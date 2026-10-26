-- Utilização da Brabus IA — 26/10/2026 (aprovado pelo Luis). Só utilização, NUNCA o texto das perguntas.
-- 1) configuracoes.ia_perfis_liberados: perfis com acesso à IA (todos, exceto RH/DP).
-- 2) bi_acesso_liberado(): a função da IA passa a decidir o acesso por essa lista (usada só depois do deploy).
-- 3) bi_uso_perguntas + bi_registrar_pergunta(): 1 linha por pergunta, sem texto e sem parâmetros.
-- 4) master_ia_usage_data(): leitura só do Master, por usuário (com o histórico de 02/10 estimado pela auditoria).
-- 5) Remove da auditoria (bi_audit_log) o texto das 2 perguntas do consultar_manual e registra a remoção.
-- Nada existente é alterado além do item 5. Nenhuma função do Score muda.
begin;

-- 1) lista de perfis com acesso ------------------------------------------------------------
insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values ('ia_perfis_liberados', 'MASTER,ANALISTA,VENDEDOR,GERENTE,DIRETOR_NOVOS,DIRETOR_SEMINOVOS',
        'Perfis com acesso à Brabus IA (todos, exceto RH/DP) — decisão do Luis em 26/10/2026. Nomes normalizados como no menu do portal.',
        now());

-- Mesma normalização de perfil de portal_modulos_permitidos (DIRETOR NOVOS -> DIRETOR_NOVOS ...).
create function public._bi_perfil_normalizado(p_perfil text)
returns text language sql immutable set search_path to 'pg_catalog', 'public' as $$
  select case
    when upper(trim(coalesce(p_perfil, ''))) in ('DIRETOR NOVOS', 'DIRETOR DE NOVOS') then 'DIRETOR_NOVOS'
    when upper(trim(coalesce(p_perfil, ''))) in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then 'DIRETOR_SEMINOVOS'
    when upper(trim(coalesce(p_perfil, ''))) in ('RECURSOS HUMANOS', 'RH', 'RH/DP') then 'RH'
    else upper(trim(coalesce(p_perfil, '')))
  end
$$;
revoke all on function public._bi_perfil_normalizado(text) from public, anon, authenticated;

create function public._bi_perfis_liberados()
returns text[] language sql stable security definer set search_path to 'pg_catalog', 'public' as $$
  select coalesce(array(
    select upper(trim(x)) from unnest(string_to_array(
      (select valor from public.configuracoes where chave = 'ia_perfis_liberados'), ',')) x
    where trim(x) <> ''), array[]::text[])
$$;
revoke all on function public._bi_perfis_liberados() from public, anon, authenticated;

-- 2) acesso do usuário logado (a função brabus-intelligence chama isto no lugar do segredo BI_PERFIS) --
create function public.bi_acesso_liberado()
returns jsonb language plpgsql stable security definer set search_path to 'pg_catalog', 'public' as $$
declare v_user public.usuarios%rowtype; v_perfil text;
begin
  select * into v_user from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user.id is null then return jsonb_build_object('liberado', false, 'motivo', 'SEM_CADASTRO_ATIVO'); end if;
  v_perfil := public._bi_perfil_normalizado(v_user.perfil);
  return jsonb_build_object('liberado', v_perfil = any(public._bi_perfis_liberados()), 'perfil', v_perfil);
end $$;
revoke all on function public.bi_acesso_liberado() from public, anon;
grant execute on function public.bi_acesso_liberado() to authenticated;

-- 3) uso por pergunta -----------------------------------------------------------------------
create table public.bi_uso_perguntas (
  id                     bigint generated always as identity primary key,
  created_at             timestamptz not null default now(),
  usuario_id             uuid not null,
  auth_user_id           uuid not null,
  sessao_id              text not null,
  canal                  text not null check (canal in ('texto', 'voz')),
  perfil_snapshot        text,
  loja_snapshot          text,
  departamento_snapshot  text,
  ferramentas            text[] not null default '{}',
  status                 text not null check (status in ('ok', 'erro', 'limite', 'negado')),
  duracao_ms             integer
);
comment on table public.bi_uso_perguntas is 'Utilização da Brabus IA: 1 linha por pergunta (quem, quando, loja/perfil/departamento da época, ferramentas usadas). Nunca guarda o texto da pergunta nem parâmetros. Grava só bi_registrar_pergunta(); lê só master_ia_usage_data().';
create index bi_uso_perguntas_created_idx on public.bi_uso_perguntas (created_at);
create index bi_uso_perguntas_usuario_idx on public.bi_uso_perguntas (usuario_id, created_at);
alter table public.bi_uso_perguntas enable row level security;
revoke all on table public.bi_uso_perguntas from anon, authenticated;

create function public.bi_registrar_pergunta(p_sessao text, p_canal text, p_ferramentas text[], p_status text, p_duracao_ms integer)
returns void language plpgsql security definer set search_path to 'pg_catalog', 'public' as $$
declare v_user public.usuarios%rowtype;
begin
  select * into v_user from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user.id is null then raise exception 'Conta sem perfil ativo no Portal.' using errcode = '42501'; end if;
  if not (public._bi_perfil_normalizado(v_user.perfil) = any(public._bi_perfis_liberados())) then
    raise exception 'A Brabus IA não está liberada para este perfil.' using errcode = '42501';
  end if;
  if p_canal is null or p_canal not in ('texto', 'voz') then raise exception 'Canal inválido.' using errcode = '22023'; end if;
  if p_status is null or p_status not in ('ok', 'erro', 'limite', 'negado') then raise exception 'Status inválido.' using errcode = '22023'; end if;
  insert into public.bi_uso_perguntas (usuario_id, auth_user_id, sessao_id, canal, perfil_snapshot, loja_snapshot, departamento_snapshot, ferramentas, status, duracao_ms)
  values (v_user.id, auth.uid(), left(coalesce(nullif(trim(p_sessao), ''), '?'), 80), p_canal, v_user.perfil, v_user.loja, v_user.status,
          -- só nomes de ferramenta (letras minúsculas e _), no máximo 30 e sem repetir: nada de texto livre
          coalesce(array(select distinct f from unnest(coalesce(p_ferramentas, array[]::text[])) f where f ~ '^[a-z_]{1,60}$' limit 30), array[]::text[]),
          p_status, case when p_duracao_ms between 0 and 3600000 then p_duracao_ms end);
end $$;
revoke all on function public.bi_registrar_pergunta(text, text, text[], text, integer) from public, anon;
grant execute on function public.bi_registrar_pergunta(text, text, text[], text, integer) to authenticated;

-- Tema de cada ferramenta (para a tela; nunca o conteúdo).
create function public._bi_tema_ferramenta(p_ferramenta text)
returns text language sql immutable set search_path to 'pg_catalog', 'public' as $$
  select case
    when p_ferramenta in ('simular_financiamento', 'buscar_entrada_minima', 'simular_balao', 'simular_plano_campanha',
                          'simular_antecipacao', 'listar_planos_elegiveis', 'calcular_taxa', 'apresentar_opcoes') then 'Simulação de financiamento'
    when p_ferramenta = 'simular_cash_conversion' then 'Cash Conversion'
    when p_ferramenta in ('resultado_loja', 'comparar_lojas', 'comparar_periodos', 'analise_fi', 'historico_vendas', 'ranking_vendedores') then 'Resultados e análises'
    when p_ferramenta in ('consultar_salario', 'consultar_comissao') then 'Salário e comissão'
    when p_ferramenta = 'consultar_score' then 'Score'
    when p_ferramenta = 'consultar_manual' then 'Manual e ajuda'
    else 'Outros'
  end
$$;
revoke all on function public._bi_tema_ferramenta(text) from public, anon, authenticated;

-- 4) leitura para a tela (só Master) -----------------------------------------------------------
-- Antes do 1º registro de bi_uso_perguntas, as perguntas são ESTIMADAS pela auditoria (bi_audit_log, desde
-- 02/10/2026): ferramentas da mesma sessão com menos de 60 s entre si = 1 pergunta. Perguntas sem ferramenta
-- não aparecem nesse período (a auditoria não as registrava). Loja/departamento do período estimado = cadastro atual.
create function public.master_ia_usage_data(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path to 'pg_catalog', 'public' as $$
declare v_master public.usuarios%rowtype; v_inicio timestamptz; v_ini timestamptz; v_fim timestamptz;
begin
  select * into v_master from public.usuarios where auth_user_id = auth.uid() and ativo = true and upper(trim(coalesce(perfil, ''))) = 'MASTER' limit 1;
  if v_master.id is null then raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501'; end if;
  if p_start is null or p_end is null or p_start > p_end then raise exception 'Período inválido.' using errcode = '22023'; end if;
  if p_end - p_start > 731 then raise exception 'Período máximo permitido: 732 dias.' using errcode = '22023'; end if;
  v_ini := p_start::timestamp at time zone 'America/Sao_Paulo';
  v_fim := (p_end + 1)::timestamp at time zone 'America/Sao_Paulo';
  select min(created_at) into v_inicio from public.bi_uso_perguntas;

  return (
    with marcadas as (                       -- auditoria antes do 1º registro real: marca onde começa cada "pergunta"
      select a.auth_user_id, a.sessao_id, a.created_at, a.ferramenta,
             case when lag(a.created_at) over w is null or a.created_at - lag(a.created_at) over w > interval '60 seconds' then 1 else 0 end as inicio
      from public.bi_audit_log a
      where a.created_at < coalesce(v_inicio, 'infinity'::timestamptz)
      window w as (partition by a.auth_user_id, a.sessao_id order by a.created_at)
    ),
    estimadas as (
      select m.*, sum(m.inicio) over (partition by m.auth_user_id, m.sessao_id order by m.created_at) as grupo from marcadas m
    ),
    perguntas as (
      select u.id as usuario_id, min(e.created_at) as quando, array_agg(distinct e.ferramenta) as ferramentas, true as estimada,
             u.loja as loja, u.perfil as perfil, u.status as departamento
      from estimadas e join public.usuarios u on u.auth_user_id = e.auth_user_id
      group by u.id, u.loja, u.perfil, u.status, e.sessao_id, e.grupo
      union all
      select p.usuario_id, p.created_at, p.ferramentas, false, p.loja_snapshot, p.perfil_snapshot, p.departamento_snapshot
      from public.bi_uso_perguntas p
    ),
    no_periodo as (select * from perguntas where quando >= v_ini and quando < v_fim),
    ultima as (                              -- loja/perfil/departamento da última pergunta do período
      select distinct on (usuario_id) usuario_id, loja, perfil, departamento from no_periodo order by usuario_id, quando desc
    ),
    temas as (
      select n.usuario_id, case when f is null then 'Conversa (sem ferramenta)' else public._bi_tema_ferramenta(f) end as tema, count(distinct n.quando) as qtd
      from no_periodo n left join lateral unnest(case when cardinality(n.ferramentas) > 0 then n.ferramentas else array[null::text] end) f on true
      group by 1, 2
    ),
    por_usuario as (
      select n.usuario_id, count(*) as perguntas, count(*) filter (where n.estimada) as perguntas_estimadas,
             count(distinct (n.quando at time zone 'America/Sao_Paulo')::date) as dias,
             min(n.quando) as primeira, max(n.quando) as ultima
      from no_periodo n group by 1
    ),
    ja_usou as (select distinct usuario_id from perguntas)
    select jsonb_build_object(
      'periodo_inicio', p_start, 'periodo_fim', p_end,
      'registro_iniciado_em', v_inicio,
      'estimado_ate', coalesce(v_inicio, now()),
      'estimativa', 'Antes de registro_iniciado_em, perguntas estimadas pela auditoria (ferramentas da mesma sessão com menos de 60 s = 1 pergunta); perguntas sem ferramenta não aparecem nesse período.',
      'perfis_liberados', to_jsonb(public._bi_perfis_liberados()),
      'linhas', coalesce((
        select jsonb_agg(jsonb_build_object(
          'usuario_id', pu.usuario_id, 'nome', u.nome, 'loja', ul.loja, 'perfil', ul.perfil, 'departamento', ul.departamento,
          'perguntas', pu.perguntas, 'perguntas_estimadas', pu.perguntas_estimadas, 'dias', pu.dias,
          'primeira', pu.primeira, 'ultima', pu.ultima,
          'temas', coalesce((select jsonb_object_agg(t.tema, t.qtd) from temas t where t.usuario_id = pu.usuario_id), '{}'::jsonb)
        ) order by pu.ultima desc)
        from por_usuario pu join public.usuarios u on u.id = pu.usuario_id join ultima ul on ul.usuario_id = pu.usuario_id
      ), '[]'::jsonb),
      'elegiveis', coalesce((                 -- usuários ativos dos perfis liberados (para "Nunca utilizaram")
        select jsonb_agg(jsonb_build_object('usuario_id', u.id, 'nome', u.nome, 'loja', u.loja, 'perfil', u.perfil, 'departamento', u.status,
                                            'ja_usou', exists (select 1 from ja_usou j where j.usuario_id = u.id)) order by u.nome)
        from public.usuarios u
        where u.ativo = true and public._bi_perfil_normalizado(u.perfil) = any(public._bi_perfis_liberados())
      ), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.master_ia_usage_data(date, date) from public, anon;
grant execute on function public.master_ia_usage_data(date, date) to authenticated;

-- 5) a auditoria guarda só utilização: tira o texto das 2 perguntas do consultar_manual (07/10/2026) --------
update public.bi_audit_log
set parametros = jsonb_set(parametros, '{pergunta}', to_jsonb('[texto removido em 26/10/2026: a auditoria guarda só utilização]'::text))
where ferramenta = 'consultar_manual' and parametros ? 'pergunta'
  and parametros->>'pergunta' <> '[texto removido em 26/10/2026: a auditoria guarda só utilização]';

insert into public.auditoria (tipo, descricao, base_origem, loja, vendedor, cpf, resolvido)
values ('BI_TEXTO_REMOVIDO',
        'Brabus IA: texto de 2 perguntas (consultar_manual, 07/10/2026) removido de bi_audit_log por decisão do Luis (26/10/2026): só utilização, nunca o texto. Nomes de colegas consultados mantidos.',
        'migração 20261026120000_brabus_ia_utilizacao', '', 'LUIS GUSTAVO DE MELO AMADIO', '', true);

commit;

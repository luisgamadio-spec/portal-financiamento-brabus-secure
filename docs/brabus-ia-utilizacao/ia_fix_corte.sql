-- Correção do corte estimado/real da utilização da Brabus IA (26/10/2026)
begin;

CREATE OR REPLACE FUNCTION public.master_ia_usage_data(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_master public.usuarios%rowtype; v_inicio timestamptz; v_ini timestamptz; v_fim timestamptz;
begin
  select * into v_master from public.usuarios where auth_user_id = auth.uid() and ativo = true and upper(trim(coalesce(perfil, ''))) = 'MASTER' limit 1;
  if v_master.id is null then raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501'; end if;
  if p_start is null or p_end is null or p_start > p_end then raise exception 'Período inválido.' using errcode = '22023'; end if;
  if p_end - p_start > 731 then raise exception 'Período máximo permitido: 732 dias.' using errcode = '22023'; end if;
  v_ini := p_start::timestamp at time zone 'America/Sao_Paulo';
  v_fim := (p_end + 1)::timestamp at time zone 'America/Sao_Paulo';
  -- 26/10/2026: o período estimado termina no INÍCIO da 1ª pergunta registrada (fim − duração); as ferramentas
  -- dessa pergunta são auditadas segundos antes do registro e não podem contar de novo como "estimada".
  select min(created_at - coalesce(duracao_ms, 0) * interval '1 millisecond') into v_inicio from public.bi_uso_perguntas;

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
end $function$;

commit;

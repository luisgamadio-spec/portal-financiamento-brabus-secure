-- ============================================================
-- [RANKING] PERF-5 -- PROCEDENCIA DA RESPONSABILIDADE + BACKFILL HISTORICO
-- ============================================================
--
-- CONTEXTO
-- PERF-4C classificou a responsabilidade historica do Ranking como
-- RECOVERABLE e deixou G17 aberto: linhas historicas precisam de
-- PROCEDENCIA durável e consultável, para que um intervalo reconstruido
-- por decisao humana NUNCA seja lido como autoridade de banco.
--
-- O QUE ESTA MIGRACAO FAZ (tudo aditivo)
--   1. adiciona analista_responsavel_loja.procedencia (NOT NULL, default
--      DIRECT_AUTHORITY -- as 9 linhas governadas existentes ja SAO
--      autoridade direta, entao o default as classifica corretamente);
--   2. adiciona a mesma coluna na auditoria;
--   3. amplia o CHECK de `acao` da auditoria com BACKFILL_HISTORICO;
--   4. cria master_backfill_analista_responsavel_historico(...) para
--      inserir intervalos historicos FECHADOS com procedencia;
--   5. cria resolve_analista_responsavel_procedencia(loja, data), que
--      devolve analista + procedencia.
--
-- O QUE ESTA MIGRACAO **NAO** FAZ
--   - nao altera master_definir_analista_responsavel (sucessao
--     prospectiva) -- fica byte-identica;
--   - nao altera resolve_analista_responsavel(text,date) -- fica
--     byte-identica; passa a enxergar historico automaticamente porque
--     consulta a mesma tabela temporal;
--   - nao altera analista_responsabilidade_janelas nem _cobertura;
--   - NAO TOCA SALARIO: nenhuma funcao de comissao e lida ou escrita.
--     operational_analyst_commission_metrics permanece intacta.
--
-- INVARIANTE TEMPORAL preservado pelo EXCLUDE USING gist ja existente:
-- um unico analista por loja normalizada por dia, intervalos [from, to).
--
-- ESTADO DA CONTA != RESPONSABILIDADE (PERF-5 §30): o backfill exige
-- perfil ANALISTA mas NAO exige `ativo`. Uma analista desligada hoje
-- pode ter sido responsavel historicamente, e apagar isso falsificaria
-- o historico.

-- ============================================================
-- 1. PROCEDENCIA -- tabela de autoridade
-- ============================================================
alter table public.analista_responsavel_loja
  add column if not exists procedencia text not null default 'DIRECT_AUTHORITY';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'analista_responsavel_loja_procedencia_check'
  ) then
    alter table public.analista_responsavel_loja
      add constraint analista_responsavel_loja_procedencia_check
      check (procedencia in (
        'DIRECT_AUTHORITY',
        'CORROBORATED_AUTHORITY',
        'HUMAN_APPROVED_RECONSTRUCTION',
        'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
      ));
  end if;
end $$;

comment on column public.analista_responsavel_loja.procedencia is
  'PERF-5: qualidade da evidencia que sustenta este intervalo. '
  'DIRECT_AUTHORITY = decisao governada registrada no proprio sistema. '
  'CORROBORATED_AUTHORITY = duas fontes historicas independentes '
  '(fechamento de comissao + ausencias_analistas) concordando. '
  'HUMAN_APPROVED_RECONSTRUCTION = regra H1, titularidade evidenciada '
  'em 21/05/2026 estendida para tras. '
  'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY = decisao humana explicita '
  'de responsavel do ano (H3/H4). '
  'Procedencia explica a QUALIDADE da evidencia; NUNCA altera a '
  'precedencia temporal nem cria um segundo dono do mesmo dia-loja.';

-- ============================================================
-- 2. PROCEDENCIA -- auditoria
-- ============================================================
alter table public.analista_responsavel_loja_auditoria
  add column if not exists procedencia text;

alter table public.analista_responsavel_loja_auditoria
  drop constraint if exists analista_responsavel_loja_auditoria_acao_check;

alter table public.analista_responsavel_loja_auditoria
  add constraint analista_responsavel_loja_auditoria_acao_check
  check (acao in ('CREATED', 'HANDOVER_CLOSED', 'SUPERSEDED', 'BACKFILL_HISTORICO'));

-- ============================================================
-- 3. BACKFILL HISTORICO -- intervalos FECHADOS com procedencia
-- ============================================================
-- Diferente de master_definir_analista_responsavel, que abre uma nova
-- vigencia e fecha a anterior (sucessao prospectiva). Aqui inserimos um
-- intervalo historico ja fechado, sem mexer em nenhuma linha existente.
create or replace function public.master_backfill_analista_responsavel_historico(
  p_loja text,
  p_analista_usuario_id uuid,
  p_valid_from date,
  p_valid_to date,
  p_procedencia text,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_loja text := upper(btrim(coalesce(p_loja, '')));
  v_alvo public.usuarios;
  v_novo_id uuid;
  v_conflito uuid;
begin
  if v_loja = '' or p_valid_from is null or p_valid_to is null then
    raise exception 'Loja, inicio e fim sao obrigatorios no backfill historico.'
      using errcode = '22023';
  end if;

  -- Intervalo historico e sempre FECHADO: nunca cria vigencia aberta.
  if p_valid_to <= p_valid_from then
    raise exception 'valid_to deve ser maior que valid_from (intervalo [from, to)).'
      using errcode = '22023';
  end if;

  -- Backfill limitado ao ano de 2026 (PERF-5 §40).
  if p_valid_from < date '2026-01-01' then
    raise exception 'Backfill historico nao pode comecar antes de 2026-01-01.'
      using errcode = '22023';
  end if;

  if p_procedencia is null or p_procedencia not in (
    'CORROBORATED_AUTHORITY',
    'HUMAN_APPROVED_RECONSTRUCTION',
    'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
  ) then
    raise exception 'Procedencia historica invalida: %. DIRECT_AUTHORITY nao pode ser atribuida por backfill.', p_procedencia
      using errcode = '22023';
  end if;

  -- Perfil ANALISTA e obrigatorio; `ativo` NAO e exigido de proposito:
  -- estado da conta nao e ciclo de vida da responsabilidade.
  select u.* into v_alvo
  from public.usuarios u
  where u.id = p_analista_usuario_id
    and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
  limit 1;

  if v_alvo.id is null then
    raise exception 'Usuario informado nao e um ANALISTA.' using errcode = '22023';
  end if;

  -- Sobreposicao: o EXCLUDE ja barra, mas damos erro legivel antes.
  select r.id into v_conflito
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.loja_normalizada = v_loja
    and daterange(r.valid_from, r.valid_to, '[)')
        && daterange(p_valid_from, p_valid_to, '[)')
  limit 1;

  if v_conflito is not null then
    raise exception 'Intervalo historico sobrepoe vigencia existente da loja % (id %).', v_loja, v_conflito
      using errcode = '23P01';
  end if;

  insert into public.analista_responsavel_loja (
    loja, analista_usuario_id, valid_from, valid_to, motivo, procedencia
  ) values (
    v_loja, p_analista_usuario_id, p_valid_from, p_valid_to, p_motivo, p_procedencia
  )
  returning id into v_novo_id;

  insert into public.analista_responsavel_loja_auditoria (
    responsabilidade_id, loja, analista_anterior, analista_novo,
    valid_from, valid_to, acao, motivo, procedencia
  ) values (
    v_novo_id, v_loja, null, p_analista_usuario_id,
    p_valid_from, p_valid_to, 'BACKFILL_HISTORICO', p_motivo, p_procedencia
  );

  return jsonb_build_object(
    'ok', true,
    'responsabilidade_id', v_novo_id,
    'loja', v_loja,
    'valid_from', p_valid_from,
    'valid_to', p_valid_to,
    'procedencia', p_procedencia
  );
end;
$function$;

comment on function public.master_backfill_analista_responsavel_historico(text, uuid, date, date, text, text) is
  'PERF-5: insere um intervalo HISTORICO FECHADO de responsabilidade do '
  'Ranking, com procedencia explicita e trilha de auditoria. Nao fecha '
  'nem altera nenhuma vigencia existente; sobreposicao e recusada. '
  'DIRECT_AUTHORITY nao pode ser atribuida por esta funcao. Exige perfil '
  'ANALISTA mas nao exige conta ativa. Nao toca Salario.';

-- ============================================================
-- 4. RESOLVER COM PROCEDENCIA (aditivo)
-- ============================================================
-- resolve_analista_responsavel(text, date) permanece intacta. Esta e uma
-- companheira que devolve tambem a qualidade da evidencia, para auditoria.
create or replace function public.resolve_analista_responsavel_procedencia(
  p_loja text,
  p_data date
)
returns table (
  analista_usuario_id uuid,
  procedencia text,
  valid_from date,
  valid_to date
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select r.analista_usuario_id, r.procedencia, r.valid_from, r.valid_to
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.loja_normalizada = upper(btrim(coalesce(p_loja, '')))
    and p_data >= r.valid_from
    and (r.valid_to is null or p_data < r.valid_to)
  limit 1;
$function$;

comment on function public.resolve_analista_responsavel_procedencia(text, date) is
  'PERF-5: resolvedor temporal canonico do Ranking, com procedencia. '
  'Sem fallback alfabetico, sem loja atual, sem resolvedor de Salario. '
  'Devolve vazio quando nao ha responsabilidade -- nunca inventa dono.';

-- ============================================================
-- 5. GRANTS -- mesmo padrao restritivo do RH-ANALYST-2
-- ============================================================
revoke all on function public.master_backfill_analista_responsavel_historico(text, uuid, date, date, text, text) from public, anon, authenticated;
grant execute on function public.master_backfill_analista_responsavel_historico(text, uuid, date, date, text, text) to service_role;

revoke all on function public.resolve_analista_responsavel_procedencia(text, date) from public, anon;
grant execute on function public.resolve_analista_responsavel_procedencia(text, date) to authenticated, service_role;

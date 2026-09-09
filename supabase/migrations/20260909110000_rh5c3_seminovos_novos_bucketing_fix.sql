-- RH-5C.3 -- P1 corrective Wave for SEMINOVOS_MANAGER_BUCKETING_INCIDENT
-- (quantified read-only in RH-5C.2: R$11,355.39 in the one
-- reconstructable historical closing, R$2,528.76/period ongoing).
--
-- Human decisions carried forward:
--   - Fix timing: PROSPECTIVE, NOW (current/open + future).
--   - Historical policy: OPTION B -- disclose, never rewrite frozen
--     monetary values, never auto-remediate.
--
-- SCOPE: operational_commission_faixa_rows()'s own manager-bucketing
-- CTE only (the SAME governed authority RH-5C.1 introduced) --
-- everything else in this function, and the pure formula function it
-- calls, is unchanged. The companion V1 frontend fix
-- (assets/js/portal-app.js, gerenteBuckets) is a separate file, not
-- expressible in SQL, committed alongside this migration in the same
-- Wave.

-- ============================================================
-- 1. Corrected operational_commission_faixa_rows()
-- ============================================================
-- Byte-identical to the RH-5C.1 live body EXCEPT the manager-bucketing
-- CTE: `like '%NOVOS%'`/`like '%SEMINOVOS%'` (substring -- the exact
-- root cause of the incident: 'SEMINOVOS' contains 'NOVOS' as a
-- substring, so every SEMINOVOS row also contaminated the NOVOS
-- bucket) replaced with exact, normalized equality -- a department
-- value of 'NOVOS/SEMINOVOS' (never observed live in this specific
-- row shape, but preserved for safety, matching the original code's
-- own intent) still contributes to both buckets; 'NOVOS' contributes
-- to NOVOS only; 'SEMINOVOS' contributes to SEMINOVOS only; any other
-- value contributes to neither (fails safe, matches this schema's own
-- existing 'SEM DEPARTAMENTO' convention rather than guessing).
create or replace function public.operational_commission_faixa_rows(p_start date, p_end date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_cfg record;
  v_seller_metrics jsonb;
  v_analyst_metrics jsonb;
  v_seller_rows jsonb;
  v_analyst_rows jsonb;
  v_row jsonb;
  v_result jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_manager_buckets jsonb;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;

  select
    max(case when chave = 'share_minimo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as share_minimo,
    max(case when chave = 'spf_liquido_percentual' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as spf_liquido_percentual,
    max(case when chave = 'limite_retorno_novos' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as limite_retorno_novos,
    max(case when chave = 'limite_retorno_seminovos' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as limite_retorno_seminovos,
    max(case when chave = 'vendedor_faixa_baixo_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfbb,
    max(case when chave = 'vendedor_faixa_baixo_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfba,
    max(case when chave = 'vendedor_faixa_alto_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfab,
    max(case when chave = 'vendedor_faixa_alto_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfaa,
    max(case when chave = 'gerente_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as gfb,
    max(case when chave = 'gerente_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as gfa,
    max(case when chave = 'analista_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as afb,
    max(case when chave = 'analista_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as afa,
    max(case when chave = 'bonus_spf_analista' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as bonus_spf
  into v_cfg
  from public.configuracoes
  where chave in ('share_minimo', 'spf_liquido_percentual', 'limite_retorno_novos', 'limite_retorno_seminovos',
    'vendedor_faixa_baixo_share_baixo', 'vendedor_faixa_baixo_share_alto', 'vendedor_faixa_alto_share_baixo', 'vendedor_faixa_alto_share_alto',
    'gerente_faixa_share_baixo', 'gerente_faixa_share_alto', 'analista_faixa_share_baixo', 'analista_faixa_share_alto', 'bonus_spf_analista');

  -- ---- VENDEDOR rows ----
  v_seller_metrics := public.operational_commission_metrics(p_start, p_end);
  v_seller_rows := coalesce(v_seller_metrics -> 'rows', '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_seller_rows)
  loop
    v_calc := public._operational_commission_faixa_formula(
      v_row ->> 'department', 'seller',
      (v_row ->> 'sold_count')::numeric, (v_row ->> 'financed_count')::numeric, (v_row ->> 'return_value')::numeric,
      (v_row ->> 'spf_value')::numeric, (v_row ->> 'spf_count')::numeric,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    );
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'perfil', 'VENDEDOR', 'seller_id', v_row -> 'seller_id', 'store', v_row -> 'store', 'department', v_row -> 'department',
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier'
    ));
  end loop;

  -- ---- GERENTE buckets (store+department) ----
  -- RH-5C.3 fix: exact match (upper/trim) replacing the substring
  -- collision. A department of exactly 'NOVOS/SEMINOVOS' still
  -- contributes to both buckets (preserving the original intent);
  -- 'SEMINOVOS' no longer contaminates 'NOVOS'.
  with dept_rows as (
    select
      r ->> 'store' as store,
      dep.g as department,
      coalesce((r ->> 'sold_count')::numeric, 0) as vendidas,
      coalesce((r ->> 'financed_count')::numeric, 0) as financiadas,
      coalesce((r ->> 'return_value')::numeric, 0) as retorno,
      coalesce((r ->> 'spf_value')::numeric, 0) as spf,
      coalesce((r ->> 'spf_count')::numeric, 0) as spf_qty
    from jsonb_array_elements(v_seller_rows) r
    cross join lateral (
      select unnest(
        case upper(trim(coalesce(r ->> 'department', '')))
          when 'NOVOS/SEMINOVOS' then array['NOVOS', 'SEMINOVOS']
          when 'NOVOS' then array['NOVOS']
          when 'SEMINOVOS' then array['SEMINOVOS']
          else array[]::text[]
        end
      ) as g
    ) dep
  ),
  buckets as (
    select store, department, sum(vendidas) as vendidas, sum(financiadas) as financiadas,
      sum(retorno) as retorno, sum(spf) as spf, sum(spf_qty) as spf_qty
    from dept_rows
    group by store, department
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'perfil', 'GERENTE', 'store', b.store, 'department', b.department,
    'calc', public._operational_commission_faixa_formula(
      'GERENTE ' || b.department, 'manager', b.vendidas, b.financiadas, b.retorno, b.spf, b.spf_qty,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    )
  )), '[]'::jsonb)
  into v_manager_buckets
  from buckets b;

  select v_result || coalesce(jsonb_agg(jsonb_build_object(
    'perfil', 'GERENTE', 'store', mb -> 'store', 'department', mb -> 'department',
    'faixa', mb -> 'calc' -> 'faixa', 'faixa_level', mb -> 'calc' -> 'faixa_level', 'share_tier', mb -> 'calc' -> 'share_tier', 'retorno_tier', mb -> 'calc' -> 'retorno_tier'
  )), '[]'::jsonb)
  into v_result
  from jsonb_array_elements(v_manager_buckets) mb;

  -- ---- ANALISTA rows ----
  v_analyst_metrics := public.operational_analyst_commission_metrics_v2(p_start, p_end);
  v_analyst_rows := coalesce(v_analyst_metrics -> 'rows', '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_analyst_rows)
  loop
    v_calc := public._operational_commission_faixa_formula(
      'ANALISTA', 'analyst',
      (v_row ->> 'sold_count')::numeric, (v_row ->> 'financed_count')::numeric, (v_row ->> 'return_value')::numeric,
      (v_row ->> 'spf_value')::numeric, (v_row ->> 'spf_count')::numeric,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    );
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'perfil', 'ANALISTA', 'store', v_row -> 'store',
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier'
    ));
  end loop;

  return jsonb_build_object('rows', v_result, 'contains_client_identity', false, 'contains_personal_documents', false);
end;
$function$;

comment on function public.operational_commission_faixa_rows(date, date) is
  'RH-5C.3: fixed SEMINOVOS_MANAGER_BUCKETING_INCIDENT (P1) -- manager bucketing now uses exact department equality, never substring containment. MASTER-only. Never returns cpf.';

-- ============================================================
-- 2. Historical disclosure (Human Decision: Option B)
-- ============================================================
-- Narrow, purpose-built table -- never overloads observacao/
-- commission_engine_version (both used for unrelated concerns).
-- Append-only by design (no update/delete policy, matching
-- snapshot_operational_detail's own established precedent for
-- immutable audit-adjacent data): a disclosure, once recorded, is
-- never edited or removed -- a correction would be a NEW row, not a
-- mutation, preserving a full audit trail.
create table if not exists public.commission_bucketing_incident_disclosures (
  id uuid primary key default gen_random_uuid(),
  fechamento_id uuid not null references public.fechamentos_comissao(id),
  incident_identifier text not null,
  classification text not null check (classification in ('AFFECTED_CONFIRMED', 'NOT_RECONSTRUCTABLE')),
  disclosure_text text not null,
  remediation_status text not null default 'NOT_REMEDIATED' check (remediation_status in ('NOT_REMEDIATED', 'REMEDIATED')),
  disclosed_at timestamptz not null default now(),
  disclosed_by text not null,
  unique (fechamento_id, incident_identifier)
);

revoke all on public.commission_bucketing_incident_disclosures from public, anon, authenticated;
alter table public.commission_bucketing_incident_disclosures enable row level security;
create policy commission_bucketing_incident_disclosures_select_master
  on public.commission_bucketing_incident_disclosures for select to authenticated
  using (public.is_master());
-- Deliberately NO insert/update/delete policy for any client role --
-- this Wave's own disclosure rows are inserted once, directly, by this
-- migration (service-role/superuser context); no ongoing client write
-- path is being introduced.

comment on table public.commission_bucketing_incident_disclosures is
  'RH-5C.3: Human Decision Option B -- non-destructive disclosure of historical closings affected by SEMINOVOS_MANAGER_BUCKETING_INCIDENT. Never mutates snapshot_comissoes. Append-only (no update/delete policy). MASTER-only read.';

-- ============================================================
-- 3. Read RPC (MASTER-only)
-- ============================================================
create or replace function public.master_commission_bucketing_incident_disclosures(p_fechamento_id uuid default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'rows',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'fechamento_id', d.fechamento_id,
        'incident_identifier', d.incident_identifier,
        'classification', d.classification,
        'disclosure_text', d.disclosure_text,
        'remediation_status', d.remediation_status,
        'disclosed_at', d.disclosed_at
      ) order by d.disclosed_at desc)
      from public.commission_bucketing_incident_disclosures d
      where p_fechamento_id is null or d.fechamento_id = p_fechamento_id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.master_commission_bucketing_incident_disclosures(uuid) from public;
revoke all on function public.master_commission_bucketing_incident_disclosures(uuid) from anon;
grant execute on function public.master_commission_bucketing_incident_disclosures(uuid) to authenticated, service_role;

comment on function public.master_commission_bucketing_incident_disclosures(uuid) is
  'RH-5C.3: MASTER-only read of commission bucketing incident disclosures (Option B). Pass p_fechamento_id to scope to one closing, or null for all.';

-- ============================================================
-- 4. Insert the 3 real disclosure rows
-- ============================================================
-- Real fechamento_id values (closing identifiers, not personal data),
-- confirmed live this Wave and RH-5C.2. Monetary values in
-- snapshot_comissoes are NOT touched by this INSERT.
insert into public.commission_bucketing_incident_disclosures
  (fechamento_id, incident_identifier, classification, disclosure_text, remediation_status, disclosed_by)
values
  ('c0be54f1-9a64-4583-ae84-72d4630d2e5a', 'SEMINOVOS_MANAGER_BUCKETING_INCIDENT', 'AFFECTED_CONFIRMED',
   'Este fechamento histórico foi calculado sob uma regra anterior de classificação departamental posteriormente identificada como inconsistente. Os valores históricos permanecem preservados.',
   'NOT_REMEDIATED', 'RH-5C.3'),
  ('6429b00d-589d-4bd2-86f2-7a8185aed0cc', 'SEMINOVOS_MANAGER_BUCKETING_INCIDENT', 'NOT_RECONSTRUCTABLE',
   'Não é possível determinar se este fechamento foi afetado por este incidente específico devido a uma limitação de dados históricos anterior e não relacionada (detalhamento de departamento por vendedor ausente neste snapshot). Os valores históricos permanecem preservados.',
   'NOT_REMEDIATED', 'RH-5C.3'),
  ('82190f87-5c73-4cca-ba06-040eded88c8d', 'SEMINOVOS_MANAGER_BUCKETING_INCIDENT', 'NOT_RECONSTRUCTABLE',
   'Não é possível determinar se este fechamento foi afetado por este incidente específico devido a uma limitação de dados históricos anterior e não relacionada (detalhamento de departamento por vendedor ausente neste snapshot). Os valores históricos permanecem preservados.',
   'NOT_REMEDIATED', 'RH-5C.3')
on conflict (fechamento_id, incident_identifier) do nothing;

-- ============================================================
-- ROLLBACK (NOT executed by this file)
-- ============================================================
-- create or replace function public.operational_commission_faixa_rows(date, date) ... -- restore the RH-5C.1 pre-fix body (LIKE-based bucketing), captured in 20260909100000_rh5c_gestor_fi_governed_authority.sql's own git history.
-- delete from public.commission_bucketing_incident_disclosures where incident_identifier = 'SEMINOVOS_MANAGER_BUCKETING_INCIDENT';
-- drop function if exists public.master_commission_bucketing_incident_disclosures(uuid);
-- drop table if exists public.commission_bucketing_incident_disclosures;

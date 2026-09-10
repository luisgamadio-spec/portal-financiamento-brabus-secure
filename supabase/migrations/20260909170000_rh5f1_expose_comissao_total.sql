-- RH-5F.1 -- SALARIOS_COMISSAO_TOTAL_AUTHORITY_GAP, closed.
--
-- Live tracing (RH-5F): _operational_commission_faixa_formula (the pure,
-- IMMUTABLE, already-governed engine -- byte-identical to V1's own
-- commissionCalc()) already computes comissao_principal/comissao_spf/
-- comissao_total for every VENDEDOR/GERENTE/ANALISTA row. But
-- operational_commission_faixa_rows -- the only RPC V2 can call for the
-- open/current period's per-row Faixa classification -- discards those
-- 3 fields before returning its result, keeping only faixa/faixa_level/
-- share_tier/retorno_tier.
--
-- This migration is a PURE, ADDITIVE PROJECTION CHANGE: it adds
-- comissao_principal/comissao_spf/comissao_total to the 3
-- jsonb_build_object(...) result-row calls, and nothing else. Every
-- other line of the function body is byte-identical to the live,
-- currently-deployed definition (20260909110000_rh5c3_seminovos_novos_
-- bucketing_fix.sql) -- same MASTER-only gate, same config read, same
-- _operational_commission_faixa_formula call sites/arguments (the
-- calculation itself is NOT touched, only which of its already-computed
-- output fields get forwarded), same GERENTE bucketing (RH-5C.3's exact-
-- match fix), same existing fields (faixa/faixa_level/share_tier/
-- retorno_tier) all preserved verbatim -- no existing consumer field is
-- renamed or removed, only additive.
--
-- CALCULATION LOGIC: UNCHANGED.
-- COMMISSION RECIPIENT LOGIC: UNCHANGED.
-- VACATION/COVERAGE: UNCHANGED (this function never reads ausencias_
-- analistas directly; it consumes operational_analyst_commission_
-- metrics_v2's already-coverage-aware rows exactly as before).
-- RANKING REFERENCES: NONE (still zero references to
-- analista_responsavel_loja/analista_responsabilidade_janelas).
-- RETURN/PROJECTION: ADDITIVE CHANGE ONLY.

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
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
      -- RH-5F.1: additive only -- same v_calc already computed above, 3
      -- fields that were simply never forwarded before.
      'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
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
    'faixa', mb -> 'calc' -> 'faixa', 'faixa_level', mb -> 'calc' -> 'faixa_level', 'share_tier', mb -> 'calc' -> 'share_tier', 'retorno_tier', mb -> 'calc' -> 'retorno_tier',
    'comissao_principal', mb -> 'calc' -> 'comissao_principal', 'comissao_spf', mb -> 'calc' -> 'comissao_spf', 'comissao_total', mb -> 'calc' -> 'comissao_total'
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
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
      'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
    ));
  end loop;

  return jsonb_build_object('rows', v_result, 'contains_client_identity', false, 'contains_personal_documents', false);
end;
$function$;

comment on function public.operational_commission_faixa_rows(date, date) is
  'RH-5F.1: additive projection change only -- now also returns comissao_principal/comissao_spf/comissao_total (already computed by _operational_commission_faixa_formula, previously discarded). RH-5C.3 bucketing fix preserved verbatim. MASTER-only. Never returns cpf.';

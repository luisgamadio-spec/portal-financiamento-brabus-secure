-- RH-5F.3 -- SELF-SCOPED COMMISSION SUMMARY (VENDEDOR/GERENTE/ANALISTA).
--
-- FORENSIC FINDING this Wave: operational_commission_faixa_rows (RH-5C.1/
-- RH-5F.1) already computes comissao_principal/comissao_spf/comissao_total
-- for VENDEDOR/GERENTE/ANALISTA via the pure, immutable, already-governed
-- _operational_commission_faixa_formula -- but that RPC is MASTER-only
-- (real, live-traced 42501 for anyone else, confirmed again this Wave).
-- So no non-MASTER user has ANY server path to their own commission
-- amount today, even though the formula and their own operational inputs
-- are both already fully governed and already computable.
--
-- This migration does NOT touch operational_commission_faixa_rows (never
-- broadened), does NOT touch _operational_commission_faixa_formula (zero
-- changes -- called with the exact same arguments, in the exact same
-- per-row/per-bucket shape, as that RPC already does), does NOT touch
-- operational_analyst_commission_metrics/_v2, operational_commission_
-- metrics, operational_metrics, resolve_store_temporal, or any Ranking
-- function. It adds exactly ONE new, narrow, self-scoped, additive
-- function: operational_own_commission_summary(p_start, p_end).
--
-- SCOPE DERIVATION -- zero new authorization logic of its own:
--   VENDEDOR: calls operational_commission_metrics(p_start,p_end) as the
--     caller -- already self-scoped to exactly this seller's own row(s)
--     (operational_metrics' own eligible_sellers CTE: "v_is_seller and
--     u.id = v_user_id"). Runs _operational_commission_faixa_formula on
--     each returned row (byte-identical arguments to the 'seller' branch
--     of operational_commission_faixa_rows), sums comissao_total.
--   GERENTE: same self-scoped operational_commission_metrics call (a
--     manager only ever receives their own store's seller rows --
--     "not v_is_seller and u.loja = v_store"), bucketed by (store,
--     department) with the EXACT SAME bucketing CTE operational_
--     commission_faixa_rows already uses for its GERENTE branch (RH-5C.3
--     exact-match fix preserved verbatim), summed across the manager's
--     own department bucket(s) -- never another store's bucket, because
--     the seller rows it buckets were never fetched for another store to
--     begin with.
--   ANALISTA: calls operational_analyst_commission_metrics_v2(p_start,
--     p_end) as the caller (already self-scoped + coverage-aware, RH-1's
--     Incident P1 fix). Filtered STRICTLY to rows whose analyst_name
--     matches the caller's own name (normalized) -- a store-scoped row
--     set can legitimately include a covering colleague's row too (the
--     exact scenario V1's own Incidente 5.2/5.3 exists to guard against,
--     portal-app.js:6713-6722) -- summed PER ROW, never on a consolidated
--     aggregate (the Faixa share threshold gives a different, wrong,
--     result computed either way -- same incident, same reason).
--   Any other profile (MASTER/RH/DIRETOR*): empty rows, zero total, no
--     exception -- there is no personal compensation concept for these
--     profiles in Secure (traced this Wave: DIRETOR's own "comissoes"
--     module view is oversight-only, isDiretorComissao(), never a
--     personal payout -- out of this Wave's explicit "gerente" scope).
--
-- DSR IS NOT PART OF THIS FUNCTION. Traced live this Wave (portal-
-- app.js:6575-6733, "Checkpoint D"): DSR was ALREADY, in the pre-existing
-- V1 authority, "exclusivamente visual, somente para ANALISTA, e nunca
-- integra comissao_total oficial" -- a pure calendar function of the
-- period's reference month (Sundays + national holidays / working days),
-- computed 100% client-side, never server-side, never part of any
-- official total in Secure either. This migration does not change that.
--
-- NO WRITES. Zero tables created/altered. Zero rows inserted/updated.
-- Zero Ranking reference. Zero coverage/vacation semantic change.

create or replace function public.operational_own_commission_summary(p_start date, p_end date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_profile text;
  v_actor_norm text;
  v_cfg record;
  v_metrics jsonb;
  v_rows jsonb;
  v_analyst_metrics jsonb;
  v_analyst_rows jsonb;
  v_row jsonb;
  v_calc jsonb;
  v_buckets jsonb;
  v_result jsonb := '[]'::jsonb;
  v_total numeric := 0;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Periodo maximo permitido: 732 dias.' using errcode = '22023';
  end if;

  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_actor.id is null then
    return jsonb_build_object('rows', '[]'::jsonb, 'comissao_total', 0, 'profile', null,
      'contains_client_identity', false, 'contains_personal_documents', false);
  end if;

  v_profile := upper(trim(coalesce(v_actor.perfil, '')));

  if v_profile not in ('VENDEDOR', 'GERENTE', 'ANALISTA') then
    return jsonb_build_object('rows', '[]'::jsonb, 'comissao_total', 0, 'profile', v_profile,
      'contains_client_identity', false, 'contains_personal_documents', false);
  end if;

  -- Same config read as operational_commission_faixa_rows, verbatim.
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

  if v_profile = 'VENDEDOR' then
    v_metrics := public.operational_commission_metrics(p_start, p_end);
    v_rows := coalesce(v_metrics -> 'rows', '[]'::jsonb);

    for v_row in select * from jsonb_array_elements(v_rows)
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
        'perfil', 'VENDEDOR', 'store', v_row -> 'store', 'department', v_row -> 'department',
        'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
        'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
      ));
      v_total := v_total + coalesce((v_calc ->> 'comissao_total')::numeric, 0);
    end loop;

  elsif v_profile = 'GERENTE' then
    v_metrics := public.operational_commission_metrics(p_start, p_end);
    v_rows := coalesce(v_metrics -> 'rows', '[]'::jsonb);

    -- Byte-identical bucketing to operational_commission_faixa_rows'
    -- GERENTE branch (RH-5C.3 exact-match fix). v_rows here is already
    -- self-scoped to the caller's own store (operational_metrics'
    -- eligible_sellers: "not v_is_seller and u.loja = v_store"), so the
    -- resulting buckets are already only this manager's own department(s).
    with dept_rows as (
      select
        r ->> 'store' as store,
        dep.g as department,
        coalesce((r ->> 'sold_count')::numeric, 0) as vendidas,
        coalesce((r ->> 'financed_count')::numeric, 0) as financiadas,
        coalesce((r ->> 'return_value')::numeric, 0) as retorno,
        coalesce((r ->> 'spf_value')::numeric, 0) as spf,
        coalesce((r ->> 'spf_count')::numeric, 0) as spf_qty
      from jsonb_array_elements(v_rows) r
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
      'store', b.store, 'department', b.department,
      'calc', public._operational_commission_faixa_formula(
        'GERENTE ' || b.department, 'manager', b.vendidas, b.financiadas, b.retorno, b.spf, b.spf_qty,
        coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
        coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
        coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
        coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
        coalesce(v_cfg.bonus_spf, 150)
      )
    )), '[]'::jsonb)
    into v_buckets
    from buckets b;

    select
      coalesce(jsonb_agg(jsonb_build_object(
        'perfil', 'GERENTE', 'store', x -> 'store', 'department', x -> 'department',
        'faixa', x -> 'calc' -> 'faixa', 'faixa_level', x -> 'calc' -> 'faixa_level', 'share_tier', x -> 'calc' -> 'share_tier', 'retorno_tier', x -> 'calc' -> 'retorno_tier',
        'comissao_principal', x -> 'calc' -> 'comissao_principal', 'comissao_spf', x -> 'calc' -> 'comissao_spf', 'comissao_total', x -> 'calc' -> 'comissao_total'
      )), '[]'::jsonb),
      coalesce(sum(((x -> 'calc' ->> 'comissao_total'))::numeric), 0)
    into v_result, v_total
    from jsonb_array_elements(v_buckets) x;

  elsif v_profile = 'ANALISTA' then
    v_analyst_metrics := public.operational_analyst_commission_metrics_v2(p_start, p_end);
    v_analyst_rows := coalesce(v_analyst_metrics -> 'rows', '[]'::jsonb);
    v_actor_norm := upper(trim(regexp_replace(coalesce(v_actor.nome, ''), '\s+', ' ', 'g')));

    for v_row in select * from jsonb_array_elements(v_analyst_rows)
    loop
      if upper(trim(regexp_replace(coalesce(v_row ->> 'analyst_name', ''), '\s+', ' ', 'g'))) = v_actor_norm then
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
          'perfil', 'ANALISTA', 'store', v_row -> 'store', 'transfer', coalesce(v_row -> 'transfer', 'false'::jsonb),
          'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
          'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
        ));
        v_total := v_total + coalesce((v_calc ->> 'comissao_total')::numeric, 0);
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'rows', v_result,
    'comissao_total', round(coalesce(v_total, 0), 2),
    'profile', v_profile,
    'contains_client_identity', false,
    'contains_personal_documents', false
  );
end;
$function$;

comment on function public.operational_own_commission_summary(date, date) is
  'RH-5F.3: self-scoped commission summary for the CALLING VENDEDOR/GERENTE/ANALISTA only, identity derived from auth.uid(). Zero client-supplied target identity. Reuses operational_commission_metrics/operational_analyst_commission_metrics_v2 (already self-scoped) and _operational_commission_faixa_formula (already governed, unchanged) verbatim -- no new formula, no new authorization rule. Never returns another user''s compensation. Never returns cpf/email/personal documents.';

revoke all on function public.operational_own_commission_summary(date, date) from public;
revoke all on function public.operational_own_commission_summary(date, date) from anon;
grant execute on function public.operational_own_commission_summary(date, date) to authenticated, service_role;

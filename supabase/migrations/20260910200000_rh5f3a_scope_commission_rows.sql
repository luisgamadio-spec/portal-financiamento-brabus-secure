-- RH-5F.3A -- ROLE COMMISSION VISIBILITY (ANALISTA seller-scope,
-- GERENTE team-scope, both own-faixa cards).
--
-- HUMAN DECISION H-SAL-1/H-SAL-3 (authoritative, supersedes the prior
-- RH-5F.3 assumption that seller commission should stay hidden from
-- ANALISTA): an ANALISTA must be able to inspect Faixa/%/Comissão Total
-- for the sellers inside her OWN Salary-authorized store scope (monthly
-- verification), and a GERENTE must see the same for their own team plus
-- a team commission total.
--
-- PART 1 -- operational_own_commission_summary: ONE additive field.
-- Its VENDEDOR branch now also returns `seller_id` per row (it already
-- computed everything else identically) -- needed so a VENDEDOR's own
-- row in the Equipe table can be matched the SAME way
-- operational_commission_faixa_rows' own rows already are (perfil+
-- seller_id), instead of a bespoke single-row assumption. Nothing else
-- in this function changes -- same formula calls, same scope sources,
-- same GERENTE/ANALISTA branches, byte-identical otherwise.
--
-- PART 2 -- operational_scope_commission_rows (NEW): read, self-scoped,
-- identity from auth.uid() only -- zero client-supplied target user or
-- store. For ANALISTA/GERENTE ONLY:
--   calls operational_commission_metrics(p_start,p_end) AS THE CALLER --
--   this is the SAME already-proven self-scope operational_own_
--   commission_summary's own GERENTE branch already relies on
--   ("not v_is_seller and u.loja = v_store", operational_metrics'
--   eligible_sellers CTE) -- an ANALISTA or GERENTE caller receives
--   EXACTLY the sellers of their own store, never another store's. Each
--   returned seller row is run through the exact same, unchanged
--   _operational_commission_faixa_formula('seller',...) the MASTER-only
--   operational_commission_faixa_rows already uses for its VENDEDOR
--   branch (byte-identical call shape), producing a perfil='VENDEDOR'
--   row set scoped to the caller's own store. team_comissao_total is
--   the plain sum of those rows' comissao_total -- a presentation
--   convenience the client would otherwise have to reduce over the same
--   array itself; no new arithmetic beyond addition of already-computed
--   numbers.
--
-- PRIVACY: seller_name/production/return/SPF for these same rows are
-- ALREADY rendered to ANALISTA/GERENTE today via operational_commission_
-- metrics (their own store, unrelated to this migration) -- this
-- migration adds the Faixa/%/Comissão Total fields to rows ALREADY
-- visible, it does not newly expose any seller who wasn't already shown.
-- Never returns cpf/email/personal documents. VENDEDOR/MASTER/RH/
-- DIRETOR* calling this get {rows:[], team_comissao_total:0, profile}
-- -- never an exception, never another role's data.
--
-- NOT TOUCHED: operational_commission_faixa_rows, _operational_
-- commission_faixa_formula, operational_analyst_commission_metrics/_v2,
-- operational_commission_metrics, operational_metrics, resolve_store_
-- temporal, any Ranking function, any table. Zero writes. Zero coverage/
-- vacation semantic change. Zero formula change (DSR untouched, still
-- 100% client-side per RH-5F.3).

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
      -- RH-5F.3A additive: seller_id added so the client can match this
      -- row against the Equipe table the SAME way operational_commission_
      -- faixa_rows' own VENDEDOR rows are already matched.
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'perfil', 'VENDEDOR', 'seller_id', v_row -> 'seller_id', 'store', v_row -> 'store', 'department', v_row -> 'department',
        'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
        'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
      ));
      v_total := v_total + coalesce((v_calc ->> 'comissao_total')::numeric, 0);
    end loop;

  elsif v_profile = 'GERENTE' then
    v_metrics := public.operational_commission_metrics(p_start, p_end);
    v_rows := coalesce(v_metrics -> 'rows', '[]'::jsonb);

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
  'RH-5F.3/RH-5F.3A: self-scoped commission summary for the CALLING VENDEDOR/GERENTE/ANALISTA only, identity derived from auth.uid(). Zero client-supplied target identity. Reuses operational_commission_metrics/operational_analyst_commission_metrics_v2 (already self-scoped) and _operational_commission_faixa_formula (already governed, unchanged) verbatim -- no new formula, no new authorization rule. Never returns another user''s compensation. Never returns cpf/email/personal documents. RH-5F.3A: VENDEDOR rows now also carry seller_id (additive).';

create or replace function public.operational_scope_commission_rows(p_start date, p_end date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_profile text;
  v_cfg record;
  v_metrics jsonb;
  v_rows jsonb;
  v_row jsonb;
  v_calc jsonb;
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
    return jsonb_build_object('rows', '[]'::jsonb, 'team_comissao_total', 0, 'profile', null,
      'contains_client_identity', false, 'contains_personal_documents', false);
  end if;

  v_profile := upper(trim(coalesce(v_actor.perfil, '')));

  -- H-SAL-1/H-SAL-3: seller-scope commission rows exist for ANALISTA and
  -- GERENTE only. VENDEDOR's own row already comes from operational_own_
  -- commission_summary (never duplicated here); MASTER/RH/DIRETOR* have
  -- no personal-team concept in Secure (same boundary as RH-5F.3).
  if v_profile not in ('ANALISTA', 'GERENTE') then
    return jsonb_build_object('rows', '[]'::jsonb, 'team_comissao_total', 0, 'profile', v_profile,
      'contains_client_identity', false, 'contains_personal_documents', false);
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

  -- operational_commission_metrics, called AS the caller, already
  -- restricts a non-master/non-seller profile (ANALISTA/GERENTE both)
  -- to their own store's sellers only ("not v_is_seller and u.loja =
  -- v_store", operational_metrics' own eligible_sellers CTE) -- the
  -- exact same self-scope operational_own_commission_summary's GERENTE
  -- branch already relies on. No store parameter is accepted here; the
  -- caller cannot request any other store's sellers.
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
      'perfil', 'VENDEDOR', 'seller_id', v_row -> 'seller_id', 'store', v_row -> 'store', 'department', v_row -> 'department',
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier',
      'comissao_principal', v_calc -> 'comissao_principal', 'comissao_spf', v_calc -> 'comissao_spf', 'comissao_total', v_calc -> 'comissao_total'
    ));
    v_total := v_total + coalesce((v_calc ->> 'comissao_total')::numeric, 0);
  end loop;

  return jsonb_build_object(
    'rows', v_result,
    'team_comissao_total', round(coalesce(v_total, 0), 2),
    'profile', v_profile,
    'contains_client_identity', false,
    'contains_personal_documents', false
  );
end;
$function$;

comment on function public.operational_scope_commission_rows(date, date) is
  'RH-5F.3A (H-SAL-1/H-SAL-3): seller-level Faixa/comissao_total rows for the CALLING ANALISTA/GERENTE own store scope only, identity derived from auth.uid(). Reuses operational_commission_metrics (already self-scoped to the caller''s own store) and the unchanged _operational_commission_faixa_formula verbatim. No target-user/store parameter. Every returned seller row was already visible to this caller via operational_commission_metrics -- this only adds the already-governed Faixa/%/Comissão Total fields to rows already shown. Never returns another store''s data. Never returns cpf/email/personal documents.';

revoke all on function public.operational_scope_commission_rows(date, date) from public;
revoke all on function public.operational_scope_commission_rows(date, date) from anon;
grant execute on function public.operational_scope_commission_rows(date, date) to authenticated, service_role;

-- SECURE-SPF-PLACEHOLDER-FIX-09 (r2): exclude R$1,00 NBS placeholder from
-- SPF Extra -- production-preserving revision.
--
-- Supersedes 20261001150000_secure_spf_placeholder_r1_exclusion.sql for
-- operational_score_coparticipated_data ONLY (that migration is kept,
-- unedited, for history -- this one is the one actually safe to publish).
--
-- Root cause and evidence: unchanged from r1, see
-- 20261001150000_secure_spf_placeholder_r1_exclusion.sql's own header
-- (SECURE-SPF-PLACEHOLDER-AUDIT-08: optional_value=1,00 is a non-
-- operational NBS import placeholder, proven never to represent a real
-- value -- strictly bimodal across the table's entire history, zero
-- occurrences between 0 and 1, smallest real value ever recorded is
-- R$1.000,00).
--
-- Why r2 exists (SECURE-SPF-RECONSTRUCT-PROD-FUNCTION-13,
-- SECURE-SPF-PLACEHOLDER-DIRECT-PUBLISH-12): r1's
-- operational_score_coparticipated_data was built from this repo's own
-- canonical migration (20260916120000_revenda3_ia3b_canonical_rpc_
-- exclusion.sql), which was discovered, via a direct read-only query
-- against the live production function (pg_get_functiondef), to be STALE
-- for this one function. Production already carries an additional field
-- -- `is_fandi` (`(sp.client_match_key is not null) as is_fandi` in
-- finance_rows, `'is_fandi', is_fandi` in the output) -- added after
-- 2026-09-16 by some mechanism never captured as a migration in this
-- repository. Publishing r1's version of this function as-is would have
-- silently dropped `is_fandi` from production -- a real, unauthorized
-- regression. operational_metrics and operational_model_metrics showed
-- NO such drift (confirmed identical to canonical, byte-for-byte, by the
-- same production read) and are carried over unchanged from r1/commit
-- c671cae040daa534a914e8f37932579d074b1258.
--
-- operational_score_coparticipated_data below is therefore built from the
-- literal, live `pg_get_functiondef` text captured directly from
-- production in SECURE-SPF-RECONSTRUCT-PROD-FUNCTION-13 -- not from any
-- local migration file -- with exactly one predicate added inside
-- spf_extra_agg (`and coalesce(x.optional_value, 0) <> 1`). Every other
-- line, including `is_fandi`, is preserved verbatim from what is live
-- today.
--
-- operational_model_metrics_without_spf is NOT redefined here (no SPF
-- logic of its own, called by name, unaffected -- same as r1).

CREATE OR REPLACE FUNCTION public.operational_metrics(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_spf_net_percent numeric := 70;
  v_rows jsonb;
  v_group_view_perfil text;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_store := v_scope->>'store';
  v_departments := array(
    select jsonb_array_elements_text(v_scope->'departments')
  );
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  if p_group_view then
    select upper(trim(coalesce(u.perfil, ''))) into v_group_view_perfil
    from public.usuarios u
    where u.auth_user_id = auth.uid() and u.ativo = true
    limit 1;
    if v_group_view_perfil in ('ANALISTA', 'VENDEDOR', 'GERENTE')
       and (public.portal_modulos_permitidos() ? 'dashbi') then
      v_is_master := true;
      v_scope := jsonb_set(v_scope, '{is_master}', 'true'::jsonb);
    end if;
  end if;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  select coalesce(
    case
      when replace(c.valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$'
        then replace(c.valor, ',', '.')::numeric
      else null
    end,
    70
  )
  into v_spf_net_percent
  from public.configuracoes c
  where c.chave = 'spf_liquido_percentual'
  limit 1;

  v_spf_net_percent := coalesce(v_spf_net_percent, 70);

  with latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status,
      true as is_current_user
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(u.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(u.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (v_is_seller and u.id = v_user_id)
            or (
              not v_is_seller
              and upper(trim(coalesce(u.loja, ''))) = v_store
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status,
      false as is_current_user
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, ''))) not in (
        'REVENDA', 'INATIVO', 'MASTER'
      )
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(ps.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(ps.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (
              not v_is_seller
              and upper(coalesce(ps.store, '')) = v_store
            )
          )
        )
      )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_id,
      s.seller_user_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.department,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, s.sale_date, null), es.status, s.department, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  sales_metrics as (
    select
      es.id as seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA') as store,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, vs.sale_date, null), es.status, vs.department, 'SEM DEPARTAMENTO'))) as department,
      es.name as seller_name,
      count(*)::integer as sold_count,
      coalesce(sum(vs.sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales vs
    join eligible_sellers es on es.id = coalesce(vs.seller_user_id, vs.seller_id)
    group by
      es.id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA'),
      upper(trim(coalesce(public.resolve_department_temporal(es.id, vs.sale_date, null), es.status, vs.department, 'SEM DEPARTAMENTO'))),
      es.name
  ),
  visible_finance as (
    select
      f.*,
      es.id as effective_seller_id,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  principal_finance as (
    select *
    from visible_finance
    where is_real_financing
  ),
  later_return as (
    select distinct on (
      effective_seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from visible_finance
    where is_later_return
    order by
      effective_seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance as (
    select * from principal_finance
    union all
    select lr.*
    from later_return lr
    where not exists (
      select 1 from principal_finance pf where pf.id = lr.id
    )
  ),
  effective_finance_classified as (
    select ef.*,
      case
        when ef.plan_codigo_if is not null
         and (upper(trim(ef.plan_codigo_if)) = '999'
              or upper(ef.plan_codigo_if) like '%SUBSIDIADO%')
          then 'SUBSIDIADO'
        when ef.plan_codigo_if is not null
         and (upper(trim(ef.plan_codigo_if)) = '777'
              or upper(ef.plan_codigo_if) like '%REVERSAO%'
              or upper(ef.plan_codigo_if) like '%REVERSÃO%')
          then 'REVERSÃO'
        when ef.tc_devolvida = 1 then 'COPARTICIPADO'
        when coalesce(ef.balloon_value, 0) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from effective_finance ef
  ),
  finance_metrics as (
    select
      effective_seller_id as seller_id,
      effective_store as store,
      department,
      seller_name,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance_classified
    group by effective_seller_id, effective_store, department, seller_name
  ),
  plan_metrics as (
    select
      effective_seller_id as seller_id,
      effective_store as store,
      department,
      seller_name,
      plan_type,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
      avg(balloon_value) filter (where balloon_value > 0)
        as average_balloon_value
    from effective_finance_classified
    group by effective_seller_id, effective_store, department, seller_name, plan_type
  ),
  plan_breakdown_agg as (
    select
      seller_id, store, department, seller_name,
      jsonb_agg(
        jsonb_build_object(
          'plan_type', plan_type,
          'financed_count', financed_count,
          'production_value', production_value,
          'return_value', return_value,
          'average_balloon_value', round(coalesce(average_balloon_value, 0), 2)
        )
        order by plan_type
      ) as plan_breakdown
    from plan_metrics
    group by seller_id, store, department, seller_name
  ),
  spf_linked as (
    select distinct
      vf.effective_seller_id as seller_id,
      vf.effective_store as store,
      vf.department,
      vf.seller_name,
      spf.id,
      spf.optional_value
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- SECURE-SPF-PLACEHOLDER-FIX-09: optional_value=1,00 is a non-
     -- operational NBS import placeholder, proven never to represent a
     -- real value (SECURE-SPF-PLACEHOLDER-AUDIT-08) -- excluded here,
     -- every other value (including the unbroken range above R$1.000,00)
     -- is preserved untouched.
     and spf.optional_value <> 1
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics as (
    select
      seller_id,
      store,
      department,
      seller_name,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_linked
    group by seller_id, store, department, seller_name
  ),
  metrics as (
    select
      sm.seller_id,
      sm.store,
      sm.department,
      sm.seller_name,
      sm.sold_count,
      sm.sales_value,
      coalesce(fm.financed_count, 0) as financed_count,
      coalesce(fm.production_value, 0)::numeric(18,2) as production_value,
      coalesce(fm.return_value, 0)::numeric(18,2) as return_value,
      coalesce(spm.spf_count, 0) as spf_count,
      coalesce(spm.spf_value, 0)::numeric(18,2) as spf_value,
      coalesce(pba.plan_breakdown, '[]'::jsonb) as plan_breakdown
    from sales_metrics sm
    left join finance_metrics fm
      on fm.seller_id = sm.seller_id
     and fm.store = sm.store
     and fm.department = sm.department
    left join spf_metrics spm
      on spm.seller_id = sm.seller_id
     and spm.store = sm.store
     and spm.department = sm.department
    left join plan_breakdown_agg pba
      on pba.seller_id = sm.seller_id
     and pba.store = sm.store
     and pba.department = sm.department
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'seller_id', seller_id,
        'seller_name', seller_name,
        'store', store,
        'department', department,
        'sold_count', sold_count,
        'sales_value', sales_value,
        'financed_count', financed_count,
        'share_percent',
          case
            when sold_count > 0
              then round(
                (financed_count::numeric / sold_count::numeric) * 100,
                4
              )
            else 0
          end,
        'production_value', production_value,
        'return_value', return_value,
        'spf_count', spf_count,
        'spf_value', spf_value,
        'spf_net_value',
          round(spf_value * (v_spf_net_percent / 100), 2),
        'profitability_value',
          round(
            return_value + (spf_value * (v_spf_net_percent / 100)),
            2
          ),
        'plan_breakdown', plan_breakdown
      )
      order by store, department, seller_name
    ),
    '[]'::jsonb
  )
  into v_rows
  from metrics;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'spf_net_percent', v_spf_net_percent,
    'eligibility_rule', 'ACTIVE_VENDEDOR_ONLY',
    'plan_priority_rule', 'SUBSIDIADO_REVERSAO_COPARTICIPADO_BALAO_LINEAR',
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'rows', v_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_model_metrics(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_base jsonb;
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_spf_net_percent numeric := 70;
  v_rows jsonb;
begin
  v_base := public.operational_model_metrics_without_spf(p_start, p_end, p_group_view);
  v_scope := v_base->'scope';
  v_store := v_scope->>'store';
  v_departments := array(select jsonb_array_elements_text(v_scope->'departments'));
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;

  select coalesce(
    case when replace(c.valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$'
      then replace(c.valor, ',', '.')::numeric end,
    70
  ) into v_spf_net_percent
  from public.configuracoes c
  where c.chave = 'spf_liquido_percentual'
  limit 1;

  v_spf_net_percent := coalesce(v_spf_net_percent, 70);

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT','SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last,
             b.created_at desc, b.id desc
  ), eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil,''))) = 'VENDEDOR'
      and (v_is_master or (
        (upper(trim(coalesce(u.status,''))) = any(v_departments)
          or (upper(trim(coalesce(u.status,''))) = 'NOVOS/SEMINOVOS'
            and ('NOVOS' = any(v_departments) or 'SEMINOVOS' = any(v_departments))))
        and (v_is_director
          or (v_is_seller and u.id = v_user_id)
          or (not v_is_seller and upper(trim(coalesce(u.loja,''))) = v_store))
      ))
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type,''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status,''))) not in ('REVENDA','INATIVO','MASTER')
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (v_is_master or (
        (upper(trim(coalesce(ps.status,''))) = any(v_departments)
          or (upper(trim(coalesce(ps.status,''))) = 'NOVOS/SEMINOVOS'
            and ('NOVOS' = any(v_departments) or 'SEMINOVOS' = any(v_departments))))
        and (v_is_director
          or (not v_is_seller and upper(coalesce(ps.store,'')) = v_store))
      ))
  ), sales_latest as (
    select distinct on (s.chassis)
      s.chassis, s.department,
      coalesce(nullif(s.vehicle_model,''),'NÃƒO INFORMADO') as model
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ), finance_rows as (
    select f.id, f.operation_date, f.client_match_key,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store,'')),es.store,'SEM LOJA') as store,
      coalesce(sl.department,'NOVOS') as department,
      coalesce(nullif(f.vehicle_model,''),sl.model,'NÃƒO INFORMADO') as model
    from public.portal_finance_operations f
    join latest_batches lb on lb.id = f.batch_id
      and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis = f.chassis
    where f.operation_date between p_start and p_end
      and f.is_real_financing
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ), spf_rows as (
    select sp.id, sp.client_match_key, sp.optional_value
    from public.portal_spf_operations sp
    join latest_batches lb on lb.id = sp.batch_id
      and lb.source_type = 'SPF_CURRENT'
    where sp.is_spf_extra and coalesce(sp.optional_value,0) > 0
      -- SECURE-SPF-PLACEHOLDER-FIX-09: same placeholder exclusion as
      -- operational_metrics.spf_linked -- see that CTE's comment above for
      -- the full evidence (SECURE-SPF-PLACEHOLDER-AUDIT-08).
      and sp.optional_value <> 1
  ), spf_linked as (
    select distinct on (sp.id)
      fr.store, fr.department, fr.model, sp.id, sp.optional_value
    from spf_rows sp
    join finance_rows fr on fr.client_match_key = sp.client_match_key
    order by sp.id, fr.operation_date desc, fr.id desc
  ), spf_metrics as (
    select store, department, model,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value),0)::numeric(18,2) as spf_value
    from spf_linked
    group by store, department, model
  ), base_rows as (
    select value as row_data from jsonb_array_elements(v_base->'rows')
  )
  select coalesce(jsonb_agg(
    br.row_data || jsonb_build_object(
      'spf_count', coalesce(sm.spf_count,0),
      'spf_value', coalesce(sm.spf_value,0),
      'spf_net_value', round(coalesce(sm.spf_value,0) * (v_spf_net_percent / 100),2)
    ) order by br.row_data->>'store', br.row_data->>'department', br.row_data->>'model'
  ), '[]'::jsonb)
  into v_rows
  from base_rows br
  left join spf_metrics sm
    on sm.store = br.row_data->>'store'
   and sm.department = br.row_data->>'department'
   and sm.model = br.row_data->>'model';

  return (v_base - 'rows') || jsonb_build_object(
    'spf_net_percent', v_spf_net_percent,
    'spf_rule', 'LATEST_VALIDATED_SPF_BATCH_LINKED_TO_VISIBLE_FINANCE',
    'rows', v_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_score_coparticipated_data(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_module_allowed jsonb;
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_sales jsonb;
  v_finance jsonb;
  v_rates jsonb;
begin
  -- SEC-1D.1 (fix 2): escopo resolvido ANTES do gate de capacidade,
  -- para que v_is_seller já seja conhecido no momento da verificação
  -- abaixo (ver cabeçalho do arquivo para o raciocínio completo).
  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(select jsonb_array_elements_text(v_scope->'departments'));
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  -- Incidente P2 SCORE-SEC-1: capability server-side. permissoes_modulos
  -- ja negava VENDEDOR (NOVOS e SEMINOVOS) para analiseScoreVendedores,
  -- mas esta RPC nunca checava isso -- so aplicava escopo (loja/depto),
  -- nao "pode usar o modulo". Reusa o mecanismo canonico existente
  -- (portal_modulos_permitidos(), o mesmo que decide o que aparece no
  -- Portal Home) em vez de duplicar a resolucao de perfil/departamento
  -- aqui. Identidade nao resolvida/inativa/desconhecida ja levanta
  -- exceção dentro de operational_current_scope(), acima -- fail
  -- closed, igual a antes.
  -- SEC-1D.1 (fix 2): v_is_master e v_is_seller sao exemptados deste
  -- gate -- v_is_master ja e estruturalmente privilegiado em toda esta
  -- função (cada branch de eligible_sellers abaixo começa com
  -- "v_is_master or (...)"), e um vendedor (is_seller) consultando a si
  -- mesmo tem seu resultado SEMPRE restrito à própria linha
  -- (eligible_sellers: "v_is_seller AND u.id = v_user_id", inalterado),
  -- independente deste gate e independente de p_group_view -- exemptar
  -- v_is_seller aqui não concede nada alem do que esse vendedor já
  -- receberia de qualquer forma. DIRETOR permanece decidido
  -- exclusivamente pela tabela real (DIRETOR_NOVOS=true,
  -- DIRETOR_SEMINOVOS=false hoje) -- não exemptado aqui.
  v_module_allowed := public.portal_modulos_permitidos();
  if not v_is_master and not v_is_seller and not (v_module_allowed ? 'analiseScoreVendedores') then
    raise exception 'Acesso não autorizado ao módulo Score F&I.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.' using errcode = '22023';
  end if;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
   where u.auth_user_id = auth.uid() and u.ativo
   limit 1;

  with sales_latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
      from public.portal_import_batches b
     where b.status='VALIDATED'
       and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
     order by b.source_type,b.completed_at desc nulls last,b.created_at desc,b.id desc
  ), eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil,'')))='VENDEDOR'
      and (v_is_master or (
        (upper(trim(coalesce(u.status,'')))=any(v_departments)
         or (upper(trim(coalesce(u.status,'')))='NOVOS/SEMINOVOS'
             and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
        and (v_is_director or (v_is_seller and u.id = v_user_id)
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store or p_group_view)))))
    union all
    select ps.id, ps.name, ps.store, ps.status from public.portal_sellers ps
     where ps.active
       and upper(trim(coalesce(ps.profile_type,'')))='VENDEDOR'
       and upper(trim(coalesce(ps.status,''))) not in ('REVENDA','INATIVO','MASTER')
       and not exists (
         select 1 from public.usuarios u2
         where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
       )
       and (v_is_master or (
         (upper(trim(coalesce(ps.status,'')))=any(v_departments)
          or (upper(trim(coalesce(ps.status,'')))='NOVOS/SEMINOVOS'
              and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
         and (v_is_director
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store or p_group_view)))))
  ), sales_latest as (
    select distinct on (s.chassis)
      s.id,s.sale_date,s.chassis,es.id as seller_id,es.name as seller_name,
      coalesce(public.resolve_store_temporal(es.id, s.sale_date, nullif(s.store,'')),es.store,'SEM LOJA') as store,
      s.department,es.status as seller_status,coalesce(nullif(s.vehicle_model,''),'NÃO INFORMADO') as vehicle_model,
      s.sale_value
    from public.portal_sales s
    join sales_latest_batches slb on slb.id = s.batch_id
      and slb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    join eligible_sellers es on es.id=coalesce(s.seller_user_id, s.seller_id)
    -- REVENDA3: exclude rows whose OWN store field is REVENDA, before
    -- resolve_store_temporal (called in the SELECT list above) can launder
    -- a REVENDA row's identity through a resolved/temporal store value.
    -- Unconditional -- not gated by the eligible_sellers join above.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis,s.sale_date desc,s.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',sale_date,'seller',seller_name,'store',store,
    'department',department,'model',vehicle_model,'sale_value',sale_value,
    'operation_reference',case when chassis is null then '' else '***'||right(chassis,6) end
  ) order by sale_date,store,seller_name),'[]'::jsonb)
  into v_sales from sales_latest
  where sale_date between p_start and p_end
    -- Incidente IA-1B: gate de autorizacao por departamento EFETIVO (temporal,
    -- com fallback para o status ATUAL da pessoa -- mesma cadeia de
    -- operational_metrics), para DIRETOR. NAO usa "department" bruto como
    -- fallback (permanece so no campo de exibicao/classificacao, inalterado).
    and (
      not v_is_director
      or upper(trim(coalesce(public.resolve_department_temporal(seller_id, sale_date, null), seller_status, 'SEM DEPARTAMENTO'))) = any(v_departments)
    );

  with latest_batches as (
    select distinct on (b.source_type) b.id,b.source_type
      from public.portal_import_batches b
     where b.status='VALIDATED'
       and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT')
     order by b.source_type,b.completed_at desc nulls last,b.created_at desc,b.id desc
  ), eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil,'')))='VENDEDOR'
      and (v_is_master or (
        (upper(trim(coalesce(u.status,'')))=any(v_departments)
         or (upper(trim(coalesce(u.status,'')))='NOVOS/SEMINOVOS'
             and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
        and (v_is_director or (v_is_seller and u.id = v_user_id)
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store or p_group_view)))))
    union all
    select ps.id, ps.name, ps.store, ps.status from public.portal_sellers ps
     where ps.active
       and upper(trim(coalesce(ps.profile_type,'')))='VENDEDOR'
       and upper(trim(coalesce(ps.status,''))) not in ('REVENDA','INATIVO','MASTER')
       and not exists (
         select 1 from public.usuarios u2
         where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
       )
       and (v_is_master or (
         (upper(trim(coalesce(ps.status,'')))=any(v_departments)
          or (upper(trim(coalesce(ps.status,'')))='NOVOS/SEMINOVOS'
              and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
         and (v_is_director
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store or p_group_view)))))
  ), sales_only_latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
      from public.portal_import_batches b
     where b.status='VALIDATED'
       and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
     order by b.source_type,b.completed_at desc nulls last,b.created_at desc,b.id desc
  ), sales_latest as (
    select distinct on (s.chassis) s.chassis,s.department,s.sale_value,s.vehicle_model
      from public.portal_sales s
      join sales_only_latest_batches solb on solb.id = s.batch_id
       and solb.source_type in ('SALES_CURRENT','SALES_HISTORY')
      -- REVENDA3: exclude rows whose OWN store field is REVENDA. This CTE
      -- is enrichment-only (department/sale_value/vehicle_model, no store
      -- column selected) but is still a direct read of portal_sales --
      -- filtered here for defense in depth/audit completeness, consistent
      -- with every other direct read site in this migration.
      where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
      order by s.chassis,s.sale_date desc,s.id desc
  ), spf_latest as (
    -- Base 03 is a terms snapshot. Do not filter it by the report period.
    select sp.* from public.portal_spf_operations sp
    join latest_batches lb on lb.id=sp.batch_id and lb.source_type='SPF_CURRENT'
    -- REVENDA3: independent linkage -- this CTE reads portal_spf_operations
    -- directly (sp.*) and is attached to finance_rows below purely by
    -- client_match_key, independent of both the sales and finance store
    -- fields. Mirrors the REVENDA-2 companion fix's own spf.store filter
    -- in operational_salary_details' spf_links CTE (portal-financiamento-
    -- brabus-secure, commit be9e96b).
    where upper(trim(coalesce(sp.store, ''))) <> 'REVENDA'
  ), spf_fandi_latest as (
    select distinct on (x.client_match_key) x.*
    from spf_latest x
    where upper(coalesce(x.modality,'')) = 'FANDI'
    order by x.client_match_key, x.operation_date desc nulls last, x.id desc
  ), spf_extra_agg as (
    select x.client_match_key,
           sum(x.optional_value) as spf_value,
           count(*)::integer as spf_count
    from spf_latest x
    where x.is_spf_extra
      -- SECURE-SPF-PLACEHOLDER-FIX-09: optional_value=1,00 is a non-
      -- operational NBS import placeholder, proven never to represent a
      -- real value (SECURE-SPF-PLACEHOLDER-AUDIT-08) -- excluded here.
      and coalesce(x.optional_value, 0) <> 1
    group by x.client_match_key
  ), finance_rows as (
    select f.*,es.name as seller_name,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store,'')),es.store,'SEM LOJA') as effective_store,
      coalesce(nullif(f.vehicle_model,''),sl.vehicle_model,'NÃO INFORMADO') as effective_model,
      coalesce(sl.department,case when upper(coalesce(es.status,'')) like '%SEMINOVOS%'
        and upper(coalesce(es.status,'')) not like '%NOVOS/%' then 'SEMINOVOS' else 'NOVOS' end) as effective_department,
      coalesce(sl.sale_value,0) as sale_value,
      sp.status as fandi_status,
      coalesce(sp.installments,f.installments) as effective_installments,
      coalesce(sp.installment_value,f.installment_value) as effective_installment_value,
      coalesce(nullif(sp.balloon_payment,0),sp.balloon_value) as fandi_balloon,
      coalesce(sea.spf_value,0) as spf_value,
      coalesce(sea.spf_count,0) as spf_count,
      -- MEGA-UAT-WAVEC3B: explicit FANDI-modality-authority provenance --
      -- true iff this row's client_match_key was actually matched by
      -- spf_fandi_latest (the exact, already-live modality='FANDI' gate
      -- above), never inferred from plan_codigo_if/tc_devolvida/
      -- balloon_value (those decide 'plan' below, independently).
      (sp.client_match_key is not null) as is_fandi
    from public.portal_finance_operations f
    join latest_batches lb on lb.id=f.batch_id and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id=coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis=f.chassis
    left join spf_fandi_latest sp on sp.client_match_key = f.client_match_key
    left join spf_extra_agg sea on sea.client_match_key = f.client_match_key
    where f.operation_date between p_start and p_end and f.is_real_financing
      -- REVENDA3: exclude finance rows whose OWN store field is REVENDA,
      -- unconditional -- never gated by seller eligibility. This is the
      -- primary row source of v_finance's financed_value/return_value/
      -- spf_value aggregation.
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',operation_date,'seller',seller_name,'store',effective_store,
    'department',effective_department,'model',effective_model,
    'sale_value',sale_value,'financed_value',financed_or_service_value,
    'return_value',return_value,'spf_value',spf_value,'spf_count',spf_count,
    'installments',coalesce(effective_installments,0),
    'installment_value',coalesce(effective_installment_value,0),
    'balloon_value',coalesce(fandi_balloon,balloon_value,0),
    'plan',case
      when plan_codigo_if is not null
       and (upper(trim(plan_codigo_if)) = '999' or upper(plan_codigo_if) like '%SUBSIDIADO%')
        then 'SUBSIDIADO'
      when plan_codigo_if is not null
       and (upper(trim(plan_codigo_if)) = '777' or upper(plan_codigo_if) like '%REVERSAO%' or upper(plan_codigo_if) like '%REVERSÃO%')
        then 'REVERSÃO'
      when tc_devolvida = 1 then 'COPARTICIPADO'
      when coalesce(balloon_value,0) > 0 then 'BALÃO'
      else 'LINEAR' end,
    'status',coalesce(fandi_status,''),
    'is_fandi',is_fandi,
    'operation_reference',case when chassis is null then '' else '***'||right(chassis,6) end
  ) order by operation_date,effective_store,seller_name),'[]'::jsonb)
  into v_finance from finance_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'model',c.modelo,'term',c.prazo,'rate',c.taxa,
    'total_rebate',c.rebate_total,'brabus_percent',c.percentual_brabus
  ) order by c.modelo,c.prazo),'[]'::jsonb)
  into v_rates from public.coparticipado_modelos_fi c where c.ativo;

  return jsonb_build_object(
    'scope',v_scope,'period_start',p_start,'period_end',p_end,
    'contains_client_identity',false,'contains_personal_documents',false,
    'contains_full_chassis',false,'sales',v_sales,'finance',v_finance,'rates',v_rates
  );
end;
$function$;


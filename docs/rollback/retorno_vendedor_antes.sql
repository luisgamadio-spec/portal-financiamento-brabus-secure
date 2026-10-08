-- ROLLBACK da correção 'vendedor não recebe retorno': volta as definições salvas em 08/10/2026 e remove as funções novas.
begin;
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

  -- RH (perfil corporativo): lê Salários & Comissões de todo o grupo -- todas as
  -- lojas, NOVOS e SEMINOVOS -- com o mesmo alcance de leitura do diretor. Só
  -- muda algo quando o perfil resolvido por operational_current_scope() é 'RH'.
  v_is_director := coalesce(v_is_director, false) or (v_scope->>'profile') = 'RH';
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
$function$
;

CREATE OR REPLACE FUNCTION public.operational_commission_metrics(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_base jsonb;
  v_rows jsonb;
  v_filtered jsonb;
  v_excluded_groups integer := 0;
  v_excluded_sales integer := 0;
  v_excluded_sales_value numeric(18,2) := 0;
  v_sold integer := 0;
  v_financed integer := 0;
  v_sales numeric(18,2) := 0;
  v_production numeric(18,2) := 0;
  v_return numeric(18,2) := 0;
  v_spf_count integer := 0;
  v_spf numeric(18,2) := 0;
  v_spf_net numeric(18,2) := 0;
  v_profitability numeric(18,2) := 0;
  v_spf_percent numeric := 70;
begin
  v_base := public.operational_metrics(p_start, p_end);
  v_rows := coalesce(v_base->'rows', '[]'::jsonb);
  v_spf_percent := coalesce((v_base->>'spf_net_percent')::numeric, 70);

  select
    coalesce(
      jsonb_agg(
        x order by x->>'store', x->>'department', x->>'seller_name'
      ) filter (where x->'seller_id' <> 'null'::jsonb),
      '[]'::jsonb
    ),
    count(*) filter (where x->'seller_id' = 'null'::jsonb)::integer,
    coalesce(
      sum((x->>'sold_count')::integer)
        filter (where x->'seller_id' = 'null'::jsonb),
      0
    )::integer,
    coalesce(
      sum((x->>'sales_value')::numeric)
        filter (where x->'seller_id' = 'null'::jsonb),
      0
    )::numeric(18,2)
  into
    v_filtered,
    v_excluded_groups,
    v_excluded_sales,
    v_excluded_sales_value
  from jsonb_array_elements(v_rows) x;

  select
    coalesce(sum((x->>'sold_count')::integer), 0)::integer,
    coalesce(sum((x->>'financed_count')::integer), 0)::integer,
    coalesce(sum((x->>'sales_value')::numeric), 0)::numeric(18,2),
    coalesce(sum((x->>'production_value')::numeric), 0)::numeric(18,2),
    coalesce(sum((x->>'return_value')::numeric), 0)::numeric(18,2),
    coalesce(sum((x->>'spf_count')::integer), 0)::integer,
    coalesce(sum((x->>'spf_value')::numeric), 0)::numeric(18,2)
  into
    v_sold,
    v_financed,
    v_sales,
    v_production,
    v_return,
    v_spf_count,
    v_spf
  from jsonb_array_elements(coalesce(v_filtered, '[]'::jsonb)) x;

  v_spf_net := round(v_spf * (v_spf_percent / 100), 2);
  v_profitability := round(v_return + v_spf_net, 2);

  return jsonb_set(
    jsonb_set(
      jsonb_set(
        v_base,
        '{rows}',
        coalesce(v_filtered, '[]'::jsonb),
        true
      ),
      '{historical_audit}',
      jsonb_build_object(
        'unlinked_groups_excluded', v_excluded_groups,
        'unlinked_sales_excluded', v_excluded_sales,
        'unlinked_sales_value_excluded', v_excluded_sales_value,
        'records_deleted', 0,
        'included_in_commission', false
      ),
      true
    ),
    '{totals}',
    jsonb_build_object(
      'sold_count', v_sold,
      'financed_count', v_financed,
      'share_percent',
        case
          when v_sold > 0
            then round((v_financed::numeric / v_sold::numeric) * 100, 4)
          else 0
        end,
      'sales_value', v_sales,
      'production_value', v_production,
      'return_value', v_return,
      'spf_count', v_spf_count,
      'spf_value', v_spf,
      'spf_net_value', v_spf_net,
      'profitability_value', v_profitability
    ),
    true
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.operational_model_metrics_without_spf(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
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

  with latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  -- FASE 6: catálogo de identificação de modelo por chassi, somente
  -- para enriquecer o TEXTO do modelo quando a linha em uso tiver uma
  -- descrição curta/truncada. Olha toda a tabela portal_finance_
  -- operations, sem filtro de período/lote/seller/is_real_financing --
  -- nunca alimenta métricas, só fornece texto. Só produz candidate_model
  -- quando existe exatamente 1 descrição distinta com mais de 35
  -- caracteres para aquele chassi (ver cabeçalho desta migration).
  chassis_model_catalog as (
    select chassis, max(vehicle_model) as candidate_model
    from (
      select distinct chassis, vehicle_model
      from public.portal_finance_operations
      where chassis is not null
        and vehicle_model is not null
        and length(trim(vehicle_model)) > 35
    ) distinct_full_descriptions
    group by chassis
    having count(*) = 1
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
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
    select ps.id, ps.name, ps.store, ps.status
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
      s.id, s.sale_date, s.chassis, s.seller_id, s.seller_user_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), es.store, 'SEM LOJA') as store,
      s.department,
      es.status as seller_status,
      -- FASE 6: se o próprio texto de Vendas já tiver mais de 35
      -- caracteres, usa ele direto (nunca substitui um texto já bom).
      -- Senão, usa o candidate_model do catálogo por chassi, se houver
      -- um candidato não-ambíguo. Senão, mantém o comportamento
      -- original (texto truncado ou 'NÃO INFORMADO').
      case
        when length(trim(coalesce(s.vehicle_model, ''))) > 35 then s.vehicle_model
        when cmc.candidate_model is not null then cmc.candidate_model
        else coalesce(nullif(s.vehicle_model, ''), 'NÃO INFORMADO')
      end as model,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    left join chassis_model_catalog cmc on cmc.chassis = s.chassis
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select *
    from sales_global_latest
    where sale_date between p_start and p_end
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(coalesce(seller_user_id, seller_id), sale_date, null), seller_status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  sales_metrics as (
    select store, department, model,
           count(*)::integer as sold_count,
           coalesce(sum(sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales
    group by store, department, model
  ),
  principal_finance as (
    select f.*,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and f.is_real_financing
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
  ),
  later_return_finance as (
    select distinct on (f.chassis) f.*,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and f.is_later_return
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
    order by f.chassis, f.return_value desc, f.id desc
  ),
  effective_finance as (
    select * from principal_finance
    union all
    select lrf.* from later_return_finance lrf
    where not exists (
      select 1 from principal_finance pf where pf.chassis = lrf.chassis
    )
  ),
  finance_linked as (
    select f.*,
      -- FASE 6: mesma regra de sales_global_latest -- texto próprio se
      -- já tiver mais de 35 caracteres; senão candidate_model do
      -- catálogo; senão o comportamento original (prioriza o próprio
      -- vehicle_model de Finance, depois o de Vendas já processado por
      -- visible_sales, depois 'NÃO INFORMADO').
      case
        when length(trim(coalesce(f.vehicle_model, ''))) > 35 then f.vehicle_model
        when cmc.candidate_model is not null then cmc.candidate_model
        else coalesce(nullif(f.vehicle_model, ''), s.model, 'NÃO INFORMADO')
      end as model,
      s.department,
      s.sale_value,
      case
        when s.sale_value > 0
         and f.financed_or_service_value > 0
         and f.financed_or_service_value <= s.sale_value * 1.15
        then greatest(s.sale_value - f.financed_or_service_value, 0)
      end as entry_value
    from effective_finance f
    left join visible_sales s on s.chassis = f.chassis
    left join chassis_model_catalog cmc on cmc.chassis = f.chassis
  ),
  finance_linked_classified as (
    select fl.*,
      case
        when fl.plan_codigo_if is not null
         and (upper(trim(fl.plan_codigo_if)) = '999'
              or upper(fl.plan_codigo_if) like '%SUBSIDIADO%')
          then 'SUBSIDIADO'
        when fl.plan_codigo_if is not null
         and (upper(trim(fl.plan_codigo_if)) = '777'
              or upper(fl.plan_codigo_if) like '%REVERSAO%'
              or upper(fl.plan_codigo_if) like '%REVERSÃO%')
          then 'REVERSÃO'
        when fl.tc_devolvida = 1 then 'COPARTICIPADO'
        when coalesce(fl.balloon_value, 0) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from finance_linked fl
  ),
  finance_metrics as (
    select effective_store as store,
           coalesce(department, 'NOVOS') as department,
           model,
           count(distinct chassis)::integer as financed_count,
           coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
             as production_value,
           coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
           avg(installments) filter (where installments > 0)
             as average_installments,
           avg(installment_value) filter (where installment_value > 0)
             as average_installment_value,
           count(entry_value)::integer as valid_entry_count,
           coalesce(sum(entry_value), 0)::numeric(18,2) as entry_total,
           coalesce(sum(sale_value) filter (where entry_value is not null), 0)
             ::numeric(18,2) as entry_sales_value_total
    from finance_linked_classified
    group by effective_store, coalesce(department, 'NOVOS'), model
  ),
  plan_metrics as (
    select effective_store as store,
           coalesce(department, 'NOVOS') as department,
           model,
           plan_type,
           count(distinct chassis)::integer as financed_count,
           coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
             as production_value,
           coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
           avg(balloon_value) filter (where balloon_value > 0)
             as average_balloon_value
    from finance_linked_classified
    group by effective_store, coalesce(department, 'NOVOS'), model, plan_type
  ),
  plan_breakdown_agg as (
    select store, department, model,
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
    group by store, department, model
  ),
  keys as (
    select store, department, model from sales_metrics
    union
    select store, department, model from finance_metrics
  ),
  metrics as (
    select k.store, k.department, k.model,
      coalesce(sm.sold_count, 0) as sold_count,
      coalesce(sm.sales_value, 0) as sales_value,
      coalesce(fm.financed_count, 0) as financed_count,
      coalesce(fm.production_value, 0) as production_value,
      coalesce(fm.return_value, 0) as return_value,
      coalesce(fm.average_installments, 0) as average_installments,
      coalesce(fm.average_installment_value, 0)
        as average_installment_value,
      coalesce(fm.valid_entry_count, 0) as valid_entry_count,
      coalesce(fm.entry_total, 0) as entry_total,
      coalesce(fm.entry_sales_value_total, 0) as entry_sales_value_total,
      coalesce(pba.plan_breakdown, '[]'::jsonb) as plan_breakdown
    from keys k
    left join sales_metrics sm using (store, department, model)
    left join finance_metrics fm using (store, department, model)
    left join plan_breakdown_agg pba using (store, department, model)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'store', store,
    'department', department,
    'model', model,
    'sold_count', sold_count,
    'sales_value', sales_value,
    'financed_count', financed_count,
    'penetration_percent',
      case when sold_count > 0
        then round(financed_count::numeric / sold_count * 100, 4)
        else 0 end,
    'production_value', production_value,
    'return_value', return_value,
    'average_return_percent',
      case when production_value > 0
        then round(return_value / production_value * 100, 6)
        else 0 end,
    'average_installments', round(average_installments, 2),
    'average_installment_value', round(average_installment_value, 2),
    'valid_entry_count', valid_entry_count,
    'entry_total', entry_total,
    'entry_sales_value_total', entry_sales_value_total,
    'average_entry_value',
      case when valid_entry_count > 0
        then round(entry_total / valid_entry_count, 2)
        else 0 end,
    'weighted_entry_percent',
      case when entry_sales_value_total > 0
        then round(entry_total / entry_sales_value_total * 100, 6)
        else 0 end,
    'plan_breakdown', plan_breakdown
  ) order by store, department, model), '[]'::jsonb)
  into v_rows
  from metrics;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'entry_rule', 'SUM_ENTRY_DIV_VALID_OPERATIONS',
    'entry_percent_rule', 'SUM_ENTRY_DIV_SUM_SALE_VALUE',
    'plan_priority_rule', 'SUBSIDIADO_REVERSAO_COPARTICIPADO_BALAO_LINEAR',
    'model_enrichment_rule', 'CHASSIS_SINGLE_UNAMBIGUOUS_DESCRIPTION_OVER_35_CHARS',
    'rows', v_rows
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.operational_reporting_summary(p_start date, p_end date)
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
  v_rows jsonb;
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

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  sales_canonical_dedup as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_user_id,
      s.seller_id,
      s.store,
      s.department,
      s.sale_value,
      s.seller_source_name
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do fallback
    -- resolve_store_temporal usado em visible_sales.store abaixo. Nunca
    -- por chassi -- mesmo principio do Incidente REVENDA2 (T34887).
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, u.loja, 'SEM LOJA') as store,
      s.department,
      s.sale_value,
      coalesce(u.nome, ps.name, s.seller_source_name, 'SEM VÍNCULO') as seller_name
    from sales_canonical_dedup s
    left join public.usuarios u on u.id = s.seller_user_id
    left join public.portal_sellers ps on ps.id = s.seller_id
    where s.sale_date between p_start and p_end
      and (
        v_is_master
        or (
          coalesce(s.seller_user_id, s.seller_id) is not null
          and s.department = any(v_departments)
          and (
            v_is_director
            or (
              v_is_seller and s.seller_user_id = v_user_id
            )
            or (
              not v_is_seller
              and upper(coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), u.loja, ps.store, '')) = v_store
            )
          )
        )
      )
  ),
  sales_groups as (
    select
      store,
      department,
      seller_id,
      seller_name,
      count(*)::integer as sales_count,
      coalesce(sum(sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales
    group by store, department, seller_id, seller_name
  ),
  finance_groups as (
    select
      vs.store,
      vs.department,
      vs.seller_id,
      vs.seller_name,
      count(distinct f.id) filter (
        where f.is_real_financing or f.is_later_return
      )::integer as financed_count,
      coalesce(sum(f.financed_or_service_value), 0)::numeric(18,2)
        as financed_or_service_value,
      coalesce(sum(f.return_value), 0)::numeric(18,2) as return_value
    from visible_sales vs
    left join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and f.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA3 (Fase 2/7): este join e SOMENTE por chassi --
     -- sem esta linha, uma linha financeira REVENDA do MESMO chassi de uma
     -- venda legitima (padrao T34887) entraria na agregacao financeira da
     -- venda legitima mesmo com visible_sales ja filtrada. Exclusao pelo
     -- store PROPRIO da linha financeira, nunca pelo chassi.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    group by vs.store, vs.department, vs.seller_id, vs.seller_name
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'store', sg.store,
        'department', sg.department,
        'seller_id', sg.seller_id,
        'seller_name', sg.seller_name,
        'sales_count', sg.sales_count,
        'sales_value', sg.sales_value,
        'financed_count', coalesce(fg.financed_count, 0),
        'financed_or_service_value',
          coalesce(fg.financed_or_service_value, 0),
        'return_value', coalesce(fg.return_value, 0)
      )
      order by sg.store, sg.department, sg.seller_name
    ),
    '[]'::jsonb
  )
  into v_rows
  from sales_groups sg
  left join finance_groups fg
    on fg.store = sg.store
   and fg.department = sg.department
   and fg.seller_id is not distinct from sg.seller_id
   and fg.seller_name = sg.seller_name;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'rows', v_rows
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.operational_salary_details(p_start date, p_end date, p_seller_id uuid DEFAULT NULL::uuid)
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
  v_rows jsonb;
  v_total_rows integer;
  v_seller_count integer;
  v_limit constant integer := 2000;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Periodo maximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_store := v_scope->>'store';
  v_departments := array(
    select upper(trim(jsonb_array_elements_text(v_scope->'departments')))
  );
  v_is_master := coalesce((v_scope->>'is_master')::boolean, false);
  v_is_director := coalesce((v_scope->>'is_director')::boolean, false);

  -- RH (perfil corporativo): lê Salários & Comissões de todo o grupo -- todas as
  -- lojas, NOVOS e SEMINOVOS -- com o mesmo alcance de leitura do diretor. Só
  -- muda algo quando o perfil resolvido por operational_current_scope() é 'RH'.
  v_is_director := coalesce(v_is_director, false) or (v_scope->>'profile') = 'RH';
  v_is_seller := coalesce((v_scope->>'is_seller')::boolean, false);

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY','SPF_CURRENT')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  spf_cur as materialized (
    -- Desempenho: SPF somente do lote vigente, lido uma vez (antes: busca por cliente em todos os lotes,
    -- ~4,3 mi de linhas intermediarias em 6 meses). Mesmo filtro de lote que ja existia no join abaixo.
    select spf.id, spf.client_match_key, spf.optional_value, spf.is_spf_extra, spf.store, spf.batch_id
    from public.portal_spf_operations spf
    where spf.batch_id in (select lb.id from latest_batches lb)
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (p_seller_id is null or u.id = p_seller_id)
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
              and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_store))
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, '')))
        not in ('REVENDA', 'INATIVO', 'MASTER')
      and (p_seller_id is null or ps.id = p_seller_id)
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
              and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_store))
            )
          )
        )
      )
  ),
  sales_global_ranked as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_id,
      s.seller_user_id,
      s.store,
      s.department,
      s.vehicle_model,
      s.sale_value,
      row_number() over (
        partition by s.chassis
        order by s.sale_date desc, s.id desc
      ) as chassis_rank
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    -- Incidente REVENDA2 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do join a
    -- eligible_sellers (linha abaixo, visible_sales) e ANTES de qualquer
    -- fallback resolve_store_temporal. Nunca por chassi: uma venda NOVOS
    -- legitima e uma linha REVENDA podem compartilhar o mesmo chassi
    -- colidido (T34887) e permanecem tratadas como linhas distintas.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
  ),
  visible_sales as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      ps.id as seller_id,
      ps.name as seller_name,
      coalesce(public.resolve_store_temporal(ps.id, s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      upper(trim(coalesce(public.resolve_department_temporal(ps.id, s.sale_date, null), ps.status, s.department, ''))) as department,
      coalesce(nullif(s.vehicle_model, ''), 'NAO INFORMADO')
        as vehicle_model,
      coalesce(s.sale_value, 0)::numeric(18,2) as sale_value,
      s.chassis_rank = 1 as included_in_commission
    from sales_global_ranked s
    join eligible_sellers ps on ps.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
      -- Incidente IA-1B: mesmo principio do IA-1A -- para DIRETOR, autorizacao
      -- vale sobre o departamento EFETIVO (temporal) do fato. Finance/SPF
      -- derivam de visible_sales via join por chassi/sale_id (finance_by_sale,
      -- spf_links), entao este gate unico fecha os tres.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(ps.id, s.sale_date, null), ps.status, s.department, ''))) = any(v_departments)
      )
  ),
  finance_by_sale as (
    select
      vs.id as sale_id,
      -- Incidente Salary-Details-Later-Return: um chassi tambem conta como
      -- financiado quando so existe um registro de retorno tardio
      -- (is_later_return), mesma regra ja aplicada por operational_metrics
      -- (effective_finance) e ja usada nesta mesma linha em
      -- return_considered, alguns campos abaixo.
      bool_or(
        coalesce(f.is_real_financing, false)
        or coalesce(f.is_later_return, false)
      ) as financed,
      min(f.operation_date) filter (
        where f.is_real_financing
      ) as finance_date,
      coalesce(sum(f.financed_or_service_value) filter (
        where f.is_real_financing
      ), 0)::numeric(18,2) as financed_value,
      coalesce(sum(f.return_value), 0)::numeric(18,2)
        as return_gross,
      coalesce(sum(f.return_value) filter (
        where f.is_real_financing or f.is_later_return
      ), 0)::numeric(18,2) as return_considered,
      max(f.installments) filter (
        where f.is_real_financing
      ) as installments,
      max(f.installment_value) filter (
        where f.is_real_financing
      )::numeric(18,2) as installment_value,
      max(nullif(f.finance_code, '')) filter (
        where f.is_real_financing
      ) as finance_code,
      max(nullif(f.service_description, '')) filter (
        where f.is_real_financing
      ) as service_description
    from visible_sales vs
    left join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and vs.included_in_commission
     and f.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA2 (Fase 2/7): este join e SOMENTE por chassi --
     -- sem esta linha, uma linha financeira REVENDA do MESMO chassi de uma
     -- venda NOVOS legitima (T34887) entraria na agregacao financeira da
     -- venda legitima mesmo com sales_global_ranked ja filtrada. Exclusao
     -- pelo store PROPRIO da linha financeira, nunca pelo chassi.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    group by vs.id
  ),
  spf_links as (
    select distinct
      vs.id as sale_id,
      spf.id,
      coalesce(spf.optional_value, 0)::numeric(18,2) as optional_value,
      spf.is_spf_extra
    from visible_sales vs
    join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and vs.included_in_commission
     -- Incidente REVENDA2 (Fase 2/7): mesma exclusao de finance_by_sale --
     -- uma linha financeira REVENDA do mesmo chassi nunca alimenta o SPF
     -- de uma venda legitima via este join intermediario.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    join spf_cur spf
      on spf.client_match_key = f.client_match_key
     -- Incidente Salary-Details-SPF-Batch-Scope: restringe SPF ao mesmo
     -- lote SPF_CURRENT VALIDATED mais recente (latest_batches, acima),
     -- mesmo padrao ja usado por finance_by_sale (f.batch_id) e por
     -- operational_model_metrics.spf_linked -- evita somar reimportacoes
     -- historicas da mesma linha SPF.
     and spf.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA2 (Fase 2/7): exclusao tambem pelo store PROPRIO
     -- da linha SPF (leitura direta de portal_spf_operations), mesmo
     -- predicado canonico aplicado a toda leitura direta desta tabela
     -- neste incidente.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
  ),
  spf_by_sale as (
    select
      sl.sale_id,
      count(*) filter (
        where sl.is_spf_extra and sl.optional_value > 0
      )::integer as spf_count,
      coalesce(sum(sl.optional_value), 0)::numeric(18,2)
        as spf_gross,
      coalesce(sum(sl.optional_value) filter (
        where sl.is_spf_extra and sl.optional_value > 0
      ), 0)::numeric(18,2) as spf_considered
    from spf_links sl
    group by sl.sale_id
  ),
  detail_rows as (
    select
      vs.sale_date,
      fbs.finance_date,
      vs.store,
      vs.department,
      vs.vehicle_model,
      vs.seller_id,
      vs.seller_name,
      encode(
        extensions.digest(
          'PORTAL-FI-SALE:' || vs.id::text || ':' || vs.sale_date::text,
          'sha256'
        ),
        'hex'
      ) as operation_ref,
      case
        when nullif(trim(vs.chassis), '') is null then ''
        else '******' || right(trim(vs.chassis), 6)
      end as chassis_masked,
      vs.sale_value,
      coalesce(fbs.financed, false) as financed,
      coalesce(fbs.financed_value, 0)::numeric(18,2)
        as financed_value,
      coalesce(fbs.return_gross, 0)::numeric(18,2)
        as return_gross,
      coalesce(fbs.return_considered, 0)::numeric(18,2)
        as return_considered,
      fbs.installments,
      fbs.installment_value,
      coalesce(
        fbs.finance_code,
        fbs.service_description,
        ''
      ) as modality,
      coalesce(sbs.spf_count, 0) as spf_count,
      coalesce(sbs.spf_gross, 0)::numeric(18,2) as spf_gross,
      coalesce(sbs.spf_considered, 0)::numeric(18,2)
        as spf_considered,
      round(
        coalesce(sbs.spf_considered, 0) * 0.70,
        2
      )::numeric(18,2) as spf_70,
      round(
        coalesce(fbs.return_considered, 0)
        + coalesce(sbs.spf_considered, 0) * 0.70,
        2
      )::numeric(18,2) as operation_profitability,
      vs.included_in_commission,
      case
        when vs.included_in_commission then ''
        else 'REGISTRO DUPLICADO: SOMENTE A VENDA MAIS RECENTE DO CHASSI E CONSIDERADA'
      end as exclusion_reason,
      case
        when vs.included_in_commission
          then 'FAIXA CONSOLIDADA DO VENDEDOR'
        else 'FORA DA BASE DE CALCULO'
      end as applied_rule
    from visible_sales vs
    left join finance_by_sale fbs on fbs.sale_id = vs.id
    left join spf_by_sale sbs on sbs.sale_id = vs.id
  ),
  limited_rows as (
    select *
    from detail_rows
    order by sale_date desc, operation_ref
    limit v_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', dr.sale_date,
          'finance_date', dr.finance_date,
          'store', dr.store,
          'department', dr.department,
          'vehicle_model', dr.vehicle_model,
          'seller_id', dr.seller_id,
          'seller_name', dr.seller_name,
          'operation_ref', left(dr.operation_ref, 12),
          'chassis_masked', dr.chassis_masked,
          'sale_value', dr.sale_value,
          'financed', dr.financed,
          'financed_value', dr.financed_value,
          'installments', dr.installments,
          'installment_value', dr.installment_value,
          'modality', dr.modality,
          'return_gross', dr.return_gross,
          'return_considered', dr.return_considered,
          'spf_count', dr.spf_count,
          'spf_gross', dr.spf_gross,
          'spf_considered', dr.spf_considered,
          'spf_70', dr.spf_70,
          'operation_profitability', dr.operation_profitability,
          'included_in_commission', dr.included_in_commission,
          'exclusion_reason', dr.exclusion_reason,
          'applied_rule', dr.applied_rule
        )
        order by dr.sale_date desc, dr.operation_ref
      ),
      '[]'::jsonb
    ),
    count(distinct dr.seller_id)::integer
  into v_rows, v_seller_count
  from limited_rows dr;

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  eligible_sellers as (
    select u.id, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (p_seller_id is null or u.id = p_seller_id)
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
              and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_store))
            )
          )
        )
      )
    union all
    select ps.id, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, '')))
        not in ('REVENDA', 'INATIVO', 'MASTER')
      and (p_seller_id is null or ps.id = p_seller_id)
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
              and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_store))
            )
          )
        )
      )
  ),
  ranked as (
    select
      s.id,
      s.sale_date,
      s.seller_id,
      s.seller_user_id,
      s.department,
      row_number() over (
        partition by s.chassis
        order by s.sale_date desc, s.id desc
      ) as chassis_rank
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    -- Incidente REVENDA2 (Fase 2): mesma exclusao de sales_global_ranked
    -- acima -- esta e uma SEGUNDA leitura independente de portal_sales,
    -- usada so para o total (v_total_rows/seller_count/truncated). Sem
    -- este filtro aqui tambem, o total exibido divergiria das linhas
    -- realmente retornadas em v_rows.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
  )
  select count(*)::integer
  into v_total_rows
  from ranked r
  join eligible_sellers es on es.id = coalesce(r.seller_user_id, r.seller_id)
  where r.sale_date between p_start and p_end
    -- Incidente IA-1B: mesmo gate de visible_sales, para manter row_count/
    -- seller_count/truncated consistentes com o array rows retornado.
    and (
      not v_is_director
      or upper(trim(coalesce(public.resolve_department_temporal(es.id, r.sale_date, null), es.status, r.department, ''))) = any(v_departments)
    );

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'seller_filter', p_seller_id,
    'seller_count', coalesce(v_seller_count, 0),
    'row_count', coalesce(v_total_rows, 0),
    'row_limit', v_limit,
    'truncated', coalesce(v_total_rows, 0) > v_limit,
    'rows', v_rows,
    'contains_client_identity', false,
    'contains_personal_documents', false,
    'contains_full_chassis', false,
    'contains_masked_chassis', true,
    'contains_chassis', false,
    'contains_nbs', false
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.operational_own_commission_summary(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.operational_scope_commission_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.operational_commission_faixa_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.operational_gestor_fi_commission(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios;
  v_beneficiary_count integer;
  v_beneficiary public.usuarios;
  v_metrics jsonb;
  v_totals jsonb;
  v_share_minimo numeric;
  v_faixa_baixo numeric;
  v_faixa_alto numeric;
  v_bonus_unit numeric;
  v_spf_liquido_percentual numeric;
  v_formula jsonb;
  v_vendidas integer;
  v_financiadas integer;
  v_producao numeric;
  v_retorno numeric;
  v_spf numeric;
  v_spf_qty integer;
begin
  -- Auth gate: MASTER only, matching master_close_commission_period's
  -- own inline pattern (Pattern C, RH-5C schema audit).
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

  -- Beneficiary identity: fail closed on 0 or >1 flagged active users,
  -- exactly matching V1's own gestorFIIdentidadeSegura() fail-closed
  -- contract (returns null / blocks, never guesses).
  select count(*) into v_beneficiary_count
  from public.usuarios u
  where u.gestor_fi_beneficiario is true and u.ativo is true;

  if v_beneficiary_count <> 1 then
    return jsonb_build_object(
      'pronto', false,
      'motivo', case
        when v_beneficiary_count = 0 then 'NENHUM_BENEFICIARIO_CONFIGURADO'
        else 'MULTIPLOS_BENEFICIARIOS_CONFIGURADOS'
      end
    );
  end if;

  select u.* into v_beneficiary
  from public.usuarios u
  where u.gestor_fi_beneficiario is true and u.ativo is true
  limit 1;

  -- Reuse the same governed aggregate the live V1 code reads (never
  -- re-summed from individual rows).
  v_metrics := public.operational_commission_metrics(p_start, p_end);
  v_totals := coalesce(v_metrics -> 'totals', '{}'::jsonb);

  v_vendidas := coalesce((v_totals ->> 'sold_count')::integer, 0);
  v_financiadas := coalesce((v_totals ->> 'financed_count')::integer, 0);
  v_producao := coalesce((v_totals ->> 'production_value')::numeric, 0);
  v_retorno := coalesce((v_totals ->> 'return_value')::numeric, 0);
  v_spf := coalesce((v_totals ->> 'spf_value')::numeric, 0);
  v_spf_qty := coalesce((v_totals ->> 'spf_count')::integer, 0);

  -- Config reads, same sanitize-then-cast pattern used throughout this
  -- schema (configuracoes.valor is text).
  select
    max(case when chave = 'gestor_fi_share_minimo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_bonus_spf' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'spf_liquido_percentual' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end)
  into v_share_minimo, v_faixa_baixo, v_faixa_alto, v_bonus_unit, v_spf_liquido_percentual
  from public.configuracoes
  where chave in ('gestor_fi_share_minimo', 'gestor_fi_faixa_share_baixo', 'gestor_fi_faixa_share_alto', 'gestor_fi_bonus_spf', 'spf_liquido_percentual');

  v_share_minimo := coalesce(v_share_minimo, 40);
  v_faixa_baixo := coalesce(v_faixa_baixo, 0.16);
  v_faixa_alto := coalesce(v_faixa_alto, 0.30);
  v_bonus_unit := coalesce(v_bonus_unit, 30);
  v_spf_liquido_percentual := coalesce(v_spf_liquido_percentual, 70);

  v_formula := public._operational_gestor_fi_formula(
    v_vendidas, v_financiadas, v_retorno, v_spf, v_spf_qty,
    v_share_minimo, v_faixa_baixo, v_faixa_alto, v_bonus_unit, v_spf_liquido_percentual
  );

  return jsonb_build_object(
    'pronto', true,
    'period_start', p_start,
    'period_end', p_end,
    'beneficiary_name', v_beneficiary.nome,
    'vendidas', v_vendidas,
    'financiadas', v_financiadas,
    'share', round((v_formula ->> 'share')::numeric, 4),
    'producao', v_producao,
    'retorno', v_retorno,
    'spf', v_spf,
    'spf_qty', v_spf_qty,
    'spf_liquido', (v_formula ->> 'spf_liquido')::numeric,
    'base', (v_formula ->> 'base')::numeric,
    'faixa', (v_formula ->> 'faixa')::numeric,
    'comissao_principal', (v_formula ->> 'comissao_principal')::numeric,
    'bonus_spf', (v_formula ->> 'bonus_spf')::numeric,
    'comissao_final', (v_formula ->> 'comissao_final')::numeric,
    'contains_client_identity', false,
    'contains_personal_documents', false
  );
end;
$function$
;

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
$function$
;

DROP FUNCTION IF EXISTS public._operational_metrics_core(date, date, boolean);
DROP FUNCTION IF EXISTS public._operational_commission_metrics_core(date, date);
DROP FUNCTION IF EXISTS public._operational_model_metrics_without_spf_core(date, date, boolean);
DROP FUNCTION IF EXISTS public._operational_reporting_summary_core(date, date);
DROP FUNCTION IF EXISTS public._operational_salary_details_core(date, date, uuid);
DROP FUNCTION IF EXISTS public._operational_own_commission_summary_core(date, date);
DROP FUNCTION IF EXISTS public._operational_scope_commission_rows_core(date, date);
DROP FUNCTION IF EXISTS public._operational_ocultar_retorno_vendedor(jsonb);
DROP FUNCTION IF EXISTS public._jsonb_sem_chaves(jsonb, text[]);
commit;

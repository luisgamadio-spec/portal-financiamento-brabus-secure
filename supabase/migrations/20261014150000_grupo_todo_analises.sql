-- Aplicado em produção em 14/10/2026 (OK do Luis). REGRA: Análise F&I do Grupo e Análise Geral do Grupo = GRUPO TODO
-- (8 lojas, todos os departamentos) para todos os perfis. NÃO restringir por loja. Já voltou uma vez (08/10, migração
-- 20261008200000_retorno_so_perfis_autorizados). Teste obrigatório depois de qualquer migração nestas funções:
--   supabase/tests/grupo_todo_8_lojas.sql

-- GRUPO TODO nas telas Análise F&I do Grupo e Análise Geral do Grupo (14/10/2026, decisões do Luis)
-- Desfazer: G_desfazer.sql
begin;

CREATE OR REPLACE FUNCTION public._operational_grupo_retorno_por_loja(p jsonb, p_group_view boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_perfil text;
  v_loja text;
  v_proprias jsonb;
  v_outras jsonb;
begin
  -- REGRA (14/10/2026, Luis): na Análise Geral do Grupo (p_group_view), ANALISTA e GERENTE recebem o retorno POR VENDEDOR
  -- só da própria loja; das outras lojas, só o total por loja: uma linha por loja/departamento, sem vendedor
  -- (seller_id nulo, seller_name 'TOTAL DA LOJA', agregado_loja = true), com os mesmos totais (vendas, financiamentos,
  -- produção, retorno, SPF e planos) -- os totais por loja da tela continuam exatos. Demais perfis: sem mudança
  -- (Master/diretoria veem tudo; vendedor/RH já não recebem retorno).
  if p is null or not coalesce(p_group_view, false) then
    return p;
  end if;
  select upper(trim(coalesce(u.perfil, ''))) into v_perfil
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;
  if v_perfil is null or v_perfil not in ('ANALISTA', 'GERENTE') then
    return p;
  end if;
  v_loja := nullif(upper(trim(coalesce(public.operational_current_scope() ->> 'store', ''))), '');

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_proprias
  from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
  where v_loja is not null and upper(trim(coalesce(x ->> 'store', ''))) = v_loja;

  with outras as (
    select x from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
    where v_loja is null or upper(trim(coalesce(x ->> 'store', ''))) is distinct from v_loja
  ),
  tot as (
    select x ->> 'store' as store, x ->> 'department' as department,
      sum(coalesce((x ->> 'sold_count')::numeric, 0)) as sold,
      sum(coalesce((x ->> 'sales_value')::numeric, 0)) as sales,
      sum(coalesce((x ->> 'financed_count')::numeric, 0)) as fin,
      sum(coalesce((x ->> 'production_value')::numeric, 0)) as prod,
      sum(coalesce((x ->> 'return_value')::numeric, 0)) as ret,
      sum(coalesce((x ->> 'spf_count')::numeric, 0)) as spfc,
      sum(coalesce((x ->> 'spf_value')::numeric, 0)) as spf,
      sum(coalesce((x ->> 'spf_net_value')::numeric, 0)) as spfn,
      sum(coalesce((x ->> 'profitability_value')::numeric, 0)) as rent
    from outras
    group by 1, 2
  ),
  pb as (
    select o.x ->> 'store' as store, o.x ->> 'department' as department, b ->> 'plan_type' as plan_type,
      sum(coalesce((b ->> 'financed_count')::numeric, 0)) as fc,
      sum(coalesce((b ->> 'production_value')::numeric, 0)) as pv,
      sum(coalesce((b ->> 'return_value')::numeric, 0)) as rv,
      sum(coalesce((b ->> 'average_balloon_value')::numeric, 0) * coalesce((b ->> 'financed_count')::numeric, 0)) as bal_w
    from outras o, jsonb_array_elements(coalesce(o.x -> 'plan_breakdown', '[]'::jsonb)) b
    group by 1, 2, 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'seller_id', null, 'seller_name', 'TOTAL DA LOJA', 'agregado_loja', true,
      'store', t.store, 'department', t.department,
      'sold_count', t.sold::integer, 'sales_value', round(t.sales, 2), 'financed_count', t.fin::integer,
      'share_percent', case when t.sold > 0 then round(t.fin / t.sold * 100, 4) else 0 end,
      'production_value', round(t.prod, 2), 'return_value', round(t.ret, 2),
      'spf_count', t.spfc::integer, 'spf_value', round(t.spf, 2), 'spf_net_value', round(t.spfn, 2),
      'profitability_value', round(t.rent, 2),
      'plan_breakdown', coalesce((
        select jsonb_agg(jsonb_build_object('plan_type', b.plan_type, 'financed_count', b.fc::integer,
          'production_value', round(b.pv, 2), 'return_value', round(b.rv, 2),
          'average_balloon_value', case when b.fc > 0 then round(b.bal_w / b.fc, 2) else 0 end) order by b.plan_type)
        from pb b where b.store is not distinct from t.store and b.department is not distinct from t.department), '[]'::jsonb)
    ) order by t.store, t.department), '[]'::jsonb)
  into v_outras
  from tot t;

  return jsonb_set(p, '{rows}', v_proprias || v_outras, true)
    || jsonb_build_object('retorno_outras_lojas', 'TOTAL_POR_LOJA');
end;
$function$;
revoke all on function public._operational_grupo_retorno_por_loja(jsonb, boolean) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public._operational_metrics_core(p_start date, p_end date, p_group_view boolean DEFAULT false)
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

  -- REGRA (14/10/2026, Luis): "Análise Geral do Grupo" = GRUPO TODO (8 lojas, todos os departamentos) para TODOS os
  -- perfis. NÃO restringir por loja. p_group_view só é enviado pela tela Análise Geral do Grupo (dashbi) e pela Brabus IA,
  -- e só vale para quem tem o módulo dashbi liberado (portal_modulos_permitidos, decidido no servidor -- correção de
  -- segurança de 24/08). Retorno: vendedor e RH continuam sem retorno (_operational_ocultar_retorno_vendedor) e
  -- ANALISTA/GERENTE recebem as outras lojas só como total por loja (_operational_grupo_retorno_por_loja), ambos no
  -- wrapper público. Salários, Score e detalhe por vendedor NÃO enviam p_group_view e não mudam.
  if coalesce(p_group_view, false) then
    select upper(trim(coalesce(u.perfil, ''))) into v_group_view_perfil
    from public.usuarios u
    where u.auth_user_id = auth.uid() and u.ativo = true
    limit 1;
    if (v_group_view_perfil in ('ANALISTA', 'GERENTE', 'VENDEDOR') or v_group_view_perfil like 'DIRETOR%')
       and (public.portal_modulos_permitidos() ? 'dashbi') then
      v_is_master := true;
      v_is_director := false;  -- todos os departamentos (decisão 4)
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
              -- loja vigente (13/10/2026): o recorte por loja é feito em cada fato, pela loja vigente na data (abaixo), não pela loja do cadastro
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
              -- loja vigente (13/10/2026): o recorte por loja é feito em cada fato, pela loja vigente na data (abaixo), não pela loja do cadastro
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
      -- loja vigente (13/10/2026): s.store já é a loja vigente na data da venda (resolve_store_temporal, acima)
      and (coalesce(v_is_master, false) or coalesce(v_is_director, false) or coalesce(v_is_seller, false) or upper(trim(s.store)) = v_store)
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
      -- loja vigente (13/10/2026): mesma loja efetiva usada em effective_store, acima
      and (coalesce(v_is_master, false) or coalesce(v_is_director, false) or coalesce(v_is_seller, false) or upper(trim(coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA'))) = v_store)
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

CREATE OR REPLACE FUNCTION public._operational_model_metrics_without_spf_core(p_start date, p_end date, p_group_view boolean DEFAULT false)
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

  -- REGRA (14/10/2026, Luis): "Análise Geral do Grupo" = GRUPO TODO (8 lojas, todos os departamentos) para TODOS os
  -- perfis. NÃO restringir por loja. p_group_view só é enviado pela tela Análise Geral do Grupo (dashbi) e pela Brabus IA,
  -- e só vale para quem tem o módulo dashbi liberado (portal_modulos_permitidos, decidido no servidor -- correção de
  -- segurança de 24/08). Retorno: vendedor e RH continuam sem retorno (_operational_ocultar_retorno_vendedor) e
  -- ANALISTA/GERENTE recebem as outras lojas só como total por loja (_operational_grupo_retorno_por_loja), ambos no
  -- wrapper público. Salários, Score e detalhe por vendedor NÃO enviam p_group_view e não mudam.
  if coalesce(p_group_view, false) then
    select upper(trim(coalesce(u.perfil, ''))) into v_group_view_perfil
    from public.usuarios u
    where u.auth_user_id = auth.uid() and u.ativo = true
    limit 1;
    if (v_group_view_perfil in ('ANALISTA', 'GERENTE', 'VENDEDOR') or v_group_view_perfil like 'DIRETOR%')
       and (public.portal_modulos_permitidos() ? 'dashbi') then
      v_is_master := true;
      v_is_director := false;  -- todos os departamentos (decisão 4)
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
$function$;

CREATE OR REPLACE FUNCTION public.operational_metrics(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  -- 14/10/2026: na visão de grupo, ANALISTA/GERENTE recebem as outras lojas só como total por loja (regra do Luis).
  return public._operational_grupo_retorno_por_loja(
    public._operational_ocultar_retorno_vendedor(public._operational_metrics_core(p_start, p_end, p_group_view)), p_group_view);
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_fandi_dashboard(p_start date, p_end date, p_store text DEFAULT NULL::text, p_department text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_scope_store text;
  v_departments text[];
  v_store text;
  v_department text;
  v_batch_id uuid;
  v_result jsonb;
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
  v_scope_store := nullif(upper(trim(coalesce(v_scope->>'store', ''))), '');
  -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja do
  -- proprio perfil (identidade de autorizacao) para o mesmo alvo usado
  -- pelos dados. Valor nao reconhecido (ex. 'REVENDA') vira NULL e cai
  -- no 'Perfil sem loja autorizada.' abaixo -- falha fechada.
  if v_scope_store is not null then
    v_scope_store := case v_scope_store
      when 'ABC' then 'ABC'
      when 'MITSUBISHI | ABC' then 'ABC'
      when 'ALPHAVILLE' then 'ALPHAVILLE'
      when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
      when 'ANALIA FRANCO' then 'ANALIA FRANCO'
      when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
      when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
      when 'BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
      when 'BARRA FUNDA' then 'BARRA FUNDA'
      when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
      when 'EUROPA' then 'EUROPA'
      when 'MITSUBISHI | EUROPA' then 'EUROPA'
      when 'GASTAO' then 'GASTAO'
      when 'GASTÃO VIDIGAL' then 'GASTAO'
      when 'MITSUBISHI | GASTAO' then 'GASTAO'
      when 'NACOES' then 'NACOES'
      when 'NAÇÕES UNIDAS' then 'NACOES'
      when 'MITSUBISHI | NACOES' then 'NACOES'
      else null
    end;
  end if;
  v_departments := array(
    select upper(jsonb_array_elements_text(v_scope->'departments'))
  );
  -- REGRA (14/10/2026, Luis): todos os departamentos na Análise F&I do Grupo, para todos os perfis.
  v_departments := array['NOVOS', 'SEMINOVOS'];

  if v_profile not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR DE NOVOS',
    'DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR'
  ) then
    raise exception 'Perfil sem acesso à Análise F&I.' using errcode = '42501';
  end if;

  v_store := nullif(upper(trim(coalesce(p_store, ''))), '');
  if v_store in ('ALL', 'TODAS', 'TODOS') then v_store := null; end if;
  -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja
  -- solicitada pelo frontend (nome de exibicao ou codigo ja canonico)
  -- para o mesmo alvo usado pelos dados -- relevante apenas para perfis
  -- GLOBAIS abaixo, ja que perfis store-scoped ignoram p_store
  -- inteiramente. Valor nao reconhecido MANTEM-SE como veio (nunca vira
  -- NULL/"todas as lojas") -- garante 0 resultados em vez de ampliar
  -- escopo, sem inventar mapeamento por semelhanca (Gate 5 do design:
  -- 0 LIKE, 0 similarity, 0 fallback difuso).
  if v_store is not null then
    v_store := case v_store
      when 'ABC' then 'ABC'
      when 'MITSUBISHI | ABC' then 'ABC'
      when 'ALPHAVILLE' then 'ALPHAVILLE'
      when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
      when 'ANALIA FRANCO' then 'ANALIA FRANCO'
      when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
      when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
      when 'BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
      when 'BARRA FUNDA' then 'BARRA FUNDA'
      when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
      when 'EUROPA' then 'EUROPA'
      when 'MITSUBISHI | EUROPA' then 'EUROPA'
      when 'GASTAO' then 'GASTAO'
      when 'GASTÃO VIDIGAL' then 'GASTAO'
      when 'MITSUBISHI | GASTAO' then 'GASTAO'
      when 'NACOES' then 'NACOES'
      when 'NAÇÕES UNIDAS' then 'NACOES'
      when 'MITSUBISHI | NACOES' then 'NACOES'
      else v_store
    end;
  end if;
  v_department := nullif(upper(trim(coalesce(p_department, ''))), '');
  if v_department in ('ALL', 'TODOS', 'TODAS') then v_department := null; end if;
  if v_department is not null and v_department not in ('NOVOS', 'SEMINOVOS') then
    raise exception 'Departamento inválido.' using errcode = '22023';
  end if;
  if v_department is not null and not (v_department = any(v_departments)) then
    raise exception 'Departamento fora do escopo.' using errcode = '42501';
  end if;

  -- MASTER, directors and (Incidente RBAC-Analista-Fandi-Group-Scope)
  -- ANALISTA may choose a store, including group-wide (NULL/ALL). Only
  -- GERENTE/VENDEDOR remain store-scoped.
  -- Incidente RBAC-Analista-Fandi-Store-Scope: p_store nao e mais
  -- consultado para autorizacao NEM para o filtro efetivo de perfis
  -- store-scoped -- a loja efetiva e SEMPRE v_scope_store (ja
  -- canonicalizada acima). Uma chamada manuscrita com p_store de outra
  -- loja e simplesmente ignorada; nunca pode alterar a loja efetiva.
  -- Isso reforca a autorizacao (o parametro deixa de ser confiavel de
  -- qualquer forma para esses perfis) em vez de afrouxa-la.
  -- REGRA (14/10/2026, Luis): "Análise F&I do Grupo" = GRUPO TODO para todos os perfis. NÃO restringir por loja.
  -- Todo perfil com acesso escolhe a loja ou o grupo todo (p_store nulo/ALL). A saída é só agregada por loja,
  -- banco, plano e situação (sem retorno, sem vendedor, sem contrato).

  select b.id into v_batch_id
  from public.portal_import_batches b
  where b.source_type = 'SPF_CURRENT'
    and b.status = 'VALIDATED'
  order by b.completed_at desc nulls last, b.created_at desc, b.id desc
  limit 1;

  if v_batch_id is null then
    raise exception 'Nenhum lote SPF validado disponível.' using errcode = 'P0002';
  end if;

  with spf_context as materialized (
    -- FIX-AUDIT-01: linhas auxiliares SPF EXTRA nao carregam store/department
    -- proprios (ficam NULL na origem). Resolve o contexto a partir da linha
    -- irma mais antiga (menor source_row_number) do MESMO cliente na MESMA
    -- data que possua store preenchido -- mesma convencao de desempate ja
    -- usada pela CTE "proposals" abaixo para store/department
    -- ((array_agg(... order by source_row_number))[1]). So roda para linhas
    -- SPF EXTRA sem store, mantendo todo o resto de source_rows intocado.
    -- Sem candidato -> ctx_store/ctx_department ficam NULL -> comportamento
    -- fail-closed identico ao atual (linha permanece "NAO INFORMADO" e
    -- continua fora do scope, como hoje).
    select
      spf.source_row_number,
      ctx.store as ctx_store,
      ctx.department as ctx_department
    from public.portal_spf_operations spf
    left join lateral (
      select m.store, m.department
      from public.portal_spf_operations m
      where m.batch_id = spf.batch_id
        and m.client_match_key = spf.client_match_key
        and m.operation_date = spf.operation_date
        and m.store is not null
      order by m.source_row_number
      limit 1
    ) ctx on true
    where spf.batch_id = v_batch_id
      and spf.is_spf_extra
      and spf.store is null
  ), source_rows as (
    select
      s.source_row_number,
      s.operation_date,
      s.client_match_key,
      s.modality,
      -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja de
      -- origem (que carrega prefixo de marca, ex. "MITSUBISHI | GASTAO",
      -- ou nem sempre com "| ", ex. "MITSUBISHI BANDEIRANTES") para o
      -- MESMO alvo usado por v_store/v_scope_store acima -- este e o
      -- unico ponto de leitura de portal_spf_operations.store para toda
      -- a funcao, entao a correcao aqui se propaga a stores/banks/plans/
      -- spf_extra/proposal_outcomes/summary sem precisar de patch por
      -- metrica. Valor nao reconhecido mantem-se como veio (nao vira
      -- 'NAO INFORMADO', que continua reservado para ausencia real de
      -- dado) -- nunca inventa correspondencia com uma loja canonica.
      coalesce(
        nullif(
          case upper(trim(coalesce(s.store, sc.ctx_store)))
            when 'ABC' then 'ABC'
            when 'MITSUBISHI | ABC' then 'ABC'
            when 'ALPHAVILLE' then 'ALPHAVILLE'
            when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
            when 'ANALIA FRANCO' then 'ANALIA FRANCO'
            when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
            when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
            when 'BANDEIRANTES' then 'BANDEIRANTES'
            when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
            when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
            when 'BARRA FUNDA' then 'BARRA FUNDA'
            when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
            when 'EUROPA' then 'EUROPA'
            when 'MITSUBISHI | EUROPA' then 'EUROPA'
            when 'GASTAO' then 'GASTAO'
            when 'GASTÃO VIDIGAL' then 'GASTAO'
            when 'MITSUBISHI | GASTAO' then 'GASTAO'
            when 'NACOES' then 'NACOES'
            when 'NAÇÕES UNIDAS' then 'NACOES'
            when 'MITSUBISHI | NACOES' then 'NACOES'
            else upper(trim(coalesce(s.store, sc.ctx_store)))
          end,
          ''
        ),
        'NÃO INFORMADO'
      ) as store,
      case
        when upper(coalesce(s.department, sc.ctx_department, '')) like '%SEMINOV%' then 'SEMINOVOS'
        when upper(coalesce(s.department, sc.ctx_department, '')) like '%NOVO%'
          or upper(coalesce(s.department, sc.ctx_department, '')) like '%VENDA%DIRETA%' then 'NOVOS'
        else 'NÃO INFORMADO'
      end as department,
      nullif(upper(trim(coalesce(s.bank, ''))), '') as bank,
      case
        when upper(coalesce(s.status, '')) like '%AGUARD%FATU%'
          or upper(coalesce(s.status, '')) in ('AG FATURAMENTO', 'AG. FATURAMENTO')
          then 'AG. FATURAMENTO'
        when upper(coalesce(s.status, '')) like '%FATURAD%' then 'FATURADA'
        when upper(coalesce(s.status, '')) like '%PAGA%' then 'PAGA'
        when upper(coalesce(s.status, '')) like '%APROVAD%' then 'APROVADA'
        when upper(coalesce(s.status, '')) like '%ASSINAD%' then 'ASSINADA'
        when upper(coalesce(s.status, '')) like '%TRANSITO%' then 'TRANSITO'
        when upper(coalesce(s.status, '')) like '%ENC%A VISTA%' then 'ENC. A VISTA'
        when upper(coalesce(s.status, '')) like '%ENC%RECUS%' then 'ENC. RECUS.'
        when upper(coalesce(s.status, '')) like '%RECUS%' then 'RECUSADA'
        when upper(coalesce(s.status, '')) like '%ENCERRAD%' then 'ENCERRADA'
        when upper(coalesce(s.status, '')) like '%CANCELAD%' then 'CANCELADA'
        else nullif(upper(trim(coalesce(s.status, ''))), '')
      end as status,
      coalesce(s.financed_value, 0) as financed_value,
      s.installment_value,
      s.balloon_payment,
      s.balloon_value,
      s.finance_code,
      s.tc_returned,
      s.optional_name,
      coalesce(s.optional_value, 0) as optional_value,
      s.is_spf_extra,
      coalesce(
        nullif(trim(s.operation_code), ''),
        concat('CLIENT:', s.client_match_key, '|', coalesce(s.store, ''), '|',
          coalesce(s.operation_date::text, ''))
      ) as proposal_key
    from public.portal_spf_operations s
    left join spf_context sc on sc.source_row_number = s.source_row_number
    where s.batch_id = v_batch_id
      and (s.operation_date is null or s.operation_date between p_start and p_end)
      -- Incidente REVENDA2 (Fase 2/6): exclui a linha cujo proprio store
      -- (ou o herdado da linha-irma via spf_context, mesma fonte usada
      -- pela canonicalizacao logo acima) resolva para REVENDA -- ANTES de
      -- qualquer canonicalizacao/fallback para 'NAO INFORMADO'. REVENDA e
      -- ausencia do universo elegivel desta RPC, nao "zero valor" nem
      -- "NAO INFORMADO". Nao apaga nem altera portal_spf_operations.
      and upper(trim(coalesce(s.store, sc.ctx_store, ''))) <> 'REVENDA'
  ), visible_rows as (
    select * from source_rows r
    where r.department = any(v_departments)
      and (v_department is null or r.department = v_department)
      and (v_store is null or r.store = v_store)
  ), proposals as (
    select
      proposal_key,
      (array_agg(store order by source_row_number) filter (where store <> 'NÃO INFORMADO'))[1] as store,
      (array_agg(department order by source_row_number) filter (where department <> 'NÃO INFORMADO'))[1] as department,
      (array_agg(bank order by source_row_number) filter (where bank is not null))[1] as bank,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as status,
      max(financed_value) as financed_value,
      max(installment_value) as installment_value,
      max(balloon_payment) as balloon_payment,
      max(balloon_value) as balloon_value,
      bool_or(upper(coalesce(modality, '')) like '%FANDI%') as tem_fandi,
      case
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])999([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%SUBSIDIADO%') then 'SUBSIDIADO'
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])777([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%REVERS%') then 'REVERSÃO'
        when bool_or(coalesce(tc_returned, '') ~ '(^|[^0-9])1([^0-9]|$)'
          or upper(coalesce(tc_returned, '')) like '%COPARTICIPADO%') then 'COPARTICIPADO'
        when max(coalesce(balloon_payment, 0)) > 0
          or max(coalesce(balloon_value, 0)) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from visible_rows
    group by proposal_key
  ), operational as (
    select * from proposals
    where status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')
      and tem_fandi
  ), store_metrics as (
    select store,
      count(*)::integer as quantity,
      count(*) filter (where department = 'NOVOS')::integer as new_quantity,
      count(*) filter (where department = 'SEMINOVOS')::integer as used_quantity,
      coalesce(avg(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_financed,
      coalesce(avg(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_financed,
      coalesce(avg(installment_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_installment,
      coalesce(avg(installment_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_installment,
      count(*) filter (where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0)::integer as balloon_quantity,
      coalesce(avg(coalesce(balloon_payment, balloon_value)) filter (
        where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0
      ), 0)::numeric(18,2) as average_balloon,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed
    from operational group by store
  ), bank_metrics as (
    select bank,
      count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed,
      coalesce(avg(financed_value), 0)::numeric(18,2) as average_financed,
      coalesce(sum(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_financed,
      coalesce(sum(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_financed
    from operational where bank is not null group by bank
  ), status_store as (
    select store, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by store, status
  ), status_bank as (
    select bank, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational where bank is not null group by bank, status
  ), plan_metrics as (
    select plan_type, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by plan_type
  ), plan_store_department as (
    select store, department, plan_type, count(*)::integer as quantity
    from operational group by store, department, plan_type
  ), spf_unique as (
    select proposal_key, store, department, optional_value
    from visible_rows
    where is_spf_extra and optional_value > 0
    group by proposal_key, store, department, optional_value
  ), spf_metrics as (
    select store, department,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value,
      (coalesce(sum(optional_value), 0) * 0.70)::numeric(18,2) as spf_70_value
    from spf_unique group by store, department
  ), client_history as (
    select client_match_key,
      (array_agg(store order by source_row_number))[1] as store,
      (array_agg(department order by source_row_number))[1] as department,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as final_status,
      bool_or(status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')) as has_operational,
      max(financed_value) as financed_value
    from visible_rows
    where client_match_key is not null
    group by client_match_key
  ), proposal_outcomes as (
    select store, department,
      case
        when final_status in ('RECUSADA', 'ENC. RECUS.') then 'RECUSADA'
        when final_status in ('APROVADA', 'ENCERRADA', 'CANCELADA', 'ASSINADA', 'TRANSITO', 'ENC. A VISTA')
          and not has_operational then 'APROVADA'
        else null
      end as outcome,
      financed_value
    from client_history
  )
  select jsonb_build_object(
    'scope', v_scope,
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'filters', jsonb_build_object('store', v_store, 'department', v_department),
    'source', jsonb_build_object('latest_validated_batch', v_batch_id),
    'summary', jsonb_build_object(
      'operational_quantity', (select count(*) from operational),
      'total_financed', (select coalesce(sum(financed_value), 0) from operational)
    ),
    'stores', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from store_metrics x), '[]'::jsonb),
    'banks', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from bank_metrics x), '[]'::jsonb),
    'status_by_store', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.status) from status_store x), '[]'::jsonb),
    'status_by_bank', coalesce((select jsonb_agg(to_jsonb(x) order by x.bank, x.status) from status_bank x), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(x) order by x.plan_type) from plan_metrics x), '[]'::jsonb),
    'plans_by_store_department', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.plan_type) from plan_store_department x), '[]'::jsonb),
    'spf_extra', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department) from spf_metrics x), '[]'::jsonb),
    'proposal_outcomes', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.outcome)
      from (
        select store, department, outcome, count(*)::integer as quantity,
          coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
        from proposal_outcomes where outcome is not null
        group by store, department, outcome
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

-- 1) acesso à Análise F&I (módulo gestao) para Diretor, Gerente e Vendedor; RH continua sem.
update public.permissoes_modulos set permitido = true, atualizado_em = now()
 where modulo_id = 'gestao' and upper(trim(perfil)) in ('DIRETOR_NOVOS', 'DIRETOR_SEMINOVOS', 'GERENTE', 'VENDEDOR') and not permitido;
do $$ begin
  if exists (select 1 from public.permissoes_modulos where modulo_id = 'gestao' and upper(trim(perfil)) = 'RH' and permitido) then
    raise exception 'TRAVA: RH não pode ter a Análise F&I'; end if;
  if (select count(*) from public.permissoes_modulos where modulo_id = 'gestao'
      and upper(trim(perfil)) in ('DIRETOR_NOVOS', 'DIRETOR_SEMINOVOS', 'GERENTE', 'VENDEDOR', 'ANALISTA') and not permitido) > 0 then
    raise exception 'TRAVA: algum perfil ficou sem a Análise F&I'; end if;
end $$;

commit;

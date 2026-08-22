-- Incidente Model-Metrics-Later-Return -- alinha
-- operational_model_metrics_without_spf (e, por heranca, seu wrapper
-- operational_model_metrics) a regra oficial de "financiamento" ja
-- corrigida em operational_salary_details (Incidente Salary-Details-
-- Later-Return) e ja usada por operational_metrics.
--
-- CAUSA: finance_metrics/plan_metrics (agrupados por loja/departamento/
-- modelo) so consideravam financiamentos com is_real_financing=true
-- (via principal_finance), sem nenhum fallback de is_later_return em
-- lugar nenhum da funcao. Diferente do bug de operational_salary_details
-- (uma flag booleana incompleta), aqui a linha inteira -- e seus valores
-- (financed_or_service_value, return_value) -- ficava totalmente fora da
-- agregacao, subdeclarando tambem production_value/return_value, nao so
-- financed_count.
--
-- GROUND TRUTH construido reproduzindo a regra canonica de
-- operational_metrics (effective_finance = principal_finance UNION
-- later_return quando o chassi NAO possui financiamento principal),
-- reagrupada por (loja, departamento, modelo) em vez de por vendedor.
-- Confirmado par a par para a competencia 21/07-20/08: 262 grupos totais,
-- 3 divergentes antes do fix, 0 depois. Os 3 chassis causadores sao
-- EXATAMENTE os mesmos 3 sentinelas do incidente Salary-Details-Later-
-- Return:
--   RALPHO   -- 93XGTGK1WVCT35017 -- GASTAO/NOVOS/ECLIPSE CROSS RUSH 1.5T CVT      (1 vs 0)
--   ROGLECIA -- 93XHTGK1WTCS21537 -- GASTAO/SEMINOVOS/ECLIPSE CROSS 1.5 MIVEC TURBO GASOL (1 vs 0)
--   STEFAN   -- 93XHTGK1WVCT35046 -- ALPHAVILLE/NOVOS/ECLIPSE CROSS TARMAC 1.5T CVT (3 vs 2)
-- Total do periodo antes do fix: financed_count=176 (esperado 179),
-- production_value subdeclarada em R$90.000,00, return_value subdeclarada
-- em R$1.200,00 -- exatamente os valores dos 3 financiamentos
-- is_later_return-only ausentes.
--
-- PATCH: nova CTE later_return_finance (mesmo gate de autorizacao de
-- DIRETOR de principal_finance, distinct on chassis) unida a
-- principal_finance via CTE effective_finance, que EXCLUI
-- explicitamente qualquer later_return cujo chassi ja tenha um
-- principal_finance (Parte 18: nunca contar 2 financiamentos para o
-- mesmo chassi -- confirmado programaticamente que nenhum chassi do
-- periodo possui as duas condicoes simultaneamente, mas a exclusao fica
-- Explicita e nao depende disso). finance_linked passa a consumir
-- effective_finance em vez de principal_finance -- unica mudanca
-- estrutural; sales_metrics/eligible_sellers/gates de autorizacao
-- inalterados.
--
-- Testado em transacao com ROLLBACK antes de promover: 0 divergencias
-- entre os 262 grupos, financed_count/production_value/return_value
-- totais identicos ao ground truth (179 / R$17.860.811,20 /
-- R$784.242,66). Repetido ao vivo apos a promocao com o mesmo resultado.
-- Grants (postgres/service_role) e search_path preservados.
--
-- operational_model_metrics (wrapper SPF): confirmado que herda
-- financed_count=179 automaticamente (nao recalcula, so agrega spf_count/
-- spf_value por cima do resultado desta funcao). O layer de SPF do
-- wrapper (finance_rows/spf_linked/spf_metrics) e independente e NAO foi
-- tocado -- spf_count/spf_value inalterados por construcao (nenhuma
-- linha desta migration toca esse codigo).
--
-- Fora do escopo (Parte 29, somente nota read-only, sem correcao):
-- operational_score_coparticipated_data tambem so usa is_real_financing e
-- classifica planos COPARTICIPADO via tc_devolvida=1 -- campo tipicamente
-- ausente/nulo em registros is_later_return-only (confirmado no proprio
-- caso RALPHO: finance_code e installments nulos na linha later-return).
-- Estender o mesmo patch aqui exigiria decidir como classificar um plano
-- sem dados de financiamento reais -- precisa revisao dedicada, nao
-- ampliada nesta fase.

CREATE OR REPLACE FUNCTION public.operational_model_metrics_without_spf(p_start date, p_end date)
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
      coalesce(nullif(s.vehicle_model, ''), 'NÃO INFORMADO') as model,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select *
    from sales_global_latest
    where sale_date between p_start and p_end
      -- Incidente IA-1B: gate de AUTORIZACAO (nao de classificacao) -- para
      -- DIRETOR, exige que o departamento EFETIVO (temporal, com fallback
      -- para o status ATUAL da pessoa, mesma cadeia de operational_metrics)
      -- esteja no escopo. NAO usa o campo "department" bruto como fallback
      -- (usa-lo bloquearia indevidamente vendas legitimas de vendedores que
      -- nunca mudaram de departamento mas tem o campo de origem taggeado de
      -- forma inconsistente -- department bruto so aparece no OUTPUT, para
      -- classificacao/exibicao por modelo, que permanece inalterada).
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
      -- Incidente IA-1B: finance nao deriva de visible_sales (join por
      -- chassis em finance_linked e LEFT JOIN -- preserva finance orfa de
      -- venda), entao precisa do proprio gate de autorizacao. operation_date
      -- ja e a ancora temporal desta CTE (usada por resolve_store_temporal
      -- acima) -- mesma ancora aqui, nada arbitrario.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
  ),
  -- Incidente Model-Metrics-Later-Return: mesma regra ja usada por
  -- operational_metrics (effective_finance) -- um chassi tambem conta como
  -- financiado quando so existe um registro de retorno tardio
  -- (is_later_return), nunca quando ja existe financiamento principal
  -- para o mesmo chassi (Parte 17/18 do incidente: nunca contar 2).
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
      coalesce(nullif(f.vehicle_model, ''), s.model, 'NÃO INFORMADO') as model,
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
  ),
  -- Classificação do plano por operação, mesma prioridade oficial da função
  -- planTypeFromFields() do frontend: SUBSIDIADO > REVERSÃO > COPARTICIPADO > BALÃO > LINEAR.
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
           coalesce(sum(return_value), 0)::numeric(18,2) as return_value
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
          'return_value', return_value
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
    'rows', v_rows
  );
end;
$function$;

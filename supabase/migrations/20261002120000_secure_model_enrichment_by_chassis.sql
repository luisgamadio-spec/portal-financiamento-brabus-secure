-- PORTAL SECURE — INCONSISTÊNCIA TRITON — FASE 6: enriquecimento de
-- modelo por chassi em operational_model_metrics_without_spf e
-- operational_model_metrics.
--
-- NÃO APLICADO A PRODUÇÃO NESTA WAVE — arquivo local apenas, para
-- validação antes de qualquer publicação (ver relatório da Fase 6).
--
-- Causa raiz (comprovada nas Fases 1-5, dados reais, sem heurística):
--   - portal_sales.vehicle_model chega truncado a ~35 caracteres para
--     uma fração dos veículos (Triton/Eclipse Cross/Outlander), por
--     um problema de origem anterior ao Portal Secure (ver Fase 2).
--   - O "model" usado como chave de agrupamento em sales_global_latest
--     (lado Vendas) NUNCA consulta portal_finance_operations -- mesmo
--     quando esta tem, para o MESMO CHASSI, uma descrição completa.
--   - O "model" do lado Financiamento (finance_linked/finance_rows) já
--     prioriza portal_finance_operations.vehicle_model sobre o de
--     Vendas, mas só quando essa linha de Finance passa pelos filtros
--     de período/is_real_financing/elegibilidade de vendedor -- e,
--     mesmo quando passa, o lado Vendas (que já rodou antes, com o
--     texto truncado) produz uma CHAVE DE AGRUPAMENTO diferente,
--     fragmentando o mesmo veículo em duas linhas/cards distintos
--     (Fase 4).
--
-- Fix: uma nova CTE, chassis_model_catalog, por chassi, em TODA a
-- tabela portal_finance_operations (sem filtro de período, lote,
-- seller ou is_real_financing -- ela serve SOMENTE para identificar o
-- texto do modelo, nunca para alterar métricas), que só produz um
-- candidate_model quando existe EXATAMENTE UMA descrição distinta com
-- mais de 35 caracteres para aquele chassi em toda a história da
-- tabela. Qualquer chassi com 0 ou 2+ descrições distintas >35
-- caracteres não recebe candidate_model (permanece NULL) -- 0 porque
-- não há nada para enriquecer, 2+ porque é um conflito real e esta
-- função nunca escolhe arbitrariamente (ver estudo de dados: dos 3606
-- chassis com alguma linha de Finance, 964 têm exatamente 1 descrição
-- >35 caracteres -- candidatos seguros --, 67 têm 2 ou mais -- tratados
-- como ambíguos e ignorados --, e 2575 têm 0).
--
-- O limiar de 35 caracteres é o mesmo ponto de corte empiricamente
-- comprovado na Fase 2 (zero ocorrências de truncamento abaixo de 35
-- em toda a tabela) -- não é um valor arbitrário.
--
-- O candidate_model só é usado quando o texto JÁ disponível na própria
-- linha (vehicle_model de portal_sales ou de portal_finance_operations)
-- tiver 35 caracteres ou menos -- um texto já longo nunca é substituído.
-- Quando usado, não altera nenhum outro campo: operation_date,
-- is_real_financing, seller_id/seller_user_id, store, department,
-- sale_value, financed_or_service_value, return_value permanecem
-- exatamente os mesmos campos das linhas que já passavam pelos filtros
-- de período/elegibilidade/is_real_financing -- a CTE não cria venda
-- nem financiamento, só fornece um texto melhor para a mesma linha que
-- já existiria de qualquer forma.
--
-- SERTÕES: não tocado nesta fase (ver brief, item 13) -- "TRITON SAVANA
-- SERTOES" já chega completo e não precisa de nenhum enriquecimento;
-- continua caindo em "TRITON SAVANA" pela mesma ordem de verificação de
-- modeloPadrao(), inalterada aqui.
--
-- Caso 93XHYKL1TLCK24068 (achado na Fase 4/5, item 17 do brief): tem
-- duas linhas com a MESMA descrição completa de Triton ("...SPORT HPE
-- CD 4P 4", 50 caracteres) e uma linha "320I ACTIVE FLEX" (16
-- caracteres) -- esta última nunca participa por ser <=35 caracteres,
-- então distinct_full=1 para este chassi (não é tratado como
-- ambíguo) e o candidate_model resolvido é exatamente a descrição de
-- Triton, nunca a do BMW. Verificado diretamente nos dados antes de
-- escrever este comentário.
--
-- Escopo: SOMENTE a expressão da coluna "model" em sales_global_latest/
-- finance_linked (operational_model_metrics_without_spf) e
-- sales_latest/finance_rows (operational_model_metrics). Nenhum outro
-- CTE, filtro, JOIN de elegibilidade, contagem ou soma foi alterado --
-- confirmado por diff normalizado contra o canônico
-- (20260916120000_revenda3_ia3b_canonical_rpc_exclusion.sql) no
-- relatório da Fase 6.

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
  ),
  -- FASE 6: mesmo catálogo usado em operational_model_metrics_without_spf,
  -- recalculado aqui porque esta função mantém seu próprio sales_latest/
  -- finance_rows independentes (usados só para o merge de spf_count/
  -- spf_value) -- sem isso, a chave (store,department,model) usada aqui
  -- para o merge por SPF ficaria incompatível com a já enriquecida em
  -- v_base, e o spf_count/spf_value não casariam com a linha certa.
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
      -- FASE 6: mesma regra -- texto próprio se >35, senão catálogo,
      -- senão 'NÃO INFORMADO' (comportamento original).
      case
        when length(trim(coalesce(s.vehicle_model, ''))) > 35 then s.vehicle_model
        when cmc.candidate_model is not null then cmc.candidate_model
        else coalesce(nullif(s.vehicle_model,''),'NÃƒO INFORMADO')
      end as model
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    left join chassis_model_catalog cmc on cmc.chassis = s.chassis
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ), finance_rows as (
    select f.id, f.operation_date, f.client_match_key,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store,'')),es.store,'SEM LOJA') as store,
      coalesce(sl.department,'NOVOS') as department,
      -- FASE 6: texto próprio se >35, senão catálogo, senão o
      -- comportamento original (vehicle_model de Finance, depois o
      -- model já resolvido de sales_latest, depois 'NÃO INFORMADO').
      case
        when length(trim(coalesce(f.vehicle_model, ''))) > 35 then f.vehicle_model
        when cmc.candidate_model is not null then cmc.candidate_model
        else coalesce(nullif(f.vehicle_model,''),sl.model,'NÃƒO INFORMADO')
      end as model
    from public.portal_finance_operations f
    join latest_batches lb on lb.id = f.batch_id
      and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis = f.chassis
    left join chassis_model_catalog cmc on cmc.chassis = f.chassis
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

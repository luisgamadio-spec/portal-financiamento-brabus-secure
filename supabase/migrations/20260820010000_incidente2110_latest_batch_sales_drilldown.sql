-- Incidente 21.10 — corrige o sintoma visual real relatado pelo usuario:
-- botao "Detalhes" (operational_salary_details) mostrando o mesmo chassi
-- repetido varias vezes (visto ate 4x no chassi sentinela).
--
-- Causa raiz: o fix 21.6C.1 (latest VALIDATED batch) so foi aplicado ao
-- lado FINANCE de operational_salary_details. O lado SALES
-- (sales_global_ranked, usado tanto na listagem de linhas quanto na
-- contagem total) continuava lendo public.portal_sales sem nenhuma
-- restricao de batch — toda copia fisica cross-batch de uma venda (Base
-- 01, arquivo cumulativo, ver Fase 21.6D) virava um card na tela, a
-- maioria marcado "EXCLUIDA — REGISTRO DUPLICADO" mas ainda visivel.
--
-- Correcao: a mesma CTE latest_batches ja usada para
-- FINANCE_CURRENT/FINANCE_HISTORY passa a cobrir tambem
-- SALES_CURRENT/SALES_HISTORY, e sales_global_ranked (nos dois pontos da
-- funcao — linhas detalhadas e contagem total) so considera vendas do
-- batch VALIDATED mais recente por source_type.
--
-- Nao alterado: a regra de dedup por chassi dentro do batch canonico
-- (row_number/chassis_rank) continua identica — se dois eventos
-- comerciais legitimos existirem no MESMO batch para o mesmo chassi
-- (venda + devolucao, por exemplo), o mais recente continua "incluido"
-- e o outro "excluido", exatamente como hoje. So deixou de contar copias
-- de reimportacoes inteiras como se fossem eventos novos.
--
-- Provado antes de promover (transacao com ROLLBACK): chassi sentinela
-- ******T34702 caiu de 4 cards para 1, financeiro inalterado
-- (R$76.500,00/R$4.590,00). Populacao completa: row_count de
-- operational_salary_details (MASTER, sem filtro de vendedor, historico
-- completo) caiu de 11.304 para 2.549 linhas. operational_metrics (fonte
-- dos KPIs oficiais) nao foi tocada nesta migration — José Carlos
-- confirmado inalterado (ALPHAVILLE 3 vendas / EUROPA 1 venda, mesmos
-- valores). Alocacao temporal (21.8B/21.8D) e latest finance batch
-- (21.6C.1) preservados integralmente.
--
-- Nota de homologacao: a primeira aplicacao real desta migration foi
-- montada a mao (nao a partir do arquivo candidato ja testado) e
-- acabou reescrevendo visible_sales.store sem a chamada a
-- resolve_store_temporal (21.8B) — Jose/Erica voltaram a aparecer com
-- a loja antiga (EUROPA/ABC) por alguns minutos em producao. Detectado
-- na propria verificacao pos-deploy desta mesma fase (nao pelo
-- usuario), corrigido imediatamente reaplicando o corpo correto, e o
-- arquivo aqui no repositorio ja reflete o corpo final, correto,
-- efetivamente em producao — nao a versao com a falha passageira.


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
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
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
  ),
  visible_sales as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      ps.id as seller_id,
      coalesce(public.resolve_store_temporal(ps.id, s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      upper(trim(coalesce(ps.status, s.department, ''))) as department,
      coalesce(nullif(s.vehicle_model, ''), 'NAO INFORMADO')
        as vehicle_model,
      coalesce(s.sale_value, 0)::numeric(18,2) as sale_value,
      s.chassis_rank = 1 as included_in_commission
    from sales_global_ranked s
    join eligible_sellers ps on ps.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
  ),
  finance_by_sale as (
    select
      vs.id as sale_id,
      bool_or(coalesce(f.is_real_financing, false)) as financed,
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
    join public.portal_spf_operations spf
      on spf.client_match_key = f.client_match_key
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
    select u.id
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
    select ps.id
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
      row_number() over (
        partition by s.chassis
        order by s.sale_date desc, s.id desc
      ) as chassis_rank
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
  )
  select count(*)::integer
  into v_total_rows
  from ranked r
  join eligible_sellers es on es.id = coalesce(r.seller_user_id, r.seller_id)
  where r.sale_date between p_start and p_end;

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

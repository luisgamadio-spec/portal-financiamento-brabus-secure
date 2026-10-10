-- Aplicada em produção em 09/10/2026 (prova com ROLLBACK: 46/46). operational_salary_details ganha p_store (opcional): filtra a loja ANTES do limite de 2.000 linhas; sem p_store o resultado é idêntico ao anterior. Rollback: docs/rollback/salary_details_filtro_loja_antes.sql
begin;
-- a assinatura muda (novo parâmetro opcional): as versões de 3 argumentos saem para não haver ambiguidade na API
DROP FUNCTION public.operational_salary_details(date, date, uuid);
DROP FUNCTION public._operational_salary_details_core(date, date, uuid);

CREATE OR REPLACE FUNCTION public._operational_salary_details_core(p_start date, p_end date, p_seller_id uuid DEFAULT NULL::uuid, p_store text DEFAULT NULL::text)
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
      -- p_store (opcional): só a loja pedida, ANTES do limite de linhas (detalhe do Analista)
      and (p_store is null or coalesce(public.resolve_store_temporal(ps.id, s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') = p_store)
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
    select u.id, u.status as status, u.loja as store
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
    select ps.id, ps.status, ps.store
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
      s.store,
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
    and (p_store is null or coalesce(public.resolve_store_temporal(es.id, r.sale_date, nullif(r.store, '')), es.store, 'SEM LOJA') = p_store)
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

CREATE OR REPLACE FUNCTION public.operational_salary_details(p_start date, p_end date, p_seller_id uuid DEFAULT NULL::uuid, p_store text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  return public._operational_ocultar_retorno_vendedor(public._operational_salary_details_core(p_start, p_end, p_seller_id, p_store));
end;
$function$;

REVOKE ALL ON FUNCTION public._operational_salary_details_core(date, date, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operational_salary_details(date, date, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operational_salary_details(date, date, uuid, text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
commit;

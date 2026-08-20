-- Incidente 21.11 — conecta resolve_department_temporal (21.8B) as
-- funcoes analiticas que hoje SUBSTITUEM o departamento correto do fato
-- (raw portal_sales.department, ja correto na fonte para Jose Carlos —
-- confirmado fresh: SEMINOVOS ate 20/07, NOVOS a partir de 12/08) pelo
-- PERFIL ATUAL do vendedor (usuarios.status via es.status/ps.status),
-- que so reflete o departamento de HOJE, nao o do fato historico.
--
-- Apenas 3 funcoes tinham esse bug real (es.status/ps.status como
-- PRIMEIRA prioridade, sem nenhum fallback para o dado do fato):
-- operational_salary_details, operational_metrics,
-- operational_analyst_commission_metrics. As demais 5 funcoes ja usam o
-- departamento do fato/venda vinculada como prioridade (nao tinham o
-- bug) — nao foram tocadas, para nao inventar regra nova onde ja
-- funcionava (confirmado fresh nesta mesma auditoria).
--
-- resolve_department_temporal(usuario_id, data, fallback=null) entra
-- como NOVA primeira prioridade; quando retorna null (nenhuma mudanca
-- com departamento preenchido cobre a data — hoje, todo mundo exceto
-- Jose apos esta migration) a cadeia cai exatamente no comportamento
-- atual (es.status/ps.status, depois o dado do fato). Populacao
-- inteira confirmada byte-identica antes/depois em transacao com
-- ROLLBACK (78 linhas, 1104 vendidas, 1064 financiadas, mesma
-- producao/retorno) — a unica mudanca observavel e para quem tiver
-- departamento_origem/destino preenchido em mudancas_loja_vendedores,
-- ninguem hoje.
--
-- Jose Carlos NAO foi preenchido nesta migration (schema/RPC apenas) —
-- feito em seguida via a mesma RPC master_admin_manage/SET_DEPARTMENTS
-- que o botao 'Editar departamentos' usa, autorizado explicitamente
-- pela informacao fornecida pelo usuario nesta sessao (EUROPA/SEMINOVOS
-- ate 31/07, ALPHAVILLE/NOVOS a partir de 01/08).
--
-- latest_batches (SALES 21.10, FINANCE 21.6C.1) e resolve_store_temporal
-- (21.8B/D) preservados integralmente — confirmado presentes nos 3
-- corpos antes de aplicar (procedimento anti-regressao pos-21.10).

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
      upper(trim(coalesce(public.resolve_department_temporal(ps.id, s.sale_date, null), ps.status, s.department, ''))) as department,
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

CREATE OR REPLACE FUNCTION public.operational_metrics(p_start date, p_end date)
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
        'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  -- Fase 21.4: usuarios passa a ser a fonte primaria de elegibilidade
  -- (identidade atual). portal_sellers permanece como fallback LEGADO,
  -- incluido apenas para pessoas que NAO tem correspondencia ativa em
  -- usuarios (o "not exists" evita listar a mesma pessoa duas vezes quando
  -- ela ja possui cadastro atual). O match com os fatos passa a ser por
  -- coalesce(seller_user_id, seller_id) -- prioridade ao vinculo moderno,
  -- fallback ao legado (Parte AK). Mantidos os mesmos nomes de coluna
  -- (id/name/store/status) para preservar o resto do corpo da funcao
  -- inalterado.
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
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
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
  -- Classificação do plano por operação, mesma prioridade oficial da função
  -- planTypeFromFields() do frontend: SUBSIDIADO > REVERSÃO > COPARTICIPADO > BALÃO > LINEAR.
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
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
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
          'return_value', return_value
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

CREATE OR REPLACE FUNCTION public.operational_analyst_commission_metrics(p_start date, p_end date)
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
  v_result jsonb;
begin
  if exists (
    select 1
    from public.ausencias_analistas a
    join public.ausencias_analistas b
      on b.id <> a.id
     and upper(trim(b.loja_coberta)) = upper(trim(a.loja_coberta))
     and b.ativo = true
     and a.ativo = true
     and daterange(b.data_inicio, b.data_fim, '[]')
         && daterange(a.data_inicio, a.data_fim, '[]')
    where a.data_inicio <= p_end
      and a.data_fim >= p_start
  ) then
    raise exception
      'Existem ausencias sobrepostas para a mesma loja no periodo.'
      using errcode = '22023';
  end if;

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

  with
  windows as (
    select 'BASE'::text as window_id, p_start as w_start, p_end as w_end
    union all
    select a.id::text, greatest(a.data_inicio, p_start), least(a.data_fim, p_end)
    from public.ausencias_analistas a
    where a.ativo = true
      and a.data_inicio <= p_end
      and a.data_fim >= p_start
  ),
  latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT')
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
      and upper(trim(coalesce(ps.status, ''))) not in ('REVENDA', 'INATIVO', 'MASTER')
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
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales_env as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
  ),
  visible_finance_env as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
  ),
  sales_by_window as (
    select
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA') as store,
      count(*)::integer as sold_count
    from windows w
    join visible_sales_env vs
      on vs.sale_date between w.w_start and w.w_end
    join eligible_sellers es on es.id = vs.seller_id
    group by
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA')
  ),
  finance_by_window as (
    select
      w.window_id,
      vf.*
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
  ),
  principal_finance_bw as (
    select *
    from finance_by_window
    where is_real_financing
  ),
  later_return_bw as (
    select distinct on (
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from finance_by_window
    where is_later_return
    order by
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance_bw as (
    select * from principal_finance_bw
    union all
    select lr.*
    from later_return_bw lr
    where not exists (
      select 1
      from principal_finance_bw pf
      where pf.id = lr.id
        and pf.window_id = lr.window_id
    )
  ),
  finance_metrics_bw as (
    select
      window_id,
      seller_id,
      effective_store as store,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2) as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance_bw
    group by window_id, seller_id, effective_store
  ),
  spf_by_window as (
    select distinct
      w.window_id,
      vf.seller_id,
      vf.effective_store as store,
      spf.id,
      spf.optional_value
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics_bw as (
    select
      window_id,
      seller_id,
      store,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_by_window
    group by window_id, seller_id, store
  ),
  window_store_totals as (
    select
      sw.window_id,
      sw.store,
      sum(sw.sold_count)::integer as sold_count,
      sum(coalesce(fm.financed_count, 0))::integer as financed_count,
      sum(coalesce(fm.production_value, 0))::numeric(18,2) as production_value,
      sum(coalesce(fm.return_value, 0))::numeric(18,2) as return_value,
      sum(coalesce(spm.spf_count, 0))::integer as spf_count,
      sum(coalesce(spm.spf_value, 0))::numeric(18,2) as spf_value
    from sales_by_window sw
    left join finance_metrics_bw fm
      on fm.window_id = sw.window_id
     and fm.seller_id = sw.seller_id
     and fm.store = sw.store
    left join spf_metrics_bw spm
      on spm.window_id = sw.window_id
     and spm.seller_id = sw.seller_id
     and spm.store = sw.store
    group by sw.window_id, sw.store
  ),
  base_store_totals as (
    select store, sold_count, financed_count, production_value, return_value, spf_count, spf_value
    from window_store_totals
    where window_id = 'BASE'
  ),
  eligible_absence_windows as (
    select
      w.window_id as absence_id,
      w.w_start as covered_start,
      w.w_end as covered_end,
      a.nome_analista_substituto as analyst_name,
      bst.store
    from windows w
    join public.ausencias_analistas a on a.id::text = w.window_id
    join base_store_totals bst
      on upper(trim(bst.store)) = upper(trim(a.loja_coberta))
    where w.window_id <> 'BASE'
  ),
  absence_metrics as (
    select
      eaw.absence_id as id,
      eaw.store,
      eaw.analyst_name,
      eaw.covered_start,
      eaw.covered_end,
      coalesce(wst.sold_count, 0)::integer as sold_count,
      coalesce(wst.financed_count, 0)::integer as financed_count,
      coalesce(wst.production_value, 0)::numeric(18,2) as production_value,
      coalesce(wst.return_value, 0)::numeric(18,2) as return_value,
      coalesce(wst.spf_count, 0)::integer as spf_count,
      coalesce(wst.spf_value, 0)::numeric(18,2) as spf_value
    from eligible_absence_windows eaw
    left join window_store_totals wst
      on wst.window_id = eaw.absence_id
     and upper(trim(wst.store)) = upper(trim(eaw.store))
  ),
  absence_sums as (
    select
      store,
      sum(sold_count)::integer as sold_count,
      sum(financed_count)::integer as financed_count,
      sum(production_value)::numeric(18,2) as production_value,
      sum(return_value)::numeric(18,2) as return_value,
      sum(spf_count)::integer as spf_count,
      sum(spf_value)::numeric(18,2) as spf_value
    from absence_metrics
    group by store
  ),
  official_rows as (
    select
      coalesce(
        (
          select u.nome
          from public.usuarios u
          where u.ativo = true
            and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
            and upper(trim(coalesce(u.loja, ''))) =
                upper(trim(coalesce(st.store, '')))
          order by u.nome
          limit 1
        ),
        'ANALISTA NAO LOCALIZADO'
      ) as analyst_name,
      st.store,
      greatest(st.sold_count - coalesce(a.sold_count, 0), 0)::integer
        as sold_count,
      greatest(st.financed_count - coalesce(a.financed_count, 0), 0)::integer
        as financed_count,
      greatest(st.production_value - coalesce(a.production_value, 0), 0)
        ::numeric(18,2) as production_value,
      greatest(st.return_value - coalesce(a.return_value, 0), 0)
        ::numeric(18,2) as return_value,
      greatest(st.spf_count - coalesce(a.spf_count, 0), 0)::integer
        as spf_count,
      greatest(st.spf_value - coalesce(a.spf_value, 0), 0)
        ::numeric(18,2) as spf_value,
      false as transfer,
      null::date as covered_start,
      null::date as covered_end
    from base_store_totals st
    left join absence_sums a on a.store = st.store
  ),
  combined_rows as (
    select * from official_rows
    union all
    select
      analyst_name,
      store,
      sold_count,
      financed_count,
      production_value,
      return_value,
      spf_count,
      spf_value,
      true as transfer,
      covered_start,
      covered_end
    from absence_metrics
  )
  select jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'absence_aware', true,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'rows',
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'analyst_name', analyst_name,
            'store', store,
            'sold_count', sold_count,
            'financed_count', financed_count,
            'production_value', production_value,
            'return_value', return_value,
            'spf_count', spf_count,
            'spf_value', spf_value,
            'transfer', transfer,
            'covered_start', covered_start,
            'covered_end', covered_end
          )
          order by store, transfer, covered_start, analyst_name
        ),
        '[]'::jsonb
      )
  )
  into v_result
  from combined_rows
  where sold_count > 0
     or financed_count > 0
     or return_value > 0
     or spf_value > 0;

  return v_result;
end;
$function$
;

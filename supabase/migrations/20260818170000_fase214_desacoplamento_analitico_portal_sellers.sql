-- Fase 21.4 -- Desacoplamento analitico definitivo de portal_sellers.
--
-- Contexto (Fase 21.0-21.3): usuarios e a fonte operacional atual;
-- portal_sales/portal_finance_operations.seller_user_id ja foi populado
-- (backfill 21.3, 9.734/13.859 sales e 10.793/13.189 finance). Portao
-- critico confirmado ANTES desta fase: zero conflitos entre seller_user_id
-- e a identidade resolvida via seller_id legado (Parte AL/AM).
--
-- Esta migration troca o mecanismo de elegibilidade de TODAS as 8 funcoes
-- analiticas conhecidas que dependiam de portal_sellers (7 da lista do
-- prompt + operational_analyst_coverage_metrics, encontrada na reauditoria
-- fresh da Parte C -- nao confiar cegamente na lista anterior). A CTE
-- eligible_sellers deixa de ser FROM portal_sellers e passa a ser
-- FROM usuarios UNION ALL FROM portal_sellers (apenas para pessoas SEM
-- correspondencia ativa em usuarios -- o "not exists" evita listar a
-- mesma pessoa duas vezes). O match de cada fato passa a ser por
-- coalesce(seller_user_id, seller_id) -- prioridade ao vinculo moderno,
-- fallback ao legado, nunca os dois ao mesmo tempo (Parte H, testado).
--
-- Mudanca estritamente de IDENTIDADE/ELEGIBILIDADE. Formulas, agregacoes,
-- filtros de periodo, classificacao de plano, SPF linking e tudo mais
-- permanecem byte-a-byte identicos -- confirmado por diff automatizado
-- contra a producao atual para MASTER em todas as 8 funcoes.
--
-- Resultado principal (Parte BH): Jose Carlos -- usuarios atual
-- ALPHAVILLE/NOVOS, portal_sellers legado stale EUROPA/SEMINOVOS -- deixa
-- de ser bloqueado na propria visao (self-view) em operational_metrics
-- (producao propria: R$ 556.250,00, antes invisivel para ele mesmo mesmo
-- apos o fix de CPF da 19.1, porque o gate de departamento ainda comparava
-- contra portal_sellers.status) e em operational_salary_details (110
-- operacoes no botao DETALHES, antes 0). O MESMO gate tambem beneficia
-- quem gerencia Jose Carlos: o proprio DIRETOR NOVOS (Rodrigo Carriel)
-- ganhou a visibilidade dele que faltava (37->38 linhas, explicado).
--
-- Toda diferenca encontrada contra a producao atual (MASTER, a visao mais
-- ampla) foi individualmente explicada nesta fase:
--   1) seller_id no JSON de saida muda de namespace (portal_sellers.id ->
--      usuarios.id) para fatos resolvidos via seller_user_id -- mudanca de
--      identidade pretendida, nunca de dado (valores financeiros
--      confirmados identicos par a par).
--   2) Jose Carlos: bucket de department muda de SEMINOVOS (stale) para
--      NOVOS (atual) em operational_metrics/operational_salary_details --
--      correcao esperada, unica mudanca nesses casos (demais 20+ campos
--      idênticos por linha).
--   3) Roberto Wagner Leite/de Lima: nome muda de fonte (portal_sellers.
--      name -> usuarios.nome) -- variacao cosmetica de cadastro entre as
--      duas fontes, numeros financeiros identicos.
-- Nenhuma outra diferenca restou sem explicacao (zero INDETERMINADO,
-- Parte AT).
--
-- Preservacao de historico (Parte K/L/AA/W/Z): confirmado que
-- operational_model_metrics_without_spf/operational_reporting_summary ja
-- usavam o department/store PROPRIO DO FATO (portal_sales.department/
-- store), nunca o status atual do vendedor -- preservado sem alteracao.
-- operational_metrics/operational_salary_details/operational_score_
-- coparticipated_data ja tinham, antes desta fase, o design pre-existente
-- de bucketar pelo status/nome ATUAL do vendedor para fins de agregacao
-- (nao alterado por esta migration -- so a fonte desse "atual" mudou de
-- portal_sellers para usuarios, mais precisa).
--
-- Escopo de negocio preservado (Parte AC/AD/I): eligible_sellers continua
-- exigindo perfil VENDEDOR -- GERENTE (Bueno, Fontolan) permanece fora dos
-- calculos de comissao de vendedor, exatamente como hoje. A arquitetura
-- agora PERMITE estender isso no futuro (identidade ja resolve
-- corretamente para GERENTE via seller_user_id, testado em
-- operational_score_coparticipated_data/finance), mas essa e uma decisao
-- de negocio fora do escopo desta fase.
--
-- Fora de escopo (confirmado intocado): Base 03 (importador nao alterado,
-- SPF continua herdando identidade via client_match_key), usuarios,
-- portal_sellers, auth, seller_user_id (0 updates -- populado na 21.3),
-- telemetria, snapshots/competencias fechadas, frontend.
--
-- Rollback: corpos exatos das 8 funcoes capturados via pg_get_functiondef()
-- antes desta promocao (scratchpad da sessao).

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
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
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
      coalesce(nullif(s.store, ''), ps.store, 'SEM LOJA') as store,
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
      upper(trim(coalesce(es.status, 'SEM DEPARTAMENTO'))) as department,
      es.name as seller_name,
      count(*)::integer as sold_count,
      coalesce(sum(vs.sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales vs
    join eligible_sellers es on es.id = coalesce(vs.seller_user_id, vs.seller_id)
    group by
      es.id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA'),
      upper(trim(coalesce(es.status, 'SEM DEPARTAMENTO'))),
      es.name
  ),
  visible_finance as (
    select
      f.*,
      es.id as effective_seller_id,
      coalesce(nullif(f.store, ''), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(es.status, 'SEM DEPARTAMENTO'))) as department
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
$function$;

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



  with eligible_sellers as (

    select u.id, u.nome as name, u.loja as store, u.status as status

    from public.usuarios u

    where u.ativo = true

      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'

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

  ),

  visible_sales as (

    select

      s.id,

      s.sale_date,

      s.chassis,

      ps.id as seller_id,

      coalesce(nullif(s.store, ''), ps.store, 'SEM LOJA') as store,

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



  with eligible_sellers as (

    select u.id

    from public.usuarios u

    where u.ativo = true

      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'

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

$function$;

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
      and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
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
      coalesce(nullif(s.store, ''), es.store, 'SEM LOJA') as store,
      s.department,
      coalesce(nullif(s.vehicle_model, ''), 'NÃO INFORMADO') as model,
      s.sale_value
    from public.portal_sales s
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select *
    from sales_global_latest
    where sale_date between p_start and p_end
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
      coalesce(nullif(f.store, ''), es.store, 'SEM LOJA') as effective_store
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and f.is_real_financing
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
    from principal_finance f
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

CREATE OR REPLACE FUNCTION public.operational_model_metrics(p_start date, p_end date)
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

  v_base := public.operational_model_metrics_without_spf(p_start, p_end);

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

      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT')

    order by b.source_type, b.completed_at desc nulls last,

             b.created_at desc, b.id desc

  ), eligible_sellers as (

    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where u.ativo = true
      and upper(trim(coalesce(u.perfil,''))) = 'VENDEDOR'
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

    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)

    order by s.chassis, s.sale_date desc, s.id desc

  ), finance_rows as (

    select f.id, f.operation_date, f.client_match_key,

      coalesce(nullif(f.store,''),es.store,'SEM LOJA') as store,

      coalesce(sl.department,'NOVOS') as department,

      coalesce(nullif(f.vehicle_model,''),sl.model,'NÃƒO INFORMADO') as model

    from public.portal_finance_operations f

    join latest_batches lb on lb.id = f.batch_id

      and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')

    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)

    left join sales_latest sl on sl.chassis = f.chassis

    where f.operation_date between p_start and p_end

      and f.is_real_financing

  ), spf_rows as (

    select sp.id, sp.client_match_key, sp.optional_value

    from public.portal_spf_operations sp

    join latest_batches lb on lb.id = sp.batch_id

      and lb.source_type = 'SPF_CURRENT'

    where sp.is_spf_extra and coalesce(sp.optional_value,0) > 0

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
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
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
      coalesce(nullif(s.store, ''), ps.store, 'SEM LOJA') as store,
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
      coalesce(nullif(f.store, ''), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(es.status, 'SEM DEPARTAMENTO'))) as department
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
$function$;

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



  with visible_sales as (

    select

      s.id,

      s.sale_date,

      s.chassis,

      coalesce(s.seller_user_id, s.seller_id) as seller_id,

      coalesce(nullif(s.store, ''), ps.store, u.loja, 'SEM LOJA') as store,

      s.department,

      s.sale_value,

      coalesce(u.nome, ps.name, s.seller_source_name, 'SEM VÍNCULO') as seller_name

    from public.portal_sales s

    left join public.usuarios u on u.id = s.seller_user_id and u.ativo = true

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

              and upper(coalesce(s.store, u.loja, ps.store, '')) = v_store

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

$function$;

CREATE OR REPLACE FUNCTION public.operational_score_coparticipated_data(p_start date, p_end date)
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
  v_sales jsonb;
  v_finance jsonb;
  v_rates jsonb;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.' using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(select jsonb_array_elements_text(v_scope->'departments'));
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
   where u.auth_user_id = auth.uid() and u.ativo
   limit 1;

  with eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where u.ativo = true
      and upper(trim(coalesce(u.perfil,'')))='VENDEDOR'
      and (v_is_master or (
        (upper(trim(coalesce(u.status,'')))=any(v_departments)
         or (upper(trim(coalesce(u.status,'')))='NOVOS/SEMINOVOS'
             and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
        and (v_is_director or (v_is_seller and u.id = v_user_id)
             or (not v_is_seller and upper(trim(coalesce(u.loja,'')))=v_store))))
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
              or (not v_is_seller and upper(coalesce(ps.store,''))=v_store))))
  ), sales_latest as (
    select distinct on (s.chassis)
      s.id,s.sale_date,s.chassis,es.id as seller_id,es.name as seller_name,
      coalesce(nullif(s.store,''),es.store,'SEM LOJA') as store,
      s.department,coalesce(nullif(s.vehicle_model,''),'NÃO INFORMADO') as vehicle_model,
      s.sale_value
    from public.portal_sales s join eligible_sellers es on es.id=coalesce(s.seller_user_id, s.seller_id)
    order by s.chassis,s.sale_date desc,s.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',sale_date,'seller',seller_name,'store',store,
    'department',department,'model',vehicle_model,'sale_value',sale_value
  ) order by sale_date,store,seller_name),'[]'::jsonb)
  into v_sales from sales_latest where sale_date between p_start and p_end;

  with latest_batches as (
    select distinct on (b.source_type) b.id,b.source_type
      from public.portal_import_batches b
     where b.status='VALIDATED'
       and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT')
     order by b.source_type,b.completed_at desc nulls last,b.created_at desc,b.id desc
  ), eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where u.ativo = true
      and upper(trim(coalesce(u.perfil,'')))='VENDEDOR'
      and (v_is_master or (
        (upper(trim(coalesce(u.status,'')))=any(v_departments)
         or (upper(trim(coalesce(u.status,'')))='NOVOS/SEMINOVOS'
             and ('NOVOS'=any(v_departments) or 'SEMINOVOS'=any(v_departments))))
        and (v_is_director or (v_is_seller and u.id = v_user_id)
             or (not v_is_seller and upper(trim(coalesce(u.loja,'')))=v_store))))
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
              or (not v_is_seller and upper(coalesce(ps.store,''))=v_store))))
  ), sales_latest as (
    select distinct on (s.chassis) s.chassis,s.department,s.sale_value,s.vehicle_model
      from public.portal_sales s order by s.chassis,s.sale_date desc,s.id desc
  ), spf_latest as (
    -- Base 03 is a terms snapshot. Do not filter it by the report period.
    select sp.* from public.portal_spf_operations sp
    join latest_batches lb on lb.id=sp.batch_id and lb.source_type='SPF_CURRENT'
  ), finance_rows as (
    select f.*,es.name as seller_name,
      coalesce(nullif(f.store,''),es.store,'SEM LOJA') as effective_store,
      coalesce(nullif(f.vehicle_model,''),sl.vehicle_model,'NÃO INFORMADO') as effective_model,
      coalesce(sl.department,case when upper(coalesce(es.status,'')) like '%SEMINOVOS%'
        and upper(coalesce(es.status,'')) not like '%NOVOS/%' then 'SEMINOVOS' else 'NOVOS' end) as effective_department,
      coalesce(sl.sale_value,0) as sale_value,
      sp.status as fandi_status,
      coalesce(sp.installments,f.installments) as effective_installments,
      coalesce(sp.installment_value,f.installment_value) as effective_installment_value,
      coalesce(nullif(sp.balloon_payment,0),sp.balloon_value) as fandi_balloon,
      coalesce((select sum(x.optional_value) from spf_latest x
        where x.client_match_key=f.client_match_key and x.is_spf_extra),0) as spf_value,
      (select count(*) from spf_latest x
        where x.client_match_key=f.client_match_key and x.is_spf_extra)::integer as spf_count
    from public.portal_finance_operations f
    join latest_batches lb on lb.id=f.batch_id and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id=coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis=f.chassis
    left join lateral (
      select x.* from spf_latest x
       where x.client_match_key=f.client_match_key and upper(coalesce(x.modality,''))='FANDI'
       order by x.operation_date desc nulls last,x.id desc limit 1
    ) sp on true
    where f.operation_date between p_start and p_end and f.is_real_financing
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',operation_date,'seller',seller_name,'store',effective_store,
    'department',effective_department,'model',effective_model,
    'sale_value',sale_value,'financed_value',financed_or_service_value,
    'return_value',return_value,'spf_value',spf_value,'spf_count',spf_count,
    'installments',coalesce(effective_installments,0),
    'installment_value',coalesce(effective_installment_value,0),
    'balloon_value',coalesce(fandi_balloon,balloon_value,0),
    -- Classificação do plano: MESMA regra oficial/validada de operational_metrics
    -- (Análise Geral do Grupo) — plan_codigo_if/tc_devolvida/balloon_value de
    -- portal_finance_operations, prioridade SUBSIDIADO > REVERSÃO > COPARTICIPADO
    -- > BALÃO > LINEAR. Antes desta correção, Coparticipados usava uma
    -- implementação paralela (join ao vivo contra portal_spf_operations exigindo
    -- modality='FANDI' + regex sobre tc_returned) que divergia da Análise Geral
    -- sempre que o cliente não tinha linha correspondente em portal_spf_operations
    -- para o período — comprovado por simulação lado a lado (julho/2026: regra
    -- antiga contava 9 COPARTICIPADO, regra validada contava 11).
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

CREATE OR REPLACE FUNCTION public.operational_analyst_coverage_metrics(p_start date, p_end date, p_store text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_rows jsonb;
begin
  select *
  into v_user
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
    and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
  limit 1;

  if v_user.id is null then
    raise exception 'Acesso restrito a analista ativo.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.ausencias_analistas a
    where a.ativo = true
      and regexp_replace(coalesce(a.cpf_analista_substituto, ''), '\D', '', 'g')
          = regexp_replace(
              coalesce(v_user.cpf_normalizado, v_user.cpf, ''),
              '\D',
              '',
              'g'
            )
      and upper(trim(a.loja_coberta)) = upper(trim(p_store))
      and p_start >= a.data_inicio
      and p_end <= a.data_fim
  ) then
    raise exception 'Loja ou periodo fora da cobertura autorizada.'
      using errcode = '42501';
  end if;

  with
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
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(u.loja, ''))) = upper(trim(p_store))
      and (
        (
          upper(trim(coalesce(u.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_user.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(u.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_user.status, '')) like '%SEMINOVOS%'
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
      and upper(trim(coalesce(ps.store, ''))) = upper(trim(p_store))
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        (
          upper(trim(coalesce(ps.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_user.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(ps.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_user.status, '')) like '%SEMINOVOS%'
        )
      )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(nullif(s.store, ''), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
      and upper(trim(s.store)) = upper(trim(p_store))
  ),
  sales_metrics as (
    select
      es.id as seller_id,
      count(*)::integer as sold_count
    from visible_sales vs
    join eligible_sellers es on es.id = vs.seller_id
    group by es.id
  ),
  -- CORRECAO: so considera operacoes do LOTE VALIDADO mais recente, igual
  -- ao caminho MASTER (operational_analyst_commission_metrics). Antes,
  -- esta funcao lia public.portal_finance_operations sem nenhum filtro de
  -- lote, somando valores de lotes antigos/substituidos junto com o atual.
  visible_finance as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and upper(trim(coalesce(nullif(f.store, ''), es.store, ''))) =
          upper(trim(p_store))
  ),
  principal_finance as (
    select * from visible_finance where is_real_financing
  ),
  later_return as (
    select distinct on (
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from visible_finance
    where is_later_return
    order by
      seller_id,
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
  finance_metrics as (
    select
      seller_id,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance
    group by seller_id
  ),
  -- CORRECAO: mesmo join de lote validado para SPF_CURRENT.
  spf_linked as (
    select distinct
      vf.seller_id,
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
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_linked
    group by seller_id
  ),
  metrics as (
    select
      sum(sm.sold_count)::integer as sold_count,
      coalesce(sum(fm.financed_count), 0)::integer as financed_count,
      coalesce(sum(fm.production_value), 0)::numeric(18,2) as production_value,
      coalesce(sum(fm.return_value), 0)::numeric(18,2) as return_value,
      coalesce(sum(spm.spf_count), 0)::integer as spf_count,
      coalesce(sum(spm.spf_value), 0)::numeric(18,2) as spf_value
    from sales_metrics sm
    left join finance_metrics fm on fm.seller_id = sm.seller_id
    left join spf_metrics spm on spm.seller_id = sm.seller_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'analyst_name', v_user.nome,
        'store', p_store,
        'sold_count', sold_count,
        'financed_count', financed_count,
        'production_value', production_value,
        'return_value', return_value,
        'spf_count', spf_count,
        'spf_value', spf_value,
        'transfer', true,
        'covered_start', p_start,
        'covered_end', p_end
      )
    ) filter (where sold_count > 0),
    '[]'::jsonb
  )
  into v_rows
  from metrics;

  return v_rows;
end;
$function$;

-- Incidente IA-1B -- fechamento sistemico do vazamento de escopo
-- departamental de DIRETOR encontrado no IA-1A, nas 4 RPCs ativas que
-- compartilhavam o mesmo padrao: elegibilidade em eligible_sellers pelo
-- status ATUAL da pessoa + departamento do fato resolvido individualmente
-- (por resolve_department_temporal ou por department bruto da fonte) sem
-- jamais reconferir esse departamento contra o escopo do DIRETOR.
--
-- Investigadas, reproduzidas, quantificadas e corrigidas INDIVIDUALMENTE
-- (nenhum patch generico copiado entre funcoes -- cada uma tem uma
-- estrutura de CTEs diferente):
--
-- 1) operational_salary_details -- ja usava resolve_department_temporal
--    para o campo "department" do output (igual a operational_metrics);
--    faltava so o gate de autorizacao. Blast radius: 1/213 linhas (Jose
--    Carlos Amancio Filho, EUROPA/SEMINOVOS, 31/07/2026). Patch: gate em
--    visible_sales (fecha finance/SPF, que derivam dela via join por
--    chassi/sale_id) + gate espelhado no bloco de contagem
--    (row_count/seller_count/truncated) para manter os metadados
--    consistentes com o array "rows".
--
-- 2) operational_model_metrics_without_spf -- usa o campo "department"
--    BRUTO da fonte para classificar/agrupar por modelo (decisao de
--    negocio, preservada sem alteracao). Um gate ingenuo comparando contra
--    esse campo bruto teria bloqueado 6 vendas LEGITIMAS de vendedores que
--    nunca mudaram de departamento mas tem o campo de origem taggeado de
--    forma inconsistente (confirmado: 0 registros em
--    mudancas_loja_vendedores para esses vendedores) -- corrigido usando
--    resolve_department_temporal com fallback para o status ATUAL da
--    pessoa (nunca para o department bruto) exclusivamente para a decisao
--    de AUTORIZACAO, mantendo a classificacao/exibicao por modelo
--    inalterada. Blast radius real (pos-correcao): 1 linha (mesma venda
--    Jose Carlos, unica com financiamento). Patch: gate em visible_sales
--    (com seller_status adicionado a sales_global_latest) + gate em
--    principal_finance (financiamento nao deriva de visible_sales -- left
--    join preserva financiamento orfao de venda).
--
-- 3) operational_score_coparticipated_data -- mesmo padrao de (2):
--    department bruto para exibicao, gate de autorizacao via
--    resolve_department_temporal com fallback ao status atual (nao ao
--    bruto). Blast radius real: 1 venda + 1 financiamento (mesma operacao
--    Jose Carlos). Patch: gate no SELECT final de v_sales (com
--    seller_status adicionado a sales_latest) + gate em finance_rows.
--
-- 4) operational_analyst_commission_metrics -- agrega por LOJA (nao expoe
--    "department" no output) -- o vazamento aparecia como valor agregado
--    inflado, nao como linha extra: loja EUROPA para DIRETOR NOVOS
--    contaminada em +R$71.680,00 producao / +R$4.300,80 retorno (a mesma
--    operacao Jose Carlos, computada via a analista Fernanda da Silva
--    Santos). CRITICO: funcao usada no calculo de comissao real de
--    ANALISTA -- patch condicionado a "not v_is_director" garante zero
--    impacto para MASTER/GERENTE/ANALISTA/VENDEDOR (confirmado
--    byte-identico antes/depois nos 4 perfis, incluindo checagem nominal
--    de Giovanna Cristina Rivera, Denise Rodrigues da Silva Neves, Jacenir
--    Oliveira Inacio e Fernanda da Silva Santos sob MASTER). Patch: gate
--    em visible_sales_env e visible_finance_env (fecha SPF, que deriva de
--    visible_finance_env via spf_by_window).
--
-- Testado em transacao com ROLLBACK antes de promover, periodo 21/07-20/08:
-- MASTER/GERENTE/ANALISTA/VENDEDOR byte-identicos (hash md5 do payload)
-- antes/depois nas 4 funcoes. DIRETOR NOVOS: 0 linhas fora de NOVOS
-- (verificado por contagem direta, nao so por hash) nas 3 funcoes que
-- expoem department; delta de valor exato (-R$71.680,00/-R$4.300,80) na
-- 4a. DIRETOR SEMINOVOS validado por fixture de perfil em ROLLBACK sobre a
-- conta sintetica MASTER TESTE (sem usuario real hoje): 0 fatos fora de
-- SEMINOVOS nas 4 funcoes -- incluindo confirmacao do caso espelhado
-- (Nadson Pires dos Santos, status atual SEMINOVOS, 0 mudancas, venda
-- taggeada raw como NOVOS mas corretamente autorizada). IDOR de
-- operational_salary_details (VENDEDOR solicitando p_seller_id de outro
-- vendedor) revalidado: 0 linhas.
--
-- Grants e search_path confirmados identicos antes/depois nas 4 funcoes.
--
-- Busca sistemica final (Parte AG): 8 funcoes ativas usam eligible_sellers;
-- 2 (operational_analyst_coverage_details/metrics) nao referenciam
-- is_director -- sem ramo de DIRETOR, nao aplicavel. Das 6 restantes,
-- operational_metrics (IA-1A) e as 4 desta migration estao corrigidas.
-- UMA QUINTA permanece vulneravel em potencial e NAO foi corrigida por
-- regra de parada (nenhuma correcao automatica ao encontrar uma 5a RPC):
-- operational_model_metrics (wrapper de SPF sobre
-- operational_model_metrics_without_spf) computa sua PROPRIA populacao de
-- eligible_sellers/finance_rows/spf_rows independente, sem nenhum gate
-- departamental, para anexar spf_count/spf_value aos rows ja corrigidos da
-- funcao base. Teste empirico pos-correcao da base: 0 linhas com
-- spf_count>0 fora de NOVOS para DIRETOR NOVOS hoje (sem vazamento
-- manifestado no dado atual) -- mas o gap estrutural existe e fica
-- reportado para decisao/incidente proprio antes de liberar IA-2 por
-- completo.

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
      coalesce(public.resolve_store_temporal(es.id, s.sale_date, nullif(s.store,'')),es.store,'SEM LOJA') as store,
      s.department,es.status as seller_status,coalesce(nullif(s.vehicle_model,''),'NÃO INFORMADO') as vehicle_model,
      s.sale_value
    from public.portal_sales s
    join sales_latest_batches slb on slb.id = s.batch_id
      and slb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    join eligible_sellers es on es.id=coalesce(s.seller_user_id, s.seller_id)
    order by s.chassis,s.sale_date desc,s.id desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',sale_date,'seller',seller_name,'store',store,
    'department',department,'model',vehicle_model,'sale_value',sale_value
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
      order by s.chassis,s.sale_date desc,s.id desc
  ), spf_latest as (
    -- Base 03 is a terms snapshot. Do not filter it by the report period.
    select sp.* from public.portal_spf_operations sp
    join latest_batches lb on lb.id=sp.batch_id and lb.source_type='SPF_CURRENT'
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
      -- Incidente IA-1B: gate de autorizacao por departamento EFETIVO
      -- (temporal) da operacao, para DIRETOR -- operation_date ja e a ancora
      -- temporal desta CTE (usada por resolve_store_temporal acima).
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
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales_env as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
      -- Incidente IA-1B: mesmo principio do IA-1A -- para DIRETOR, autorizacao
      -- vale sobre o departamento EFETIVO (temporal) do fato. Esta funcao
      -- agrega por LOJA (nao expoe "department" no output), mas o vazamento
      -- e o mesmo: fatos fora do departamento do DIRETOR contaminando o
      -- total da loja. No-op para MASTER/GERENTE/ANALISTA/VENDEDOR
      -- (v_is_director sempre false) -- nao afeta calculo real de comissao.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, s.sale_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
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
      -- Incidente IA-1B: mesmo gate de visible_sales_env -- fecha finance e,
      -- por derivacao (spf_by_window faz join a visible_finance_env), SPF
      -- tambem.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
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
      null::date as covered_end,
      null::text as coverage_id
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
      covered_end,
      id as coverage_id
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
            'covered_end', covered_end,
            'coverage_id', coverage_id
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

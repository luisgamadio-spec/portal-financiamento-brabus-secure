-- Incidente IA-1C -- fecha o ultimo gap sistemico de escopo departamental
-- de DIRETOR, encontrado na busca sistemica final do IA-1B:
-- operational_model_metrics (wrapper de SPF sobre a ja corrigida
-- operational_model_metrics_without_spf).
--
-- CAUSA: o wrapper chama a funcao base corrigida (v_base, ja gated) mas
-- depois computa sua PROPRIA populacao independente de
-- eligible_sellers/finance_rows/spf_rows, sem nenhum gate departamental,
-- so para anexar spf_count/spf_value aos rows ja corrigidos, casando por
-- (store, department, model). Como esse join nao e por pessoa/operacao,
-- SPF de uma operacao temporalmente NAO AUTORIZADA para o DIRETOR pode
-- contaminar uma linha legitima que so coincida em
-- (loja, departamento, modelo).
--
-- GAP ESTRUTURAL COMPROVADO por fixture controlada em transacao com
-- ROLLBACK (nenhum dado real criado): vendedor sintetico de teste
-- (conta "VENDEDOR TESTE" de contas_sinteticas_excluidas) recebeu status
-- NOVOS + loja BARRA FUNDA (mesma loja de um vendedor real, Vinicius
-- Caldas de Oliveira, com venda legitima de COROLLA GLI 2.0 la) e um
-- registro real em mudancas_loja_vendedores (SEMINOVOS ate 25/07/2026,
-- NOVOS a partir de 26/07/2026). Uma venda+financiamento+SPF fake foram
-- inseridos em 22/07/2026 (dentro do periodo SEMINOVOS do vendedor
-- sintetico), com o MESMO modelo (COROLLA GLI 2.0) e loja (BARRA FUNDA)
-- da venda real do Vinicius. Resultado ANTES do patch: a linha legitima
-- do Vinicius (sold_count=1, corretamente autorizada) aparecia com
-- spf_count=1, spf_value=R$999.999,99 -- o valor de teste do
-- financiamento SEMINOVOS nao autorizado do vendedor sintetico, anexado
-- indevidamente. Depois do patch: spf_count=0, spf_value=0 na mesma
-- linha, sold_count=1 preservado. Transacao inteira revertida (ROLLBACK),
-- nenhum dado de teste persistido.
--
-- Vazamento manifestado nos DADOS REAIS hoje (sem fixture): 0 -- nenhuma
-- operacao de SPF real colide hoje com uma linha de departamento
-- raw-label-inconsistente ja autorizada. O gap era estrutural/potencial,
-- nao ativo -- ainda assim corrigido, pois o mesmo padrao ja se
-- manifestou realmente em outras 4 funcoes (IA-1A/IA-1B) com o
-- surgimento de novos dados.
--
-- PATCH (minimo, 1 CTE): gate em finance_rows, mesmo principio das fases
-- anteriores -- para DIRETOR, autorizacao vale sobre o departamento
-- EFETIVO (temporal, com fallback ao status ATUAL da pessoa, nunca ao
-- department bruto) do fato de financiamento. Como spf_linked so anexa
-- SPF a financiamentos presentes em finance_rows (inner join por
-- client_match_key), o gate na raiz fecha o SPF automaticamente. Nao
-- altera classificacao de modelo, nomenclatura, agrupamento, store,
-- department exibido, sold_count, financed_count, production ou return
-- -- nenhum desses vem do wrapper (todos ja corrigidos em v_base,
-- herdados sem alteracao). Preserva a string "NÃƒO INFORMADO" (mojibake
-- pre-existente em producao, nao relacionado a este incidente -- fora de
-- escopo, nao corrigido aqui).
--
-- Testado em transacao com ROLLBACK antes de promover, periodo
-- 21/07-20/08: MASTER/GERENTE/ANALISTA/VENDEDOR com hash MD5 do payload
-- completo identico antes/depois (4/4). DIRETOR NOVOS: 94 linhas, 0 com
-- SPF fora de NOVOS, hash identico antes/depois do patch (confirma 0
-- vazamento manifestado hoje -- a fixture, feita separadamente, e que
-- provou o gap estrutural). DIRETOR SEMINOVOS (fixture de perfil sobre
-- conta sintetica MASTER TESTE): 0 SPF fora de SEMINOVOS. Sentinela Jose
-- Carlos: linha EUROPA/SEMINOVOS (pre-31/07) ausente, linha
-- ALPHAVILLE/SEMINOVOS -- rotulo bruto, corretamente autorizada, caso ja
-- documentado no IA-1B -- presente. Smoke tests OK:
-- operational_analyst_coverage_details, operational_salary_details (414
-- linhas), operational_score_coparticipated_data (414 vendas),
-- operational_analyst_commission_metrics (13 linhas) -- todas
-- inalteradas desde o IA-1B.
--
-- Grants (authenticated/postgres/service_role) e search_path
-- ('pg_catalog, public') confirmados identicos antes/depois.
--
-- BUSCA SISTEMICA FINAL: das 6 funcoes ativas que combinam
-- eligible_sellers + is_director, as 6 agora tem
-- resolve_department_temporal + o gate "not v_is_director or ...":
-- operational_metrics (IA-1A), operational_salary_details,
-- operational_model_metrics_without_spf,
-- operational_score_coparticipated_data,
-- operational_analyst_commission_metrics (IA-1B) e
-- operational_model_metrics (esta migration). As 2 funcoes restantes que
-- usam eligible_sellers (operational_analyst_coverage_details/_metrics)
-- nao tem ramo de DIRETOR -- confirmado nao aplicavel.
--
-- RPCs analiticas ativas com o padrao vulneravel remanescentes: 0.

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
      -- Incidente IA-1C: mesmo principio do IA-1A/IA-1B -- para DIRETOR, a
      -- autorizacao vale sobre o departamento EFETIVO (temporal, com
      -- fallback ao status ATUAL da pessoa, nunca ao department bruto) do
      -- fato de financiamento. Gap comprovado por fixture controlada em
      -- ROLLBACK: SPF de uma operacao temporalmente nao-autorizada
      -- contaminava uma linha legitima que compartilhava
      -- (loja, departamento, modelo) em spf_metrics. Como spf_linked so
      -- anexa SPF a financiamentos presentes em finance_rows (inner join
      -- por client_match_key), este gate fecha o SPF na raiz.
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

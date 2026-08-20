-- Incidente 22.9 -- ultima funcao analitica encontrada na busca sistemica
-- pos-22.8 com o padrao vulneravel de sales cross-batch, agora corrigida.
--
-- operational_reporting_summary.visible_sales lia public.portal_sales
-- diretamente, sem restringir aos batches VALIDATED canonicos e sem
-- DISTINCT ON (chassis) -- ou seja, contava CADA COPIA FISICA de CADA
-- reimportacao diaria como uma venda separada. No periodo 21/07-20/08:
-- 3.962 linhas fisicas contra 448 vendas canonicas reais (chamada como
-- MASTER, sem filtro de elegibilidade adicional) -- inflacao de ~8,8x.
--
-- Efeito cascata comprovado: finance_groups faz LEFT JOIN entre
-- portal_finance_operations (corretamente restrita ao batch FINANCE
-- canonico) e visible_sales (multiplicada) -- cada copia duplicada de
-- uma venda somava o MESMO financiamento de novo. Prova numerica: Jose
-- Carlos Amancio Filho em ALPHAVILLE/NOVOS tinha sales_count=11,
-- financed_or_service_value=R$387.487,74, return_value=R$22.950,00
-- antes; apos a correcao, sales_count=2, financed_or_service_value=
-- R$77.331,29, return_value=R$4.590,00 -- a razao de reducao em
-- financed/return (5,01x e 5,00x) bate com a razao de reducao em
-- sales_count (5,5x), confirmando que a multiplicacao em finance era
-- inteiramente causada pela populacao de sales suja, nao por qualquer
-- outro fator.
--
-- Sem caller no frontend atual nem caller RPC interno -- funcao
-- dormente do ponto de vista de UI hoje, mas EXECUTE permanece
-- concedido a authenticated (preservado neste incidente; remocao de
-- EXECUTE de funcao dormente e decisao de hardening separada, fora de
-- escopo aqui).
--
-- Correcao (patch minimo, corpo LIVE + 1 alteracao estrutural pontual):
-- a CTE latest_batches (ja existente, usada para FINANCE_CURRENT/
-- FINANCE_HISTORY) passa a incluir tambem SALES_CURRENT/SALES_HISTORY;
-- uma nova CTE sales_canonical_dedup faz DISTINCT ON (chassis) restrito
-- a esses batches (mesmo padrao ja homologado em operational_metrics
-- pos-22.7 e nas 5 funcoes do Incidente 22.8 -- dedup GLOBAL por chassi
-- ANTES do filtro de periodo, nao depois); visible_sales passa a ler de
-- sales_canonical_dedup em vez de public.portal_sales diretamente,
-- preservando 100% das suas colunas/expressoes/filtro de elegibilidade
-- originais (MASTER/DIRETOR/VENDEDOR, resolve_store_temporal, join a
-- usuarios/portal_sellers). finance_groups e a regra de FINANCE_CURRENT/
-- FINANCE_HISTORY nao foram tocados -- a diferenca residual entre os
-- valores desta funcao e os de operational_metrics (esta soma toda linha
-- de finance vinculada ao chassi, sem o filtro is_real_financing/dedup
-- de later_return que operational_metrics usa) e uma caracteristica de
-- contrato PRE-EXISTENTE, documentada mas fora do escopo deste patch
-- (nao redesenhar a funcao).
--
-- Testado em transacao com ROLLBACK antes de promover, e revalidado ao
-- vivo apos a promocao: sales_count 3.962 -> 448 (identico candidata e
-- live), financed_or_service_value R$143.434.963,68 -> R$16.532.465,11,
-- return_value R$11.318.163,49 -> R$1.268.878,98. As 5 vendas fantasmas
-- conhecidas (Wesley, Eduardo, Viviane, Ronaldo, Marcio) confirmadas
-- ausentes da populacao canonica. Venda legitima de alta reimportacao
-- (12 copias fisicas) confirmada presente 1x. Historico legitimo
-- (SALES_HISTORY, jan-mai/2026) confirmado preservado. Grants e
-- search_path identicos antes/depois. Smoke pos-promocao: Resumo
-- (operational_metrics) = 361, Wesley 7/3/42,857%/R$2.247,88 inalterado,
-- Score (operational_score_coparticipated_data) = 2498, Jacenir
-- (operational_analyst_commission_metrics_v2) identica ao Incidente
-- 22.8 -- nenhuma das funcoes ja corrigidas foi tocada por esta
-- migration.

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

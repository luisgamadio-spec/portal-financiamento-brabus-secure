-- SEC-1D.1: operational_score_coparticipated_data ganha p_group_view
-- (Human-approved Score contract: ANALISTA/GERENTE/DIRETOR devem poder
-- consultar Score individual/ranking/comparação cross-store, dentro da
-- própria autoridade de departamento; VENDEDOR permanece restrito ao
-- próprio Score).
--
-- Mudança MÍNIMA, intencionalmente restrita a UM ponto estrutural: nas
-- duas CTEs eligible_sellers (bloco de vendas e bloco de financiamento,
-- cada uma com um branch para public.usuarios e outro para o legado
-- public.portal_sellers -- 4 pontos no total), o termo
--   not v_is_seller and <loja do vendedor> = v_store
-- passa a ser
--   not v_is_seller and (<loja do vendedor> = v_store or p_group_view)
--
-- Por que isto é seguro (raciocínio auditado no SEC-1D.1, não apenas
-- testado):
--
-- 1. VENDEDOR nunca alcança o branch modificado. A estrutura OR de
--    elegibilidade é:
--      v_is_master OR (department_match AND (v_is_director
--        OR (v_is_seller AND u.id = v_user_id)
--        OR (NOT v_is_seller AND (...))))
--    Quando v_is_seller = true, o termo "NOT v_is_seller" do branch
--    modificado é sempre falso -- o vendedor cai exclusivamente no
--    branch irmão "v_is_seller AND u.id = v_user_id", que esta
--    migration NÃO altera. p_group_view=true não tem nenhum efeito
--    sobre um chamador VENDEDOR: ele continua vendo exclusivamente os
--    próprios fatos, por construção, não por verificação adicional.
--
-- 2. Nenhum bypass de capacidade. Esta função já levanta 42501 no
--    topo (antes de qualquer CTE) se portal_modulos_permitidos() não
--    contiver 'analiseScoreVendedores' -- isto vale incondicionalmente
--    para QUALQUER chamador, com ou sem p_group_view. Diferente de
--    operational_metrics/operational_model_metrics_without_spf (que
--    não tinham gate de capacidade algum e por isso precisaram de uma
--    reverificação própria embutida no branch do p_group_view -- ver
--    20260824020000_incidente_p1_groupview_authorization_escalation.sql),
--    esta função já não precisa de uma segunda verificação: o gate de
--    entrada já é estritamente mais amplo (roda sempre) do que o que
--    precisaria ser verificado dentro do branch.
--
-- 3. Nenhum bypass de departamento. department_match (a condição que
--    testa u.status/ps.status contra v_departments) continua aplicada
--    IGUALMENTE a todos os branches, incluindo o modificado -- um
--    ANALISTA/GERENTE com p_group_view=true só passa a ver vendedores
--    de OUTRAS LOJAS dentro do(s) MESMO(S) departamento(s) que já
--    tinha autoridade para ver hoje (mesma loja). Nenhuma linha deste
--    diff toca department_match.
--
-- 4. DIRETOR/MASTER são inteiramente inafetados. v_is_master e
--    v_is_director já satisfazem o OR antes de o branch modificado ser
--    avaliado -- p_group_view não muda nada para esses dois perfis
--    (DIRETOR já tinha cross-store dentro do próprio departamento,
--    estruturalmente, antes desta migration -- achado do SEC-1D).
--
-- Nada mais nesta função é alterado: mascaramento, minimização de
-- dados (contains_client_identity/contains_personal_documents/
-- contains_full_chassis seguem false), resolução de escopo, gate de
-- capacidade, classificação de plano, cálculo de SPF -- tudo
-- preservado byte-a-byte.
--
-- p_group_view DEFAULT false preserva o comportamento de TODO chamador
-- de 2 argumentos existente -- inventário completo desta fase (grep em
-- ambos os repositórios, nenhum passa um 3º argumento hoje):
--   - assets/js/score-coparticipated-secure-adapter.js (Portal V2)
--   - assets/js/adapters/score-real-provider.js (Portal V2, REST direto)
--   - assets/js/adapters/coparticipado-real-provider.js (Portal V2, REST direto)
--   - supabase/functions/portal-ai-homolog/index.ts (esta fase atualiza
--     o call site para passar p_group_view condicionalmente -- único
--     consumidor desta migration que muda de comportamento, e só para
--     ANALISTA/GERENTE/DIRETOR autorizados, ver §9 do relatório)
--   - supabase/functions/portal-ai/index.ts (Edge Function de PRODUÇÃO,
--     separada de portal-ai-homolog, FORA do escopo desta wave -- não
--     modificada; permanece com 2 argumentos, portanto inteiramente
--     inafetada por este DROP/CREATE)
--
-- Definição live capturada e auditada bit-a-bit antes desta mudança
-- (SEC-1D.1, sem drift em relação ao que o SEC-1D já havia auditado).
--
-- DROP + CREATE (não apenas CREATE OR REPLACE): mesmo padrão já
-- estabelecido em 20260822040000_incidente_ux_grupo30_item2_group_view.sql
-- para operational_metrics/operational_model_metrics(_without_spf) --
-- adicionar um parâmetro com DEFAULT via CREATE OR REPLACE sozinho cria
-- uma SEGUNDA função sobrecarregada (2 args) coexistindo com a nova (3
-- args), nunca substituindo-a -- qualquer chamador de 2 argumentos
-- (score-real-provider.js, coparticipado-real-provider.js, e a própria
-- IA antes do próximo passo) continuaria resolvendo para a assinatura
-- antiga, nunca herdando o novo comportamento nem o DEFAULT. O DROP da
-- assinatura de 2 argumentos evita essa ambiguidade -- confirmado sem
-- conflito: apenas uma função com esse nome/assinatura existe hoje.
--
-- GRANTs capturados antes do DROP (pg_proc.proacl, live,
-- yacqlelpzchcotgngwbh): authenticated=X, service_role=X, postgres=X
-- (owner) -- SEM anon, SEM PUBLIC. Um DROP remove todos os grants; a
-- CREATE seguinte concede EXECUTE a PUBLIC por padrão do Postgres --
-- corrigido abaixo com REVOKE explícito de PUBLIC/anon e GRANT
-- explícito de authenticated/service_role, replicando exatamente os
-- grants capturados (mesmo padrão do precedente citado acima).

DROP FUNCTION public.operational_score_coparticipated_data(date, date);

CREATE OR REPLACE FUNCTION public.operational_score_coparticipated_data(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_module_allowed jsonb;
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
  -- Incidente P2 SCORE-SEC-1: capability server-side. permissoes_modulos
  -- ja negava VENDEDOR (NOVOS e SEMINOVOS) para analiseScoreVendedores,
  -- mas esta RPC nunca checava isso -- so aplicava escopo (loja/depto),
  -- nao "pode usar o modulo". Reusa o mecanismo canonico existente
  -- (portal_modulos_permitidos(), o mesmo que decide o que aparece no
  -- Portal Home) em vez de duplicar a resolucao de perfil/departamento
  -- aqui. MASTER e tratado de forma estrutural dentro dessa funcao (nao
  -- depende de linha em permissoes_modulos). Identidade nao resolvida/
  -- inativa/desconhecida ja retorna [] por aquela funcao -- fail closed.
  -- SEC-1D.1: este gate roda incondicionalmente, ANTES de p_group_view
  -- ser lido -- um chamador sem analiseScoreVendedores é rejeitado aqui
  -- independentemente do valor de p_group_view.
  v_module_allowed := public.portal_modulos_permitidos();
  if not (v_module_allowed ? 'analiseScoreVendedores') then
    raise exception 'Acesso não autorizado ao módulo Score F&I.'
      using errcode = '42501';
  end if;

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
             -- SEC-1D.1: or p_group_view -- só alcançável quando
             -- not v_is_seller já é verdade (um vendedor nunca chega
             -- aqui, ver comentário no topo do arquivo).
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store or p_group_view)))))
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
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store or p_group_view)))))
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
    'department',department,'model',vehicle_model,'sale_value',sale_value,
    'operation_reference',case when chassis is null then '' else '***'||right(chassis,6) end
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
             -- SEC-1D.1: mesma correção do bloco de vendas acima.
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store or p_group_view)))))
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
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store or p_group_view)))))
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
  ), spf_fandi_latest as (
    -- PERF-COPART-01: pre-resolves the same "most recent FANDI row per
    -- client_match_key" the old per-row LATERAL picked (identical filter
    -- and tie-break: modality='FANDI', operation_date desc nulls last, id
    -- desc), computed ONCE instead of once per finance row. Proven exact
    -- (jsonb equality, all 1193 real rows) and ~25x faster (2625ms ->
    -- 104ms on the full real dataset) -- see the paired migration's own
    -- header for the full forensic trail.
    select distinct on (x.client_match_key) x.*
    from spf_latest x
    where upper(coalesce(x.modality,'')) = 'FANDI'
    order by x.client_match_key, x.operation_date desc nulls last, x.id desc
  ), spf_extra_agg as (
    -- PERF-COPART-01: pre-aggregates the same spf_value/spf_count the old
    -- code computed via two separate per-row correlated subqueries
    -- (sum(optional_value)/count(*) where is_spf_extra, by
    -- client_match_key) into one GROUP BY, computed ONCE.
    select x.client_match_key,
           sum(x.optional_value) as spf_value,
           count(*)::integer as spf_count
    from spf_latest x
    where x.is_spf_extra
    group by x.client_match_key
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
      coalesce(sea.spf_value,0) as spf_value,
      coalesce(sea.spf_count,0) as spf_count
    from public.portal_finance_operations f
    join latest_batches lb on lb.id=f.batch_id and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id=coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis=f.chassis
    left join spf_fandi_latest sp on sp.client_match_key = f.client_match_key
    left join spf_extra_agg sea on sea.client_match_key = f.client_match_key
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
    -- (Análise Geral do Grupo)  plan_codigo_if/tc_devolvida/balloon_value de
    -- portal_finance_operations, prioridade SUBSIDIADO > REVERSÃO > COPARTICIPADO
    -- > BALÃO > LINEAR. Antes desta correção, Coparticipados usava uma
    -- implementação paralela (join ao vivo contra portal_spf_operations exigindo
    -- modality='FANDI' + regex sobre tc_returned) que divergia da Análise Geral
    -- sempre que o cliente não tinha linha correspondente em portal_spf_operations
    -- para o período  comprovado por simulação lado a lado (julho/2026: regra
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

GRANT EXECUTE ON FUNCTION public.operational_score_coparticipated_data(date, date, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.operational_score_coparticipated_data(date, date, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.operational_score_coparticipated_data(date, date, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operational_score_coparticipated_data(date, date, boolean) FROM anon;

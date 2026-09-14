-- SEC-1D.1 (fix 2, discovered during live security testing of fix 1
-- above, in the same migration "20260913200000_sec1d1_score_group_view.sql"):
-- a real VENDEDOR cannot reach operational_score_coparticipated_data at
-- all -- not even for their OWN score, p_group_view=false -- because
-- the function's entry gate requires
--   portal_modulos_permitidos() ? 'analiseScoreVendedores'
-- UNCONDITIONALLY, for every caller, and the real permissoes_modulos
-- table has this grant = false for VENDEDOR (both NOVOS and SEMINOVOS
-- -- confirmed live, and already documented inline in this same
-- function's own "Incidente P2 SCORE-SEC-1" comment). Proven live this
-- wave: impersonating a real active VENDEDOR (Bandeirantes, NOVOS) via
-- auth.uid() and calling operational_score_coparticipated_data(...,
-- false) raised 42501 "Acesso não autorizado ao módulo Score F&I."
--
-- Root cause: analiseScoreVendedores was designed to gate the Score
-- ANALYSIS module (ranking/any-seller lookup) -- it was never designed
-- to gate a personal self-view, because no such self-view existed in
-- the Portal before this AI feature (SEC-1D's own finding). The
-- Edge Function's tool-policy layer (supabase/functions/portal-ai-homolog/
-- scope-policy.ts, SEC-1D) already reflects exactly this distinction --
-- it does not require analiseScoreVendedores for mode="own" -- but this
-- RPC's OWN independent copy of the same gate had no equivalent
-- exemption, so a real VENDEDOR's own-score request was rejected at
-- the database layer regardless of how correctly the Edge Function
-- policy behaved.
--
-- Fix (minimal, identity-bit-based, consistent with how v_is_master is
-- ALREADY structurally exempted throughout this same function without
-- ever touching permissoes_modulos): the entry gate now also exempts
-- v_is_master (already implicitly always true via the real grant table
-- in practice, but made structurally explicit here for the same reason
-- every eligible_sellers branch in this function already starts with
-- "v_is_master or (...)" rather than relying on the table alone) and
-- v_is_seller. A seller's own result is UNCONDITIONALLY restricted to
-- their own rows regardless of this gate or of p_group_view (the
-- eligible_sellers branch "v_is_seller AND u.id = v_user_id", untouched
-- by fix 1 above, is the ONLY branch a seller can ever reach) -- so
-- exempting v_is_seller from this one capability check cannot grant a
-- seller anything beyond their own already-self-scoped facts.
--
-- DIRETOR is explicitly NOT exempted: DIRETOR_NOVOS (grant=true) and
-- DIRETOR_SEMINOVOS (grant=false, no active user today) continue to be
-- decided exclusively by the real permissoes_modulos table, unchanged
-- -- preserving the exact asymmetry the Human's own brief required kept
-- intact ("Do not change the permission matrix").
--
-- Structural side-effect of the reorder (operational_current_scope()
-- now resolves BEFORE the module-gate check, so v_is_seller is known
-- in time): an inactive/unresolvable identity now surfaces
-- operational_current_scope()'s OWN exception message ("Conta sem
-- perfil ativo no portal."/"Perfil sem acesso aos dados operacionais.")
-- instead of this function's own "Acesso não autorizado ao módulo
-- Score F&I." -- both raise errcode 42501 either way, and the
-- Edge Function never surfaces either raw message to a caller (wrapped
-- into a generic ToolError) -- not a security-relevant change, noted
-- for transparency only. Every other ordering (period validation vs.
-- the module-gate check) is unchanged: the gate still runs before
-- period validation, exactly as before fix 2.
--
-- Nothing else in this function changes from its post-fix-1 state:
-- fix 1's p_group_view widening, all eligibility branches, masking,
-- data minimization fields, plan classification, and SPF calculation
-- are carried over byte-for-byte.

DROP FUNCTION public.operational_score_coparticipated_data(date, date, boolean);

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
  -- SEC-1D.1 (fix 2): escopo resolvido ANTES do gate de capacidade,
  -- para que v_is_seller já seja conhecido no momento da verificação
  -- abaixo (ver cabeçalho do arquivo para o raciocínio completo).
  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(select jsonb_array_elements_text(v_scope->'departments'));
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  -- Incidente P2 SCORE-SEC-1: capability server-side. permissoes_modulos
  -- ja negava VENDEDOR (NOVOS e SEMINOVOS) para analiseScoreVendedores,
  -- mas esta RPC nunca checava isso -- so aplicava escopo (loja/depto),
  -- nao "pode usar o modulo". Reusa o mecanismo canonico existente
  -- (portal_modulos_permitidos(), o mesmo que decide o que aparece no
  -- Portal Home) em vez de duplicar a resolucao de perfil/departamento
  -- aqui. Identidade nao resolvida/inativa/desconhecida ja levanta
  -- exceção dentro de operational_current_scope(), acima -- fail
  -- closed, igual a antes.
  -- SEC-1D.1 (fix 2): v_is_master e v_is_seller sao exemptados deste
  -- gate -- v_is_master ja e estruturalmente privilegiado em toda esta
  -- função (cada branch de eligible_sellers abaixo começa com
  -- "v_is_master or (...)"), e um vendedor (is_seller) consultando a si
  -- mesmo tem seu resultado SEMPRE restrito à própria linha
  -- (eligible_sellers: "v_is_seller AND u.id = v_user_id", inalterado),
  -- independente deste gate e independente de p_group_view -- exemptar
  -- v_is_seller aqui não concede nada alem do que esse vendedor já
  -- receberia de qualquer forma. DIRETOR permanece decidido
  -- exclusivamente pela tabela real (DIRETOR_NOVOS=true,
  -- DIRETOR_SEMINOVOS=false hoje) -- não exemptado aqui.
  v_module_allowed := public.portal_modulos_permitidos();
  if not v_is_master and not v_is_seller and not (v_module_allowed ? 'analiseScoreVendedores') then
    raise exception 'Acesso não autorizado ao módulo Score F&I.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.' using errcode = '22023';
  end if;

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
    select distinct on (x.client_match_key) x.*
    from spf_latest x
    where upper(coalesce(x.modality,'')) = 'FANDI'
    order by x.client_match_key, x.operation_date desc nulls last, x.id desc
  ), spf_extra_agg as (
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

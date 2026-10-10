-- Aplicada em produção em 09/10/2026. PASSO 1 do Score no servidor: cria _operational_score_coparticipated_data_core e operational_score_vendedores (mesma fórmula da tela; item Retorno em degraus, degrau mais próximo, a partir do ciclo de 21/10/2026). Nada do que existia muda. Rollback: docs/rollback/score_passo1_antes.sql
begin;
CREATE OR REPLACE FUNCTION public._operational_score_coparticipated_data_core(p_start date, p_end date, p_group_view boolean DEFAULT false)
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
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store)))))
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
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store)))))
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
    -- REVENDA3: exclude rows whose OWN store field is REVENDA, before
    -- resolve_store_temporal (called in the SELECT list above) can launder
    -- a REVENDA row's identity through a resolved/temporal store value.
    -- Unconditional -- not gated by the eligible_sellers join above.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
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
             or (not v_is_seller and (upper(trim(coalesce(u.loja,'')))=v_store)))))
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
              or (not v_is_seller and (upper(coalesce(ps.store,''))=v_store)))))
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
      -- REVENDA3: exclude rows whose OWN store field is REVENDA. This CTE
      -- is enrichment-only (department/sale_value/vehicle_model, no store
      -- column selected) but is still a direct read of portal_sales --
      -- filtered here for defense in depth/audit completeness, consistent
      -- with every other direct read site in this migration.
      where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
      order by s.chassis,s.sale_date desc,s.id desc
  ), spf_latest as (
    -- Base 03 is a terms snapshot. Do not filter it by the report period.
    select sp.* from public.portal_spf_operations sp
    join latest_batches lb on lb.id=sp.batch_id and lb.source_type='SPF_CURRENT'
    -- REVENDA3: independent linkage -- this CTE reads portal_spf_operations
    -- directly (sp.*) and is attached to finance_rows below purely by
    -- client_match_key, independent of both the sales and finance store
    -- fields. Mirrors the REVENDA-2 companion fix's own spf.store filter
    -- in operational_salary_details' spf_links CTE (portal-financiamento-
    -- brabus-secure, commit be9e96b).
    where upper(trim(coalesce(sp.store, ''))) <> 'REVENDA'
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
      -- SECURE-SPF-PLACEHOLDER-FIX-09: optional_value=1,00 is a non-
      -- operational NBS import placeholder, proven never to represent a
      -- real value (SECURE-SPF-PLACEHOLDER-AUDIT-08) -- excluded here.
      and coalesce(x.optional_value, 0) <> 1
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
      coalesce(sea.spf_count,0) as spf_count,
      -- MEGA-UAT-WAVEC3B: explicit FANDI-modality-authority provenance --
      -- true iff this row's client_match_key was actually matched by
      -- spf_fandi_latest (the exact, already-live modality='FANDI' gate
      -- above), never inferred from plan_codigo_if/tc_devolvida/
      -- balloon_value (those decide 'plan' below, independently).
      (sp.client_match_key is not null) as is_fandi
    from public.portal_finance_operations f
    join latest_batches lb on lb.id=f.batch_id and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    join eligible_sellers es on es.id=coalesce(f.seller_user_id, f.seller_id)
    left join sales_latest sl on sl.chassis=f.chassis
    left join spf_fandi_latest sp on sp.client_match_key = f.client_match_key
    left join spf_extra_agg sea on sea.client_match_key = f.client_match_key
    where f.operation_date between p_start and p_end and f.is_real_financing
      -- REVENDA3: exclude finance rows whose OWN store field is REVENDA,
      -- unconditional -- never gated by seller eligibility. This is the
      -- primary row source of v_finance's financed_value/return_value/
      -- spf_value aggregation.
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
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
    'is_fandi',is_fandi,
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
$function$
;

CREATE OR REPLACE FUNCTION public.operational_score_vendedores(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
-- Score de vendedores calculado no servidor: mesma fórmula de calcScores() (assets/js/adapters/score.adapter.js) e de
-- calculaScores() (Brabus Intelligence, data/score.ts), sobre as MESMAS linhas que o perfil já recebe hoje de
-- operational_score_coparticipated_data (mesmo escopo; p_group_view não existe aqui). Nunca devolve valores em R$
-- por contrato. Para perfis não autorizados a ver retorno, também não devolve produção nem o % de retorno médio
-- (só os pontos do item; decisão de 09/10/2026: item Retorno em degraus a partir do ciclo de 21/10). Conta em float8,
-- a mesma aritmética do navegador (o arredondamento de x,5 tem de bater com Math.round da tela). Produção (R$) não sai para ninguém.
declare
  v_base jsonb;
  v_rows jsonb;
  -- opção (b), decisão de 09/10/2026: item Retorno em degraus (degrau MAIS PRÓXIMO de 0/25/50/75/100%) a partir da competência que começa em 21/10/2026
  v_degraus boolean := p_start >= date '2026-10-21';
begin
  v_base := public._operational_score_coparticipated_data_core(p_start, p_end, false);

  with sales as (
    select coalesce(x->>'seller', '') seller, coalesce(x->>'store', '') store,
           case when upper(trim(coalesce(x->>'department', ''))) = 'SEMINOVOS' then 'Seminovos' else 'Novos' end dept,
           case when upper(coalesce(x->>'model', '')) like '%OUTLANDER%' then 'Outlander'
                when upper(coalesce(x->>'model', '')) like '%TRITON%' or upper(coalesce(x->>'model', '')) like '%L200%' then 'Triton'
                when upper(coalesce(x->>'model', '')) like '%ECLIPSE%' then 'Eclipse Cross' else 'Outros' end familia
    from jsonb_array_elements(coalesce(v_base->'sales', '[]'::jsonb)) x
  ),
  fins as (
    select coalesce(x->>'seller', '') seller, coalesce(x->>'store', '') store,
           case when upper(trim(coalesce(x->>'department', ''))) = 'SEMINOVOS' then 'Seminovos' else 'Novos' end dept,
           coalesce(nullif(x->>'plan', ''), 'LINEAR') plano,
           coalesce((x->>'financed_value')::float8, 0) producao,
           coalesce((x->>'return_value')::float8, 0) + coalesce((x->>'spf_value')::float8, 0) retorno,
           coalesce((x->>'spf_count')::float8, 0) spf_qtd
    from jsonb_array_elements(coalesce(v_base->'finance', '[]'::jsonb)) x
  ),
  chaves as (select seller, store, dept from sales union select seller, store, dept from fins),
  agg as (
    select k.seller, k.store, k.dept,
      (select count(*) from sales s where (s.seller, s.store, s.dept) = (k.seller, k.store, k.dept))::float8 vendas,
      (select count(distinct s.familia) from sales s where (s.seller, s.store, s.dept) = (k.seller, k.store, k.dept) and s.dept = 'Novos')::float8 familias,
      (select count(*) from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept))::float8 fin,
      (select coalesce(sum(f.producao), 0) from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept)) producao,
      (select coalesce(sum(f.retorno), 0) from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept)) retorno,
      (select coalesce(sum(f.spf_qtd), 0) from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept)) spf_qtd,
      (select count(distinct f.plano) from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept)
         and f.plano in ('LINEAR', 'BALÃO', 'COPARTICIPADO', 'SUBSIDIADO'))::float8 planos_validos,
      (select f.plano from fins f where (f.seller, f.store, f.dept) = (k.seller, k.store, k.dept)
         group by f.plano order by count(*) desc, f.plano limit 1) plano_mais
    from chaves k
  ),
  ref as (select dept, greatest(1, max(vendas)) max_venda from agg group by dept),
  pts as (
    select a.*, r.max_venda,
      case when a.dept = 'Novos' then 250 else 300 end w_vol, case when a.dept = 'Novos' then 230 else 270 end w_share,
      130 w_fam, 130 w_pl, case when a.dept = 'Novos' then 100 else 150 end w_spf, case when a.dept = 'Novos' then 160 else 280 end w_ret,
      case when a.vendas > 0 then a.fin / a.vendas else 0 end share,
      case when a.producao > 0 then a.retorno / a.producao else 0 end ret,
      least(1, a.vendas / 4.0) conf_v, least(1, a.fin / 2.0) conf_f,
      case when a.fin > 0 then a.spf_qtd / a.fin else 0 end spf_rate
    from agg a left join ref r on r.dept = a.dept
  ),
  calc as (
    select p.*,
      p.w_vol * least(1, p.vendas / coalesce(p.max_venda, 1)) p_vol,
      p.w_share * least(1, p.share / 0.6) * p.conf_v p_share,
      case when p.dept = 'Novos' then p.w_fam * least(1, p.familias / 3.0) end p_fam,
      case when p.dept = 'Novos' then p.w_pl * least(1, p.planos_validos / 4.0) end p_pl,
      p.w_spf * least(1, p.spf_rate) * p.conf_f p_spf,
      case when v_degraus then p.w_ret * (floor(least(1, p.ret / 0.08) * 4 + 0.5) / 4) * p.conf_f
           else p.w_ret * least(1, p.ret / 0.08) * p.conf_f end p_ret
    from pts p
  ),
  fim as (
    select c.*, floor(greatest(0, least(1000, c.p_vol + c.p_share + coalesce(c.p_fam, 0) + coalesce(c.p_pl, 0) + c.p_spf + c.p_ret)) + 0.5) score
    from calc c
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'vendedor', f.seller, 'loja', f.store, 'departamento', f.dept, 'score', f.score,
      'vendas', f.vendas, 'financiados', f.fin, 'share', round(f.share::numeric, 6), 'spf_qtd', f.spf_qtd,
      'plano_mais_vendido', coalesce(f.plano_mais, '—'),
      'retorno_medio_pct', round((f.ret * 100)::numeric, 4),
      'composicao', jsonb_path_query_array(jsonb_build_array(
        jsonb_build_object('item', 'Volume de vendas', 'pontos', floor(f.p_vol + 0.5), 'maximo', f.w_vol, 'vendas', f.vendas, 'referencia', f.max_venda),
        jsonb_build_object('item', 'Penetração de financiamento', 'pontos', floor(f.p_share + 0.5), 'maximo', f.w_share, 'financiados', f.fin, 'vendas', f.vendas),
        case when f.dept = 'Novos' then jsonb_build_object('item', 'Mix de famílias vendidas', 'pontos', floor(f.p_fam + 0.5), 'maximo', f.w_fam, 'familias', f.familias) end,
        case when f.dept = 'Novos' then jsonb_build_object('item', 'Mix de planos (diversidade)', 'pontos', floor(f.p_pl + 0.5), 'maximo', f.w_pl, 'planos', f.planos_validos) end,
        jsonb_build_object('item', 'SPF EXTRA', 'pontos', floor(f.p_spf + 0.5), 'maximo', f.w_spf, 'spf_qtd', f.spf_qtd, 'financiados', f.fin),
        jsonb_build_object('item', 'Retorno médio', 'pontos', floor(f.p_ret + 0.5), 'maximo', f.w_ret, 'financiados', f.fin)
      ), '$[*] ? (@ != null)'))
    order by f.score desc, f.fin desc, f.seller, f.store), '[]'::jsonb)
  into v_rows
  from fim f;

  -- produção e % de retorno médio só para os perfis autorizados (mesma regra das demais funções)
  return public._operational_ocultar_retorno_vendedor(jsonb_build_object(
    'scope', v_base->'scope', 'period_start', p_start, 'period_end', p_end,
    'regra', 'calcScores (score.adapter.js) no servidor', 'retorno_em_degraus', v_degraus, 'rows', v_rows));
end;
$function$;

REVOKE ALL ON FUNCTION public._operational_score_coparticipated_data_core(date, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.operational_score_vendedores(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.operational_score_vendedores(date, date) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
commit;

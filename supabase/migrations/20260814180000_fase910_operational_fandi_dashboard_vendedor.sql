-- Fase 9.10 — libera Análise F&I do Grupo para VENDEDOR, com escopo
-- forçado no servidor (própria loja + próprio(s) departamento(s)).
--
-- Testado antes de promover: criada como função candidata separada
-- (operational_fandi_dashboard_candidate_v910), validada com sessões
-- reais impersonadas —
--   VENDEDOR: 42501 antes / sucesso escopado depois;
--   tentativa de outra loja: bloqueada (42501 "Loja fora do escopo.");
--   loja=TODAS: sucesso mas forçada à própria loja;
--   tentativa de outro departamento: bloqueada (42501 "Departamento
--     fora do escopo.");
--   departamento=TODOS: sucesso mas já restrito via v_departments;
--   MASTER/ANALISTA/GERENTE: saída byte-idêntica entre a função atual
--     e a candidata (comparação direta com "=" sobre o jsonb completo);
--   performance: sem regressão relevante (~7ms de diferença, dentro da
--     variação normal de uma única amostra).
-- Só depois de todos os testes passarem a candidata foi promovida
-- (CREATE OR REPLACE sobre a função real) e removida.
--
-- Única mudança de comportamento: 'VENDEDOR' adicionado à allowlist de
-- perfis. O forçamento de loja (bloco "MASTER and directors may choose
-- a store...") e a filtragem de departamento via v_departments já eram
-- genéricos — aplicam-se a qualquer perfil que não seja MASTER/DIRETOR,
-- então passaram a valer para VENDEDOR automaticamente, sem necessidade
-- de nenhuma lógica nova. Nenhuma outra linha do corpo da função foi
-- alterada. security definer, owner, search_path e grants (authenticated
-- + service_role EXECUTE, sem anon) preservados pelo CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.operational_fandi_dashboard(p_start date, p_end date, p_store text DEFAULT NULL::text, p_department text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_scope_store text;
  v_departments text[];
  v_store text;
  v_department text;
  v_batch_id uuid;
  v_result jsonb;
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
  v_scope_store := nullif(upper(trim(coalesce(v_scope->>'store', ''))), '');
  v_departments := array(
    select upper(jsonb_array_elements_text(v_scope->'departments'))
  );

  if v_profile not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR DE NOVOS',
    'DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR'
  ) then
    raise exception 'Perfil sem acesso à Análise F&I.' using errcode = '42501';
  end if;

  v_store := nullif(upper(trim(coalesce(p_store, ''))), '');
  if v_store in ('ALL', 'TODAS', 'TODOS') then v_store := null; end if;
  v_department := nullif(upper(trim(coalesce(p_department, ''))), '');
  if v_department in ('ALL', 'TODOS', 'TODAS') then v_department := null; end if;
  if v_department is not null and v_department not in ('NOVOS', 'SEMINOVOS') then
    raise exception 'Departamento inválido.' using errcode = '22023';
  end if;
  if v_department is not null and not (v_department = any(v_departments)) then
    raise exception 'Departamento fora do escopo.' using errcode = '42501';
  end if;

  -- MASTER and directors may choose a store. Store-scoped profiles cannot.
  if v_profile not like 'DIRETOR%' and v_profile <> 'MASTER' then
    if v_scope_store is null then
      raise exception 'Perfil sem loja autorizada.' using errcode = '42501';
    end if;
    if v_store is not null and v_store <> v_scope_store then
      raise exception 'Loja fora do escopo.' using errcode = '42501';
    end if;
    v_store := v_scope_store;
  end if;

  select b.id into v_batch_id
  from public.portal_import_batches b
  where b.source_type = 'SPF_CURRENT'
    and b.status = 'VALIDATED'
  order by b.completed_at desc nulls last, b.created_at desc, b.id desc
  limit 1;

  if v_batch_id is null then
    raise exception 'Nenhum lote SPF validado disponível.' using errcode = 'P0002';
  end if;

  with source_rows as (
    select
      s.source_row_number,
      s.operation_date,
      s.client_match_key,
      s.modality,
      coalesce(nullif(upper(trim(s.store)), ''), 'NÃO INFORMADO') as store,
      case
        when upper(coalesce(s.department, '')) like '%SEMINOV%' then 'SEMINOVOS'
        when upper(coalesce(s.department, '')) like '%NOVO%'
          or upper(coalesce(s.department, '')) like '%VENDA%DIRETA%' then 'NOVOS'
        else 'NÃO INFORMADO'
      end as department,
      nullif(upper(trim(coalesce(s.bank, ''))), '') as bank,
      case
        when upper(coalesce(s.status, '')) like '%AGUARD%FATU%'
          or upper(coalesce(s.status, '')) in ('AG FATURAMENTO', 'AG. FATURAMENTO')
          then 'AG. FATURAMENTO'
        when upper(coalesce(s.status, '')) like '%FATURAD%' then 'FATURADA'
        when upper(coalesce(s.status, '')) like '%PAGA%' then 'PAGA'
        when upper(coalesce(s.status, '')) like '%APROVAD%' then 'APROVADA'
        when upper(coalesce(s.status, '')) like '%ASSINAD%' then 'ASSINADA'
        when upper(coalesce(s.status, '')) like '%TRANSITO%' then 'TRANSITO'
        when upper(coalesce(s.status, '')) like '%ENC%A VISTA%' then 'ENC. A VISTA'
        when upper(coalesce(s.status, '')) like '%ENC%RECUS%' then 'ENC. RECUS.'
        when upper(coalesce(s.status, '')) like '%RECUS%' then 'RECUSADA'
        when upper(coalesce(s.status, '')) like '%ENCERRAD%' then 'ENCERRADA'
        when upper(coalesce(s.status, '')) like '%CANCELAD%' then 'CANCELADA'
        else nullif(upper(trim(coalesce(s.status, ''))), '')
      end as status,
      coalesce(s.financed_value, 0) as financed_value,
      s.installment_value,
      s.balloon_payment,
      s.balloon_value,
      s.finance_code,
      s.tc_returned,
      s.optional_name,
      coalesce(s.optional_value, 0) as optional_value,
      s.is_spf_extra,
      coalesce(
        nullif(trim(s.operation_code), ''),
        concat('CLIENT:', s.client_match_key, '|', coalesce(s.store, ''), '|',
          coalesce(s.operation_date::text, ''))
      ) as proposal_key
    from public.portal_spf_operations s
    where s.batch_id = v_batch_id
      and (s.operation_date is null or s.operation_date between p_start and p_end)
  ), visible_rows as (
    select * from source_rows r
    where r.department = any(v_departments)
      and (v_department is null or r.department = v_department)
      and (v_store is null or r.store = v_store)
  ), proposals as (
    select
      proposal_key,
      (array_agg(store order by source_row_number) filter (where store <> 'NÃO INFORMADO'))[1] as store,
      (array_agg(department order by source_row_number) filter (where department <> 'NÃO INFORMADO'))[1] as department,
      (array_agg(bank order by source_row_number) filter (where bank is not null))[1] as bank,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as status,
      max(financed_value) as financed_value,
      max(installment_value) as installment_value,
      max(balloon_payment) as balloon_payment,
      max(balloon_value) as balloon_value,
      bool_or(upper(coalesce(modality, '')) like '%FANDI%') as tem_fandi,
      case
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])999([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%SUBSIDIADO%') then 'SUBSIDIADO'
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])777([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%REVERS%') then 'REVERSÃO'
        when bool_or(coalesce(tc_returned, '') ~ '(^|[^0-9])1([^0-9]|$)'
          or upper(coalesce(tc_returned, '')) like '%COPARTICIPADO%') then 'COPARTICIPADO'
        when max(coalesce(balloon_payment, 0)) > 0
          or max(coalesce(balloon_value, 0)) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from visible_rows
    group by proposal_key
  ), operational as (
    select * from proposals
    where status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')
      and tem_fandi
  ), store_metrics as (
    select store,
      count(*)::integer as quantity,
      count(*) filter (where department = 'NOVOS')::integer as new_quantity,
      count(*) filter (where department = 'SEMINOVOS')::integer as used_quantity,
      coalesce(avg(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_financed,
      coalesce(avg(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_financed,
      coalesce(avg(installment_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_installment,
      coalesce(avg(installment_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_installment,
      count(*) filter (where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0)::integer as balloon_quantity,
      coalesce(avg(coalesce(balloon_payment, balloon_value)) filter (
        where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0
      ), 0)::numeric(18,2) as average_balloon,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed
    from operational group by store
  ), bank_metrics as (
    select bank,
      count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed,
      coalesce(avg(financed_value), 0)::numeric(18,2) as average_financed,
      coalesce(sum(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_financed,
      coalesce(sum(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_financed
    from operational where bank is not null group by bank
  ), status_store as (
    select store, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by store, status
  ), status_bank as (
    select bank, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational where bank is not null group by bank, status
  ), plan_metrics as (
    select plan_type, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by plan_type
  ), plan_store_department as (
    select store, department, plan_type, count(*)::integer as quantity
    from operational group by store, department, plan_type
  ), spf_unique as (
    select proposal_key, store, department, optional_value
    from visible_rows
    where is_spf_extra and optional_value > 0
    group by proposal_key, store, department, optional_value
  ), spf_metrics as (
    select store, department,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value,
      (coalesce(sum(optional_value), 0) * 0.70)::numeric(18,2) as spf_70_value
    from spf_unique group by store, department
  ), client_history as (
    select client_match_key,
      (array_agg(store order by source_row_number))[1] as store,
      (array_agg(department order by source_row_number))[1] as department,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as final_status,
      bool_or(status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')) as has_operational,
      max(financed_value) as financed_value
    from visible_rows
    where client_match_key is not null
    group by client_match_key
  ), proposal_outcomes as (
    select store, department,
      case
        when final_status in ('RECUSADA', 'ENC. RECUS.') then 'RECUSADA'
        when final_status in ('APROVADA', 'ENCERRADA', 'CANCELADA', 'ASSINADA', 'TRANSITO', 'ENC. A VISTA')
          and not has_operational then 'APROVADA'
        else null
      end as outcome,
      financed_value
    from client_history
  )
  select jsonb_build_object(
    'scope', v_scope,
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'filters', jsonb_build_object('store', v_store, 'department', v_department),
    'source', jsonb_build_object('latest_validated_batch', v_batch_id),
    'summary', jsonb_build_object(
      'operational_quantity', (select count(*) from operational),
      'total_financed', (select coalesce(sum(financed_value), 0) from operational)
    ),
    'stores', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from store_metrics x), '[]'::jsonb),
    'banks', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from bank_metrics x), '[]'::jsonb),
    'status_by_store', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.status) from status_store x), '[]'::jsonb),
    'status_by_bank', coalesce((select jsonb_agg(to_jsonb(x) order by x.bank, x.status) from status_bank x), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(x) order by x.plan_type) from plan_metrics x), '[]'::jsonb),
    'plans_by_store_department', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.plan_type) from plan_store_department x), '[]'::jsonb),
    'spf_extra', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department) from spf_metrics x), '[]'::jsonb),
    'proposal_outcomes', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.outcome)
      from (
        select store, department, outcome, count(*)::integer as quantity,
          coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
        from proposal_outcomes where outcome is not null
        group by store, department, outcome
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

-- Desfaz 20261028120000_loja_canonica_importacao_vendas.sql (volta as 4 linhas, a função de importação anterior, idêntica, e remove o mapa).
begin;
set local statement_timeout = '60s';
update public.portal_sales s set store = 'NACOES UNIDAS'
where s.batch_id = '63caf16b-c47d-40e7-a3eb-718aa92dcec3' and s.id in (160123, 160180, 160924, 160872) and s.store = 'NACOES';

CREATE OR REPLACE FUNCTION public.master_operational_import_sales(p_batch_id uuid, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_count integer;
  v_source_type text;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception 'Lote deve ser um array de até 500 linhas.'
      using errcode = '22023';
  end if;
  select b.source_type into v_source_type
  from public.portal_import_batches b
  where b.id = p_batch_id
    and b.imported_by = auth.uid()
    and b.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    and b.status = 'VALIDATING';
  if v_source_type is null then
    raise exception 'Lote de vendas inválido.' using errcode = '42501';
  end if;

  drop table if exists tmp_reconciliacao_vendedor_sales;

  create temp table tmp_reconciliacao_vendedor_sales on commit drop as
  with incoming as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      source_row_number integer,
      sale_date date,
      chassis text,
      chassis_short text,
      seller_cpf text,
      seller_source_name text,
      seller_nbs text,
      store text,
      sale_value numeric,
      department text,
      source_kind text,
      source_transaction text,
      vehicle_model text,
      client_document_normalized text
    )
  ),
  prepared as (
    select
      x.*,
      regexp_replace(coalesce(x.seller_cpf, ''), '\D', '', 'g') as cpf_norm,
      nullif(public.portal_normaliza_nbs(x.seller_nbs), 'NBS') as nbs_norm
    from incoming x
    where x.source_row_number > 0
      and x.sale_date is not null
      and trim(coalesce(x.chassis, '')) <> ''
      and upper(x.department) in ('NOVOS', 'SEMINOVOS')
      and upper(x.source_kind) in ('CURRENT', 'HISTORY')
  ),
  resolved as (
    select
      p.*,
      s.id as resolved_seller_id,
      (p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000') as cpf_valido,
      (
        case when (
          select count(*) from public.usuarios u
          where u.cpf_normalizado = p.cpf_norm and u.ativo = true
            and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        ) = 1 then (
          select u.id from public.usuarios u
          where u.cpf_normalizado = p.cpf_norm and u.ativo = true
            and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        ) end
      ) as user_cpf_active,
      (
        select count(*) from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = true
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
      ) as user_cpf_active_count,
      (
        select u.id from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = false
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        limit 1
      ) as user_cpf_inactive,
      (
        select u.id from public.usuarios u
        where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active_count
    from prepared p
    left join public.portal_sellers s
      on s.cpf_normalizado = p.cpf_norm and p.cpf_norm ~ '^[0-9]{11}$'
  ),
  classified as (
    select
      r.*,
      case
        when r.user_cpf_active_count > 1 then 'IDENTIFICADOR_DUPLICADO'
        when r.user_cpf_active is not null and r.user_nbs_active is not null
             and r.user_cpf_active <> r.user_nbs_active then 'CONFLITO'
        when r.user_cpf_active is not null then 'CPF_MATCH'
        when r.user_cpf_inactive is not null then 'CPF_INATIVO'
        when r.user_nbs_active is not null and r.user_nbs_active_count = 1 then 'NBS_FALLBACK'
        when r.nbs_norm is null and not r.cpf_valido then 'SEM_IDENTIFICADOR'
        else 'SEM_MATCH'
      end as classificacao
    from resolved r
  ),
  previous_resolution as (
    select distinct on (s.chassis)
      s.chassis, s.seller_user_id as prev_seller_user_id,
      s.seller_cpf_normalizado as prev_seller_cpf_normalizado,
      s.seller_nbs as prev_seller_nbs
    from public.portal_sales s
    join public.portal_import_batches b on b.id = s.batch_id
    where b.status = 'VALIDATED'
      and b.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
      and s.seller_user_id is not null
      -- Fase 1 (19/10/2026): só os chassis desta parte — o resultado do join abaixo é o mesmo, sem ler o histórico inteiro.
      and s.chassis in (select upper(regexp_replace(p.chassis, '[^A-Za-z0-9]', '', 'g')) from prepared p)
    order by s.chassis, b.completed_at desc nulls last, b.created_at desc, s.id desc
  )
  select
    c.*,
    coalesce(
      case c.classificacao
        when 'CPF_MATCH' then c.user_cpf_active
        when 'NBS_FALLBACK' then c.user_nbs_active
        else null
      end,
      case
        when c.classificacao not in ('IDENTIFICADOR_DUPLICADO', 'CONFLITO')
          and not (
            (c.cpf_valido and pr.prev_seller_cpf_normalizado is not null
              and c.cpf_norm <> pr.prev_seller_cpf_normalizado)
            or
            (c.nbs_norm is not null and pr.prev_seller_nbs is not null
              and c.nbs_norm <> pr.prev_seller_nbs)
          )
          then pr.prev_seller_user_id
        else null
      end
    )::uuid as seller_user_id_final,
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor,
    case when c.cpf_valido then c.cpf_norm else pr.prev_seller_cpf_normalizado end as seller_cpf_final
  from classified c
  left join previous_resolution pr
    on pr.chassis = upper(regexp_replace(c.chassis, '[^A-Za-z0-9]', '', 'g'));

  with upserted as (
    insert into public.portal_sales (
      batch_id, source_row_number, sale_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_cpf_normalizado, seller_source_name, seller_nbs, store, sale_value,
      department, source_kind, source_transaction, vehicle_model,
      client_document_match_key
    )
    select
      p_batch_id, source_row_number, sale_date,
      upper(regexp_replace(chassis, '[^A-Za-z0-9]', '', 'g')),
      nullif(upper(trim(coalesce(chassis_short, ''))), ''),
      resolved_seller_id,
      seller_user_id_final,
      seller_cpf_final,
      nullif(trim(coalesce(seller_source_name, '')), ''),
      nullif(upper(trim(coalesce(seller_nbs, ''))), ''),
      nullif(upper(trim(coalesce(store, ''))), ''),
      coalesce(sale_value, 0),
      upper(department), upper(source_kind),
      nullif(upper(trim(coalesce(source_transaction, ''))), ''),
      nullif(upper(trim(coalesce(vehicle_model, ''))), ''),
      public.portal_document_match_key(client_document_normalized)
    from tmp_reconciliacao_vendedor_sales
    on conflict (batch_id, source_row_number) do update
    set
      sale_date = excluded.sale_date,
      chassis = excluded.chassis,
      chassis_short = excluded.chassis_short,
      seller_id = excluded.seller_id,
      seller_user_id = excluded.seller_user_id,
      seller_cpf_normalizado = excluded.seller_cpf_normalizado,
      seller_source_name = excluded.seller_source_name,
      seller_nbs = excluded.seller_nbs,
      store = excluded.store,
      sale_value = excluded.sale_value,
      department = excluded.department,
      source_kind = excluded.source_kind,
      source_transaction = excluded.source_transaction,
      vehicle_model = excluded.vehicle_model,
      client_document_match_key = excluded.client_document_match_key
    returning 1
  )
  select count(*) into v_count from upserted;

  perform public.registrar_alertas_reconciliacao_lote(
    p_batch_id, v_source_type,
    (
      select jsonb_agg(jsonb_build_object(
        'identificador_tipo', f.identificador_alerta_tipo,
        'identificador_valor', f.identificador_alerta_valor,
        'nome_encontrado', f.seller_source_name,
        'login_nbs_encontrado', f.seller_nbs,
        'loja_encontrada', f.store,
        'departamento_encontrado', f.department,
        'tipo', case f.classificacao
          when 'IDENTIFICADOR_DUPLICADO' then 'IDENTIFICADOR_DUPLICADO'
          when 'CONFLITO' then 'CORRESPONDENCIA_INDETERMINADA'
          when 'CPF_INATIVO' then 'USUARIO_INATIVO_COM_PRODUCAO'
          when 'SEM_MATCH' then 'NOVO_CADASTRO_NECESSARIO'
        end,
        'severidade', case when upper(f.source_kind) = 'CURRENT' then 'URGENTE' else 'NORMAL' end
      ))
      from tmp_reconciliacao_vendedor_sales f
      where f.classificacao in ('IDENTIFICADOR_DUPLICADO', 'CONFLITO', 'CPF_INATIVO', 'SEM_MATCH')
    )
  );

  return v_count;
end;
$function$
;

drop function if exists public.portal_canoniza_loja(text);
commit;

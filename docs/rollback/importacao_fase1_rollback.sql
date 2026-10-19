-- Desfaz a FASE 1: volta as 3 funções às definições de 19/10/2026 (antes da Fase 1) e remove índices e coluna.

CREATE OR REPLACE FUNCTION public.master_operational_import_finance(p_batch_id uuid, p_rows jsonb)
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
    and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    and b.status = 'VALIDATING';
  if v_source_type is null then
    raise exception 'Lote financeiro inválido.' using errcode = '42501';
  end if;

  drop table if exists tmp_reconciliacao_vendedor_finance;

  create temp table tmp_reconciliacao_vendedor_finance on commit drop as
  with incoming as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      source_row_number integer,
      operation_date date,
      chassis text,
      chassis_short text,
      seller_cpf text,
      seller_source_name text,
      seller_nbs text,
      store text,
      service_description text,
      is_real_financing boolean,
      is_later_return boolean,
      is_spf boolean,
      return_value numeric,
      financed_or_service_value numeric,
      client_match_key text,
      source_kind text,
      finance_code text
    )
  ),
  prepared as (
    select
      x.*,
      regexp_replace(coalesce(x.seller_cpf, ''), '\D', '', 'g') as cpf_norm,
      nullif(public.portal_normaliza_nbs(x.seller_nbs), 'NBS') as nbs_norm
    from incoming x
    where x.source_row_number > 0
      and x.operation_date is not null
      and (
        trim(coalesce(x.chassis, '')) <> ''
        or coalesce(x.is_later_return, false)
      )
      and upper(x.source_kind) in ('CURRENT', 'HISTORY')
  ),
  resolved as (
    select
      p.*,
      s.id as resolved_seller_id,
      (p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000') as cpf_valido,
      -- Incidente Integridade-Cadastral-2.0: mesmo raciocinio do Sales --
      -- dois usuarios ATIVOS podem compartilhar cpf_normalizado (UNIQUE so
      -- existe sobre CPF bruto). So materializa o id quando a contagem e
      -- exatamente 1; nunca usa LIMIT/ORDER BY para escolher entre usuarios
      -- ambiguos. Ambiguidade vira NULL aqui, e a classificacao (via
      -- user_cpf_active_count > 1) continua marcando IDENTIFICADOR_DUPLICADO.
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
        where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null
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
  -- Incidente Identidade-Operacional-2.1, Patch Finance: mesma classe
  -- estrutural do Patch A de Sales, adaptada ao contrato proprio de
  -- Finance. Diferenca central: em Finance um UNICO chassi pode ter varios
  -- fatos financeiros distintos e legitimos (financiamento + blindagem +
  -- emplacamento + SPF extra etc.), entao chassi sozinho NAO identifica "o
  -- mesmo fato" (ate 5 linhas por chassi observadas em producao). A chave
  -- (chassis, service_description) e a mais granular disponivel nas
  -- colunas hoje persistidas e chega a 99,8% de unicidade real na base
  -- (3672 de 3678 linhas do lote mais recente) -- nao inclui operation_date
  -- de proposito: uma correcao legitima de data entre lotes nao pode por
  -- si so quebrar o vinculo com o fato anterior. Nunca tenta herdar quando
  -- chassis esta vazio (linhas is_later_return sem chassi): sem essa
  -- guarda, duas linhas distintas com chassis nulo poderiam colidir e
  -- fabricar um vinculo que nunca existiu (Parte 6 -- nao fabricar match).
  --
  -- Incidente REVENDA2/Patch-C (Fase 3): mesma extensao de Sales -- carrega
  -- tambem os identificadores PROPRIOS (CPF/NBS) da linha prévia que
  -- originou prev_seller_user_id, para a checagem de consistencia abaixo.
  previous_resolution as (
    select distinct on (f.chassis, f.service_description)
      f.chassis, f.service_description, f.seller_user_id as prev_seller_user_id,
      f.seller_cpf_normalizado as prev_seller_cpf_normalizado,
      f.seller_nbs as prev_seller_nbs
    from public.portal_finance_operations f
    join public.portal_import_batches b on b.id = f.batch_id
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
      and f.seller_user_id is not null
      and f.chassis is not null
    order by f.chassis, f.service_description, b.completed_at desc nulls last, b.created_at desc, f.id desc
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
          -- Incidente REVENDA2/Patch-C: mesma checagem de consistencia de
          -- Sales -- so herda quando a linha atual nao tem identificador
          -- proprio (CPF valido ou NBS) que divirja do identificador
          -- proprio da resolucao anterior para o mesmo (chassis,
          -- service_description).
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
    case when c.cpf_valido then c.cpf_norm else null end as seller_cpf_final
  from classified c
  left join previous_resolution pr
    on trim(coalesce(c.chassis, '')) <> ''
   and pr.chassis = upper(regexp_replace(c.chassis, '[^A-Za-z0-9]', '', 'g'))
   and pr.service_description = nullif(trim(coalesce(c.service_description, '')), '');

  with upserted as (
    insert into public.portal_finance_operations (
      batch_id, source_row_number, operation_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_cpf_normalizado, seller_source_name, seller_nbs, store,
      service_description, is_real_financing, is_later_return, is_spf,
      return_value, financed_or_service_value, client_match_key, source_kind,
      finance_code
    )
    select
      p_batch_id, source_row_number, operation_date,
      nullif(upper(regexp_replace(coalesce(chassis, ''), '[^A-Za-z0-9]', '', 'g')), ''),
      nullif(upper(trim(coalesce(chassis_short, ''))), ''),
      resolved_seller_id,
      seller_user_id_final,
      seller_cpf_final,
      nullif(trim(coalesce(seller_source_name, '')), ''),
      nullif(upper(trim(coalesce(seller_nbs, ''))), ''),
      nullif(upper(trim(coalesce(store, ''))), ''),
      nullif(trim(coalesce(service_description, '')), ''),
      coalesce(is_real_financing, false),
      coalesce(is_later_return, false),
      coalesce(is_spf, false),
      coalesce(return_value, 0),
      coalesce(financed_or_service_value, 0),
      nullif(upper(trim(coalesce(client_match_key, ''))), ''),
      upper(source_kind),
      nullif(upper(trim(coalesce(finance_code, ''))), '')
    from tmp_reconciliacao_vendedor_finance
    on conflict (batch_id, source_row_number) do update
    set
      operation_date = excluded.operation_date,
      chassis = excluded.chassis,
      chassis_short = excluded.chassis_short,
      seller_id = excluded.seller_id,
      seller_user_id = excluded.seller_user_id,
      seller_cpf_normalizado = excluded.seller_cpf_normalizado,
      seller_source_name = excluded.seller_source_name,
      seller_nbs = excluded.seller_nbs,
      store = excluded.store,
      service_description = excluded.service_description,
      is_real_financing = excluded.is_real_financing,
      is_later_return = excluded.is_later_return,
      is_spf = excluded.is_spf,
      return_value = excluded.return_value,
      financed_or_service_value = excluded.financed_or_service_value,
      client_match_key = excluded.client_match_key,
      source_kind = excluded.source_kind,
      finance_code = excluded.finance_code
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
        'departamento_encontrado', null,
        'tipo', case f.classificacao
          when 'IDENTIFICADOR_DUPLICADO' then 'IDENTIFICADOR_DUPLICADO'
          when 'CONFLITO' then 'CORRESPONDENCIA_INDETERMINADA'
          when 'CPF_INATIVO' then 'USUARIO_INATIVO_COM_PRODUCAO'
          when 'SEM_MATCH' then 'NOVO_CADASTRO_NECESSARIO'
        end,
        'severidade', case when upper(f.source_kind) = 'HISTORY' then 'INFORMATIVO' else 'URGENTE' end,
        'usuario_candidato_id', coalesce(f.user_cpf_active, f.user_cpf_inactive, f.user_nbs_active)
      ))
      from tmp_reconciliacao_vendedor_finance f
      where f.classificacao in ('IDENTIFICADOR_DUPLICADO', 'CONFLITO', 'CPF_INATIVO', 'SEM_MATCH')
        and f.identificador_alerta_valor is not null
    )
  );

  perform public.registrar_alertas_reconciliacao_lote(
    p_batch_id, v_source_type,
    (
      select jsonb_agg(jsonb_build_object(
        'identificador_tipo', 'CPF',
        'identificador_valor', f.cpf_norm,
        'nome_encontrado', f.seller_source_name,
        'login_nbs_encontrado', f.seller_nbs,
        'loja_encontrada', f.store,
        'departamento_encontrado', null,
        -- Incidente 22.5D: login_nbs NULL e login_nbs divergente sao a MESMA
        -- causa (Login NBS do cadastro nao bate com o encontrado na base) --
        -- classificar diferente so por causa de NULL fragmentava o mesmo
        -- problema em dois tipos, um deles (ATUALIZACAO_CADASTRAL_NECESSARIA)
        -- generico demais pra oferecer correcao assistida.
        'tipo', 'NBS_DIVERGENTE',
        'severidade', 'ATENCAO',
        'usuario_candidato_id', f.user_cpf_active
      ))
      from tmp_reconciliacao_vendedor_finance f
      join public.usuarios u on u.id = f.user_cpf_active
      where f.classificacao = 'CPF_MATCH'
        and f.nbs_norm is not null
        and coalesce(public.portal_normaliza_nbs(u.login_nbs), '') <> f.nbs_norm
    )
  );

  perform public.registrar_alerta_sem_identificador_lote(
    p_batch_id, v_source_type,
    (select count(*)::integer from tmp_reconciliacao_vendedor_finance where classificacao = 'SEM_IDENTIFICADOR')
  );

  drop table if exists tmp_reconciliacao_vendedor_finance;

  return v_count;
end;
$function$;

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
        where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true
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
$function$;

CREATE OR REPLACE FUNCTION public.portal_fechar_alertas_cadastro_resolvidos()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_n integer;
begin
  -- Fecha pendências que deixaram de ser verdade porque o cadastro passou a bater (13/10/2026).
  -- Só fecha quando há EXATAMENTE um usuário ativo correspondente (nunca "adivinha" entre vários).
  with alvo as (
    select a.id from public.portal_cadastro_alertas a
    where a.status = 'PENDENTE'
      and (
        (a.tipo in ('NOVO_CADASTRO_NECESSARIO', 'USUARIO_INATIVO_COM_PRODUCAO') and a.identificador_tipo = 'NBS'
          and (select count(*) from public.usuarios u where u.ativo and public.portal_normaliza_nbs(u.login_nbs) = public.portal_normaliza_nbs(a.identificador_valor)) = 1)
        or
        (a.tipo in ('NOVO_CADASTRO_NECESSARIO', 'USUARIO_INATIVO_COM_PRODUCAO') and a.identificador_tipo = 'CPF'
          and (select count(*) from public.usuarios u where u.ativo and u.cpf_normalizado = a.identificador_valor) = 1)
        or
        (a.tipo = 'NBS_DIVERGENTE'
          and exists (select 1 from public.usuarios u where u.id = a.usuario_candidato_id and u.ativo
                      and public.portal_normaliza_nbs(u.login_nbs) = public.portal_normaliza_nbs(a.login_nbs_encontrado)))
      )
  )
  update public.portal_cadastro_alertas a
     set status = 'RESOLVIDO', resolvido_em = now(), resolvido_por = null, atualizado_em = now(),
         motivo_acao = 'Encerrada automaticamente: o cadastro passou a corresponder.'
    from alvo where a.id = alvo.id;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_em)
    values ('CADASTRO_ALERTA_AUTO', format('%s pendência(s) cadastral(is) encerrada(s) automaticamente: o cadastro passou a corresponder.', v_n),
            'portal_fechar_alertas_cadastro_resolvidos', true, now());
  end if;
  return v_n;
end;
$function$;

drop index if exists public.idx_finance_ops_heranca_chassi_servico;
drop index if exists public.idx_usuarios_login_nbs_normalizado_ativo;
alter table public.usuarios drop column if exists login_nbs_normalizado;

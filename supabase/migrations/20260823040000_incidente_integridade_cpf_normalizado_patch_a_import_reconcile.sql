-- Incidente: Integridade Cadastral 2.0 -- CPF normalizado duplicado (Patch A)
-- Vulnerabilidade estrutural pre-existente comprovada via fixture sintetica
-- em transacao ROLLBACK (nunca observada em dados reais atuais -- 0
-- usuarios.cpf_normalizado duplicados na base hoje): como usuarios.cpf so
-- tem UNIQUE sobre o texto BRUTO (nao sobre a forma normalizada), dois
-- usuarios ATIVOS podem coexistir com CPFs formatados diferente
-- ("123.456.789-00" vs "12345678900") que normalizam para o MESMO valor.
--
-- Quando isso acontece, master_operational_import_sales e
-- master_operational_import_finance derrubavam o importador inteiro com
-- "more than one row returned by a subquery used as an expression" -- a
-- subquery escalar user_cpf_active nao tinha protecao contra cardinalidade
-- >1, mesmo a classificacao logo abaixo (IDENTIFICADOR_DUPLICADO) ja tendo
-- sido desenhada para esse caso: o crash acontecia ANTES da classificacao
-- rodar. portal_reconcile_user_facts_core, por sua vez, nao crashava, mas
-- vinculava fatos ao usuario que chamasse a reconciliacao primeiro, sem
-- nunca detectar que o mesmo CPF tambem pertencia a outro usuario ativo
-- (escolha arbitraria e silenciosa, comprovada em fixture).
--
-- Este patch elimina os dois problemas SEM usar LIMIT/ORDER BY para
-- escolher entre usuarios ambiguos (isso mascararia corrupcao cadastral):
--   - Sales/Finance: so materializa o id do vendedor quando ha exatamente
--     1 usuario ativo com aquele CPF normalizado; ambiguidade vira NULL e
--     continua caindo em IDENTIFICADOR_DUPLICADO (alerta ja existente,
--     reutilizado sem alteracao de contrato).
--   - Reconcile: pula o vinculo por CPF quando o CPF normalizado pertence
--     a mais de um usuario ativo (o fallback por NBS, chave diferente,
--     continua funcionando); sinaliza isso no retorno (cpf_ambiguo).
--
-- Nao altera login_nbs reconciliation, previous_resolution (Patch A/B de
-- Identidade Operacional 2.0/2.1), grants ou search_path de nenhuma
-- funcao. Prevencao estrutural de NOVAS duplicidades fica no Patch B
-- (indice UNIQUE), separado.

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
      vehicle_model text
    )
  ),
  prepared as (
    select
      x.*,
      regexp_replace(coalesce(x.seller_cpf, ''), '\D', '', 'g') as cpf_norm,
      nullif(nullif(upper(trim(coalesce(x.seller_nbs, ''))), ''), 'NBS') as nbs_norm
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
      -- Incidente Integridade-Cadastral-2.0: dois usuarios ATIVOS podem
      -- compartilhar o mesmo cpf_normalizado (nao ha UNIQUE sobre a forma
      -- normalizada, so sobre o CPF bruto -- "123.456.789-00" e
      -- "12345678900" coexistem hoje). A subquery escalar abaixo derrubava
      -- o importador inteiro com "more than one row returned by a subquery
      -- used as an expression" nesse caso, mesmo a classificacao logo
      -- abaixo ja tendo sido desenhada para tratar isso como
      -- IDENTIFICADOR_DUPLICADO -- o crash acontecia ANTES da classificacao
      -- rodar. So materializa o id quando a contagem e exatamente 1; nunca
      -- usa LIMIT/ORDER BY para "escolher" entre usuarios ambiguos (isso
      -- mascararia corrupcao cadastral) -- ambiguidade vira NULL aqui, e a
      -- classificacao (via user_cpf_active_count > 1) continua marcando
      -- IDENTIFICADOR_DUPLICADO normalmente.
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
        where upper(trim(u.login_nbs)) = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where upper(trim(u.login_nbs)) = p.nbs_norm and u.ativo = true
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
  -- Incidente Identidade-Operacional-2.0, Patch A: quando a resolucao
  -- DESTA importacao nao encontra identidade ativa (SEM_MATCH/SEM_
  -- IDENTIFICADOR/CPF_INATIVO), procura a ultima resolucao ja validada
  -- para o MESMO chassi (qualquer lote SALES_CURRENT/SALES_HISTORY
  -- VALIDATED anterior) e a preserva -- nunca regride um vinculo
  -- inequivocamente resolvido para NULL so porque a nova importacao nao
  -- trouxe dado suficiente. NUNCA herda quando a classificacao desta
  -- importacao e IDENTIFICADOR_DUPLICADO ou CONFLITO -- esses sao sinais
  -- POSITIVOS de ambiguidade na informacao atual, nao ausencia de
  -- informacao, e nunca devem ser mascarados por um valor antigo (Parte
  -- E/F/G). Uma resolucao CPF_MATCH/NBS_FALLBACK desta importacao SEMPRE
  -- vence a herdada, mesmo quando aponta para um vendedor diferente
  -- (Parte J -- mudanca real de vendedor nunca fica presa no antigo).
  previous_resolution as (
    select distinct on (s.chassis)
      s.chassis, s.seller_user_id as prev_seller_user_id
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
          then pr.prev_seller_user_id
        else null
      end
    )::uuid as seller_user_id_final,
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor,
    -- Fase 21.6B (Parte H) -- CPF normalizado persistido SEMPRE que valido,
    -- mesmo quando o fato nao resolve para ninguem agora -- e o que
    -- viabiliza a reconciliacao automatica quando o vendedor for
    -- cadastrado depois (Parte O).
    case when c.cpf_valido then c.cpf_norm else null end as seller_cpf_final
  from classified c
  left join previous_resolution pr
    on pr.chassis = upper(regexp_replace(c.chassis, '[^A-Za-z0-9]', '', 'g'));

  with upserted as (
    insert into public.portal_sales (
      batch_id, source_row_number, sale_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_cpf_normalizado, seller_source_name, seller_nbs, store, sale_value,
      department, source_kind, source_transaction, vehicle_model
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
      nullif(upper(trim(coalesce(vehicle_model, ''))), '')
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
      vehicle_model = excluded.vehicle_model
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
        'severidade', case when upper(f.source_kind) = 'HISTORY' then 'INFORMATIVO' else 'URGENTE' end,
        'usuario_candidato_id', coalesce(f.user_cpf_active, f.user_cpf_inactive, f.user_nbs_active)
      ))
      from tmp_reconciliacao_vendedor_sales f
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
        'departamento_encontrado', f.department,
        -- Incidente 22.5D: login_nbs NULL e login_nbs divergente sao a MESMA
        -- causa (Login NBS do cadastro nao bate com o encontrado na base) --
        -- classificar diferente so por causa de NULL fragmentava o mesmo
        -- problema em dois tipos, um deles (ATUALIZACAO_CADASTRAL_NECESSARIA)
        -- generico demais pra oferecer correcao assistida.
        'tipo', 'NBS_DIVERGENTE',
        'severidade', 'ATENCAO',
        'usuario_candidato_id', f.user_cpf_active
      ))
      from tmp_reconciliacao_vendedor_sales f
      join public.usuarios u on u.id = f.user_cpf_active
      where f.classificacao = 'CPF_MATCH'
        and f.nbs_norm is not null
        and upper(trim(coalesce(u.login_nbs, ''))) <> f.nbs_norm
    )
  );

  perform public.registrar_alerta_sem_identificador_lote(
    p_batch_id, v_source_type,
    (select count(*)::integer from tmp_reconciliacao_vendedor_sales where classificacao = 'SEM_IDENTIFICADOR')
  );

  drop table if exists tmp_reconciliacao_vendedor_sales;

  return v_count;
end;
$function$
;

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
      nullif(nullif(upper(trim(coalesce(x.seller_nbs, ''))), ''), 'NBS') as nbs_norm
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
        where upper(trim(u.login_nbs)) = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where upper(trim(u.login_nbs)) = p.nbs_norm and u.ativo = true
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
  previous_resolution as (
    select distinct on (f.chassis, f.service_description)
      f.chassis, f.service_description, f.seller_user_id as prev_seller_user_id
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
        and upper(trim(coalesce(u.login_nbs, ''))) <> f.nbs_norm
    )
  );

  perform public.registrar_alerta_sem_identificador_lote(
    p_batch_id, v_source_type,
    (select count(*)::integer from tmp_reconciliacao_vendedor_finance where classificacao = 'SEM_IDENTIFICADOR')
  );

  drop table if exists tmp_reconciliacao_vendedor_finance;

  return v_count;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.portal_reconcile_user_facts_core(p_usuario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_usuario public.usuarios%rowtype;
  v_cpf text;
  v_nbs text;
  v_cpf_ambiguo boolean := false;
  v_sales_cpf integer := 0;
  v_finance_cpf integer := 0;
  v_sales_nbs integer := 0;
  v_finance_nbs integer := 0;
  v_actor_nome text;
begin
  -- Rele tudo fresh do banco -- nunca confia em CPF/NBS passados por fora.
  select * into v_usuario from public.usuarios where id = p_usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  v_cpf := v_usuario.cpf_normalizado;
  v_nbs := nullif(upper(trim(coalesce(v_usuario.login_nbs, ''))), '');

  -- Incidente Integridade-Cadastral-2.0: dois usuarios ATIVOS podem
  -- compartilhar o mesmo cpf_normalizado (nao ha UNIQUE sobre a forma
  -- normalizada). Sem esta checagem, o vinculo por CPF abaixo e um UPDATE
  -- em massa por valor -- vincularia ao usuario que chamou a funcao
  -- primeiro, sem nunca detectar que o mesmo CPF tambem pertence a outro
  -- usuario ativo (escolha arbitraria, comprovada em fixture). Quando o
  -- CPF nao e inequivoco entre usuarios ativos, pula o vinculo por CPF
  -- para ESTE usuario -- o NBS fallback (chave diferente) continua
  -- funcionando normalmente.
  select count(*) > 1 into v_cpf_ambiguo
  from public.usuarios u
  where u.cpf_normalizado = v_cpf and u.ativo = true;

  if not v_cpf_ambiguo then
    with alvo as (
      select s.id from public.portal_sales s
      where s.seller_user_id is null
        and s.seller_cpf_normalizado = v_cpf
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'CPF' and e.identificador_valor = v_cpf
        )
    )
    update public.portal_sales s set seller_user_id = p_usuario_id
    from alvo where s.id = alvo.id;
    get diagnostics v_sales_cpf = row_count;

    with alvo as (
      select f.id from public.portal_finance_operations f
      where f.seller_user_id is null
        and f.seller_cpf_normalizado = v_cpf
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'CPF' and e.identificador_valor = v_cpf
        )
    )
    update public.portal_finance_operations f set seller_user_id = p_usuario_id
    from alvo where f.id = alvo.id;
    get diagnostics v_finance_cpf = row_count;
  end if;

  if v_nbs is not null then
    with alvo as (
      select s.id from public.portal_sales s
      where s.seller_user_id is null
        and s.seller_cpf_normalizado is null
        and upper(trim(coalesce(s.seller_nbs, ''))) = v_nbs
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'NBS' and e.identificador_valor = v_nbs
        )
    )
    update public.portal_sales s set seller_user_id = p_usuario_id
    from alvo where s.id = alvo.id;
    get diagnostics v_sales_nbs = row_count;

    with alvo as (
      select f.id from public.portal_finance_operations f
      where f.seller_user_id is null
        and f.seller_cpf_normalizado is null
        and upper(trim(coalesce(f.seller_nbs, ''))) = v_nbs
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'NBS' and e.identificador_valor = v_nbs
        )
    )
    update public.portal_finance_operations f set seller_user_id = p_usuario_id
    from alvo where f.id = alvo.id;
    get diagnostics v_finance_nbs = row_count;
  end if;

  update public.portal_cadastro_alertas a
  set status = 'RESOLVIDO', resolvido_por = v_usuario.id, resolvido_em = now(), atualizado_em = now(),
      motivo_acao = 'Reconciliado automaticamente após cadastro do usuário correspondente.'
  where a.status = 'PENDENTE'
    and (
      (a.identificador_tipo = 'CPF' and a.identificador_valor = v_cpf)
      or (v_nbs is not null and a.identificador_tipo = 'NBS' and a.identificador_valor = v_nbs)
    );

  if (v_sales_cpf + v_finance_cpf + v_sales_nbs + v_finance_nbs) > 0 then
    select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
    values (
      'FATOS_RECONCILIADOS_USUARIO',
      format('%s venda(s) e %s financiamento(s) vinculados a %s ao ser cadastrado (CPF: %s+%s, NBS fallback: %s+%s) — disparado por %s',
        v_sales_cpf, v_finance_cpf, v_usuario.nome, v_sales_cpf, v_finance_cpf, v_sales_nbs, v_finance_nbs,
        coalesce(v_actor_nome, '—')),
      'RPC portal_reconcile_user_facts_core', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'codigo', 'RECONCILIADO',
    'sales_cpf', v_sales_cpf, 'finance_cpf', v_finance_cpf,
    'sales_nbs', v_sales_nbs, 'finance_nbs', v_finance_nbs,
    'cpf_ambiguo', v_cpf_ambiguo
  );
end;
$function$
;

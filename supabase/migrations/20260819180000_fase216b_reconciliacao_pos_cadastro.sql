-- Fase 21.6B -- reconciliacao pos-cadastro: fecha o ciclo
-- FATO -> ALERTA -> CADASTRO -> RECONCILIACAO -> seller_user_id.
--
-- Causa raiz (Fase 21.6, Parte AE): o CPF do vendedor CHEGA aos
-- importadores (seller_cpf, ja usado para matching em tempo real), mas
-- ate agora era descartado quando nao havia match -- so seller_nbs/
-- seller_source_name ficavam persistidos no fato. Sem CPF persistido,
-- reconciliacao pos-cadastro so seria possivel via NBS (quando presente)
-- ou nome (proibido como autoridade, Parte AD).
--
-- Decisao de seguranca (Parte D/E): seller_cpf_normalizado text, texto
-- plano (nao hash) -- mesmo modelo de protecao ja usado em
-- usuarios.cpf/cpf_normalizado neste projeto inteiro: RLS + zero grant
-- direto a anon/authenticated (confirmado fresh nesta fase para
-- portal_sales/portal_finance_operations antes de alterar), acesso
-- exclusivamente via RPC. Hash determinístico nao adicionaria protecao
-- real (a coluna ja e inacessivel a qualquer role publica) e impediria
-- backfill/debug administrativo -- consistente com o padrao ja
-- estabelecido, nao um novo modelo.

-- =========================================================================
-- PARTE F/G -- schema: coluna nova (NULL permitido -- historico antigo
-- pode nao ter CPF recuperavel, Parte F) + indices parciais so para o
-- caminho que a reconciliacao realmente varre (fatos ainda sem
-- seller_user_id).
-- =========================================================================

alter table public.portal_sales
  add column if not exists seller_cpf_normalizado text;
alter table public.portal_finance_operations
  add column if not exists seller_cpf_normalizado text;

create index if not exists portal_sales_seller_cpf_pendente_idx
  on public.portal_sales (seller_cpf_normalizado)
  where seller_user_id is null and seller_cpf_normalizado is not null;
create index if not exists portal_finance_operations_seller_cpf_pendente_idx
  on public.portal_finance_operations (seller_cpf_normalizado)
  where seller_user_id is null and seller_cpf_normalizado is not null;

create index if not exists portal_sales_seller_nbs_pendente_idx
  on public.portal_sales (upper(seller_nbs))
  where seller_user_id is null and seller_cpf_normalizado is null and seller_nbs is not null;
create index if not exists portal_finance_operations_seller_nbs_pendente_idx
  on public.portal_finance_operations (upper(seller_nbs))
  where seller_user_id is null and seller_cpf_normalizado is null and seller_nbs is not null;

-- =========================================================================
-- PARTE K/L -- backfill histórico: SOMENTE determinístico via
-- seller_id -> portal_sellers.cpf_normalizado (nunca por nome, nunca
-- inferido). Fatos sem seller_id (so NBS ou sem identificador nenhum)
-- ficam NULL -- Parte M, nao inventar CPF.
-- =========================================================================

update public.portal_sales s
set seller_cpf_normalizado = ps.cpf_normalizado
from public.portal_sellers ps
where s.seller_id = ps.id
  and s.seller_cpf_normalizado is null
  and ps.cpf_normalizado is not null
  and ps.cpf_normalizado <> '';

update public.portal_finance_operations f
set seller_cpf_normalizado = ps.cpf_normalizado
from public.portal_sellers ps
where f.seller_id = ps.id
  and f.seller_cpf_normalizado is null
  and ps.cpf_normalizado is not null
  and ps.cpf_normalizado <> '';

-- =========================================================================
-- PARTE H -- master_operational_import_sales(): persiste o CPF
-- normalizado (ja computado no CTE existente como cpf_norm/cpf_valido
-- para matching -- so passa a gravar tambem). Mudanca minima: 1 coluna
-- nova no INSERT/SELECT/ON CONFLICT DO UPDATE; ZERO alteracao na
-- hierarquia de match (Parte J), zero alteracao na geracao de alertas.
-- =========================================================================

create or replace function public.master_operational_import_sales(p_batch_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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
      (
        select u.id from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = true
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
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
  )
  select
    c.*,
    case c.classificacao
      when 'CPF_MATCH' then c.user_cpf_active
      when 'NBS_FALLBACK' then c.user_nbs_active
      else null
    end::uuid as seller_user_id_final,
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor,
    -- Fase 21.6B (Parte H) -- CPF normalizado persistido SEMPRE que valido,
    -- mesmo quando o fato nao resolve para ninguem agora -- e o que
    -- viabiliza a reconciliacao automatica quando o vendedor for
    -- cadastrado depois (Parte O).
    case when c.cpf_valido then c.cpf_norm else null end as seller_cpf_final
  from classified c;

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
        'tipo', case
          when u.login_nbs is null then 'ATUALIZACAO_CADASTRAL_NECESSARIA'
          else 'NBS_DIVERGENTE'
        end,
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
$function$;

-- =========================================================================
-- PARTE I -- master_operational_import_finance(): mesma mudanca minima.
-- =========================================================================

create or replace function public.master_operational_import_finance(p_batch_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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
      (
        select u.id from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = true
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
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
  )
  select
    c.*,
    case c.classificacao
      when 'CPF_MATCH' then c.user_cpf_active
      when 'NBS_FALLBACK' then c.user_nbs_active
      else null
    end::uuid as seller_user_id_final,
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor,
    case when c.cpf_valido then c.cpf_norm else null end as seller_cpf_final
  from classified c;

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
        'tipo', case
          when u.login_nbs is null then 'ATUALIZACAO_CADASTRAL_NECESSARIA'
          else 'NBS_DIVERGENTE'
        end,
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
$function$;

-- =========================================================================
-- PARTE N/O/P/Q/R/S/V/W/X -- reconciliador. Chamada controlada (Parte AY),
-- nunca exposta diretamente a authenticated -- so service_role, alcancada
-- por chamada interna de RPCs ja MASTER-gated (SECURITY DEFINER preserva
-- o auth.uid() da sessao original em todo o call chain, entao o gate
-- is_master() interno continua correto mesmo chamado de dentro de outra
-- funcao). Idempotente (Parte AM): WHERE seller_user_id IS NULL garante
-- que nunca sobrescreve vinculo existente (Parte AO) e que rodar duas
-- vezes na pratica so afeta fatos ainda nao resolvidos na 2a chamada.
--
-- Decisao de escopo Parte R/AB: NAO exige usuarios.ativo=true. Identidade
-- do fato (quem fez a venda) e conceito distinto de autorizacao de acesso
-- (Parte AB, ja confirmado no propio prompt) -- um cadastro recem-criado
-- via master_convidar_usuario comeca ativo=false (Fase 21.6) e so ficaria
-- de fora se essa checagem existisse, contrariando a preferencia
-- explicita da Parte Z ("reconciliar assim que cadastro e criado, sem
-- depender de login"). Nunca roda como job/trigger de fundo -- so e
-- alcancada pela chamada explicita abaixo em master_convidar_usuario, que
-- ja e MASTER-gated e ja tinha o CPF/NBS unicos validados no mesmo
-- statement -- nunca varre a base inteira, nunca toca Herbert/Cristina/
-- Fabio (so reconcilia o usuario_id que acabou de ser criado).
-- =========================================================================

create or replace function public.portal_reconcile_user_facts(p_usuario_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_usuario public.usuarios%rowtype;
  v_cpf text;
  v_nbs text;
  v_sales_cpf integer := 0;
  v_finance_cpf integer := 0;
  v_sales_nbs integer := 0;
  v_finance_nbs integer := 0;
  v_actor_nome text;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  -- Rele tudo fresh do banco -- nunca confia em CPF/NBS passados por fora.
  select * into v_usuario from public.usuarios where id = p_usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  v_cpf := v_usuario.cpf_normalizado;
  v_nbs := nullif(upper(trim(coalesce(v_usuario.login_nbs, ''))), '');

  -- Parte O -- CPF e o identificador primario e deterministico. Nunca
  -- sobrescreve fato ja vinculado (Parte AO) nem fato coberto por
  -- excecao ativa do mesmo identificador (Parte S/V).
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

  -- Parte P/Q/AL -- NBS so como fallback: exige seller_cpf_normalizado
  -- NULO no fato (nunca contraria um CPF ja presente, mesmo que de outra
  -- pessoa) e excecao ativa do mesmo NBS bloqueia (Parte V).
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

  -- Parte W -- alertas PENDENTES cujo identificador bate deterministicamente
  -- com este cadastro viram RESOLVIDO. Nunca toca IGNORADO/EXCLUIDO (Parte
  -- T/U) -- o filtro so pega status='PENDENTE'.
  update public.portal_cadastro_alertas a
  set status = 'RESOLVIDO', resolvido_por = v_usuario.id, resolvido_em = now(), atualizado_em = now(),
      motivo_acao = 'Reconciliado automaticamente após cadastro do usuário correspondente.'
  where a.status = 'PENDENTE'
    and (
      (a.identificador_tipo = 'CPF' and a.identificador_valor = v_cpf)
      or (v_nbs is not null and a.identificador_tipo = 'NBS' and a.identificador_valor = v_nbs)
    );

  -- Parte X -- 1 evento agregado, nunca 1 por fato, nunca CPF completo.
  if (v_sales_cpf + v_finance_cpf + v_sales_nbs + v_finance_nbs) > 0 then
    select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
    values (
      'FATOS_RECONCILIADOS_USUARIO',
      format('%s venda(s) e %s financiamento(s) vinculados a %s ao ser cadastrado (CPF: %s+%s, NBS fallback: %s+%s) — disparado por %s',
        v_sales_cpf, v_finance_cpf, v_usuario.nome, v_sales_cpf, v_finance_cpf, v_sales_nbs, v_finance_nbs,
        coalesce(v_actor_nome, '—')),
      'RPC portal_reconcile_user_facts', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'codigo', 'RECONCILIADO',
    'sales_cpf', v_sales_cpf, 'finance_cpf', v_finance_cpf,
    'sales_nbs', v_sales_nbs, 'finance_nbs', v_finance_nbs
  );
end;
$function$;

revoke all on function public.portal_reconcile_user_facts(uuid) from public, anon, authenticated;
grant execute on function public.portal_reconcile_user_facts(uuid) to service_role;

-- =========================================================================
-- PARTE Y/Z -- integra ao unico fluxo oficial de cadastro
-- (master_convidar_usuario, ja MASTER-gated). Reconcilia assim que o
-- cadastro e criado, sem depender de ativacao/login (Parte Z/AA/AB).
-- Mudanca minima: 1 linha nova (perform ...) logo apos o enriquecimento
-- best-effort de portal_sellers da Fase 21.6; NENHUMA outra linha do
-- corpo da funcao alterada.
-- =========================================================================

create or replace function public.master_convidar_usuario(
  p_cpf text, p_nome text, p_perfil text, p_loja text, p_email text,
  p_nbs text default null::text, p_status text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_cpf text := public.normalizar_cpf(p_cpf);
  v_perfil text := upper(trim(coalesce(p_perfil, '')));
  v_loja text := nullif(upper(trim(coalesce(p_loja, ''))), '');
  v_email text := lower(trim(coalesce(p_email, '')));
  v_nome text := trim(coalesce(p_nome, ''));
  v_nbs text := nullif(upper(trim(coalesce(p_nbs, ''))), '');
  v_status text := nullif(upper(trim(coalesce(p_status, ''))), '');
  v_seller public.portal_sellers;
  v_usuario_id uuid;
  v_convite_id uuid;
  v_lojas_validas constant text[] := array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'];
  v_perfis_validos constant text[] := array['MASTER','DIRETOR NOVOS','DIRETOR SEMINOVOS','ANALISTA','GERENTE','VENDEDOR','RECURSOS HUMANOS','RH'];
  v_status_validos constant text[] := array['NOVOS','SEMINOVOS','NOVOS/SEMINOVOS'];
  v_perfis_status_obrigatorio constant text[] := array['VENDEDOR','GERENTE','ANALISTA'];
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil,''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if regexp_replace(coalesce(p_cpf,''), '[^0-9]', '', 'g') = '' or length(regexp_replace(coalesce(p_cpf,''), '[^0-9]', '', 'g')) > 11 then
    raise exception 'CPF inválido.' using errcode = '22023';
  end if;
  if v_nome = '' then
    raise exception 'Nome é obrigatório.' using errcode = '22023';
  end if;
  if v_perfil = '' or not (v_perfil = any(v_perfis_validos)) then
    raise exception 'Perfil inválido. Utilize um dos perfis já autorizados pelo sistema.' using errcode = '22023';
  end if;
  if v_loja is not null and not (v_loja = any(v_lojas_validas)) then
    raise exception 'Loja inválida. Utilize uma loja oficial cadastrada.' using errcode = '22023';
  end if;
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;
  if v_email like '%@portalfi.brabus' or v_email like '%@brabus-fi.local' then
    raise exception 'Use o e-mail real do colaborador — não um e-mail interno/fictício.' using errcode = '22023';
  end if;

  if v_perfil = any(v_perfis_status_obrigatorio) then
    if v_status is null or not (v_status = any(v_status_validos)) then
      raise exception 'Selecione o departamento (Novos, Seminovos ou Novos/Seminovos) para este perfil.' using errcode = '22023';
    end if;
  elsif v_perfil = 'DIRETOR NOVOS' then
    v_status := 'NOVOS';
  elsif v_perfil = 'DIRETOR SEMINOVOS' then
    v_status := 'SEMINOVOS';
  elsif v_perfil = 'MASTER' then
    v_status := 'MASTER';
  else
    v_status := null;
  end if;

  if exists (select 1 from public.usuarios where cpf_normalizado = v_cpf) then
    raise exception 'Já existe um usuário cadastrado com este CPF.' using errcode = '23505';
  end if;
  if exists (select 1 from public.usuarios where lower(coalesce(email_auth,'')) = v_email) then
    raise exception 'Já existe um usuário cadastrado com este e-mail.' using errcode = '23505';
  end if;

  if v_nbs is not null then
    if exists (
      select 1 from public.usuarios u2
      where upper(trim(coalesce(u2.login_nbs, ''))) = v_nbs and u2.ativo = true
    ) then
      raise exception 'Este login NBS já está em uso por outro usuário ativo.' using errcode = '23505';
    end if;
    select * into v_seller from public.portal_sellers where nbs = v_nbs and active limit 1;
    if v_seller.id is not null then
      if v_seller.portal_user_id is not null then
        raise exception 'Este login NBS já está vinculado a outro usuário do portal.' using errcode = '23505';
      end if;
      if v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_cpf then
        raise exception 'O CPF informado não corresponde ao cadastro deste login NBS.' using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.usuarios (cpf, nome, perfil, loja, status, email_auth, login_nbs, ativo, primeiro_acesso)
  values (p_cpf, v_nome, v_perfil, v_loja, v_status, v_email, v_nbs, false, true)
  returning id into v_usuario_id;

  if v_nbs is not null and v_seller.id is not null then
    update public.portal_sellers
       set portal_user_id = v_usuario_id, updated_at = now()
     where id = v_seller.id;
  end if;

  -- Fase 21.6B (Parte Y/Z) -- fecha o ciclo agora mesmo: qualquer fato ja
  -- importado com este CPF/NBS (SEM_MATCH anterior) e vinculado
  -- imediatamente, sem depender de ativacao/primeiro acesso.
  perform public.portal_reconcile_user_facts(v_usuario_id);

  insert into public.convites_usuario (usuario_id, cpf, nome, perfil, loja, email, nbs, status, convidado_por)
  values (v_usuario_id, v_cpf, v_nome, v_perfil, v_loja, v_email, v_nbs, 'PENDENTE', v_actor.id)
  returning id into v_convite_id;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('CONVITE_USUARIO',
    format('Convite criado por %s para %s (%s), perfil %s, departamento %s', v_actor.nome, v_nome, v_email, v_perfil, coalesce(v_status,'—')),
    'Painel Master', v_nome, v_cpf, v_loja, false);

  return jsonb_build_object('convite_id', v_convite_id, 'usuario_id', v_usuario_id, 'email', v_email, 'status', 'PENDENTE', 'departamento', v_status);
end;
$function$;

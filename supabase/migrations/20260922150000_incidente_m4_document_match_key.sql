-- Incidente T35918 / M4 -- identidade de cliente (chassi -> Base01 -> Base03)
-- substitui nome como autoridade de casamento para o enriquecimento
-- SUBSIDIADO/REVERSAO/COPARTICIPADO/BALAO de portal_finance_operations.
--
-- PROVA (waves anteriores, mesma cadeia de investigacao, ainda que nao
-- executadas contra este banco):
--   - T35918/SILVESTRE MARIANO DE SOUZA: Base01."Cód. Cliente" ==
--     Base03."Cli - CPF/CNPJ" == 74109570859 (match exato).
--   - Base02."Cód. Cliente" e uma coisa DIFERENTE (CNPJ da financeira/
--     agente, nao do cliente) -- nunca deve ser usado como identidade.
--   - Universo real (605 financiamentos reais canonicos, dados
--     correntes): 605/605 casam chassi->Base01; apos reparo de zero a
--     esquerda (artefato numerico do Excel), 605/605 tem documento
--     utilizavel; 582 casam unico com uma operacao PAGA/FATURADA em
--     Base03, 9 resolvem com alto grau de confianca (nao aplicado aqui
--     -- ver nota de escopo abaixo), 5 permanecem ambiguos, 9 nao
--     encontram operacao realizada nenhuma.
--
-- ESCOPO DESTA WAVE (P1 -- implementacao local, sem reimport real):
--   Autoridade automatica = APENAS operacao UNICA por documento entre as
--   operacoes PAGA/FATURADA. Multiplas operacoes realizadas para o mesmo
--   documento NUNCA sao resolvidas automaticamente aqui -- nem por
--   prioridade de plano, nem por ordem, nem pelo limiar de 2% de
--   proximidade de valor usado só para fins de auditoria na wave
--   anterior (esse limiar nunca foi aprovado como autoridade de
--   produto). Ficam de fora do enriquecimento automatico ate uma
--   decisao de produto explicita.
--
-- PRIVACIDADE: o CPF/CNPJ bruto (mesmo normalizado) NUNCA e persistido.
-- Só a chave de casamento HMAC-SHA256(segredo do Vault, documento
-- normalizado) e gravada -- deterministica (permite JOIN) mas nao
-- reversivel sem o segredo, que nunca sai do banco (nunca retornado a
-- nenhum papel que nao seja service_role).

-- =========================================================================
-- PARTE A -- extensoes (idempotente; pgcrypto e supabase_vault ja
-- confirmados habilitados neste projeto antes desta migration).
-- =========================================================================
create extension if not exists pgcrypto;

-- =========================================================================
-- PARTE B -- segredo HMAC no Vault (idempotente; gerado pelo proprio
-- Postgres via pgcrypto.gen_random_bytes -- nunca digitado/hardcoded por
-- um humano, nunca aparece em texto claro nesta migration nem em nenhum
-- log). Vault criptografa em repouso; só e legivel via
-- vault.decrypted_secrets, uma view que por sua vez só e alcançável por
-- papeis com privilegio equivalente a service_role -- nunca anon/
-- authenticated.
-- =========================================================================
do $$
begin
  if not exists (
    select 1 from vault.secrets where name = 'portal_document_match_hmac_key'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'portal_document_match_hmac_key',
      'Chave HMAC para a chave de casamento de documento de cliente (ponte M4 Base01<->Base03). Uso exclusivo de public.portal_document_match_key(), nunca exposta a nenhum papel de cliente.'
    );
  end if;
end $$;

-- =========================================================================
-- PARTE C -- coluna aditiva, nula, sem reescrita destrutiva. Só em
-- portal_sales (Base01) -- portal_finance_operations e
-- portal_spf_operations NAO recebem esta coluna nesta wave (evidencia
-- concreta de que só Base01 precisa dela: o documento e lido de
-- portal_sales.chassis -> portal_finance_operations.chassis, nunca
-- persistido em duplicidade).
-- =========================================================================
alter table public.portal_sales
  add column if not exists client_document_match_key text;

create index if not exists portal_sales_doc_match_key_idx
  on public.portal_sales (client_document_match_key)
  where client_document_match_key is not null;

-- =========================================================================
-- PARTE D -- primitiva server-side: documento normalizado (11 ou 14
-- digitos, nunca outro tamanho) -> chave deterministica. SECURITY
-- DEFINER para poder ler o Vault; revogada de public/anon/authenticated;
-- concedida apenas a service_role (ou seja, só alcançável de dentro de
-- outra função SECURITY DEFINER já MASTER-gated, nunca diretamente do
-- navegador). Nunca loga, nunca retorna o documento bruto, nunca inclui
-- o segredo no valor de retorno.
-- =========================================================================
create or replace function public.portal_document_match_key(p_normalized_document text)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'vault', 'extensions'
as $function$
declare
  v_secret text;
begin
  if p_normalized_document is null
     or length(trim(p_normalized_document)) not in (11, 14)
     or trim(p_normalized_document) !~ '^[0-9]+$' then
    return null;
  end if;

  select decrypted_secret into v_secret
    from vault.decrypted_secrets
   where name = 'portal_document_match_hmac_key'
   limit 1;

  if v_secret is null then
    raise exception 'Segredo de casamento de documento não configurado.' using errcode = 'XX000';
  end if;

  return encode(extensions.hmac(trim(p_normalized_document), v_secret, 'sha256'), 'hex');
end;
$function$;

revoke all on function public.portal_document_match_key(text) from public, anon, authenticated;
grant execute on function public.portal_document_match_key(text) to service_role;

-- =========================================================================
-- PARTE E -- master_operational_import_sales: adiciona
-- client_document_normalized ao payload aceito e persiste APENAS a chave
-- calculada (client_document_match_key) -- nunca o documento em si.
-- Único trecho alterado é o bloco "incoming"/INSERT; toda a logica de
-- resolucao de identidade do VENDEDOR (CPF/NBS, herança por chassi,
-- IDENTIFICADOR_DUPLICADO/CONFLITO) permanece byte-a-byte identica --
-- não é o alvo desta wave e não deve ser tocada.
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
      vehicle_model text,
      client_document_normalized text
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

-- =========================================================================
-- PARTE F -- master_operational_apply_base03: substitui o enriquecimento
-- por NOME (client_match_key) pelo enriquecimento por CHAVE DE DOCUMENTO,
-- só automatico quando existe EXATAMENTE UMA operação PAGA/FATURADA
-- (nunca por prioridade de plano, nunca por ordem, nunca por limiar de
-- proximidade de valor). A parte 2 (persistência de SPF) permanece
-- byte-a-byte identica -- não é o alvo desta wave.
-- =========================================================================
create or replace function public.master_operational_apply_base03(p_original_filename text, p_source_sha256 text, p_finance_rows jsonb, p_spf_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
declare
  v_finance_batch_id uuid;
  v_finance_matched integer := 0;
  v_finance_ambiguous integer := 0;
  v_finance_rows_count integer;
  v_sha text := lower(trim(coalesce(p_source_sha256, '')));
  v_spf_batch_id uuid;
  v_spf_rows_count integer;
  v_spf_accepted integer := 0;
  v_spf_rejected integer := 0;
  v_spf_principal_accepted integer := 0;
  v_chunk jsonb;
  v_i integer;
  v_chunk_size constant integer := 500;
  v_max_rows constant integer := 10000;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_finance_rows) <> 'array' or jsonb_typeof(p_spf_rows) <> 'array' then
    raise exception 'Payload inválido: finance_rows e spf_rows devem ser arrays.' using errcode = '22023';
  end if;
  v_finance_rows_count := jsonb_array_length(p_finance_rows);
  v_spf_rows_count := jsonb_array_length(p_spf_rows);
  if v_finance_rows_count > v_max_rows or v_spf_rows_count > v_max_rows then
    raise exception 'Lote da Base 03 excede o limite de % linhas.', v_max_rows using errcode = '22023';
  end if;

  if not p_dry_run then
    if trim(coalesce(p_original_filename, '')) = '' or v_sha !~ '^[a-f0-9]{64}$' then
      raise exception 'Metadados de arquivo inválidos.' using errcode = '22023';
    end if;
  end if;

  select b.id into v_finance_batch_id
  from public.portal_import_batches b
  where b.source_type = 'FINANCE_CURRENT' and b.status = 'VALIDATED'
  order by b.completed_at desc nulls last, b.created_at desc, b.id desc
  limit 1;

  if v_finance_batch_id is null then
    raise exception 'Nenhuma Base 02 (FINANCE_CURRENT) validada foi encontrada. Atualize a Base 02 antes da Base 03.'
      using errcode = 'P0002';
  end if;

  -- Incidente T35918/M4 -- só operações realizadas (PAGA/FATURADA)
  -- participam da identificação da operação elegível; reforçado aqui no
  -- servidor mesmo que o navegador já filtre, para nunca depender só do
  -- filtro do cliente. Agrupa por chave de documento (nunca por nome),
  -- calculada aqui dentro (o navegador nunca vê nem calcula a chave) a
  -- partir do documento normalizado enviado por linha.
  create temp table tmp_m4_keyed on commit drop as
  select
    public.portal_document_match_key(x.client_document_normalized) as match_key,
    x.op_code, x.plan_codigo_if, x.tc_devolvida, x.balloon_value,
    x.installments, x.installment_value, x.vehicle_model
  from jsonb_to_recordset(p_finance_rows) as x(
    client_document_normalized text, op_code text, status text,
    plan_codigo_if text, tc_devolvida numeric, balloon_value numeric,
    installments integer, installment_value numeric, vehicle_model text
  )
  where upper(trim(coalesce(x.status, ''))) in ('PAGA', 'FATURADA');

  -- Incidente T35918/M4 Wave 1.1 -- a auditoria de 5 casos reais provou que
  -- agrupar só por SINAL de classificação (n_signals = count(distinct
  -- (Código IF, TC Devolvida))) é inseguro: 3 dos 5 casos reais encontrados
  -- eram operações GENUINAMENTE DIFERENTES (financiado/parcelas/PMT/balão
  -- todos divergentes, datas de contrato meses apart) que só coincidiam na
  -- CATEGORIA de plano (ex.: ambas BALÃO) -- mesma classificação final, mas
  -- enriquecimento (PMT/parcelas/balão) diferente e potencialmente errado
  -- se a operação errada fosse escolhida. Um segundo achado (casos 4/5):
  -- mesmo par de operações Base03 casando com DOIS chassis/financiamentos
  -- diferentes do mesmo cliente (~16h de intervalo) -- documento identifica
  -- o CLIENTE, não necessariamente o EVENTO de financiamento; nenhuma
  -- contagem de sinal ajuda aqui, só uma seleção verdadeiramente única
  -- resolve com segurança. Corrigido: autoridade de seleção passa a ser
  -- SOMENTE n_ops = count(distinct operation_code) -- nunca o sinal de
  -- classificação, nunca payload, nunca proximidade de valor/data (essas
  -- continuam fora de escopo como autoridade de produto nesta wave).
  create temp table tmp_m4_grouped on commit drop as
  select
    match_key,
    count(distinct op_code) as n_ops,
    (array_agg(plan_codigo_if order by op_code))[1] as any_plan_codigo_if,
    (array_agg(tc_devolvida order by op_code))[1] as any_tc_devolvida,
    (array_agg(balloon_value order by op_code))[1] as any_balloon_value,
    (array_agg(installments order by op_code))[1] as any_installments,
    (array_agg(installment_value order by op_code))[1] as any_installment_value,
    (array_agg(vehicle_model order by op_code))[1] as any_vehicle_model
  from tmp_m4_keyed
  where match_key is not null
  group by match_key;

  select count(*) into v_finance_ambiguous from tmp_m4_grouped where n_ops > 1;

  if p_dry_run then
    select count(*) into v_finance_matched
    from public.portal_finance_operations f
    join public.portal_sales s on s.chassis = f.chassis
    join tmp_m4_grouped g on g.match_key = s.client_document_match_key and g.n_ops = 1
    where f.batch_id = v_finance_batch_id;

    return jsonb_build_object(
      'dry_run', true,
      'finance_batch_id', v_finance_batch_id,
      'finance_rows_received', v_finance_rows_count,
      'finance_rows_matched', v_finance_matched,
      'finance_rows_ambiguous_excluded', v_finance_ambiguous,
      'spf_rows_received', v_spf_rows_count
    );
  end if;

  -- Enriquecimento: só aplica quando existe EXATAMENTE UMA operation_code
  -- PAGA/FATURADA distinta (n_ops = 1) para o documento casado por chassi.
  -- Múltiplas operações distintas (n_ops > 1) NUNCA são resolvidas
  -- automaticamente -- nem por sinal de classificação igual, nem por
  -- payload igual, nem por proximidade de valor/data, nem por ordem --
  -- ficam de fora do UPDATE, o registro permanece como estava.
  with updated as (
    update public.portal_finance_operations f
       set vehicle_model = coalesce(nullif(upper(trim(g.any_vehicle_model)), ''), f.vehicle_model),
           installments = case when g.any_installments > 0 then g.any_installments else f.installments end,
           installment_value =
             case when g.any_installment_value > 0 then g.any_installment_value else f.installment_value end,
           balloon_value =
             case when g.any_balloon_value > 0 then g.any_balloon_value else f.balloon_value end,
           tc_devolvida = g.any_tc_devolvida,
           plan_codigo_if = nullif(upper(trim(g.any_plan_codigo_if)), '')
      from public.portal_sales s
      join tmp_m4_grouped g on g.match_key = s.client_document_match_key and g.n_ops = 1
     where f.batch_id = v_finance_batch_id
       and f.chassis = s.chassis
    returning 1
  )
  select count(*) into v_finance_matched from updated;

  if v_spf_rows_count > 0 then
    v_spf_batch_id := public.master_operational_begin_import(
      'SPF_CURRENT', p_original_filename, v_sha, v_spf_rows_count
    );

    v_i := 0;
    while v_i < v_spf_rows_count loop
      select jsonb_agg(elem) into v_chunk
      from jsonb_array_elements(p_spf_rows) with ordinality as t(elem, ord)
      where ord > v_i and ord <= v_i + v_chunk_size;

      v_spf_accepted := v_spf_accepted
        + public.master_operational_import_spf(v_spf_batch_id, v_chunk);
      v_i := v_i + v_chunk_size;
    end loop;
    v_spf_rejected := v_spf_rows_count - v_spf_accepted;

    select count(*) into v_spf_principal_accepted
    from public.portal_spf_operations
    where batch_id = v_spf_batch_id and is_spf_extra = false;

    if v_spf_principal_accepted = 0 then
      raise exception 'Lote SPF_CURRENT rejeitado: % linha(s) recebida(s), % aceita(s), mas nenhuma é linha operacional principal (todas são SPF Extra). Isso indica que a Base 03 completa não foi enviada — apenas o subconjunto SPF Extra. Selecione o arquivo completo da Base 03 e tente novamente.',
        v_spf_rows_count, v_spf_accepted
        using errcode = '22023';
    end if;

    perform public.master_operational_finalize_import(
      v_spf_batch_id, v_spf_accepted, v_spf_rejected,
      format(
        'Gestão de Bases (Base 03 atômica, identidade por documento): %s SPF aceitas (%s principais + %s SPF Extra), %s rejeitadas; %s linhas financeiras enriquecidas; %s documentos ambíguos (múltiplas operações PAGA/FATURADA) deixados de fora do enriquecimento automático.',
        v_spf_accepted, v_spf_principal_accepted, v_spf_accepted - v_spf_principal_accepted, v_spf_rejected, v_finance_matched, v_finance_ambiguous
      )
    );
  end if;

  return jsonb_build_object(
    'dry_run', false,
    'finance_batch_id', v_finance_batch_id,
    'finance_rows_matched', v_finance_matched,
    'finance_rows_ambiguous_excluded', v_finance_ambiguous,
    'spf_batch_id', v_spf_batch_id,
    'spf_rows_received', v_spf_rows_count,
    'spf_accepted', v_spf_accepted,
    'spf_principal_accepted', v_spf_principal_accepted,
    'spf_rejected', v_spf_rejected
  );
end;
$function$;

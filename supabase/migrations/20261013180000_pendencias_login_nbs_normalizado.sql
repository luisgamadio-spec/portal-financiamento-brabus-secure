-- Pendências cadastrais (13/10/2026) — aplicado em produção em 13/10/2026 com OK do Luis.
-- B: Login NBS comparado sem espaços (inclusive invisíveis) e sem diferença de maiúsculas nas importações e na reconciliação;
--    a cada lote importado, pendências cujo cadastro passou a corresponder (exatamente 1 usuário ativo) são encerradas.
--    Provado com as importações de 13/10 (Base 01/02/03) antes x depois: só muda o encerramento da pendência já resolvida.
-- C: Painel Master > Usuários mostra e edita o Login NBS (master_atualizar_login_nbs_usuario).
-- Desfazer: textos anteriores das funções + drop das novas (guardados fora do repositório, junto da proposta).

-- B) REGRA — normalização do Login NBS + encerramento automático das pendências (PROPOSTA — NÃO APLICADO)
-- 1) portal_normaliza_nbs: ignora qualquer espaço (inclusive invisível) e maiúsculas/minúsculas.
-- 2) portal_fechar_alertas_cadastro_resolvidos: fecha PENDENTE quando o cadastro passa a bater (1 usuário ativo).
-- 3) registrar_alertas_reconciliacao_lote chama (2) a cada lote importado (Base 01 e Base 02).
-- 4) importação de vendas e de financiamentos e a reconciliação passam a comparar NBS por (1).
-- Tudo numa transação; nenhuma linha de dados é alterada além das pendências que (2) fechar.

create or replace function public.portal_normaliza_nbs(p text)
 returns text
 language sql
 immutable
 set search_path to 'pg_catalog', 'public'
as $function$
  -- Login NBS comparável: sem NENHUM espaço (inclusive não separável/invisível) e em maiúsculas. Vazio -> null.
  select nullif(upper(regexp_replace(coalesce(p, ''), '[[:space:]' || chr(160) || chr(8203) || chr(65279) || ']', '', 'g')), '')
$function$;

create or replace function public.portal_fechar_alertas_cadastro_resolvidos()
 returns integer
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
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
-- só as funções internas (security definer) chamam; ninguém chama direto pela API
revoke all on function public.portal_fechar_alertas_cadastro_resolvidos() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.registrar_alertas_reconciliacao_lote(p_batch_id uuid, p_origem_base text, p_itens jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  -- 13/10/2026: a cada lote, fecha as pendências cujo cadastro já passou a corresponder.
  perform public.portal_fechar_alertas_cadastro_resolvidos();
  if p_itens is null or jsonb_array_length(p_itens) = 0 then
    return;
  end if;

  with itens as (
    select
      x.identificador_tipo,
      x.identificador_valor,
      x.nome_encontrado,
      x.login_nbs_encontrado,
      x.loja_encontrada,
      x.departamento_encontrado,
      x.tipo,
      x.severidade,
      x.usuario_candidato_id
    from jsonb_to_recordset(p_itens) as x(
      identificador_tipo text,
      identificador_valor text,
      nome_encontrado text,
      login_nbs_encontrado text,
      loja_encontrada text,
      departamento_encontrado text,
      tipo text,
      severidade text,
      usuario_candidato_id uuid
    )
    where x.identificador_valor is not null and trim(x.identificador_valor) <> ''
  ),
  -- Deduplicacao dentro do proprio lote (Parte S): mesmo identificador+tipo
  -- aparecendo N vezes no lote vira 1 grupo com quantidade N.
  agrupado as (
    select
      tipo, severidade, identificador_tipo, identificador_valor,
      min(nome_encontrado) as nome_encontrado,
      min(login_nbs_encontrado) as login_nbs_encontrado,
      min(loja_encontrada) as loja_encontrada,
      min(departamento_encontrado) as departamento_encontrado,
      (array_agg(usuario_candidato_id) filter (where usuario_candidato_id is not null))[1] as usuario_candidato_id,
      count(*) as ocorrencias_no_lote
    from itens
    group by tipo, severidade, identificador_tipo, identificador_valor
  ),
  -- Excecoes ativas (Parte Q): suprime alerta visivel, incrementa contador
  -- na propria excecao. Nao afeta seller_user_id (ja resolvido antes).
  com_excecao as (
    select a.*, e.id as excecao_id
    from agrupado a
    left join public.portal_cadastro_excecoes e
      on e.identificador_tipo = a.identificador_tipo
     and e.identificador_valor = a.identificador_valor
     and e.ativo = true
  ),
  suprimidos as (
    update public.portal_cadastro_excecoes ex
    set ocorrencias_suprimidas = ex.ocorrencias_suprimidas + ce.ocorrencias_no_lote,
        ultima_ocorrencia_suprimida_em = now(),
        atualizado_em = now()
    from com_excecao ce
    where ex.id = ce.excecao_id and ce.excecao_id is not null
    returning ex.id
  )
  insert into public.portal_cadastro_alertas (
    tipo, severidade, origem_base, import_batch_id,
    identificador_tipo, identificador_valor,
    nome_encontrado, login_nbs_encontrado, loja_encontrada, departamento_encontrado,
    usuario_candidato_id, quantidade_ocorrencias, primeira_ocorrencia_em, ultima_ocorrencia_em
  )
  select
    ce.tipo, ce.severidade, p_origem_base, p_batch_id,
    ce.identificador_tipo, ce.identificador_valor,
    ce.nome_encontrado, ce.login_nbs_encontrado, ce.loja_encontrada, ce.departamento_encontrado,
    ce.usuario_candidato_id, ce.ocorrencias_no_lote, now(), now()
  from com_excecao ce
  where ce.excecao_id is null
  on conflict (tipo, identificador_tipo, identificador_valor)
    where status = 'PENDENTE' and identificador_valor is not null
  do update set
    quantidade_ocorrencias = public.portal_cadastro_alertas.quantidade_ocorrencias + excluded.quantidade_ocorrencias,
    ultima_ocorrencia_em = excluded.ultima_ocorrencia_em,
    import_batch_id = excluded.import_batch_id,
    nome_encontrado = coalesce(excluded.nome_encontrado, public.portal_cadastro_alertas.nome_encontrado),
    login_nbs_encontrado = coalesce(excluded.login_nbs_encontrado, public.portal_cadastro_alertas.login_nbs_encontrado),
    loja_encontrada = coalesce(excluded.loja_encontrada, public.portal_cadastro_alertas.loja_encontrada),
    departamento_encontrado = coalesce(excluded.departamento_encontrado, public.portal_cadastro_alertas.departamento_encontrado),
    usuario_candidato_id = coalesce(excluded.usuario_candidato_id, public.portal_cadastro_alertas.usuario_candidato_id),
    atualizado_em = now();
end;
$function$;

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
  v_nbs := public.portal_normaliza_nbs(v_usuario.login_nbs);

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
        and public.portal_normaliza_nbs(s.seller_nbs) = v_nbs
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
        and public.portal_normaliza_nbs(f.seller_nbs) = v_nbs
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
$function$;

-- conferência antes do commit
do $$ begin
  if public.portal_normaliza_nbs(' fic ti' || chr(160) || 'cio ') <> 'FICTICIO' then raise exception 'TRAVA: normalização'; end if;
  if position('portal_normaliza_nbs' in pg_get_functiondef('public.master_operational_import_finance'::regproc)) = 0
     or position('portal_normaliza_nbs' in pg_get_functiondef('public.master_operational_import_sales'::regproc)) = 0 then raise exception 'TRAVA: importadores'; end if;
end $$;

-- C) TELA — Login NBS no detalhe do usuário + edição pelo Master (PROPOSTA — NÃO APLICADO; requer B aplicada antes)
CREATE OR REPLACE FUNCTION public.master_admin_security_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'cpf', u.cpf,
          'cpf_normalizado', u.cpf_normalizado,
          'nome', u.nome,
          'perfil', u.perfil,
          'loja', u.loja,
          'login_nbs', u.login_nbs,
          'status', u.status,
          'ativo', u.ativo,
          'primeiro_acesso', u.primeiro_acesso,
          'ultimo_login', u.ultimo_login,
          'email_auth', u.email_auth,
          'tem_auth', (u.auth_user_id is not null),
          'email_divergente', (
            u.auth_user_id is not null
            and exists (
              select 1 from auth.users au
              where au.id = u.auth_user_id
                and lower(au.email) is distinct from lower(u.email_auth)
            )
          ),
          'auth_confirmado', (
            u.auth_user_id is not null
            and exists (
              select 1 from auth.users au
              where au.id = u.auth_user_id
                and au.email_confirmed_at is not null
            )
          ),
          'ativacao_legado', (
            select jsonb_build_object(
              'status', a.status,
              'email_novo', a.email_novo,
              'criado_em', a.criado_em,
              'ultimo_envio_em', a.ultimo_envio_em,
              'expira_em', a.expira_em,
              'verificado_em', a.verificado_em,
              'concluido_em', a.concluido_em
            )
            from public.ativacoes_acesso_usuario a
            where a.usuario_id = u.id
            order by a.criado_em desc
            limit 1
          )
        )
        order by u.nome
      )
      from public.usuarios u
    ), '[]'::jsonb),
    'configurations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'chave', c.chave,
          'valor', c.valor,
          'descricao', c.descricao,
          'atualizado_em', c.atualizado_em
        )
        order by c.chave
      )
      from public.configuracoes c
      where c.chave = any (array[
        'share_minimo',
        'spf_liquido_percentual',
        'bonus_spf_analista',
        'limite_retorno_novos',
        'limite_retorno_seminovos',
        'vendedor_faixa_baixo_share_baixo',
        'vendedor_faixa_baixo_share_alto',
        'vendedor_faixa_alto_share_baixo',
        'vendedor_faixa_alto_share_alto',
        'gerente_faixa_share_baixo',
        'gerente_faixa_share_alto',
        'analista_faixa_share_baixo',
        'analista_faixa_share_alto'
      ])
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.criado_em desc)
      from (
        select id, tipo, descricao, base_origem, loja, vendedor, cpf,
               resolvido, resolvido_por, resolvido_em, criado_em
        from public.auditoria
        order by criado_em desc
        limit 100
      ) a
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.master_atualizar_login_nbs_usuario(p_usuario_id uuid, p_login_nbs text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_usuario public.usuarios%rowtype;
  v_seller public.portal_sellers%rowtype;
  v_novo text := public.portal_normaliza_nbs(p_login_nbs);
begin
  -- Editar o Login NBS pelo Painel Master → Usuários (13/10/2026). Mesmas validações de
  -- master_cadastro_alerta_corrigir_login_nbs; depois reconcilia (liga as vendas/financiamentos
  -- e encerra as pendências do usuário) e fecha as pendências que passaram a bater.
  select u.* into v_actor from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil, ''))) = 'MASTER' limit 1;
  if v_actor.id is null then raise exception 'Acesso negado.' using errcode = '42501'; end if;
  if v_novo is null then return jsonb_build_object('ok', false, 'codigo', 'VALOR_OBRIGATORIO'); end if;
  select * into v_usuario from public.usuarios where id = p_usuario_id;
  if v_usuario.id is null then return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO'); end if;
  if public.portal_normaliza_nbs(v_usuario.login_nbs) is not distinct from v_novo then
    return jsonb_build_object('ok', true, 'codigo', 'SEM_ALTERACAO', 'login_nbs', v_novo);
  end if;
  if exists (select 1 from public.usuarios u2 where public.portal_normaliza_nbs(u2.login_nbs) = v_novo and u2.ativo and u2.id <> v_usuario.id) then
    return jsonb_build_object('ok', false, 'codigo', 'NBS_VINCULADO_OUTRO_USUARIO');
  end if;
  select * into v_seller from public.portal_sellers where public.portal_normaliza_nbs(nbs) = v_novo and active limit 1;
  if v_seller.id is not null and coalesce(v_seller.cpf_normalizado, '') <> '' and v_seller.cpf_normalizado <> v_usuario.cpf_normalizado then
    return jsonb_build_object('ok', false, 'codigo', 'NBS_CPF_DIVERGENTE');
  end if;
  update public.usuarios set login_nbs = v_novo, atualizado_em = now() where id = v_usuario.id;
  perform public.portal_reconcile_user_facts_core(v_usuario.id);
  perform public.portal_fechar_alertas_cadastro_resolvidos();
  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_por, resolvido_em)
  values ('ADMIN_USUARIO', format('Login NBS alterado por %s: %s -> %s', v_actor.nome, coalesce(nullif(trim(coalesce(v_usuario.login_nbs, '')), ''), '(vazio)'), v_novo),
          'RPC master_atualizar_login_nbs_usuario', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, v_actor.id, now());
  return jsonb_build_object('ok', true, 'codigo', 'ATUALIZADO', 'login_nbs', v_novo);
end;
$function$;

revoke all on function public.master_atualizar_login_nbs_usuario(uuid, text) from public, anon;
grant execute on function public.master_atualizar_login_nbs_usuario(uuid, text) to authenticated;
-- DESFAZER C:
-- begin;
-- CREATE OR REPLACE FUNCTION public.master_admin_security_data()
--  RETURNS jsonb
--  LANGUAGE plpgsql
--  SECURITY DEFINER
--  SET search_path TO 'pg_catalog', 'public'
-- AS $function$
-- begin
--   if not public.is_master() then
--     raise exception 'Acesso exclusivo do perfil Master.'
--       using errcode = '42501';
--   end if;
-- 
--   return jsonb_build_object(
--     'users', coalesce((
--       select jsonb_agg(
--         jsonb_build_object(
--           'id', u.id,
--           'cpf', u.cpf,
--           'cpf_normalizado', u.cpf_normalizado,
--           'nome', u.nome,
--           'perfil', u.perfil,
--           'loja', u.loja,
--           'status', u.status,
--           'ativo', u.ativo,
--           'primeiro_acesso', u.primeiro_acesso,
--           'ultimo_login', u.ultimo_login,
--           'email_auth', u.email_auth,
--           'tem_auth', (u.auth_user_id is not null),
--           'email_divergente', (
--             u.auth_user_id is not null
--             and exists (
--               select 1 from auth.users au
--               where au.id = u.auth_user_id
--                 and lower(au.email) is distinct from lower(u.email_auth)
--             )
--           ),
--           'auth_confirmado', (
--             u.auth_user_id is not null
--             and exists (
--               select 1 from auth.users au
--               where au.id = u.auth_user_id
--                 and au.email_confirmed_at is not null
--             )
--           ),
--           'ativacao_legado', (
--             select jsonb_build_object(
--               'status', a.status,
--               'email_novo', a.email_novo,
--               'criado_em', a.criado_em,
--               'ultimo_envio_em', a.ultimo_envio_em,
--               'expira_em', a.expira_em,
--               'verificado_em', a.verificado_em,
--               'concluido_em', a.concluido_em
--             )
--             from public.ativacoes_acesso_usuario a
--             where a.usuario_id = u.id
--             order by a.criado_em desc
--             limit 1
--           )
--         )
--         order by u.nome
--       )
--       from public.usuarios u
--     ), '[]'::jsonb),
--     'configurations', coalesce((
--       select jsonb_agg(
--         jsonb_build_object(
--           'chave', c.chave,
--           'valor', c.valor,
--           'descricao', c.descricao,
--           'atualizado_em', c.atualizado_em
--         )
--         order by c.chave
--       )
--       from public.configuracoes c
--       where c.chave = any (array[
--         'share_minimo',
--         'spf_liquido_percentual',
--         'bonus_spf_analista',
--         'limite_retorno_novos',
--         'limite_retorno_seminovos',
--         'vendedor_faixa_baixo_share_baixo',
--         'vendedor_faixa_baixo_share_alto',
--         'vendedor_faixa_alto_share_baixo',
--         'vendedor_faixa_alto_share_alto',
--         'gerente_faixa_share_baixo',
--         'gerente_faixa_share_alto',
--         'analista_faixa_share_baixo',
--         'analista_faixa_share_alto'
--       ])
--     ), '[]'::jsonb),
--     'audit', coalesce((
--       select jsonb_agg(to_jsonb(a) order by a.criado_em desc)
--       from (
--         select id, tipo, descricao, base_origem, loja, vendedor, cpf,
--                resolvido, resolvido_por, resolvido_em, criado_em
--         from public.auditoria
--         order by criado_em desc
--         limit 100
--       ) a
--     ), '[]'::jsonb)
--   );
-- end;
-- $function$;
-- drop function if exists public.master_atualizar_login_nbs_usuario(uuid, text);
-- commit;

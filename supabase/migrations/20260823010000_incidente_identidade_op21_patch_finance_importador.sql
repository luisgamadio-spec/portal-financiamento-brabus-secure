-- Incidente Identidade-Operacional-2.1, Patch Finance (importador).
--
-- Mesma classe estrutural do Patch A de Sales (Identidade-Operacional-2.0),
-- investigada e adaptada individualmente ao contrato proprio de Finance --
-- NAO copiada mecanicamente.
--
-- EXPOSICAO COMPROVADA EM DADOS REAIS (nao so teorica): busca historica
-- encontrou 78 operacoes financeiras, 6 vendedores, cujo seller_user_id
-- foi corretamente resolvido em um lote FINANCE VALIDATED anterior e
-- aparece NULL no lote VALIDATED mais recente (fonte de origem: lotes
-- 2b3c7461-85e0-40e1-a899-4851dead8613 e 645e8bd9-b6c0-4564-96a3-92ed96c2cee8).
-- Das 78, 4 caem dentro do periodo sentinela certificado (21/07-20/08) E
-- sao is_real_financing=true -- hoje MASCARADAS no total de 179 porque o
-- fallback legado seller_id (portal_sellers, coalesce em eligible_sellers)
-- ainda cobre exatamente esses 4 casos. Isso e coincidencia, nao garantia:
-- se qualquer um desses 6 vendedores (todos com usuarios.ativo=false hoje)
-- tiver um cadastro usuarios ativo criado com o mesmo CPF no futuro, o
-- guard NOT EXISTS(usuario ativo) do ramo portal_sellers de eligible_sellers
-- excluiria a identidade legada e o mesmo padrao Fabio/Herbert se repetiria
-- aqui, silenciosamente.
--
-- IDENTIDADE CANONICA DO FATO: diferente de Sales, chassi sozinho NAO
-- identifica "o mesmo fato" em Finance -- um unico chassi pode ter ate 5
-- linhas legitimas e distintas no mesmo lote (financiamento + blindagem +
-- emplacamento + SPF extra etc.). client_match_key e ainda menos granular
-- (nivel cliente, ate 38 linhas por valor) e finance_code cobre so 25% das
-- linhas com apenas 143 valores distintos para 926 linhas -- nenhum dos
-- dois serve como chave de fato. A chave mais granular disponivel nas
-- colunas hoje persistidas e (chassis, service_description): 3672 de 3678
-- linhas distintas no lote mais recente (99,84%). operation_date foi
-- deliberadamente excluido da chave -- uma correcao legitima de data entre
-- lotes nao pode por si so quebrar o vinculo com o fato anterior.
--
-- Regra de precedencia identica em espirito ao Patch A: identidade atual
-- valida sempre vence; heranca so quando a classificacao atual e SEM_MATCH/
-- SEM_IDENTIFICADOR/CPF_INATIVO; nunca herda em IDENTIFICADOR_DUPLICADO/
-- CONFLITO; nunca tenta herdar quando chassis esta vazio (linhas
-- is_later_return sem chassi -- sem essa guarda, duas linhas distintas
-- com chassis nulo poderiam colidir e fabricar um vinculo inexistente).
--
-- Escopo estritamente estrutural: nenhuma coluna de valor, data, retorno,
-- plano ou client_match_key e alterada -- apenas o computo de
-- seller_user_id_final ganha um fallback via COALESCE. Testado
-- exaustivamente em ROLLBACK: recuperacao real dos 78 fatos afetados via
-- reimportacao identica do subconjunto (nenhum dado alterado fora da
-- transacao de teste), heranca quando SEM_MATCH, mudanca real de vendedor
-- sempre vence a heranca mesmo servico, SEM_MATCH em servico nunca antes
-- resolvido permanece NULL, CONFLITO (CPF x NBS apontando usuarios
-- diferentes) nunca herda, e populacao/SPF confirmados byte-identicos ao
-- baseline certificado (414/179/0-divergencias; SPF 38 operacoes /
-- R$118.609,10 bruto / R$83.026,37 liquido) numa transacao isolada sem
-- fixtures sinteticas contaminando a selecao do "lote mais recente".
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

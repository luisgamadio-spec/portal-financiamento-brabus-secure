-- Fase 21.3 -- Reconciliacao operacional direta Bases 01/02 -> usuarios.
--
-- Contexto (Fase 21.0/21.1/21.2): usuarios e a fonte operacional atual;
-- portal_sellers passa a ser fallback legado/enriquecimento. As tabelas
-- portal_sales/portal_finance_operations ja tinham seller_user_id (FK
-- usuarios.id) ocioso desde sempre -- esta migration finalmente o popula.
--
-- Prova retrospectiva (leitura, sem escrita, feita ANTES desta migration):
-- de 13.859 portal_sales existentes, 9.734 resolveriam por CPF (via a ponte
-- legada seller_id->portal_sellers.cpf_normalizado, unico jeito de simular
-- CPF em dados historicos ja que o CPF bruto nunca foi persistido); 1.868
-- sao o placeholder seller_nbs="NBS" (fato sem vendedor individual na
-- origem, nao e pendencia cadastral); 1.441 sao portal_sellers legado sem
-- usuario atual (nunca convidados ao Portal); 189 sao historico anterior
-- com esquema de identificacao obsoleto; e 627 batem por CPF mas o usuario
-- esta INATIVO -- destas, 4 pessoas (Herbert Martins Nascimento, Cristina
-- Jane dos Santos, Fabio Donizete de Oliveira Franca, Alexandre de Sa
-- Correa) tem producao recente e real associada a um cadastro inativo,
-- incluindo uma venda de Herbert em 17/08 (posterior a propria desativacao
-- em massa registrada em 15/08) -- achado reportado separadamente para
-- decisao de negocio, NAO resolvido automaticamente por esta migration
-- (regra explicita: usuario inativo nunca vira seller_user_id, sempre gera
-- alerta USUARIO_INATIVO_COM_PRODUCAO em vez disso).
--
-- Elegibilidade de perfil (Parte E): NAO restrita a VENDEDOR. Confirmado
-- com dados reais que GERENTE (Luis Fernando Bueno de Souza, Joao Fontolan)
-- tem producao financeira legitima e agora resolve corretamente por CPF --
-- eram o gap mais concreto encontrado na Fase 21.0 (316 operacoes sem
-- seller_id nem seller_user_id, por NBS divergente entre a base de vendas
-- e a base de colaboradores). seller_user_id e resolucao de IDENTIDADE, nao
-- elegibilidade de comissao -- essa continua sendo decidida inteiramente
-- por operational_metrics() (Incidente 19.1/Fase 21.1), intocada aqui.
--
-- Hierarquia de resolucao: CPF valido + match unico em usuarios ativo (mais
-- forte) > NBS normalizado + match unico em usuarios.login_nbs ativo,
-- somente quando CPF ausente/invalido > sem match = seller_user_id NULL +
-- alerta. CPF e NBS resolvendo pessoas DIFERENTES = conflito, NULL + alerta
-- CORRESPONDENCIA_INDETERMINADA (nunca escolhe). portal_sellers permanece
-- SOMENTE como fonte do seller_id legado (nunca usado para seller_user_id).
--
-- Testado com fixtures sinteticas (CPFs 999...xxxxx e nomes claramente
-- marcados como FIXTURE/TESTE, alem dos CPFs reais de Bruno/Aline/Herbert/
-- Bueno/Fontolan para provar a resolucao contra pessoas reais) cobrindo os
-- 12 cenarios do prompt: CPF match, Bruno (tem portal_sellers -- correcao a
-- um entendimento anterior da Fase 20.2/21.0, nunca verificado
-- especificamente), Aline (genuinamente sem portal_sellers, prova mais
-- limpa da arquitetura), CPF sem match, NBS fallback, conflito CPF x NBS,
-- usuario inativo, NBS divergente com CPF correto, placeholder NBS
-- (agregado em 1 alerta por lote, nunca por linha), excecao ativa
-- (suprime alerta, incrementa ocorrencias_suprimidas), historico antigo
-- (severidade INFORMATIVO via source_kind, nao URGENTE), gerente. Dedup
-- confirmado dentro do lote e entre lotes diferentes (quantidade_ocorrencias
-- incrementa via ON CONFLICT, nao duplica linha). Todas as fixtures
-- removidas ao final -- zero alerta/excecao real criado por este trabalho.
--
-- Contrato preservado (Parte AO): master_operational_import_sales/finance
-- continuam retornando integer (contagem de linhas aceitas) -- o frontend
-- usa esse valor aritmeticamente (rowsToSend.length - accepted), mudar para
-- jsonb quebraria silenciosamente. Detalhes de alertas gerados por lote
-- ficam disponiveis via master_cadastro_alertas_listar(..., p_origem_base)
-- filtrando por import_batch_id, ja existente desde a Fase 21.2.
--
-- Fora de escopo: Base 03 (nao alterada, permanece herdando identidade via
-- client_match_key -> portal_finance_operations.seller_user_id quando a
-- 21.4 passar a usa-lo), backfill dos fatos ja existentes (nao executado
-- nesta migration -- avaliado e proposto separadamente no relatorio final,
-- nao incluido aqui por decisao de manter esta migration estritamente
-- sobre os importadores), LOJA_DIVERGENTE/DEPARTAMENTO_DIVERGENTE (tipos
-- de alerta existem no schema da 21.2 mas nao sao gerados por este
-- importador -- risco real de falso positivo comparando fato historico
-- contra cadastro atual, sinalizado explicitamente pelo proprio prompt;
-- fica para uma fase futura com mais evidencia).

-- Funcao auxiliar (Fase 21.3): agrega e faz upsert de alertas cadastrais a
-- partir de um lote de importacao, checando excecoes ativas antes de criar
-- qualquer alerta visivel. Chamada internamente pelos importadores
-- candidatos (nunca exposta diretamente a authenticated). identificador_tipo
-- vem DENTRO de cada item (CPF ou NBS, conforme o que estiver disponivel na
-- linha de origem), nao como parametro fixo -- um fato pode ter CPF invalido
-- mas NBS presente, e precisa ser identificado pelo NBS nesse caso.
CREATE OR REPLACE FUNCTION public.registrar_alertas_reconciliacao_lote(
  p_batch_id uuid,
  p_origem_base text,
  p_itens jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
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
  on conflict (tipo, coalesce(origem_base, ''), identificador_tipo, identificador_valor)
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

-- Funcao auxiliar (Fase 21.3): 1 alerta agregado por lote para fatos sem
-- NENHUM identificador aproveitavel (ex: placeholder "NBS", campo vazio).
-- Nunca 1 alerta por linha -- nao ha pessoa para cadastrar (Parte N).
CREATE OR REPLACE FUNCTION public.registrar_alerta_sem_identificador_lote(
  p_batch_id uuid,
  p_origem_base text,
  p_quantidade integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if coalesce(p_quantidade, 0) <= 0 then
    return;
  end if;

  insert into public.portal_cadastro_alertas (
    tipo, severidade, origem_base, import_batch_id,
    motivo, quantidade_ocorrencias, primeira_ocorrencia_em, ultima_ocorrencia_em
  ) values (
    'FATO_SEM_VENDEDOR_ATRIBUIDO', 'INFORMATIVO', p_origem_base, p_batch_id,
    format('%s linha(s) sem qualquer identificador de vendedor no arquivo importado (ex.: placeholder ou campo vazio).', p_quantidade),
    p_quantidade, now(), now()
  );
end;
$function$;

revoke all on function public.registrar_alertas_reconciliacao_lote(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.registrar_alertas_reconciliacao_lote(uuid, text, jsonb) to service_role;
revoke all on function public.registrar_alerta_sem_identificador_lote(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.registrar_alerta_sem_identificador_lote(uuid, text, integer) to service_role;

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

  -- Materializado em tabela temporaria (nao CTE) porque precisa ser lido
  -- por multiplos statements depois (insert do fato + 3 chamadas de
  -- registro de alerta) -- uma CTE nao sobrevive alem do proprio statement.
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
      -- Placeholder "NBS" (Fase 21.0/21.3: ~1.868 linhas historicas, fato
      -- sem vendedor individual atribuido na origem) tratado como ausencia
      -- de NBS desde a normalizacao -- nunca deve virar identificador de
      -- alerta nem SEM_MATCH, sempre SEM_IDENTIFICADOR (Parte N).
      nullif(nullif(upper(trim(coalesce(x.seller_nbs, ''))), ''), 'NBS') as nbs_norm
    from incoming x
    where x.source_row_number > 0
      and x.sale_date is not null
      and trim(coalesce(x.chassis, '')) <> ''
      and upper(x.department) in ('NOVOS', 'SEMINOVOS')
      and upper(x.source_kind) in ('CURRENT', 'HISTORY')
  ),
  -- Reconciliacao operacional atual (Fase 21.3): resolve o vendedor
  -- diretamente contra usuarios por CPF, com fallback controlado por NBS.
  -- portal_sellers permanece como fallback LEGADO apenas para seller_id,
  -- nunca para seller_user_id.
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
    -- Identificador usado para fins de ALERTA quando a linha nao resolve:
    -- prioriza CPF valido; usa NBS quando CPF ausente/invalido mas NBS
    -- presente (evita perder o caso "CPF ruim, NBS bom mas nao cadastrado").
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor
  from classified c;

  with upserted as (
    insert into public.portal_sales (
      batch_id, source_row_number, sale_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_source_name, seller_nbs, store, sale_value,
      department, source_kind, source_transaction, vehicle_model
    )
    select
      p_batch_id, source_row_number, sale_date,
      upper(regexp_replace(chassis, '[^A-Za-z0-9]', '', 'g')),
      nullif(upper(trim(coalesce(chassis_short, ''))), ''),
      resolved_seller_id,
      seller_user_id_final,
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

  -- Alertas cadastrais (Fase 21.3). Severidade: CURRENT usa a classificacao
  -- real; HISTORY (legado, anterior ao periodo operacional atual) e sempre
  -- INFORMATIVO -- nunca gera ruido urgente para dado historico (Parte P,
  -- usa a fronteira estrutural ja existente source_kind em vez de uma data
  -- arbitraria). Exceções ativas suprimem o alerta e incrementam contador.
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

  -- NBS_DIVERGENTE: CPF resolveu, mas o NBS do fato diverge do cadastro
  -- (ou o cadastro nao tem NBS ainda). Nao bloqueia seller_user_id.
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

  -- FATO_SEM_VENDEDOR_ATRIBUIDO: sem NENHUM identificador no fato (ex.
  -- placeholder "NBS" ou campo vazio) -- 1 alerta agregado por lote, nunca
  -- por linha (Parte N/S): nao ha pessoa para cadastrar.
  perform public.registrar_alerta_sem_identificador_lote(
    p_batch_id, v_source_type,
    (select count(*)::integer from tmp_reconciliacao_vendedor_sales where classificacao = 'SEM_IDENTIFICADOR')
  );

  drop table if exists tmp_reconciliacao_vendedor_sales;

  return v_count;
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
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor
  from classified c;

  with upserted as (
    insert into public.portal_finance_operations (
      batch_id, source_row_number, operation_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_source_name, seller_nbs, store,
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

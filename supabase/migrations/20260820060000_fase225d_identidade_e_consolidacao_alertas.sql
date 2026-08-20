-- Fase 22.5D -- Pendencias Cadastrais: identidade e consolidacao de alertas.
--
-- Caso sentinela: CAMILA FERNANDES FIGUEIREDO / NBS CAMILAFF, reportada como
-- "63 tarefas para a mesma pessoa". Investigacao (100% leitura) confirmou:
-- ela tinha apenas 2 alertas PENDENTE fisicos (nao 63) -- 78 ocorrencias
-- (FINANCE_CURRENT) + 63 ocorrencias (SALES_CURRENT), ambos tipo
-- ATUALIZACAO_CADASTRAL_NECESSARIA. seller_user_id ja estava 100% correto
-- (240/240 sales, 304/304 finance vinculadas por CPF) -- o problema era
-- puramente de CLASSIFICACAO e CONSOLIDACAO do alerta, nunca de identidade.
--
-- CAUSA RAIZ 1 (classificacao): em master_operational_import_sales e
-- master_operational_import_finance, quando o CPF ja identifica o usuario
-- de forma inequivoca (CPF_MATCH) mas o Login NBS da base diverge do
-- cadastro, o tipo gerado dependia de usuarios.login_nbs ser NULL
-- ('ATUALIZACAO_CADASTRAL_NECESSARIA', generico) ou nao-NULL
-- ('NBS_DIVERGENTE', especifico com correcao assistida) -- exatamente a
-- MESMA causa (Login NBS nao bate), classificada diferente so por acaso
-- de NULL. Confirmado: ATUALIZACAO_CADASTRAL_NECESSARIA e gerado
-- EXCLUSIVAMENTE por esse ponto (auditoria de toda funcao no schema
-- public que a referencia) -- corrigido pra sempre NBS_DIVERGENTE.
--
-- CAUSA RAIZ 2 (consolidacao): a chave de deduplicacao de
-- portal_cadastro_alertas incluia origem_base, entao o MESMO problema de
-- identidade aparecendo em Base 01 (SALES) e Base 02 (FINANCE) sempre
-- virava 2 alertas PENDENTE fisicamente separados. origem_base e
-- proveniencia (onde foi detectado), nunca parte da identidade do
-- problema (tipo + identificador) -- removida da chave.
--
-- Saneamento (rodado uma vez, antes de alterar a chave, pra nao violar o
-- indice antigo): reclassificar TODOS os ATUALIZACAO_CADASTRAL_NECESSARIA
-- PENDENTE pra NBS_DIVERGENTE e consolidar, na mesma operacao, qualquer
-- grupo (tipo efetivo + identificador) com mais de 1 linha PENDENTE --
-- somando quantidade_ocorrencias, preservando primeira/ultima ocorrencia,
-- 1 evento de auditoria por grupo (nunca 1 por alerta removido). Resultado
-- real: 102 -> 50 alertas PENDENTE; Camila: 2 alertas (141 ocorrencias
-- somadas) -> 1 alerta NBS_DIVERGENTE. Alertas IGNORADO/RESOLVIDO/EXCLUIDO
-- nunca tocados (saneamento so olha status='PENDENTE').
--
-- Testado em transacao com ROLLBACK antes de aplicar: TESTE 1 (100 fatos,
-- mesmo CPF/usuario/NBS divergente -> 100/100 vinculados, 1 alerta
-- NBS_DIVERGENTE, quantidade=100), TESTE 9 (reimportar os mesmos 100
-- fatos -> continua 1 alerta, quantidade=200, nao duplica), TESTE 6 (CPF
-- pessoa A + NBS pessoa B -> NAO vincula automaticamente, seller_user_id
-- nulo, 1 alerta CORRESPONDENCIA_INDETERMINADA severidade URGENTE).
-- TESTES 2/3/4/5/7/8 (nome/loja/departamento nunca decidem identidade;
-- NBS so como fallback quando CPF ausente; nunca consolidar identificadores
-- diferentes) garantidos por construcao -- codigo de classificacao por
-- CPF/NBS (CTE `classified`) nao foi alterado, so o mapeamento de tipo do
-- caso CPF_MATCH+NBS-divergente e a chave de deduplicacao.
--
-- Zero alteracao em: usuarios, ausencias_analistas, comissoes, coberturas
-- (22.6B), analytics (21.10/21.11), snapshots, fechamentos, Auth, Edge
-- Functions, CORS. Grants de todas as 3 funcoes recriadas preservados
-- exatamente (comparado antes/depois).

-- ===================== SANEAMENTO (dados existentes) =====================
do $do$
declare
  v_grupo record;
  v_canonico uuid;
  v_ids_removidos uuid[];
  v_total_grupos integer := 0;
  v_total_removidos integer := 0;
  v_total_renomeados integer := 0;
begin
  for v_grupo in
    select
      case when tipo = 'ATUALIZACAO_CADASTRAL_NECESSARIA' then 'NBS_DIVERGENTE' else tipo end as tipo_efetivo,
      identificador_tipo, identificador_valor,
      array_agg(id order by primeira_ocorrencia_em asc, id asc) as ids,
      array_agg(tipo order by primeira_ocorrencia_em asc, id asc) as tipos_originais,
      sum(quantidade_ocorrencias) as qtd_total,
      min(primeira_ocorrencia_em) as primeira,
      max(ultima_ocorrencia_em) as ultima,
      (array_agg(nome_encontrado order by (nome_encontrado is null), primeira_ocorrencia_em asc))[1] as nome,
      (array_agg(login_nbs_encontrado order by (login_nbs_encontrado is null), primeira_ocorrencia_em asc))[1] as nbs,
      (array_agg(loja_encontrada order by (loja_encontrada is null), primeira_ocorrencia_em asc))[1] as loja,
      (array_agg(departamento_encontrado order by (departamento_encontrado is null), primeira_ocorrencia_em asc))[1] as depto,
      (array_agg(usuario_candidato_id order by (usuario_candidato_id is null), primeira_ocorrencia_em asc))[1] as candidato
    from public.portal_cadastro_alertas
    where status = 'PENDENTE' and identificador_valor is not null
    group by
      case when tipo = 'ATUALIZACAO_CADASTRAL_NECESSARIA' then 'NBS_DIVERGENTE' else tipo end,
      identificador_tipo, identificador_valor
  loop
    v_canonico := v_grupo.ids[1];

    if array_length(v_grupo.ids, 1) > 1 then
      v_total_grupos := v_total_grupos + 1;
      v_ids_removidos := v_grupo.ids[2:array_length(v_grupo.ids,1)];
      v_total_removidos := v_total_removidos + array_length(v_ids_removidos,1);

      -- Apagar os irmaos ANTES de renomear o canonico: se algum irmao ja
      -- era do tipo_efetivo com o MESMO origem_base do canonico (ex.:
      -- canonico era ATUALIZACAO_CADASTRAL_NECESSARIA, irmao ja era
      -- NBS_DIVERGENTE, mesma origem_base), renomear o canonico ANTES de
      -- remover o irmao colide momentaneamente com o indice antigo
      -- (ainda ativo neste ponto da migracao).
      delete from public.portal_cadastro_alertas where id = any(v_ids_removidos);

      update public.portal_cadastro_alertas
      set tipo = v_grupo.tipo_efetivo,
          quantidade_ocorrencias = v_grupo.qtd_total,
          primeira_ocorrencia_em = v_grupo.primeira,
          ultima_ocorrencia_em = v_grupo.ultima,
          nome_encontrado = coalesce(nome_encontrado, v_grupo.nome),
          login_nbs_encontrado = coalesce(login_nbs_encontrado, v_grupo.nbs),
          loja_encontrada = coalesce(loja_encontrada, v_grupo.loja),
          departamento_encontrado = coalesce(departamento_encontrado, v_grupo.depto),
          usuario_candidato_id = coalesce(usuario_candidato_id, v_grupo.candidato),
          atualizado_em = now()
      where id = v_canonico;

      insert into public.auditoria (tipo, descricao, base_origem, resolvido)
      values (
        'ALERTAS_CADASTRAIS_CONSOLIDADOS',
        format('Saneamento 22.5D: %s alerta(s) PENDENTE (%s) de identificador %s consolidados no alerta %s como %s (ocorrencias somadas: %s)',
          array_length(v_ids_removidos,1), array_to_string(v_grupo.tipos_originais, '+'),
          public.mascarar_identificador_cadastro(v_grupo.identificador_valor),
          v_canonico, v_grupo.tipo_efetivo, v_grupo.qtd_total),
        'Saneamento 22.5D', true
      );
    elsif v_grupo.tipos_originais[1] <> v_grupo.tipo_efetivo then
      v_total_renomeados := v_total_renomeados + 1;
      update public.portal_cadastro_alertas
      set tipo = v_grupo.tipo_efetivo, atualizado_em = now()
      where id = v_canonico;
    end if;
  end loop;

  raise notice 'Saneamento: % grupos consolidados (% alertas removidos), % alertas so renomeados', v_total_grupos, v_total_removidos, v_total_renomeados;
end $do$;

-- ===================== CHAVE DE DEDUPLICACAO (drop origem_base) =====================
drop index public.portal_cadastro_alertas_pendente_uk;

create unique index portal_cadastro_alertas_pendente_uk
on public.portal_cadastro_alertas (tipo, identificador_tipo, identificador_valor)
where (status = 'PENDENTE' and identificador_valor is not null);

CREATE OR REPLACE FUNCTION public.registrar_alertas_reconciliacao_lote(p_batch_id uuid, p_origem_base text, p_itens jsonb)
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

-- ===================== IMPORTADORES (classificacao) =====================
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

-- DESFAZER a mudança do fechamento de 21/10/2026: funções com o texto EXATO de antes (fech_backup.json)
-- e remoção das 2 colunas novas. ATENÇÃO: se algum fechamento já tiver sido feito depois da mudança,
-- remover as colunas apaga a identificação (usuario_id) e o "conta na comissão" gravados nele.
begin;

CREATE OR REPLACE FUNCTION public.master_close_commission_period(p_period_id uuid, p_summary jsonb, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios;
  v_period public.periodos_comissao;
  v_closing_id uuid;
  v_version integer;
  v_row_count integer;
  v_perfis_validos constant text[] := array['VENDEDOR', 'GERENTE', 'ANALISTA', 'GESTOR F&I'];
  -- PM-6D.2 -- novas variaveis, estritamente para a captura suplementar.
  v_sales_batch_id uuid;
  v_finance_batch_id uuid;
  v_spf_batch_id uuid;
  v_chassis_result jsonb;
  v_spf_result jsonb;
  v_chassis_row_count integer;
  v_spf_row_count integer;
  v_hash text;
  v_engine_version constant text := 'commission-secure-v1';
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  select p.* into v_period
  from public.periodos_comissao p
  where p.id = p_period_id
  for update;

  if v_period.id is null or v_period.ativo is not true then
    raise exception 'Período de comissão ativo não encontrado.'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from public.fechamentos_comissao f
    where f.periodo_id = p_period_id
      and f.ativo is true
      and upper(trim(coalesce(f.status, ''))) = 'FECHADO'
  ) then
    raise exception 'Este período já possui fechamento ativo.'
      using errcode = '23505';
  end if;

  if jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' then
    raise exception 'As linhas do snapshot devem ser uma lista.'
      using errcode = '22023';
  end if;

  v_row_count := jsonb_array_length(p_rows);
  if v_row_count < 1 or v_row_count > 5000 then
    raise exception 'Quantidade inválida de linhas no snapshot: %.', v_row_count
      using errcode = '22023';
  end if;

  -- Incidente Fechamento 1.0 -- validacao minima do contrato antes de
  -- gravar. Nao redesenha o payload, so recusa o que ja e objetivamente
  -- invalido: identidade ausente, perfil fora do conjunto que este fluxo
  -- realmente produz (VENDEDOR/GERENTE/ANALISTA/GESTOR F&I), ou comissao
  -- negativa/NaN.
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(nome text, perfil text)
    where nullif(trim(coalesce(r.nome, '')), '') is null
       or upper(trim(coalesce(r.perfil, ''))) <> all(v_perfis_validos)
  ) then
    raise exception 'Linha de snapshot com nome ou perfil invalido.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      comissao_total numeric, comissao_principal numeric, comissao_spf numeric
    )
    where coalesce(r.comissao_total, 0) < 0
       or coalesce(r.comissao_principal, 0) < 0
       or coalesce(r.comissao_spf, 0) < 0
       or r.comissao_total = 'NaN'::numeric
       or r.comissao_principal = 'NaN'::numeric
       or r.comissao_spf = 'NaN'::numeric
  ) then
    raise exception 'Linha de snapshot com valor de comissao invalido (negativo ou NaN).'
      using errcode = '22023';
  end if;

  select coalesce(max(f.versao), 0) + 1 into v_version
  from public.fechamentos_comissao f
  where f.periodo_id = p_period_id;

  insert into public.fechamentos_comissao (
    periodo_id, nome_periodo, data_inicio, data_fim, versao, status,
    fechado_por, fechado_em, observacao, ativo, criado_por
  ) values (
    v_period.id, v_period.nome_periodo, v_period.data_inicio, v_period.data_fim,
    v_version, 'FECHADO', v_actor.nome, now(),
    jsonb_build_object(
      'qtd_vendida', coalesce((p_summary->>'qtd_vendida')::numeric, 0),
      'qtd_financiada', coalesce((p_summary->>'qtd_financiada')::numeric, 0),
      'producao_total', coalesce((p_summary->>'producao_total')::numeric, 0),
      'retorno_total', coalesce((p_summary->>'retorno_total')::numeric, 0),
      'spf_total', coalesce((p_summary->>'spf_total')::numeric, 0),
      'linhas_snapshot', v_row_count,
      'comissao_total', coalesce((p_summary->>'comissao_total')::numeric, 0),
      'fechado_por_nome', v_actor.nome
    )::text,
    true, v_actor.nome
  )
  returning id into v_closing_id;

  -- Incidente Fechamento 1.0 -- contrato de persistencia corrigido para
  -- bater com o schema LIVE real de snapshot_comissoes (departamento,
  -- comissao) em vez das colunas inexistentes (status, comissao_principal,
  -- comissao_spf, comissao_total). "status" no payload sempre significou
  -- o departamento da linha (NOVOS/SEMINOVOS/GERENTE NOVOS/...), nunca o
  -- status da competencia -- esse mora em periodos_comissao.status e
  -- fechamentos_comissao.status, ja gravados corretamente acima/abaixo. A
  -- decomposicao comissao_principal/comissao_spf e preservada em
  -- detalhes (jsonb), ja que a tabela so tem 1 coluna de comissao final.
  insert into public.snapshot_comissoes (
    fechamento_id, periodo_id, nome_periodo, data_inicio, data_fim,
    nome, perfil, loja, departamento, vendidas, financiadas, share, producao,
    retorno, spf_extra, spf_liquido, rentabilidade_total, faixa,
    comissao, detalhes
  )
  select
    v_closing_id, v_period.id, v_period.nome_periodo,
    v_period.data_inicio, v_period.data_fim,
    nullif(trim(r.nome), ''), nullif(trim(r.perfil), ''),
    nullif(trim(r.loja), ''), nullif(trim(r.status), ''),
    coalesce(r.vendidas, 0), coalesce(r.financiadas, 0),
    coalesce(r.share, 0), coalesce(r.producao, 0),
    coalesce(r.retorno, 0), coalesce(r.spf_extra, 0),
    coalesce(r.spf_liquido, 0), coalesce(r.rentabilidade_total, 0),
    coalesce(r.faixa, 0), coalesce(r.comissao_total, 0),
    jsonb_build_object(
      'comissao_principal', coalesce(r.comissao_principal, 0),
      'comissao_spf', coalesce(r.comissao_spf, 0),
      'comissao_total', coalesce(r.comissao_total, 0)
    )
  from jsonb_to_recordset(p_rows) as r(
    nome text, perfil text, loja text, status text,
    vendidas numeric, financiadas numeric, share numeric, producao numeric,
    retorno numeric, spf_extra numeric, spf_liquido numeric,
    rentabilidade_total numeric, faixa numeric, comissao_principal numeric,
    comissao_spf numeric, comissao_total numeric
  );

  if (select count(*) from public.snapshot_comissoes s
      where s.fechamento_id = v_closing_id) <> v_row_count then
    raise exception 'O snapshot não foi gravado integralmente.'
      using errcode = 'P0001';
  end if;

  -- =========================================================================
  -- PM-6D.2 -- captura atomica do detalhe operacional suplementar
  -- (abas 5/6/7 do RH/DP). Estritamente ADITIVA a partir deste ponto --
  -- nenhuma linha/coluna acima foi alterada. NUNCA recalcula nem
  -- sobrescreve comissao/faixa/share/SPF liquido/rentabilidade oficiais
  -- (essas ja estao gravadas e verificadas acima). Qualquer excecao
  -- daqui em diante aborta a transacao inteira -- fechamento, snapshot
  -- financeiro e tudo mais sao revertidos junto (Gate 19/20/52/53/54).
  -- =========================================================================

  select id into v_sales_batch_id
  from public.portal_import_batches
  where status = 'VALIDATED' and source_type = 'SALES_CURRENT'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;

  select id into v_finance_batch_id
  from public.portal_import_batches
  where status = 'VALIDATED' and source_type = 'FINANCE_CURRENT'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;

  select id into v_spf_batch_id
  from public.portal_import_batches
  where status = 'VALIDATED' and source_type = 'SPF_CURRENT'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;

  -- Chamada direta, server-side, dentro da MESMA transacao -- nenhum
  -- parametro novo no frontend. auth.uid() permanece o do ator MASTER
  -- original atraves da cadeia SECURITY DEFINER aninhada.
  v_chassis_result := public.operational_salary_details(v_period.data_inicio, v_period.data_fim, null::uuid);
  if jsonb_typeof(coalesce(v_chassis_result->'rows', 'null'::jsonb)) <> 'array' then
    raise exception 'Detalhe operacional de chassi retornou em formato inesperado -- fechamento abortado.'
      using errcode = 'P0001';
  end if;

  v_spf_result := public.master_operational_spf_audit_period(v_period.data_inicio, v_period.data_fim);
  if jsonb_typeof(coalesce(v_spf_result->'rows', 'null'::jsonb)) <> 'array' then
    raise exception 'Auditoria SPF retornou em formato inesperado -- fechamento abortado.'
      using errcode = 'P0001';
  end if;

  insert into public.snapshot_operational_detail (
    fechamento_id, kind, store, department, seller_user_id, seller_name,
    sale_date, chassis_masked, vehicle_model, financed, finance_date,
    sale_value, financed_value, return_considered, included_in_commission
  )
  select
    v_closing_id, 'CHASSIS',
    nullif(r->>'store', ''), nullif(r->>'department', ''),
    nullif(r->>'seller_id', '')::uuid, nullif(r->>'seller_name', ''),
    nullif(r->>'date', '')::date, nullif(r->>'chassis_masked', ''),
    nullif(r->>'vehicle_model', ''),
    (r->>'financed')::boolean, nullif(r->>'finance_date', '')::date,
    coalesce((r->>'sale_value')::numeric, 0), coalesce((r->>'financed_value')::numeric, 0),
    coalesce((r->>'return_considered')::numeric, 0), (r->>'included_in_commission')::boolean
  from jsonb_array_elements(coalesce(v_chassis_result->'rows', '[]'::jsonb)) as r;

  v_chassis_row_count := jsonb_array_length(coalesce(v_chassis_result->'rows', '[]'::jsonb));
  if (select count(*) from public.snapshot_operational_detail d
      where d.fechamento_id = v_closing_id and d.kind = 'CHASSIS') <> v_chassis_row_count then
    raise exception 'O detalhe operacional de chassi não foi gravado integralmente.'
      using errcode = 'P0001';
  end if;

  insert into public.snapshot_operational_detail (
    fechamento_id, kind, store, department, seller_user_id, seller_name,
    operation_date, chassis_masked, operation_code, bank, finance_code,
    optional_name, spf_bruto, spf_liquido
  )
  select
    v_closing_id, 'SPF',
    nullif(r->>'store', ''), nullif(r->>'department', ''),
    nullif(r->>'seller_id', '')::uuid, nullif(r->>'seller_name', ''),
    nullif(r->>'operation_date', '')::date, nullif(r->>'chassis_masked', ''),
    nullif(r->>'operation_code', ''), nullif(r->>'bank', ''), nullif(r->>'finance_code', ''),
    nullif(r->>'optional_name', ''),
    coalesce((r->>'spf_bruto')::numeric, 0), coalesce((r->>'spf_liquido')::numeric, 0)
  from jsonb_array_elements(coalesce(v_spf_result->'rows', '[]'::jsonb)) as r;

  v_spf_row_count := jsonb_array_length(coalesce(v_spf_result->'rows', '[]'::jsonb));
  if (select count(*) from public.snapshot_operational_detail d
      where d.fechamento_id = v_closing_id and d.kind = 'SPF') <> v_spf_row_count then
    raise exception 'A auditoria SPF não foi gravada integralmente.'
      using errcode = 'P0001';
  end if;

  -- Hash de integridade sobre o pacote oficial completo (Gate 28-30):
  -- p_rows (financeiro, financial_result_authority) + detalhe CHASSIS +
  -- detalhe SPF + p_summary, nessa ordem, unidos por '|'. extensions.
  -- digest() -- pgcrypto ja instalado no projeto real, confirmado ao
  -- vivo nesta wave.
  v_hash := encode(
    extensions.digest(
      coalesce(p_rows::text, '') || '|' ||
      coalesce(v_chassis_result->'rows', '[]'::jsonb)::text || '|' ||
      coalesce(v_spf_result->'rows', '[]'::jsonb)::text || '|' ||
      coalesce(p_summary::text, ''),
      'sha256'
    ),
    'hex'
  );

  -- historical_detail_status='COMPLETE' SOMENTE agora, depois que TODAS
  -- as linhas de detalhe (inclusive zero linhas legitimas) e o hash ja
  -- foram calculados com sucesso (Gate 17/18).
  update public.fechamentos_comissao
  set sales_batch_id = v_sales_batch_id,
      finance_batch_id = v_finance_batch_id,
      spf_batch_id = v_spf_batch_id,
      snapshot_payload_hash = v_hash,
      commission_engine_version = v_engine_version,
      historical_detail_status = 'COMPLETE'
  where id = v_closing_id;

  -- =========================================================================
  -- Fim da captura suplementar PM-6D.2. Corpo original retomado sem
  -- alteracao a partir daqui.
  -- =========================================================================

  update public.periodos_comissao
  set status = 'FECHADO', atualizado_em = now()
  where id = v_period.id;

  insert into public.auditoria (
    tipo, descricao, base_origem, loja, vendedor, cpf, resolvido
  ) values (
    'FECHAMENTO_COMISSAO',
    'Competência fechada: ' || v_period.nome_periodo,
    'RPC master_close_commission_period',
    '', v_actor.nome, '', false
  );

  return jsonb_build_object(
    'status', 'OK',
    'closing_id', v_closing_id,
    'period_id', v_period.id,
    'version', v_version,
    'snapshot_rows', v_row_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.master_operational_spf_audit_period(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios;
  v_spf_net_percent numeric := 70;
  v_rows jsonb;
  v_count integer;
  v_total_bruto numeric;
  v_total_liquido numeric;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  select coalesce(
    case
      when replace(c.valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$'
        then replace(c.valor, ',', '.')::numeric
      else null
    end,
    70
  )
  into v_spf_net_percent
  from public.configuracoes c
  where c.chave = 'spf_liquido_percentual'
  limit 1;
  v_spf_net_percent := coalesce(v_spf_net_percent, 70);

  with
  -- Mesmo "lote oficial" usado em todas as RPCs analiticas certificadas:
  -- distinct on source_type, status=VALIDATED, mais recente por completed_at/created_at/id.
  latest_validated_batches as (
    select distinct on (b.source_type)
      b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT')
    order by
      b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  -- MASTER-only: sem restricao de loja/departamento (mesma logica de
  -- eligible_sellers das outras RPCs, com v_is_master sempre verdadeiro).
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, ''))) not in ('REVENDA', 'INATIVO', 'MASTER')
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
  ),
  -- Mesmo contrato de visible_finance de operational_metrics/operational_
  -- analyst_coverage_metrics: FINANCE_CURRENT+FINANCE_HISTORY do lote mais
  -- recente, filtrado pelo periodo, identidade resolvida via eligible_sellers.
  visible_finance as (
    select
      f.id, f.chassis, f.client_match_key, f.operation_date,
      es.id as effective_seller_id,
      es.name as seller_name,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer
      -- linha cujo store PROPRIO da operacao financeira seja REVENDA --
      -- ANTES do fallback resolve_store_temporal usado em effective_store
      -- acima.
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
  ),
  -- Mesmo padrao homologado de SPF (operational_metrics.spf_linked):
  -- portal_spf_operations, is_spf_extra=true, optional_value>0, join por
  -- client_match_key, restrito ao lote SPF_CURRENT mais recente.
  spf_matched as (
    select
      spf.id as spf_id,
      spf.operation_date,
      spf.operation_code,
      spf.bank,
      spf.finance_code,
      spf.optional_name,
      spf.optional_value,
      vf.effective_seller_id as seller_id,
      vf.seller_name,
      vf.effective_store as store,
      vf.department,
      vf.chassis,
      vf.id as finance_id
    from public.portal_spf_operations spf
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
    join visible_finance vf
      on vf.client_match_key = spf.client_match_key
    where spf.is_spf_extra
      and coalesce(spf.optional_value, 0) > 0
      -- Incidente REVENDA3 (Fase 2/7): protecao independente pelo store
      -- PROPRIO da linha SPF (leitura direta de portal_spf_operations) --
      -- mesmo que visible_finance ja exclua REVENDA por f.store, uma linha
      -- SPF REVENDA vinculada pelo MESMO client_match_key nunca deve
      -- alcancar a auditoria via este join.
      and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
  ),
  -- Dedup (Parte U): uma operacao SPF (spf.id) pode casar com mais de uma
  -- linha de visible_finance para o mesmo cliente (varios financiamentos
  -- no periodo) -- distinct on (spf_id) elege 1 vinculo representativo,
  -- desempate pelo financiamento mais recente, mesmo criterio "id desc"
  -- ja usado nos outros dedups desta familia. Nunca multiplica a mesma
  -- operacao SPF em mais de 1 linha da auditoria.
  spf_dedup as (
    select distinct on (spf_id)
      spf_id, operation_date, operation_code, bank, finance_code,
      optional_name, optional_value, seller_id, seller_name, store,
      department, chassis, finance_id
    from spf_matched
    order by spf_id, finance_id desc
  ),
  spf_rows as (
    select jsonb_agg(
      jsonb_build_object(
        'operation_date', d.operation_date,
        'seller_id', d.seller_id,
        'seller_name', d.seller_name,
        'store', d.store,
        'department', d.department,
        'chassis_masked', case
          when d.chassis is null or length(d.chassis) <= 6 then d.chassis
          else repeat('*', length(d.chassis) - 6) || right(d.chassis, 6)
        end,
        'operation_code', d.operation_code,
        'bank', d.bank,
        'finance_code', d.finance_code,
        'optional_name', d.optional_name,
        'spf_bruto', d.optional_value,
        'spf_liquido', round(d.optional_value * (v_spf_net_percent / 100), 2)
      )
      order by d.operation_date, d.seller_name, d.spf_id
    ) as rows
    from spf_dedup d
  )
  select
    coalesce(sr.rows, '[]'::jsonb),
    coalesce((select count(*) from spf_dedup), 0),
    coalesce((select sum(optional_value) from spf_dedup), 0),
    coalesce((select sum(round(optional_value * (v_spf_net_percent / 100), 2)) from spf_dedup), 0)
  into v_rows, v_count, v_total_bruto, v_total_liquido
  from spf_rows sr;

  return jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'spf_net_percent', v_spf_net_percent,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', true,
    'chassis_masking', 'last6',
    'total_operations', v_count,
    'total_spf_bruto', v_total_bruto,
    'total_spf_liquido', v_total_liquido,
    'rows', v_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.master_commission_operational_detail(p_closing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_status text;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  select f.historical_detail_status into v_status
  from public.fechamentos_comissao f
  where f.id = p_closing_id;

  if not found then
    raise exception 'Fechamento não encontrado.'
      using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'completeness', coalesce(v_status, 'LEGACY_PARTIAL'),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'kind', d.kind,
          'store', d.store,
          'department', d.department,
          'seller_user_id', d.seller_user_id,
          'seller_name', d.seller_name,
          'sale_date', d.sale_date,
          'chassis_masked', d.chassis_masked,
          'vehicle_model', d.vehicle_model,
          'financed', d.financed,
          'finance_date', d.finance_date,
          'sale_value', d.sale_value,
          'financed_value', d.financed_value,
          'return_considered', d.return_considered,
          'included_in_commission', d.included_in_commission,
          'operation_date', d.operation_date,
          'operation_code', d.operation_code,
          'bank', d.bank,
          'finance_code', d.finance_code,
          'optional_name', d.optional_name,
          'spf_bruto', d.spf_bruto,
          'spf_liquido', d.spf_liquido
        )
        order by d.kind, d.store, d.department, d.seller_name, d.sale_date, d.operation_date, d.chassis_masked
      )
      from public.snapshot_operational_detail d
      where d.fechamento_id = p_closing_id
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_analyst_commission_metrics(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_spf_net_percent numeric := 70;
  v_result jsonb;
begin
  if exists (
    select 1
    from public.ausencias_analistas a
    join public.ausencias_analistas b
      on b.id <> a.id
     and upper(trim(b.loja_coberta)) = upper(trim(a.loja_coberta))
     and b.ativo = true
     and a.ativo = true
     and daterange(b.data_inicio, b.data_fim, '[]')
         && daterange(a.data_inicio, a.data_fim, '[]')
    where a.data_inicio <= p_end
      and a.data_fim >= p_start
  ) then
    raise exception
      'Existem ausencias sobrepostas para a mesma loja no periodo.'
      using errcode = '22023';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_store := v_scope->>'store';
  v_departments := array(
    select jsonb_array_elements_text(v_scope->'departments')
  );
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  -- Incidente P1 Autorizacao-Comissoes 1.0 (Parte Q/R/S) -- fail-closed:
  -- somente MASTER e o proprio ANALISTA podem receber linhas de comissao
  -- por Analista. Vendedor, Gerente e Diretor (Parte N: Diretor NAO ve
  -- Analista) nunca -- antes deste gate, a funcao computava e devolvia
  -- nome real + totais do Analista para QUALQUER perfil chamador, e a
  -- unica protecao era o frontend esconder a secao (podeVerAnalista).
  if not (v_is_master or v_profile = 'ANALISTA') then
    return jsonb_build_object(
      'period_start', p_start,
      'period_end', p_end,
      'absence_aware', true,
      'contains_personal_documents', false,
      'contains_client_identity', false,
      'contains_chassis', false,
      'rows', '[]'::jsonb
    );
  end if;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  select coalesce(
    case
      when replace(c.valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$'
        then replace(c.valor, ',', '.')::numeric
      else null
    end,
    70
  )
  into v_spf_net_percent
  from public.configuracoes c
  where c.chave = 'spf_liquido_percentual'
  limit 1;

  v_spf_net_percent := coalesce(v_spf_net_percent, 70);

  with
  windows as (
    select 'BASE'::text as window_id, p_start as w_start, p_end as w_end
    union all
    select a.id::text, greatest(a.data_inicio, p_start), least(a.data_fim, p_end)
    from public.ausencias_analistas a
    where a.ativo = true
      and a.data_inicio <= p_end
      and a.data_fim >= p_start
  ),
  latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(u.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(u.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (v_is_seller and u.id = v_user_id)
            or (
              not v_is_seller
              -- loja vigente (13/10/2026): o recorte por loja é feito em cada fato, pela loja vigente na data (abaixo), não pela loja do cadastro
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, ''))) not in ('REVENDA', 'INATIVO', 'MASTER')
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(ps.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(ps.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (
              not v_is_seller
              -- loja vigente (13/10/2026): o recorte por loja é feito em cada fato, pela loja vigente na data (abaixo), não pela loja do cadastro
            )
          )
        )
      )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do join a
    -- eligible_sellers (visible_sales_env, abaixo) e ANTES do fallback
    -- resolve_store_temporal usado na coluna "store" acima. Nunca por
    -- chassi -- mesmo principio do Incidente REVENDA2 (T34887).
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales_env as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
      -- loja vigente (13/10/2026): s.store já é a loja vigente na data da venda
      and (coalesce(v_is_master, false) or coalesce(v_is_director, false) or coalesce(v_is_seller, false) or upper(trim(s.store)) = v_store)
      -- Incidente IA-1B: mesmo principio do IA-1A -- para DIRETOR, autorizacao
      -- vale sobre o departamento EFETIVO (temporal) do fato. Esta funcao
      -- agrega por LOJA (nao expoe "department" no output), mas o vazamento
      -- e o mesmo: fatos fora do departamento do DIRETOR contaminando o
      -- total da loja. No-op para MASTER/GERENTE/ANALISTA/VENDEDOR
      -- (v_is_director sempre false) -- nao afeta calculo real de comissao.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, s.sale_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  visible_finance_env as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      -- loja vigente (13/10/2026): mesma loja efetiva usada em effective_store, acima
      and (coalesce(v_is_master, false) or coalesce(v_is_director, false) or coalesce(v_is_seller, false) or upper(trim(coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA'))) = v_store)
      -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer linha
      -- cujo store PROPRIO da operacao financeira seja REVENDA -- ANTES do
      -- fallback resolve_store_temporal usado em effective_store acima.
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
      -- Incidente IA-1B: mesmo gate de visible_sales_env -- fecha finance e,
      -- por derivacao (spf_by_window faz join a visible_finance_env), SPF
      -- tambem.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  sales_by_window as (
    select
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA') as store,
      count(*)::integer as sold_count
    from windows w
    join visible_sales_env vs
      on vs.sale_date between w.w_start and w.w_end
    join eligible_sellers es on es.id = vs.seller_id
    group by
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA')
  ),
  finance_by_window as (
    select
      w.window_id,
      vf.*
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
  ),
  principal_finance_bw as (
    select *
    from finance_by_window
    where is_real_financing
  ),
  later_return_bw as (
    select distinct on (
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from finance_by_window
    where is_later_return
    order by
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance_bw as (
    select * from principal_finance_bw
    union all
    select lr.*
    from later_return_bw lr
    where not exists (
      select 1
      from principal_finance_bw pf
      where pf.id = lr.id
        and pf.window_id = lr.window_id
    )
  ),
  finance_metrics_bw as (
    select
      window_id,
      seller_id,
      effective_store as store,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2) as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance_bw
    group by window_id, seller_id, effective_store
  ),
  spf_by_window as (
    select distinct
      w.window_id,
      vf.seller_id,
      vf.effective_store as store,
      spf.id,
      spf.optional_value
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- Incidente REVENDA3 (Fase 2/7): protecao independente pelo store
     -- PROPRIO da linha SPF (leitura direta de portal_spf_operations) --
     -- mesmo padrao de dupla protecao do Incidente REVENDA2: mesmo que
     -- visible_finance_env ja exclua REVENDA por f.store, uma linha SPF
     -- REVENDA vinculada pelo MESMO client_match_key de um cliente
     -- legitimo nunca deve alcancar a agregacao via este join intermediario.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics_bw as (
    select
      window_id,
      seller_id,
      store,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_by_window
    group by window_id, seller_id, store
  ),
  window_store_totals as (
    select
      sw.window_id,
      sw.store,
      sum(sw.sold_count)::integer as sold_count,
      sum(coalesce(fm.financed_count, 0))::integer as financed_count,
      sum(coalesce(fm.production_value, 0))::numeric(18,2) as production_value,
      sum(coalesce(fm.return_value, 0))::numeric(18,2) as return_value,
      sum(coalesce(spm.spf_count, 0))::integer as spf_count,
      sum(coalesce(spm.spf_value, 0))::numeric(18,2) as spf_value
    from sales_by_window sw
    left join finance_metrics_bw fm
      on fm.window_id = sw.window_id
     and fm.seller_id = sw.seller_id
     and fm.store = sw.store
    left join spf_metrics_bw spm
      on spm.window_id = sw.window_id
     and spm.seller_id = sw.seller_id
     and spm.store = sw.store
    group by sw.window_id, sw.store
  ),
  base_store_totals as (
    select store, sold_count, financed_count, production_value, return_value, spf_count, spf_value
    from window_store_totals
    where window_id = 'BASE'
  ),
  eligible_absence_windows as (
    select
      w.window_id as absence_id,
      w.w_start as covered_start,
      w.w_end as covered_end,
      a.nome_analista_substituto as analyst_name,
      bst.store
    from windows w
    join public.ausencias_analistas a on a.id::text = w.window_id
    join base_store_totals bst
      on upper(trim(bst.store)) = upper(trim(a.loja_coberta))
    where w.window_id <> 'BASE'
  ),
  absence_metrics as (
    select
      eaw.absence_id as id,
      eaw.store,
      eaw.analyst_name,
      eaw.covered_start,
      eaw.covered_end,
      coalesce(wst.sold_count, 0)::integer as sold_count,
      coalesce(wst.financed_count, 0)::integer as financed_count,
      coalesce(wst.production_value, 0)::numeric(18,2) as production_value,
      coalesce(wst.return_value, 0)::numeric(18,2) as return_value,
      coalesce(wst.spf_count, 0)::integer as spf_count,
      coalesce(wst.spf_value, 0)::numeric(18,2) as spf_value
    from eligible_absence_windows eaw
    left join window_store_totals wst
      on wst.window_id = eaw.absence_id
     and upper(trim(wst.store)) = upper(trim(eaw.store))
  ),
  absence_sums as (
    select
      store,
      sum(sold_count)::integer as sold_count,
      sum(financed_count)::integer as financed_count,
      sum(production_value)::numeric(18,2) as production_value,
      sum(return_value)::numeric(18,2) as return_value,
      sum(spf_count)::integer as spf_count,
      sum(spf_value)::numeric(18,2) as spf_value
    from absence_metrics
    group by store
  ),
  official_rows as (
    select
      coalesce(
        (
          select u.nome
          from public.usuarios u
          where u.ativo = true
            and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
            and upper(trim(coalesce(u.loja, ''))) =
                upper(trim(coalesce(st.store, '')))
          order by u.nome
          limit 1
        ),
        'ANALISTA NAO LOCALIZADO'
      ) as analyst_name,
      st.store,
      greatest(st.sold_count - coalesce(a.sold_count, 0), 0)::integer
        as sold_count,
      greatest(st.financed_count - coalesce(a.financed_count, 0), 0)::integer
        as financed_count,
      greatest(st.production_value - coalesce(a.production_value, 0), 0)
        ::numeric(18,2) as production_value,
      greatest(st.return_value - coalesce(a.return_value, 0), 0)
        ::numeric(18,2) as return_value,
      greatest(st.spf_count - coalesce(a.spf_count, 0), 0)::integer
        as spf_count,
      greatest(st.spf_value - coalesce(a.spf_value, 0), 0)
        ::numeric(18,2) as spf_value,
      false as transfer,
      null::date as covered_start,
      null::date as covered_end,
      null::text as coverage_id
    from base_store_totals st
    left join absence_sums a on a.store = st.store
  ),
  combined_rows as (
    select * from official_rows
    union all
    select
      analyst_name,
      store,
      sold_count,
      financed_count,
      production_value,
      return_value,
      spf_count,
      spf_value,
      true as transfer,
      covered_start,
      covered_end,
      id as coverage_id
    from absence_metrics
  )
  select jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'absence_aware', true,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'rows',
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'analyst_name', analyst_name,
            'store', store,
            'sold_count', sold_count,
            'financed_count', financed_count,
            'production_value', production_value,
            'return_value', return_value,
            'spf_count', spf_count,
            'spf_value', spf_value,
            'transfer', transfer,
            'covered_start', covered_start,
            'covered_end', covered_end,
            'coverage_id', coverage_id
          )
          order by store, transfer, covered_start, analyst_name
        ),
        '[]'::jsonb
      )
  )
  into v_result
  from combined_rows
  where sold_count > 0
     or financed_count > 0
     or return_value > 0
     or spf_value > 0;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_analyst_coverage_metrics(p_start date, p_end date, p_store text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_rows jsonb;
begin
  select *
  into v_user
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
    and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
  limit 1;

  if v_user.id is null then
    raise exception 'Acesso restrito a analista ativo.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.ausencias_analistas a
    where a.ativo = true
      and regexp_replace(coalesce(a.cpf_analista_substituto, ''), '\D', '', 'g')
          = regexp_replace(
              coalesce(v_user.cpf_normalizado, v_user.cpf, ''),
              '\D',
              '',
              'g'
            )
      and upper(trim(a.loja_coberta)) = upper(trim(p_store))
      and p_start >= a.data_inicio
      and p_end <= a.data_fim
  ) then
    raise exception 'Loja ou periodo fora da cobertura autorizada.'
      using errcode = '42501';
  end if;

  with
  latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      -- loja vigente (13/10/2026): sem filtro pela loja do cadastro; visible_sales/visible_finance já recortam cada fato pela loja vigente = p_store
      and (
        (
          upper(trim(coalesce(u.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_user.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(u.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_user.status, '')) like '%SEMINOVOS%'
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, ''))) not in (
        'REVENDA', 'INATIVO', 'MASTER'
      )
      -- loja vigente (13/10/2026): idem, cadastro legado
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        (
          upper(trim(coalesce(ps.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_user.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(ps.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_user.status, '')) like '%SEMINOVOS%'
        )
      )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do join a
    -- eligible_sellers (visible_sales, abaixo) e ANTES do fallback
    -- resolve_store_temporal usado na coluna "store" acima.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
      and upper(trim(coalesce(s.store, ''))) = upper(trim(p_store))
  ),
  sales_metrics as (
    select
      es.id as seller_id,
      count(*)::integer as sold_count
    from visible_sales vs
    join eligible_sellers es on es.id = vs.seller_id
    group by es.id
  ),
  visible_finance as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and upper(trim(coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, ''))) =
          upper(trim(p_store))
      -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer
      -- linha cujo store PROPRIO da operacao financeira seja REVENDA --
      -- protecao independente da comparacao acima (que usa o valor
      -- resolvido, ja com fallback aplicado).
      and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
  ),
  principal_finance as (
    select * from visible_finance where is_real_financing
  ),
  later_return as (
    select distinct on (
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from visible_finance
    where is_later_return
    order by
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance as (
    select * from principal_finance
    union all
    select lr.*
    from later_return lr
    where not exists (
      select 1 from principal_finance pf where pf.id = lr.id
    )
  ),
  finance_metrics as (
    select
      seller_id,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance
    group by seller_id
  ),
  spf_linked as (
    select distinct
      vf.seller_id,
      spf.id,
      spf.optional_value
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- Incidente REVENDA3 (Fase 2/7): protecao independente pelo store
     -- PROPRIO da linha SPF (leitura direta de portal_spf_operations) --
     -- mesmo que visible_finance ja exclua REVENDA por f.store, uma linha
     -- SPF REVENDA vinculada pelo MESMO client_match_key nunca deve
     -- alcancar a agregacao via este join intermediario.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics as (
    select
      seller_id,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_linked
    group by seller_id
  ),
  metrics as (
    select
      sum(sm.sold_count)::integer as sold_count,
      coalesce(sum(fm.financed_count), 0)::integer as financed_count,
      coalesce(sum(fm.production_value), 0)::numeric(18,2) as production_value,
      coalesce(sum(fm.return_value), 0)::numeric(18,2) as return_value,
      coalesce(sum(spm.spf_count), 0)::integer as spf_count,
      coalesce(sum(spm.spf_value), 0)::numeric(18,2) as spf_value
    from sales_metrics sm
    left join finance_metrics fm on fm.seller_id = sm.seller_id
    left join spf_metrics spm on spm.seller_id = sm.seller_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'analyst_name', v_user.nome,
        'store', p_store,
        'sold_count', sold_count,
        'financed_count', financed_count,
        'production_value', production_value,
        'return_value', return_value,
        'spf_count', spf_count,
        'spf_value', spf_value,
        'transfer', true,
        'covered_start', p_start,
        'covered_end', p_end
      )
    ) filter (where sold_count > 0),
    '[]'::jsonb
  )
  into v_rows
  from metrics;

  return v_rows;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_salary_manager_directory(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_is_master boolean;
  v_is_director boolean;
  v_rows jsonb;
  v_ambiguous integer;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Periodo maximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(
    select upper(trim(jsonb_array_elements_text(v_scope->'departments')))
  );
  v_is_master := coalesce((v_scope->>'is_master')::boolean, false);
  v_is_director := coalesce((v_scope->>'is_director')::boolean, false);

  -- RH (perfil corporativo): lê Salários & Comissões de todo o grupo -- todas as
  -- lojas, NOVOS e SEMINOVOS -- com o mesmo alcance de leitura do diretor. Só
  -- muda algo quando o perfil resolvido por operational_current_scope() é 'RH'.
  v_is_director := coalesce(v_is_director, false) or (v_scope->>'profile') = 'RH';

  with manager_departments as (
    select
      u.id,
      trim(u.nome) as manager_name,
      upper(trim(coalesce(u.loja, ''))) as store,
      upper(trim(department.value)) as department
    from public.usuarios u
    cross join lateral regexp_split_to_table(
      regexp_replace(
        upper(trim(coalesce(u.status, ''))),
        '^GERENTE[[:space:]]+',
        ''
      ),
      '[[:space:]]*/[[:space:]]*'
    ) as department(value)
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'GERENTE'
  ),
  authorized as (
    select md.*
    from manager_departments md
    where md.department in ('NOVOS', 'SEMINOVOS')
      and (
        v_is_master
        or (
          md.department = any(v_departments)
          and (
            v_is_director
            or md.store = upper(trim(coalesce(v_store, '')))
          )
        )
      )
  ),
  selected as (
    select
      a.store,
      a.department,
      string_agg(
        distinct a.manager_name,
        ' / ' order by a.manager_name
      ) as manager_name
    from authorized a
    group by a.store, a.department
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'store', s.store,
        'department', s.department,
        'manager_name', s.manager_name
      ) order by s.store, s.department
    ),
    '[]'::jsonb
  )
  into v_rows
  from selected s;

  with manager_departments as (
    select
      upper(trim(coalesce(u.loja, ''))) as store,
      upper(trim(department.value)) as department
    from public.usuarios u
    cross join lateral regexp_split_to_table(
      regexp_replace(
        upper(trim(coalesce(u.status, ''))),
        '^GERENTE[[:space:]]+',
        ''
      ),
      '[[:space:]]*/[[:space:]]*'
    ) as department(value)
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'GERENTE'
  )
  select count(*)::integer
  into v_ambiguous
  from (
    select md.store, md.department
    from manager_departments md
    where md.department in ('NOVOS', 'SEMINOVOS')
    group by md.store, md.department
    having count(*) > 1
  ) duplicates;

  return jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'assignment_source', 'ACTIVE_PORTAL_PROFILE',
    'rows', v_rows,
    'ambiguous_assignments', coalesce(v_ambiguous, 0),
    'contains_client_identity', false,
    'contains_personal_documents', false,
    'contains_operational_identifiers', false
  );
end;
$function$;

alter table public.snapshot_comissoes drop column if exists usuario_id;
alter table public.snapshot_operational_detail drop column if exists conta_na_comissao;

commit;

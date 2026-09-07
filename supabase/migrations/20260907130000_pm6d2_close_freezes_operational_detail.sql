-- PM-6D.2 -- RH/DP Historical Immutability: fechamento agora congela
-- ATOMICAMENTE, na MESMA transacao/chamada, o detalhe operacional
-- (chassi + auditoria SPF) e a provenance/hash/versao ja preparados
-- pela fundacao aditiva da PM-6D.1 (supabase/migrations/20260907120000_
-- pm6d1_snapshot_operational_detail_foundation.sql).
--
-- ASSINATURA INALTERADA (Gate 43): p_period_id uuid, p_summary jsonb,
-- p_rows jsonb -- nenhuma quebra de compatibilidade V1/V2. RETORNO
-- INALTERADO (Gate 44): mesmo shape {status, closing_id, period_id,
-- version, snapshot_rows}. FINANCIAL_RESULT_AUTHORITY continua sendo
-- snapshot_comissoes -- nenhuma linha, formula ou validacao financeira
-- pre-existente foi alterada; todo o corpo ate a linha do UPDATE de
-- periodos_comissao e uma copia byte-a-byte do corpo real vigente
-- (fingerprint capturado ao vivo nesta wave, PM-6D.2 Gate 46), com
-- APENAS uma secao nova inserida entre a verificacao de integridade do
-- snapshot financeiro e o UPDATE de periodos_comissao.
--
-- ARQUITETURA (Gate 10, resolvida): o proprio close RPC chama
-- diretamente, server-side, dentro da MESMA transacao,
-- operational_salary_details(v_period.data_inicio, v_period.data_fim,
-- null) e master_operational_spf_audit_period(v_period.data_inicio,
-- v_period.data_fim) -- nenhum parametro novo no frontend, nenhuma
-- segunda chamada de RPC do browser. auth.uid() e uma configuracao de
-- sessao (nao de role), entao permanece o do ATOR MASTER real original
-- atraves de toda a cadeia de chamadas SECURITY DEFINER aninhadas --
-- confirmado ao vivo nesta wave via teste sintetico com
-- BEGIN/ROLLBACK genuino contra o banco real (ver relatorio da wave).
--
-- ATOMICIDADE (Gate 15/19/20): se qualquer uma das duas RPCs de fonte
-- falhar (RAISE EXCEPTION) ou retornar um shape inesperado (nao
-- array), a excecao nao tratada aborta toda a transacao da funcao --
-- nenhum fechamento, nenhum snapshot financeiro, nenhum detalhe
-- operacional e gravado. O mesmo vale para falha no calculo do hash.
--
-- PROVENANCE (Gate 11/12): sales_batch_id/finance_batch_id/spf_batch_id
-- sao resolvidos DENTRO da mesma transacao, imediatamente antes de
-- cada chamada as RPCs de fonte -- garantindo que o metadado de
-- diagnostico corresponde ao MESMO lote que efetivamente gerou o
-- detalhe gravado (nunca uma leitura posterior desincronizada).
-- Simplificacao documentada: cada *_batch_id captura o lote
-- VALIDATED mais recente do source_type "*_CURRENT" respectivo
-- (SALES_CURRENT/FINANCE_CURRENT/SPF_CURRENT) -- as RPCs de fonte
-- tambem usam *_HISTORY quando aplicavel, mas esse metadado e
-- estritamente diagnostico (nunca mecanismo de reconstrucao, PM-6C
-- achado real sobre nao-imutabilidade de linha dentro de um batch),
-- entao um unico id representativo por fonte e suficiente para seu
-- proposito real.
--
-- historical_detail_status='COMPLETE' e gravado SOMENTE depois que
-- TODAS as linhas de detalhe operacional (inclusive zero linhas
-- legitimas) ja foram persistidas (Gate 17/18) -- nunca antes.
--
-- HASH (Gate 28-30): snapshot_payload_hash = SHA-256 hex de
-- p_rows::text || '|' || <chassis rows>::text || '|' || <spf rows>::text
-- || '|' || p_summary::text -- via pgcrypto.digest(), ja instalado no
-- projeto real (extensions.pgcrypto, confirmado ao vivo nesta wave).
-- Contrato explicito: este hash prova que o pacote gravado para ESTE
-- fechamento especifico nao foi corrompido depois -- ele NAO e uma
-- funcao de igualdade canonica entre dois payloads construidos
-- independentemente (Gate 33: integridade, nao autoridade/reconstrucao).
--
-- commission_engine_version: constante explicita 'commission-secure-v1'
-- -- nenhuma versao formal preexistia no projeto (auditado, Gate 26);
-- representa a formula SECURE atual (commissionCalc/calcGestorFIGrupo,
-- portal-app.js) tal como reconciliada desde PM-5I/5J. Puramente
-- metadado -- nao altera calculo algum (Gate 27).

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

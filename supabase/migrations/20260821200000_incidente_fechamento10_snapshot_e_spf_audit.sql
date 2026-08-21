-- Incidente Fechamento de Competencia 1.0 + Auditoria SPF Segura.
--
-- =========================================================================
-- PROBLEMA 1: master_close_commission_period tentava INSERT em
-- snapshot_comissoes.status / .comissao_principal / .comissao_spf /
-- .comissao_total -- colunas que nao existem no schema LIVE real
-- (departamento, comissao). Causa raiz comprovada por leitura de dados:
-- os 2 fechamentos historicos "bem-sucedidos" (21/05-20/06, 21/06-20/07,
-- 95 linhas cada) tinham 100% das linhas com departamento=NULL e
-- comissao=0 -- uma versao ANTERIOR da funcao ja estava com nomes de
-- campo do jsonb_to_recordset desalinhados do payload real (silencioso,
-- nunca erro). Uma tentativa de correcao trocou os nomes de campo para
-- bater com o payload, mas tambem trocou por engano a lista de colunas-
-- alvo do INSERT, criando o erro visivel atual.
--
-- FIX: "status" do payload (que sempre significou departamento da linha,
-- nunca status da competencia -- esse mora em periodos_comissao.status e
-- fechamentos_comissao.status, ja corretos) agora grava em departamento.
-- comissao_principal/comissao_spf/comissao_total (3 campos do payload)
-- agora colapsam em comissao (= comissao_total) + detalhes jsonb
-- (preserva a decomposicao, unica coluna que ja suportava isso).
--
-- Validacao minima adicionada (Parte E): rejeita nome/perfil vazio ou
-- fora do conjunto real (VENDEDOR/GERENTE/ANALISTA/GESTOR F&I) e
-- comissao negativa/NaN, ANTES de qualquer INSERT -- confirmado que a
-- funcao continua atomica mesmo com a validacao nova (0 linhas gravadas
-- quando rejeitada).
--
-- TESTADO em transacao com ROLLBACK, usando o PAYLOAD REAL gerado pelo
-- proprio frontend (calcularPreviewFechamentoCompetenciaSegura +
-- snapshotRowsPayload, executados sem modificacao via Playwright com
-- estado real capturado das RPCs operational_commission_metrics,
-- operational_analyst_commission_metrics_v2, operational_salary_manager_
-- directory e master_admin_security_data), para a competencia real
-- 21/07-20/08/2026 (periodo_id 7b57561c-9048-4426-9850-a4abf8476f3c):
--   - 97 linhas no payload (68 vendedores + 15 gerentes + 13 analistas/
--     coberturas + 1 Gestor F&I) -> 97 linhas gravadas no snapshot.
--   - departamento_null_count = 0 (era 100% antes).
--   - comissao gravada = comissao_total do payload em TODAS as 97 linhas
--     (diferenca R$0,00, verificado linha a linha por nome+loja+perfil+
--     departamento).
--   - periodos_comissao.status e fechamentos_comissao.status = FECHADO.
--   - Sentinelas confirmados: Wesley, Fernanda, Giovanna (4 linhas: 1
--     propria + 3 coberturas), Denise (2), Jacenir (3) -- todos com
--     departamento/vendidas/financiadas/producao/retorno/comissao
--     batendo com a fonte oficial.
--   - Segunda chamada no mesmo periodo (mesma transacao): bloqueada com
--     "Este periodo ja possui fechamento ativo.", 0 linhas adicionais em
--     snapshot_comissoes e fechamentos_comissao (idempotencia + zero
--     duplicacao confirmadas).
--   - Payload com perfil invalido: rejeitado, 0 linhas gravadas.
--   - Payload com comissao negativa: rejeitado, 0 linhas gravadas.
-- ROLLBACK confirmado -- nenhum dado real foi alterado; a competencia
-- 21/07-20/08 continua EM CONFERENCIA apos esta migration. O fechamento
-- real sera executado manualmente pelo usuario, fora desta fase.
--
-- BACKLOG CRITICO (nao tratado nesta fase, Parte AF): os 2 fechamentos
-- historicos (21/05-20/06 id 82190f87, 21/06-20/07 id 6429b00d) tem 190
-- linhas de snapshot com departamento=NULL e comissao=0 -- tecnicamente
-- invalidas. Precisam de reconstrucao/certificacao historica separada,
-- fora do escopo desta correcao (nao foi feito UPDATE/DELETE nelas).
--
-- =========================================================================
-- PROBLEMA 2: aba "7_AUDITORIA_SPF" da Previa RH/DP nao tinha
-- implementacao em modo seguro (Fase C.2-D nunca concluida) -- gerava
-- so um aviso placeholder. O unico RPC candidato existente
-- (master_operational_list_spf_extra_base02) foi comprovado inadequado:
-- sem filtro de periodo, chassi/client_match_key sem mascara, e usa
-- portal_finance_operations.is_spf em vez do padrao canonico
-- portal_spf_operations.is_spf_extra + client_match_key ja homologado em
-- operational_metrics/operational_commission_metrics.
--
-- FIX: nova RPC dedicada, read-only, MASTER-only,
-- master_operational_spf_audit_period(p_start, p_end) -- mesmo padrao de
-- lote validado + resolve_store_temporal/resolve_department_temporal +
-- join SPF via client_match_key das outras RPCs certificadas. Chassi
-- mascarado (last6), sem CPF/nome/telefone/e-mail de cliente,
-- client_match_key nunca exposto.
--
-- TESTADO: reconciliacao 1:1 com operational_commission_metrics.totals
-- para 21/07-20/08 (38 operacoes, R$118.609,10 bruto, R$83.026,37
-- liquido -- diferenca R$0,00) via chamada live real (MASTER, read-
-- only). Excel gerado ponta a ponta (Playwright real, XLSX.writeFile
-- interceptado): aba 7_AUDITORIA_SPF com 38 linhas reais, 0
-- duplicidade, 0 chassi sem mascara, 0 coluna sensivel, soma bruto/
-- liquido batendo exatamente com a RPC.
--
-- Grants: authenticated + service_role apenas, anon/PUBLIC revogados
-- explicitamente.
-- =========================================================================

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

revoke all on function public.master_operational_spf_audit_period(date, date) from public, anon;
grant execute on function public.master_operational_spf_audit_period(date, date) to authenticated, service_role;

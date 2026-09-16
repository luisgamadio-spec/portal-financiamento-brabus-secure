-- Incidente REVENDA-2: exclusao operacional de REVENDA + blindagem de
-- heranca de identidade no reconciliador de importacao (causa raiz do
-- incidente do chassi 93XHTGK1WVCT34887).
--
-- ESCOPO DESTA ONDA (ja decidido e reportado ao usuario antes desta
-- migracao -- nao relitigado aqui):
--   1. public.operational_fandi_dashboard      (Gestao)
--   2. public.operational_salary_details        (Salarios & Comissoes)
--   3. public.master_operational_import_sales /
--      public.master_operational_import_finance (raiz: heranca de
--      identidade por chassi/chassi+service_description)
--
-- FORA DE ESCOPO (autoridade canonica divergiu para a IA3B, ja
-- confirmado e reportado -- NAO tocado aqui):
--   - public.operational_metrics / public.operational_model_metrics*
--     (autoridade canonica mais nova so existe em
--     supabase/migrations/20260914150000_sec1f2_gerente_group_view_fix.sql
--     do repo IA3B -- este repo so tem ate 20260824020000)
--   - public.operational_score_coparticipated_data
--     (autoridade canonica mais nova so existe em
--     20260913200000_sec1d1_score_group_view.sql e
--     20260913201500_sec1d1_score_seller_own_gate.sql do repo IA3B --
--     este repo so tem ate 20260827180000)
--   Ambas permanecem SEM a exclusao de REVENDA desta onda. Requerem uma
--   onda separada tendo o repo IA3B como base.
--
-- ============================================================
-- FASE 2 -- EXCLUSAO OPERACIONAL DE REVENDA (fandi_dashboard + salary_details)
-- ============================================================
-- Auditoria ao vivo, somente leitura, confirmou 2.476 linhas em
-- portal_sales com store='REVENDA' (199 chassis distintos) e ZERO
-- variantes de normalizacao (caixa/espaco/acento) da string "REVENDA" na
-- base hoje -- uma comparacao exata upper(trim()) e suficiente, no mesmo
-- estilo ja usado em todo o codebase (ex. upper(trim(coalesce(ps.status,
-- ''))) nas CTEs eligible_sellers abaixo, inalteradas por este patch).
--
-- PRECEDENTE LIDO E SEGUIDO (mesmo estilo de predicado, mesmo campo):
-- supabase/migrations/20260910180000_perf5d1b_revenda_ranking_exclusion.sql
-- ("H10 -- REVENDA fora do escopo do Ranking de Performance de
-- Analistas"), linha 85: normaliza com
-- upper(btrim(coalesce(p_loja_canonica, ''))) e compara a string exata
-- 'REVENDA'; linha 161 comenta "a loja canonica final decide a
-- elegibilidade... nunca entra no universo do Ranking" -- REVENDA e
-- AUSENCIA do universo elegivel, nao zero pontos/zero valor. Adota-se
-- aqui o MESMO principio (ausencia do universo, nao "zerar" a linha) e o
-- MESMO estilo de normalizacao (upper+trim/btrim sobre coalesce('')),
-- adaptado ao alias real de cada FROM-clause deste incidente (s./f./spf.,
-- ver abaixo) em vez de reusar a funcao performance_loja_fora_de_escopo_
-- ranking() -- essa funcao e as tabelas do Ranking foram REMOVIDAS por
-- supabase/migrations/20260910230000_retire_analyst_performance_ranking.sql
-- (aposentadoria do Ranking, decisao do Humano) e nunca foram uma camada
-- compartilhada: eram exclusivas do motor do Ranking, ja documentado como
-- "SOMENTE RANKING... nao se aplica a Salario, Score, Coparticipado,
-- Intelligence ou qualquer outro dominio" no proprio cabecalho daquela
-- migracao. Reconstruir a exclusao aqui, diretamente nas 2 RPCs deste
-- incidente, e portanto o unico caminho seguro e consistente com o estilo
-- ja estabelecido.
--
-- PREDICADO CANONICO (identico nas 2 RPCs, adaptado ao alias local):
--   upper(trim(coalesce(<alias>.store, ''))) <> 'REVENDA'
-- Aplicado no campo PROPRIO da linha/transacao (nunca por chassi -- uma
-- venda legitima NOVOS e uma linha REVENDA podem compartilhar o mesmo
-- chassi colidido, exatamente o padrao do T34887; excluir por chassi
-- apagaria a venda legitima junto). Aplicado na CTE base de leitura, ANTES
-- de qualquer join a eligible_sellers e ANTES de qualquer fallback
-- resolve_store_temporal.
--
-- operational_fandi_dashboard: NAO le portal_sales nem
-- portal_finance_operations (confirmado lendo a funcao inteira) -- a
-- unica tabela-base e portal_spf_operations (alias s, CTE source_rows).
-- Predicado aplicado sobre coalesce(s.store, sc.ctx_store, ''), a MESMA
-- expressao ja usada pela canonicalizacao logo abaixo (spf_context supre
-- ctx_store para linhas SPF EXTRA sem store proprio, a partir da linha
-- irma do MESMO cliente/data) -- garante que a exclusao rode ANTES da
-- canonicalizacao/fallback 'NAO INFORMADO' (Fase 6), nao depois.
--
-- operational_salary_details: le portal_sales (2 CTEs independentes --
-- sales_global_ranked, para as linhas exibidas, e ranked, para o total
-- v_total_rows -- ambas corrigidas), portal_finance_operations (via
-- finance_by_sale e via spf_links, as duas vinculadas por CHASSI a partir
-- de visible_sales, sem gate de store proprio ate este patch) e
-- portal_spf_operations (via spf_links). Fase 7: como finance_by_sale e
-- spf_links juntam portal_finance_operations por s.chassis = vs.chassis
-- (sem comparar store), uma linha financeira REVENDA do MESMO chassi de
-- uma venda NOVOS legitima entraria na agregacao da venda legitima mesmo
-- com sales_global_ranked/visible_sales ja corrigidas -- exatamente o
-- padrao do T34887. Por isso o predicado tambem e aplicado 1:1 sobre
-- f.store dentro de finance_by_sale e dentro de spf_links (dupla
-- protecao: uma vez ao juntar finance, outra ao juntar spf via finance),
-- e sobre spf.store dentro de spf_links (leitura direta de
-- portal_spf_operations). Nenhuma alteracao a formula de
-- comissao/tier/selecao de linha oficial-vs-transferencia-de-cobertura
-- (Fase 8, ja congelada e aprovada pelo Humano) -- o filtro so REMOVE
-- linhas da base, nunca altera valores calculados de linhas sobreviventes.
--
-- FASE 6 -- GESTAO / NAO INFORMADO: com a exclusao da Fase 2 aplicada na
-- propria CTE source_rows de operational_fandi_dashboard, ANTES do CASE de
-- canonicalizacao de loja (que hoje, para 'REVENDA', cai no ramo "else"
-- e mantem o valor bruto 'REVENDA' -- so vira 'NAO INFORMADO' quando o
-- valor de origem e vazio/nulo), uma linha REVENDA jamais chega a essa
-- canonicalizacao -- verificado pela ORDEM real do codigo (filtro no WHERE
-- da CTE fonte, antes do SELECT que contem o CASE), nao por suposicao.
-- 'NAO INFORMADO' continua reservado para lacunas reais de dado, sem
-- relacao com REVENDA.
--
-- FASE 16 -- SEGURANCA: nenhuma alteracao a operational_current_scope(),
-- grants, RLS/policies ou qualquer regra de autorizacao/visibilidade --
-- o fix SOMENTE remove linhas do universo agregado (REVENDA), nunca
-- amplia o escopo de nenhum usuario.
--
-- FASE 12: nenhuma linha de portal_sales/portal_finance_operations/
-- portal_spf_operations e apagada, atualizada ou inserida por esta
-- migracao -- as 2.476 linhas REVENDA existentes continuam intactas na
-- tabela de origem; simplesmente deixam de alcancar a saida agregada
-- destas 2 RPCs.

CREATE OR REPLACE FUNCTION public.operational_fandi_dashboard(p_start date, p_end date, p_store text DEFAULT NULL::text, p_department text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_scope_store text;
  v_departments text[];
  v_store text;
  v_department text;
  v_batch_id uuid;
  v_result jsonb;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_scope_store := nullif(upper(trim(coalesce(v_scope->>'store', ''))), '');
  -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja do
  -- proprio perfil (identidade de autorizacao) para o mesmo alvo usado
  -- pelos dados. Valor nao reconhecido (ex. 'REVENDA') vira NULL e cai
  -- no 'Perfil sem loja autorizada.' abaixo -- falha fechada.
  if v_scope_store is not null then
    v_scope_store := case v_scope_store
      when 'ABC' then 'ABC'
      when 'MITSUBISHI | ABC' then 'ABC'
      when 'ALPHAVILLE' then 'ALPHAVILLE'
      when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
      when 'ANALIA FRANCO' then 'ANALIA FRANCO'
      when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
      when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
      when 'BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
      when 'BARRA FUNDA' then 'BARRA FUNDA'
      when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
      when 'EUROPA' then 'EUROPA'
      when 'MITSUBISHI | EUROPA' then 'EUROPA'
      when 'GASTAO' then 'GASTAO'
      when 'GASTÃO VIDIGAL' then 'GASTAO'
      when 'MITSUBISHI | GASTAO' then 'GASTAO'
      when 'NACOES' then 'NACOES'
      when 'NAÇÕES UNIDAS' then 'NACOES'
      when 'MITSUBISHI | NACOES' then 'NACOES'
      else null
    end;
  end if;
  v_departments := array(
    select upper(jsonb_array_elements_text(v_scope->'departments'))
  );

  if v_profile not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR DE NOVOS',
    'DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR'
  ) then
    raise exception 'Perfil sem acesso à Análise F&I.' using errcode = '42501';
  end if;

  v_store := nullif(upper(trim(coalesce(p_store, ''))), '');
  if v_store in ('ALL', 'TODAS', 'TODOS') then v_store := null; end if;
  -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja
  -- solicitada pelo frontend (nome de exibicao ou codigo ja canonico)
  -- para o mesmo alvo usado pelos dados -- relevante apenas para perfis
  -- GLOBAIS abaixo, ja que perfis store-scoped ignoram p_store
  -- inteiramente. Valor nao reconhecido MANTEM-SE como veio (nunca vira
  -- NULL/"todas as lojas") -- garante 0 resultados em vez de ampliar
  -- escopo, sem inventar mapeamento por semelhanca (Gate 5 do design:
  -- 0 LIKE, 0 similarity, 0 fallback difuso).
  if v_store is not null then
    v_store := case v_store
      when 'ABC' then 'ABC'
      when 'MITSUBISHI | ABC' then 'ABC'
      when 'ALPHAVILLE' then 'ALPHAVILLE'
      when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
      when 'ANALIA FRANCO' then 'ANALIA FRANCO'
      when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
      when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
      when 'BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
      when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
      when 'BARRA FUNDA' then 'BARRA FUNDA'
      when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
      when 'EUROPA' then 'EUROPA'
      when 'MITSUBISHI | EUROPA' then 'EUROPA'
      when 'GASTAO' then 'GASTAO'
      when 'GASTÃO VIDIGAL' then 'GASTAO'
      when 'MITSUBISHI | GASTAO' then 'GASTAO'
      when 'NACOES' then 'NACOES'
      when 'NAÇÕES UNIDAS' then 'NACOES'
      when 'MITSUBISHI | NACOES' then 'NACOES'
      else v_store
    end;
  end if;
  v_department := nullif(upper(trim(coalesce(p_department, ''))), '');
  if v_department in ('ALL', 'TODOS', 'TODAS') then v_department := null; end if;
  if v_department is not null and v_department not in ('NOVOS', 'SEMINOVOS') then
    raise exception 'Departamento inválido.' using errcode = '22023';
  end if;
  if v_department is not null and not (v_department = any(v_departments)) then
    raise exception 'Departamento fora do escopo.' using errcode = '42501';
  end if;

  -- MASTER, directors and (Incidente RBAC-Analista-Fandi-Group-Scope)
  -- ANALISTA may choose a store, including group-wide (NULL/ALL). Only
  -- GERENTE/VENDEDOR remain store-scoped.
  -- Incidente RBAC-Analista-Fandi-Store-Scope: p_store nao e mais
  -- consultado para autorizacao NEM para o filtro efetivo de perfis
  -- store-scoped -- a loja efetiva e SEMPRE v_scope_store (ja
  -- canonicalizada acima). Uma chamada manuscrita com p_store de outra
  -- loja e simplesmente ignorada; nunca pode alterar a loja efetiva.
  -- Isso reforca a autorizacao (o parametro deixa de ser confiavel de
  -- qualquer forma para esses perfis) em vez de afrouxa-la.
  if v_profile not like 'DIRETOR%' and v_profile <> 'MASTER' and v_profile <> 'ANALISTA' then
    if v_scope_store is null then
      raise exception 'Perfil sem loja autorizada.' using errcode = '42501';
    end if;
    v_store := v_scope_store;
  end if;

  select b.id into v_batch_id
  from public.portal_import_batches b
  where b.source_type = 'SPF_CURRENT'
    and b.status = 'VALIDATED'
  order by b.completed_at desc nulls last, b.created_at desc, b.id desc
  limit 1;

  if v_batch_id is null then
    raise exception 'Nenhum lote SPF validado disponível.' using errcode = 'P0002';
  end if;

  with spf_context as (
    -- FIX-AUDIT-01: linhas auxiliares SPF EXTRA nao carregam store/department
    -- proprios (ficam NULL na origem). Resolve o contexto a partir da linha
    -- irma mais antiga (menor source_row_number) do MESMO cliente na MESMA
    -- data que possua store preenchido -- mesma convencao de desempate ja
    -- usada pela CTE "proposals" abaixo para store/department
    -- ((array_agg(... order by source_row_number))[1]). So roda para linhas
    -- SPF EXTRA sem store, mantendo todo o resto de source_rows intocado.
    -- Sem candidato -> ctx_store/ctx_department ficam NULL -> comportamento
    -- fail-closed identico ao atual (linha permanece "NAO INFORMADO" e
    -- continua fora do scope, como hoje).
    select
      spf.source_row_number,
      ctx.store as ctx_store,
      ctx.department as ctx_department
    from public.portal_spf_operations spf
    left join lateral (
      select m.store, m.department
      from public.portal_spf_operations m
      where m.batch_id = spf.batch_id
        and m.client_match_key = spf.client_match_key
        and m.operation_date = spf.operation_date
        and m.store is not null
      order by m.source_row_number
      limit 1
    ) ctx on true
    where spf.batch_id = v_batch_id
      and spf.is_spf_extra
      and spf.store is null
  ), source_rows as (
    select
      s.source_row_number,
      s.operation_date,
      s.client_match_key,
      s.modality,
      -- Incidente RBAC-Analista-Fandi-Store-Scope: canonicaliza a loja de
      -- origem (que carrega prefixo de marca, ex. "MITSUBISHI | GASTAO",
      -- ou nem sempre com "| ", ex. "MITSUBISHI BANDEIRANTES") para o
      -- MESMO alvo usado por v_store/v_scope_store acima -- este e o
      -- unico ponto de leitura de portal_spf_operations.store para toda
      -- a funcao, entao a correcao aqui se propaga a stores/banks/plans/
      -- spf_extra/proposal_outcomes/summary sem precisar de patch por
      -- metrica. Valor nao reconhecido mantem-se como veio (nao vira
      -- 'NAO INFORMADO', que continua reservado para ausencia real de
      -- dado) -- nunca inventa correspondencia com uma loja canonica.
      coalesce(
        nullif(
          case upper(trim(coalesce(s.store, sc.ctx_store)))
            when 'ABC' then 'ABC'
            when 'MITSUBISHI | ABC' then 'ABC'
            when 'ALPHAVILLE' then 'ALPHAVILLE'
            when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE'
            when 'ANALIA FRANCO' then 'ANALIA FRANCO'
            when 'ANÁLIA FRANCO' then 'ANALIA FRANCO'
            when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO'
            when 'BANDEIRANTES' then 'BANDEIRANTES'
            when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
            when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES'
            when 'BARRA FUNDA' then 'BARRA FUNDA'
            when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA'
            when 'EUROPA' then 'EUROPA'
            when 'MITSUBISHI | EUROPA' then 'EUROPA'
            when 'GASTAO' then 'GASTAO'
            when 'GASTÃO VIDIGAL' then 'GASTAO'
            when 'MITSUBISHI | GASTAO' then 'GASTAO'
            when 'NACOES' then 'NACOES'
            when 'NAÇÕES UNIDAS' then 'NACOES'
            when 'MITSUBISHI | NACOES' then 'NACOES'
            else upper(trim(coalesce(s.store, sc.ctx_store)))
          end,
          ''
        ),
        'NÃO INFORMADO'
      ) as store,
      case
        when upper(coalesce(s.department, sc.ctx_department, '')) like '%SEMINOV%' then 'SEMINOVOS'
        when upper(coalesce(s.department, sc.ctx_department, '')) like '%NOVO%'
          or upper(coalesce(s.department, sc.ctx_department, '')) like '%VENDA%DIRETA%' then 'NOVOS'
        else 'NÃO INFORMADO'
      end as department,
      nullif(upper(trim(coalesce(s.bank, ''))), '') as bank,
      case
        when upper(coalesce(s.status, '')) like '%AGUARD%FATU%'
          or upper(coalesce(s.status, '')) in ('AG FATURAMENTO', 'AG. FATURAMENTO')
          then 'AG. FATURAMENTO'
        when upper(coalesce(s.status, '')) like '%FATURAD%' then 'FATURADA'
        when upper(coalesce(s.status, '')) like '%PAGA%' then 'PAGA'
        when upper(coalesce(s.status, '')) like '%APROVAD%' then 'APROVADA'
        when upper(coalesce(s.status, '')) like '%ASSINAD%' then 'ASSINADA'
        when upper(coalesce(s.status, '')) like '%TRANSITO%' then 'TRANSITO'
        when upper(coalesce(s.status, '')) like '%ENC%A VISTA%' then 'ENC. A VISTA'
        when upper(coalesce(s.status, '')) like '%ENC%RECUS%' then 'ENC. RECUS.'
        when upper(coalesce(s.status, '')) like '%RECUS%' then 'RECUSADA'
        when upper(coalesce(s.status, '')) like '%ENCERRAD%' then 'ENCERRADA'
        when upper(coalesce(s.status, '')) like '%CANCELAD%' then 'CANCELADA'
        else nullif(upper(trim(coalesce(s.status, ''))), '')
      end as status,
      coalesce(s.financed_value, 0) as financed_value,
      s.installment_value,
      s.balloon_payment,
      s.balloon_value,
      s.finance_code,
      s.tc_returned,
      s.optional_name,
      coalesce(s.optional_value, 0) as optional_value,
      s.is_spf_extra,
      coalesce(
        nullif(trim(s.operation_code), ''),
        concat('CLIENT:', s.client_match_key, '|', coalesce(s.store, ''), '|',
          coalesce(s.operation_date::text, ''))
      ) as proposal_key
    from public.portal_spf_operations s
    left join spf_context sc on sc.source_row_number = s.source_row_number
    where s.batch_id = v_batch_id
      and (s.operation_date is null or s.operation_date between p_start and p_end)
      -- Incidente REVENDA2 (Fase 2/6): exclui a linha cujo proprio store
      -- (ou o herdado da linha-irma via spf_context, mesma fonte usada
      -- pela canonicalizacao logo acima) resolva para REVENDA -- ANTES de
      -- qualquer canonicalizacao/fallback para 'NAO INFORMADO'. REVENDA e
      -- ausencia do universo elegivel desta RPC, nao "zero valor" nem
      -- "NAO INFORMADO". Nao apaga nem altera portal_spf_operations.
      and upper(trim(coalesce(s.store, sc.ctx_store, ''))) <> 'REVENDA'
  ), visible_rows as (
    select * from source_rows r
    where r.department = any(v_departments)
      and (v_department is null or r.department = v_department)
      and (v_store is null or r.store = v_store)
  ), proposals as (
    select
      proposal_key,
      (array_agg(store order by source_row_number) filter (where store <> 'NÃO INFORMADO'))[1] as store,
      (array_agg(department order by source_row_number) filter (where department <> 'NÃO INFORMADO'))[1] as department,
      (array_agg(bank order by source_row_number) filter (where bank is not null))[1] as bank,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as status,
      max(financed_value) as financed_value,
      max(installment_value) as installment_value,
      max(balloon_payment) as balloon_payment,
      max(balloon_value) as balloon_value,
      bool_or(upper(coalesce(modality, '')) like '%FANDI%') as tem_fandi,
      case
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])999([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%SUBSIDIADO%') then 'SUBSIDIADO'
        when bool_or(coalesce(finance_code, '') ~ '(^|[^0-9])777([^0-9]|$)'
          or upper(coalesce(finance_code, '')) like '%REVERS%') then 'REVERSÃO'
        when bool_or(coalesce(tc_returned, '') ~ '(^|[^0-9])1([^0-9]|$)'
          or upper(coalesce(tc_returned, '')) like '%COPARTICIPADO%') then 'COPARTICIPADO'
        when max(coalesce(balloon_payment, 0)) > 0
          or max(coalesce(balloon_value, 0)) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from visible_rows
    group by proposal_key
  ), operational as (
    select * from proposals
    where status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')
      and tem_fandi
  ), store_metrics as (
    select store,
      count(*)::integer as quantity,
      count(*) filter (where department = 'NOVOS')::integer as new_quantity,
      count(*) filter (where department = 'SEMINOVOS')::integer as used_quantity,
      coalesce(avg(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_financed,
      coalesce(avg(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_financed,
      coalesce(avg(installment_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_average_installment,
      coalesce(avg(installment_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_average_installment,
      count(*) filter (where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0)::integer as balloon_quantity,
      coalesce(avg(coalesce(balloon_payment, balloon_value)) filter (
        where coalesce(balloon_payment, 0) > 0 or coalesce(balloon_value, 0) > 0
      ), 0)::numeric(18,2) as average_balloon,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed
    from operational group by store
  ), bank_metrics as (
    select bank,
      count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as total_financed,
      coalesce(avg(financed_value), 0)::numeric(18,2) as average_financed,
      coalesce(sum(financed_value) filter (where department = 'NOVOS'), 0)::numeric(18,2) as new_financed,
      coalesce(sum(financed_value) filter (where department = 'SEMINOVOS'), 0)::numeric(18,2) as used_financed
    from operational where bank is not null group by bank
  ), status_store as (
    select store, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by store, status
  ), status_bank as (
    select bank, status, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational where bank is not null group by bank, status
  ), plan_metrics as (
    select plan_type, count(*)::integer as quantity,
      coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
    from operational group by plan_type
  ), plan_store_department as (
    select store, department, plan_type, count(*)::integer as quantity
    from operational group by store, department, plan_type
  ), spf_unique as (
    select proposal_key, store, department, optional_value
    from visible_rows
    where is_spf_extra and optional_value > 0
    group by proposal_key, store, department, optional_value
  ), spf_metrics as (
    select store, department,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value,
      (coalesce(sum(optional_value), 0) * 0.70)::numeric(18,2) as spf_70_value
    from spf_unique group by store, department
  ), client_history as (
    select client_match_key,
      (array_agg(store order by source_row_number))[1] as store,
      (array_agg(department order by source_row_number))[1] as department,
      (array_agg(status order by source_row_number desc) filter (where status is not null))[1] as final_status,
      bool_or(status in ('PAGA', 'FATURADA', 'AG. FATURAMENTO')) as has_operational,
      max(financed_value) as financed_value
    from visible_rows
    where client_match_key is not null
    group by client_match_key
  ), proposal_outcomes as (
    select store, department,
      case
        when final_status in ('RECUSADA', 'ENC. RECUS.') then 'RECUSADA'
        when final_status in ('APROVADA', 'ENCERRADA', 'CANCELADA', 'ASSINADA', 'TRANSITO', 'ENC. A VISTA')
          and not has_operational then 'APROVADA'
        else null
      end as outcome,
      financed_value
    from client_history
  )
  select jsonb_build_object(
    'scope', v_scope,
    'period', jsonb_build_object('start', p_start, 'end', p_end),
    'filters', jsonb_build_object('store', v_store, 'department', v_department),
    'source', jsonb_build_object('latest_validated_batch', v_batch_id),
    'summary', jsonb_build_object(
      'operational_quantity', (select count(*) from operational),
      'total_financed', (select coalesce(sum(financed_value), 0) from operational)
    ),
    'stores', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from store_metrics x), '[]'::jsonb),
    'banks', coalesce((select jsonb_agg(to_jsonb(x) order by x.total_financed desc) from bank_metrics x), '[]'::jsonb),
    'status_by_store', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.status) from status_store x), '[]'::jsonb),
    'status_by_bank', coalesce((select jsonb_agg(to_jsonb(x) order by x.bank, x.status) from status_bank x), '[]'::jsonb),
    'plans', coalesce((select jsonb_agg(to_jsonb(x) order by x.plan_type) from plan_metrics x), '[]'::jsonb),
    'plans_by_store_department', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.plan_type) from plan_store_department x), '[]'::jsonb),
    'spf_extra', coalesce((select jsonb_agg(to_jsonb(x) order by x.store, x.department) from spf_metrics x), '[]'::jsonb),
    'proposal_outcomes', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.store, x.department, x.outcome)
      from (
        select store, department, outcome, count(*)::integer as quantity,
          coalesce(sum(financed_value), 0)::numeric(18,2) as financed_value
        from proposal_outcomes where outcome is not null
        group by store, department, outcome
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_salary_details(p_start date, p_end date, p_seller_id uuid DEFAULT NULL::uuid)
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
  v_rows jsonb;
  v_total_rows integer;
  v_seller_count integer;
  v_limit constant integer := 2000;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Periodo maximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_store := v_scope->>'store';
  v_departments := array(
    select upper(trim(jsonb_array_elements_text(v_scope->'departments')))
  );
  v_is_master := coalesce((v_scope->>'is_master')::boolean, false);
  v_is_director := coalesce((v_scope->>'is_director')::boolean, false);
  v_is_seller := coalesce((v_scope->>'is_seller')::boolean, false);

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY','SPF_CURRENT')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (p_seller_id is null or u.id = p_seller_id)
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
              and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_store))
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, '')))
        not in ('REVENDA', 'INATIVO', 'MASTER')
      and (p_seller_id is null or ps.id = p_seller_id)
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
              and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_store))
            )
          )
        )
      )
  ),
  sales_global_ranked as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_id,
      s.seller_user_id,
      s.store,
      s.department,
      s.vehicle_model,
      s.sale_value,
      row_number() over (
        partition by s.chassis
        order by s.sale_date desc, s.id desc
      ) as chassis_rank
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    -- Incidente REVENDA2 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do join a
    -- eligible_sellers (linha abaixo, visible_sales) e ANTES de qualquer
    -- fallback resolve_store_temporal. Nunca por chassi: uma venda NOVOS
    -- legitima e uma linha REVENDA podem compartilhar o mesmo chassi
    -- colidido (T34887) e permanecem tratadas como linhas distintas.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
  ),
  visible_sales as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      ps.id as seller_id,
      ps.name as seller_name,
      coalesce(public.resolve_store_temporal(ps.id, s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      upper(trim(coalesce(public.resolve_department_temporal(ps.id, s.sale_date, null), ps.status, s.department, ''))) as department,
      coalesce(nullif(s.vehicle_model, ''), 'NAO INFORMADO')
        as vehicle_model,
      coalesce(s.sale_value, 0)::numeric(18,2) as sale_value,
      s.chassis_rank = 1 as included_in_commission
    from sales_global_ranked s
    join eligible_sellers ps on ps.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
      -- Incidente IA-1B: mesmo principio do IA-1A -- para DIRETOR, autorizacao
      -- vale sobre o departamento EFETIVO (temporal) do fato. Finance/SPF
      -- derivam de visible_sales via join por chassi/sale_id (finance_by_sale,
      -- spf_links), entao este gate unico fecha os tres.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(ps.id, s.sale_date, null), ps.status, s.department, ''))) = any(v_departments)
      )
  ),
  finance_by_sale as (
    select
      vs.id as sale_id,
      -- Incidente Salary-Details-Later-Return: um chassi tambem conta como
      -- financiado quando so existe um registro de retorno tardio
      -- (is_later_return), mesma regra ja aplicada por operational_metrics
      -- (effective_finance) e ja usada nesta mesma linha em
      -- return_considered, alguns campos abaixo.
      bool_or(
        coalesce(f.is_real_financing, false)
        or coalesce(f.is_later_return, false)
      ) as financed,
      min(f.operation_date) filter (
        where f.is_real_financing
      ) as finance_date,
      coalesce(sum(f.financed_or_service_value) filter (
        where f.is_real_financing
      ), 0)::numeric(18,2) as financed_value,
      coalesce(sum(f.return_value), 0)::numeric(18,2)
        as return_gross,
      coalesce(sum(f.return_value) filter (
        where f.is_real_financing or f.is_later_return
      ), 0)::numeric(18,2) as return_considered,
      max(f.installments) filter (
        where f.is_real_financing
      ) as installments,
      max(f.installment_value) filter (
        where f.is_real_financing
      )::numeric(18,2) as installment_value,
      max(nullif(f.finance_code, '')) filter (
        where f.is_real_financing
      ) as finance_code,
      max(nullif(f.service_description, '')) filter (
        where f.is_real_financing
      ) as service_description
    from visible_sales vs
    left join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and vs.included_in_commission
     and f.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA2 (Fase 2/7): este join e SOMENTE por chassi --
     -- sem esta linha, uma linha financeira REVENDA do MESMO chassi de uma
     -- venda NOVOS legitima (T34887) entraria na agregacao financeira da
     -- venda legitima mesmo com sales_global_ranked ja filtrada. Exclusao
     -- pelo store PROPRIO da linha financeira, nunca pelo chassi.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    group by vs.id
  ),
  spf_links as (
    select distinct
      vs.id as sale_id,
      spf.id,
      coalesce(spf.optional_value, 0)::numeric(18,2) as optional_value,
      spf.is_spf_extra
    from visible_sales vs
    join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and vs.included_in_commission
     -- Incidente REVENDA2 (Fase 2/7): mesma exclusao de finance_by_sale --
     -- uma linha financeira REVENDA do mesmo chassi nunca alimenta o SPF
     -- de uma venda legitima via este join intermediario.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    join public.portal_spf_operations spf
      on spf.client_match_key = f.client_match_key
     -- Incidente Salary-Details-SPF-Batch-Scope: restringe SPF ao mesmo
     -- lote SPF_CURRENT VALIDATED mais recente (latest_batches, acima),
     -- mesmo padrao ja usado por finance_by_sale (f.batch_id) e por
     -- operational_model_metrics.spf_linked -- evita somar reimportacoes
     -- historicas da mesma linha SPF.
     and spf.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA2 (Fase 2/7): exclusao tambem pelo store PROPRIO
     -- da linha SPF (leitura direta de portal_spf_operations), mesmo
     -- predicado canonico aplicado a toda leitura direta desta tabela
     -- neste incidente.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
  ),
  spf_by_sale as (
    select
      sl.sale_id,
      count(*) filter (
        where sl.is_spf_extra and sl.optional_value > 0
      )::integer as spf_count,
      coalesce(sum(sl.optional_value), 0)::numeric(18,2)
        as spf_gross,
      coalesce(sum(sl.optional_value) filter (
        where sl.is_spf_extra and sl.optional_value > 0
      ), 0)::numeric(18,2) as spf_considered
    from spf_links sl
    group by sl.sale_id
  ),
  detail_rows as (
    select
      vs.sale_date,
      fbs.finance_date,
      vs.store,
      vs.department,
      vs.vehicle_model,
      vs.seller_id,
      vs.seller_name,
      encode(
        extensions.digest(
          'PORTAL-FI-SALE:' || vs.id::text || ':' || vs.sale_date::text,
          'sha256'
        ),
        'hex'
      ) as operation_ref,
      case
        when nullif(trim(vs.chassis), '') is null then ''
        else '******' || right(trim(vs.chassis), 6)
      end as chassis_masked,
      vs.sale_value,
      coalesce(fbs.financed, false) as financed,
      coalesce(fbs.financed_value, 0)::numeric(18,2)
        as financed_value,
      coalesce(fbs.return_gross, 0)::numeric(18,2)
        as return_gross,
      coalesce(fbs.return_considered, 0)::numeric(18,2)
        as return_considered,
      fbs.installments,
      fbs.installment_value,
      coalesce(
        fbs.finance_code,
        fbs.service_description,
        ''
      ) as modality,
      coalesce(sbs.spf_count, 0) as spf_count,
      coalesce(sbs.spf_gross, 0)::numeric(18,2) as spf_gross,
      coalesce(sbs.spf_considered, 0)::numeric(18,2)
        as spf_considered,
      round(
        coalesce(sbs.spf_considered, 0) * 0.70,
        2
      )::numeric(18,2) as spf_70,
      round(
        coalesce(fbs.return_considered, 0)
        + coalesce(sbs.spf_considered, 0) * 0.70,
        2
      )::numeric(18,2) as operation_profitability,
      vs.included_in_commission,
      case
        when vs.included_in_commission then ''
        else 'REGISTRO DUPLICADO: SOMENTE A VENDA MAIS RECENTE DO CHASSI E CONSIDERADA'
      end as exclusion_reason,
      case
        when vs.included_in_commission
          then 'FAIXA CONSOLIDADA DO VENDEDOR'
        else 'FORA DA BASE DE CALCULO'
      end as applied_rule
    from visible_sales vs
    left join finance_by_sale fbs on fbs.sale_id = vs.id
    left join spf_by_sale sbs on sbs.sale_id = vs.id
  ),
  limited_rows as (
    select *
    from detail_rows
    order by sale_date desc, operation_ref
    limit v_limit
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'date', dr.sale_date,
          'finance_date', dr.finance_date,
          'store', dr.store,
          'department', dr.department,
          'vehicle_model', dr.vehicle_model,
          'seller_id', dr.seller_id,
          'seller_name', dr.seller_name,
          'operation_ref', left(dr.operation_ref, 12),
          'chassis_masked', dr.chassis_masked,
          'sale_value', dr.sale_value,
          'financed', dr.financed,
          'financed_value', dr.financed_value,
          'installments', dr.installments,
          'installment_value', dr.installment_value,
          'modality', dr.modality,
          'return_gross', dr.return_gross,
          'return_considered', dr.return_considered,
          'spf_count', dr.spf_count,
          'spf_gross', dr.spf_gross,
          'spf_considered', dr.spf_considered,
          'spf_70', dr.spf_70,
          'operation_profitability', dr.operation_profitability,
          'included_in_commission', dr.included_in_commission,
          'exclusion_reason', dr.exclusion_reason,
          'applied_rule', dr.applied_rule
        )
        order by dr.sale_date desc, dr.operation_ref
      ),
      '[]'::jsonb
    ),
    count(distinct dr.seller_id)::integer
  into v_rows, v_seller_count
  from limited_rows dr;

  with latest_batches as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  eligible_sellers as (
    select u.id, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (p_seller_id is null or u.id = p_seller_id)
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
              and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_store))
            )
          )
        )
      )
    union all
    select ps.id, ps.status
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, '')))
        not in ('REVENDA', 'INATIVO', 'MASTER')
      and (p_seller_id is null or ps.id = p_seller_id)
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
              and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_store))
            )
          )
        )
      )
  ),
  ranked as (
    select
      s.id,
      s.sale_date,
      s.seller_id,
      s.seller_user_id,
      s.department,
      row_number() over (
        partition by s.chassis
        order by s.sale_date desc, s.id desc
      ) as chassis_rank
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    -- Incidente REVENDA2 (Fase 2): mesma exclusao de sales_global_ranked
    -- acima -- esta e uma SEGUNDA leitura independente de portal_sales,
    -- usada so para o total (v_total_rows/seller_count/truncated). Sem
    -- este filtro aqui tambem, o total exibido divergiria das linhas
    -- realmente retornadas em v_rows.
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
  )
  select count(*)::integer
  into v_total_rows
  from ranked r
  join eligible_sellers es on es.id = coalesce(r.seller_user_id, r.seller_id)
  where r.sale_date between p_start and p_end
    -- Incidente IA-1B: mesmo gate de visible_sales, para manter row_count/
    -- seller_count/truncated consistentes com o array rows retornado.
    and (
      not v_is_director
      or upper(trim(coalesce(public.resolve_department_temporal(es.id, r.sale_date, null), es.status, r.department, ''))) = any(v_departments)
    );

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'seller_filter', p_seller_id,
    'seller_count', coalesce(v_seller_count, 0),
    'row_count', coalesce(v_total_rows, 0),
    'row_limit', v_limit,
    'truncated', coalesce(v_total_rows, 0) > v_limit,
    'rows', v_rows,
    'contains_client_identity', false,
    'contains_personal_documents', false,
    'contains_full_chassis', false,
    'contains_masked_chassis', true,
    'contains_chassis', false,
    'contains_nbs', false
  );
end;
$function$;

-- ============================================================
-- FASE 3 -- BLINDAGEM DE HERANCA DE IDENTIDADE (raiz do incidente T34887)
-- ============================================================
-- Fonte original modificada aqui:
-- supabase/migrations/20260823040000_incidente_integridade_cpf_normalizado_patch_a_import_reconcile.sql
--
-- DEFEITO (comprovado pelo T34887): quando a resolucao DESTA importacao
-- para a linha atual nao encontra identidade ativa (classificacao
-- SEM_MATCH/SEM_IDENTIFICADOR/CPF_INATIVO -- nunca IDENTIFICADOR_
-- DUPLICADO/CONFLITO, que ja bloqueiam heranca corretamente), o codigo
-- herdava previous_resolution.prev_seller_user_id apenas casando o CHASSI
-- da linha atual contra a ultima resolucao ja validada para o MESMO
-- chassi -- SEM checar se o CPF/NBS PROPRIO (presente, porem sem match)
-- da linha atual poderia pertencer a uma pessoa real DIFERENTE de quem o
-- chassi foi resolvido anteriormente. A linha REVENDA do Mario Alberto de
-- Souza Vaz (CPF 05326688808, sem match ativo) herdou assim a identidade
-- de Eduardo Fernando da Silva (CPF 36689800806) so por colisao de
-- chassi com a linha ANALIA FRANCO dele, na reimportacao seguinte.
--
-- REGRA MINIMA DESENHADA (consistente com a hierarquia ja estabelecida no
-- proprio arquivo -- CPF primario, NBS fallback; NAO REVENDA-especifica):
-- antes de herdar previous_resolution.prev_seller_user_id para um chassi,
-- tambem compara o(s) identificador(es) PROPRIO(S) da linha atual contra
-- o(s) identificador(es) PROPRIO(S) da PROPRIA linha que gerou a
-- resolucao anterior (previous_resolution estendida para tambem carregar
-- prev_seller_cpf_normalizado/prev_seller_nbs, da MESMA linha prévia que
-- ja era joinada). So herda quando:
--   (a) a linha atual nao tem CPF valido nem NBS proprios (nenhuma
--       informacao propria para contradizer a heranca), OU
--   (b) o(s) identificador(es) proprio(s) presentes na linha atual SAO
--       CONSISTENTES com o(s) da resolucao anterior.
-- Nao herda (fica NULL/nao resolvido) quando a linha atual tem CPF valido
-- OU NBS proprio que DIVIRJA do identificador proprio da resolucao
-- anterior -- exatamente o caso do Mario: CPF proprio presente
-- (05326688808) e diferente do CPF da resolucao anterior para aquele
-- chassi (36689800806) -> NAO herda, seller_user_id_final permanece NULL.
--
-- Preserva integralmente o caso legitimo de reimportacao (mesma pessoa,
-- mesmo chassi, segundo lote com dado mais incompleto) e o caso de linha
-- genuinamente sem nenhum identificador proprio para comparar -- nenhuma
-- heranca legitima existente e quebrada. Nao e REVENDA-especifica: e o
-- invariante geral IDENTIDADE ATUAL != IDENTIDADE ANTERIOR -> NAO HERDA.
--
-- ZERO alteracao a: classificacao (SEM_MATCH/SEM_IDENTIFICADOR/CPF_
-- INATIVO/IDENTIFICADOR_DUPLICADO/CONFLITO/CPF_MATCH/NBS_FALLBACK
-- inalterados), CPF_MATCH/NBS_FALLBACK (sempre vencem, inalterado),
-- IDENTIFICADOR_DUPLICADO/CONFLITO (continuam bloqueando heranca
-- incondicionalmente, inalterado), alertas/auditoria, upsert de
-- portal_sales/portal_finance_operations, RLS, grants, search_path,
-- SECURITY DEFINER. portal_reconcile_user_facts_core (mesmo arquivo
-- original) nao usa previous_resolution e permanece intocada aqui.

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
  --
  -- Incidente REVENDA2/Patch-C (Fase 3): a previous_resolution passa a
  -- tambem carregar os identificadores PROPRIOS (CPF/NBS) da MESMA linha
  -- prévia que originou prev_seller_user_id -- necessarios para a
  -- checagem de consistencia abaixo, antes de decidir herdar.
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
          -- Incidente REVENDA2/Patch-C: so herda quando a linha atual NAO
          -- tem identificador proprio (CPF valido ou NBS) que divirja do
          -- identificador proprio da resolucao anterior para o mesmo
          -- chassi. Ausencia total de identificador proprio na linha
          -- atual, ou identificador proprio consistente com o anterior,
          -- continua herdando normalmente (0 regressao no caso legitimo
          -- de reimportacao com dado mais incompleto).
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

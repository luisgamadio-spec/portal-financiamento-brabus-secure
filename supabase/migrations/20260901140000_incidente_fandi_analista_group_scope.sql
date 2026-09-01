-- Incidente RBAC-Analista-Fandi-Group-Scope -- decisao de negocio do
-- responsavel pelo produto: dentro de ANALISE F&I DO GRUPO
-- (operational_fandi_dashboard), o perfil ANALISTA passa a ter
-- VISIBILIDADE DE TODAS AS LOJAS DO GRUPO, deixando de ser restrito a
-- usuarios.loja. Exemplo dado pelo dono do negocio: GIOVANNA CRISTINA
-- RIVERA, perfil ANALISTA, usuarios.loja='BARRA FUNDA', hoje so ve Barra
-- Funda nesta tela -- deve poder ver o grupo inteiro e escolher qualquer
-- loja legitima, exatamente como MASTER/DIRETOR ja fazem nesta mesma RPC.
--
-- ESCOPO: SOMENTE a classificacao de store-scope de ANALISTA dentro desta
-- RPC muda. Nao altera profile, usuarios.loja, RLS, policies, grants, nem
-- qualquer outra RPC. GERENTE e VENDEDOR permanecem store-scoped, sem
-- alteracao. A migracao anterior (20260901130000, canonicalizacao de
-- loja) permanece a base e NAO e revertida -- continua sendo o unico
-- mapeamento usado tanto para v_store (selecao do usuario) quanto para
-- source_rows.store (dado de origem).
--
-- IMPLEMENTACAO: ANALISTA e removido da condicao que forcava v_store :=
-- v_scope_store (bloco "perfis store-scoped"). ANALISTA passa a percorrer
-- exatamente o mesmo caminho ja existente para MASTER/DIRETOR: p_store
-- NULL/ALL/TODAS/TODOS -> v_store NULL -> visible_rows sem filtro de loja
-- (grupo inteiro); p_store com uma das variantes canonicas conhecidas ->
-- loja especifica; p_store desconhecido -> mantido como veio (nunca vira
-- NULL) -> 0 linhas, nunca amplia escopo. Nenhum codigo novo de
-- canonicalizacao ou de fail-closed foi necessario -- e o mesmo bloco
-- (linhas ja existentes desde 20260901130000) que globais usam hoje.
--
-- EFEITO COLATERAL INTENCIONAL: para ANALISTA, v_scope_store (derivado de
-- usuarios.loja) deixa de ser consultado para autorizacao nesta RPC --
-- portanto a excecao 'Perfil sem loja autorizada.' (que hoje bloqueia o
-- unico ANALISTA com usuarios.loja='REVENDA', valor legado nao mapeado)
-- deixa de se aplicar a ANALISTA especificamente aqui. Isso e a
-- consequencia direta e pretendida da regra de negocio ("ANALISTA nao
-- deve ser restrito por usuarios.loja... aplica-se a TODOS os usuarios
-- ANALISTA") -- nao e um bug nem um caminho novo inventado. usuarios.loja
-- continua intocado e continua controlando outras RPCs normalmente.
--
-- Departamento: 0 alteracao. v_departments/v_department continuam vindo
-- de operational_current_scope() e sendo validados exatamente como antes
-- -- mudar o escopo de loja de ANALISTA nao amplia nem reduz os
-- departamentos autorizados.
--
-- CAUSA ORIGINAL (mantida do incidente anterior, ainda corrigida por esta
-- funcao -- nao revertida):
--
-- 1. AUTORIZACAO: v_store (da selecao de loja do frontend, nome de
--    exibicao completo, ex. "GASTAO VIDIGAL") era comparado byte-a-byte
--    contra v_scope_store (de usuarios.loja via operational_current_scope(),
--    codigo curto, ex. "GASTAO") -- nunca identicos para as lojas cujo
--    nome de exibicao diverge do codigo interno, disparando
--    'Loja fora do escopo.' mesmo para a propria loja autorizada do
--    usuario.
--
-- 2. FILTRO DE DADOS: mesmo quando a autorizacao passava (p_store=NULL,
--    "Todas as lojas"), visible_rows comparava v_store (codigo curto,
--    sem prefixo) contra r.store (lido direto de
--    portal_spf_operations.store, que carrega prefixo de marca) --
--    tambem nunca identicos, zerando toda a resposta (nao so spf_extra)
--    para qualquer perfil store-scoped, e tambem para MASTER/DIRETOR ao
--    selecionar uma loja especifica (mesmo comparador compartilhado).
--
-- PROVA AO VIVO (leitura, 0 escrita) -- portal_spf_operations.store real,
-- todas as 8 lojas ativas com ANALISTA hoje:
--   ABC            -> "MITSUBISHI | ABC"
--   ALPHAVILLE     -> "MITSUBISHI | ALPHAVILLE"
--   ANALIA FRANCO  -> "MITSUBISHI | A. FRANCO"        (abrev. distinta)
--   BANDEIRANTES   -> "MITSUBISHI BANDEIRANTES" (achado inicial, dado
--                     historico) E "MITSUBISHI | BANDEIRANTES" (forma
--                     usada no lote SPF_CURRENT autoritativo mais
--                     recente na validacao desta correcao, 1733
--                     registros) -- ambas as formas mapeadas; a
--                     ausencia de "| " nao e universal nem previsivel
--   BARRA FUNDA    -> "MITSUBISHI | BARRA FUNDA"
--   EUROPA         -> "MITSUBISHI | EUROPA"
--   GASTAO         -> "MITSUBISHI | GASTAO"
--   NACOES         -> "MITSUBISHI | NACOES"
-- Confirma que um regexp_replace/prefix-strip generico e insuficiente --
-- ANALIA FRANCO e BANDEIRANTES quebram esse padrao unico. Por isso o
-- mapeamento abaixo e uma enumeracao EXPLICITA das variantes realmente
-- observadas, nao uma regra generica.
--
-- DESENHO (aprovado em 3 fases de diagnostico/design, nenhuma
-- implementada ate agora):
--
-- A. Para perfis STORE-SCOPED (ANALISTA/GERENTE/VENDEDOR), p_store deixa
--    de ser consultado para autorizacao OU filtro -- a loja efetiva e
--    SEMPRE v_scope_store (ja canonico, de usuarios.loja). Uma chamada
--    manuscrita com p_store de outra loja e simplesmente ignorada, nunca
--    validada e rejeitada nem aceita -- reforca, nao afrouxa,
--    autorizacao (Gate 5 do design: prova adversarial, 0 vazamento).
--
-- B. v_scope_store passa pelo MESMO mapeamento canonico logo apos ser
--    lido -- um valor nao reconhecido (ex. o caso legado
--    usuarios.loja='REVENDA', 1 unico ANALISTA ativo, nao mapeado para
--    nenhuma loja fisica por falta de evidencia -- Gate 7 do design)
--    vira NULL e cai no 'Perfil sem loja autorizada.' ja existente --
--    falha fechada, 0 caminho novo de excecao, 0 acesso a grupo,
--    reportado como incidente de qualidade de dados separado.
--
-- C. Para perfis GLOBAIS (MASTER/DIRETOR), p_store continua controlando
--    o filtro (0 mudanca de semantica -- NULL/ALL continua grupo todo),
--    mas agora tambem passa pelo mapeamento canonico antes de comparar
--    contra r.store -- corrige o mesmo bug de representacao para esses
--    perfis ao selecionar uma loja especifica (achado novo do
--    diagnostico, nao reportado originalmente mas parte da mesma causa
--    raiz). Valor nao reconhecido mantem-se como veio (nunca vira NULL/
--    "todas as lojas") -- garante 0 resultados, nunca amplia escopo.
--
-- D. source_rows.store (o unico ponto de leitura de
--    portal_spf_operations.store) passa pelo MESMO mapeamento antes do
--    fallback existente para 'NAO INFORMADO' -- corrige o comparador
--    compartilhado por TODOS os campos de saida (stores/banks/plans/
--    spf_extra/proposal_outcomes/summary), nao um patch por metrica.
--
-- ZERO alteracao a: allowlist de perfil, autorizacao de departamento,
-- validacao de periodo, calculo de status/plano/SPF/proposal_outcomes/
-- summary, formato do JSON de saida, SECURITY DEFINER, search_path,
-- grants. Nenhuma tabela criada. Nenhuma escrita em usuarios. Nenhuma
-- mudanca de RLS/policy.

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

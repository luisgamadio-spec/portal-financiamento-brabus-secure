-- Incidente REVENDA-3: exclusao operacional de REVENDA nas RPCs restantes
-- que ainda liam portal_sales/portal_finance_operations/
-- portal_spf_operations sem o gate proprio de store da linha/transacao.
--
-- ONDA ANTERIOR (ja commitada, be9e96bc99698ac83d5d59f88e54b44eee1f207c,
-- migration supabase/migrations/20260916100000_incidente_revenda2_
-- operational_exclusion_and_identity_safety.sql) -- NAO tocada, NAO
-- reaberta, NAO duplicada aqui:
--   1. public.operational_fandi_dashboard
--   2. public.operational_salary_details
--   3. public.master_operational_import_sales / master_operational_import_finance
--      (blindagem de heranca de identidade, T34887)
--
-- ESCOPO DESTA ONDA -- as 6 RPCs restantes confirmadas com autoridade
-- canonica ATUAL neste repo (verificado lendo, para cada uma, a ULTIMA
-- "CREATE OR REPLACE FUNCTION" cronologica em supabase/migrations/):
--   1. public.operational_analyst_commission_metrics    (Salarios & Comissoes)
--   2. public.operational_analyst_commission_metrics_v2 (Salarios & Comissoes)
--   3. public.operational_reporting_summary              (Relatorios)
--   4. public.operational_analyst_coverage_metrics       (Cobertura de Analista)
--   5. public.operational_analyst_coverage_details        (Cobertura de Analista)
--   6. public.master_operational_spf_audit_period         (Auditoria SPF / RH-DP)
--
-- CLASSIFICACAO ATIVO x DORMENTE (evidencia, nao suposicao):
--   - (1),(2): chamadas em assets/js/portal-app.js (Secure) E em multiplos
--     adapters/view-models do V2 (salarios-comissoes.js,
--     master-competence-closing-*, master-absences-*) -- ATIVA.
--   - (4): NAO chamada por nenhum frontend diretamente, mas chamada
--     INTERNAMENTE por (2) (operational_analyst_commission_metrics_v2, ver
--     supabase/migrations/20260821110000_coverage_details_analista.sql
--     linha 938: "public.operational_analyst_coverage_metrics(...)" dentro
--     do loop de cobertura) -- ATIVA por transitividade.
--   - (5): chamada em assets/js/portal-app.js (Secure) -- ATIVA.
--   - (6): chamada em assets/js/portal-app.js (Secure) E em
--     master-competence-history-provider.js/shell-admin.js (V2) -- ATIVA.
--   - (3) operational_reporting_summary: NENHUM caller encontrado em
--     assets/js (Secure OU V2), NENHUM caller RPC-chama-RPC em nenhuma
--     migration deste repo, e a PROPRIA migration que a define
--     (20260820090000_incidente229_fix_reporting_summary_canonical_sales.sql,
--     linhas 24-28) ja a documenta: "Sem caller no frontend atual nem
--     caller RPC interno -- funcao dormente do ponto de vista de UI hoje,
--     mas EXECUTE permanece concedido a authenticated". O proprio baseline
--     de auditoria do schema (supabase/baseline/MANIFEST.md linha 5)
--     classifica-a explicitamente como "1 DORMENTE (operational_reporting_
--     summary, ja documentada como sem caller pela propria migration que a
--     define)". Nao se enquadra na categoria RETIRED_NOT_APPLICABLE do
--     Ranking (nunca foi exclusiva daquele dominio -- e anterior a ele e
--     nunca dependeu de nenhum objeto performance_*, confirmado lendo
--     supabase/migrations/20260910230000_retire_analyst_performance_ranking.sql,
--     que nao a menciona). Como (a) o GRANT para authenticated permanece
--     ativo -- ela continua diretamente invocavel via RPC por qualquer
--     usuario autenticado, mesmo sem UI -- e (b) o fix e puramente
--     subtrativo e de risco zero, ela e patcheada aqui por blindagem, e
--     nao por inflar contagem de cobertura. Reportado explicitamente ao
--     usuario como DORMENTE (nao "ativa" no sentido de UI hoje).
--
--   Nenhuma das 6 aparece na lista de DROP da aposentadoria do Ranking
--   (20260910230000) -- confirmado lendo esse arquivo inteiro.
--
-- operational_analyst_commission_metrics_v2 NAO e redefinida nesta
-- migration: lendo o corpo inteiro (20260821110000, linhas 877-957),
-- ela NUNCA le portal_sales/portal_finance_operations/
-- portal_spf_operations diretamente -- e um wrapper puro que (a) chama
-- public.operational_analyst_commission_metrics(p_start, p_end) e (b)
-- chama public.operational_analyst_coverage_metrics(...) por cobertura
-- ativa do ANALISTA chamador, concatenando as linhas. Como as duas RPCs
-- chamadas SAO redefinidas abaixo, v_2 herda a exclusao de REVENDA
-- transitivamente, sem precisar de nenhuma linha propria alterada --
-- redefini-la aqui seria uma CREATE OR REPLACE idêntica (sem-op) e
-- desnecessaria. Verificado ao vivo pelo teste
-- tests/revenda3_additional_rpc_regression_test.js (chama v2 diretamente
-- e confirma REVENDA=0, mesmo sem redefinicao propria).
--
-- PREDICADO CANONICO (identico ao Incidente REVENDA2, mesmo estilo,
-- adaptado ao alias local de cada CTE):
--   upper(trim(coalesce(<alias>.store, ''))) <> 'REVENDA'
-- Aplicado no campo PROPRIO da linha/transacao (nunca por chassi), na CTE
-- base de leitura, ANTES de qualquer join a eligible_sellers e ANTES de
-- qualquer fallback resolve_store_temporal -- mesma ordem, mesma
-- justificativa (colisao de chassi T34887) do Incidente REVENDA2.
--
-- LINKAGE INDEPENDENTE (mesmo padrao ja fechado em operational_
-- salary_details pelo Incidente REVENDA2, Fase 7): todas as 5 funcoes
-- abaixo vinculam portal_finance_operations e/ou portal_spf_operations a
-- portal_sales por CHASSI ou por client_match_key, SEM comparar o store
-- proprio da linha vinculada contra o da venda -- uma linha financeira/SPF
-- REVENDA do MESMO chassi/cliente de uma venda legitima poderia, sem este
-- gate adicional, alimentar a agregacao da venda legitima. Fechado aqui
-- 1:1, no mesmo estilo (predicado tambem sobre f.store e sobre spf.store,
-- em cada ponto de leitura direta).
--
-- Zero normalizacao de "REVENDA" na base hoje (confirmado na auditoria da
-- onda anterior) -- comparacao exata upper(trim()) e suficiente.
--
-- NAO tocado: operational_current_scope(), nenhum GRANT/REVOKE/ALTER/
-- RLS/policy, o mecanismo congelado de selecao "linha oficial vs.
-- transferencia de cobertura" (official_rows/combined_rows em
-- operational_analyst_commission_metrics, absence_metrics em geral) --
-- o fix SOMENTE remove linhas REVENDA da base agregada, nunca altera a
-- formula de comissao/tier/selecao de linhas sobreviventes. Nenhuma linha
-- de portal_sales/portal_finance_operations/portal_spf_operations e
-- apagada, atualizada ou inserida por esta migration.

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
              and upper(trim(coalesce(u.loja, ''))) = v_store
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
              and upper(coalesce(ps.store, '')) = v_store
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

CREATE OR REPLACE FUNCTION public.operational_reporting_summary(p_start date, p_end date)
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
  v_store := v_scope->>'store';
  v_departments := array(
    select jsonb_array_elements_text(v_scope->'departments')
  );
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

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
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc
  ),
  sales_canonical_dedup as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_user_id,
      s.seller_id,
      s.store,
      s.department,
      s.sale_value,
      s.seller_source_name
    from public.portal_sales s
    join latest_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    -- Incidente REVENDA3 (Fase 2): exclui, na propria base, qualquer linha
    -- cujo store PROPRIO da transacao seja REVENDA -- ANTES do fallback
    -- resolve_store_temporal usado em visible_sales.store abaixo. Nunca
    -- por chassi -- mesmo principio do Incidente REVENDA2 (T34887).
    where upper(trim(coalesce(s.store, ''))) <> 'REVENDA'
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select
      s.id,
      s.sale_date,
      s.chassis,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, u.loja, 'SEM LOJA') as store,
      s.department,
      s.sale_value,
      coalesce(u.nome, ps.name, s.seller_source_name, 'SEM VÍNCULO') as seller_name
    from sales_canonical_dedup s
    left join public.usuarios u on u.id = s.seller_user_id
    left join public.portal_sellers ps on ps.id = s.seller_id
    where s.sale_date between p_start and p_end
      and (
        v_is_master
        or (
          coalesce(s.seller_user_id, s.seller_id) is not null
          and s.department = any(v_departments)
          and (
            v_is_director
            or (
              v_is_seller and s.seller_user_id = v_user_id
            )
            or (
              not v_is_seller
              and upper(coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), u.loja, ps.store, '')) = v_store
            )
          )
        )
      )
  ),
  sales_groups as (
    select
      store,
      department,
      seller_id,
      seller_name,
      count(*)::integer as sales_count,
      coalesce(sum(sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales
    group by store, department, seller_id, seller_name
  ),
  finance_groups as (
    select
      vs.store,
      vs.department,
      vs.seller_id,
      vs.seller_name,
      count(distinct f.id) filter (
        where f.is_real_financing or f.is_later_return
      )::integer as financed_count,
      coalesce(sum(f.financed_or_service_value), 0)::numeric(18,2)
        as financed_or_service_value,
      coalesce(sum(f.return_value), 0)::numeric(18,2) as return_value
    from visible_sales vs
    left join public.portal_finance_operations f
      on f.chassis = vs.chassis
     and f.operation_date between p_start and p_end
     and f.batch_id in (select lb.id from latest_batches lb)
     -- Incidente REVENDA3 (Fase 2/7): este join e SOMENTE por chassi --
     -- sem esta linha, uma linha financeira REVENDA do MESMO chassi de uma
     -- venda legitima (padrao T34887) entraria na agregacao financeira da
     -- venda legitima mesmo com visible_sales ja filtrada. Exclusao pelo
     -- store PROPRIO da linha financeira, nunca pelo chassi.
     and upper(trim(coalesce(f.store, ''))) <> 'REVENDA'
    group by vs.store, vs.department, vs.seller_id, vs.seller_name
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'store', sg.store,
        'department', sg.department,
        'seller_id', sg.seller_id,
        'seller_name', sg.seller_name,
        'sales_count', sg.sales_count,
        'sales_value', sg.sales_value,
        'financed_count', coalesce(fg.financed_count, 0),
        'financed_or_service_value',
          coalesce(fg.financed_or_service_value, 0),
        'return_value', coalesce(fg.return_value, 0)
      )
      order by sg.store, sg.department, sg.seller_name
    ),
    '[]'::jsonb
  )
  into v_rows
  from sales_groups sg
  left join finance_groups fg
    on fg.store = sg.store
   and fg.department = sg.department
   and fg.seller_id is not distinct from sg.seller_id
   and fg.seller_name = sg.seller_name;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'rows', v_rows
  );
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
      and upper(trim(coalesce(u.loja, ''))) = upper(trim(p_store))
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
      and upper(trim(coalesce(ps.store, ''))) = upper(trim(p_store))
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

CREATE OR REPLACE FUNCTION public.operational_analyst_coverage_details(p_coverage_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_ausencia public.ausencias_analistas%rowtype;
  v_user public.usuarios%rowtype;
  v_sub public.usuarios%rowtype;
  v_is_master boolean;
  v_caller_cpf text;
  v_result jsonb;
begin
  -- Fase Cobertura-Details 1.0 -- identidade do chamador.
  select *
  into v_user
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.' using errcode = '42501';
  end if;

  v_is_master := public.is_master();
  v_caller_cpf := regexp_replace(coalesce(v_user.cpf_normalizado, v_user.cpf, ''), '\D', '', 'g');

  -- Parametro unico de autoridade: p_coverage_id. Loja/periodo/CPF nunca
  -- sao aceitos como parametro -- tudo vem do registro em ausencias_analistas.
  select * into v_ausencia from public.ausencias_analistas a where a.id = p_coverage_id;

  -- Mensagem identica para "nao existe" e "existe mas nao pertence ao
  -- chamador" -- nunca revelar qual dos dois casos ocorreu (Parte 10).
  if v_ausencia.id is null then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  -- ativo=false = registro arquivado/cancelado pelo MASTER via
  -- master_admin_manage (acao ARCHIVE/SET_ACTIVE) -- NUNCA e setado
  -- automaticamente pela passagem de data_fim (auditado fresh: unico
  -- caminho de escrita da tabela e master_admin_manage, e so altera ativo
  -- em resposta a uma acao administrativa explicita). Por isso o gate
  -- correto e ativo=true, e NAO current_date <= data_fim -- a substituta
  -- deve continuar acessando o historico de uma cobertura ja encerrada
  -- cronologicamente, contanto que o registro nao tenha sido invalidado.
  if not v_ausencia.ativo then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  if not v_is_master then
    if upper(trim(coalesce(v_user.perfil, ''))) <> 'ANALISTA' then
      raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
    end if;
    -- Identidade por CPF normalizado -- mesmo contrato comprovado de
    -- ausencias_analistas.cpf_analista_substituto. Nunca por nome.
    -- Titular/ausente (cpf_analista_ausente) explicitamente NAO autoriza
    -- nesta versao, mesmo que o CPF do chamador bata com ele.
    if regexp_replace(coalesce(v_ausencia.cpf_analista_substituto, ''), '\D', '', 'g') <> v_caller_cpf then
      raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
    end if;
  end if;

  -- Escopo de departamento elegivel usa o cadastro da PROPRIA substituta
  -- (nunca do chamador) -- garante que MASTER abrindo o mesmo coverage_id
  -- ve exatamente a mesma populacao que a substituta veria, preservando a
  -- semantica ja usada em operational_analyst_coverage_metrics sem
  -- reinventar regra nova.
  select *
  into v_sub
  from public.usuarios u
  where u.cpf_normalizado = regexp_replace(coalesce(v_ausencia.cpf_analista_substituto, ''), '\D', '', 'g')
    and u.ativo = true
  limit 1;

  if v_sub.id is null then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  with
  -- Mesmo bloco de latest_validated_batches de operational_analyst_coverage_metrics.
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
  -- Mesmo bloco de eligible_sellers de operational_analyst_coverage_metrics,
  -- trocando v_user por v_ausencia.loja_coberta / v_sub.status (a mesma
  -- entrada que a funcao original usaria se a propria substituta chamasse).
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_ausencia.loja_coberta))
      and (
        (
          upper(trim(coalesce(u.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_sub.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(u.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_sub.status, '')) like '%SEMINOVOS%'
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
      and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_ausencia.loja_coberta))
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        (
          upper(trim(coalesce(ps.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_sub.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(ps.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_sub.status, '')) like '%SEMINOVOS%'
        )
      )
  ),
  -- Mesmo bloco de sales_global_latest, com model/chassi adicionados para o
  -- detalhamento (nao existiam no agregado por nao serem necessarios la).
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.vehicle_model,
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
    select s.*, es.name as seller_name, es.status as seller_department
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between v_ausencia.data_inicio and v_ausencia.data_fim
      and upper(trim(coalesce(s.store, ''))) = upper(trim(v_ausencia.loja_coberta))
  ),
  -- Mesmo bloco de visible_finance de operational_analyst_coverage_metrics.
  visible_finance as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if,
      es.name as seller_name, es.status as seller_department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between v_ausencia.data_inicio and v_ausencia.data_fim
      and upper(trim(coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, ''))) =
          upper(trim(v_ausencia.loja_coberta))
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
  -- Mesmo dedup de spf_linked/spf_metrics de operational_analyst_coverage_metrics
  -- (distinct por seller_id+spf.id) -- autoridade do summary.spf_count/spf_value,
  -- garante reconciliacao 1:1 com o agregado existente.
  spf_dedup_by_seller as (
    select distinct vf.seller_id, spf.id, spf.optional_value
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- Incidente REVENDA3 (Fase 2/7): protecao independente pelo store
     -- PROPRIO da linha SPF -- mesmo padrao dos demais joins por
     -- client_match_key nesta migration.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  -- So para marcar, na linha de financiamento exibida, se ha SPF vinculado
  -- ao mesmo cliente -- flag booleana, nunca valor por linha, para nao
  -- arriscar dupla-contagem visual quando 1 cliente casa com >1 operacao.
  spf_present_by_finance as (
    select distinct vf.id as finance_id
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- Incidente REVENDA3 (Fase 2/7): mesma protecao independente de
     -- spf_dedup_by_seller acima -- uma linha SPF REVENDA nunca deve
     -- acender o flag has_spf_linked de uma operacao financeira legitima.
     and upper(trim(coalesce(spf.store, ''))) <> 'REVENDA'
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  sales_rows as (
    select jsonb_agg(
      jsonb_build_object(
        'sale_id', vs.id,
        'sale_date', vs.sale_date,
        'seller_id', vs.seller_id,
        'seller_name', vs.seller_name,
        'store', vs.store,
        'department', vs.seller_department,
        'model', vs.vehicle_model,
        'chassis_masked', case
          when vs.chassis is null or length(vs.chassis) <= 6 then vs.chassis
          else repeat('*', length(vs.chassis) - 6) || right(vs.chassis, 6)
        end,
        'sale_value', vs.sale_value
      )
      order by vs.sale_date, vs.seller_name, vs.id
    ) as rows
    from visible_sales vs
  ),
  finance_rows as (
    select jsonb_agg(
      jsonb_build_object(
        'finance_id', ef.id,
        'operation_date', ef.operation_date,
        'seller_id', ef.seller_id,
        'seller_name', ef.seller_name,
        'store', v_ausencia.loja_coberta,
        'department', ef.seller_department,
        'model', ef.vehicle_model,
        'chassis_masked', case
          when ef.chassis is null or length(ef.chassis) <= 6 then ef.chassis
          else repeat('*', length(ef.chassis) - 6) || right(ef.chassis, 6)
        end,
        'is_real_financing', ef.is_real_financing,
        'is_later_return', ef.is_later_return,
        'finance_code', ef.finance_code,
        'plan_codigo_if', ef.plan_codigo_if,
        'financed_or_service_value', ef.financed_or_service_value,
        'return_value', ef.return_value,
        'has_spf_linked', exists (select 1 from spf_present_by_finance sp where sp.finance_id = ef.id)
      )
      order by ef.operation_date, ef.seller_name, ef.id
    ) as rows
    from effective_finance ef
  ),
  summary as (
    select
      (select count(*) from visible_sales)::integer as sold_count,
      (select count(distinct chassis) from effective_finance)::integer as financed_count,
      (select coalesce(sum(financed_or_service_value), 0) from effective_finance)::numeric(18,2) as production_value,
      (select coalesce(sum(return_value), 0) from effective_finance)::numeric(18,2) as return_value,
      (select count(*) from spf_dedup_by_seller)::integer as spf_count,
      (select coalesce(sum(optional_value), 0) from spf_dedup_by_seller)::numeric(18,2) as spf_value
  )
  select jsonb_build_object(
    'coverage_id', v_ausencia.id,
    'store', v_ausencia.loja_coberta,
    'covered_start', v_ausencia.data_inicio,
    'covered_end', v_ausencia.data_fim,
    'substitute_analyst_name', v_ausencia.nome_analista_substituto,
    'absent_analyst_name', v_ausencia.nome_analista_ausente,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', true,
    'chassis_masking', 'last6',
    'summary', jsonb_build_object(
      'sold_count', s.sold_count,
      'financed_count', s.financed_count,
      'production_value', s.production_value,
      'return_value', s.return_value,
      'spf_count', s.spf_count,
      'spf_value', s.spf_value
    ),
    'sales', coalesce(sr.rows, '[]'::jsonb),
    'finance', coalesce(fr.rows, '[]'::jsonb)
  )
  into v_result
  from summary s, sales_rows sr, finance_rows fr;

  return v_result;
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

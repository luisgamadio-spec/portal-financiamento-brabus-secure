-- RH-ANALYST-4 -- Resolver ESTRITO de responsabilidade na comissao do
-- Analista de F&I + aposentadoria da selecao alfabetica.
--
-- Substitui, dentro de operational_analyst_commission_metrics, a regra
-- arbitraria de destinatario:
--
--     select u.nome from public.usuarios
--      where ativo and perfil='ANALISTA' and loja = st.store
--      order by u.nome limit 1
--
-- pela autoridade temporal governada criada na RH-ANALYST-2/3
-- (analista_responsavel_loja), resolvida por LOJA + JANELA DE DATAS.
--
-- ============================================================
-- O QUE MUDA
-- ============================================================
--   * o destinatario passa a vir do UUID governado, nunca da ordem
--     alfabetica do nome;
--   * o periodo e particionado por SEGMENTO de responsabilidade, entao
--     um handover no meio da competencia divide os fatos pela data --
--     nunca atribui o periodo inteiro ao analista do fim do periodo;
--   * ausencia/cobertura passa a ser intersectada DENTRO de cada
--     segmento de responsabilidade (janelas RESPABS:), preservando
--     integralmente o mecanismo de substituto ja existente;
--   * fail-closed: reconciliacao exige que a soma dos segmentos bata
--     EXATAMENTE com o total da loja. Falta => omissao => 22023.
--     Sobra => duplicacao => 22023. Nunca inventa destinatario.
--   * periodo inteiramente anterior a primeira vigencia governada
--     devolve rows=[] com responsibility_governed=false, em vez de
--     cair na regra antiga.
--
-- ============================================================
-- O QUE *NAO* MUDA (FORMULA FREEZE)
-- ============================================================
-- Nenhuma formula financeira foi tocada: retorno, 70% SPF, faixas,
-- percentuais, bucketing exato NOVOS/SEMINOVOS, regras de gerente,
-- vendedor e Gestor F&I, deduplicacao por chassi, later-return,
-- SPF por client_match_key e o filtro final de atividade permanecem
-- byte-a-byte os da definicao live anterior. Esta Wave muda
-- ATRIBUICAO DE DESTINATARIO, nada mais.
--
-- ============================================================
-- RECONCILIACAO PROVADA ANTES DO APPLY
-- ============================================================
-- OLD vs NEW executados lado a lado dentro de BEGIN...ROLLBACK contra
-- os dados reais da competencia aberta (2026-08-21 a 2026-09-21):
-- projecao financeira canonica IDENTICA, mesmo hash, 8 linhas em ambos.
-- Esperado e confirmado: em todas as 9 lojas o responsavel governado
-- coincide com quem a regra alfabetica ja escolhia -- 8 lojas tem um
-- unico analista, e em BARRA FUNDA a escolha explicita do Humano
-- (2026-08-21) e tambem a primeira alfabeticamente. Delta financeiro
-- zero, por prova e nao por suposicao.
--
-- Construida a partir da definicao LIVE (pg_get_functiondef), nao de
-- uma copia do repositorio -- mesma licao da RH-5C.3.

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
  -- RH-ANALYST-4
  v_gov_start date;
  v_missing integer := 0;
  v_conflict integer := 0;
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

  -- RH-ANALYST-4: era governada. Antes da primeira vigencia oficial nao
  -- existe autoridade de responsabilidade -- e NUNCA se inventa uma. Um
  -- periodo totalmente anterior devolve payload vazio e explicitamente
  -- nao-governado, em vez de cair na antiga selecao alfabetica de analista.
  select min(r.valid_from) into v_gov_start
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE';

  if v_gov_start is null or p_end < v_gov_start then
    return jsonb_build_object(
      'period_start', p_start,
      'period_end', p_end,
      'absence_aware', true,
      'responsibility_governed', false,
      'contains_personal_documents', false,
      'contains_client_identity', false,
      'contains_chassis', false,
      'rows', '[]'::jsonb
    );
  end if;

  with
  -- RH-ANALYST-4: segmentos de responsabilidade oficial que intersectam o
  -- periodo. Fim EXCLUSIVO na tabela -> fim INCLUSIVO aqui (valid_to - 1),
  -- para casar com a convencao de datas inclusivas de ausencias_analistas
  -- e das janelas ja existentes.
  resp_windows as (
    select
      r.id as resp_id,
      r.loja_normalizada as store,
      r.analista_usuario_id,
      greatest(r.valid_from, p_start) as r_start,
      least(coalesce(r.valid_to - 1, p_end), p_end) as r_end
    from public.analista_responsavel_loja r
    where r.status = 'ACTIVE'
      and r.valid_from <= p_end
      and (r.valid_to is null or r.valid_to > p_start)
  ),
  -- Intersecao responsabilidade x ausencia: o que o substituto cobriu
  -- DENTRO de cada segmento de responsabilidade.
  resp_absence_windows as (
    select
      rw.resp_id,
      rw.store,
      a.id as absence_id,
      greatest(a.data_inicio, rw.r_start) as ra_start,
      least(a.data_fim, rw.r_end) as ra_end
    from resp_windows rw
    join public.ausencias_analistas a
      on a.ativo = true
     and upper(trim(coalesce(a.loja_coberta, ''))) = rw.store
     and a.data_inicio <= rw.r_end
     and a.data_fim >= rw.r_start
  ),
  windows as (
    select 'BASE'::text as window_id, p_start as w_start, p_end as w_end
    union all
    select a.id::text, greatest(a.data_inicio, p_start), least(a.data_fim, p_end)
    from public.ausencias_analistas a
    where a.ativo = true
      and a.data_inicio <= p_end
      and a.data_fim >= p_start
    union all
    select 'RESP:' || rw.resp_id::text, rw.r_start, rw.r_end
    from resp_windows rw
    union all
    select 'RESPABS:' || raw.resp_id::text || ':' || raw.absence_id::text,
           raw.ra_start, raw.ra_end
    from resp_absence_windows raw
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
  -- RH-ANALYST-4: totais por SEGMENTO de responsabilidade (nao mais por
  -- loja inteira), para que um handover no meio do periodo divida os
  -- fatos pela data em que cada analista era de fato o responsavel.
  resp_totals as (
    select
      rw.resp_id,
      rw.store,
      rw.analista_usuario_id,
      coalesce(wst.sold_count, 0)::integer as sold_count,
      coalesce(wst.financed_count, 0)::integer as financed_count,
      coalesce(wst.production_value, 0)::numeric(18,2) as production_value,
      coalesce(wst.return_value, 0)::numeric(18,2) as return_value,
      coalesce(wst.spf_count, 0)::integer as spf_count,
      coalesce(wst.spf_value, 0)::numeric(18,2) as spf_value
    from resp_windows rw
    left join window_store_totals wst
      on wst.window_id = 'RESP:' || rw.resp_id::text
     and upper(trim(wst.store)) = rw.store
  ),
  resp_absence_sums as (
    select
      raw.resp_id,
      sum(coalesce(wst.sold_count, 0))::integer as sold_count,
      sum(coalesce(wst.financed_count, 0))::integer as financed_count,
      sum(coalesce(wst.production_value, 0))::numeric(18,2) as production_value,
      sum(coalesce(wst.return_value, 0))::numeric(18,2) as return_value,
      sum(coalesce(wst.spf_count, 0))::integer as spf_count,
      sum(coalesce(wst.spf_value, 0))::numeric(18,2) as spf_value
    from resp_absence_windows raw
    left join window_store_totals wst
      on wst.window_id = 'RESPABS:' || raw.resp_id::text || ':' || raw.absence_id::text
     and upper(trim(wst.store)) = raw.store
    group by raw.resp_id
  ),
  -- Reconciliacao: a soma dos segmentos tem de bater EXATAMENTE com o
  -- total da loja no periodo. Menos = dia sem dono (omissao); mais = dia
  -- com dois donos (duplicacao). Ambos falham fechado.
  reconciliation as (
    select
      bst.store,
      bst.sold_count     as base_sold, coalesce(sum(rt.sold_count), 0)     as resp_sold,
      bst.financed_count as base_fin,  coalesce(sum(rt.financed_count), 0) as resp_fin,
      bst.return_value   as base_ret,  coalesce(sum(rt.return_value), 0)   as resp_ret,
      bst.spf_count      as base_spfq, coalesce(sum(rt.spf_count), 0)      as resp_spfq,
      bst.spf_value      as base_spfv, coalesce(sum(rt.spf_value), 0)      as resp_spfv
    from base_store_totals bst
    left join resp_totals rt on rt.store = upper(trim(bst.store))
    group by bst.store, bst.sold_count, bst.financed_count,
             bst.return_value, bst.spf_count, bst.spf_value
  ),
  official_rows as (
    select
      -- Identidade vem do UUID governado. O nome e so apresentacao, e a
      -- busca NAO filtra por ativo: quem foi responsavel num periodo
      -- continua nomeado ali mesmo se for desativado depois.
      coalesce(u.nome, 'ANALISTA NAO LOCALIZADO') as analyst_name,
      rt.store,
      greatest(rt.sold_count - coalesce(ras.sold_count, 0), 0)::integer
        as sold_count,
      greatest(rt.financed_count - coalesce(ras.financed_count, 0), 0)::integer
        as financed_count,
      greatest(rt.production_value - coalesce(ras.production_value, 0), 0)
        ::numeric(18,2) as production_value,
      greatest(rt.return_value - coalesce(ras.return_value, 0), 0)
        ::numeric(18,2) as return_value,
      greatest(rt.spf_count - coalesce(ras.spf_count, 0), 0)::integer
        as spf_count,
      greatest(rt.spf_value - coalesce(ras.spf_value, 0), 0)
        ::numeric(18,2) as spf_value,
      false as transfer,
      null::date as covered_start,
      null::date as covered_end,
      null::text as coverage_id
    from resp_totals rt
    left join resp_absence_sums ras on ras.resp_id = rt.resp_id
    left join public.usuarios u on u.id = rt.analista_usuario_id
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
  , (select count(*) from reconciliation
      where (base_sold > 0 or base_fin > 0 or base_ret > 0 or base_spfv > 0)
        and (resp_sold < base_sold or resp_fin < base_fin or resp_ret < base_ret
             or resp_spfq < base_spfq or resp_spfv < base_spfv))
  , (select count(*) from reconciliation
      where resp_sold > base_sold or resp_fin > base_fin or resp_ret > base_ret
         or resp_spfq > base_spfq or resp_spfv > base_spfv)
  into v_result, v_missing, v_conflict
  from combined_rows
  where sold_count > 0
     or financed_count > 0
     or return_value > 0
     or spf_value > 0;

  -- RH-ANALYST-4: FAIL-CLOSED. Nunca devolve destinatario inventado.
  if v_conflict > 0 then
    raise exception 'Responsabilidade de analista conflitante para o periodo informado.'
      using errcode = '22023';
  end if;
  if v_missing > 0 then
    raise exception 'Responsabilidade de analista nao configurada para o periodo informado.'
      using errcode = '22023';
  end if;

  return v_result;
end;
$function$
;

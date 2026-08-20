-- Incidente 22.6/22.6B -- hotfix da regressao nas comissoes de cobertura
-- de ferias/ausencias (sentinela: Giovanna Cristina Rivera; casos
-- historicos: Denise, Jacenir).
--
-- Causa raiz (comprovada por comparacao byte-a-byte entre migrations):
-- a CTE visible_sales de operational_analyst_coverage_metrics referenciava
-- s.seller_user_id (nao existe em sales_global_latest, que ja coalesceu
-- pra seller_id) e ps.store (alias fora de escopo -- so existia na CTE
-- anterior). Regressao introduzida na Fase 21.8B (commit c45fc31, "feat:
-- resolve seller store/department allocation by fact date",
-- 2026-08-19 17:57:21 -03:00) ao copiar a expressao de
-- resolve_store_temporal usada em sales_global_latest sem ajustar pro
-- novo escopo -- coluna/alias inexistentes faziam a funcao lancar
-- excecao SQL em TODA chamada, para qualquer loja/periodo/analista.
-- Confirmado nas Fases 21.4 e 21.7: a CTE estava correta antes da 21.8B.
--
-- Efeito em producao: operational_analyst_commission_metrics_v2 (a RPC
-- real chamada pelo frontend) nao tem tratamento de excecao ao redor
-- dessa chamada -- o erro aborta a RPC inteira sempre que o analista logado
-- tem pelo menos uma ausencia ativa cobrindo loja diferente da propria no
-- periodo consultado. O frontend captura o erro e zera
-- OPERATIONAL_ANALYST_METRICS_STATE silenciosamente (so loga no console) --
-- por isso a secao "Coberturas -- Ferias/Ausencias" (Incidente 5.6) somem
-- por completo, nao so as linhas de cobertura.
--
-- Correcao: a loja ja foi resolvida corretamente (com resolve_store_temporal,
-- alocacao temporal da Fase 21.8B preservada) dentro de sales_global_latest
-- -- visible_sales so precisa comparar o resultado ja pronto (s.store),
-- nunca recalcula-lo de novo com aliases fora de escopo. Patch de uma
-- unica expressao, partindo do corpo LIVE atual (pg_get_functiondef fresh,
-- nunca reconstruido a partir de migration antiga) -- nenhuma outra CTE,
-- grant ou search_path alterados.
--
-- Testado em transacoes com ROLLBACK contra dados reais (nada persistido):
-- Giovanna (5 linhas via a RPC real operational_analyst_commission_metrics_v2
-- -- BARRA FUNDA propria, BARRA FUNDA coberta por Jacenir, GASTAO/ANALIA
-- FRANCO/ABC cobertas por ela), Denise (3 linhas) e Jacenir (4 linhas) --
-- todas coerentes e cruzadas entre si (o mesmo evento aparece
-- corretamente nos dois lados quando aplicavel). Confirmado sem
-- duplicidade: official_rows (linha do titular) ja subtrai a janela de
-- ausencia do total base -- a linha de cobertura e aditiva e
-- complementar, nunca sobreposta.
--
-- population no periodo atual (21/07-20/08/2026): 3 analistas (Giovanna,
-- Denise, Jacenir), 7 janelas de cobertura ativas.
--
-- Zero alteracao de dados: usuarios/ausencias_analistas/snapshots/
-- fechamentos/fatos/alertas = 0. Grants (postgres, service_role -- sem
-- anon/authenticated/PUBLIC, ja que esta funcao so e chamada internamente
-- por operational_analyst_commission_metrics_v2, nunca diretamente pelo
-- frontend) e search_path preservados exatamente como no LIVE anterior.

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
      and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT')
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
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  -- Incidente 22.6 -- visible_sales referenciava s.seller_user_id (nao
  -- existe em sales_global_latest, que ja coalesceu pra seller_id) e
  -- ps.store (alias fora de escopo aqui -- so existia dentro da CTE
  -- anterior). Regressao introduzida na Fase 21.8B (commit c45fc31) ao
  -- copiar a expressao de resolve_store_temporal de sales_global_latest
  -- sem ajustar pro novo escopo -- coluna/alias inexistentes faziam a
  -- funcao lancar excecao SQL em TODA chamada, para qualquer
  -- loja/periodo/analista. A loja ja foi resolvida corretamente (com
  -- resolve_store_temporal, alocacao temporal preservada) dentro de
  -- sales_global_latest -- aqui so precisa comparar o resultado ja pronto.
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
  -- CORRECAO: so considera operacoes do LOTE VALIDADO mais recente, igual
  -- ao caminho MASTER (operational_analyst_commission_metrics). Antes,
  -- esta funcao lia public.portal_finance_operations sem nenhum filtro de
  -- lote, somando valores de lotes antigos/substituidos junto com o atual.
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
  -- CORRECAO: mesmo join de lote validado para SPF_CURRENT.
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
$function$

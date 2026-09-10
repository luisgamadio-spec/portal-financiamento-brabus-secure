-- ============================================================
-- [RANKING] PERF-5D.1A -- FALLBACK DE LOJA PELA VENDA DO CHASSI
-- ============================================================
--
-- DEFEITO (provado em PERF-5D.1)
-- Quando a resolucao primaria de loja nao devolve loja utilizavel, o motor
-- do Ranking marcava a operacao como SEM LOJA e a deixava sem atribuicao
-- -- mesmo quando o MESMO evento de negocio tem uma venda ligada por
-- chassi, temporalmente valida, carregando a loja canonica.
-- Cinco operacoes (jun/2026 e ago/2026) ficaram sem dono por isso.
--
-- CORRECAO
-- Fallback SECUNDARIO, exclusivo do Ranking, consumido apenas por
-- performance_calcular_periodo. Nao altera nada compartilhado.
--
-- PRECEDENCIA (inalterada, o fallback so entra no fim)
--   1. autoridade primaria de loja (resolve_store_temporal)
--   2. normalizacao do Ranking, incluindo H7 ("2" -> BARRA FUNDA)
--   3. SOMENTE se ainda nao houver loja utilizavel: venda do chassi
--   4. responsabilidade temporal do Analista
--
-- G4 STRICT_DATE_BOUNDED PRESERVADO
-- So considera vendas com sale_date <= data da operacao. Uma venda
-- posterior JAMAIS determina a loja historica.
--
-- FALHA SEGURA (nao adivinha)
-- Escolhe a venda mais recente ate a data. Se houver mais de uma venda
-- NESSA MESMA data mais recente e elas discordarem da loja canonica, a
-- funcao devolve NULL e a operacao permanece SEM LOJA, com motivo
-- auditavel. Nunca usa maioria, vizinhanca, loja habitual do vendedor,
-- historico do cliente, ordem alfabetica nem cobertura de Salario.
--
-- NAO TOCA
--   - resolve_store_temporal (compartilhada com Salario/Score/Coparticipado)
--   - operational_analyst_commission_metrics
--   - snapshots/fechamentos de Salario
--   - portal_sales / portal_finance_operations (evidencia bruta intacta;
--     esta e uma correcao de LEITURA, nao de dado)

-- ============================================================
-- 1. HELPER RANKING-ONLY
-- ============================================================
create or replace function public.performance_loja_por_venda_do_chassi(
  p_chassis text,
  p_data date
)
returns text
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  with lvb as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
  candidatas as (
    -- G4: somente vendas ATE a data da operacao
    select s.sale_date,
           public.performance_normalizar_loja(upper(btrim(coalesce(s.store,'')))) as loja
    from public.portal_sales s
    join lvb on lvb.id = s.batch_id
    where btrim(coalesce(s.chassis,'')) = btrim(coalesce(p_chassis,''))
      and btrim(coalesce(p_chassis,'')) <> ''
      and s.sale_date <= p_data
      and coalesce(btrim(s.store), '') <> ''),
  mais_recentes as (
    select loja from candidatas
    where sale_date = (select max(sale_date) from candidatas))
  -- falha segura: se as vendas da data mais recente discordarem, devolve
  -- NULL em vez de escolher uma delas.
  select case when count(distinct loja) = 1 then min(loja) else null end
  from mais_recentes;
$function$;

comment on function public.performance_loja_por_venda_do_chassi(text, date) is
  'PERF-5D.1A: fallback SECUNDARIO de loja para o Ranking, a partir da '
  'venda ligada por chassi e temporalmente valida (sale_date <= data da '
  'operacao). Devolve NULL quando as vendas da data mais recente '
  'discordam -- nunca adivinha. Consumida exclusivamente por '
  'performance_calcular_periodo; nao e um resolvedor global de loja e '
  'nenhuma funcao de Salario a chama.';

-- ============================================================
-- 2. MOTOR -- fallback aplicado apos a autoridade primaria
-- ============================================================
create or replace function public.performance_calcular_periodo(
  p_inicio date,
  p_fim date
)
returns table (
  analista_usuario_id uuid,
  loja text,
  loja_origem_codigo text,
  departamento text,
  operacoes int,
  retorno numeric,
  spf_valor numeric,
  spf_unidades int,
  responsabilidade_procedencia text
)
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  with lvb as (
    select distinct on (b.source_type) b.id, b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
  sales_all as (
    select s.chassis, s.sale_date, s.department, s.id
    from public.portal_sales s
    join lvb on lvb.id = s.batch_id and lvb.source_type in ('SALES_CURRENT','SALES_HISTORY')
    where coalesce(s.chassis,'') <> ''),
  spf as (
    select o.client_match_key, o.optional_value
    from public.portal_spf_operations o
    where o.batch_id = (select b.id from public.portal_import_batches b
        where b.status='VALIDATED' and b.source_type='SPF_CURRENT'
        order by b.completed_at desc nulls last, b.created_at desc, b.id desc limit 1)
      and o.is_spf_extra and coalesce(o.optional_value,0) > 0
      -- G20: o fato SPF tem de pertencer AO MESMO periodo
      and o.operation_date between p_inicio and p_fim),
  fin as (
    select f.chassis, f.operation_date d, f.return_value v, f.client_match_key,
      btrim(coalesce(f.store,'')) as store_bruto,
      -- 1 e 2: autoridade primaria + normalizacao do Ranking (H7)
      public.performance_normalizar_loja(
        coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id, f.seller_id),
          f.operation_date, nullif(f.store,'')), 'SEM LOJA')) as loja_primaria
    from public.portal_finance_operations f
    join lvb on lvb.id = f.batch_id and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    where f.is_real_financing and f.operation_date between p_inicio and p_fim),
  fin_res as (
    select fin.*,
      -- 3: fallback SO quando a primaria nao produziu loja utilizavel
      case when fin.loja_primaria = 'SEM LOJA'
        then coalesce(public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d), 'SEM LOJA')
        else fin.loja_primaria
      end as loja_norm,
      (fin.loja_primaria = 'SEM LOJA'
        and public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d) is not null) as veio_do_fallback
    from fin),
  res as (
    select fin_res.*,
      (select sa.department from sales_all sa
        where sa.chassis = fin_res.chassis and sa.sale_date <= fin_res.d
        order by sa.sale_date desc, sa.id desc limit 1) as dept,
      (select coalesce(sum(spf.optional_value),0) from spf
        where spf.client_match_key = fin_res.client_match_key) as spf_val,
      (select count(*) from spf where spf.client_match_key = fin_res.client_match_key) as spf_qtd,
      -- 4: responsabilidade temporal do Ranking
      (select r.analista_usuario_id from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = fin_res.loja_norm
          and fin_res.d >= r.valid_from and (r.valid_to is null or fin_res.d < r.valid_to)
        limit 1) as analista,
      (select r.procedencia from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = fin_res.loja_norm
          and fin_res.d >= r.valid_from and (r.valid_to is null or fin_res.d < r.valid_to)
        limit 1) as proc
    from fin_res)
  select res.analista, res.loja_norm,
    -- proveniencia auditavel: codigo H7, ou marca de fallback por chassi
    coalesce(
      (select m.codigo_origem from public.performance_loja_codigo_map m
        where m.codigo_origem = res.store_bruto),
      case when res.veio_do_fallback then 'FALLBACK_VENDA_CHASSI' else null end) as loja_origem_codigo,
    res.dept, count(*)::int, sum(res.v), sum(res.spf_val), sum(res.spf_qtd)::int,
    coalesce(res.proc, 'UNRESOLVED')
  from res
  group by res.analista, res.loja_norm, 3, res.dept, res.proc;
$function$;

comment on function public.performance_calcular_periodo(date, date) is
  'PERF-5C/5D.1A: motor unico de calculo do Ranking. G4 STRICT_DATE_BOUNDED, '
  'G15 pelo mapa de codigo, fallback SECUNDARIO pela venda do chassi quando '
  'a loja primaria nao resolve, SPF escopado ao proprio periodo (G20), '
  'responsabilidade pela autoridade temporal do Ranking. Nao le nem '
  'escreve nada de Salario.';

revoke all on function public.performance_loja_por_venda_do_chassi(text, date) from public, anon;
grant execute on function public.performance_loja_por_venda_do_chassi(text, date) to service_role;

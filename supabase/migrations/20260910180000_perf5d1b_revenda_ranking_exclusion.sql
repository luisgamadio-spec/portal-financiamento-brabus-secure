-- ============================================================
-- [RANKING] PERF-5D.1B -- H10: REVENDA FORA DO ESCOPO DO RANKING
-- ============================================================
--
-- DECISAO HUMANA H10, palavras do Humano:
--
--     "IGNORAR TUDO O QUE FOR REVENDA."
--
-- Interpretacao canonica para o Ranking de Performance de Analistas:
-- todo evento cujo classificador canonico de loja do Ranking resolva para
-- REVENDA esta FORA DO ESCOPO. Nao e "zero pontos" -- e ausencia do
-- universo elegivel.
--
-- REVENDA portanto NAO:
--   exige Analista responsavel;  contribui com metrica;
--   recebe atribuicao;           contribui com ponto;
--   aparece como nao atribuida;  conta como residuo;
--   bloqueia fechamento;         afeta podio/mes/quadrimestre/YTD;
--   gera decisao de titular;     exige reconstrucao historica.
--
-- ESCOPO: SOMENTE RANKING. Nao se aplica a Salario, Score, Coparticipado,
-- Intelligence ou qualquer outro dominio. REVENDA continua sendo
-- evidencia operacional legitima em todos eles.
--
-- A REGRA E POR CLASSIFICACAO, NUNCA POR OPERACAO
-- A exclusao olha a loja canonica do Ranking. Nao ha exclusao por chassi,
-- por id de operacao, por cliente, por data nem por "aquelas tres linhas".
--
-- O QUE ESTA MIGRACAO NAO FAZ
--   - nao fecha nem reabre periodo algum;
--   - nao escreve em performance_periodo/_snapshot/_resultado/_detalhe;
--   - nao altera resolve_store_temporal (compartilhada com Salario);
--   - nao altera operational_analyst_commission_metrics;
--   - nao altera o fallback por chassi do PERF-5D.1A;
--   - nao altera H7 ("2" -> BARRA FUNDA) nem H8 (SPF a partir de 21/05);
--   - nao toca portal_sales nem portal_finance_operations.

-- ============================================================
-- 1. AUTORIDADE DE ESCOPO (dado, nao literal espalhado no codigo)
-- ============================================================
create table if not exists public.performance_loja_fora_de_escopo (
  id uuid primary key default gen_random_uuid(),
  loja_canonica text not null,
  autoridade text not null,
  decisao text not null,
  motivo text not null,
  criado_em timestamptz not null default now(),
  constraint performance_loja_fora_de_escopo_unica unique (loja_canonica),
  constraint performance_loja_fora_de_escopo_autoridade_check
    check (autoridade in ('HUMAN_APPROVED'))
);

comment on table public.performance_loja_fora_de_escopo is
  'PERF-5D.1B/H10: lojas canonicas que NAO participam do Ranking de '
  'Performance. Fora de escopo nao e zero ponto -- e ausencia do universo '
  'elegivel. Autoridade exclusiva do Ranking; nenhum outro dominio a le.';

insert into public.performance_loja_fora_de_escopo
  (loja_canonica, autoridade, decisao, motivo)
select 'REVENDA', 'HUMAN_APPROVED', 'H10',
  'Palavras do Humano: "IGNORAR TUDO O QUE FOR REVENDA." REVENDA fica '
  'fora do universo elegivel do Ranking de Analistas, historica e '
  'prospectivamente. Nao exige titular, nao contribui com metrica nem '
  'ponto, e nao constitui residuo. Permanece evidencia operacional valida '
  'em Salario e nos demais dominios.'
where not exists (
  select 1 from public.performance_loja_fora_de_escopo where loja_canonica = 'REVENDA');

-- ============================================================
-- 2. PREDICADO DE ELEGIBILIDADE
-- ============================================================
-- Recebe a loja JA CANONICA (pos-normalizacao H7 e pos-fallback por
-- chassi), para que variacoes de caixa/espaco nao escapem da regra.
create or replace function public.performance_loja_fora_de_escopo_ranking(
  p_loja_canonica text
)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select exists (
    select 1 from public.performance_loja_fora_de_escopo e
    where e.loja_canonica = upper(btrim(coalesce(p_loja_canonica, ''))));
$function$;

comment on function public.performance_loja_fora_de_escopo_ranking(text) is
  'PERF-5D.1B/H10: true quando a loja canonica esta fora do escopo do '
  'Ranking. Aplicado DEPOIS da normalizacao e do fallback, para que a '
  'exclusao valha sobre a classificacao final e nao sobre o texto bruto.';

-- ============================================================
-- 3. MOTOR -- exclusao ANTES da responsabilidade e da metrica
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
  elegivel as (
    -- 4: H10 -- a loja canonica final decide a elegibilidade. Fora de
    -- escopo sai AQUI, antes de qualquer resolucao de responsabilidade e
    -- antes de qualquer metrica: nunca entra no universo do Ranking.
    select * from fin_res
    where not public.performance_loja_fora_de_escopo_ranking(fin_res.loja_norm)),
  res as (
    select elegivel.*,
      (select sa.department from sales_all sa
        where sa.chassis = elegivel.chassis and sa.sale_date <= elegivel.d
        order by sa.sale_date desc, sa.id desc limit 1) as dept,
      (select coalesce(sum(spf.optional_value),0) from spf
        where spf.client_match_key = elegivel.client_match_key) as spf_val,
      (select count(*) from spf where spf.client_match_key = elegivel.client_match_key) as spf_qtd,
      -- 5: responsabilidade temporal do Ranking
      (select r.analista_usuario_id from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = elegivel.loja_norm
          and elegivel.d >= r.valid_from and (r.valid_to is null or elegivel.d < r.valid_to)
        limit 1) as analista,
      (select r.procedencia from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = elegivel.loja_norm
          and elegivel.d >= r.valid_from and (r.valid_to is null or elegivel.d < r.valid_to)
        limit 1) as proc
    from elegivel)
  select res.analista, res.loja_norm,
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
  'PERF-5C/5D.1A/5D.1B: motor unico do Ranking. Ordem: loja primaria -> '
  'normalizacao H7 -> fallback por venda do chassi -> H10 (fora de escopo '
  'sai do universo) -> responsabilidade temporal -> metricas. G4 '
  'STRICT_DATE_BOUNDED e SPF escopado ao periodo (G20) preservados. Nao '
  'le nem escreve nada de Salario.';

-- ============================================================
-- 4. OBSERVABILIDADE FORENSE (sem poluir o resultado do Ranking)
-- ============================================================
-- Diagnostico separado: permite auditar o que foi excluido sem que essas
-- operacoes entrem em snapshot algum como "elegivel nao atribuida".
create or replace function public.performance_operacoes_fora_de_escopo(
  p_inicio date,
  p_fim date
)
returns table (
  loja text,
  motivo text,
  operacoes int,
  retorno numeric
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
      and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
  fin as (
    select f.chassis, f.operation_date d, f.return_value v,
      public.performance_normalizar_loja(
        coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id, f.seller_id),
          f.operation_date, nullif(f.store,'')), 'SEM LOJA')) as loja_primaria
    from public.portal_finance_operations f
    join lvb on lvb.id = f.batch_id
    where f.is_real_financing and f.operation_date between p_inicio and p_fim),
  fin_res as (
    select fin.*,
      case when fin.loja_primaria = 'SEM LOJA'
        then coalesce(public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d), 'SEM LOJA')
        else fin.loja_primaria end as loja_norm
    from fin)
  select fin_res.loja_norm,
    'OUT_OF_SCOPE_' || fin_res.loja_norm,
    count(*)::int, sum(fin_res.v)
  from fin_res
  where public.performance_loja_fora_de_escopo_ranking(fin_res.loja_norm)
  group by fin_res.loja_norm;
$function$;

comment on function public.performance_operacoes_fora_de_escopo(date, date) is
  'PERF-5D.1B: diagnostico das operacoes excluidas do Ranking por H10. '
  'Serve a relatorios forenses; nada aqui entra em snapshot oficial nem '
  'conta como residuo elegivel.';

-- ============================================================
-- 5. RLS / GRANTS -- menor privilegio
-- ============================================================
alter table public.performance_loja_fora_de_escopo enable row level security;
revoke all on public.performance_loja_fora_de_escopo from public, anon, authenticated;
grant all on public.performance_loja_fora_de_escopo to service_role;

revoke all on function public.performance_loja_fora_de_escopo_ranking(text) from public, anon;
revoke all on function public.performance_operacoes_fora_de_escopo(date, date) from public, anon;
grant execute on function public.performance_loja_fora_de_escopo_ranking(text) to authenticated, service_role;
grant execute on function public.performance_operacoes_fora_de_escopo(date, date) to service_role;

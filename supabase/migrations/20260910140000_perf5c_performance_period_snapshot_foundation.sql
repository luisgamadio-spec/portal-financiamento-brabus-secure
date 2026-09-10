-- ============================================================
-- [RANKING] PERF-5C -- FUNDACAO: PERIODO + REGRA + SNAPSHOT IMUTAVEL
-- ============================================================
--
-- Implementa a autoridade de Performance (Ranking) sob as decisoes
-- humanas H7, H8 e H9, mais os defaults tecnicos G4 e G6 provados em
-- PERF-5B.
--
--   H7  codigo de origem "2" = BARRA FUNDA
--   H8  SPF conta em maio/2026 (programa comeca 2026-05-21), NAO rateado;
--       jan-abr: categoria SPF NAO APLICAVEL (max 85)
--   H9  reabertura de mes FECHADO: somente MASTER, com motivo, snapshot
--       original preservado e nova versao superseding a anterior
--   G4  STRICT_DATE_BOUNDED -- venda mais recente ATE a data do
--       financiamento; uma venda posterior nunca reclassifica
--   G6  NOT_APPLICABLE_BEFORE_PROGRAM_START
--
-- ------------------------------------------------------------
-- DECISAO ARQUITETURAL CRITICA -- POR QUE A NORMALIZACAO E RANKING-ONLY
-- ------------------------------------------------------------
-- resolve_store_temporal() e consumida por 11 funcoes, entre elas
-- operational_analyst_commission_metrics (Salario), operational_
-- salary_details, operational_metrics, Score e Coparticipado.
-- Existe 1 operacao com store='2' DENTRO do periodo de Salario
-- 2026-05-21..2026-06-20, que esta FECHADO.
-- Portanto embutir H7 em resolve_store_temporal reescreveria comissao de
-- um periodo de Salario ja fechado -- exatamente o padrao do incidente
-- RH-ANALYST-4.
-- Por isso a normalizacao vive numa autoridade PROPRIA e ADITIVA, que o
-- motor de fechamento do Ranking consome. resolve_store_temporal fica
-- byte-identica. Adotar esta normalizacao em Salario e uma decisao
-- separada, fora do escopo desta Wave.
--
-- As tabelas de origem (portal_sales, portal_finance_operations) NAO sao
-- alteradas: zero triggers, reimportaveis, sao evidencia bruta.

-- ============================================================
-- 1. G15 -- AUTORIDADE DE NORMALIZACAO DE CODIGO DE LOJA
-- ============================================================
create table if not exists public.performance_loja_codigo_map (
  id uuid primary key default gen_random_uuid(),
  codigo_origem text not null,
  loja_canonica text not null,
  autoridade text not null,
  motivo text not null,
  vigencia_inicio date,
  vigencia_fim date,
  criado_em timestamptz not null default now(),
  constraint performance_loja_codigo_map_codigo_unico unique (codigo_origem),
  constraint performance_loja_codigo_map_autoridade_check
    check (autoridade in ('HUMAN_APPROVED', 'SOURCE_REGISTRY'))
);

comment on table public.performance_loja_codigo_map is
  'PERF-5C/G15: traducao de codigo de loja de ORIGEM para loja canonica. '
  'Autoridade propria do Ranking -- resolve_store_temporal NAO e alterada, '
  'porque e compartilhada com Salario/Score/Coparticipado e ha operacao '
  'com codigo "2" dentro de periodo de Salario FECHADO. A evidencia bruta '
  'em portal_sales/portal_finance_operations permanece intacta.';

insert into public.performance_loja_codigo_map
  (codigo_origem, loja_canonica, autoridade, motivo, vigencia_inicio, vigencia_fim)
select '2', 'BARRA FUNDA', 'HUMAN_APPROVED',
  'H7: o Humano declarou que o codigo de origem "2" designa a unidade '
  'BARRA FUNDA. Defeito de origem presente em portal_sales (189 linhas) e '
  'portal_finance_operations (186 linhas), 2026-01-06 a 2026-05-25, com 25 '
  'vendedores sem CPF e sem usuario do portal.',
  date '2026-01-06', date '2026-05-25'
where not exists (
  select 1 from public.performance_loja_codigo_map where codigo_origem = '2');

create or replace function public.performance_normalizar_loja(p_loja text)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
  select coalesce(
    (select m.loja_canonica from public.performance_loja_codigo_map m
      where m.codigo_origem = btrim(coalesce(p_loja, ''))),
    upper(btrim(coalesce(p_loja, '')))
  );
$function$;

comment on function public.performance_normalizar_loja(text) is
  'PERF-5C/G15: aplica o mapa de codigo de origem. Consumida SOMENTE pelo '
  'motor de Ranking. Nao e chamada por nenhuma funcao de Salario.';

-- ============================================================
-- 2. AUTORIDADE DE VERSAO DE REGRA
-- ============================================================
create table if not exists public.performance_regra_versao (
  id uuid primary key default gen_random_uuid(),
  versao text not null unique,
  pontos_retorno_novos_1 int not null,
  pontos_retorno_novos_2 int not null,
  pontos_retorno_seminovos_1 int not null,
  pontos_retorno_seminovos_2 int not null,
  pontos_und_financiado_1 int not null,
  pontos_und_financiado_2 int not null,
  pontos_und_spf_1 int not null,
  pontos_und_spf_2 int not null,
  regra_empate text not null,
  regra_atividade_zero text not null,
  resolver_g4 text not null,
  aplicabilidade_g6 text not null,
  spf_programa_inicio date not null,
  spf_maio_override text not null,
  spf_percentual_bruto numeric not null,
  normalizacao_loja_versao text not null,
  criado_em timestamptz not null default now(),
  constraint performance_regra_versao_g4_check
    check (resolver_g4 in ('STRICT_DATE_BOUNDED', 'LATEST_SALE_EVER')),
  constraint performance_regra_versao_g6_check
    check (aplicabilidade_g6 in ('NOT_APPLICABLE_BEFORE_PROGRAM_START', 'ZERO_BEFORE_PROGRAM_START')),
  constraint performance_regra_versao_empate_check
    check (regra_empate in ('FULL_POINTS_COMPETITION_RANKING'))
);

comment on table public.performance_regra_versao is
  'PERF-5C: contrato de pontuacao do Ranking como DADO, nao como prosa. '
  'Todo snapshot referencia uma versao. Mudanca de regra cria versao nova; '
  'nunca reescreve a semantica de um Ranking ja fechado.';

insert into public.performance_regra_versao (
  versao, pontos_retorno_novos_1, pontos_retorno_novos_2,
  pontos_retorno_seminovos_1, pontos_retorno_seminovos_2,
  pontos_und_financiado_1, pontos_und_financiado_2,
  pontos_und_spf_1, pontos_und_spf_2,
  regra_empate, regra_atividade_zero, resolver_g4, aplicabilidade_g6,
  spf_programa_inicio, spf_maio_override, spf_percentual_bruto,
  normalizacao_loja_versao)
select '2026.1', 35, 17, 35, 17, 15, 8, 15, 8,
  'FULL_POINTS_COMPETITION_RANKING', 'METRIC_LE_ZERO_UNRANKED',
  'STRICT_DATE_BOUNDED', 'NOT_APPLICABLE_BEFORE_PROGRAM_START',
  date '2026-05-21', 'APPLICABLE_NOT_PRORATED', 70, 'PERF5C_H7'
where not exists (select 1 from public.performance_regra_versao where versao = '2026.1');

-- ============================================================
-- 3. AUTORIDADE DE PERIODO (MES CALENDARIO)
-- ============================================================
create table if not exists public.performance_periodo (
  id uuid primary key default gen_random_uuid(),
  tipo text not null default 'MONTH',
  data_inicio date not null,
  data_fim date not null,
  status text not null default 'OPEN',
  regra_versao_id uuid not null references public.performance_regra_versao(id),
  current_snapshot_id uuid,
  criado_em timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references public.usuarios(id),
  constraint performance_periodo_tipo_check check (tipo in ('MONTH')),
  constraint performance_periodo_status_check check (status in ('OPEN', 'CLOSED')),
  constraint performance_periodo_unico unique (tipo, data_inicio),
  -- mes calendario estrito: comeca no dia 1 e termina no ultimo dia
  constraint performance_periodo_mes_calendario check (
    data_inicio = date_trunc('month', data_inicio)::date
    and data_fim = (date_trunc('month', data_inicio) + interval '1 month - 1 day')::date),
  constraint performance_periodo_fechado_coerente check (
    (status = 'OPEN' and closed_at is null and closed_by is null and current_snapshot_id is null)
    or (status = 'CLOSED' and closed_at is not null and current_snapshot_id is not null))
);

comment on table public.performance_periodo is
  'PERF-5C: periodos de Performance sao MESES CALENDARIO (dia 1 ao ultimo '
  'dia), NUNCA competencias de Salario (21->20). CLOSED so existe com '
  'snapshot; a constraint impede um mes "fechado" sem resultado.';

-- ============================================================
-- 4. SNAPSHOT -- CABECALHO / RESULTADOS / DETALHE
-- ============================================================
create table if not exists public.performance_snapshot (
  id uuid primary key default gen_random_uuid(),
  periodo_id uuid not null references public.performance_periodo(id),
  snapshot_versao int not null,
  regra_versao_id uuid not null references public.performance_regra_versao(id),
  responsabilidade_procedencias text[] not null,
  resolver_g4 text not null,
  spf_aplicavel boolean not null,
  max_score int not null,
  fonte_fingerprint text not null,
  operacoes_consideradas int not null,
  retorno_total numeric not null,
  operacoes_nao_atribuidas int not null,
  criado_em timestamptz not null default now(),
  criado_por uuid references public.usuarios(id),
  supersedes_snapshot_id uuid references public.performance_snapshot(id),
  superseded_at timestamptz,
  superseded_by uuid references public.usuarios(id),
  supersession_motivo text,
  constraint performance_snapshot_versao_unica unique (periodo_id, snapshot_versao),
  constraint performance_snapshot_max_check check (max_score in (85, 100))
);

alter table public.performance_periodo
  drop constraint if exists performance_periodo_current_snapshot_fkey;
alter table public.performance_periodo
  add constraint performance_periodo_current_snapshot_fkey
  foreign key (current_snapshot_id) references public.performance_snapshot(id);

create table if not exists public.performance_snapshot_resultado (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.performance_snapshot(id),
  analista_usuario_id uuid not null references public.usuarios(id),
  retorno_novos numeric not null default 0,
  retorno_seminovos numeric not null default 0,
  und_financiado int not null default 0,
  und_spf int,
  rank_retorno_novos int,
  pontos_retorno_novos int not null default 0,
  rank_retorno_seminovos int,
  pontos_retorno_seminovos int not null default 0,
  rank_und_financiado int,
  pontos_und_financiado int not null default 0,
  rank_und_spf int,
  pontos_und_spf int,
  pontos_total int not null default 0,
  max_score int not null,
  constraint performance_snapshot_resultado_unico unique (snapshot_id, analista_usuario_id)
);

comment on column public.performance_snapshot_resultado.und_spf is
  'NULL quando a categoria SPF NAO era aplicavel no periodo (jan-abr/2026). '
  'NULL significa NAO APLICAVEL -- nunca gravar 0, que significaria '
  '"disputou e nao pontuou".';

create table if not exists public.performance_snapshot_detalhe (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.performance_snapshot(id),
  analista_usuario_id uuid not null references public.usuarios(id),
  loja text not null,
  departamento text,
  operacoes int not null,
  retorno numeric not null,
  spf_unidades int not null default 0,
  responsabilidade_procedencia text not null,
  loja_normalizada_de text
);

comment on column public.performance_snapshot_detalhe.loja_normalizada_de is
  'Codigo de origem quando a loja passou pelo mapa do G15 (ex.: "2"). '
  'NULL quando a loja ja veio canonica.';

create table if not exists public.performance_auditoria (
  id bigint generated always as identity primary key,
  evento text not null,
  periodo_id uuid,
  snapshot_id uuid,
  ator_usuario_id uuid references public.usuarios(id),
  motivo text,
  metadados jsonb,
  criado_em timestamptz not null default now(),
  constraint performance_auditoria_evento_check check (evento in (
    'PERIOD_CREATED', 'PERIOD_CLOSED', 'PERIOD_REOPENED',
    'SNAPSHOT_CREATED', 'SNAPSHOT_SUPERSEDED',
    'REOPEN_DENIED', 'CLOSE_DENIED', 'MUTATION_DENIED'))
);

-- ============================================================
-- 5. IMUTABILIDADE DE SNAPSHOT (nivel banco, nao disciplina de app)
-- ============================================================
-- Um snapshot so pode ser tocado enquanto o periodo ainda nao fechou.
-- Depois de CLOSED nada mais muda -- nem cabecalho, nem resultado, nem
-- detalhe. A unica excecao e marcar supersession no cabecalho, feita
-- exclusivamente pela RPC governada de reabertura.
create or replace function public.performance_snapshot_imutavel()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_snapshot uuid;
  v_fechado boolean;
begin
  -- IF, nao CASE: em PL/pgSQL o acesso a campo de RECORD e resolvido
  -- mesmo no ramo nao tomado, e o cabecalho nao tem snapshot_id.
  if tg_table_name = 'performance_snapshot' then
    if tg_op = 'DELETE' then v_snapshot := old.id; else v_snapshot := new.id; end if;
  else
    if tg_op = 'DELETE' then v_snapshot := old.snapshot_id; else v_snapshot := new.snapshot_id; end if;
  end if;

  select p.status = 'CLOSED' into v_fechado
  from public.performance_snapshot s
  join public.performance_periodo p on p.id = s.periodo_id
  where s.id = v_snapshot;

  if coalesce(v_fechado, false) then
    -- unica mutacao permitida: supersession no cabecalho, e apenas
    -- quando a sessao esta dentro da RPC governada de reabertura.
    if tg_table_name = 'performance_snapshot' and tg_op = 'UPDATE'
       and coalesce(current_setting('performance.supersession', true), '') = 'on'
       and old.id = new.id and old.periodo_id = new.periodo_id
       and old.snapshot_versao = new.snapshot_versao then
      return new;
    end if;

    insert into public.performance_auditoria (evento, snapshot_id, motivo, metadados)
    values ('MUTATION_DENIED', v_snapshot,
      'Tentativa de ' || tg_op || ' em ' || tg_table_name || ' de snapshot fechado.',
      jsonb_build_object('tabela', tg_table_name, 'operacao', tg_op));

    raise exception 'PERF-5C: snapshot de periodo FECHADO e imutavel (% em %).', tg_op, tg_table_name
      using errcode = '23514';
  end if;

  return case tg_op when 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists trg_performance_snapshot_imutavel on public.performance_snapshot;
create trigger trg_performance_snapshot_imutavel
  before update or delete on public.performance_snapshot
  for each row execute function public.performance_snapshot_imutavel();

drop trigger if exists trg_performance_resultado_imutavel on public.performance_snapshot_resultado;
create trigger trg_performance_resultado_imutavel
  before update or delete on public.performance_snapshot_resultado
  for each row execute function public.performance_snapshot_imutavel();

drop trigger if exists trg_performance_detalhe_imutavel on public.performance_snapshot_detalhe;
create trigger trg_performance_detalhe_imutavel
  before update or delete on public.performance_snapshot_detalhe
  for each row execute function public.performance_snapshot_imutavel();

-- auditoria e append-only
create or replace function public.performance_auditoria_append_only()
returns trigger language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
begin
  raise exception 'PERF-5C: performance_auditoria e append-only.' using errcode = '23514';
end;
$function$;

drop trigger if exists trg_performance_auditoria_append_only on public.performance_auditoria;
create trigger trg_performance_auditoria_append_only
  before update or delete on public.performance_auditoria
  for each row execute function public.performance_auditoria_append_only();

-- ============================================================
-- 6. MOTOR DE CALCULO (compartilhado por dry-run e fechamento)
-- ============================================================
-- G4 STRICT_DATE_BOUNDED, G15 via performance_normalizar_loja, SPF
-- escopado ao MESMO periodo (G20), responsabilidade temporal do Ranking.
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
      public.performance_normalizar_loja(
        coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id, f.seller_id),
          f.operation_date, nullif(f.store,'')), 'SEM LOJA')) as loja_norm
    from public.portal_finance_operations f
    join lvb on lvb.id = f.batch_id and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
    where f.is_real_financing and f.operation_date between p_inicio and p_fim),
  res as (
    select fin.*,
      -- G4 STRICT_DATE_BOUNDED: venda mais recente ATE a data do financiamento
      (select sa.department from sales_all sa
        where sa.chassis = fin.chassis and sa.sale_date <= fin.d
        order by sa.sale_date desc, sa.id desc limit 1) as dept,
      (select coalesce(sum(spf.optional_value),0) from spf
        where spf.client_match_key = fin.client_match_key) as spf_val,
      (select count(*) from spf where spf.client_match_key = fin.client_match_key) as spf_qtd,
      (select r.analista_usuario_id from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = fin.loja_norm
          and fin.d >= r.valid_from and (r.valid_to is null or fin.d < r.valid_to)
        limit 1) as analista,
      (select r.procedencia from public.analista_responsavel_loja r
        where r.status = 'ACTIVE'
          and r.loja_normalizada = fin.loja_norm
          and fin.d >= r.valid_from and (r.valid_to is null or fin.d < r.valid_to)
        limit 1) as proc
    from fin)
  select res.analista, res.loja_norm,
    (select m.codigo_origem from public.performance_loja_codigo_map m
      where m.codigo_origem = res.store_bruto) as loja_origem_codigo,
    res.dept, count(*)::int, sum(res.v), sum(res.spf_val), sum(res.spf_qtd)::int,
    coalesce(res.proc, 'UNRESOLVED')
  from res
  group by res.analista, res.loja_norm, 3, res.dept, res.proc;
$function$;

comment on function public.performance_calcular_periodo(date, date) is
  'PERF-5C: motor unico de calculo do Ranking. G4 STRICT_DATE_BOUNDED, '
  'G15 pelo mapa de codigo, SPF escopado ao proprio periodo (G20), '
  'responsabilidade pela autoridade temporal do Ranking. Nao le nem '
  'escreve nada de Salario.';

-- ============================================================
-- 7. RLS / GRANTS -- menor privilegio
-- ============================================================
alter table public.performance_loja_codigo_map enable row level security;
alter table public.performance_regra_versao enable row level security;
alter table public.performance_periodo enable row level security;
alter table public.performance_snapshot enable row level security;
alter table public.performance_snapshot_resultado enable row level security;
alter table public.performance_snapshot_detalhe enable row level security;
alter table public.performance_auditoria enable row level security;

revoke all on public.performance_loja_codigo_map from public, anon, authenticated;
revoke all on public.performance_regra_versao from public, anon, authenticated;
revoke all on public.performance_periodo from public, anon, authenticated;
revoke all on public.performance_snapshot from public, anon, authenticated;
revoke all on public.performance_snapshot_resultado from public, anon, authenticated;
revoke all on public.performance_snapshot_detalhe from public, anon, authenticated;
revoke all on public.performance_auditoria from public, anon, authenticated;

grant all on public.performance_loja_codigo_map to service_role;
grant all on public.performance_regra_versao to service_role;
grant all on public.performance_periodo to service_role;
grant all on public.performance_snapshot to service_role;
grant all on public.performance_snapshot_resultado to service_role;
grant all on public.performance_snapshot_detalhe to service_role;
grant all on public.performance_auditoria to service_role;

revoke all on function public.performance_normalizar_loja(text) from public, anon;
revoke all on function public.performance_calcular_periodo(date, date) from public, anon;
grant execute on function public.performance_normalizar_loja(text) to authenticated, service_role;
grant execute on function public.performance_calcular_periodo(date, date) to service_role;

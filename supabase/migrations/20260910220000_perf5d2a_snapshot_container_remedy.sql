-- ===========================================================================
-- [RANKING] PERF-5D.2A -- reparo do CONTAINER do snapshot historico.
--
-- Esta migracao NAO altera nenhum resultado de negocio. Ela conserta apenas
-- o contrato de imutabilidade, versionamento e linhagem do snapshot, antes
-- que a historia de jan-ago/2026 se torne oficial e imutavel.
--
-- G29 (BLOQUEADOR) -- snapshot FECHADO aceitava INSERT.
--   As tres travas eram BEFORE DELETE OR UPDATE. Uma linha de detalhe
--   forjada foi aceita em ensaio. Passam a cobrir INSERT tambem.
--   Seguro para o fechamento legitimo: master_performance_fechar_periodo
--   insere cabecalho, resultados e detalhes ENQUANTO o periodo ainda esta
--   OPEN, e so depois grava status='CLOSED' (verificado na fonte viva).
--
-- G30 (MEDIO) -- a trava falhava com erro interno de PL/pgSQL
--   (record "old" has no field "periodo_id") em resultado/detalhe, porque
--   a excecao de supersession comparava old.periodo_id dentro da MESMA
--   expressao booleana da checagem de tabela. O PostgreSQL nao garante
--   curto-circuito de AND, entao o campo era resolvido em tabelas que nao
--   o possuem. Passa a ramificar por TG_TABLE_NAME em statement separado,
--   antes de tocar qualquer campo especifico da tabela.
--
-- G32 (BLOQUEADOR) -- a versao de regra nao congelava H10.
--   A versao 2026.1 e anterior a H10 e sua normalizacao dizia apenas
--   PERF5C_H7. O conjunto fora de escopo vivia so em uma tabela mutavel,
--   sem vinculo com o snapshot. Agora o conjunto e congelado COMO DADO na
--   versao de regra e copiado para o proprio snapshot no fechamento, de
--   modo que a leitura historica nao dependa da configuracao corrente.
--   A 2026.1 NAO e alterada: ganha apenas o conjunto vazio, que e o que
--   ela sempre significou -- ela antecede H10.
--
-- G31 (BAIXO) -- supersedes_snapshot_id existia e nunca era preenchido.
--   O refechamento ja preservava a versao anterior, mas a linhagem ficava
--   implicita no numero de versao. Passa a ser explicita: v3 -> v2 -> v1,
--   pelo maior snapshot_versao anterior do periodo (determinismo por
--   versao, nunca por timestamp).
--
-- G33 NAO faz parte desta onda. Nenhum criterio de desempate de
-- classificacao final por pontos totais e inventado aqui.
--
-- NAO fecha periodo. NAO cria snapshot oficial. NAO toca Salario, IA,
-- Portal V2, dados brutos nem responsabilidade.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. G32 -- o conjunto fora de escopo passa a ser DADO VERSIONADO
-- ---------------------------------------------------------------------------

-- Na versao de regra: define o que aquela versao considera fora de escopo.
alter table public.performance_regra_versao
  add column if not exists lojas_fora_de_escopo text[] not null default '{}'::text[];

comment on column public.performance_regra_versao.lojas_fora_de_escopo is
  'PERF-5D.2A/G32: conjunto canonico de lojas fora do universo do Ranking '
  'nesta versao de regra. Congelado como dado. A 2026.1 mantem o conjunto '
  'vazio porque antecede H10.';

-- No proprio snapshot: congela o conjunto efetivamente usado naquele
-- fechamento. Como as linhas de snapshot sao imutaveis, esta e a copia
-- durável -- a leitura historica nao precisa da tabela mutavel.
alter table public.performance_snapshot
  add column if not exists lojas_fora_de_escopo text[] not null default '{}'::text[];

comment on column public.performance_snapshot.lojas_fora_de_escopo is
  'PERF-5D.2A/G32: conjunto de lojas fora de escopo vigente no momento '
  'deste fechamento, copiado da versao de regra. Torna o snapshot '
  'auto-descritivo quanto a H10.';

-- Nova versao de regra, aditiva. Copia TODOS os valores de pontuacao da
-- 2026.1 a partir da propria linha, garantindo equivalencia semantica, e
-- muda somente o descritor de normalizacao e o conjunto fora de escopo.
insert into public.performance_regra_versao (
  versao,
  pontos_retorno_novos_1, pontos_retorno_novos_2,
  pontos_retorno_seminovos_1, pontos_retorno_seminovos_2,
  pontos_und_financiado_1, pontos_und_financiado_2,
  pontos_und_spf_1, pontos_und_spf_2,
  regra_empate, regra_atividade_zero, resolver_g4, aplicabilidade_g6,
  spf_programa_inicio, spf_maio_override, spf_percentual_bruto,
  normalizacao_loja_versao, lojas_fora_de_escopo)
select
  '2026.2',
  r.pontos_retorno_novos_1, r.pontos_retorno_novos_2,
  r.pontos_retorno_seminovos_1, r.pontos_retorno_seminovos_2,
  r.pontos_und_financiado_1, r.pontos_und_financiado_2,
  r.pontos_und_spf_1, r.pontos_und_spf_2,
  r.regra_empate, r.regra_atividade_zero, r.resolver_g4, r.aplicabilidade_g6,
  r.spf_programa_inicio, r.spf_maio_override, r.spf_percentual_bruto,
  'PERF5D2A_H7_H10',
  (select coalesce(array_agg(upper(btrim(e.loja_canonica)) order by e.loja_canonica),
                   array[]::text[])
     from public.performance_loja_fora_de_escopo e)
from public.performance_regra_versao r
where r.versao = '2026.1'
on conflict (versao) do nothing;

-- Resolve o conjunto fora de escopo de uma versao de regra. Sem versao,
-- cai na autoridade corrente -- caminho usado por diagnostico ad-hoc.
create or replace function public.performance_lojas_fora_de_escopo_versao(
  p_regra_versao_id uuid default null)
returns text[]
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select case
    when p_regra_versao_id is null then
      (select coalesce(array_agg(upper(btrim(e.loja_canonica)) order by e.loja_canonica),
                       array[]::text[])
         from public.performance_loja_fora_de_escopo e)
    else
      coalesce(
        (select array_agg(upper(btrim(x)) order by upper(btrim(x)))
           from public.performance_regra_versao rv,
                lateral unnest(rv.lojas_fora_de_escopo) x
          where rv.id = p_regra_versao_id),
        array[]::text[])
  end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. G32 -- o motor passa a aceitar a versao de regra que o governa
-- ---------------------------------------------------------------------------
-- A assinatura de 2 argumentos e removida antes de recriar com 3 para nao
-- deixar sobrecarga ambigua. O terceiro argumento tem default, entao todo
-- chamador de 2 argumentos continua valido e com o comportamento atual.
drop function if exists public.performance_calcular_periodo(date, date);

create or replace function public.performance_calcular_periodo(
  p_inicio date, p_fim date, p_regra_versao_id uuid default null)
returns table(analista_usuario_id uuid, loja text, loja_origem_codigo text,
  departamento text, operacoes integer, retorno numeric, spf_valor numeric,
  spf_unidades integer, responsabilidade_procedencia text)
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
  fora as (
    -- G32: conjunto fora de escopo CONGELADO pela versao de regra quando ela
    -- e informada. Sem versao, autoridade corrente (diagnostico ad-hoc).
    select public.performance_lojas_fora_de_escopo_versao(p_regra_versao_id) as lojas),
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
    select fin_res.* from fin_res, fora
    where upper(btrim(fin_res.loja_norm)) <> all (fora.lojas)),
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

-- ---------------------------------------------------------------------------
-- 3. G29 + G30 -- trava de imutabilidade
-- ---------------------------------------------------------------------------
create or replace function public.performance_snapshot_imutavel()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_rec record;
  v_snapshot uuid;
  v_fechado boolean;
begin
  -- G30: ramifica PRIMEIRO por operacao, depois por tabela, em statements
  -- separados. Nenhum campo especifico de tabela e citado antes de a
  -- tabela estar estabelecida, e nada depende de curto-circuito de AND.
  if tg_op = 'DELETE' then v_rec := old; else v_rec := new; end if;

  if tg_table_name = 'performance_snapshot' then
    v_snapshot := v_rec.id;
    -- o cabecalho resolve o periodo direto: em INSERT a propria linha
    -- ainda nao existe para ser consultada.
    select p.status = 'CLOSED' into v_fechado
    from public.performance_periodo p
    where p.id = v_rec.periodo_id;
  else
    v_snapshot := v_rec.snapshot_id;
    select p.status = 'CLOSED' into v_fechado
    from public.performance_snapshot s
    join public.performance_periodo p on p.id = s.periodo_id
    where s.id = v_snapshot;
  end if;

  if coalesce(v_fechado, false) then
    -- unica mutacao permitida: supersession no cabecalho, e apenas quando
    -- a sessao esta dentro da RPC governada de reabertura. A checagem e
    -- ANINHADA de proposito (G30): os campos de performance_snapshot so
    -- podem ser tocados depois que a tabela ja esta estabelecida.
    if tg_table_name = 'performance_snapshot' and tg_op = 'UPDATE' then
      if coalesce(current_setting('performance.supersession', true), '') = 'on'
         and old.id = new.id
         and old.periodo_id = new.periodo_id
         and old.snapshot_versao = new.snapshot_versao then
        return new;
      end if;
    end if;

    -- Contrato de auditoria preservado como estava. Registre-se, porem, o
    -- que foi medido: esta linha NUNCA sobrevive. O raise abaixo desfaz a
    -- subtransacao que a contem, e o mesmo vale para CLOSE_DENIED e
    -- REOPEN_DENIED desde a PERF-5C -- nenhum evento *_DENIED jamais
    -- persistiu no banco. Uma recusa e sua propria auditoria em tabela nao
    -- coexistem na mesma transacao sem transacao autonoma.
    insert into public.performance_auditoria (evento, snapshot_id, motivo, metadados)
    values ('MUTATION_DENIED', v_snapshot,
      'Tentativa de ' || tg_op || ' em ' || tg_table_name || ' de snapshot fechado.',
      jsonb_build_object('tabela', tg_table_name, 'operacao', tg_op));

    -- Registro DURAVEL da recusa: o log do servidor nao e desfeito pelo
    -- rollback. E o unico rastro que sobrevive sem transacao autonoma.
    raise warning 'PERF-5D.2A MUTATION_DENIED: % em % (snapshot %).',
      tg_op, tg_table_name, v_snapshot;

    raise exception 'PERF-5C: snapshot de periodo FECHADO e imutavel (% em %).', tg_op, tg_table_name
      using errcode = '23514';
  end if;

  -- G30: IF explicito. Um CASE unico citaria old em INSERT.
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$function$;

-- G29: as tres travas passam a cobrir INSERT. O fechamento legitimo grava
-- cabecalho, resultados e detalhes com o periodo ainda OPEN, entao nao e
-- afetado.
drop trigger if exists trg_performance_snapshot_imutavel on public.performance_snapshot;
create trigger trg_performance_snapshot_imutavel
  before insert or update or delete on public.performance_snapshot
  for each row execute function public.performance_snapshot_imutavel();

drop trigger if exists trg_performance_resultado_imutavel on public.performance_snapshot_resultado;
create trigger trg_performance_resultado_imutavel
  before insert or update or delete on public.performance_snapshot_resultado
  for each row execute function public.performance_snapshot_imutavel();

drop trigger if exists trg_performance_detalhe_imutavel on public.performance_snapshot_detalhe;
create trigger trg_performance_detalhe_imutavel
  before insert or update or delete on public.performance_snapshot_detalhe
  for each row execute function public.performance_snapshot_imutavel();

-- ---------------------------------------------------------------------------
-- 4. G31 + G32 -- fechamento com linhagem explicita e regra congelada
-- ---------------------------------------------------------------------------
create or replace function public.master_performance_fechar_periodo(
  p_periodo_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ator public.usuarios;
  v_p public.performance_periodo;
  v_r public.performance_regra_versao;
  v_spf_ok boolean;
  v_max int;
  v_versao int;
  v_anterior uuid;
  v_snap uuid;
  v_ops int; v_ret numeric; v_nao int;
  v_procs text[];
  v_fora text[];
begin
  select u.* into v_ator from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil,''))) = 'MASTER' limit 1;
  if v_ator.id is null then
    insert into public.performance_auditoria (evento, periodo_id, motivo)
    values ('CLOSE_DENIED', p_periodo_id, 'Chamador nao e MASTER.');
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  -- trava a linha do periodo: dois fechamentos concorrentes serializam
  select * into v_p from public.performance_periodo where id = p_periodo_id for update;
  if v_p.id is null then
    raise exception 'Periodo de Performance inexistente.' using errcode = '22023';
  end if;

  -- idempotencia explicita: fechar de novo sem reabrir e recusado
  if v_p.status = 'CLOSED' then
    insert into public.performance_auditoria (evento, periodo_id, ator_usuario_id, motivo)
    values ('CLOSE_DENIED', v_p.id, v_ator.id, 'Periodo ja esta FECHADO; reabra antes de refechar.');
    raise exception 'Periodo ja esta FECHADO. Reabra antes de fechar novamente.' using errcode = '22023';
  end if;

  select * into v_r from public.performance_regra_versao where id = v_p.regra_versao_id;

  -- G6/H8: aplicabilidade da categoria SPF pela data de inicio do programa
  v_spf_ok := v_p.data_fim >= v_r.spf_programa_inicio;
  v_max := case when v_spf_ok then 100 else 85 end;

  -- G31: linhagem explicita. A versao anterior e a de MAIOR snapshot_versao
  -- deste periodo -- determinismo por versao, nunca por timestamp.
  select s.snapshot_versao, s.id into v_versao, v_anterior
  from public.performance_snapshot s
  where s.periodo_id = v_p.id
  order by s.snapshot_versao desc limit 1;
  v_versao := coalesce(v_versao, 0) + 1;

  -- G32: conjunto fora de escopo congelado por esta versao de regra
  v_fora := public.performance_lojas_fora_de_escopo_versao(v_r.id);

  -- reentrante: dois fechamentos na mesma transacao/sessao nao colidem
  drop table if exists _calc;
  drop table if exists _m;
  create temp table _calc on commit drop as
  select * from public.performance_calcular_periodo(v_p.data_inicio, v_p.data_fim, v_r.id);

  select count(*)::int, coalesce(sum(retorno),0),
         coalesce(sum(operacoes) filter (where analista_usuario_id is null),0)::int
    into v_ops, v_ret, v_nao from _calc;
  select coalesce(sum(operacoes),0)::int into v_ops from _calc;

  select coalesce(array_agg(distinct responsabilidade_procedencia), array[]::text[])
    into v_procs from _calc where analista_usuario_id is not null;

  insert into public.performance_snapshot (
    periodo_id, snapshot_versao, regra_versao_id, responsabilidade_procedencias,
    resolver_g4, spf_aplicavel, max_score, fonte_fingerprint,
    operacoes_consideradas, retorno_total, operacoes_nao_atribuidas, criado_por,
    supersedes_snapshot_id, lojas_fora_de_escopo)
  values (v_p.id, v_versao, v_r.id, v_procs, v_r.resolver_g4, v_spf_ok, v_max,
    md5(v_p.data_inicio::text || '|' || v_p.data_fim::text || '|' || v_r.versao || '|'
        || v_ops::text || '|' || v_ret::text),
    v_ops, v_ret, v_nao, v_ator.id,
    v_anterior, v_fora)
  returning id into v_snap;

  -- metricas por analista
  create temp table _m on commit drop as
  select analista_usuario_id an,
    coalesce(sum(retorno) filter (where departamento = 'NOVOS'), 0)
      + coalesce(sum(spf_valor) filter (where departamento = 'NOVOS'), 0) * v_r.spf_percentual_bruto / 100 as novos,
    coalesce(sum(retorno) filter (where departamento = 'SEMINOVOS'), 0)
      + coalesce(sum(spf_valor) filter (where departamento = 'SEMINOVOS'), 0) * v_r.spf_percentual_bruto / 100 as semi,
    coalesce(sum(operacoes), 0)::int as und_fin,
    coalesce(sum(spf_unidades), 0)::int as und_spf
  from _calc where analista_usuario_id is not null group by 1;

  insert into public.performance_snapshot_resultado (
    snapshot_id, analista_usuario_id, retorno_novos, retorno_seminovos,
    und_financiado, und_spf,
    rank_retorno_novos, pontos_retorno_novos,
    rank_retorno_seminovos, pontos_retorno_seminovos,
    rank_und_financiado, pontos_und_financiado,
    rank_und_spf, pontos_und_spf, pontos_total, max_score)
  select v_snap, m.an, m.novos, m.semi, m.und_fin,
    case when v_spf_ok then m.und_spf else null end,
    rn.r, coalesce(case rn.r when 1 then v_r.pontos_retorno_novos_1
                             when 2 then v_r.pontos_retorno_novos_2 else 0 end, 0),
    rs.r, coalesce(case rs.r when 1 then v_r.pontos_retorno_seminovos_1
                             when 2 then v_r.pontos_retorno_seminovos_2 else 0 end, 0),
    rf.r, coalesce(case rf.r when 1 then v_r.pontos_und_financiado_1
                             when 2 then v_r.pontos_und_financiado_2 else 0 end, 0),
    case when v_spf_ok then rp.r else null end,
    case when v_spf_ok then coalesce(case rp.r when 1 then v_r.pontos_und_spf_1
                                               when 2 then v_r.pontos_und_spf_2 else 0 end, 0)
         else null end,
    coalesce(case rn.r when 1 then v_r.pontos_retorno_novos_1
                       when 2 then v_r.pontos_retorno_novos_2 else 0 end, 0)
    + coalesce(case rs.r when 1 then v_r.pontos_retorno_seminovos_1
                         when 2 then v_r.pontos_retorno_seminovos_2 else 0 end, 0)
    + coalesce(case rf.r when 1 then v_r.pontos_und_financiado_1
                         when 2 then v_r.pontos_und_financiado_2 else 0 end, 0)
    + case when v_spf_ok then coalesce(case rp.r when 1 then v_r.pontos_und_spf_1
                                                 when 2 then v_r.pontos_und_spf_2 else 0 end, 0)
           else 0 end,
    v_max
  from _m m
  left join (select an, rank() over (order by novos desc) r from _m where novos > 0) rn on rn.an = m.an
  left join (select an, rank() over (order by semi desc) r from _m where semi > 0) rs on rs.an = m.an
  left join (select an, rank() over (order by und_fin desc) r from _m where und_fin > 0) rf on rf.an = m.an
  left join (select an, rank() over (order by und_spf desc) r from _m where und_spf > 0) rp on rp.an = m.an;

  insert into public.performance_snapshot_detalhe (
    snapshot_id, analista_usuario_id, loja, departamento, operacoes, retorno,
    spf_unidades, responsabilidade_procedencia, loja_normalizada_de)
  select v_snap, c.analista_usuario_id, c.loja, c.departamento, c.operacoes,
    c.retorno, c.spf_unidades, c.responsabilidade_procedencia, c.loja_origem_codigo
  from _calc c where c.analista_usuario_id is not null;

  update public.performance_periodo
     set status = 'CLOSED', closed_at = now(), closed_by = v_ator.id,
         current_snapshot_id = v_snap
   where id = v_p.id;

  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo, metadados)
  values ('SNAPSHOT_CREATED', v_p.id, v_snap, v_ator.id, coalesce(p_motivo, 'Fechamento de periodo.'),
    jsonb_build_object('versao', v_versao, 'spf_aplicavel', v_spf_ok, 'max_score', v_max,
      'supersedes', v_anterior, 'regra_versao', v_r.versao, 'lojas_fora_de_escopo', v_fora));
  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo)
  values ('PERIOD_CLOSED', v_p.id, v_snap, v_ator.id, coalesce(p_motivo, 'Fechamento de periodo.'));

  return jsonb_build_object('ok', true, 'periodo_id', v_p.id, 'snapshot_id', v_snap,
    'versao', v_versao, 'supersedes', v_anterior,
    'regra_versao', v_r.versao, 'lojas_fora_de_escopo', v_fora,
    'spf_aplicavel', v_spf_ok, 'max_score', v_max,
    'operacoes', v_ops, 'nao_atribuidas', v_nao);
end;
$function$;

#!/usr/bin/env node
/*
 * [RANKING] PERF-5C -- Fundacao de periodo + snapshot imutavel.
 *
 * Prova, contra o banco REAL:
 *   - autoridade de versao de regra (G4/G6/H8 como DADO, nao prosa);
 *   - normalizacao de codigo de loja H7 ("2" = BARRA FUNDA) sem tocar a
 *     funcao compartilhada resolve_store_temporal;
 *   - periodo = mes calendario, unico, OPEN/CLOSED coerente;
 *   - fechamento atomico, MASTER-only, idempotente;
 *   - snapshot imutavel no BANCO (nao por disciplina de aplicacao);
 *   - reabertura H9: MASTER, motivo obrigatorio, snapshot preservado,
 *     nova versao supersede a anterior, um unico snapshot corrente;
 *   - isolamento SPF entre meses (G20);
 *   - Salario intacto.
 *
 * As partes que escrevem rodam SEMPRE dentro de BEGIN...ROLLBACK: nenhum
 * periodo ou snapshot oficial e criado. ZERO PII.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}
function runSql(token, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

/* Bloco que roda um cenario de escrita dentro de rollback e devolve as
   assercoes que o proprio SQL avaliou. */
const IMPERSONA_MASTER = `do $imp$ begin
  perform set_config('request.jwt.claims', json_build_object('sub',
    (select auth_user_id from public.usuarios where ativo
      and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null
      order by criado_em limit 1))::text, true);
end $imp$;`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _erro: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-5C -- FUNDACAO DE PERIODO E SNAPSHOT IMUTAVEL DO RANKING');

  /* ---------- 1. Salario e autoridade compartilhada ---------- */
  h('1. TRAVA DE DOMINIO');
  const md5 = await one(`select
      (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') salario,
      (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.proname='resolve_store_temporal') resolve_store;`);
  ok('1.1 funcao de comissao de Salario inalterada', md5.salario === SALARY_MD5, md5.salario);
  ok('1.2 resolve_store_temporal (compartilhada com Salario) inalterada',
    md5.resolve_store === RESOLVE_STORE_MD5, md5.resolve_store);
  const usa = await one(`select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'
      and p.proname in ('operational_analyst_commission_metrics','operational_salary_details','operational_metrics')
      and pg_get_functiondef(p.oid) like '%performance_normalizar_loja%';`);
  ok('1.3 nenhuma funcao de Salario consome a normalizacao do Ranking', Number(usa.n) === 0);

  /* ---------- 2. Versao de regra ---------- */
  h('2. AUTORIDADE DE VERSAO DE REGRA');
  const r = await one(`select * from public.performance_regra_versao order by criado_em desc limit 1;`);
  ok('2.1 versao de regra existe', !!r.versao, r.versao);
  ok('2.2 Retorno Novos 35/17', Number(r.pontos_retorno_novos_1) === 35 && Number(r.pontos_retorno_novos_2) === 17);
  ok('2.3 Retorno Seminovos 35/17', Number(r.pontos_retorno_seminovos_1) === 35 && Number(r.pontos_retorno_seminovos_2) === 17);
  ok('2.4 UND Financiado 15/8', Number(r.pontos_und_financiado_1) === 15 && Number(r.pontos_und_financiado_2) === 8);
  ok('2.5 UND SPF 15/8', Number(r.pontos_und_spf_1) === 15 && Number(r.pontos_und_spf_2) === 8);
  ok('2.6 empate FULL_POINTS_COMPETITION_RANKING', r.regra_empate === 'FULL_POINTS_COMPETITION_RANKING');
  ok('2.7 metrica <= 0 nao pontua', r.regra_atividade_zero === 'METRIC_LE_ZERO_UNRANKED');
  ok('2.8 G4 = STRICT_DATE_BOUNDED', r.resolver_g4 === 'STRICT_DATE_BOUNDED');
  ok('2.9 G6 = NOT_APPLICABLE_BEFORE_PROGRAM_START', r.aplicabilidade_g6 === 'NOT_APPLICABLE_BEFORE_PROGRAM_START');
  ok('2.10 inicio do programa SPF = 2026-05-21', r.spf_programa_inicio === '2026-05-21');
  ok('2.11 H8: maio aplicavel e NAO rateado', r.spf_maio_override === 'APPLICABLE_NOT_PRORATED');
  ok('2.12 percentual bruto SPF = 70', Number(r.spf_percentual_bruto) === 70);

  /* ---------- 3. H7 -- normalizacao de loja ---------- */
  h('3. H7 -- NORMALIZACAO DE CODIGO DE LOJA');
  const g15 = await one(`select
      public.performance_normalizar_loja('2') dois,
      public.performance_normalizar_loja(' barra funda ') ja_canonica,
      public.performance_normalizar_loja('ABC') abc,
      (select autoridade from public.performance_loja_codigo_map where codigo_origem='2') autoridade,
      (select count(*) from public.portal_sales where trim(coalesce(store,''))='2') vendas_brutas,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2') fin_brutas;`);
  ok('3.1 "2" resolve para BARRA FUNDA', g15.dois === 'BARRA FUNDA', g15.dois);
  ok('3.2 loja ja canonica passa intacta (normalizada)', g15.ja_canonica === 'BARRA FUNDA');
  ok('3.3 loja sem mapa passa intacta', g15.abc === 'ABC');
  ok('3.4 autoridade registrada como HUMAN_APPROVED', g15.autoridade === 'HUMAN_APPROVED');
  ok('3.5 evidencia BRUTA preservada em portal_sales', Number(g15.vendas_brutas) === 189, g15.vendas_brutas + ' linhas');
  ok('3.6 evidencia BRUTA preservada em portal_finance_operations', Number(g15.fin_brutas) === 186, g15.fin_brutas + ' linhas');
  const users = await one(`select count(*) n from public.usuarios where criado_em::date > date '2026-09-09';`);
  ok('3.7 NENHUM usuario do portal foi criado por esta Wave', Number(users.n) === 0, users.n + ' novo(s)');

  /* ---------- 4. Periodo ---------- */
  h('4. AUTORIDADE DE PERIODO -- MES CALENDARIO');
  const cons = await all(`select conname, pg_get_constraintdef(oid) def from pg_constraint
    where conrelid='public.performance_periodo'::regclass order by conname;`);
  const defs = cons.map(c => c.conname + ' ' + c.def).join(' | ');
  ok('4.1 unicidade de mes no banco', /performance_periodo_unico.*UNIQUE \(tipo, data_inicio\)/.test(defs));
  ok('4.2 mes calendario forcado por CHECK', /mes_calendario/.test(defs));
  ok('4.3 CLOSED exige snapshot (coerencia)', /fechado_coerente/.test(defs));
  const nenhum = await one(`select count(*) n from public.performance_periodo;`);
  ok('4.4 NENHUM periodo oficial foi criado', Number(nenhum.n) === 0, nenhum.n + ' periodo(s)');

  const mesInvalido = await runSql(token, `begin;
    insert into public.performance_periodo (tipo, data_inicio, data_fim, regra_versao_id)
    values ('MONTH', date '2026-03-15', date '2026-04-14',
      (select id from public.performance_regra_versao limit 1));
    rollback;`);
  ok('4.5 periodo que nao e mes calendario e RECUSADO',
    !Array.isArray(mesInvalido) && /mes_calendario/.test(JSON.stringify(mesInvalido)));

  /* ---------- 5. Fechamento: autorizacao, atomicidade, idempotencia ---------- */
  h('5. FECHAMENTO GOVERNADO');
  const naoMaster = await runSql(token, `begin;
    do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub',
      (select auth_user_id from public.usuarios where ativo
        and upper(trim(coalesce(perfil,'')))='ANALISTA' and auth_user_id is not null limit 1))::text, true); end $x$;
    select public.master_performance_criar_periodo(date '2026-03-01');
    rollback;`);
  ok('5.1 ANALISTA nao pode criar periodo',
    !Array.isArray(naoMaster) && /Master/i.test(JSON.stringify(naoMaster)));

  const ciclo = await runSql(token, `begin;
    ${IMPERSONA_MASTER}
    create temp table _t(k text, v text) on commit drop;
    do $c$
    declare r jsonb; p uuid; s uuid; n int;
    begin
      r := public.master_performance_criar_periodo(date '2026-03-01');
      p := (r->>'periodo_id')::uuid;
      insert into _t values ('criou', (r->>'ok'));
      r := public.master_performance_criar_periodo(date '2026-03-01');
      insert into _t values ('criar_2x_ja_existia', (r->>'ja_existia'));

      r := public.master_performance_fechar_periodo(p, 'teste');
      s := (r->>'snapshot_id')::uuid;
      insert into _t values ('fechou', (r->>'ok'));
      insert into _t values ('versao', (r->>'versao'));
      insert into _t values ('spf_aplicavel_marco', (r->>'spf_aplicavel'));
      insert into _t values ('max_marco', (r->>'max_score'));
      insert into _t values ('status', (select status from public.performance_periodo where id=p));
      insert into _t values ('current_snap_igual', ((select current_snapshot_id from public.performance_periodo where id=p) = s)::text);
      select count(*) into n from public.performance_snapshot_resultado where snapshot_id=s;
      insert into _t values ('resultados', n::text);
      select count(*) into n from public.performance_snapshot_detalhe where snapshot_id=s;
      insert into _t values ('detalhes', n::text);
      insert into _t values ('und_spf_null_marco',
        (select count(*) from public.performance_snapshot_resultado where snapshot_id=s and und_spf is null)::text);
      insert into _t values ('resultados_total',
        (select count(*) from public.performance_snapshot_resultado where snapshot_id=s)::text);

      -- idempotencia: fechar de novo sem reabrir
      begin
        r := public.master_performance_fechar_periodo(p, 'segunda vez');
        insert into _t values ('refechar', 'PERMITIU');
      exception when others then
        insert into _t values ('refechar', 'NEGADO');
      end;

      -- imutabilidade
      begin
        update public.performance_snapshot set max_score = 99 where id = s;
        insert into _t values ('update_header', 'PERMITIU');
      exception when others then insert into _t values ('update_header', 'NEGADO'); end;
      begin
        delete from public.performance_snapshot where id = s;
        insert into _t values ('delete_header', 'PERMITIU');
      exception when others then insert into _t values ('delete_header', 'NEGADO'); end;
      begin
        update public.performance_snapshot_resultado set pontos_total = 999 where snapshot_id = s;
        insert into _t values ('update_result', 'PERMITIU');
      exception when others then insert into _t values ('update_result', 'NEGADO'); end;
      begin
        delete from public.performance_snapshot_resultado where snapshot_id = s;
        insert into _t values ('delete_result', 'PERMITIU');
      exception when others then insert into _t values ('delete_result', 'NEGADO'); end;
      begin
        update public.performance_snapshot_detalhe set operacoes = 0 where snapshot_id = s;
        insert into _t values ('update_detail', 'PERMITIU');
      exception when others then insert into _t values ('update_detail', 'NEGADO'); end;
      begin
        delete from public.performance_snapshot_detalhe where snapshot_id = s;
        insert into _t values ('delete_detail', 'PERMITIU');
      exception when others then insert into _t values ('delete_detail', 'NEGADO'); end;

      -- reabertura sem motivo
      begin
        r := public.master_performance_reabrir_periodo(p, '   ');
        insert into _t values ('reabrir_sem_motivo', 'PERMITIU');
      exception when others then insert into _t values ('reabrir_sem_motivo', 'NEGADO'); end;

      -- reabertura valida
      r := public.master_performance_reabrir_periodo(p, 'Reimportacao de base corrigiu vendas.');
      insert into _t values ('reabriu', (r->>'ok'));
      insert into _t values ('status_pos_reabertura', (select status from public.performance_periodo where id=p));
      insert into _t values ('snapshot_v1_ainda_existe', (select count(*) from public.performance_snapshot where id=s)::text);
      insert into _t values ('v1_superseded', (select (superseded_at is not null)::text from public.performance_snapshot where id=s));
      insert into _t values ('v1_resultados_intactos', (select count(*) from public.performance_snapshot_resultado where snapshot_id=s)::text);

      -- refechar cria v2
      r := public.master_performance_fechar_periodo(p, 'refechamento apos correcao');
      insert into _t values ('nova_versao', (r->>'versao'));
      insert into _t values ('snapshots_do_periodo', (select count(*) from public.performance_snapshot where periodo_id=p)::text);
      insert into _t values ('correntes', (select count(*) from public.performance_periodo where id=p and current_snapshot_id is not null)::text);
      insert into _t values ('corrente_e_v2', ((select current_snapshot_id from public.performance_periodo where id=p) <> s)::text);
    end $c$;
    select * from _t;
    rollback;`);

  const T = {};
  if (Array.isArray(ciclo)) ciclo.forEach(x => T[x.k] = x.v);
  else console.log('  (erro no ciclo: ' + JSON.stringify(ciclo).slice(0, 300) + ')');

  ok('5.2 MASTER cria periodo', T.criou === 'true');
  ok('5.3 criar duas vezes nao duplica', T.criar_2x_ja_existia === 'true');
  ok('5.4 MASTER fecha periodo', T.fechou === 'true');
  ok('5.5 primeira versao de snapshot = 1', T.versao === '1');
  ok('5.6 periodo fica CLOSED', T.status === 'CLOSED');
  ok('5.7 current_snapshot_id aponta para o snapshot criado', T.current_snap_igual === 'true');
  ok('5.8 resultados materializados', Number(T.resultados) > 0, T.resultados + ' analista(s)');
  ok('5.9 detalhe de atribuicao materializado', Number(T.detalhes) > 0, T.detalhes + ' linha(s)');
  ok('5.10 refechar sem reabrir e NEGADO (idempotencia explicita)', T.refechar === 'NEGADO');

  /* ---------- 6. G6 no snapshot ---------- */
  h('6. G6 -- APLICABILIDADE NO SNAPSHOT');
  ok('6.1 marco/2026: SPF NAO aplicavel', T.spf_aplicavel_marco === 'false');
  ok('6.2 marco/2026: max_score = 85', T.max_marco === '85');
  ok('6.3 marco/2026: und_spf gravado como NULL (nao aplicavel), nunca 0',
    T.und_spf_null_marco === T.resultados_total, T.und_spf_null_marco + '/' + T.resultados_total);

  /* ---------- 7. Imutabilidade ---------- */
  h('7. IMUTABILIDADE DE SNAPSHOT FECHADO (nivel banco)');
  ['update_header', 'delete_header', 'update_result', 'delete_result', 'update_detail', 'delete_detail']
    .forEach(k => ok('7.x ' + k + ' e NEGADO', T[k] === 'NEGADO', T[k]));

  /* ---------- 8. Reabertura H9 ---------- */
  h('8. H9 -- REABERTURA GOVERNADA E SUPERSESSAO');
  ok('8.1 reabertura sem motivo e NEGADA', T.reabrir_sem_motivo === 'NEGADO');
  ok('8.2 MASTER com motivo reabre', T.reabriu === 'true');
  ok('8.3 periodo volta a OPEN', T.status_pos_reabertura === 'OPEN');
  ok('8.4 snapshot v1 NAO foi apagado', T.snapshot_v1_ainda_existe === '1');
  ok('8.5 snapshot v1 marcado como superseded', T.v1_superseded === 'true');
  ok('8.6 resultados de v1 preservados', Number(T.v1_resultados_intactos) > 0, T.v1_resultados_intactos + ' linha(s)');
  ok('8.7 refechamento cria versao 2', T.nova_versao === '2');
  ok('8.8 as duas versoes coexistem', T.snapshots_do_periodo === '2');
  ok('8.9 exatamente um snapshot corrente', T.correntes === '1');
  ok('8.10 o corrente e a versao nova', T.corrente_e_v2 === 'true');

  /* ---------- 9. G20 -- isolamento SPF entre meses ---------- */
  h('9. G20 -- SPF ESCOPADO AO PROPRIO PERIODO');
  const g20 = await one(`select
      (select coalesce(sum(spf_unidades),0) from public.performance_calcular_periodo(date '2026-02-01', date '2026-02-28')) fev,
      (select coalesce(sum(spf_unidades),0) from public.performance_calcular_periodo(date '2026-06-01', date '2026-06-30')) jun;`);
  ok('9.1 fevereiro NAO recebe SPF de meses posteriores', Number(g20.fev) === 0, 'fev=' + g20.fev);
  ok('9.2 junho contabiliza o proprio SPF', Number(g20.jun) > 0, 'jun=' + g20.jun);

  /* ---------- 10. G4 estrito ---------- */
  h('10. G4 -- RESOLVEDOR ESTRITO NO MOTOR');
  const g4 = await one(`select
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='performance_calcular_periodo'
          and pg_get_functiondef(p.oid) like '%sa.sale_date <= fin.d%') estrito,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='performance_calcular_periodo'
          and pg_get_functiondef(p.oid) like '%performance_normalizar_loja%') usa_norm;`);
  ok('10.1 motor usa venda ATE a data do financiamento', Number(g4.estrito) === 1);
  ok('10.2 motor consome a normalizacao de loja', Number(g4.usa_norm) === 1);

  /* ---------- 11. Sem CPF / identidade UUID ---------- */
  h('11. IDENTIDADE POR UUID, SEM CPF');
  const cpf = await one(`select count(*) n from information_schema.columns
    where table_schema='public' and table_name like 'performance_%'
      and (column_name ilike '%cpf%' or column_name ilike '%documento%');`);
  ok('11.1 nenhuma coluna de CPF/documento na fundacao', Number(cpf.n) === 0);
  const uuid = await one(`select data_type t from information_schema.columns
    where table_schema='public' and table_name='performance_snapshot_resultado'
      and column_name='analista_usuario_id';`);
  ok('11.2 analista identificado por UUID', uuid.t === 'uuid');

  /* ---------- 12. Grants ---------- */
  h('12. MENOR PRIVILEGIO');
  const gr = await one(`select count(*) n from information_schema.role_table_grants
    where table_schema='public' and table_name like 'performance_%'
      and grantee in ('anon','authenticated','PUBLIC');`);
  ok('12.1 anon/authenticated/PUBLIC sem grant direto de tabela', Number(gr.n) === 0, gr.n + ' grant(s)');
  const rls = await one(`select count(*) n from pg_class where relname like 'performance_%' and relrowsecurity;`);
  ok('12.2 RLS habilitada nas 7 tabelas', Number(rls.n) === 7, rls.n + ' tabela(s)');

  /* ---------- 13. Nada oficial foi criado ---------- */
  h('13. NENHUM FECHAMENTO OFICIAL');
  const fim = await one(`select
      (select count(*) from public.performance_periodo) periodos,
      (select count(*) from public.performance_snapshot) snapshots,
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') resp,
      (select count(*) from public.usuarios) usr,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc;`);
  ok('13.1 zero periodos oficiais', Number(fim.periodos) === 0);
  ok('13.2 zero snapshots oficiais', Number(fim.snapshots) === 0);
  ok('13.3 responsabilidade inalterada (23 ACTIVE)', Number(fim.resp) === 23);
  ok('13.4 usuarios inalterados (111)', Number(fim.usr) === 111);
  ok('13.5 fechamentos de Salario inalterados (24)', Number(fim.fech) === 24);
  ok('13.6 snapshots de Salario inalterados (2138)', Number(fim.snapc) === 2138);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

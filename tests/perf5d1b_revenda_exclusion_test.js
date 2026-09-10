#!/usr/bin/env node
/*
 * [RANKING] PERF-5D.1B -- H10: REVENDA fora do escopo do Ranking.
 *
 * Decisao do Humano: "IGNORAR TUDO O QUE FOR REVENDA."
 *
 * Prova, contra o banco REAL:
 *   - REVENDA sai do universo elegivel ANTES da responsabilidade e da
 *     metrica -- nao e "zero ponto", e ausencia;
 *   - as tres operacoes REVENDA conhecidas nao aparecem em lugar nenhum
 *     do calculo, e nao contam como residuo;
 *   - a regra e por CLASSIFICACAO canonica, nunca por operacao;
 *   - a regra nao se alarga para outras lojas;
 *   - H7, H8, o fallback por chassi, G4 e a falha segura seguem intactos;
 *   - residuo elegivel jan-ago = 0;
 *   - podio, empate de junho e recuperacoes de agosto preservados;
 *   - Salario, resolvedor compartilhado e responsabilidade intactos;
 *   - a migracao H10 nao contem NENHUMA acao de fechamento/reabertura;
 *   - nenhum periodo ou snapshot oficial existe.
 *
 * SEGURANCA: qualquer fechamento roda dentro de BEGIN...ROLLBACK, e o
 * script recusa por construcao um bloco que contenha statement COMMIT.
 * ZERO PII de cliente.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';
const MIGRACAO = path.join(__dirname, '..', 'supabase', 'migrations',
  '20260910180000_perf5d1b_revenda_ranking_exclusion.sql');

const REVENDA_CONHECIDAS = ['2026-01-19', '2026-04-13', '2026-05-07'];
const PODIO = {
  '2026-01': ['CAMILE', 43, 'BÁRBARA'], '2026-02': ['GIOVANNA', 50, 'CAMILE'],
  '2026-03': ['GIOVANNA', 50, 'FERNANDA'], '2026-04': ['WILLIAN', 50, 'Daiane'],
  '2026-05': ['DOUGLAS', 57, 'CAMILE'], '2026-06': ['CAMILE', 82, 'DOUGLAS'],
  '2026-07': ['DOUGLAS', 58, 'WILLIAN'], '2026-08': ['WILLIAN', 50, 'CAMILE'],
};

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function pad(s, n) { return String(s === null || s === undefined ? '-' : s).padEnd(n); }

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}
function runSql(token, query) {
  /* trava de seguranca: um bloco transacional nunca pode conter COMMIT */
  if (/^\s*begin\s*;/im.test(query) && query.split('\n').some(l => /^\s*commit\s*;/i.test(l))) {
    return Promise.reject(new Error('bloco transacional com COMMIT recusado'));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const MESES = `generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') d(mes)`;
const CALC = `public.performance_calcular_periodo(d.mes::date, (d.mes + interval '1 month - 1 day')::date) c`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _e: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-5D.1B -- H10: REVENDA FORA DO ESCOPO DO RANKING');

  /* ---------- 1. Seguranca estatica da migracao ---------- */
  h('1. A MIGRACAO H10 NAO PODE FECHAR NEM REABRIR NADA');
  const mig = fs.readFileSync(MIGRACAO, 'utf-8');
  const exe = mig.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const proibidos = [
    ['chamada de fechamento', /master_performance_fechar_periodo/i],
    ['chamada de reabertura', /master_performance_reabrir_periodo/i],
    ['insert em performance_periodo', /insert\s+into\s+public\.performance_periodo/i],
    ['insert em performance_snapshot', /insert\s+into\s+public\.performance_snapshot/i],
    ['delete em performance_periodo', /delete\s+from\s+public\.performance_periodo/i],
    ['delete em performance_snapshot', /delete\s+from\s+public\.performance_snapshot/i],
    ['update em performance_periodo', /update\s+public\.performance_periodo/i],
    ['update em performance_snapshot', /update\s+public\.performance_snapshot/i],
    ['laco', /\bloop\b/i],
    ['laco de meses', /generate_series\s*\(\s*date/i],
    ['redefine resolvedor compartilhado', /create or replace function public\.resolve_store_temporal/i],
    ['toca funcao de Salario', /operational_analyst_commission_metrics/i],
    ['escreve em vendas brutas', /update\s+public\.portal_sales/i],
    ['escreve em financiamentos brutos', /update\s+public\.portal_finance_operations/i],
  ];
  proibidos.forEach(([nome, re], i) =>
    ok('1.' + (i + 1) + ' migracao NAO contem ' + nome, !re.test(exe)));

  /* ---------- 2. Dominio ---------- */
  h('2. TRAVA DE DOMINIO');
  const md5 = await one(`select
      (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') sal,
      (select length(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') bytes,
      (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f' and p.proname='resolve_store_temporal') rs,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f'
          and p.proname in ('operational_analyst_commission_metrics','operational_salary_details','operational_metrics')
          and pg_get_functiondef(p.oid) like '%performance_loja_fora_de_escopo%') sal_usa;`);
  ok('2.1 funcao de comissao de Salario inalterada', md5.sal === SALARY_MD5, md5.sal);
  ok('2.2 tamanho inalterado', Number(md5.bytes) === 16301, md5.bytes + ' bytes');
  ok('2.3 resolve_store_temporal (compartilhada) inalterada', md5.rs === RESOLVE_STORE_MD5, md5.rs);
  ok('2.4 NENHUMA funcao de Salario conhece a regra H10', Number(md5.sal_usa) === 0);

  /* ---------- 3. H10 registrado ---------- */
  h('3. H10 REGISTRADO COMO AUTORIDADE');
  const h10 = await one(`select loja_canonica, autoridade, decisao,
      (motivo like '%IGNORAR TUDO O QUE FOR REVENDA%') tem_palavras
    from public.performance_loja_fora_de_escopo where loja_canonica='REVENDA';`);
  ok('3.1 REVENDA registrada como fora de escopo', h10.loja_canonica === 'REVENDA');
  ok('3.2 autoridade HUMAN_APPROVED', h10.autoridade === 'HUMAN_APPROVED');
  ok('3.3 decisao identificada como H10', h10.decisao === 'H10');
  ok('3.4 palavras do Humano preservadas no registro', h10.tem_palavras === true);

  /* ---------- 4. Predicado: por classificacao, sem alargar ---------- */
  h('4. A REGRA E POR CLASSIFICACAO CANONICA');
  const pred = await one(`select
      public.performance_loja_fora_de_escopo_ranking('REVENDA') a,
      public.performance_loja_fora_de_escopo_ranking('  revenda  ') b,
      public.performance_loja_fora_de_escopo_ranking('BARRA FUNDA') c,
      public.performance_loja_fora_de_escopo_ranking('EUROPA') d,
      public.performance_loja_fora_de_escopo_ranking('GASTAO') e,
      public.performance_loja_fora_de_escopo_ranking('ABC') f,
      public.performance_loja_fora_de_escopo_ranking('SEM LOJA') g,
      (select count(*) from public.performance_loja_fora_de_escopo) total;`);
  ok('4.1 REVENDA esta fora de escopo', pred.a === true);
  ok('4.2 caixa/espacos nao escapam da regra', pred.b === true);
  ok('4.3 BARRA FUNDA continua no escopo', pred.c === false);
  ok('4.4 EUROPA continua no escopo', pred.d === false);
  ok('4.5 GASTAO continua no escopo', pred.e === false);
  ok('4.6 ABC continua no escopo', pred.f === false);
  ok('4.7 SEM LOJA nao virou fora de escopo', pred.g === false);
  ok('4.8 a regra nao foi alargada: uma unica loja excluida', Number(pred.total) === 1);
  ok('4.9 nenhuma exclusao por operacao/chassi/data na migracao',
    !/chassis\s*=\s*'/i.test(exe) && !/operation_date\s*=\s*date/i.test(exe));

  /* ---------- 5. REVENDA fora do universo ---------- */
  h('5. REVENDA NAO ENTRA NO CALCULO');
  const motor = await one(`select count(*) n from ${MESES} cross join lateral ${CALC}
    where c.loja='REVENDA';`);
  ok('5.1 ZERO linhas REVENDA dentro do motor', Number(motor.n) === 0, motor.n + '');
  const fora = await all(`select to_char(d.mes,'YYYY-MM') mes, x.loja, x.motivo, x.operacoes,
      round(x.retorno,2) retorno
    from ${MESES} cross join lateral
      public.performance_operacoes_fora_de_escopo(d.mes::date, (d.mes + interval '1 month - 1 day')::date) x
    order by 1;`);
  ok('5.2 diagnostico lista exatamente 3 operacoes fora de escopo', fora.length === 3, fora.length + '');
  console.log('  ' + pad('Mes', 9) + pad('Loja', 10) + pad('Motivo', 24) + 'Retorno');
  fora.forEach(f => console.log('  ' + pad(f.mes, 9) + pad(f.loja, 10) + pad(f.motivo, 24) + 'R$ ' + f.retorno));
  ok('5.3 todas marcadas OUT_OF_SCOPE_REVENDA', fora.every(f => f.motivo === 'OUT_OF_SCOPE_REVENDA'));
  ok('5.4 as tres datas conhecidas de jan/abr/mai', fora.length === 3
    && fora[0].mes === '2026-01' && fora[1].mes === '2026-04' && fora[2].mes === '2026-05');

  /* as 3 operacoes brutas continuam existindo -- so nao participam */
  const bruto = await one(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc)
    select count(*) n from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
    where f.is_real_financing and upper(btrim(coalesce(f.store,'')))='REVENDA'
      and f.operation_date in (${REVENDA_CONHECIDAS.map(d => `date '${d}'`).join(',')});`);
  ok('5.5 as 3 operacoes REVENDA continuam existindo como evidencia bruta',
    Number(bruto.n) === 3, bruto.n + ' linha(s)');

  /* ---------- 6. Contribuicao zero em toda metrica ---------- */
  h('6. CONTRIBUICAO DE REVENDA EM CADA METRICA');
  const met = await one(`select
      coalesce(sum(c.retorno) filter (where c.loja='REVENDA' and c.departamento='NOVOS'),0) novos,
      coalesce(sum(c.retorno) filter (where c.loja='REVENDA' and c.departamento='SEMINOVOS'),0) semi,
      coalesce(sum(c.operacoes) filter (where c.loja='REVENDA'),0) und,
      coalesce(sum(c.spf_unidades) filter (where c.loja='REVENDA'),0) spf
    from ${MESES} cross join lateral ${CALC};`);
  [['Maior Retorno Novos', met.novos], ['Maior Retorno Seminovos', met.semi],
   ['UND Financiado', met.und], ['UND SPF', met.spf]].forEach(([m, v], i) =>
    ok('6.' + (i + 1) + ' ' + pad(m, 26) + 'contribuicao 0 / EXCLUIDA', Number(v) === 0, String(v)));

  /* ---------- 7. Responsabilidade nao e exigida ---------- */
  h('7. REVENDA NAO EXIGE ANALISTA RESPONSAVEL');
  const resp = await one(`select
      (select count(*) from public.analista_responsavel_loja where loja_normalizada='REVENDA') intervalos,
      (select count(*) from ${MESES} cross join lateral ${CALC}
        where c.loja='REVENDA' and c.analista_usuario_id is null) revenda_nao_atribuida,
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') ativas,
      (select count(*) from public.analista_responsavel_loja where status='SUPERSEDED') sup,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit;`);
  ok('7.1 nenhum titular sintetico de REVENDA foi criado', Number(resp.intervalos) === 1,
    resp.intervalos + ' (apenas a vigencia governada de 21/08, pre-existente)');
  ok('7.2 REVENDA nunca aparece como nao atribuida', Number(resp.revenda_nao_atribuida) === 0);
  ok('7.3 responsabilidade ACTIVE inalterada (23)', Number(resp.ativas) === 23);
  ok('7.4 responsabilidade SUPERSEDED inalterada (4)', Number(resp.sup) === 4);
  ok('7.5 auditoria de responsabilidade inalterada (31)', Number(resp.audit) === 31);

  /* ---------- 8. Residuo elegivel ---------- */
  h('8. RESIDUO ELEGIVEL JAN-AGO');
  const res = await all(`select to_char(d.mes,'YYYY-MM') mes,
      coalesce(sum(c.operacoes),0) elegiveis,
      coalesce(sum(c.operacoes) filter (where c.analista_usuario_id is null),0) residuo
    from ${MESES} cross join lateral ${CALC} group by 1 order by 1;`);
  console.log('  ' + pad('Mes', 9) + pad('Elegiveis', 11) + 'Residuo');
  res.forEach(r => console.log('  ' + pad(r.mes, 9) + pad(r.elegiveis, 11) + r.residuo));
  ok('8.1 oito meses avaliados', res.length === 8);
  res.forEach(r => ok('8.res ' + r.mes + ' residuo elegivel = 0', Number(r.residuo) === 0, r.residuo + ''));
  const tot = res.reduce((s, r) => s + Number(r.residuo), 0);
  ok('8.2 residuo elegivel TOTAL = 0', tot === 0, 'total=' + tot);
  ok('8.3 REVENDA saiu do denominador em janeiro (149 -> 148)',
    Number(res.find(r => r.mes === '2026-01').elegiveis) === 148);
  ok('8.4 REVENDA saiu do denominador em abril (155 -> 154)',
    Number(res.find(r => r.mes === '2026-04').elegiveis) === 154);
  ok('8.5 REVENDA saiu do denominador em maio (149 -> 148)',
    Number(res.find(r => r.mes === '2026-05').elegiveis) === 148);

  /* ---------- 9. Heranca das Waves anteriores ---------- */
  h('9. H7, H8, FALLBACK, G4 E FALHA SEGURA PRESERVADOS');
  const her = await one(`select
      public.performance_normalizar_loja('2') h7,
      (select spf_programa_inicio::text from public.performance_regra_versao order by criado_em desc limit 1) h8_inicio,
      (select spf_maio_override from public.performance_regra_versao order by criado_em desc limit 1) h8_maio,
      public.performance_loja_por_venda_do_chassi('CHASSI_QUE_NAO_EXISTE', date '2026-06-30') fallback_nulo,
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='performance_calcular_periodo'
          and pg_get_functiondef(p.oid) ~ 'sa\\.sale_date <= [a-z_]+\\.d') g4;`);
  ok('9.1 H7 preservado: "2" -> BARRA FUNDA', her.h7 === 'BARRA FUNDA');
  ok('9.2 H8 preservado: SPF a partir de 2026-05-21', her.h8_inicio === '2026-05-21');
  ok('9.3 H8 preservado: maio aplicavel e nao rateado', her.h8_maio === 'APPLICABLE_NOT_PRORATED');
  ok('9.4 fallback por chassi preservado (falha segura devolve NULL)', her.fallback_nulo === null);
  ok('9.5 G4 STRICT_DATE_BOUNDED preservado no motor', Number(her.g4) === 1);
  const cinco = await one(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
    fin as (select f.chassis, f.operation_date d,
      public.performance_normalizar_loja(coalesce(public.resolve_store_temporal(
        coalesce(f.seller_user_id,f.seller_id), f.operation_date, nullif(f.store,'')),'SEM LOJA')) prim
      from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
      where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')
    select count(*) n from fin
    where fin.prim='SEM LOJA'
      and public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d) is not null;`);
  ok('9.6 as 5 recuperacoes SEM LOJA do PERF-5D.1A seguem valendo',
    Number(cinco.n) === 5, cinco.n + ' recuperada(s)');

  /* ---------- 10. Fechamento em ROLLBACK: podio, junho, agosto ---------- */
  h('10. PODIO, EMPATE DE JUNHO E AGOSTO (fechamento em ROLLBACK)');
  const dry = await runSql(token, `begin;
    do $imp$ begin
      perform set_config('request.jwt.claims', json_build_object('sub',
        (select auth_user_id from public.usuarios where ativo
          and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null
          order by criado_em limit 1))::text, true);
    end $imp$;
    create temp table _d(mes text, nome text, pts int, und int, nao int) on commit drop;
    do $x$
    declare m date; r jsonb; p uuid;
    begin
      for m in select generate_series(date '2026-01-01', date '2026-08-01', interval '1 month')::date loop
        r := public.master_performance_criar_periodo(m);
        p := (r->>'periodo_id')::uuid;
        r := public.master_performance_fechar_periodo(p, 'PERF-5D.1B regressao');
        insert into _d select to_char(m,'YYYY-MM'), split_part(btrim(u.nome),' ',1),
          res.pontos_total, res.und_financiado, (r->>'nao_atribuidas')::int
        from public.performance_snapshot_resultado res
        join public.usuarios u on u.id=res.analista_usuario_id
        where res.snapshot_id=(r->>'snapshot_id')::uuid;
      end loop;
    end $x$;
    select * from _d order by mes, pts desc, nome;
    rollback;`);
  const by = {}; if (Array.isArray(dry)) dry.forEach(o => (by[o.mes] = by[o.mes] || []).push(o));
  else console.log('  (erro: ' + JSON.stringify(dry).slice(0, 250) + ')');

  Object.keys(PODIO).forEach(m => {
    const [w, pts, ru] = PODIO[m];
    const s = (by[m] || []).sort((a, b) => b.pts - a.pts);
    ok('10.podio ' + m + ' 1o ' + pad(w, 10) + pts + ' / 2o ' + ru,
      s[0] && s[0].nome === w && Number(s[0].pts) === pts && s[1] && s[1].nome === ru,
      s[0] ? s[0].nome + '=' + s[0].pts + ' / ' + (s[1] || {}).nome : '-');
    ok('10.res ' + m + ' residuo no snapshot = 0', s[0] && Number(s[0].nao) === 0, s[0] ? s[0].nao + '' : '-');
  });

  const g = (m, n) => ((by[m] || []).find(x => x.nome === n) || {});
  const jw = g('2026-06', 'WILLIAN'), jc = g('2026-06', 'CAMILE');
  ok('10.jun.1 Willian UND 28', Number(jw.und) === 28, jw.und + '');
  ok('10.jun.2 Camile UND 28', Number(jc.und) === 28, jc.und + '');
  ok('10.jun.3 empate preservado 28/28', Number(jw.und) === Number(jc.und));
  ok('10.jun.4 Willian 30 pontos (FULL_POINTS no empate)', Number(jw.pts) === 30, jw.pts + '');
  ok('10.jun.5 Camile 82 pontos', Number(jc.pts) === 82, jc.pts + '');
  [['WILLIAN', 34, 50], ['FERNANDA', 27, 25], ['JACENIR', 19, 17]].forEach(([n, u, p]) => {
    const v = g('2026-08', n);
    ok('10.ago ' + pad(n, 9) + 'UND=' + u + ' pontos=' + p,
      Number(v.und) === u && Number(v.pts) === p, v.und + '|' + v.pts);
  });

  /* ---------- 11. Nenhum fechamento oficial ---------- */
  h('11. ESTADO OFICIAL E EVIDENCIA BRUTA');
  const fim = await one(`select
      (select count(*) from public.performance_periodo) periodos,
      (select count(*) from public.performance_snapshot) snapshots,
      (select count(*) from public.performance_snapshot_resultado) resultados,
      (select count(*) from public.performance_snapshot_detalhe) detalhes,
      (select count(*) from public.performance_auditoria) auditoria,
      (select count(*) from public.portal_sales where trim(coalesce(store,''))='2') vendas2,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2') fin2;`);
  ok('11.1 ZERO periodos oficiais', Number(fim.periodos) === 0, fim.periodos + '');
  ok('11.2 ZERO snapshots oficiais', Number(fim.snapshots) === 0, fim.snapshots + '');
  ok('11.3 ZERO resultados oficiais', Number(fim.resultados) === 0);
  ok('11.4 ZERO detalhes oficiais', Number(fim.detalhes) === 0);
  ok('11.5 auditoria do incidente PERF-5D.1A preservada (40)',
    Number(fim.auditoria) === 40, fim.auditoria + ' linha(s)');
  ok('11.6 evidencia bruta de vendas intacta (189)', Number(fim.vendas2) === 189);
  ok('11.7 evidencia bruta de financiamentos intacta (186)', Number(fim.fin2) === 186);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

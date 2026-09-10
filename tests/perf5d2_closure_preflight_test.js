#!/usr/bin/env node
/*
 * [RANKING] PERF-5D.2 -- pre-voo do fechamento historico jan-ago/2026.
 *
 * Este e o ultimo portao antes de a historia virar imutavel. Ele prova,
 * contra o banco REAL, exatamente o que um fechamento congelaria:
 *
 *   - estado oficial permanece 0/0/0/0 com as 40 auditorias do incidente;
 *   - as 40 linhas de auditoria NAO podem ser lidas como fechamento ativo;
 *   - periodos sao meses de calendario, nunca competencia de Salario;
 *   - o contrato de pontuacao esta congelado na versao de regra;
 *   - H8 (SPF a partir de 21/05) e H10 (REVENDA fora do escopo) valem;
 *   - as 5 recuperacoes por chassi seguem deterministicas e marcadas;
 *   - residuo elegivel = 0 nos oito meses;
 *   - os oito podios, o empate de junho e agosto batem;
 *   - identidade congelada e UUID, nunca nome nem CPF;
 *   - UPDATE/DELETE em snapshot FECHADO sao recusados pelo banco;
 *   - auditoria e append-only;
 *   - refechar sem reabrir e recusado;
 *   - reabrir/refechar PRESERVA a versao anterior (nao destrutivo);
 *   - o visualizador historico le o snapshot, nunca a auditoria.
 *
 * SEGURANCA: todo ensaio roda dentro de BEGIN...ROLLBACK e o script
 * recusa por construcao qualquer bloco que contenha statement COMMIT.
 * O estado oficial e conferido antes e depois de cada ensaio.
 * ZERO PII de cliente. Somente primeiro nome de analista.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';

const PODIO = {
  '2026-01': ['CAMILE', 43, 'BÁRBARA', 35], '2026-02': ['GIOVANNA', 50, 'CAMILE', 43],
  '2026-03': ['GIOVANNA', 50, 'FERNANDA', 35], '2026-04': ['WILLIAN', 50, 'Daiane', 35],
  '2026-05': ['DOUGLAS', 57, 'CAMILE', 35], '2026-06': ['CAMILE', 82, 'DOUGLAS', 52],
  '2026-07': ['DOUGLAS', 58, 'WILLIAN', 50], '2026-08': ['WILLIAN', 50, 'CAMILE', 43],
};
/* meses com SPF aplicavel (H8: programa comeca em 21/05/2026) */
const SPF_APLICAVEL = { '2026-01': false, '2026-02': false, '2026-03': false, '2026-04': false,
  '2026-05': true, '2026-06': true, '2026-07': true, '2026-08': true };
/* H10: operacoes REVENDA conhecidas, por mes */
const REVENDA_FORA = { '2026-01': 1, '2026-04': 1, '2026-05': 1 };

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
  /* trava de seguranca: um bloco transacional nunca pode conter COMMIT */
  if (/^\s*begin\s*;/im.test(query) && query.split('\n').some(l => /^\s*commit\s*(;|$)/i.test(l))) {
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

const ESTADO = `select (select count(*) from public.performance_periodo) periodos,
 (select count(*) from public.performance_snapshot) snapshots,
 (select count(*) from public.performance_snapshot_resultado) resultados,
 (select count(*) from public.performance_snapshot_detalhe) detalhes,
 (select count(*) from public.performance_auditoria) auditoria`;

const IMPERSONA = `do $imp$ begin
  perform set_config('request.jwt.claims', json_build_object('sub',
    (select auth_user_id from public.usuarios where ativo
      and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null
      order by criado_em limit 1))::text, true);
end $imp$;`;

const MESES = `generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') d(mes)`;
const CALC = `public.performance_calcular_periodo(d.mes::date, (d.mes + interval '1 month - 1 day')::date) c`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _e: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-5D.2 -- PRE-VOO DO FECHAMENTO HISTORICO JAN-AGO/2026');

  /* ---------- 1. Trava de dominio ---------- */
  h('1. TRAVA DE DOMINIO RANKING x SALARIO');
  const md5 = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') sal,
    (select length(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') sal_bytes,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='resolve_store_temporal') res`);
  ok('1.1 funcao de Salario intacta', md5.sal === SALARY_MD5, md5.sal);
  ok('1.2 tamanho da funcao de Salario intacto (16301)', Number(md5.sal_bytes) === 16301);
  ok('1.3 resolvedor compartilhado intacto', md5.res === RESOLVE_STORE_MD5, md5.res);

  /* ---------- 2. Estado oficial antes ---------- */
  h('2. ESTADO OFICIAL ANTES -- NADA FECHADO');
  const ini = await one(ESTADO);
  const CHAVE = JSON.stringify(ini);
  ok('2.1 ZERO periodos oficiais', Number(ini.periodos) === 0, ini.periodos + '');
  ok('2.2 ZERO snapshots oficiais', Number(ini.snapshots) === 0, ini.snapshots + '');
  ok('2.3 ZERO resultados oficiais', Number(ini.resultados) === 0);
  ok('2.4 ZERO detalhes oficiais', Number(ini.detalhes) === 0);
  ok('2.5 auditoria do incidente PERF-5D.1A preservada (40)', Number(ini.auditoria) === 40, ini.auditoria + '');

  /* ---------- 3. G27: a auditoria do incidente nao e fechamento ---------- */
  h('3. G27 -- AS 40 AUDITORIAS NAO PODEM SER LIDAS COMO FECHAMENTO ATIVO');
  const g27 = await one(`select
    (select count(*) from public.performance_auditoria a where a.periodo_id is not null
       and not exists (select 1 from public.performance_periodo p where p.id=a.periodo_id)) periodo_orfao,
    (select count(*) from public.performance_auditoria) total,
    (select count(*) from public.performance_periodo where status='CLOSED') fechados,
    (select count(*) from public.performance_auditoria where evento='PERIOD_REOPENED') reabertos,
    (select count(*) from public.performance_auditoria where evento='PERIOD_CLOSED') fechamentos`);
  ok('3.1 TODA linha de auditoria aponta para periodo inexistente',
    Number(g27.periodo_orfao) === Number(g27.total), g27.periodo_orfao + '/' + g27.total);
  ok('3.2 nenhum periodo com status CLOSED existe', Number(g27.fechados) === 0);
  ok('3.3 cada fechamento do incidente tem a reabertura correspondente',
    Number(g27.fechamentos) === Number(g27.reabertos), g27.fechamentos + ' x ' + g27.reabertos);
  const vw = await one(`select pg_get_functiondef(p.oid) def from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='performance_ranking_periodo'`);
  ok('3.4 o visualizador historico le o SNAPSHOT', /performance_snapshot_resultado/i.test(vw.def || ''));
  ok('3.5 o visualizador NAO consulta a auditoria', !/performance_auditoria/i.test(vw.def || ''));
  ok('3.6 o visualizador deriva o estado de performance_periodo.status',
    /v_p\.status\s*=\s*'CLOSED'/i.test(vw.def || ''));

  /* ---------- 4. Periodos sao meses de calendario ---------- */
  h('4. PERIODOS SAO MESES DE CALENDARIO, NUNCA COMPETENCIA DE SALARIO');
  const cal = await one(`select
    (select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid
      where t.relname='performance_periodo' and c.conname='performance_periodo_mes_calendario') calendario,
    (select pg_get_constraintdef(c.oid) from pg_constraint c join pg_class t on t.oid=c.conrelid
      where t.relname='performance_periodo' and c.conname='performance_periodo_mes_calendario') def,
    (select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid
      where t.relname='performance_periodo' and c.conname='performance_periodo_unico') unico`);
  ok('4.1 restricao de mes de calendario existe no banco', Number(cal.calendario) === 1);
  ok('4.2 o inicio e obrigatoriamente date_trunc(month)', /date_trunc/i.test(cal.def || ''));
  ok('4.3 o fim e obrigatoriamente o ultimo dia do mes', /1 mon -1 days|1 mon -1 day/i.test(cal.def || ''));
  ok('4.4 nao existe fronteira 21->20 de Salario na restricao', !/21|20/.test((cal.def || '').replace(/\d+ mon/g, '')));
  ok('4.5 um unico periodo por mes', Number(cal.unico) === 1);

  /* ---------- 5. Contrato de pontuacao congelado ---------- */
  h('5. CONTRATO DE PONTUACAO CONGELADO NA VERSAO DE REGRA');
  const r = await one(`select * from public.performance_regra_versao order by criado_em desc limit 1`);
  ok('5.1 Retorno Novos 35/17', Number(r.pontos_retorno_novos_1) === 35 && Number(r.pontos_retorno_novos_2) === 17);
  ok('5.2 Retorno Seminovos 35/17', Number(r.pontos_retorno_seminovos_1) === 35 && Number(r.pontos_retorno_seminovos_2) === 17);
  ok('5.3 UND Financiado 15/8', Number(r.pontos_und_financiado_1) === 15 && Number(r.pontos_und_financiado_2) === 8);
  ok('5.4 UND SPF 15/8', Number(r.pontos_und_spf_1) === 15 && Number(r.pontos_und_spf_2) === 8);
  ok('5.5 maximo 100 = 35+35+15+15',
    Number(r.pontos_retorno_novos_1) + Number(r.pontos_retorno_seminovos_1)
    + Number(r.pontos_und_financiado_1) + Number(r.pontos_und_spf_1) === 100);
  ok('5.6 empate FULL_POINTS_COMPETITION_RANKING', r.regra_empate === 'FULL_POINTS_COMPETITION_RANKING');
  ok('5.7 atividade zero nao recebe rank', r.regra_atividade_zero === 'METRIC_LE_ZERO_UNRANKED');
  ok('5.8 G4 STRICT_DATE_BOUNDED', r.resolver_g4 === 'STRICT_DATE_BOUNDED');
  ok('5.9 G6 NOT_APPLICABLE_BEFORE_PROGRAM_START', r.aplicabilidade_g6 === 'NOT_APPLICABLE_BEFORE_PROGRAM_START');
  ok('5.10 H8 inicio do programa SPF em 2026-05-21', String(r.spf_programa_inicio).slice(0, 10) === '2026-05-21');
  ok('5.11 H8 maio aplicavel e NAO proporcional', r.spf_maio_override === 'APPLICABLE_NOT_PRORATED');
  ok('5.12 SPF entra no bruto a 70%', Number(r.spf_percentual_bruto) === 70);
  ok('5.13 versao de normalizacao de loja registrada', !!r.normalizacao_loja_versao, r.normalizacao_loja_versao);
  const emp = await one(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='master_performance_fechar_periodo'`);
  ok('5.14 o motor usa rank() -- empate no 1o da metrica leva pontos cheios',
    /rank\(\)\s*over\s*\(\s*order\s+by/i.test(emp.def || ''));
  ok('5.15 metrica <= 0 fica sem rank no motor',
    /where\s+novos\s*>\s*0/i.test(emp.def || '') && /where\s+und_spf\s*>\s*0/i.test(emp.def || ''));

  /* ---------- 6. H10 -- REVENDA fora do escopo ---------- */
  h('6. H10 -- REVENDA FORA DO UNIVERSO ELEGIVEL');
  const h10 = await one(`select loja_canonica, autoridade, decisao, motivo
    from public.performance_loja_fora_de_escopo where loja_canonica='REVENDA'`);
  ok('6.1 REVENDA registrada como fora de escopo', h10.loja_canonica === 'REVENDA');
  ok('6.2 autoridade HUMAN_APPROVED', h10.autoridade === 'HUMAN_APPROVED');
  ok('6.3 decisao H10', h10.decisao === 'H10');
  ok('6.4 palavras do Humano preservadas',
    /IGNORAR TUDO O QUE FOR REVENDA/i.test(h10.motivo || ''));
  const so1 = await one(`select count(*) n from public.performance_loja_fora_de_escopo`);
  ok('6.5 a regra NAO se alargou para outras lojas (1 unica)', Number(so1.n) === 1, so1.n + '');
  const rev = await all(`select to_char(d.mes,'YYYY-MM') mes, count(*) linhas
    from ${MESES} cross join lateral ${CALC} where c.loja='REVENDA' group by 1`);
  ok('6.6 ZERO linhas REVENDA dentro do motor em jan-ago', rev.length === 0, rev.length + ' linha(s)');
  const fora = await all(`select to_char(d.mes,'YYYY-MM') mes, count(*)::int ops
    from ${MESES} cross join lateral public.performance_operacoes_fora_de_escopo(
      d.mes::date, (d.mes + interval '1 month - 1 day')::date) f group by 1 order by 1`);
  const foraMap = Object.fromEntries(fora.map(x => [x.mes, Number(x.ops)]));
  Object.entries(REVENDA_FORA).forEach(([m, n], i) =>
    ok('6.' + (7 + i) + ' ' + m + ' registra ' + n + ' operacao fora de escopo', foraMap[m] === n, JSON.stringify(foraMap[m])));
  ok('6.10 somente 3 operacoes fora de escopo em jan-ago',
    Object.values(foraMap).reduce((a, b) => a + b, 0) === 3, JSON.stringify(foraMap));

  /* ---------- 7. Fallback por chassi ---------- */
  h('7. AS 5 RECUPERACOES POR CHASSI SEGUEM DETERMINISTICAS');
  const fb = await all(`select to_char(d.mes,'YYYY-MM') mes, c.loja, c.departamento, c.operacoes::int ops
    from ${MESES} cross join lateral ${CALC}
    where c.loja_origem_codigo = 'FALLBACK_VENDA_CHASSI' order by 1, c.loja, c.departamento`);
  const totalFb = fb.reduce((a, x) => a + Number(x.ops), 0);
  ok('7.1 exatamente 5 operacoes recuperadas por chassi', totalFb === 5, totalFb + '');
  ok('7.2 junho recuperou 1 operacao em BANDEIRANTES',
    fb.some(x => x.mes === '2026-06' && x.loja === 'BANDEIRANTES' && Number(x.ops) === 1));
  ok('7.3 agosto recuperou BANDEIRANTES, EUROPA e GASTAO',
    ['BANDEIRANTES', 'EUROPA', 'GASTAO'].every(l => fb.some(x => x.mes === '2026-08' && x.loja === l)));
  ok('7.4 nenhuma recuperacao ficou sem loja canonica',
    fb.every(x => x.loja && x.loja !== 'SEM LOJA'));
  ok('7.5 a marca do fallback e congelavel no detalhe do snapshot',
    (await one(`select count(*) n from information_schema.columns where table_schema='public'
      and table_name='performance_snapshot_detalhe' and column_name='loja_normalizada_de'`)).n === 1);

  /* ---------- 8. Residuo elegivel ---------- */
  h('8. RESIDUO ELEGIVEL = 0 NOS OITO MESES');
  const res = await all(`select to_char(d.mes,'YYYY-MM') mes,
      coalesce(sum(c.operacoes) filter (where c.analista_usuario_id is null),0)::int residuo,
      coalesce(sum(c.operacoes),0)::int total
    from ${MESES} cross join lateral ${CALC} group by 1 order by 1`);
  ok('8.1 os oito meses foram calculados', res.length === 8, res.length + '');
  res.forEach((m, i) => ok('8.' + (i + 2) + ' ' + m.mes + ' residuo elegivel = 0',
    Number(m.residuo) === 0, 'residuo=' + m.residuo + ' de ' + m.total + ' ops'));

  /* ---------- 9. Ensaio somente-rollback dos oito fechamentos ---------- */
  h('9. ENSAIO SOMENTE-ROLLBACK -- PODIOS, EMPATE E SPF');
  const ensaio = await all(`begin;
${IMPERSONA}
create temp table _s(mes text, nome text, total int, und_fin int, und_spf int,
  rs numeric, spf_ok boolean, maxs int, nao_atrib int) on commit drop;
do $x$
declare m date; j jsonb; p uuid; sn uuid;
begin
  for m in select generate_series(date '2026-01-01', date '2026-08-01', interval '1 month')::date loop
    j := public.master_performance_criar_periodo(m);
    p := (j->>'periodo_id')::uuid;
    j := public.master_performance_fechar_periodo(p, 'PERF-5D.2 ensaio somente-rollback');
    sn := (j->>'snapshot_id')::uuid;
    insert into _s select to_char(m,'YYYY-MM'), split_part(btrim(u.nome),' ',1),
      q.pontos_total, q.und_financiado, q.und_spf, q.retorno_seminovos,
      (j->>'spf_aplicavel')::boolean, q.max_score, (j->>'nao_atribuidas')::int
    from public.performance_snapshot_resultado q
    join public.usuarios u on u.id=q.analista_usuario_id where q.snapshot_id=sn;
  end loop;
end $x$;
select * from _s order by mes, total desc, nome;
rollback;`);
  ok('9.1 o ensaio produziu resultados nos oito meses',
    new Set(ensaio.map(x => x.mes)).size === 8, new Set(ensaio.map(x => x.mes)).size + '');
  let i9 = 2;
  for (const [mes, [vNome, vPts, sNome, sPts]] of Object.entries(PODIO)) {
    const linhas = ensaio.filter(x => x.mes === mes).sort((a, b) => b.total - a.total);
    const v = linhas[0];
    ok('9.' + (i9++) + ' ' + mes + ' vencedor ' + vNome + ' com ' + vPts,
      v && v.nome === vNome && Number(v.total) === vPts, v ? v.nome + '=' + v.total : 'sem linha');
    const vice = linhas.filter(x => Number(x.total) !== Number(v.total))[0];
    ok('9.' + (i9++) + ' ' + mes + ' vice com ' + sPts + ' ponto(s)',
      vice && Number(vice.total) === sPts, vice ? vice.nome + '=' + vice.total : 'sem vice');
    ok('9.' + (i9++) + ' ' + mes + ' ' + sNome + ' esta na 2a colocacao',
      linhas.some(x => x.nome === sNome && Number(x.total) === sPts));
    ok('9.' + (i9++) + ' ' + mes + ' nenhuma operacao nao atribuida',
      linhas.every(x => Number(x.nao_atrib) === 0));
    ok('9.' + (i9++) + ' ' + mes + ' SPF aplicavel = ' + SPF_APLICAVEL[mes] + ' (H8)',
      linhas.every(x => x.spf_ok === SPF_APLICAVEL[mes]), 'max=' + (linhas[0] || {}).maxs);
    ok('9.' + (i9++) + ' ' + mes + ' teto ' + (SPF_APLICAVEL[mes] ? 100 : 85),
      linhas.every(x => Number(x.maxs) === (SPF_APLICAVEL[mes] ? 100 : 85)));
  }

  /* ---------- 10. Empate de junho e recuperacao de agosto ---------- */
  h('10. REGRESSOES DE CARGA -- EMPATE DE JUNHO E AGOSTO');
  const jun = ensaio.filter(x => x.mes === '2026-06');
  const jW = jun.find(x => x.nome === 'WILLIAN'), jC = jun.find(x => x.nome === 'CAMILE');
  ok('10.1 junho Willian UND Financiado = 28', jW && Number(jW.und_fin) === 28, jW && jW.und_fin + '');
  ok('10.2 junho Camile UND Financiado = 28', jC && Number(jC.und_fin) === 28, jC && jC.und_fin + '');
  ok('10.3 junho ha empate no 1o lugar da metrica', jW && jC && jW.und_fin === jC.und_fin);
  ok('10.4 junho Willian totaliza 30', jW && Number(jW.total) === 30, jW && jW.total + '');
  ok('10.5 junho Camile totaliza 82', jC && Number(jC.total) === 82, jC && jC.total + '');
  const ago = ensaio.filter(x => x.mes === '2026-08');
  const aW = ago.find(x => x.nome === 'WILLIAN'), aF = ago.find(x => x.nome === 'FERNANDA'),
    aJ = ago.find(x => x.nome === 'JACENIR');
  ok('10.6 agosto Willian 34 UND / 50 pontos', aW && Number(aW.und_fin) === 34 && Number(aW.total) === 50);
  ok('10.7 agosto Fernanda 27 UND / 25 pontos', aF && Number(aF.und_fin) === 27 && Number(aF.total) === 25);
  ok('10.8 agosto Jacenir 19 UND / 17 pontos', aJ && Number(aJ.und_fin) === 19 && Number(aJ.total) === 17);
  ok('10.9 agosto Jacenir Retorno Seminovos = 53.473,88',
    aJ && Math.abs(Number(aJ.rs) - 53473.88) < 0.005, aJ && aJ.rs);

  /* ---------- 11. Identidade congelada ---------- */
  h('11. IDENTIDADE CONGELADA E UUID, NUNCA NOME NEM CPF');
  const idc = await all(`select column_name, data_type from information_schema.columns
    where table_schema='public' and table_name in
      ('performance_snapshot_resultado','performance_snapshot_detalhe') order by 1`);
  const nomes = idc.map(x => x.column_name);
  ok('11.1 resultado identifica o analista por UUID',
    idc.some(x => x.column_name === 'analista_usuario_id' && x.data_type === 'uuid'));
  ok('11.2 nenhuma coluna de CPF no snapshot', !nomes.some(n => /cpf/i.test(n)));
  ok('11.3 nenhuma coluna de email no snapshot', !nomes.some(n => /email/i.test(n)));
  ok('11.4 o nome de exibicao NAO e autoridade de identidade',
    !nomes.some(n => /^nome|nome$/i.test(n)));
  const fk = await one(`select count(*) n from pg_constraint c join pg_class t on t.oid=c.conrelid
    where t.relname='performance_snapshot_resultado' and c.contype='f'
      and pg_get_constraintdef(c.oid) ilike '%analista_usuario_id%usuarios(id)%'`);
  ok('11.5 o UUID do analista tem chave estrangeira para usuarios', Number(fk.n) === 1);

  /* ---------- 12. Imutabilidade imposta pelo banco ---------- */
  h('12. IMUTABILIDADE IMPOSTA PELO BANCO');
  const imut = await all(`begin;
${IMPERSONA}
create temp table _t(tentativa text, bloqueado boolean, detalhe text) on commit drop;
do $x$
declare j jsonb; p uuid; sn uuid; rid uuid; aid bigint;
begin
  j := public.master_performance_criar_periodo(date '2026-01-01');
  p := (j->>'periodo_id')::uuid;
  j := public.master_performance_fechar_periodo(p, 'sonda de imutabilidade');
  sn := (j->>'snapshot_id')::uuid;
  select id into rid from public.performance_snapshot_resultado where snapshot_id=sn limit 1;
  select id into aid from public.performance_auditoria order by id limit 1;

  begin update public.performance_snapshot_resultado set pontos_total=999 where id=rid;
    insert into _t values ('UPDATE resultado', false, null);
  exception when others then insert into _t values ('UPDATE resultado', true, sqlerrm); end;

  begin delete from public.performance_snapshot_resultado where id=rid;
    insert into _t values ('DELETE resultado', false, null);
  exception when others then insert into _t values ('DELETE resultado', true, sqlerrm); end;

  begin update public.performance_snapshot_detalhe set operacoes=999 where snapshot_id=sn;
    insert into _t values ('UPDATE detalhe', false, null);
  exception when others then insert into _t values ('UPDATE detalhe', true, sqlerrm); end;

  begin delete from public.performance_snapshot_detalhe where snapshot_id=sn;
    insert into _t values ('DELETE detalhe', false, null);
  exception when others then insert into _t values ('DELETE detalhe', true, sqlerrm); end;

  begin update public.performance_snapshot set retorno_total=1 where id=sn;
    insert into _t values ('UPDATE snapshot', false, null);
  exception when others then insert into _t values ('UPDATE snapshot', true, sqlerrm); end;

  begin delete from public.performance_snapshot where id=sn;
    insert into _t values ('DELETE snapshot', false, null);
  exception when others then insert into _t values ('DELETE snapshot', true, sqlerrm); end;

  begin update public.performance_auditoria set motivo='reescrito' where id=aid;
    insert into _t values ('UPDATE auditoria', false, null);
  exception when others then insert into _t values ('UPDATE auditoria', true, sqlerrm); end;

  begin delete from public.performance_auditoria where id=aid;
    insert into _t values ('DELETE auditoria', false, null);
  exception when others then insert into _t values ('DELETE auditoria', true, sqlerrm); end;

  begin j := public.master_performance_fechar_periodo(p, 'refechar sem reabrir');
    insert into _t values ('REFECHAR sem reabrir', false, null);
  exception when others then insert into _t values ('REFECHAR sem reabrir', true, sqlerrm); end;
end $x$;
select * from _t;
rollback;`);
  const bloq = t => { const x = imut.find(y => y.tentativa === t); return x && x.bloqueado === true; };
  ['UPDATE resultado', 'DELETE resultado', 'UPDATE detalhe', 'DELETE detalhe',
    'UPDATE snapshot', 'DELETE snapshot'].forEach((t, i) =>
      ok('12.' + (i + 1) + ' ' + t + ' em snapshot FECHADO e recusado', bloq(t)));
  ok('12.7 UPDATE em auditoria e recusado (append-only)', bloq('UPDATE auditoria'));
  ok('12.8 DELETE em auditoria e recusado (append-only)', bloq('DELETE auditoria'));
  ok('12.9 refechar sem reabrir e recusado', bloq('REFECHAR sem reabrir'));
  const rls = await all(`select c.relname, c.relrowsecurity, (select count(*) from pg_policy pol
      where pol.polrelid=c.oid) pol from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname like 'performance_%'`);
  ok('12.10 RLS ligada em todas as tabelas de Performance',
    rls.length >= 8 && rls.every(x => x.relrowsecurity === true), rls.length + ' tabela(s)');
  ok('12.11 nenhuma policy: escrita so por RPC governada',
    rls.every(x => Number(x.pol) === 0));

  /* ---------- 13. Reabertura e refechamento nao destrutivos ---------- */
  h('13. REABRIR E REFECHAR PRESERVAM A VERSAO ANTERIOR');
  const recl = await all(`begin;
${IMPERSONA}
create temp table _v(fase text, payload jsonb) on commit drop;
do $x$
declare j jsonb; p uuid; s1 uuid; s2 uuid;
begin
  j := public.master_performance_criar_periodo(date '2026-06-01');
  p := (j->>'periodo_id')::uuid;
  j := public.master_performance_fechar_periodo(p, 'v1');
  s1 := (j->>'snapshot_id')::uuid;
  j := public.master_performance_reabrir_periodo(p, 'sonda de refechamento');
  j := public.master_performance_fechar_periodo(p, 'v2');
  s2 := (j->>'snapshot_id')::uuid;
  insert into _v select 'final', to_jsonb(x) from (
    select (select snapshot_versao from public.performance_snapshot where id=s1) v1,
      (select snapshot_versao from public.performance_snapshot where id=s2) v2,
      (s1 <> s2) snapshot_novo,
      (select count(*) from public.performance_snapshot where periodo_id=p) total,
      (select count(*) from public.performance_snapshot_resultado where snapshot_id=s1) res_v1,
      (select count(*) from public.performance_snapshot_resultado where snapshot_id=s2) res_v2,
      (select superseded_at is not null from public.performance_snapshot where id=s1) v1_superseded,
      (select supersession_motivo from public.performance_snapshot where id=s1) v1_motivo,
      (select current_snapshot_id = s2 from public.performance_periodo where id=p) aponta_v2,
      (select count(*) from public.performance_auditoria where periodo_id=p
         and evento='SNAPSHOT_SUPERSEDED') aud_superseded) x;
end $x$;
select * from _v;
rollback;`);
  const rc = (recl[0] || {}).payload || {};
  ok('13.1 o primeiro snapshot e a versao 1', Number(rc.v1) === 1);
  ok('13.2 o refechamento cria a versao 2', Number(rc.v2) === 2);
  ok('13.3 o refechamento gera um snapshot NOVO', rc.snapshot_novo === true);
  ok('13.4 as duas versoes coexistem', Number(rc.total) === 2, rc.total + '');
  ok('13.5 os resultados da versao 1 NAO foram apagados',
    Number(rc.res_v1) > 0 && Number(rc.res_v1) === Number(rc.res_v2), rc.res_v1 + ' x ' + rc.res_v2);
  ok('13.6 a versao 1 fica marcada como superada', rc.v1_superseded === true);
  ok('13.7 a superacao guarda o motivo explicito', !!rc.v1_motivo, rc.v1_motivo);
  ok('13.8 o periodo passa a apontar para a versao 2', rc.aponta_v2 === true);
  ok('13.9 a superacao gera evento de auditoria', Number(rc.aud_superseded) === 1);

  /* ---------- 14. H9 -- reabertura so do MASTER ---------- */
  h('14. H9 -- REABERTURA EXCLUSIVA DO MASTER');
  const reab = await one(`select pg_get_functiondef(p.oid) def from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname='master_performance_reabrir_periodo'`);
  ok('14.1 exige perfil MASTER', /=\s*'MASTER'/i.test(reab.def || ''));
  ok('14.2 exige motivo explicito', /Reabertura exige motivo explicito/i.test(reab.def || ''));
  ok('14.3 recusa negada e auditada', /REOPEN_DENIED/.test(reab.def || ''));
  ok('14.4 SECURITY DEFINER', /SECURITY DEFINER/i.test(reab.def || ''));
  ok('14.5 NAO apaga snapshot', !/delete\s+from\s+public\.performance_snapshot/i.test(reab.def || ''));
  ok('14.6 so o MASTER fecha', /=\s*'MASTER'/i.test(emp.def || ''));

  /* ---------- 15. Agregados de quadrimestre/YTD ainda nao existem ---------- */
  h('15. QUADRIMESTRE / YTD -- FORA DESTE FECHAMENTO');
  const agg = await one(`select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname ilike '%quadrimestre%' or p.proname ilike '%ytd%'
      or p.proname ilike '%acumulad%')`);
  ok('15.1 nenhuma RPC de quadrimestre/YTD implementada', Number(agg.n) === 0, agg.n + '');
  ok('15.2 o snapshot mensal preserva metricas brutas para agregar depois',
    ['retorno_novos', 'retorno_seminovos', 'und_financiado', 'und_spf']
      .every(c => idc.some(x => x.column_name === c)));

  /* ---------- 16. Estado oficial depois ---------- */
  h('16. ESTADO OFICIAL DEPOIS -- NADA FOI FECHADO');
  const fim = await one(ESTADO);
  ok('16.1 estado oficial identico ao inicial', JSON.stringify(fim) === CHAVE, JSON.stringify(fim));
  ok('16.2 ZERO periodos oficiais', Number(fim.periodos) === 0);
  ok('16.3 ZERO snapshots oficiais', Number(fim.snapshots) === 0);
  ok('16.4 ZERO resultados oficiais', Number(fim.resultados) === 0);
  ok('16.5 ZERO detalhes oficiais', Number(fim.detalhes) === 0);
  ok('16.6 auditoria do incidente segue com 40 linhas', Number(fim.auditoria) === 40, fim.auditoria + '');
  const md5f = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') sal,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='resolve_store_temporal') res`);
  ok('16.7 funcao de Salario intacta ao fim', md5f.sal === SALARY_MD5);
  ok('16.8 resolvedor compartilhado intacto ao fim', md5f.res === RESOLVE_STORE_MD5);
  const resp = await one(`select count(*) filter (where status='ACTIVE') ativo,
    count(*) filter (where status='SUPERSEDED') sup from public.analista_responsavel_loja`);
  ok('16.9 responsabilidade inalterada (23 ACTIVE / 4 SUPERSEDED)',
    Number(resp.ativo) === 23 && Number(resp.sup) === 4, resp.ativo + '/' + resp.sup);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

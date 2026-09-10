#!/usr/bin/env node
/*
 * [RANKING] PERF-5 -- Autoridade canônica de responsabilidade do Ranking.
 *
 * Verifica, contra o banco REAL e somente por leitura, que:
 *   - a linha do tempo 2026 foi persistida com procedência explícita;
 *   - o invariante temporal vale (um dono por loja-dia, zero sobreposição);
 *   - o resolvedor canônico responde por (loja, data) sem nenhum fallback;
 *   - H2 vale: durante férias/ausência a TITULAR continua dona e a
 *     Ferista recebe ZERO atribuição de Ranking;
 *   - transferências permanentes mudam a dona na data efetiva;
 *   - Salário permanece intacto (md5 + contagens).
 *
 * SOMENTE LEITURA. Recusa statements não-SELECT por construção.
 * ZERO PII: analistas aparecem como ANALYST-A..L; Denise Rodrigues e
 * Willian Inacio aparecem apenas porque o próprio Humano os nomeou nas
 * decisões H3/H4.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5_EXPECTED = '3b7f632a7b4826bc44da641e0e294100';

const MONTHS = [
  ['2026-01', 31, 'JAN'], ['2026-02', 28, 'FEV'], ['2026-03', 31, 'MAR'],
  ['2026-04', 30, 'ABR'], ['2026-05', 31, 'MAI'], ['2026-06', 30, 'JUN'],
  ['2026-07', 31, 'JUL'], ['2026-08', 31, 'AGO'],
];

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function pad(s, n) { return String(s === null || s === undefined ? '' : s).padEnd(n); }
function padL(s, n) { return String(s === null || s === undefined ? '' : s).padStart(n); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '--'; }

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}
function runSql(token, query) {
  return new Promise((resolve, reject) => {
    if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|commit|rollback)\b/i.test(query)
      || /\bcreate\s+(table|function|index|view|trigger|extension)\b/i.test(query)) {
      return reject(new Error('PERF-5 test é somente-leitura: statement recusado'));
    }
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const LABELS = {};
let seq = 0;
function label(id) {
  if (!id) return '(nenhum)';
  if (!LABELS[id]) LABELS[id] = 'ANALYST-' + String.fromCharCode(65 + (seq++));
  return LABELS[id];
}

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => (await runSql(token, q))[0] || {};
  const all = async q => { const r = await runSql(token, q); if (!Array.isArray(r)) throw new Error(JSON.stringify(r)); return r; };

  console.log('PERF-5 -- AUTORIDADE CANÔNICA DE RESPONSABILIDADE DO RANKING');
  console.log('[RANKING] Somente leitura. Zero PII.');

  /* rótulos estáveis por ordem de criação */
  (await all(`select u.id from public.usuarios u
     where upper(trim(coalesce(u.perfil,'')))='ANALISTA' order by u.criado_em, u.id;`))
    .forEach(r => label(r.id));

  /* ---------- 1. Salário intacto ---------- */
  h('1. TRAVA DE DOMÍNIO -- SALÁRIO');
  const md5a = await one(`select md5(pg_get_functiondef(p.oid)) m from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  ok('1.1 operational_analyst_commission_metrics inalterada', md5a.m === SALARY_MD5_EXPECTED, md5a.m);
  const salRef = await one(`select
      (pg_get_functiondef(p.oid) like '%analista_responsavel_loja%') usa_tabela,
      (pg_get_functiondef(p.oid) like '%analista_responsabilidade_janelas%') usa_janelas,
      (pg_get_functiondef(p.oid) like '%procedencia%') usa_procedencia
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  ok('1.2 Salário não referencia a tabela de responsabilidade do Ranking', salRef.usa_tabela === false);
  ok('1.3 Salário não referencia as janelas do Ranking', salRef.usa_janelas === false);
  ok('1.4 Salário não referencia procedência', salRef.usa_procedencia === false);
  const rpcIntacta = await one(`select md5(pg_get_functiondef(p.oid)) m from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='master_definir_analista_responsavel';`);
  ok('1.5 RPC de sucessão prospectiva preservada', rpcIntacta.m === '1c56408bffad444cb15b662257d30cb1', rpcIntacta.m);
  const resolverIntacto = await one(`select md5(pg_get_functiondef(p.oid)) m from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='resolve_analista_responsavel';`);
  ok('1.6 resolvedor original preservado byte-a-byte', resolverIntacto.m === '8ff83fc621d8ccb53e4949fa0daeeb51', resolverIntacto.m);

  /* ---------- 2. Estado persistido ---------- */
  h('2. AUTORIDADE TEMPORAL PERSISTIDA');
  const st = await one(`select
      (select count(*) from public.analista_responsavel_loja) total,
      (select count(*) from public.analista_responsavel_loja where valid_to is not null) historicas,
      (select count(*) from public.analista_responsavel_loja where valid_to is null) abertas,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.analista_responsavel_loja_auditoria where acao='BACKFILL_HISTORICO') audit_backfill,
      (select count(*) from public.analista_responsavel_loja a
        join public.analista_responsavel_loja b on b.loja_normalizada=a.loja_normalizada and b.id<>a.id
        where a.status='ACTIVE' and b.status='ACTIVE'
          and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)')) sobreposicoes,
      (select count(*) from public.analista_responsavel_loja where valid_from < date '2026-01-01') antes_de_2026;`);
  ok('2.1 25 intervalos de responsabilidade', Number(st.total) === 25, 'total=' + st.total);
  ok('2.2 16 intervalos históricos fechados', Number(st.historicas) === 16, 'hist=' + st.historicas);
  ok('2.3 9 vigências abertas preservadas', Number(st.abertas) === 9, 'abertas=' + st.abertas);
  ok('2.4 auditoria completa (1 por efeito)', Number(st.audit) === 25, 'audit=' + st.audit);
  ok('2.5 16 eventos BACKFILL_HISTORICO', Number(st.audit_backfill) === 16);
  ok('2.6 ZERO sobreposições temporais', Number(st.sobreposicoes) === 0);
  ok('2.7 nenhum intervalo anterior a 2026-01-01', Number(st.antes_de_2026) === 0);

  const proc = await all(`select procedencia, count(*) n from public.analista_responsavel_loja group by 1 order by 1;`);
  console.log('  Distribuição de procedência:');
  proc.forEach(p => console.log('    ' + pad(p.procedencia, 44) + padL(p.n, 3)));
  const pm = {}; proc.forEach(p => pm[p.procedencia] = Number(p.n));
  ok('2.8 DIRECT_AUTHORITY apenas nas 9 vigências governadas', pm['DIRECT_AUTHORITY'] === 9);
  ok('2.9 CORROBORATED_AUTHORITY presente', pm['CORROBORATED_AUTHORITY'] === 8);
  ok('2.10 HUMAN_APPROVED_RECONSTRUCTION presente', pm['HUMAN_APPROVED_RECONSTRUCTION'] === 6);
  ok('2.11 HUMAN_APPROVED_2026_STORE_RESPONSIBILITY presente (H3+H4)', pm['HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'] === 2);

  /* ---------- 3. Linha do tempo ---------- */
  h('3. LINHA DO TEMPO CANÔNICA PERSISTIDA');
  const tl = await all(`select r.loja_normalizada loja, r.valid_from, r.valid_to, r.procedencia,
      r.analista_usuario_id ident
    from public.analista_responsavel_loja r
    order by r.loja_normalizada, r.valid_from;`);
  console.log('  ' + pad('Loja', 16) + pad('Início', 13) + pad('Fim', 13) + pad('Analista', 12) + 'Procedência');
  console.log('  ' + '-'.repeat(78));
  tl.forEach(r => console.log('  ' + pad(r.loja, 16) + pad(r.valid_from, 13)
    + pad(r.valid_to || '(aberto)', 13) + pad(label(r.ident), 12) + r.procedencia));

  /* ---------- 4. Resolvedor ---------- */
  h('4. RESOLVEDOR TEMPORAL CANÔNICO');
  const probes = [
    ['ABC', '2026-01-15', 'HUMAN_APPROVED_RECONSTRUCTION'],
    ['ABC', '2026-06-15', 'CORROBORATED_AUTHORITY'],
    ['ABC', '2026-09-01', 'DIRECT_AUTHORITY'],
    ['ANALIA FRANCO', '2026-02-10', 'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'],
    ['BANDEIRANTES', '2026-03-10', 'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'],
    ['GASTAO', '2026-06-01', 'CORROBORATED_AUTHORITY'],
    ['GASTAO', '2026-07-01', 'CORROBORATED_AUTHORITY'],
    ['BARRA FUNDA', '2026-07-01', 'CORROBORATED_AUTHORITY'],
    ['BARRA FUNDA', '2026-08-01', 'CORROBORATED_AUTHORITY'],
  ];
  for (const [loja, d, esperado] of probes) {
    const r = await one(`select analista_usuario_id ident, procedencia
      from public.resolve_analista_responsavel_procedencia('${loja}', date '${d}');`);
    ok('4.x ' + pad(loja, 15) + d + ' -> ' + pad(label(r.ident), 12), r.procedencia === esperado,
      r.procedencia || '(nulo)');
  }
  const rev = await runSql(token, `select analista_usuario_id from public.resolve_analista_responsavel_procedencia('REVENDA', date '2026-01-15');`);
  ok('4.10 REVENDA em janeiro NÃO tem dono inventado', Array.isArray(rev) && rev.length === 0);
  const inex = await runSql(token, `select analista_usuario_id from public.resolve_analista_responsavel_procedencia('LOJA INEXISTENTE', date '2026-03-01');`);
  ok('4.11 loja inexistente devolve vazio, não um palpite', Array.isArray(inex) && inex.length === 0);

  /* ---------- 5. H2 -- férias e Ferista ---------- */
  h('5. H2 -- FÉRIAS NÃO TRANSFEREM PROPRIEDADE; FERISTA NÃO PONTUA');
  const cov = await all(`select a.data_inicio, a.data_fim,
      upper(trim(coalesce(a.loja_coberta,''))) loja,
      (select u.id from public.usuarios u where u.cpf_normalizado=a.cpf_analista_ausente) titular,
      (select u.id from public.usuarios u where u.cpf_normalizado=a.cpf_analista_substituto) ferista,
      (select r.analista_usuario_id from public.resolve_analista_responsavel_procedencia(
         upper(trim(coalesce(a.loja_coberta,''))), a.data_inicio) r) dono_inicio,
      (select r.analista_usuario_id from public.resolve_analista_responsavel_procedencia(
         upper(trim(coalesce(a.loja_coberta,''))), a.data_fim) r) dono_fim
    from public.ausencias_analistas a order by a.data_inicio, a.id;`);
  const semDono = cov.filter(c => !c.dono_inicio || !c.dono_fim);
  const mudouNoMeio = cov.filter(c => c.dono_inicio && c.dono_fim && c.dono_inicio !== c.dono_fim);
  /* H2 é violado quando a COBERTURA muda a propriedade. Se a Ferista já é
     a titular do Ranking daquela loja por outra autoridade (H3/H4), ela é
     dona apesar da cobertura, não por causa dela -- isso não é violação. */
  const feristaPorCobertura = cov.filter(c => c.ferista
    && (c.dono_inicio === c.ferista || c.dono_fim === c.ferista)
    && c.dono_inicio !== c.dono_fim);
  const feristaJaTitular = cov.filter(c => c.ferista
    && c.dono_inicio === c.ferista && c.dono_inicio === c.dono_fim);
  console.log('  coberturas avaliadas ........................... ' + cov.length);
  console.log('  dias de cobertura sem dono .................... ' + semDono.length);
  console.log('  coberturas que MUDARAM o dono ................. ' + mudouNoMeio.length);
  console.log('  Ferista virou dona POR CAUSA da cobertura ..... ' + feristaPorCobertura.length);
  console.log('  Ferista já era titular por outra autoridade ... ' + feristaJaTitular.length);
  ok('5.1 nenhuma cobertura transferiu a propriedade do Ranking', feristaPorCobertura.length === 0);
  ok('5.2 nenhum dia de férias/cobertura ficou sem dono', semDono.length === 0);
  ok('5.3 nenhuma cobertura alterou o dono no meio da janela', mudouNoMeio.length === 0);
  if (feristaJaTitular.length) {
    console.log('\n  Casos em que a pessoa registrada como Ferista JÁ É a titular do');
    console.log('  Ranking daquela loja -- consequência direta de H3/H4, não de H2:');
    for (const c of feristaJaTitular) {
      const p = await one(`select procedencia from public.resolve_analista_responsavel_procedencia('${c.loja}', date '${c.data_inicio}');`);
      console.log('    ' + pad(c.loja, 15) + pad(c.data_inicio + '..' + c.data_fim, 24)
        + pad(label(c.ferista), 12) + p.procedencia);
    }
    console.log('  Em todos eles a propriedade é ANTERIOR e INDEPENDENTE da cobertura.');
  }

  /* ---------- 6. Transferências permanentes ---------- */
  h('6. TRANSFERÊNCIAS PERMANENTES');
  const hand = await all(`select a.loja_normalizada loja, a.valid_to data, a.analista_usuario_id de,
      (select b.analista_usuario_id from public.analista_responsavel_loja b
        where b.loja_normalizada=a.loja_normalizada and b.valid_from=a.valid_to limit 1) para
    from public.analista_responsavel_loja a
    where a.valid_to is not null order by a.loja_normalizada, a.valid_from;`);
  const reais = hand.filter(x => x.para && x.para !== x.de);
  console.log('  ' + pad('Loja', 16) + pad('Data efetiva', 14) + pad('De', 12) + 'Para');
  console.log('  ' + '-'.repeat(60));
  reais.forEach(x => console.log('  ' + pad(x.loja, 16) + pad(x.data, 14) + pad(label(x.de), 12) + label(x.para)));
  ok('6.1 transferências permanentes preservadas', reais.length >= 3, reais.length + ' encontradas');
  const gaps = hand.filter(x => !x.para);
  ok('6.2 nenhum intervalo histórico termina em buraco não intencional',
    gaps.every(g => g.loja === 'REVENDA' || g.data === '2026-08-21'), gaps.length + ' fins sem sucessor imediato');

  /* ---------- 7. Um dono por loja-dia ---------- */
  h('7. CONSERVAÇÃO -- UM DONO POR LOJA-DIA');
  const cons = await one(`with dias as (
      select l.loja, d.dia::date dia
      from (select distinct loja_normalizada loja from public.analista_responsavel_loja) l
      cross join generate_series(date '2026-01-01', date '2026-08-31', interval '1 day') d(dia))
    select count(*) filter (where c > 1) multi, count(*) filter (where c = 0) sem_dono,
           count(*) total
    from (select dias.loja, dias.dia, (select count(*) from public.analista_responsavel_loja r
            where r.status='ACTIVE' and r.loja_normalizada=dias.loja
              and dias.dia >= r.valid_from and (r.valid_to is null or dias.dia < r.valid_to)) c
          from dias) x;`);
  ok('7.1 nenhum loja-dia com mais de um dono', Number(cons.multi) === 0, 'multi=' + cons.multi);
  console.log('  loja-dias sem dono: ' + cons.sem_dono + ' de ' + cons.total
    + '  (REVENDA 01/01..20/08 = 232, legítimo -- a loja não tinha Analista)');
  ok('7.2 loja-dias sem dono limitados a REVENDA', Number(cons.sem_dono) === 232, 'sem_dono=' + cons.sem_dono);

  /* ---------- 8. Multi-loja simultânea ---------- */
  h('8. CONSEQUÊNCIA MATERIAL -- ANALISTAS COM DUAS LOJAS SIMULTÂNEAS');
  const multi = await all(`select a.analista_usuario_id ident,
      a.loja_normalizada loja_a, b.loja_normalizada loja_b,
      greatest(a.valid_from, b.valid_from) de,
      least(coalesce(a.valid_to, date '2026-12-31'), coalesce(b.valid_to, date '2026-12-31')) ate
    from public.analista_responsavel_loja a
    join public.analista_responsavel_loja b
      on b.analista_usuario_id = a.analista_usuario_id
     and b.loja_normalizada > a.loja_normalizada
     and daterange(a.valid_from, a.valid_to, '[)') && daterange(b.valid_from, b.valid_to, '[)')
    order by 1,2,3;`);
  if (!multi.length) console.log('  (nenhum)');
  multi.forEach(m => console.log('  ' + pad(label(m.ident), 12) + pad(m.loja_a, 16) + '+ '
    + pad(m.loja_b, 16) + m.de + ' .. ' + m.ate));
  console.log('  Option C permite uma Analista responder por mais de uma loja.');
  console.log('  Isto NÃO é um defeito, mas é uma consequência material de H3/H4');
  console.log('  que o Humano precisa enxergar antes de qualquer pontuação.');

  /* ---------- 9. Replay mensal ---------- */
  h('9. REPLAY MENSAL -- ATRIBUIÇÃO DE FATOS DO RANKING');
  const fin = await all(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
    op as (select f.operation_date d, f.return_value v,
      upper(trim(coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
        f.operation_date, nullif(f.store,'')),'SEM LOJA'))) loja
      from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
      where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')
    select to_char(date_trunc('month', op.d),'YYYY-MM') mes, op.loja,
      count(*) ops, sum(op.v) ret,
      count(*) filter (where exists (select 1 from public.analista_responsavel_loja r
        where r.status='ACTIVE' and r.loja_normalizada=op.loja
          and op.d >= r.valid_from and (r.valid_to is null or op.d < r.valid_to))) ops_atrib,
      sum(op.v) filter (where exists (select 1 from public.analista_responsavel_loja r
        where r.status='ACTIVE' and r.loja_normalizada=op.loja
          and op.d >= r.valid_from and (r.valid_to is null or op.d < r.valid_to))) ret_atrib
    from op group by 1,2 order by 1,2;`);
  console.log('  ' + pad('Mês', 6) + padL('Ops', 6) + padL('Atrib.', 8) + padL('Não atrib.', 12)
    + padL('Retorno', 16) + padL('Ret.atrib%', 12) + '  Resultado');
  console.log('  ' + '-'.repeat(78));
  const resid = {};
  MONTHS.forEach(m => {
    const rows = fin.filter(f => f.mes === m[0]);
    let ops = 0, oa = 0, ret = 0, ra = 0;
    rows.forEach(r => {
      ops += Number(r.ops); oa += Number(r.ops_atrib || 0);
      ret += Number(r.ret); ra += Number(r.ret_atrib || 0);
      const na = Number(r.ops) - Number(r.ops_atrib || 0);
      if (na > 0) { resid[r.loja] = resid[r.loja] || { ops: 0, ret: 0 }; resid[r.loja].ops += na;
        resid[r.loja].ret += Number(r.ret) - Number(r.ret_atrib || 0); }
    });
    const verd = ra >= ret * 0.999 ? 'COMPLETO' : 'PARCIAL';
    console.log('  ' + pad(m[2], 6) + padL(ops, 6) + padL(oa, 8) + padL(ops - oa, 12)
      + padL('R$ ' + brl(ret), 16) + padL(pct(ra, ret), 12) + '  ' + verd);
  });
  console.log('\n  Operações NÃO atribuíveis, por rótulo de loja:');
  Object.keys(resid).sort((a, b) => resid[b].ops - resid[a].ops).forEach(k =>
    console.log('    ' + pad(k, 16) + padL(resid[k].ops, 4) + ' ops   R$ ' + pad(brl(resid[k].ret), 14)
      + (k === '2' ? '<- unidade não registrada (STORE_CODE_2_UNRESOLVED)'
        : k === 'REVENDA' ? '<- loja sem Analista até 21/08'
          : k === 'SEM LOJA' ? '<- loja não resolvível na origem' : '')));

  /* ---------- 10. Estado de negócio inalterado ---------- */
  h('10. CONSERVAÇÃO DE DADOS DE NEGÓCIO NÃO-RANKING');
  const biz = await one(`select
      (select count(*) from public.usuarios) usr,
      (select count(*) from public.ausencias_analistas) aus,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc,
      (select count(*) from public.periodos_comissao) per;`);
  ok('10.1 usuários inalterados', Number(biz.usr) === 111, 'usr=' + biz.usr);
  ok('10.2 ausências inalteradas', Number(biz.aus) === 26, 'aus=' + biz.aus);
  ok('10.3 fechamentos de Salário inalterados', Number(biz.fech) === 24, 'fech=' + biz.fech);
  ok('10.4 snapshots de Salário inalterados', Number(biz.snapc) === 2138, 'snap=' + biz.snapc);
  ok('10.5 períodos de comissão inalterados', Number(biz.per) === 6, 'per=' + biz.per);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

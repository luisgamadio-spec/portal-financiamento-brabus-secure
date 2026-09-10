#!/usr/bin/env node
/*
 * [RANKING] PERF-RETIRE-1 -- o Ranking de Performance de Analistas foi
 * aposentado por decisao do Humano.
 *
 *   "Nao vamos fazer mais nada... Pode eliminar isso do nosso portal,
 *    sem mexer em mais nada."
 *
 * Esta suite prova as duas metades dessa frase:
 *   1. o Ranking nao existe mais -- nem no banco, nem na fonte, nem no
 *      Portal (rota, navegacao, modulo, permissao, loader);
 *   2. nada mais foi mexido -- Salario, responsabilidade de RH, IA,
 *      Score F&I, demais modulos e dados brutos seguem intactos.
 *
 * Somente leitura. ZERO PII.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const RAIZ = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure');
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }

function readToken() {
  const p = path.join(RAIZ, 'supabase', '.env.local');
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
/* varredura de fonte, ignorando historia (migracoes) e esta propria suite */
function varrer(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'migrations') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varrer(p, out);
    else if (/\.(html|js|css|json)$/i.test(e.name)) out.push(p);
  }
  return out;
}

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _e: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-RETIRE-1 -- RANKING DE PERFORMANCE DE ANALISTAS APOSENTADO');

  /* ---------- 1. Runtime de banco do Ranking ---------- */
  h('1. O RANKING NAO EXISTE MAIS NO BANCO');
  const tab = await all(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname like 'performance_%' order by 1`);
  ok('1.1 ZERO tabelas performance_*', tab.length === 0, tab.map(x => x.relname).join(',') || 'nenhuma');
  const fn = await all(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (p.proname like 'performance_%' or p.proname like 'master_performance_%')
    order by 1`);
  ok('1.2 ZERO funcoes/RPCs performance_*', fn.length === 0, fn.map(x => x.proname).join(',') || 'nenhuma');
  const bf = await one(`select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='master_backfill_analista_responsavel_historico'`);
  ok('1.3 o backfill historico do Ranking foi removido', Number(bf.n) === 0);
  const trg = await all(`select t.tgname from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal
      and t.tgname like '%performance%' order by 1`);
  ok('1.4 ZERO gatilhos do Ranking', trg.length === 0, trg.map(x => x.tgname).join(',') || 'nenhum');
  const orfaos = await one(`select count(*) n from pg_constraint c
    where c.contype='f' and (c.conrelid::regclass::text like 'performance_%'
      or c.confrelid::regclass::text like 'performance_%')`);
  ok('1.5 ZERO chaves estrangeiras orfas do Ranking', Number(orfaos.n) === 0);

  /* ---------- 2. Nenhum fechamento oficial jamais ocorreu ---------- */
  h('2. NENHUM FECHAMENTO HISTORICO OFICIAL FOI EXECUTADO');
  const hist = await one(`select count(*) n from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('performance_periodo','performance_snapshot',
      'performance_snapshot_resultado','performance_snapshot_detalhe')`);
  ok('2.1 as tabelas de periodo/snapshot nao existem -- nada foi congelado',
    Number(hist.n) === 0, hist.n + '');
  const migRet = path.join(RAIZ, 'supabase', 'migrations',
    '20260910230000_retire_analyst_performance_ranking.sql');
  ok('2.2 a migracao de aposentadoria esta versionada', fs.existsSync(migRet));
  /* comentarios fora: a migracao EXPLICA por que evita CASCADE, e a palavra
   * aparece nessa explicacao. O que importa e o SQL executavel. */
  const mr = (fs.existsSync(migRet) ? fs.readFileSync(migRet, 'utf-8') : '')
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  ok('2.3 o SQL executavel da aposentadoria nao usa CASCADE', !/\bcascade\b/i.test(mr));
  ok('2.4 a aposentadoria nao remove a autoridade de RH',
    !/drop\s+table[^;]*analista_responsavel_loja/i.test(mr));
  ok('2.5 a aposentadoria nao toca dados brutos nem usuarios',
    !/(drop|alter|delete\s+from|update)\s+(table\s+)?(public\.)?(usuarios|portal_sales|portal_finance_operations)\b/i.test(mr));

  /* ---------- 3. Migracoes antigas preservadas ---------- */
  h('3. A HISTORIA DE MIGRACOES FOI PRESERVADA');
  const migs = fs.readdirSync(path.join(RAIZ, 'supabase', 'migrations'));
  const perfMigs = migs.filter(m => /perf\d|perf5|ranking/i.test(m) && !/retire/i.test(m));
  ok('3.1 as migracoes aplicadas do Ranking continuam no repositorio',
    perfMigs.length >= 6, perfMigs.length + ' arquivo(s)');
  ok('3.2 a aposentadoria e aditiva, nao um apagamento de historia',
    migs.some(m => /retire_analyst_performance_ranking/.test(m)));

  /* ---------- 4. Superficie de produto ---------- */
  h('4. O RANKING NAO APARECE NO PORTAL');
  const mods = await all(`select id, nome from public.modulos_portal order by 1`);
  ok('4.1 nenhum modulo do Portal e o Ranking de Analistas',
    !mods.some(m => /performance.*analista|ranking.*analista|analyst.*ranking/i.test(m.id + ' ' + m.nome)),
    mods.length + ' modulo(s)');
  ok('4.2 Score F&I (Analise de Score) continua cadastrado -- NAO e este Ranking',
    mods.some(m => m.id === 'analiseScoreVendedores'));
  ok('4.3 Acompanhamento de Salario continua cadastrado',
    mods.some(m => m.id === 'comissoes'));

  const arquivos = varrer(RAIZ, []).filter(p => !/[\\/]tests[\\/]ranking_retired_test\.js$/.test(p));
  const RPC_RANKING = /performance_periodo|performance_snapshot|performance_regra_versao|performance_auditoria|performance_calcular_periodo|performance_ranking_periodo|performance_normalizar_loja|performance_loja_fora_de_escopo|performance_loja_codigo_map|performance_loja_por_venda_do_chassi|master_performance_/;
  const comRpc = arquivos.filter(p => RPC_RANKING.test(fs.readFileSync(p, 'utf-8')));
  ok('4.4 nenhum arquivo de fonte invoca RPC/tabela do Ranking',
    comRpc.length === 0, comRpc.map(p => path.relative(RAIZ, p)).join(', ') || 'nenhum');

  const loader = arquivos.filter(p => /performance-scoring/.test(fs.readFileSync(p, 'utf-8')));
  ok('4.5 nenhum loader referencia o nucleo de pontuacao do Ranking',
    loader.length === 0, loader.map(p => path.relative(RAIZ, p)).join(', ') || 'nenhum');
  ok('4.6 o nucleo de pontuacao do Ranking foi removido da fonte',
    !fs.existsSync(path.join(RAIZ, 'assets', 'js', 'performance-scoring.js')));

  const testes = fs.readdirSync(path.join(RAIZ, 'tests'));
  ok('4.7 nenhuma suite PERF-* do Ranking permanece',
    !testes.some(t => /^perf\d/i.test(t)), testes.filter(t => /^perf\d/i.test(t)).join(',') || 'nenhuma');
  ok('4.8 a guarda de fronteira Ranking x Salario permanece',
    testes.includes('ranking_salary_domain_boundary_test.js'));

  /* ---------- 5. Salario intacto ---------- */
  h('5. [SALARIOS] INTACTO');
  const sal = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') met,
    (select length(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') bytes,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='resolve_store_temporal') res,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'operational_%') fns`);
  ok('5.1 operational_analyst_commission_metrics intacta', sal.met === SALARY_MD5, sal.met);
  ok('5.2 tamanho preservado (16301 bytes)', Number(sal.bytes) === 16301, sal.bytes + '');
  ok('5.3 resolve_store_temporal intacta', sal.res === RESOLVE_STORE_MD5, sal.res);
  ok('5.4 as 23 funcoes operational_* continuam presentes', Number(sal.fns) === 23, sal.fns + '');
  const salFn = await all(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('operational_own_commission_summary',
      'operational_scope_commission_rows','operational_commission_metrics',
      'operational_commission_faixa_rows','operational_salary_details') order by 1`);
  ok('5.5 as funcoes de comissao aprovadas pelo Humano seguem vivas',
    salFn.length === 5, salFn.length + '/5');
  /* A UI de Salario vive no repositorio V2 (portal-next-v2-rh4a), nunca no
   * Secure. O que o Secure guarda de Salario sao as migracoes e as funcoes
   * acima -- e nenhuma migracao de Salario pode ter sido removida. */
  const migsDir = fs.readdirSync(path.join(RAIZ, 'supabase', 'migrations'));
  const migsSal = migsDir.filter(m => /rh_analyst|rh5f|rh5c|rh5d|commission|comissao/i.test(m));
  ok('5.6 as migracoes de Salario continuam versionadas', migsSal.length >= 6, migsSal.length + ' arquivo(s)');
  ok('5.7 a restauracao de semantica de Salario (RH-ANALYST-4A) segue presente',
    migsDir.some(m => /rh_analyst4a_restore_salary_commission_semantics/.test(m)));

  /* ---------- 6. Responsabilidade de RH preservada ---------- */
  h('6. AUTORIDADE DE RESPONSABILIDADE DE RH PRESERVADA');
  const resp = await one(`select
    (select count(*) from public.analista_responsavel_loja) linhas,
    (select count(*) from public.analista_responsavel_loja where status='ACTIVE') ativas,
    (select count(*) from public.analista_responsavel_loja_auditoria) audit,
    (select count(*) from information_schema.columns where table_schema='public'
      and table_name='analista_responsavel_loja' and column_name='procedencia') proc,
    (select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid
      where t.relname='analista_responsavel_loja' and c.contype='x') exc,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('resolve_analista_responsavel',
        'resolve_analista_responsavel_procedencia','master_definir_analista_responsavel',
        'analista_responsabilidade_janelas','analista_responsabilidade_cobertura')) fns`);
  ok('6.1 a tabela de responsabilidade sobreviveu com todas as linhas',
    Number(resp.linhas) === 27, resp.linhas + '');
  ok('6.2 as 23 vigencias ACTIVE seguem intactas', Number(resp.ativas) === 23, resp.ativas + '');
  ok('6.3 a auditoria de responsabilidade sobreviveu', Number(resp.audit) === 31, resp.audit + '');
  ok('6.4 a coluna procedencia foi preservada (consumida pelo RH-ANALYST-3)',
    Number(resp.proc) === 1);
  ok('6.5 a restricao EXCLUDE de nao sobreposicao continua no banco', Number(resp.exc) === 1);
  ok('6.6 as 5 funcoes de responsabilidade do RH seguem vivas', Number(resp.fns) === 5, resp.fns + '/5');

  /* ---------- 7. IA, Score e demais dominios ---------- */
  h('7. IA, SCORE F&I E DEMAIS MODULOS INTACTOS');
  const outros = await one(`select
    (select count(*) from public.modulos_portal) modulos,
    (select count(*) from public.modulos_portal where ativo) ativos,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_score_coparticipated_data') score,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_fandi_dashboard') fandi`);
  ok('7.1 os 12 modulos do Portal continuam cadastrados', Number(outros.modulos) === 12, outros.modulos + '');
  ok('7.2 todos seguem ativos', Number(outros.ativos) === 12, outros.ativos + '');
  ok('7.3 a autoridade do Score F&I / Coparticipado sobreviveu', Number(outros.score) === 1);
  ok('7.4 o dashboard F&I sobreviveu', Number(outros.fandi) === 1);
  ['modules/score.html', 'modules/coparticipado.html', 'index.html']
    .forEach((f, i) => ok('7.' + (5 + i) + ' ' + f + ' continua no repositorio',
      fs.existsSync(path.join(RAIZ, f))));
  const ia = ['supabase/functions/portal-ai', 'assets/js/portal-ai-ui.js']
    .filter(f => fs.existsSync(path.join(RAIZ, f)));
  ok('7.8 a fonte da Brabus Intelligence continua intacta', ia.length === 2, ia.length + '/2');

  /* ---------- 8. Dados brutos e usuarios ---------- */
  h('8. DADOS BRUTOS E USUARIOS INTOCADOS');
  const raw = await one(`select
    (select count(*) from public.portal_sales) vendas,
    (select count(*) from public.portal_finance_operations) fin,
    (select count(*) from public.usuarios) usuarios,
    (select count(*) from public.usuarios
      where upper(trim(coalesce(perfil,'')))='ANALISTA') analistas,
    (select count(*) from public.usuarios where ativo
      and upper(trim(coalesce(perfil,'')))='ANALISTA') analistas_ativos`);
  ok('8.1 portal_sales intacta (34625)', Number(raw.vendas) === 34625, raw.vendas + '');
  ok('8.2 portal_finance_operations intacta (42318)', Number(raw.fin) === 42318, raw.fin + '');
  ok('8.3 nenhum usuario removido (112)', Number(raw.usuarios) === 112, raw.usuarios + '');
  ok('8.4 a populacao de ANALISTAS segue com 12 cadastros', Number(raw.analistas) === 12, raw.analistas + '');
  ok('8.5 os 10 analistas ATIVOS seguem ativos', Number(raw.analistas_ativos) === 10, raw.analistas_ativos + '');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

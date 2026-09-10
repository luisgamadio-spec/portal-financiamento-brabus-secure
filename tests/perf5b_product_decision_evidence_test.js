#!/usr/bin/env node
/*
 * [RANKING] PERF-5B -- Evidencia das decisoes de produto G4, G6 e G15.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * O relatorio do PERF-4A registrou que o resolvedor "estritamente
 * limitado por data" deixaria ~13 operacoes e ~R$ 33.874,45 sem
 * classificacao. Esse numero media outra coisa: media "a venda CANONICA
 * (a mais recente do chassi) e posterior ao financiamento", e nao "nao
 * existe nenhuma venda anterior ao financiamento". Recalculado contra o
 * dado canonico atual, TODAS as 1.295 operacoes tem venda anterior, e a
 * disputa real entre os dois resolvedores e de apenas 3 operacoes.
 *
 * Sem este registro, uma Wave futura releria o PERF-4A e reconstruiria um
 * dilema que nao existe. As assercoes abaixo travam a correcao.
 *
 * SOMENTE LEITURA. Recusa statements nao-SELECT por construcao.
 * ZERO PII. Nao pontua, nao cria periodo, nao escreve nada.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5_EXPECTED = '3b7f632a7b4826bc44da641e0e294100';

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function pad(s, n) { return String(s === null || s === undefined ? '' : s).padEnd(n); }
function padL(s, n) { return String(s === null || s === undefined ? '' : s).padStart(n); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

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
      return reject(new Error('PERF-5B e somente-leitura: statement recusado'));
    }
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const LVB = `
lvb as (
  select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
  where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
sales_all as (
  select s.id, s.chassis, s.sale_date, s.department from public.portal_sales s
  join lvb on lvb.id=s.batch_id and lvb.source_type in ('SALES_CURRENT','SALES_HISTORY')
  where coalesce(s.chassis,'')<>''),
fin as (
  select f.id, f.chassis, f.operation_date d, f.return_value v,
    upper(trim(coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
      f.operation_date, nullif(f.store,'')),'SEM LOJA'))) loja
  from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
   and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
  where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => (await runSql(token, q))[0] || {};
  const all = async q => { const r = await runSql(token, q); if (!Array.isArray(r)) throw new Error(JSON.stringify(r)); return r; };

  console.log('PERF-5B -- EVIDENCIA DAS DECISOES DE PRODUTO (G4 / G6 / G15)');
  console.log('[RANKING] Somente leitura. Nenhuma decisao de produto foi implementada.');

  /* ---------- 1. Salario ---------- */
  h('1. TRAVA DE DOMINIO -- SALARIO');
  const md5 = await one(`select md5(pg_get_functiondef(p.oid)) m, length(pg_get_functiondef(p.oid)) b
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  ok('1.1 funcao canonica de comissao inalterada', md5.m === SALARY_MD5_EXPECTED, md5.m);
  ok('1.2 tamanho inalterado', Number(md5.b) === 16301, md5.b + ' bytes');

  /* ---------- 2. G4 ---------- */
  h('2. G4 -- O DILEMA MEDIDO CORRETAMENTE');
  const g4 = await one(`with ${LVB},
    res as (select fin.*,
      (select sa.department from sales_all sa where sa.chassis=fin.chassis
         and sa.sale_date <= fin.d order by sa.sale_date desc, sa.id desc limit 1) dept_a,
      (select sa.department from sales_all sa where sa.chassis=fin.chassis
         order by sa.sale_date desc, sa.id desc limit 1) dept_b
      from fin)
    select count(*) ops,
      count(*) filter (where dept_a is null) sem_venda_anterior,
      count(*) filter (where dept_b is null) sem_venda_alguma,
      count(*) filter (where dept_a is distinct from dept_b) divergentes,
      round(coalesce(sum(v) filter (where dept_a is distinct from dept_b),0),2) retorno_divergente
    from res;`);
  console.log('  operacoes elegiveis jan-ago ................. ' + g4.ops);
  console.log('  sem NENHUMA venda anterior ao financiamento . ' + g4.sem_venda_anterior);
  console.log('  sem venda alguma ........................... ' + g4.sem_venda_alguma);
  console.log('  divergentes entre G4-A e G4-B .............. ' + g4.divergentes
    + '   R$ ' + brl(g4.retorno_divergente));
  ok('2.1 G4-A (data-limitada) NAO deixa operacao sem classificacao',
    Number(g4.sem_venda_anterior) === 0, 'sem_venda_anterior=' + g4.sem_venda_anterior);
  ok('2.2 G4-A e G4-B tem cobertura identica: 100%',
    Number(g4.sem_venda_anterior) === Number(g4.sem_venda_alguma));
  ok('2.3 a disputa real e pequena e delimitada', Number(g4.divergentes) === 3,
    g4.divergentes + ' operacao(oes)');

  /* a antiga contagem de 13 do PERF-4A: reconciliada, nao ignorada */
  const g4v = await one(`with ${LVB},
    sc as (select distinct on (chassis) chassis, sale_date from sales_all order by chassis, sale_date desc, id desc)
    select count(*) venda_canonica_posterior,
      count(*) filter (where exists (select 1 from sales_all sa
        where sa.chassis=fin.chassis and sa.sale_date <= fin.d)) tem_venda_anterior
    from fin join sc on sc.chassis=fin.chassis where fin.d < sc.sale_date;`);
  console.log('  PERF-4A media "venda canonica posterior" ... ' + g4v.venda_canonica_posterior
    + ', das quais ' + g4v.tem_venda_anterior + ' TEM venda anterior');
  ok('2.4 as operacoes de "venda canonica posterior" tem, todas, venda anterior',
    Number(g4v.venda_canonica_posterior) === Number(g4v.tem_venda_anterior)
    && Number(g4v.venda_canonica_posterior) > 0);

  const casos = await all(`with ${LVB},
    res as (select fin.*,
      (select sa.department from sales_all sa where sa.chassis=fin.chassis
         and sa.sale_date <= fin.d order by sa.sale_date desc, sa.id desc limit 1) dept_a,
      (select sa.department from sales_all sa where sa.chassis=fin.chassis
         order by sa.sale_date desc, sa.id desc limit 1) dept_b
      from fin)
    select to_char(res.d,'YYYY-MM') mes, res.loja, round(res.v,2) retorno,
      res.dept_a, res.dept_b,
      (select max(sa.sale_date) from sales_all sa where sa.chassis=res.chassis) - res.d lag
    from res where res.dept_a is distinct from res.dept_b order by res.d;`);
  console.log('\n  ' + pad('Mes', 9) + pad('Loja', 16) + padL('Retorno', 12) + '  '
    + pad('G4-A', 11) + pad('G4-B', 11) + 'Revenda apos');
  console.log('  ' + '-'.repeat(70));
  casos.forEach(c => console.log('  ' + pad(c.mes, 9) + pad(c.loja, 16) + padL('R$ ' + brl(c.retorno), 12)
    + '  ' + pad(c.dept_a, 11) + pad(c.dept_b, 11) + c.lag + ' dias'));
  ok('2.5 todos os divergentes sao ciclo NOVO->USADO (A=NOVOS, B=SEMINOVOS)',
    casos.length > 0 && casos.every(c => c.dept_a === 'NOVOS' && c.dept_b === 'SEMINOVOS'));

  /* ---------- 3. G6 ---------- */
  h('3. G6 -- INICIO REAL DO PROGRAMA SPF');
  const g6 = await one(`select min(operation_date) primeira, count(*) total
    from public.portal_spf_operations
    where batch_id=(select b.id from public.portal_import_batches b where b.status='VALIDATED'
      and b.source_type='SPF_CURRENT' order by b.completed_at desc nulls last, b.created_at desc, b.id desc limit 1)
      and is_spf_extra and operation_date between date '2026-01-01' and date '2026-08-31';`);
  console.log('  primeira unidade SPF Extra de 2026 .... ' + g6.primeira);
  console.log('  total de unidades jan-ago ............. ' + g6.total);
  ok('3.1 SPF Extra comeca em 2026-05-21, nao "em maio" genericamente',
    g6.primeira === '2026-05-21', String(g6.primeira));
  const g6m = await all(`select to_char(date_trunc('month',operation_date),'YYYY-MM') mes,
      count(*) filter (where is_spf_extra) spf
    from public.portal_spf_operations
    where batch_id=(select b.id from public.portal_import_batches b where b.status='VALIDATED'
      and b.source_type='SPF_CURRENT' order by b.completed_at desc nulls last, b.created_at desc, b.id desc limit 1)
      and operation_date between date '2026-01-01' and date '2026-08-31' group by 1 order by 1;`);
  g6m.forEach(m => console.log('    ' + m.mes + '  ' + padL(m.spf, 4) + ' unidades'));
  ok('3.2 jan-abr tem ZERO unidades SPF Extra',
    g6m.filter(m => m.mes < '2026-05').every(m => Number(m.spf) === 0));
  ok('3.3 maio e um mes PARCIAL (programa comeca no dia 21)',
    Number(g6m.find(m => m.mes === '2026-05').spf) > 0
    && Number(g6m.find(m => m.mes === '2026-05').spf) < Number(g6m.find(m => m.mes === '2026-06').spf));

  /* ---------- 4. G15 ---------- */
  h('4. G15 -- ROTULO DE LOJA "2"');
  const g15 = await one(`with ${LVB}
    select count(*) filter (where loja='2') ops, count(distinct chassis) filter (where loja='2') und,
      round(coalesce(sum(v) filter (where loja='2'),0),2) retorno,
      min(d) filter (where loja='2') de, max(d) filter (where loja='2') ate from fin;`);
  const g15src = await one(`select
      (select count(*) from public.portal_sales where trim(coalesce(store,''))='2') vendas,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2') financiamentos,
      (select count(distinct seller_nbs) from public.portal_finance_operations where trim(coalesce(store,''))='2') vendedores,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2'
         and coalesce(seller_cpf_normalizado,'')<>'') com_cpf,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2'
         and seller_user_id is not null) com_usuario,
      (select count(distinct trim(store)) from public.portal_sales where store ~ '^[0-9]+$') rotulos_numericos;`);
  console.log('  operacoes de Ranking ......... ' + g15.ops + '   R$ ' + brl(g15.retorno));
  console.log('  janela ....................... ' + g15.de + ' .. ' + g15.ate);
  console.log('  linhas na origem ............. ' + g15src.vendas + ' vendas + '
    + g15src.financiamentos + ' financiamentos');
  console.log('  vendedores distintos ......... ' + g15src.vendedores
    + '  (com CPF: ' + g15src.com_cpf + ', com usuario: ' + g15src.com_usuario + ')');
  ok('4.1 "2" aparece nas DUAS bases -- defeito de origem, nao de join',
    Number(g15src.vendas) > 0 && Number(g15src.financiamentos) > 0);
  ok('4.2 nenhum vendedor de "2" tem CPF ou usuario do portal',
    Number(g15src.com_cpf) === 0 && Number(g15src.com_usuario) === 0);
  ok('4.3 "2" e o unico rotulo numerico do sistema', Number(g15src.rotulos_numericos) === 1,
    g15src.rotulos_numericos + ' rotulo(s)');
  const g15sale = await one(`with ${LVB},
    sc as (select distinct on (s.chassis) s.chassis, upper(trim(coalesce(s.store,''))) loja
      from public.portal_sales s join lvb on lvb.id=s.batch_id
       and lvb.source_type in ('SALES_CURRENT','SALES_HISTORY')
      where coalesce(s.chassis,'')<>'' order by s.chassis, s.sale_date desc, s.id desc)
    select count(*) total, count(*) filter (where sc.loja='2') venda_tambem_2
    from fin join sc on sc.chassis=fin.chassis where fin.loja='2';`);
  ok('4.4 a venda canonica tambem diz "2" -- sem corroboracao independente',
    Number(g15sale.total) === Number(g15sale.venda_tambem_2) && Number(g15sale.total) > 0,
    g15sale.venda_tambem_2 + '/' + g15sale.total);
  console.log('  Conclusao: NENHUMA reconstrucao deterministica de loja e possivel.');
  console.log('  Atribuir "2" a uma loja governada exigiria adivinhar.');

  /* ---------- 5. Nada foi implementado ---------- */
  h('5. NENHUMA DECISAO DE PRODUTO FOI IMPLEMENTADA');
  const est = await one(`select
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') ativas,
      (select count(*) from public.analista_responsavel_loja where status='SUPERSEDED') superseded,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from information_schema.tables where table_schema='public'
        and table_name in ('performance_periodos','performance_snapshots','snapshot_performance')) tabelas_performance;`);
  ok('5.1 autoridade de responsabilidade inalterada (23 ACTIVE + 4 SUPERSEDED)',
    Number(est.ativas) === 23 && Number(est.superseded) === 4);
  ok('5.2 auditoria inalterada', Number(est.audit) === 31, 'audit=' + est.audit);
  ok('5.3 NENHUMA tabela de periodo/snapshot de Performance foi criada',
    Number(est.tabelas_performance) === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

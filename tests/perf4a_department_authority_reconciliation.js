#!/usr/bin/env node
/*
 * [RANKING] PERF-4A -- Autoridade histórica do departamento
 * NOVOS / SEMINOVOS para o Ranking de Analistas.
 *
 * PERGUNTA: uma operação de financiamento pode ser classificada como
 * NOVOS ou SEMINOVOS pelo departamento persistido na VENDA histórica
 * correspondente (join determinístico por chassi), em vez de ser
 * derivada do departamento ATUAL do vendedor?
 *
 * SOMENTE LEITURA. Recusa por construção qualquer statement que não seja
 * SELECT/WITH. Não escreve, não cria período, não fecha nada, não toca
 * Salário. Determinístico e reexecutável.
 *
 * Zero PII: nunca imprime chassi, cliente, vendedor, analista, e-mail
 * ou UUID -- apenas contagens, valores agregados e rótulos de mês.
 *
 * SEMÂNTICA DE NEGÓCIO REUTILIZADA (nada inventado):
 *   - universo de vendas   = lotes SALES_CURRENT/SALES_HISTORY validados
 *                            mais recentes (latest_validated_batches);
 *   - venda canônica       = distinct on (chassis) order by chassis,
 *                            sale_date desc, id desc  -- exatamente a
 *                            regra `sales_global_latest` já usada por
 *                            operational_metrics;
 *   - universo de finance  = FINANCE_CURRENT/FINANCE_HISTORY validados
 *                            mais recentes, is_real_financing;
 *   - método atual (dept)  = coalesce(resolve_department_temporal(...),
 *                            status ATUAL do vendedor) -- o defeito que
 *                            esta Wave está medindo.
 *
 * O resolvedor candidato FALHA EXPLICITAMENTE quando ambíguo: nunca
 * escolhe primeira linha, nem ordem alfabética, nem default NOVOS.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';

const MONTHS = [
  ['2026-01-01', '2026-01-31', 'JAN'], ['2026-02-01', '2026-02-28', 'FEV'],
  ['2026-03-01', '2026-03-31', 'MAR'], ['2026-04-01', '2026-04-30', 'ABR'],
  ['2026-05-01', '2026-05-31', 'MAI'], ['2026-06-01', '2026-06-30', 'JUN'],
  ['2026-07-01', '2026-07-31', 'JUL'], ['2026-08-01', '2026-08-31', 'AGO'],
  ['2026-09-01', '2026-09-30', 'SET'],
];

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke)\b/i.test(query)
      || /\bcreate\s+(table|function|index|view|trigger|extension)\b/i.test(query)) {
      return reject(new Error('PERF-4A é somente-leitura: statement não-SELECT recusado'));
    }
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// Blocos canônicos reutilizados por todas as consultas.
const CTE = `
lvb as (
  select distinct on (b.source_type) b.id, b.source_type
  from public.portal_import_batches b
  where b.status='VALIDATED'
    and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SALES_CURRENT','SALES_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
sales_all as (
  select s.id, s.chassis, s.sale_date, s.department, s.store, s.seller_id, s.seller_user_id
  from public.portal_sales s join lvb on lvb.id=s.batch_id
   and lvb.source_type in ('SALES_CURRENT','SALES_HISTORY')
  where coalesce(s.chassis,'') <> ''),
sales_canon as (
  select distinct on (chassis) *
  from sales_all order by chassis, sale_date desc, id desc),
sales_dup as (
  select chassis, count(*) as n, count(distinct department) as depts
  from sales_all group by chassis),
fin as (
  select f.id, f.chassis, f.operation_date, f.return_value, f.store,
         coalesce(f.seller_user_id, f.seller_id) as sid
  from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
   and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
  where f.is_real_financing),
seller_dept as (
  select u.id, upper(trim(coalesce(u.status,''))) as status from public.usuarios u
  union all
  select ps.id, upper(trim(coalesce(ps.status,''))) from public.portal_sellers ps
   where not exists (select 1 from public.usuarios u2 where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo))
`;

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local -- PERF-4A exige leitura do projeto real.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');
  const one = async (q) => (await runSql(token, q))[0] || {};
  const all = async (q) => (await runSql(token, q)) || [];

  console.log('='.repeat(96));
  console.log('PERF-4A -- AUTORIDADE HISTORICA DE DEPARTAMENTO (NOVOS/SEMINOVOS)   [SOMENTE LEITURA]');
  console.log('='.repeat(96));

  // ---- 0. Guarda de dominio + proveniencia
  const g = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salary_md5,
    (select is_generated from information_schema.columns where table_schema='public'
      and table_name='portal_sales' and column_name='department') as dept_generated,
    (select is_nullable from information_schema.columns where table_schema='public'
      and table_name='portal_sales' and column_name='department') as dept_nullable,
    (select (pg_get_functiondef(p.oid) like '%resolve_department_temporal%') from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
      and p.proname='master_operational_import_sales') as import_usa_resolver;`);
  console.log(`\n[0] PROVENIENCIA  portal_sales.department: is_generated=${g.dept_generated} nullable=${g.dept_nullable}` +
    ` | import usa resolver de vendedor: ${g.import_usa_resolver}`);
  console.log(`    Salario md5 (deve permanecer intacto): ${g.salary_md5}`);

  // ---- 1. Grao e duplicidade de chassi
  const grain = await one(`with ${CTE}
    select (select count(*) from sales_all) as vendas,
           (select count(distinct chassis) from sales_all) as chassis_distintos,
           (select count(*) from sales_dup where n>1) as chassis_com_multiplas_vendas,
           (select count(*) from sales_dup where n>1 and depts>1) as chassis_multiplas_com_dept_diferente,
           (select count(*) from fin) as fin_elegiveis,
           (select count(*) from fin where coalesce(chassis,'')='') as fin_sem_chassi;`);
  console.log(`\n[1] GRAO  vendas=${grain.vendas} chassis distintos=${grain.chassis_distintos}` +
    ` | chassi com >1 venda=${grain.chassis_com_multiplas_vendas}` +
    ` (dos quais com DEPARTAMENTO DIFERENTE=${grain.chassis_multiplas_com_dept_diferente})`);
  console.log(`         financiamentos elegiveis=${grain.fin_elegiveis} sem chassi=${grain.fin_sem_chassi}`);

  // ---- 2. Match rate por mes
  console.log('\n[2] MATCH FINANCE -> VENDA CANONICA (por mes)');
  console.log('    ' + pad('MES', 5) + padL('ELEG', 6) + padL('C/CHASSI', 9) + padL('MATCH', 7) +
    padL('UNICA', 7) + padL('MULTI', 7) + padL('S/MATCH', 9) + padL('MATCH%', 8));
  const matchRows = [];
  for (const [ini, fim, label] of MONTHS) {
    const r = await one(`with ${CTE},
      m as (select f.*, sc.department as sale_dept, sd.n as cand
            from fin f
            left join sales_canon sc on sc.chassis = f.chassis
            left join sales_dup sd on sd.chassis = f.chassis
            where f.operation_date between date '${ini}' and date '${fim}')
      select count(*) as eleg,
             count(*) filter (where coalesce(chassis,'')<>'') as com_chassi,
             count(*) filter (where sale_dept is not null) as com_match,
             count(*) filter (where sale_dept is not null and cand=1) as unica,
             count(*) filter (where sale_dept is not null and cand>1) as multi,
             count(*) filter (where sale_dept is null) as sem_match
      from m;`);
    const pct = Number(r.eleg) > 0 ? (100 * Number(r.com_match) / Number(r.eleg)) : 0;
    console.log('    ' + pad(label, 5) + padL(r.eleg, 6) + padL(r.com_chassi, 9) + padL(r.com_match, 7) +
      padL(r.unica, 7) + padL(r.multi, 7) + padL(r.sem_match, 9) + padL(pct.toFixed(1) + '%', 8));
    matchRows.push({ label, ...r, pct });
  }

  // ---- 3. Cobertura de VALOR (retorno)
  console.log('\n[3] COBERTURA DE VALOR (retorno classificavel pelo departamento da venda)');
  console.log('    ' + pad('MES', 5) + padL('RETORNO TOTAL', 17) + padL('CLASSIFICADO', 17) + padL('NAO RESOLVIDO', 17) + padL('COBERTURA%', 12));
  const valRows = [];
  for (const [ini, fim, label] of MONTHS) {
    const r = await one(`with ${CTE},
      m as (select f.return_value, sc.department as sale_dept
            from fin f left join sales_canon sc on sc.chassis = f.chassis
            where f.operation_date between date '${ini}' and date '${fim}')
      select round(coalesce(sum(return_value),0),2) as total,
             round(coalesce(sum(return_value) filter (where sale_dept is not null),0),2) as classificado,
             round(coalesce(sum(return_value) filter (where sale_dept is null),0),2) as nao_resolvido
      from m;`);
    const cov = Number(r.total) > 0 ? (100 * Number(r.classificado) / Number(r.total)) : 100;
    console.log('    ' + pad(label, 5) + padL(brl(r.total), 17) + padL(brl(r.classificado), 17) +
      padL(brl(r.nao_resolvido), 17) + padL(cov.toFixed(2) + '%', 12));
    valRows.push({ label, ...r, cov });
  }

  // ---- 4. Metodo atual vs metodo venda-dept
  console.log('\n[4] METODO ATUAL (dept do vendedor) vs CANDIDATO (dept da venda)');
  console.log('    ' + pad('MES', 5) + padL('OPS', 6) + padL('IGUAL', 7) + padL('DIFER.', 8) + padL('N/RESOLV', 9) +
    padL('DELTA NOVOS R$', 18) + padL('DELTA SEMIN. R$', 18));
  const cmpRows = [];
  for (const [ini, fim, label] of MONTHS) {
    const r = await one(`with ${CTE},
      m as (select f.return_value,
              sc.department as cand,
              upper(trim(coalesce(public.resolve_department_temporal(f.sid, f.operation_date, null), sdp.status, 'SEM DEPARTAMENTO'))) as atual
            from fin f
            left join sales_canon sc on sc.chassis = f.chassis
            left join seller_dept sdp on sdp.id = f.sid
            where f.operation_date between date '${ini}' and date '${fim}')
      select count(*) as ops,
             count(*) filter (where cand is not null and cand = atual) as igual,
             count(*) filter (where cand is not null and cand <> atual) as difer,
             count(*) filter (where cand is null) as nao_resolv,
             round(coalesce(sum(return_value) filter (where cand='NOVOS'),0)
                 - coalesce(sum(return_value) filter (where atual='NOVOS'),0),2) as delta_novos,
             round(coalesce(sum(return_value) filter (where cand='SEMINOVOS'),0)
                 - coalesce(sum(return_value) filter (where atual='SEMINOVOS'),0),2) as delta_semi
      from m;`);
    console.log('    ' + pad(label, 5) + padL(r.ops, 6) + padL(r.igual, 7) + padL(r.difer, 8) + padL(r.nao_resolv, 9) +
      padL(brl(r.delta_novos), 18) + padL(brl(r.delta_semi), 18));
    cmpRows.push({ label, ...r });
  }

  // ---- 5. Conservacao: cada operacao cai em exatamente um balde
  console.log('\n[5] LEI DE CONSERVACAO (cada operacao elegivel conta exatamente uma vez)');
  for (const [ini, fim, label] of [['2026-01-01', '2026-08-31', 'JAN-AGO'], ['2026-09-01', '2026-09-30', 'SET']]) {
    const c = await one(`with ${CTE},
      m as (select f.return_value, sc.department as cand
            from fin f left join sales_canon sc on sc.chassis = f.chassis
            where f.operation_date between date '${ini}' and date '${fim}')
      select count(*) as ops,
        count(*) filter (where cand='NOVOS') as novos,
        count(*) filter (where cand='SEMINOVOS') as seminovos,
        count(*) filter (where cand is null) as unresolved,
        round(coalesce(sum(return_value),0),2) as total,
        round(coalesce(sum(return_value) filter (where cand='NOVOS'),0)
            + coalesce(sum(return_value) filter (where cand='SEMINOVOS'),0)
            + coalesce(sum(return_value) filter (where cand is null),0),2) as soma_baldes
      from m;`);
    const okOps = Number(c.novos) + Number(c.seminovos) + Number(c.unresolved) === Number(c.ops);
    const okVal = Number(c.total).toFixed(2) === Number(c.soma_baldes).toFixed(2);
    console.log(`    ${pad(label, 8)} ops=${c.ops} (N=${c.novos} S=${c.seminovos} NR=${c.unresolved}) soma=${okOps ? 'OK' : 'FALHA'}` +
      ` | retorno=${brl(c.total)} baldes=${brl(c.soma_baldes)} ${okVal ? 'OK' : 'FALHA'}`);
  }

  // ---- 6. Relacao de datas finance x venda
  console.log('\n[6] RELACAO DE DATAS (financiamento - venda canonica)');
  const dr = await all(`with ${CTE},
    m as (select (f.operation_date - sc.sale_date) as lag
          from fin f join sales_canon sc on sc.chassis = f.chassis
          where f.operation_date between date '2026-01-01' and date '2026-09-30')
    select case
      when lag < 0 then 'financiamento ANTES da venda'
      when lag = 0 then 'mesmo dia'
      when lag <= 1 then 'ate 1 dia'
      when lag <= 7 then 'ate 7 dias'
      when lag <= 30 then 'ate 30 dias'
      else 'mais de 30 dias' end as faixa,
      count(*) as n
    from m group by 1 order by 2 desc;`);
  const totLag = dr.reduce((a, x) => a + Number(x.n), 0);
  dr.forEach(x => console.log(`    ${pad(x.faixa, 32)} ${padL(x.n, 6)}  ${padL((100 * Number(x.n) / totLag).toFixed(1) + '%', 7)}`));

  // ---- 7. Chassi com multiplas vendas -- forense
  console.log('\n[7] CHASSI COM MULTIPLAS VENDAS -- consistencia de departamento');
  const dup = await one(`with ${CTE}
    select count(*) filter (where n>1) as multiplas,
           count(*) filter (where n>1 and depts=1) as mesmo_dept,
           count(*) filter (where n>1 and depts>1) as dept_diferente,
           (select count(*) from fin f join sales_dup d on d.chassis=f.chassis
             where d.n>1 and d.depts>1
               and f.operation_date between date '2026-01-01' and date '2026-09-30') as fin_afetados,
           (select round(coalesce(sum(f.return_value),0),2) from fin f join sales_dup d on d.chassis=f.chassis
             where d.n>1 and d.depts>1
               and f.operation_date between date '2026-01-01' and date '2026-09-30') as retorno_afetado
    from sales_dup;`);
  console.log(`    chassi com >1 venda: ${dup.multiplas}  | mesmo departamento: ${dup.mesmo_dept}  | departamento DIFERENTE: ${dup.dept_diferente}`);
  console.log(`    financiamentos Jan-Set atingidos por chassi ambiguo: ${dup.fin_afetados}  | retorno envolvido: R$ ${brl(dup.retorno_afetado)}`);

  // ---- 8. Consistencia de loja
  const st = await one(`with ${CTE},
    m as (select upper(trim(coalesce(f.store,''))) as fstore, upper(trim(coalesce(sc.store,''))) as sstore
          from fin f join sales_canon sc on sc.chassis=f.chassis
          where f.operation_date between date '2026-01-01' and date '2026-09-30')
    select count(*) as n, count(*) filter (where fstore = sstore) as iguais,
           count(*) filter (where fstore='' or sstore='') as vazio from m;`);
  console.log(`\n[8] CONSISTENCIA DE LOJA  pares=${st.n} iguais=${st.iguais}` +
    ` (${(100 * Number(st.iguais) / Math.max(Number(st.n), 1)).toFixed(1)}%) com loja vazia=${st.vazio}`);

  // ---- 9. Guarda final
  const f2 = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salary_md5,
    (select count(*) from public.analista_responsavel_loja) as resp,
    (select count(*) from public.fechamentos_comissao) as fech,
    (select count(*) from public.snapshot_comissoes) as snapc;`);
  console.log(`\n[9] GUARDA FINAL  Salario md5=${f2.salary_md5} | responsabilidade=${f2.resp} | fechamentos=${f2.fech} | snapshot=${f2.snapc}`);
  console.log(`    Salario inalterado: ${f2.salary_md5 === g.salary_md5 ? 'SIM' : 'NAO -- VIOLACAO'}`);

  console.log('\n' + '='.repeat(96));
  console.log('PERF-4A concluido. Nenhuma escrita realizada.');
  console.log('='.repeat(96));
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

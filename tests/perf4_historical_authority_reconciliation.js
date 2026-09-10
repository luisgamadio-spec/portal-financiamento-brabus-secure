#!/usr/bin/env node
/*
 * [RANKING] PERF-4 -- Reconciliacao de autoridade historica do Ranking
 * de Analistas, JANEIRO a AGOSTO de 2026.
 *
 * SOMENTE LEITURA. Recusa por construcao qualquer statement que nao seja
 * SELECT/WITH. Nao escreve, nao cria periodo, nao cria responsabilidade,
 * nao fecha nada. Deterministico: pode ser reexecutado e produz o mesmo
 * resultado a partir das mesmas fontes canonicas.
 *
 * Zero PII: nenhum nome, CPF, e-mail ou UUID e impresso -- apenas
 * contagens, datas e rotulos de loja (entidades de negocio).
 *
 * O que ele prova, mes a mes:
 *   [A] FATOS   -- vendas, financiamentos, retorno, unidades SPF, pelo
 *                  filtro canonico de lote validado mais recente;
 *   [B] SPLIT   -- se NOVOS/SEMINOVOS e fato historico ou derivado do
 *                  departamento ATUAL do vendedor;
 *   [C] IDENTIDADE -- se existe qualquer identidade de Analista no
 *                  sistema naquele mes;
 *   [D] RESPONSABILIDADE -- se existe autoridade governada cobrindo o mes.
 *
 * A regra do produto e clara: nunca inferir responsabilidade historica a
 * partir do cadastro atual, da ordem alfabetica, do Salario ou de
 * ausencias. Este script mede a AUSENCIA dessas evidencias; nao a supre.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const GOV_START = '2026-08-21';

const MONTHS = [
  ['2026-01-01', '2026-01-31', 'JAN'], ['2026-02-01', '2026-02-28', 'FEV'],
  ['2026-03-01', '2026-03-31', 'MAR'], ['2026-04-01', '2026-04-30', 'ABR'],
  ['2026-05-01', '2026-05-31', 'MAI'], ['2026-06-01', '2026-06-30', 'JUN'],
  ['2026-07-01', '2026-07-31', 'JUL'], ['2026-08-01', '2026-08-31', 'AGO'],
];

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(query)) {
      return reject(new Error('PERF-4 e somente-leitura: statement nao-SELECT recusado'));
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

// Filtro canonico: mesmo `latest_validated_batches` usado por
// operational_metrics. Sem ele, lotes superseded inflam as contagens.
const LVB = `with lvb as (
  select distinct on (b.source_type) b.id, b.source_type
  from public.portal_import_batches b
  where b.status='VALIDATED'
    and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT','SALES_CURRENT','SALES_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc)`;

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local -- PERF-4 exige leitura do projeto real.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');
  const one = async (q) => (await runSql(token, q))[0] || {};
  const all = async (q) => (await runSql(token, q)) || [];

  console.log('='.repeat(78));
  console.log('PERF-4 -- AUTORIDADE HISTORICA DO RANKING (JAN-AGO 2026)  [SOMENTE LEITURA]');
  console.log('='.repeat(78));

  // ---- 0. Fronteira de dominio: Salario nao pode ser fonte do Ranking
  const b = await one(`select
    (select (pg_get_functiondef(p.oid) like '%analista_responsavel_loja%') from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
      and p.proname='operational_analyst_commission_metrics') as salario_ref_ranking,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salario_md5;`);
  console.log(`\n[0] FRONTEIRA  Salario referencia autoridade do Ranking: ${b.salario_ref_ranking ? 'SIM (VIOLACAO)' : 'NAO'}  | md5 ${b.salario_md5}`);

  // ---- 1. Fundacao de responsabilidade (governanca atual)
  const g = await one(`select
    (select count(*) from public.analista_responsavel_loja where status='ACTIVE') as vigencias,
    (select min(valid_from) from public.analista_responsavel_loja where status='ACTIVE') as inicio,
    (select count(*) from public.analista_responsavel_loja where valid_from < date '${GOV_START}') as retroativas,
    (select count(*) from public.analista_responsavel_loja a join public.analista_responsavel_loja c
       on c.id<>a.id and c.loja_normalizada=a.loja_normalizada and a.status='ACTIVE' and c.status='ACTIVE'
      and daterange(a.valid_from,a.valid_to,'[)') && daterange(c.valid_from,c.valid_to,'[)')) as overlaps;`);
  console.log(`[1] GOVERNANCA vigencias=${g.vigencias} inicio=${g.inicio} retroativas=${g.retroativas} overlaps=${g.overlaps}`);

  // ---- 2. Identidade de Analista existente no sistema, por mes
  const ident = await all(`select to_char(criado_em,'YYYY-MM') as mes, count(*) as novos_analistas
    from public.usuarios where upper(trim(coalesce(perfil,'')))='ANALISTA' group by 1 order by 1;`);
  const firstAnalyst = await one(`select min(criado_em)::date as primeiro_analista,
    count(*) as total_analistas,
    count(*) filter (where criado_em::date < date '2026-06-01') as criados_antes_de_junho
    from public.usuarios where upper(trim(coalesce(perfil,'')))='ANALISTA';`);
  console.log(`[2] IDENTIDADE primeiro registro de ANALISTA no sistema: ${firstAnalyst.primeiro_analista}` +
    ` | total=${firstAnalyst.total_analistas} | criados antes de junho=${firstAnalyst.criados_antes_de_junho}`);
  console.log(`    cadastros por mes: ${ident.map(r => `${r.mes}:${r.novos_analistas}`).join('  ')}`);

  // ---- 3. Evidencia historica alternativa
  const h = await one(`select
    (select count(*) from public.snapshot_comissoes where perfil='ANALISTA') as snap_total,
    (select count(*) from public.snapshot_comissoes where perfil='ANALISTA' and coalesce(cpf,'')<>'') as snap_com_cpf,
    (select count(*) from public.snapshot_comissoes where perfil='ANALISTA'
       and upper(trim(coalesce(departamento,''))) in ('NOVOS','SEMINOVOS')) as snap_com_dept,
    (select count(*) from information_schema.columns where table_schema='public'
       and table_name='snapshot_comissoes' and (column_name ilike '%spf%qtd%' or column_name ilike '%spf%count%')) as snap_spf_qtd,
    (select count(*) from public.snapshot_operational_detail) as detail_rows,
    (select count(*) from public.usuarios u where upper(trim(coalesce(u.perfil,'')))='ANALISTA'
       and exists (select 1 from public.mudancas_loja_vendedores m where m.usuario_id=u.id)) as analistas_com_historico_loja;`);
  console.log(`[3] EVIDENCIA snapshot ANALISTA=${h.snap_total} (com CPF=${h.snap_com_cpf}, com dept NOVOS/SEMINOVOS=${h.snap_com_dept},` +
    ` colunas de QTD SPF=${h.snap_spf_qtd}) | snapshot_operational_detail=${h.detail_rows} | analistas com historico de loja=${h.analistas_com_historico_loja}`);

  // ---- 4. Matriz mes a mes
  console.log('\n[4] MATRIZ MENSAL (fatos canonicos, lote validado mais recente)');
  console.log('    ' + pad('MES', 5) + padL('VENDAS', 8) + padL('FIN', 6) + padL('CHASSI', 8) +
    padL('RETORNO', 14) + padL('SPF_UND', 9) + padL('LOJAS', 7) + '  ' + pad('DEPT_SPLIT', 12) + pad('IDENT', 8) + 'RESP');

  const rows = [];
  for (const [ini, fim, label] of MONTHS) {
    const f = await one(`${LVB}
      select
        (select count(*) from public.portal_sales s join lvb on lvb.id=s.batch_id
           and lvb.source_type in ('SALES_CURRENT','SALES_HISTORY')
         where s.sale_date between date '${ini}' and date '${fim}') as vendas,
        (select count(*) from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}') as fin,
        (select count(distinct x.chassis) from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}') as chassi,
        (select round(coalesce(sum(x.return_value),0),2) from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}') as retorno,
        (select count(*) from public.portal_spf_operations sp join lvb on lvb.id=sp.batch_id
           and lvb.source_type='SPF_CURRENT'
         where sp.is_spf_extra and coalesce(sp.optional_value,0)>0
           and sp.operation_date between date '${ini}' and date '${fim}') as spf_und,
        (select count(distinct upper(trim(coalesce(public.resolve_store_temporal(coalesce(x.seller_user_id,x.seller_id), x.operation_date, nullif(x.store,'')),'SEM LOJA'))))
         from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}') as lojas,
        (select count(*) from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}'
           and upper(trim(coalesce(public.resolve_department_temporal(coalesce(x.seller_user_id,x.seller_id), x.operation_date, null),''))) in ('NOVOS','SEMINOVOS')) as dept_temporal,
        (select count(*) from public.usuarios where upper(trim(coalesce(perfil,'')))='ANALISTA'
           and criado_em::date <= date '${fim}') as analistas_existentes,
        (select count(*) from public.analista_responsavel_loja
         where status='ACTIVE' and valid_from <= date '${fim}' and (valid_to is null or valid_to > date '${ini}')) as resp_janelas;`);

    const deptPct = Number(f.fin) > 0 ? (100 * Number(f.dept_temporal) / Number(f.fin)) : 0;
    const deptTag = deptPct >= 99 ? 'HISTORICO' : (Number(f.dept_temporal) === 0 ? 'ATUAL(0%)' : `ATUAL(${deptPct.toFixed(0)}%)`);
    const identTag = Number(f.analistas_existentes) === 0 ? 'NENHUM' : `${f.analistas_existentes}`;
    const respTag = Number(f.resp_janelas) > 0 ? `${f.resp_janelas} jan.` : 'NENHUMA';
    console.log('    ' + pad(label, 5) + padL(f.vendas, 8) + padL(f.fin, 6) + padL(f.chassi, 8) +
      padL(Number(f.retorno).toLocaleString('pt-BR', { minimumFractionDigits: 2 }), 14) +
      padL(f.spf_und, 9) + padL(f.lojas, 7) + '  ' + pad(deptTag, 12) + pad(identTag, 8) + respTag);
    rows.push({ label, ...f, deptTag, identTag, respTag });
  }

  // ---- 5. Agosto em dois segmentos
  console.log('\n[5] AGOSTO EM SEGMENTOS');
  for (const [ini, fim, label] of [['2026-08-01', '2026-08-20', 'AGO 01-20'], ['2026-08-21', '2026-08-31', 'AGO 21-31']]) {
    const s = await one(`${LVB}
      select
        (select count(*) from public.portal_finance_operations x join lvb on lvb.id=x.batch_id
           and lvb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
         where x.is_real_financing and x.operation_date between date '${ini}' and date '${fim}') as fin,
        (select count(*) from public.portal_spf_operations sp join lvb on lvb.id=sp.batch_id
           and lvb.source_type='SPF_CURRENT' where sp.is_spf_extra and coalesce(sp.optional_value,0)>0
           and sp.operation_date between date '${ini}' and date '${fim}') as spf_und,
        (select count(*) from public.analista_responsavel_loja where status='ACTIVE'
           and valid_from <= date '${fim}' and (valid_to is null or valid_to > date '${ini}')) as resp;`);
    console.log(`    ${pad(label, 11)} fin=${padL(s.fin, 4)} spf_und=${padL(s.spf_und, 3)} responsabilidade=${Number(s.resp) > 0 ? 'GOVERNADA' : 'AUSENTE'}`);
  }

  // ---- 6. Conclusao determinada pelas evidencias
  console.log('\n[6] CLASSIFICACAO DERIVADA DAS EVIDENCIAS');
  for (const r of rows) {
    const semIdent = Number(r.analistas_existentes) === 0;
    const semResp = Number(r.resp_janelas) === 0;
    const semSpf = Number(r.spf_und) === 0;
    let cls;
    if (semIdent) cls = 'UNRESOLVED (sem identidade de Analista no sistema)';
    else if (semResp) cls = 'UNRESOLVED (sem autoridade de responsabilidade)';
    else cls = 'PARCIALMENTE GOVERNADO (ver segmentos)';
    const notas = [];
    if (semSpf) notas.push('UND SPF = 0');
    if (r.deptTag.startsWith('ATUAL')) notas.push('split NOVOS/SEMINOVOS derivado do departamento ATUAL do vendedor');
    console.log(`    ${pad(r.label, 5)} ${pad(cls, 52)}${notas.length ? ' | ' + notas.join('; ') : ''}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('PERF-4 concluido. Nenhuma escrita realizada.');
  console.log('='.repeat(78));
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

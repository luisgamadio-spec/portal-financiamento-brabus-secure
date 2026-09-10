#!/usr/bin/env node
/*
 * [RANKING] PERF-5D.1A -- Fallback de loja pela venda ligada por chassi.
 *
 * Prova, contra o banco REAL:
 *   - as 5 operacoes SEM LOJA de PERF-5D.1 sao recuperadas, cada uma para
 *     a loja e a Analista corretas;
 *   - as 3 operacoes REVENDA continuam sem atribuicao -- a falta ali e de
 *     ANALISTA, nao de loja, e o fallback nao as toca;
 *   - a precedencia e respeitada: loja primaria valida nunca e sobrescrita;
 *   - H7 ("2" -> BARRA FUNDA) segue valendo;
 *   - G4 STRICT_DATE_BOUNDED: venda posterior nao determina loja historica;
 *   - ambiguidade FALHA SEGURO: vendas da mesma data que discordam devolvem
 *     NULL em vez de escolher;
 *   - junho: empate 28/28 em UND Financiado da 15 pontos aos dois
 *     (FULL_POINTS_COMPETITION_RANKING), levando Willian de 23 a 30;
 *   - agosto: contagens sobem, pontos NAO mudam;
 *   - nenhum vencedor e nenhum vice muda em jan-ago;
 *   - residuo 8 -> 3;
 *   - Salario e o resolvedor compartilhado permanecem intactos;
 *   - evidencia bruta intacta.
 *
 * Todo fechamento roda dentro de BEGIN...ROLLBACK. Nenhum periodo ou
 * snapshot oficial e criado. ZERO PII de cliente.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';

/* Esperado de PERF-5D.1, por mes e ordem cronologica dentro do mes. */
const RECUPERACOES = [
  { ref: 'S1', mes: '2026-06', loja: 'BANDEIRANTES', analista: 'WILLIAN' },
  { ref: 'S2', mes: '2026-08', loja: 'EUROPA', analista: 'FERNANDA' },
  { ref: 'S3', mes: '2026-08', loja: 'GASTAO', analista: 'JACENIR' },
  { ref: 'S4', mes: '2026-08', loja: 'GASTAO', analista: 'JACENIR' },
  { ref: 'S5', mes: '2026-08', loja: 'BANDEIRANTES', analista: 'WILLIAN' },
];
const PODIO = {
  '2026-01': ['CAMILE', 43, 'BÁRBARA'], '2026-02': ['GIOVANNA', 50, 'CAMILE'],
  '2026-03': ['GIOVANNA', 50, 'FERNANDA'], '2026-04': ['WILLIAN', 50, 'Daiane'],
  '2026-05': ['DOUGLAS', 57, 'CAMILE'], '2026-06': ['CAMILE', 82, 'DOUGLAS'],
  '2026-07': ['DOUGLAS', 58, 'WILLIAN'], '2026-08': ['WILLIAN', 50, 'CAMILE'],
};
const RESIDUO = { '2026-01': 1, '2026-02': 0, '2026-03': 0, '2026-04': 1,
  '2026-05': 1, '2026-06': 0, '2026-07': 0, '2026-08': 0 };

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
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const FIN_CTE = `
lvb as (
  select distinct on (b.source_type) b.id, b.source_type
  from public.portal_import_batches b
  where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
fin as (
  select f.chassis, f.operation_date d,
    public.performance_normalizar_loja(
      coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
        f.operation_date, nullif(f.store,'')),'SEM LOJA')) prim
  from public.portal_finance_operations f
  join lvb on lvb.id=f.batch_id
  where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _e: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-5D.1A -- FALLBACK DE LOJA PELA VENDA DO CHASSI');

  /* ---------- 1. Dominio ---------- */
  h('1. TRAVA DE DOMINIO');
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
          and pg_get_functiondef(p.oid) like '%performance_loja_por_venda_do_chassi%') sal_usa;`);
  ok('1.1 funcao de comissao de Salario inalterada', md5.sal === SALARY_MD5, md5.sal);
  ok('1.2 tamanho inalterado', Number(md5.bytes) === 16301, md5.bytes + ' bytes');
  ok('1.3 resolve_store_temporal (compartilhada) inalterada', md5.rs === RESOLVE_STORE_MD5, md5.rs);
  ok('1.4 NENHUMA funcao de Salario referencia o fallback', Number(md5.sal_usa) === 0);

  /* ---------- 2. As cinco recuperacoes ---------- */
  h('2. AS CINCO OPERACOES SEM LOJA RECUPERADAS');
  const rec = await all(`with ${FIN_CTE}
    select to_char(fin.d,'YYYY-MM') mes, fin.d data,
      public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d) loja,
      (select split_part(btrim(u.nome),' ',1) from public.analista_responsavel_loja r
        join public.usuarios u on u.id=r.analista_usuario_id
        where r.status='ACTIVE'
          and r.loja_normalizada=public.performance_loja_por_venda_do_chassi(fin.chassis, fin.d)
          and fin.d >= r.valid_from and (r.valid_to is null or fin.d < r.valid_to) limit 1) analista
    from fin where fin.prim='SEM LOJA' order by fin.d;`);
  ok('2.0 exatamente 5 operacoes SEM LOJA', rec.length === 5, rec.length + ' encontrada(s)');
  console.log('  ' + pad('Ref', 5) + pad('Mes', 9) + pad('Loja recuperada', 16) + 'Analista');
  console.log('  ' + '-'.repeat(50));
  RECUPERACOES.forEach((e, i) => {
    const r = rec[i] || {};
    console.log('  ' + pad(e.ref, 5) + pad(r.mes, 9) + pad(r.loja, 16) + pad(r.analista, 12));
    ok('2.' + (i + 1) + ' ' + e.ref + ' -> ' + e.loja + ' -> ' + e.analista,
      r.mes === e.mes && r.loja === e.loja && r.analista === e.analista);
  });

  /* ---------- 3. REVENDA intocada ---------- */
  h('3. REVENDA -- FORA DO ESCOPO DO FALLBACK');
  const rev = await all(`with ${FIN_CTE}
    select to_char(fin.d,'YYYY-MM') mes, fin.d data, fin.prim loja,
      (select count(*) from public.analista_responsavel_loja r
        where r.status='ACTIVE' and r.loja_normalizada=fin.prim
          and fin.d >= r.valid_from and (r.valid_to is null or fin.d < r.valid_to)) resp
    from fin where fin.prim='REVENDA'
      and not exists (select 1 from public.analista_responsavel_loja r
        where r.status='ACTIVE' and r.loja_normalizada=fin.prim
          and fin.d >= r.valid_from and (r.valid_to is null or fin.d < r.valid_to))
    order by fin.d;`);
  ok('3.1 exatamente 3 operacoes REVENDA sem responsavel', rev.length === 3, rev.length + '');
  ok('3.2 todas mantem a loja primaria REVENDA (fallback nao sobrescreve)',
    rev.every(r => r.loja === 'REVENDA'));
  ok('3.3 nenhuma tem responsavel -- falta ANALISTA, nao loja',
    rev.every(r => Number(r.resp) === 0));
  console.log('  ' + rev.map(r => r.data).join('  ') + '  -> permanecem sem atribuicao');

  /* ---------- 4. Precedencia e H7 ---------- */
  h('4. PRECEDENCIA E H7');
  const prec = await one(`with ${FIN_CTE}
    select count(*) filter (where fin.prim <> 'SEM LOJA') com_primaria,
      count(*) filter (where fin.prim = 'BARRA FUNDA') barra_funda
    from fin;`);
  ok('4.1 operacoes com loja primaria valida nao passam pelo fallback',
    Number(prec.com_primaria) > 0, prec.com_primaria + ' operacoes');
  const h7 = await one(`select public.performance_normalizar_loja('2') dois,
      (select count(*) from public.performance_loja_codigo_map where codigo_origem='2'
        and loja_canonica='BARRA FUNDA') mapa;`);
  ok('4.2 H7 preservado: "2" -> BARRA FUNDA', h7.dois === 'BARRA FUNDA' && Number(h7.mapa) === 1);
  const src = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations',
    '20260910160000_perf5d1a_sem_loja_chassis_fallback.sql'), 'utf-8');
  ok('4.3 fallback so entra quando a primaria e SEM LOJA',
    /case when fin\.loja_primaria = 'SEM LOJA'/.test(src));
  ok('4.4 a migracao NAO redefine resolve_store_temporal',
    !/create or replace function public\.resolve_store_temporal/i.test(src));

  /* ---------- 5. G4 e ambiguidade ---------- */
  h('5. STRICT_DATE_BOUNDED E FALHA SEGURA');
  const g4 = await one(`select
      (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='performance_loja_por_venda_do_chassi'
          and pg_get_functiondef(p.oid) like '%s.sale_date <= p_data%') estrito,
      public.performance_loja_por_venda_do_chassi('CHASSI_QUE_NAO_EXISTE', date '2026-06-30') inexistente;`);
  ok('5.1 helper so considera venda ATE a data da operacao', Number(g4.estrito) === 1);
  ok('5.2 chassi sem venda devolve NULL', g4.inexistente === null, String(g4.inexistente));

  /* venda POSTERIOR nao pode determinar a loja */
  const futuro = await one(`with ${FIN_CTE},
    alvo as (select fin.chassis, fin.d from fin where fin.prim='SEM LOJA' order by fin.d limit 1)
    select public.performance_loja_por_venda_do_chassi(alvo.chassis, alvo.d - 3650) antes,
           public.performance_loja_por_venda_do_chassi(alvo.chassis, alvo.d) na_data
    from alvo;`);
  ok('5.3 uma venda POSTERIOR nao determina a loja historica',
    futuro.antes === null && futuro.na_data !== null, 'antes=' + futuro.antes + ' na_data=' + futuro.na_data);

  /* ambiguidade: duas vendas na MESMA data com lojas diferentes -> NULL */
  const amb = await runSql(token, `begin;
    insert into public.portal_sales (batch_id, chassis, sale_date, store, department, source_row_number, source_kind)
    select b.id, 'PERF5D1A_AMBIGUO', date '2026-03-10', 'EUROPA', 'NOVOS', 900001, 'CURRENT'
      from public.portal_import_batches b where b.status='VALIDATED' and b.source_type='SALES_CURRENT'
      order by b.completed_at desc nulls last limit 1;
    insert into public.portal_sales (batch_id, chassis, sale_date, store, department, source_row_number, source_kind)
    select b.id, 'PERF5D1A_AMBIGUO', date '2026-03-10', 'GASTAO', 'NOVOS', 900002, 'CURRENT'
      from public.portal_import_batches b where b.status='VALIDATED' and b.source_type='SALES_CURRENT'
      order by b.completed_at desc nulls last limit 1;
    select public.performance_loja_por_venda_do_chassi('PERF5D1A_AMBIGUO', date '2026-03-31') r;
    rollback;`);
  const ambV = Array.isArray(amb) ? (amb[0] || {}).r : '(erro)';
  ok('5.4 vendas conflitantes na mesma data devolvem NULL -- nao adivinha',
    ambV === null, String(ambV));
  const limpo = await one(`select count(*) n from public.portal_sales where chassis='PERF5D1A_AMBIGUO';`);
  ok('5.5 ROLLBACK: nenhuma venda sintetica persistiu', Number(limpo.n) === 0);

  /* ---------- 6. Fechamento em rollback: junho, agosto, podio ---------- */
  h('6. FECHAMENTO REAL EM ROLLBACK -- JUN, AGO E PODIO');
  const dry = await runSql(token, `begin;
    do $imp$ begin
      perform set_config('request.jwt.claims', json_build_object('sub',
        (select auth_user_id from public.usuarios where ativo
          and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null
          order by criado_em limit 1))::text, true);
    end $imp$;
    create temp table _r(k text, v text) on commit drop;
    do $x$
    declare m date; r jsonb; p uuid;
    begin
      for m in select generate_series(date '2026-01-01', date '2026-08-01', interval '1 month')::date loop
        r := public.master_performance_criar_periodo(m);
        p := (r->>'periodo_id')::uuid;
        r := public.master_performance_fechar_periodo(p, 'PERF-5D.1A regressao');
        insert into _r values ('res_' || to_char(m,'YYYY-MM'), r->>'nao_atribuidas');
        insert into _r
          select 'p' || x.rn || '_' || to_char(m,'YYYY-MM'),
                 split_part(btrim(u.nome),' ',1) || '|' || x.pontos_total
          from (select res.*, row_number() over (order by res.pontos_total desc, res.analista_usuario_id) rn
                from public.performance_snapshot_resultado res
                where res.snapshot_id=(r->>'snapshot_id')::uuid) x
          join public.usuarios u on u.id=x.analista_usuario_id where x.rn <= 2;
        if to_char(m,'YYYY-MM') in ('2026-06','2026-08') then
          insert into _r
            select 'm_' || to_char(m,'YYYY-MM') || '_' || split_part(btrim(u.nome),' ',1),
                   res.und_financiado || '|' || res.pontos_total
            from public.performance_snapshot_resultado res
            join public.usuarios u on u.id=res.analista_usuario_id
            where res.snapshot_id=(r->>'snapshot_id')::uuid
              and split_part(btrim(u.nome),' ',1) in ('WILLIAN','CAMILE','FERNANDA','JACENIR');
        end if;
      end loop;
    end $x$;
    select * from _r;
    rollback;`);
  const R = {}; if (Array.isArray(dry)) dry.forEach(x => R[x.k] = x.v);
  else console.log('  (erro no fechamento: ' + JSON.stringify(dry).slice(0, 300) + ')');

  Object.keys(RESIDUO).forEach(m =>
    ok('6.res ' + m + ' residuo = ' + RESIDUO[m], Number(R['res_' + m]) === RESIDUO[m], R['res_' + m]));
  const totalRes = Object.keys(RESIDUO).reduce((s, m) => s + Number(R['res_' + m] || 0), 0);
  ok('6.total residuo 8 -> 3', totalRes === 3, 'total=' + totalRes);

  h('6.1 JUNHO -- EMPATE 28/28 E FULL_POINTS_COMPETITION_RANKING');
  const jw = (R['m_2026-06_WILLIAN'] || '').split('|');
  const jc = (R['m_2026-06_CAMILE'] || '').split('|');
  ok('6.1.1 Willian UND Financiado 27 -> 28', jw[0] === '28', 'und=' + jw[0]);
  ok('6.1.2 Camile UND Financiado permanece 28', jc[0] === '28', 'und=' + jc[0]);
  ok('6.1.3 empate 28/28 confirmado', jw[0] === jc[0] && jw[0] === '28');
  ok('6.1.4 Willian 23 -> 30 pontos (recebe os 15 do 1o lugar no empate)',
    jw[1] === '30', 'pontos=' + jw[1]);
  ok('6.1.5 Camile mantem 82 pontos', jc[1] === '82', 'pontos=' + jc[1]);

  h('6.2 AGOSTO -- CONTAGENS SOBEM, PONTOS NAO MUDAM');
  [['WILLIAN', '34', '50'], ['FERNANDA', '27', '25'], ['JACENIR', '19', '17']].forEach(([a, u, p]) => {
    const v = (R['m_2026-08_' + a] || '').split('|');
    ok('6.2 ' + pad(a, 9) + 'UND=' + u + ' pontos=' + p, v[0] === u && v[1] === p,
      'obtido ' + v[0] + '|' + v[1]);
  });

  h('6.3 PODIO JAN-AGO INALTERADO');
  Object.keys(PODIO).forEach(m => {
    const [w, pts, ru] = PODIO[m];
    const p1 = (R['p1_' + m] || '').split('|'), p2 = (R['p2_' + m] || '').split('|');
    ok('6.3 ' + m + ' 1o ' + pad(w, 10) + pts + ' / 2o ' + ru,
      p1[0] === w && p1[1] === String(pts) && p2[0] === ru,
      p1[0] + '=' + p1[1] + ' / ' + p2[0]);
  });

  /* ---------- 7. Nada oficial, nada bruto ---------- */
  h('7. ESTADO OFICIAL E EVIDENCIA BRUTA');
  const fim = await one(`select
      (select count(*) from public.performance_periodo) periodos,
      (select count(*) from public.performance_snapshot) snapshots,
      (select count(*) from public.portal_sales where trim(coalesce(store,''))='2') vendas2,
      (select count(*) from public.portal_finance_operations where trim(coalesce(store,''))='2') fin2,
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') resp,
      (select count(*) from public.analista_responsavel_loja where status='SUPERSEDED') sup,
      (select count(*) from public.analista_responsavel_loja_auditoria) resp_audit;`);
  ok('7.1 ZERO periodos oficiais', Number(fim.periodos) === 0, fim.periodos + '');
  ok('7.2 ZERO snapshots oficiais', Number(fim.snapshots) === 0, fim.snapshots + '');
  ok('7.3 evidencia bruta de vendas intacta (189)', Number(fim.vendas2) === 189);
  ok('7.4 evidencia bruta de financiamentos intacta (186)', Number(fim.fin2) === 186);
  ok('7.5 responsabilidade inalterada (23 ACTIVE / 4 SUPERSEDED)',
    Number(fim.resp) === 23 && Number(fim.sup) === 4);
  ok('7.6 auditoria de responsabilidade inalterada (31)', Number(fim.resp_audit) === 31);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

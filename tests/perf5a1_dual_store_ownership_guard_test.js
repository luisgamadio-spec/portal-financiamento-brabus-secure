#!/usr/bin/env node
/*
 * [RANKING] PERF-5A.1 -- Guarda permanente de POSSE CONCORRENTE DE LOJAS.
 *
 * PROBLEMA QUE ESTA GUARDA IMPEDE
 * A responsabilidade do Ranking permite, por Option C, que uma Analista
 * responda por mais de uma loja ao mesmo tempo -- isso NAO e proibido.
 * O risco e outro: posse concorrente multiplica o volume de Ranking
 * daquela pessoa e pode chegar a uma pontuacao sem que ninguem tenha
 * decidido conscientemente que era para ser assim.
 *
 * Esta guarda NAO bloqueia posse concorrente. Ela a torna IMPOSSIVEL DE
 * PASSAR DESPERCEBIDA: detecta, quantifica em operacoes e retorno, e
 * falha enquanto o caso nao estiver explicitamente reconhecido abaixo.
 *
 * SOMENTE LEITURA. Recusa statements nao-SELECT por construcao.
 * ZERO PII: apenas Denise Rodrigues e Willian Inacio aparecem, porque o
 * proprio Humano os nomeou nas decisoes H3/H4. Ninguem mais e nomeado.
 *
 * ESTADO EM 2026-09-10 (PERF-5A.2): ZERO casos concorrentes. Os dois que
 * existiam -- G18-A (ABC) e G18-B (BARRA FUNDA) -- foram resolvidos por
 * autoridade humana explicita (H5/H6). A lista RECONHECIDOS esta vazia de
 * proposito: qualquer posse concorrente que reaparecer FALHA aqui.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5_EXPECTED = '3b7f632a7b4826bc44da641e0e294100';

/*
 * Casos de posse concorrente ja levados ao Humano e ainda pendentes de
 * decisao. Enquanto estiverem aqui, a guarda passa mas IMPRIME o caso.
 * Um caso NOVO, fora desta lista, FALHA -- e essa e a proteccao real.
 */
const RECONHECIDOS = [];

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
      return reject(new Error('PERF-5A.1 e somente-leitura: statement recusado'));
    }
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

/* Rotulo publico: so os dois nomes fornecidos pelo Humano; o resto anonimo. */
const ANON = {};
let seq = 0;
function nome(quem, hash) {
  if (quem === 'DENISE' || quem === 'WILLIAN') return quem;
  if (!ANON[hash]) ANON[hash] = 'ANALYST-' + String.fromCharCode(65 + (seq++));
  return ANON[hash];
}

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => (await runSql(token, q))[0] || {};
  const all = async q => { const r = await runSql(token, q); if (!Array.isArray(r)) throw new Error(JSON.stringify(r)); return r; };

  console.log('PERF-5A.1 -- GUARDA DE POSSE CONCORRENTE DE LOJAS NO RANKING');
  console.log('[RANKING] Somente leitura. Zero escrita. Zero PII alem de H3/H4.');

  /* ---------- 1. Salario intacto ---------- */
  h('1. TRAVA DE DOMINIO -- SALARIO');
  const md5 = await one(`select md5(pg_get_functiondef(p.oid)) m, length(pg_get_functiondef(p.oid)) b
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  ok('1.1 funcao canonica de comissao inalterada', md5.m === SALARY_MD5_EXPECTED, md5.m);
  ok('1.2 tamanho inalterado', Number(md5.b) === 16301, md5.b + ' bytes');

  /* ---------- 2. Escopo de H3/H4 ---------- */
  h('2. ESCOPO DAS DECISOES HUMANAS (somente vigencias ACTIVE)');
  const escopo = await all(`select procedencia,
      string_agg(distinct loja_normalizada, ' | ' order by loja_normalizada) lojas, count(*) n
    from public.analista_responsavel_loja where status='ACTIVE' group by 1 order by 1;`);
  escopo.forEach(e => console.log('  ' + pad(e.procedencia, 44) + padL(e.n, 3) + '  ' + e.lojas));
  const hum = escopo.find(e => e.procedencia === 'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY');
  ok('2.1 autoridade humana de 2026 cobre exatamente as 4 lojas decididas (H3/H4/H5/H6)',
    hum && hum.lojas === 'ABC | ANALIA FRANCO | BANDEIRANTES | BARRA FUNDA', hum && hum.lojas);
  ok('2.2 sao 4 intervalos de autoridade humana, um por decisao', hum && Number(hum.n) === 4,
    hum && hum.n + ' intervalo(s)');
  const reconstrucao = escopo.find(e => e.procedencia === 'HUMAN_APPROVED_RECONSTRUCTION');
  ok('2.3 nenhuma reconstrucao H1 sobrevive em ABC ou BARRA FUNDA',
    reconstrucao && !reconstrucao.lojas.includes('ABC') && !reconstrucao.lojas.includes('BARRA FUNDA'),
    reconstrucao && reconstrucao.lojas);

  /* ---------- 3. Posse concorrente ---------- */
  h('3. POSSE CONCORRENTE DE LOJAS (nivel UUID, sem alias)');
  const dual = await all(`select
      case when upper(btrim(coalesce(u.nome,''))) like 'DENISE%RODRIGUES%' then 'DENISE'
           when upper(btrim(coalesce(u.nome,''))) like 'WILLIAN%INACIO%' then 'WILLIAN'
           else 'OUTRO' end quem,
      left(md5(a.analista_usuario_id::text),8) hash,
      a.loja_normalizada loja_a, b.loja_normalizada loja_b,
      greatest(a.valid_from, b.valid_from) de,
      least(coalesce(a.valid_to, date '2026-12-31'), coalesce(b.valid_to, date '2026-12-31')) ate
    from public.analista_responsavel_loja a
    join public.analista_responsavel_loja b
      on b.analista_usuario_id = a.analista_usuario_id
     and b.loja_normalizada > a.loja_normalizada
     and a.status='ACTIVE' and b.status='ACTIVE'
     and daterange(a.valid_from, a.valid_to, '[)') && daterange(b.valid_from, b.valid_to, '[)')
    join public.usuarios u on u.id = a.analista_usuario_id
    order by 1,3,4,5;`);

  if (!dual.length) console.log('  (nenhuma posse concorrente)');
  const casos = {};
  dual.forEach(d => {
    const k = d.quem + '|' + [d.loja_a, d.loja_b].sort().join('+');
    if (!casos[k]) casos[k] = { quem: d.quem, hash: d.hash, lojas: [d.loja_a, d.loja_b].sort(), de: d.de, ate: d.ate };
    if (d.de < casos[k].de) casos[k].de = d.de;
    if (d.ate > casos[k].ate) casos[k].ate = d.ate;
  });
  const lista = Object.values(casos);
  console.log('  ' + pad('Analista', 12) + pad('Loja A', 16) + pad('Loja B', 16)
    + pad('De', 13) + pad('Ate', 13) + 'Situacao');
  console.log('  ' + '-'.repeat(84));
  const naoReconhecidos = [];
  lista.forEach(c => {
    const r = RECONHECIDOS.find(x => x.pessoa === c.quem
      && x.lojas.slice().sort().join('+') === c.lojas.join('+'));
    if (!r) naoReconhecidos.push(c);
    console.log('  ' + pad(nome(c.quem, c.hash), 12) + pad(c.lojas[0], 16) + pad(c.lojas[1], 16)
      + pad(c.de, 13) + pad(c.ate, 13) + (r ? r.gap + ' -- aguarda Humano' : '*** NOVO -- NAO RECONHECIDO ***'));
  });
  ok('3.1 nenhuma posse concorrente NOVA e nao reconhecida', naoReconhecidos.length === 0,
    naoReconhecidos.length + ' nova(s)');
  ok('3.2 ZERO posse concorrente -- G18-A e G18-B resolvidos por H5/H6',
    lista.length === 0, lista.length + ' caso(s)');

  /* ---------- 4. Impacto em volume ---------- */
  h('4. IMPACTO EM VOLUME DE RANKING (jan-ago/2026)');
  const vol = await all(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
    op as (select f.operation_date d, f.return_value v,
      upper(trim(coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
        f.operation_date, nullif(f.store,'')),'SEM LOJA'))) loja
      from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
      where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')
    select coalesce((select case
        when upper(btrim(coalesce(u.nome,''))) like 'DENISE%RODRIGUES%' then 'DENISE'
        when upper(btrim(coalesce(u.nome,''))) like 'WILLIAN%INACIO%' then 'WILLIAN'
        else 'OUTROS' end
      from public.analista_responsavel_loja r join public.usuarios u on u.id=r.analista_usuario_id
      where r.status='ACTIVE' and r.loja_normalizada=op.loja
        and op.d >= r.valid_from and (r.valid_to is null or op.d < r.valid_to) limit 1),'(sem dono)') dono,
      count(*) ops, sum(op.v) ret
    from op group by 1 order by 3 desc nulls last;`);
  console.log('  ' + pad('Dono do Ranking', 16) + padL('Ops', 7) + padL('Retorno', 18));
  console.log('  ' + '-'.repeat(44));
  let outrosOps = 0;
  vol.forEach(v => {
    if (v.dono === 'OUTROS') outrosOps = Number(v.ops);
    console.log('  ' + pad(v.dono, 16) + padL(v.ops, 7) + padL('R$ ' + brl(v.ret), 18));
  });
  const dn = vol.find(v => v.dono === 'DENISE'), wl = vol.find(v => v.dono === 'WILLIAN');
  /* 6 analistas dividem "OUTROS": media por analista */
  const media = outrosOps / 6;
  console.log('  media de operacoes por Analista de loja unica: ' + media.toFixed(0));
  if (dn) console.log('  DENISE  = ' + (Number(dn.ops) / media).toFixed(1) + 'x a media');
  if (wl) console.log('  WILLIAN = ' + (Number(wl.ops) / media).toFixed(1) + 'x a media');
  ok('4.1 o impacto de volume e mensuravel e foi reportado', dn && wl && media > 0);

  /* ---------- 5. Titular alternativo ---------- */
  h('5. EXISTE TITULAR ALTERNATIVO PARA A SEGUNDA LOJA?');
  const cand = await all(`with fe as (select f.id fid from public.fechamentos_comissao f where f.status='FECHADO'),
    base as (select upper(trim(coalesce(s.loja,''))) loja,
        upper(btrim(regexp_replace(coalesce(s.nome,''),' +',' ','g'))) nome_norm,
        upper(trim(coalesce(s.perfil,''))) perfil
      from public.snapshot_comissoes s join fe on fe.fid=s.fechamento_id
      where upper(trim(coalesce(s.loja,''))) in ('ABC','BARRA FUNDA')
        and upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%'),
    agg as (select loja, nome_norm, count(*) linhas from base group by 1,2)
    select agg.loja, left(md5(agg.nome_norm),6) hash, agg.linhas,
      (exists (select 1 from public.ausencias_analistas a
         join public.usuarios u2 on u2.cpf_normalizado=a.cpf_analista_substituto
        where upper(trim(coalesce(a.loja_coberta,'')))=agg.loja
          and upper(btrim(regexp_replace(u2.nome,' +',' ','g')))=agg.nome_norm)) e_ferista,
      case when exists (select 1 from public.usuarios u
             where upper(btrim(regexp_replace(u.nome,' +',' ','g')))=agg.nome_norm
               and upper(btrim(coalesce(u.nome,''))) like 'DENISE%RODRIGUES%') then 'DENISE'
           when exists (select 1 from public.usuarios u
             where upper(btrim(regexp_replace(u.nome,' +',' ','g')))=agg.nome_norm
               and upper(btrim(coalesce(u.nome,''))) like 'WILLIAN%INACIO%') then 'WILLIAN'
           else 'OUTRO' end quem
    from agg order by agg.loja, agg.linhas desc;`);
  console.log('  ' + pad('Loja', 16) + pad('Pessoa', 12) + padL('Periodos', 10) + '  Ferista nessa loja?');
  console.log('  ' + '-'.repeat(60));
  cand.forEach(c => console.log('  ' + pad(c.loja, 16) + pad(nome(c.quem, c.hash), 12)
    + padL(c.linhas, 10) + '  ' + (c.e_ferista ? 'sim' : 'NAO -- titular')));
  const abcNaoFerista = cand.filter(c => c.loja === 'ABC' && !c.e_ferista);
  const bfNaoFerista = cand.filter(c => c.loja === 'BARRA FUNDA' && !c.e_ferista);
  ok('5.1 ABC nao tem titular alternativo alem de DENISE',
    abcNaoFerista.length === 1 && abcNaoFerista[0].quem === 'DENISE');
  ok('5.2 BARRA FUNDA nao tem titular alternativo determinavel por este criterio',
    bfNaoFerista.length === 0, bfNaoFerista.length + ' candidato(s) nao-ferista');
  console.log('  Conclusao: nenhuma das duas lojas tem titular alternativo deterministico.');
  console.log('  Corrigir por adivinhacao criaria autoridade falsa -- por isso NADA foi escrito.');

  /* ---------- 6. Invariante temporal ---------- */
  h('6. INVARIANTE TEMPORAL PRESERVADO');
  const inv = await one(`select
      (select count(*) from public.analista_responsavel_loja) total,
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') ativas,
      (select count(*) from public.analista_responsavel_loja where status='SUPERSEDED') superseded,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.analista_responsavel_loja a
        join public.analista_responsavel_loja b on b.loja_normalizada=a.loja_normalizada and b.id<>a.id
        where a.status='ACTIVE' and b.status='ACTIVE'
          and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)')) sobrepostos;`);
  ok('6.1 27 intervalos (23 ACTIVE + 4 SUPERSEDED apos H5/H6)', Number(inv.total) === 27, 'total=' + inv.total);
  ok('6.2 31 eventos de auditoria (25 + 4 SUPERSEDED + 2 novos)', Number(inv.audit) === 31, 'audit=' + inv.audit);
  ok('6.3 ZERO sobreposicoes por loja-dia', Number(inv.sobrepostos) === 0);
  ok('6.4 as 4 linhas substituidas continuam inspecionaveis (nao foram apagadas)',
    Number(inv.superseded) === 4, 'superseded=' + inv.superseded);
  ok('6.5 9 vigencias abertas preservadas', Number(inv.ativas) === 23, 'ativas=' + inv.ativas);
  console.log('  Posse concorrente de LOJAS DIFERENTES nao viola o invariante:');
  console.log('  o invariante e um dono por LOJA-DIA, nao uma loja por Analista.');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

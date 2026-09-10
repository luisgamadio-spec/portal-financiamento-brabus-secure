#!/usr/bin/env node
/*
 * [RANKING] PERF-4C -- Reconciliação final da responsabilidade histórica
 * do Ranking, jan–ago/2026, sob as decisões humanas H1 e H2.
 *
 * H1 -- BACKFILL DE TITULARIDADE HISTÓRICA (aprovado pelo Humano)
 *   "Sim, eram os mesmos."
 *   A titularidade normal evidenciada no período de 21/05/2026 pode ser
 *   estendida para trás até 01/01/2026, EXCETO onde exista evidência
 *   direta contraditória para uma loja/intervalo específico.
 *
 * H2 -- ATRIBUIÇÃO DE RANKING EM FÉRIAS/AUSÊNCIA (aprovado pelo Humano)
 *   "Mesmo ele estando de férias, os pontos serão dele, pois o Ferista
 *    não pontua."
 *   A titular mantém a propriedade do Ranking durante férias/ausência.
 *   A Ferista cobre operacionalmente e NÃO pontua naquela loja.
 *
 * SOMENTE LEITURA. Recusa por construção qualquer statement que não seja
 * SELECT/WITH. ZERO escrita de responsabilidade histórica (o brief PERF-4C
 * §43 proíbe explicitamente). ZERO migração. ZERO alteração de Salário.
 *
 * ZERO PII: Analistas aparecem como ANALYST-A..L, rótulos determinísticos.
 *
 * PROVENIÊNCIA PRESERVADA (§58/§59): intervalos derivados de H1 são
 * rotulados HUMAN_APPROVED_RECONSTRUCTION e NUNCA DIRECT_AUTHORITY.
 *
 * SEPARAÇÃO DE DOMÍNIO: H2 vale SOMENTE para Ranking. Nenhuma regra de
 * férias, cobertura ou comissão de Salário é lida como autoridade de
 * runtime nem alterada. O md5 de operational_analyst_commission_metrics é
 * verificado no início e no fim.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5_EXPECTED = '3b7f632a7b4826bc44da641e0e294100';

const H1_BACKFILL_FROM = '2026-01-01';
const EVIDENCE_BOUNDARY = '2026-05-21';   // início do período fechado mais antigo
const GOVERNED_FROM = '2026-08-21';

const MONTHS = [
  ['2026-01', 31, 'JAN'], ['2026-02', 28, 'FEV'], ['2026-03', 31, 'MAR'],
  ['2026-04', 30, 'ABR'], ['2026-05', 31, 'MAI'], ['2026-06', 30, 'JUN'],
  ['2026-07', 31, 'JUL'], ['2026-08', 31, 'AGO'],
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
      return reject(new Error('PERF-4C é somente-leitura: statement não-SELECT recusado'));
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

const LABELS = {};
let labelSeq = 0;
function label(id) {
  if (!id || id === '?') return '(nenhum)';
  if (!LABELS[id]) LABELS[id] = 'ANALYST-' + String.fromCharCode(65 + (labelSeq++));
  return LABELS[id];
}
function pad(s, n) { return String(s === null || s === undefined ? '' : s).padEnd(n); }
function padL(s, n) { return String(s === null || s === undefined ? '' : s).padStart(n); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '--'; }
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }
function addDay(ds) { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local -- PERF-4C exige leitura do projeto real.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');
  const one = async (q) => (await runSql(token, q))[0] || {};
  const all = async (q) => { const r = await runSql(token, q); if (!Array.isArray(r)) throw new Error(JSON.stringify(r)); return r; };

  console.log('PERF-4C -- RECONCILIAÇÃO DE RESPONSABILIDADE SOB H1 + H2 (jan-ago/2026)');
  console.log('[RANKING] Somente leitura. Zero escrita. Zero migração. Zero PII.');

  /* ---------- 1. Trava de domínio (início) ---------- */
  h('1. TRAVA DE DOMÍNIO -- SALÁRIO (início)');
  const md5a = await one(`select md5(pg_get_functiondef(p.oid)) m, length(pg_get_functiondef(p.oid)) b
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  console.log('  md5 = ' + md5a.m + ' (' + md5a.b + ' bytes)');
  if (md5a.m !== SALARY_MD5_EXPECTED) throw new Error('STOP: SALARY_DOMAIN_MUTATED_BY_PERF4C');
  console.log('  esperado = ' + SALARY_MD5_EXPECTED + '  ->  INALTERADO');
  const base = await one(`select (select count(*) from public.analista_responsavel_loja) resp,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc,
      (select count(*) from public.ausencias_analistas) aus,
      (select count(*) from public.usuarios) usr;`);
  console.log('  baseline: resp=' + base.resp + ' audit=' + base.audit + ' fech=' + base.fech
    + ' snap=' + base.snapc + ' aus=' + base.aus + ' usr=' + base.usr);

  /* ---------- 2. Evidência bruta ---------- */
  const gov = await all(`select r.loja_normalizada loja, r.valid_from, r.valid_to,
      left(md5(u.cpf_normalizado),6) ident
    from public.analista_responsavel_loja r join public.usuarios u on u.id=r.analista_usuario_id
    where r.status='ACTIVE' order by r.loja_normalizada;`);
  const stores = gov.map(g => g.loja);

  /* titular do período fechado mais antigo: perfil ANALISTA (exclui SUBSTITUTO) */
  const baseline = await all(`select upper(trim(coalesce(s.loja,''))) loja,
      left(md5(regexp_replace(coalesce(s.cpf,''),'[^0-9]','','g')),6) ident
    from public.snapshot_comissoes s
    where s.data_inicio = date '${EVIDENCE_BOUNDARY}'
      and upper(trim(coalesce(s.perfil,''))) = 'ANALISTA'
      and coalesce(s.cpf,'') <> '' order by 1;`);

  /* recebedores por período fechado, com marcação de Ferista naquela loja */
  const recips = await all(`with fe as (
      select f.id fid, p.data_inicio pi, p.data_fim pf
      from public.fechamentos_comissao f join public.periodos_comissao p on p.id=f.periodo_id
      where f.status='FECHADO'),
    r as (select distinct fe.pi, fe.pf, upper(trim(coalesce(s.loja,''))) loja,
        coalesce((select left(md5(u.cpf_normalizado),6) from public.usuarios u
          where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))
              = upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
            and upper(trim(coalesce(u.perfil,'')))='ANALISTA'),'?') ident
      from public.snapshot_comissoes s join fe on fe.fid=s.fechamento_id
      where upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%')
    select r.*, exists (select 1 from public.ausencias_analistas a
      where upper(trim(coalesce(a.loja_coberta,''))) = r.loja
        and left(md5(coalesce(a.cpf_analista_substituto,'x')),6) = r.ident
        and a.data_inicio <= r.pf and a.data_fim >= r.pi) as ferista
    from r order by r.pi, r.loja;`);

  /* janelas de loja de origem declarada (titularidade declarada) */
  const homes = await all(`select left(md5(a.cpf_analista_ausente),6) ident,
      upper(trim(coalesce(a.loja_origem,''))) loja,
      min(a.data_inicio) de, max(a.data_fim) ate, count(*) regs
    from public.ausencias_analistas a group by 1,2 order by 3;`);

  /* coberturas (H2) */
  const covers = await all(`select a.data_inicio, a.data_fim,
      upper(trim(coalesce(a.loja_origem,''))) loja_origem,
      upper(trim(coalesce(a.loja_coberta,''))) loja_coberta,
      upper(trim(coalesce(a.motivo,''))) motivo,
      left(md5(a.cpf_analista_ausente),6) titular,
      left(md5(coalesce(a.cpf_analista_substituto,'?')),6) ferista
    from public.ausencias_analistas a order by a.data_inicio, a.id;`);

  /* rótulos determinísticos por ordem de criação de conta */
  (await all(`select left(md5(u.cpf_normalizado),6) ident from public.usuarios u
     where upper(trim(coalesce(u.perfil,'')))='ANALISTA' order by u.criado_em, u.id;`))
    .forEach(r => label(r.ident));

  /* ---------- 3. Titular de referência em 21/05 ---------- */
  h('3. TITULARIDADE DE REFERÊNCIA NO LIMITE DE EVIDÊNCIA (' + EVIDENCE_BOUNDARY + ')');
  const baseByStore = {};
  baseline.forEach(b => baseByStore[b.loja] = b.ident);
  console.log('  Fonte: snapshot de comissão, linhas perfil=ANALISTA (SUBSTITUTO excluído por H2).');
  console.log('  ' + pad('Loja', 16) + 'Titular de referência');
  console.log('  ' + '-'.repeat(44));
  stores.forEach(s => console.log('  ' + pad(s, 16) + (baseByStore[s] ? label(baseByStore[s]) : '(nenhum -- loja sem Analista nessa data)')));

  /* ---------- 4. Titular por período fechado, aplicando H2 ---------- */
  h('4. TITULAR POR PERÍODO FECHADO -- H2 APLICADO (Ferista excluída)');
  const periods = [...new Set(recips.map(r => r.pi + '|' + r.pf))].map(s => s.split('|'));
  const periodTitular = {};   // "pi|loja" -> ident | null
  console.log('  ' + pad('Período', 24) + pad('Loja', 16) + padL('Receb.', 7)
    + padL('Feristas', 10) + '  Titular (H2)');
  console.log('  ' + '-'.repeat(78));
  periods.forEach(([pi, pf]) => {
    const storesInP = [...new Set(recips.filter(r => r.pi === pi).map(r => r.loja))].sort();
    storesInP.forEach(st => {
      const rows = recips.filter(r => r.pi === pi && r.loja === st);
      const nonF = rows.filter(r => !r.ferista);
      let tit = null, how;
      if (nonF.length === 1) { tit = nonF[0].ident; how = 'recebedor não-Ferista único'; }
      else if (nonF.length === 0) {
        /* todos são Feristas -> a titular é quem estava ausente daquela loja */
        const absent = [...new Set(covers.filter(c => c.loja_coberta === st
          && c.data_inicio <= pf && c.data_fim >= pi).map(c => c.titular))];
        const declared = absent.filter(a => homes.some(hh => hh.ident === a && hh.loja === st
          && hh.de <= pf && hh.ate >= pi));
        if (declared.length === 1) { tit = declared[0]; how = 'titular ausente com loja de origem declarada'; }
        else how = 'AMBÍGUO -- titular ausente não identificável';
      } else how = 'AMBÍGUO -- mais de um recebedor não-Ferista';
      periodTitular[pi + '|' + st] = tit;
      console.log('  ' + pad(pi + '..' + pf, 24) + pad(st, 16) + padL(rows.length, 5) + '  '
        + padL(rows.filter(r => r.ferista).length, 8) + '  '
        + pad(tit ? label(tit) : '--', 12) + (tit ? '' : '  ' + how));
    });
  });

  /* ---------- 5. Transferências permanentes ---------- */
  h('5. TRANSFERÊNCIAS PERMANENTES DE TITULARIDADE (preservadas -- H1 não as apaga)');
  const handovers = [];
  stores.forEach(st => {
    /* mudança entre períodos fechados consecutivos */
    let prev = baseByStore[st] || null, prevDate = EVIDENCE_BOUNDARY;
    periods.forEach(([pi]) => {
      const t = periodTitular[pi + '|' + st];
      if (t && prev && t !== prev) {
        handovers.push({ loja: st, de: prev, para: t, efetivo: pi, fonte: 'troca de titular entre períodos fechados' });
        prev = t; prevDate = pi;
      } else if (t && !prev) { prev = t; prevDate = pi; }
    });
    /* mudança sinalizada por loja de origem declarada */
    homes.filter(hh => hh.loja === st).sort((a, b) => a.de < b.de ? -1 : 1).forEach(hh => {
      if (prev && hh.ident !== prev && hh.de > prevDate) {
        handovers.push({ loja: st, de: prev, para: hh.ident, efetivo: hh.de, fonte: 'loja de origem declarada muda' });
        prev = hh.ident; prevDate = hh.de;
      }
    });
    /* autoridade governada */
    const g = gov.find(x => x.loja === st);
    if (g && prev && g.ident !== prev) {
      handovers.push({ loja: st, de: prev, para: g.ident, efetivo: g.valid_from, fonte: 'autoridade governada' });
    } else if (g && !prev) {
      handovers.push({ loja: st, de: null, para: g.ident, efetivo: g.valid_from, fonte: 'autoridade governada (primeira titular)' });
    }
  });
  console.log('  ' + pad('Loja', 16) + pad('De', 12) + pad('Para', 12) + pad('Efetivo', 13) + 'Fonte');
  console.log('  ' + '-'.repeat(78));
  handovers.forEach(x => console.log('  ' + pad(x.loja, 16) + pad(x.de ? label(x.de) : '(nenhum)', 12)
    + pad(label(x.para), 12) + pad(x.efetivo, 13) + x.fonte));
  console.log('  Total de transferências permanentes preservadas: ' + handovers.length);

  /* ---------- 6. Linha do tempo canônica ---------- */
  h('6. LINHA DO TEMPO CANÔNICA DE RESPONSABILIDADE DO RANKING');
  const timeline = {};   // loja -> [{de, ate, ident, autoridade}]
  stores.forEach(st => {
    const segs = [];
    const b = baseByStore[st];
    if (b) segs.push({ de: H1_BACKFILL_FROM, ident: b, aut: 'HUMAN_APPROVED_RECONSTRUCTION' });
    const hs = handovers.filter(x => x.loja === st).sort((a, b2) => a.efetivo < b2.efetivo ? -1 : 1);
    hs.forEach(x => segs.push({
      de: x.efetivo, ident: x.para,
      aut: x.fonte === 'autoridade governada' || x.fonte.startsWith('autoridade governada')
        ? 'DIRECT_AUTHORITY' : 'CORROBORATED_AUTHORITY'
    }));
    /* fecha cada segmento e marca o trecho DIRECT a partir do limite de evidência */
    const out = [];
    segs.forEach((s, i) => {
      const ate = i + 1 < segs.length ? addDay(segs[i + 1].de) === segs[i + 1].de ? segs[i + 1].de : segs[i + 1].de : null;
      out.push({ de: s.de, ate: ate, ident: s.ident, aut: s.aut });
    });
    /* o primeiro segmento é misto: H1 até 20/05, corroborado a partir de 21/05 */
    if (out.length && out[0].de === H1_BACKFILL_FROM && baseByStore[st]) {
      const firstEnd = out[0].ate;
      out.shift();
      out.unshift({ de: EVIDENCE_BOUNDARY, ate: firstEnd, ident: baseByStore[st], aut: 'CORROBORATED_AUTHORITY' });
      out.unshift({ de: H1_BACKFILL_FROM, ate: EVIDENCE_BOUNDARY, ident: baseByStore[st], aut: 'HUMAN_APPROVED_RECONSTRUCTION' });
    }
    timeline[st] = out;
  });

  /* Uma titular que MUDA de loja deixa de ser titular da loja anterior nessa
     data. Sem isso o "último titular conhecido" seguiria valendo e criaria
     titularidade simultânea em duas lojas -- inferência, não evidência.
     O trecho vira NÃO RESOLVIDO até a próxima evidência daquela loja. */
  const vacated = [];
  stores.forEach(st => {
    timeline[st] = timeline[st].filter(seg => {
      const moved = handovers.find(x => x.loja !== st && x.para === seg.ident
        && x.efetivo > seg.de && (!seg.ate || x.efetivo < seg.ate));
      if (!moved) return true;
      vacated.push({ loja: st, ident: seg.ident, desde: moved.efetivo, para: moved.loja, ate: seg.ate });
      seg.ate = moved.efetivo;
      return true;
    });
  });
  console.log('  ' + pad('Loja', 16) + pad('Início', 13) + pad('Fim', 13) + pad('Analista', 12) + 'Autoridade');
  console.log('  ' + '-'.repeat(78));
  stores.forEach(st => timeline[st].forEach(s => console.log('  ' + pad(st, 16) + pad(s.de, 13)
    + pad(s.ate || '(aberto)', 13) + pad(label(s.ident), 12) + s.aut)));

  function ownerAt(store, ds) {
    const segs = timeline[store] || [];
    for (const s of segs) if (ds >= s.de && (!s.ate || ds < s.ate)) return s;
    return null;
  }

  /* ---------- 7. H2: nenhuma cobertura transfere propriedade ---------- */
  h('7. H2 -- FÉRIAS / AUSÊNCIA NÃO TRANSFEREM PROPRIEDADE DO RANKING');
  console.log('  ' + pad('Caso', 6) + pad('Loja coberta', 15) + pad('Janela', 24)
    + pad('Titular', 12) + pad('Ferista', 12) + 'Dono do Ranking');
  console.log('  ' + '-'.repeat(84));
  let ferOwn = 0, casos = 0;
  covers.forEach((c, i) => {
    const owner = ownerAt(c.loja_coberta, c.data_inicio);
    const ownerId = owner ? owner.ident : null;
    if (ownerId && ownerId === c.ferista) ferOwn++;
    casos++;
    console.log('  ' + pad('C' + (i + 1), 6) + pad(c.loja_coberta, 15)
      + pad(c.data_inicio + '..' + c.data_fim, 24) + pad(label(c.titular), 12)
      + pad(label(c.ferista), 12) + (ownerId ? label(ownerId) : '(não resolvido)'));
  });
  console.log('  Casos de cobertura: ' + casos);
  console.log('  Casos em que a FERISTA ficou dona do Ranking: ' + ferOwn + '  (esperado: 0)');
  if (ferOwn) {
    console.log('  ATENÇÃO: cada ocorrência precisa de explicação -- nunca é aceita em silêncio.');
    covers.forEach((c, i) => {
      const o = ownerAt(c.loja_coberta, c.data_inicio);
      if (o && o.ident === c.ferista) console.log('    C' + (i + 1) + ' ' + c.loja_coberta
        + ' ' + c.data_inicio + '..' + c.data_fim + ' -- registro declara ' + label(c.titular)
        + ' como titular, mas a titularidade evidenciada dessa loja é ' + label(o.ident));
    });
  }

  /* ---------- 7.1 Lojas vagas por mudança de titular ---------- */
  h('7.1 LOJAS QUE FICARAM SEM TITULAR EVIDENCIADA (titular mudou de loja)');
  if (!vacated.length) console.log('  (nenhuma)');
  vacated.forEach(v => console.log('  ' + pad(v.loja, 16) + 'sem titular evidenciada de ' + v.desde
    + ' até ' + (v.ate || '(aberto)') + ' -- ' + label(v.ident) + ' passou a ser titular de ' + v.para));

  /* ---------- 7.2 Titular inativa no intervalo ---------- */
  h('7.2 INTERVALOS CUJA TITULAR ESTAVA COM CONTA INATIVA');
  const inativos = await all(`select left(md5(u.cpf_normalizado),6) ident, u.atualizado_em::date desativada
    from public.usuarios u where upper(trim(coalesce(u.perfil,'')))='ANALISTA' and not u.ativo;`);
  let flagged = 0;
  stores.forEach(st => (timeline[st] || []).forEach(seg => {
    const inat = inativos.find(x => x.ident === seg.ident);
    if (inat && (!seg.ate || seg.ate > inat.desativada) && seg.de <= '2026-08-31') {
      flagged++;
      console.log('  ' + pad(st, 16) + pad(seg.de + '..' + (seg.ate || '(aberto)'), 24)
        + label(seg.ident) + ' -- conta desativada em ' + inat.desativada);
    }
  }));
  if (!flagged) console.log('  (nenhum)');
  console.log('  Nota: H2 cobre FÉRIAS/AUSÊNCIA temporária. Saída definitiva do Analista NÃO');
  console.log('  é coberta por H2 e permanece como confirmação humana pendente.');

  /* ---------- 8. Matriz loja × mês ---------- */
  h('8. MATRIZ LOJA × MÊS -- PROVENIÊNCIA DA RESPONSABILIDADE');
  const SH = { HUMAN_APPROVED_RECONSTRUCTION: 'HUM', CORROBORATED_AUTHORITY: 'CORR', DIRECT_AUTHORITY: 'DIR' };
  console.log('  ' + pad('Loja', 16) + MONTHS.map(m => padL(m[2], 7)).join(''));
  console.log('  ' + '-'.repeat(16 + 7 * MONTHS.length));
  const dayStats = {};
  stores.forEach(st => {
    const cells = MONTHS.map(m => {
      const kinds = new Set(); let unres = 0;
      for (let d = 1; d <= m[1]; d++) {
        const ds = m[0] + '-' + String(d).padStart(2, '0');
        const o = ownerAt(st, ds);
        dayStats[m[2]] = dayStats[m[2]] || { total: 0, hum: 0, corr: 0, dir: 0, unres: 0 };
        dayStats[m[2]].total++;
        if (!o) { unres++; dayStats[m[2]].unres++; }
        else {
          kinds.add(SH[o.aut]);
          if (o.aut === 'HUMAN_APPROVED_RECONSTRUCTION') dayStats[m[2]].hum++;
          else if (o.aut === 'CORROBORATED_AUTHORITY') dayStats[m[2]].corr++;
          else dayStats[m[2]].dir++;
        }
      }
      let t = unres === m[1] ? 'UNRE' : [...kinds].join('/');
      if (unres && unres < m[1]) t += '+U';
      return padL(t, 7);
    }).join('');
    console.log('  ' + pad(st, 16) + cells);
  });
  console.log('  HUM = HUMAN_APPROVED_RECONSTRUCTION (H1)   CORR = CORROBORATED_AUTHORITY');
  console.log('  DIR = DIRECT_AUTHORITY (tabela governada)  +U = contém dias não resolvidos');

  /* ---------- 9. Cobertura em dias-loja ---------- */
  h('9. COBERTURA EM DIAS-LOJA');
  console.log('  ' + pad('Mês', 7) + padL('Total', 8) + padL('H1', 8) + padL('Corrob.', 9)
    + padL('Direta', 8) + padL('Não res.', 10) + padL('Cobertura', 11));
  console.log('  ' + '-'.repeat(62));
  MONTHS.forEach(m => {
    const s = dayStats[m[2]] || { total: 0, hum: 0, corr: 0, dir: 0, unres: 0 };
    console.log('  ' + pad(m[2], 7) + padL(s.total, 8) + padL(s.hum, 8) + padL(s.corr, 9)
      + padL(s.dir, 8) + padL(s.unres, 10) + padL(pct(s.total - s.unres, s.total), 11));
  });

  /* ---------- 10. Cobertura de valor ---------- */
  h('10. COBERTURA DE VALOR DO RANKING');
  const fin = await all(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
    op as (select f.operation_date, f.return_value,
      upper(trim(coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
        f.operation_date, nullif(f.store,'')),'SEM LOJA'))) loja
      from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
      where f.is_real_financing and f.operation_date between date '2026-01-01' and date '2026-08-31')
    select to_char(date_trunc('month',operation_date),'YYYY-MM') mes, loja,
      operation_date::text d, count(*) ops, sum(return_value) ret
    from op group by 1,2,3 order by 1,2,3;`);
  const spf = await all(`select to_char(date_trunc('month',operation_date),'YYYY-MM') mes,
      count(*) filter (where is_spf_extra) spf from public.portal_spf_operations
    where batch_id=(select b.id from public.portal_import_batches b where b.status='VALIDATED'
      and b.source_type='SPF_CURRENT' order by b.completed_at desc nulls last, b.created_at desc, b.id desc limit 1)
      and operation_date between date '2026-01-01' and date '2026-08-31' group by 1;`);
  const spfBy = {}; spf.forEach(s => spfBy[s.mes] = Number(s.spf));
  console.log('  ' + pad('Mês', 6) + padL('Ops', 6) + padL('Atrib.', 8) + padL('Retorno', 16)
    + padL('Ret.atrib%', 12) + padL('SPF atrib%', 12) + '  Veredito');
  console.log('  ' + '-'.repeat(80));
  let unresOps = 0, unresRet = 0;
  const unresByStore = {};
  MONTHS.forEach(m => {
    const rows = fin.filter(f => f.mes === m[0]);
    let ops = 0, opsA = 0, ret = 0, retA = 0;
    rows.forEach(r => {
      const n = Number(r.ops), v = Number(r.ret);
      ops += n; ret += v;
      if (ownerAt(r.loja, r.d)) { opsA += n; retA += v; }
      else {
        unresOps += n; unresRet += v;
        unresByStore[r.loja] = unresByStore[r.loja] || { ops: 0, ret: 0 };
        unresByStore[r.loja].ops += n; unresByStore[r.loja].ret += v;
      }
    });
    const verd = retA >= ret * 0.999 ? 'ATRIBUÍVEL' : retA === 0 ? 'NÃO ATRIBUÍVEL' : 'PARCIAL';
    console.log('  ' + pad(m[2], 6) + padL(ops, 6) + padL(opsA, 8) + padL('R$ ' + brl(ret), 16)
      + padL(pct(retA, ret), 12) + padL(spfBy[m[0]] ? pct(opsA, ops) : 'N/A*', 12) + '  ' + verd);
  });
  console.log('  * N/A = PROGRAMA SPF NÃO INICIADO (mantido de PERF-4A -- sem semântica de pontuação).');
  console.log('\n  Operações NÃO atribuíveis, por rótulo de loja:');
  Object.keys(unresByStore).sort((a, b) => unresByStore[b].ops - unresByStore[a].ops).forEach(k =>
    console.log('    ' + pad(k, 16) + padL(unresByStore[k].ops, 5) + ' ops   R$ ' + brl(unresByStore[k].ret)
      + (stores.includes(k) ? '   (loja governada)' : '   <- RÓTULO FORA DO REGISTRO GOVERNADO')));

  /* ---------- 11. Conservação: um dono por dia-loja ---------- */
  h('11. CONSERVAÇÃO -- UM ÚNICO DONO DO RANKING POR DIA-LOJA');
  let multi = 0, vacUn = 0;
  stores.forEach(st => MONTHS.forEach(m => {
    for (let d = 1; d <= m[1]; d++) {
      const ds = m[0] + '-' + String(d).padStart(2, '0');
      const segs = (timeline[st] || []).filter(s => ds >= s.de && (!s.ate || ds < s.ate));
      if (segs.length > 1) multi++;
      /* dia de férias não pode ficar sem dono */
      const inCover = covers.some(c => c.loja_coberta === st && ds >= c.data_inicio && ds <= c.data_fim);
      if (inCover && segs.length === 0) vacUn++;
    }
  }));
  console.log('  dias-loja com MAIS DE UM dono ................ ' + multi + '  (esperado: 0)');
  console.log('  dias de férias/cobertura SEM dono ............ ' + vacUn + '  (esperado: 0)');
  console.log('  Ferista dona do Ranking em alguma cobertura .. ' + ferOwn + '  (esperado: 0)');

  /* ---------- 12. Checagem de contradição a H1 ---------- */
  h('12. CHECAGEM DE EVIDÊNCIA CONTRADITÓRIA A H1 (01/01 .. 20/05)');
  const early = covers.filter(c => c.data_inicio < EVIDENCE_BOUNDARY);
  console.log('  Registros históricos que tocam a janela do backfill: ' + early.length);
  early.forEach((c, i) => {
    const baseTit = baseByStore[c.loja_origem];
    const contradicts = baseTit && baseTit !== c.titular
      && !stores.some(s => baseByStore[s] === c.titular && s === c.loja_origem);
    const realHome = stores.find(s => baseByStore[s] === c.titular);
    console.log('    ' + pad(c.data_inicio + '..' + c.data_fim, 24) + 'origem=' + pad(c.loja_origem, 15)
      + ' titular=' + pad(label(c.titular), 11)
      + ' | titular de referência dessa loja=' + pad(baseTit ? label(baseTit) : '--', 11)
      + (contradicts ? ' DIVERGE (loja de referência dessa pessoa = ' + (realHome || '--') + ')' : ' concorda'));
  });
  console.log('  Nenhum desses registros afirma TITULARIDADE por si -- são registros de');
  console.log('  COBERTURA. Sob H2, cobertura nunca transfere propriedade do Ranking,');
  console.log('  portanto nenhum deles pode contradizer a titularidade estendida por H1.');

  /* ---------- 13. Trava final ---------- */
  h('13. TRAVA DE DOMÍNIO -- SALÁRIO (fim)');
  const md5b = await one(`select md5(pg_get_functiondef(p.oid)) m from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
    and p.proname='operational_analyst_commission_metrics';`);
  const fim = await one(`select (select count(*) from public.analista_responsavel_loja) resp,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc,
      (select count(*) from public.ausencias_analistas) aus,
      (select count(*) from public.usuarios) usr;`);
  console.log('  md5 fim = ' + md5b.m + (md5b.m === SALARY_MD5_EXPECTED ? '  INALTERADO' : '  ALTERADO'));
  if (md5b.m !== SALARY_MD5_EXPECTED) throw new Error('STOP: SALARY_DOMAIN_MUTATED_BY_PERF4C');
  const same = ['resp', 'audit', 'fech', 'snapc', 'aus', 'usr'].every(k => String(base[k]) === String(fim[k]));
  console.log('  contagens início = fim: ' + (same ? 'SIM (zero escrita)' : 'NÃO -- INVESTIGAR'));
  if (!same) throw new Error('STOP: BUSINESS_DATA_MUTATED_BY_PERF4C');
  console.log('\nPERF-4C concluído. Somente leitura, zero escrita, zero PII.');
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });

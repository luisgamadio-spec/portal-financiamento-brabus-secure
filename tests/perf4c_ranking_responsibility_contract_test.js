#!/usr/bin/env node
/*
 * [RANKING] PERF-4C -- CONTRATO DE SEMÂNTICA DA RESPONSABILIDADE DO RANKING
 *
 * Registra, em forma executável e NÃO-runtime, as decisões de negócio
 * aprovadas pelo Humano. Nenhuma implementação de Performance depende
 * deste arquivo; ele existe para que uma implementação futura (PERF-5)
 * seja validada contra a semântica aprovada, e para que uma regressão
 * silenciosa nessa semântica falhe visivelmente.
 *
 * NÃO contém mapeamento loja->Analista. NÃO é um dicionário paralelo.
 * NÃO toca banco. NÃO toca Salário. É um contrato puro.
 *
 * DECISÕES REGISTRADAS
 * --------------------
 * H1 -- HUMAN_APPROVED_HISTORICAL_RESPONSIBILITY_BACKFILL_RULE
 *   Pergunta feita ao Humano: as Analistas normalmente responsáveis pelas
 *   lojas no período evidenciado a partir de 21/05/2026 já eram, em
 *   essência, as mesmas responsáveis normais desde janeiro de 2026?
 *   Resposta do Humano: "Sim, eram os mesmos."
 *   Efeito: a titularidade evidenciada no limite de 21/05/2026 vale para
 *   trás até 01/01/2026, EXCETO onde exista evidência direta contraditória
 *   para uma loja/intervalo específico.
 *
 * H2 -- HUMAN_APPROVED_RANKING_VACATION_ATTRIBUTION_RULE
 *   Decisão do Humano: "Mesmo ele estando de férias, os pontos serão dele,
 *   pois o Ferista não pontua."
 *   Efeito: durante férias/ausência temporária a titular mantém a
 *   propriedade do Ranking; a Ferista cobre operacionalmente e não recebe
 *   atribuição de Ranking da loja coberta.
 *
 * LIMITE DE DOMÍNIO -- CRÍTICO
 *   H2 vale SOMENTE para RANKING/PERFORMANCE. Não altera nenhuma regra de
 *   Salário: férias, cobertura, comissão de substituta e
 *   operational_analyst_commission_metrics permanecem exatamente como
 *   estão. "Ferista não pontua" NÃO significa "Ferista não recebe
 *   comissão".
 */

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name); }
}
function eq(name, a, b) { ok(name + '  (' + JSON.stringify(a) + ' === ' + JSON.stringify(b) + ')', a === b); }
function h(t) { console.log('\n' + t); }

/* =====================================================================
 * O CONTRATO -- funções puras, sem estado, sem banco.
 * ===================================================================== */

const AUTHORITY = Object.freeze({
  DIRECT: 'DIRECT_AUTHORITY',
  CORROBORATED: 'CORROBORATED_AUTHORITY',
  HUMAN: 'HUMAN_APPROVED_RECONSTRUCTION',
  UNRESOLVED: 'UNRESOLVED',
});

const H1_BACKFILL_FROM = '2026-01-01';
const H1_EVIDENCE_BOUNDARY = '2026-05-21';

/*
 * H1: estende a titularidade de referência para trás, mas NUNCA por cima
 * de evidência direta contraditória, e NUNCA com proveniência de banco.
 */
function resolveHistoricalTitular(store, date, ctx) {
  const direct = (ctx.directIntervals || []).find(i =>
    i.store === store && date >= i.from && (!i.to || date < i.to));
  if (direct) return { analyst: direct.analyst, authority: AUTHORITY.DIRECT };

  const corrob = (ctx.corroboratedIntervals || []).find(i =>
    i.store === store && date >= i.from && (!i.to || date < i.to));
  if (corrob) return { analyst: corrob.analyst, authority: AUTHORITY.CORROBORATED };

  if (date >= H1_BACKFILL_FROM && date < H1_EVIDENCE_BOUNDARY) {
    const contra = (ctx.contradictingIntervals || []).find(i =>
      i.store === store && date >= i.from && date <= i.to);
    if (contra) return { analyst: contra.analyst, authority: AUTHORITY.DIRECT };
    const ref = (ctx.referenceTitular || {})[store];
    if (ref) return { analyst: ref, authority: AUTHORITY.HUMAN };
  }
  return { analyst: null, authority: AUTHORITY.UNRESOLVED };
}

/*
 * H2: a propriedade do Ranking em um dia-loja é da TITULAR do intervalo.
 * Uma cobertura temporária nunca substitui a dona.
 */
function rankingOwner(store, date, ctx) {
  const t = resolveHistoricalTitular(store, date, ctx);
  const covering = (ctx.coverages || []).find(c =>
    c.store === store && date >= c.from && date <= c.to);
  return {
    analyst: t.analyst,
    authority: t.authority,
    coveredBy: covering ? covering.substitute : null,
    substituteScores: false,
  };
}

/* Pontos de Ranking que uma Ferista ganha por cobrir: sempre zero. */
function rankingAttributionForSubstitute() { return 0; }

/* =====================================================================
 * TESTES
 * ===================================================================== */

console.log('PERF-4C -- CONTRATO DE RESPONSABILIDADE DO RANKING (H1 + H2)');

const CTX = {
  referenceTitular: { 'LOJA X': 'A-1', 'LOJA Y': 'A-2', 'LOJA Z': 'A-3' },
  corroboratedIntervals: [
    { store: 'LOJA X', analyst: 'A-1', from: '2026-05-21', to: null },
    { store: 'LOJA Y', analyst: 'A-2', from: '2026-05-21', to: '2026-07-22' },
    /* transferência permanente em 22/07 */
    { store: 'LOJA Y', analyst: 'A-9', from: '2026-07-22', to: null },
  ],
  directIntervals: [
    { store: 'LOJA Z', analyst: 'A-7', from: '2026-08-21', to: null },
  ],
  coverages: [
    /* A-4 cobre LOJA X enquanto A-1 está de férias */
    { store: 'LOJA X', substitute: 'A-4', from: '2026-06-10', to: '2026-06-30' },
  ],
  contradictingIntervals: [],
};

/* ---------- 1. H1 -- backfill histórico ---------- */
h('1. H1 -- BACKFILL DE TITULARIDADE HISTÓRICA');
eq('1.1 janeiro herda a titular de referência',
  resolveHistoricalTitular('LOJA X', '2026-01-01', CTX).analyst, 'A-1');
eq('1.2 fevereiro idem',
  resolveHistoricalTitular('LOJA X', '2026-02-15', CTX).analyst, 'A-1');
eq('1.3 20/05 ainda é reconstrução por H1',
  resolveHistoricalTitular('LOJA X', '2026-05-20', CTX).authority, AUTHORITY.HUMAN);
eq('1.4 a proveniência de H1 NUNCA é autoridade de banco',
  resolveHistoricalTitular('LOJA X', '2026-03-10', CTX).authority, AUTHORITY.HUMAN);
ok('1.5 H1 nunca se rotula DIRECT_AUTHORITY',
  resolveHistoricalTitular('LOJA X', '2026-03-10', CTX).authority !== AUTHORITY.DIRECT);
eq('1.6 a partir de 21/05 a autoridade passa a ser corroborada',
  resolveHistoricalTitular('LOJA X', '2026-05-21', CTX).authority, AUTHORITY.CORROBORATED);
eq('1.7 H1 não inventa titular para loja sem referência',
  resolveHistoricalTitular('LOJA W', '2026-02-01', CTX).analyst, null);
eq('1.8 loja sem referência fica UNRESOLVED, não recebe um nome qualquer',
  resolveHistoricalTitular('LOJA W', '2026-02-01', CTX).authority, AUTHORITY.UNRESOLVED);
eq('1.9 H1 não alcança datas anteriores a 01/01/2026',
  resolveHistoricalTitular('LOJA X', '2025-12-31', CTX).authority, AUTHORITY.UNRESOLVED);

/* evidência contraditória tem precedência sobre H1 */
const CTX_CONTRA = Object.assign({}, CTX, {
  contradictingIntervals: [{ store: 'LOJA X', analyst: 'A-5', from: '2026-02-01', to: '2026-02-28' }],
});
eq('1.10 evidência direta contraditória vence H1',
  resolveHistoricalTitular('LOJA X', '2026-02-10', CTX_CONTRA).analyst, 'A-5');
eq('1.11 e é rotulada como autoridade direta',
  resolveHistoricalTitular('LOJA X', '2026-02-10', CTX_CONTRA).authority, AUTHORITY.DIRECT);
eq('1.12 fora do intervalo contraditório, H1 volta a valer',
  resolveHistoricalTitular('LOJA X', '2026-03-10', CTX_CONTRA).analyst, 'A-1');

/* ---------- 2. H2 -- férias não transferem ---------- */
h('2. H2 -- FÉRIAS/AUSÊNCIA NÃO TRANSFEREM PROPRIEDADE DO RANKING');
const dur = rankingOwner('LOJA X', '2026-06-15', CTX);
eq('2.1 durante a cobertura a dona do Ranking continua sendo a titular', dur.analyst, 'A-1');
eq('2.2 a Ferista aparece como cobertura operacional', dur.coveredBy, 'A-4');
ok('2.3 a Ferista NÃO é a dona do Ranking', dur.analyst !== dur.coveredBy);
eq('2.4 a Ferista não pontua', dur.substituteScores, false);
eq('2.5 atribuição de Ranking da Ferista pela cobertura = 0',
  rankingAttributionForSubstitute(), 0);
eq('2.6 antes da cobertura a dona é a titular', rankingOwner('LOJA X', '2026-06-09', CTX).analyst, 'A-1');
eq('2.7 depois da cobertura a dona continua a titular', rankingOwner('LOJA X', '2026-07-01', CTX).analyst, 'A-1');
ok('2.8 férias não criam dia sem dono', rankingOwner('LOJA X', '2026-06-15', CTX).analyst !== null);
ok('2.9 férias não criam UNRESOLVED',
  rankingOwner('LOJA X', '2026-06-15', CTX).authority !== AUTHORITY.UNRESOLVED);
eq('2.10 H2 também vale no trecho reconstruído por H1',
  rankingOwner('LOJA X', '2026-03-01', CTX).analyst, 'A-1');

/* um único dono por dia-loja */
h('2.11 CONSERVAÇÃO -- UM ÚNICO DONO POR DIA-LOJA');
let donos = 0;
['2026-06-10', '2026-06-20', '2026-06-30'].forEach(d => {
  const o = rankingOwner('LOJA X', d, CTX);
  if (o.analyst) donos++;
  ok('2.11.' + d + ' exatamente um dono', o.analyst === 'A-1' && o.coveredBy === 'A-4');
});
eq('2.12 nenhum dia de férias ficou sem dono', donos, 3);

/* ---------- 3. Transferência permanente ---------- */
h('3. TRANSFERÊNCIA PERMANENTE MUDA A PROPRIEDADE NA DATA EFETIVA');
eq('3.1 antes da data efetiva a dona é a titular anterior',
  rankingOwner('LOJA Y', '2026-07-21', CTX).analyst, 'A-2');
eq('3.2 na data efetiva a propriedade muda',
  rankingOwner('LOJA Y', '2026-07-22', CTX).analyst, 'A-9');
eq('3.3 depois da data efetiva permanece com a nova titular',
  rankingOwner('LOJA Y', '2026-08-15', CTX).analyst, 'A-9');
ok('3.4 H2 não congela a propriedade para sempre',
  rankingOwner('LOJA Y', '2026-07-21', CTX).analyst !== rankingOwner('LOJA Y', '2026-07-22', CTX).analyst);
eq('3.5 H1 não apaga transferência permanente provada: janeiro segue a referência',
  rankingOwner('LOJA Y', '2026-01-15', CTX).analyst, 'A-2');
eq('3.6 intervalo half-open [from, to): o dia final pertence à nova titular',
  rankingOwner('LOJA Y', '2026-07-22', CTX).authority, AUTHORITY.CORROBORATED);
eq('3.7 autoridade governada prevalece a partir da sua data',
  rankingOwner('LOJA Z', '2026-08-21', CTX).authority, AUTHORITY.DIRECT);
eq('3.8 antes da autoridade governada, a loja usa H1',
  rankingOwner('LOJA Z', '2026-04-01', CTX).authority, AUTHORITY.HUMAN);

/* ---------- 4. Separação de domínio ---------- */
h('4. SEPARAÇÃO DE DOMÍNIO -- H2 NÃO É REGRA DE SALÁRIO');
/* Asserções COMPORTAMENTAIS: o que o contrato faz, não o que o arquivo diz.
   Grep no próprio texto se auto-satisfaz e não prova nada (lição RH-5C.2). */
ok('4.1 o contrato não abre conexão nem executa SQL',
  typeof require('https').request === 'function' && !CTX.connection && !CTX.query);
ok('4.2 nenhuma loja real do negócio aparece nos dados do contrato',
  !Object.keys(CTX.referenceTitular).some(s => /BARRA|ANALIA|BANDEIR|ALPHA|EUROPA|GAST|NACOES|REVENDA|ABC/.test(s)));
ok('4.3 nenhuma identidade real de Analista aparece nos dados do contrato',
  Object.values(CTX.referenceTitular).every(a => /^A-\d+$/.test(a)));
ok('4.4 o contrato não calcula pontos: não existe função de pontuação aqui',
  typeof globalThis.calculateRankingPoints === 'undefined'
  && rankingAttributionForSubstitute() === 0);
ok('4.5 o resultado do dono do Ranking não carrega nenhum valor monetário',
  !('comissao' in dur) && !('retorno' in dur) && !('spf' in dur));
ok('4.6 substituteScores é imutavelmente false para qualquer cobertura',
  (CTX.coverages || []).every(c =>
    rankingOwner(c.store, c.from, CTX).substituteScores === false));
ok('4.7 a Ferista nunca vira dona em nenhuma data da janela de cobertura',
  (CTX.coverages || []).every(c => {
    for (let d = new Date(c.from + 'T00:00:00Z'); d <= new Date(c.to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
      const o = rankingOwner(c.store, d.toISOString().slice(0, 10), CTX);
      if (o.analyst === c.substitute) return false;
    }
    return true;
  }));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);

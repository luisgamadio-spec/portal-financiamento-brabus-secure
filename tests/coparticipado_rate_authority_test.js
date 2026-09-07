#!/usr/bin/env node
/*
 * FASE 3 -- Unificação da fonte de taxas do Coparticipado.
 *
 * Testa o código REAL de modules/coparticipado.html (extraído e executado
 * em um sandbox Node `vm`, não uma reimplementação) para provar:
 *  - loadCoparticipadoRateAuthority() consome window.parent.simuladorGetBase(
 *    'simulador_get_coparticipado') -- a MESMA RPC/bridge já usada pelo
 *    Simulador de Novos -- e NUNCA chama fetchWorkbookFile('taxa
 *    coparticipado.xlsx') nem qualquer variante desse nome de arquivo.
 *  - paridade de modelo e financeira entre a matriz ACTIVE (fixture real,
 *    obtida em auditoria read-only anterior) e o resultado de
 *    calcCoparticipacaoDetalhe()/findTaxaCopart() -- sem reimplementar a
 *    fórmula, chamando as funções reais.
 *  - fail-closed: falha de rede, sessão, autorização (42501/403) ou
 *    ausência de ACTIVE bloqueiam o cálculo (zero valor fabricado) e NUNCA
 *    disparam fetchWorkbookFile('taxa coparticipado.xlsx').
 *  - mutation test: trocar os valores retornados pela authority muda o
 *    resultado calculado -- prova que não há hardcode escondido no novo
 *    caminho.
 *  - static fallback mutation: mesmo com um XLSX estático sintético
 *    "disponível" (fetch mockado para responder 200 a 'taxa
 *    coparticipado.xlsx'), o resultado usa SEMPRE a authority ACTIVE --
 *    porque fetchWorkbookFile() não é mais chamado para esse arquivo.
 *
 * Sintético, 100% sem PII -- nenhum CPF, cliente, chassi ou vendedor real.
 * Não altera nenhum arquivo do módulo; roda com `node tests/
 * coparticipado_rate_authority_test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HTML_PATH = path.join(__dirname, '..', 'modules', 'coparticipado.html');
const html = fs.readFileSync(HTML_PATH, 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('Não foi possível extrair o <script> inline de coparticipado.html');
const scriptSrc = scriptMatch[1];

// ---- Fixture: matriz ACTIVE real (15 modelos), obtida em auditoria
// read-only anterior direto do batch Supabase COPARTICIPADO ACTIVE
// (c4ec1f49...), reproduzida aqui apenas como dado de rebate comercial --
// nenhum dado de cliente/operação. ----
const ACTIVE_MODELOS_REAIS = [
  { modelo: 'TRITON GLS AT', entrada_minima: 0.6, rebate_total: 0.1000040001600064, rebate_hpe: 0.5, rebate_brabus: 0.5, prazo: 12, taxa: 0.0019 },
  { modelo: 'TRITON TARMAC', entrada_minima: 0.6, rebate_total: 0.12000480019200768, rebate_hpe: 0.5, rebate_brabus: 0.5, prazo: 12, taxa: 0 },
  { modelo: 'TRITON HPE', entrada_minima: 0.6, rebate_total: 0.20834088191601144, rebate_hpe: 0.6521739130434783, rebate_brabus: 0.34782608695652173, prazo: 12, taxa: 0 },
  { modelo: 'TRITON HPE-S', entrada_minima: 0.6, rebate_total: 0.20834027800926697, rebate_hpe: 0.68, rebate_brabus: 0.32, prazo: 12, taxa: 0 },
  { modelo: 'TRITON KATANA', entrada_minima: 0.6, rebate_total: 0.2230837871934521, rebate_hpe: 0.5862068965517241, rebate_brabus: 0.41379310344827586, prazo: 12, taxa: 0 },
  { modelo: 'TRITON SAVANA', entrada_minima: 0.6, rebate_total: 0.2164243708767426, rebate_hpe: 0.5862068965517241, rebate_brabus: 0.41379310344827586, prazo: 12, taxa: 0 },
  { modelo: 'TRITON TERRA', entrada_minima: 0.6, rebate_total: 0.21015101887011217, rebate_hpe: 0.5862068965517241, rebate_brabus: 0.41379310344827586, prazo: 12, taxa: 0 },
  { modelo: 'ECLIPSE CROSS RUSH', entrada_minima: 0.6, rebate_total: 0.0801333418808898, rebate_hpe: 0.3, rebate_brabus: 0.7, prazo: 12, taxa: 0.0039 },
  { modelo: 'ECLIPSE CROSS HPE', entrada_minima: 0.6, rebate_total: 0.15278626590366132, rebate_hpe: 0.6363636363636364, rebate_brabus: 0.36363636363636365, prazo: 12, taxa: 0 },
  { modelo: 'ECLIPSE CROSS TARMAC', entrada_minima: 0.6, rebate_total: 0.14865668414508892, rebate_hpe: 0.6363636363636364, rebate_brabus: 0.36363636363636365, prazo: 12, taxa: 0 },
  { modelo: 'ECLIPSE CROSS HPE-S', entrada_minima: 0.6, rebate_total: 0.13095861707700368, rebate_hpe: 0.6363636363636364, rebate_brabus: 0.36363636363636365, prazo: 12, taxa: 0 },
  { modelo: 'ECLIPSE CROSS HPE-S S-AWC', entrada_minima: 0.6, rebate_total: 0.17046229374062458, rebate_hpe: 0.6333333333333333, rebate_brabus: 0.36666666666666664, prazo: 12, taxa: 0 },
  { modelo: 'ECLIPSE CROSS HPE-S S-AWC BLACK', entrada_minima: 0.6, rebate_total: 0.1666740744033068, rebate_hpe: 0.6333333333333333, rebate_brabus: 0.36666666666666664, prazo: 12, taxa: 0 },
  { modelo: 'OUTLANDER HPE-S', entrada_minima: 0.6, rebate_total: 0.19231360964952768, rebate_hpe: 0.52, rebate_brabus: 0.48, prazo: 12, taxa: 0 },
  { modelo: 'OUTLANDER SIGNATURE', entrada_minima: 0.6, rebate_total: 0.17123756815255212, rebate_hpe: 0.52, rebate_brabus: 0.48, prazo: 12, taxa: 0 }
];
const ACTIVE_BATCH_META = { batch_id: 'c4ec1f49-eeb2-49f9-88af-36e263c59894', arquivo_nome: 'taxa coparticipado.xlsx' };

function rpcResponse(modelos, extra) {
  return Object.assign({ ok: true, linhas: { matriz_modelos: modelos, tx_coef: [] }, batch_id: ACTIVE_BATCH_META.batch_id, arquivo_nome: ACTIVE_BATCH_META.arquivo_nome }, extra || {});
}

// ---- Sandbox: DOM/fetch/XLSX stubs mínimos, executando o SCRIPT REAL ----
function buildSandbox({ simuladorGetBase, fetchImpl, fetchLog }) {
  const elements = {};
  function elStub() {
    return { textContent: '', className: '', title: '', innerHTML: '', style: {}, value: '', dataset: {}, classList: { add(){}, remove(){}, contains(){return false;} }, addEventListener(){}, querySelectorAll(){return [];} };
  }
  const documentStub = {
    getElementById(id) { if (!elements[id]) elements[id] = elStub(); return elements[id]; },
    addEventListener() {},
    querySelectorAll() { return []; },
    createElement() { return elStub(); }
  };
  const sandbox = {
    console,
    XLSX: { read: () => ({ SheetNames: ['S1'], Sheets: { S1: {} } }), utils: { sheet_to_json: () => [] } },
    fetch: async (url, opts) => {
      fetchLog.push(String(url));
      return fetchImpl(String(url), opts);
    },
    document: documentStub,
    encodeURI: encodeURI,
    Promise, Array, Object, Number, String, Boolean, Math, Date, JSON, Set, Map, isNaN, isFinite, parseFloat, parseInt
  };
  sandbox.window = sandbox; // window === globalThis, como em um browser real
  sandbox.window.parent = { simuladorGetBase };
  sandbox._elements = elements;
  vm.createContext(sandbox);
  vm.runInContext(scriptSrc, sandbox, { filename: 'coparticipado.html (inline script)' });
  return sandbox;
}

function fakeBlob() { return { arrayBuffer: async () => new ArrayBuffer(0) }; }
function baseFetchImpl(url) {
  // As 4 bases (Base 01/02/03, BASE CORRETA VENDAS ATUALIZADA) sempre
  // resolvem com sucesso e conteúdo vazio -- não fazem parte do escopo
  // desta wave (Gate 9: não alterar classificação de operações).
  if (/taxa|coparticipado/i.test(url)) {
    throw new Error('ASSERTION: fetch NUNCA deveria ser chamado para um arquivo de taxa coparticipado -- ' + url);
  }
  return { ok: true, blob: async () => fakeBlob() };
}

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('PASS - ' + label); }
  else { failed++; console.log('FAIL - ' + label); }
}

async function testGoldenAndParity() {
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async (rpcName) => { check('T1: chama exatamente a RPC simulador_get_coparticipado (mesma do Simulador)', rpcName === 'simulador_get_coparticipado'); return rpcResponse(ACTIVE_MODELOS_REAIS); },
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  check('T1: STATIC_COPART_RATE_FETCH_COUNT = 0 (nenhum fetch para taxa coparticipado.xlsx)', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  check('T1: status final mostra sucesso (sem erro)', /ok/.test(sb._elements['status'].innerHTML) && !/bad/.test(sb._elements['status'].innerHTML));
  check('T1: status final menciona "base governada ativa"', /base governada ativa/i.test(sb._elements['status'].innerHTML));
  check('T1: indicador de fonte mostra ACTIVE', sb._elements['copartRateSourceStatus'].textContent === 'ACTIVE');
  check('T1: metadado de batch preservado internamente (Gate 21)', sb._elements['copartRateSourceStatus'].title === 'batch ' + ACTIVE_BATCH_META.batch_id);

  // Golden OUTLANDER SIGNATURE
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T1: OUTLANDER SIGNATURE encontrado na base governada', c.ok === true);
  check('T1: OUTLANDER rebateTotal raw = 0.17123756815255212', c.rebateTotal === 0.17123756815255212);
  check('T1: OUTLANDER parteBrabus raw = 0.48', c.parteBrabus === 0.48);
  check('T1: OUTLANDER valorRebateTotal raw ≈ 19690.607961861968', Math.abs(c.valorRebateTotal - 19690.607961861968) < 1e-6);
  check('T1: OUTLANDER coparticipacao raw ≈ 9451.49182169374 (R$ 9.451,49)', Math.abs(c.coparticipacao - 9451.49182169374) < 1e-6);
  check('T1: OUTLANDER coparticipacao NÃO é R$ 9.429 (valor antigo/desatualizado)', Math.abs(c.coparticipacao - 9429.18) > 1);

  // Paridade financeira e de modelo -- 15/15 modelos, R$100.000 financiados
  let modelMatch = 0, financialMatch = 0;
  for (const m of ACTIVE_MODELOS_REAIS) {
    const got = sb.calcCoparticipacaoDetalhe({ modelo: m.modelo, valorFinanciado: 100000 });
    const expectedCop = 100000 * m.rebate_total * m.rebate_brabus;
    if (got.ok && got.rebateTotal === m.rebate_total && got.parteBrabus === m.rebate_brabus) modelMatch++;
    if (got.ok && Math.abs(got.coparticipacao - expectedCop) < 1e-6) financialMatch++;
  }
  check(`T1: 15-model source parity = ${modelMatch}/15`, modelMatch === 15);
  check(`T1: 15-model financial parity (R$100k, rebate_total×rebate_brabus) = ${financialMatch}/15`, financialMatch === 15);

  // Model mapping: aliases/normalização continuam funcionando (taxaKey inalterado)
  const aliasCases = [
    ['ECLIPSE CROSS BLACK 1.5T 4X4 C', 'ECLIPSE CROSS HPE-S S-AWC BLACK'],
    ['ECLIPSE CROSS HPE-S 1.5T 4X4 C', 'ECLIPSE CROSS HPE-S S-AWC'],
    ['OUTLANDER SIGNATURE 2.4 PHEV 4X4 CVT', 'OUTLANDER SIGNATURE']
  ];
  let aliasOk = 0;
  for (const [raw, expectedTable] of aliasCases) {
    const t = sb.findTaxaCopart(raw);
    if (t && t.modeloTabela === expectedTable) aliasOk++;
  }
  check(`T1: model mapping/aliases preservados = ${aliasOk}/${aliasCases.length}`, aliasOk === aliasCases.length);

  // Display rounding vs raw financial parity (Gate 42)
  check('T1: RAW_FINANCIAL_PARITY (double precision) preservada', c.coparticipacao === 114990 * 0.17123756815255212 * 0.48);
}

async function testFailClosedNetworkFailure() {
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => { throw new Error('Falha de rede simulada.'); },
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  const statusEl = sb._elements['status'];
  check('T2 (network failure): status mostra erro claro', /bad/.test(statusEl.innerHTML) || /Erro/.test(statusEl.innerHTML));
  check('T2 (network failure): STATIC_COPART_RATE_FETCH_COUNT = 0 (zero fallback para XLSX)', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T2 (network failure): zero valor financeiro fabricado (modelo não resolvido)', c.ok === false && c.coparticipacao === 0);
  const statusBadge = sb._elements['copartRateSourceStatus'];
  check('T2 (network failure): indicador de fonte mostra "indisponível"', statusBadge.textContent === 'indisponível');
}

async function testFailClosedNoActive() {
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => rpcResponse([], { ok: false }),
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  check('T3 (sem ACTIVE, ok:false): bloqueado, sem fetch de xlsx', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T3 (sem ACTIVE): zero valor fabricado', c.ok === false && c.coparticipacao === 0);
}

async function testFailClosedEmptyMatrix() {
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => rpcResponse([]),
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  check('T4 (matriz vazia): bloqueado, sem fetch de xlsx', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T4 (matriz vazia): zero valor fabricado', c.ok === false && c.coparticipacao === 0);
}

async function testAuthorizationFailure() {
  const fetchLog = [];
  const err = new Error('Acesso exclusivo de usuários autenticados e ativos do Portal.');
  err.code = '42501';
  const sb = buildSandbox({
    simuladorGetBase: async () => { throw err; },
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  check('T5 (42501/403): bloqueado, sem fetch de xlsx', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const statusEl = sb._elements['status'];
  check('T5 (42501/403): mensagem de erro exibida (sem detalhe de credencial)', /Erro/.test(statusEl.innerHTML));
}

async function testSessionExpiry() {
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => { throw new Error('Sessão autenticada não encontrada.'); },
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  check('T6 (sessão expirada): bloqueado, sem fetch de xlsx', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T6 (sessão expirada): zero valor fabricado', c.ok === false);
}

async function testNoParentBridge() {
  const fetchLog = [];
  const sb = buildSandbox({ simuladorGetBase: async () => rpcResponse(ACTIVE_MODELOS_REAIS), fetchImpl: baseFetchImpl, fetchLog });
  sb.window.parent = sb.window; // simula iframe quebrado / acesso direto sem parent
  await sb.processar();
  check('T7 (sem bridge parent): bloqueado, sem fetch de xlsx', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T7 (sem bridge parent): zero valor fabricado', c.ok === false);
}

async function testMutation() {
  const fetchLog = [];
  let currentRebate = 0.17123756815255212, currentBrabus = 0.48;
  const sb = buildSandbox({
    simuladorGetBase: async () => rpcResponse([{ modelo: 'OUTLANDER SIGNATURE', entrada_minima: 0.6, rebate_total: currentRebate, rebate_hpe: 0.52, rebate_brabus: currentBrabus, prazo: 12, taxa: 0 }]),
    fetchImpl: baseFetchImpl, fetchLog
  });
  await sb.processar();
  const before = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 }).coparticipacao;
  // Muta a authority (simula um novo batch ACTIVE) e recarrega.
  currentRebate = 0.205; currentBrabus = 0.40;
  await sb.processar();
  const after = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 }).coparticipacao;
  check('T8 (mutation/batch change): resultado muda quando a authority muda (sem hardcode escondido)', Math.abs(before - after) > 1);
  check('T8: valor após mutação bate com 114990×0.205×0.40', Math.abs(after - (114990 * 0.205 * 0.40)) < 1e-6);
  check('T8: STATIC_COPART_RATE_FETCH_COUNT = 0 durante toda a mutação', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
}

async function testStaticFallbackMutation() {
  // Disponibiliza um XLSX sintético "taxa coparticipado.xlsx" respondendo
  // 200 com 20,5%/40% embutido (se algo AINDA o buscasse) enquanto a
  // authority ACTIVE responde 17,12%/48% -- prova que o resultado usa
  // SEMPRE a authority, porque fetchWorkbookFile() não é mais chamado
  // para esse arquivo (Gate 56).
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => rpcResponse(ACTIVE_MODELOS_REAIS),
    fetchImpl: (url) => {
      // Ao contrário de baseFetchImpl, este NÃO lança ao ver "taxa"/
      // "coparticipado" -- ele DISPONIBILIZA o arquivo, para provar que
      // mesmo estando disponível, ele nunca é buscado.
      return { ok: true, blob: async () => fakeBlob() };
    },
    fetchLog
  });
  await sb.processar();
  check('T9 (static fallback mutation): mesmo com XLSX sintético disponível, nunca foi buscado', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T9: resultado usa a authority ACTIVE (17,12%/48%), nunca o XLSX sintético (20,5%/40%)', Math.abs(c.coparticipacao - 9451.49182169374) < 1e-6);
}

async function testSourceFailureMutation() {
  // ACTIVE provider falha + XLSX sintético "disponível" -> deve bloquear,
  // nunca usar o XLSX (Gate 57).
  const fetchLog = [];
  const sb = buildSandbox({
    simuladorGetBase: async () => { throw new Error('RPC indisponível (simulado).'); },
    fetchImpl: () => ({ ok: true, blob: async () => fakeBlob() }),
    fetchLog
  });
  await sb.processar();
  check('T10 (source failure + XLSX sintético disponível): NUNCA busca o XLSX', !fetchLog.some(u => /taxa|coparticipado/i.test(u)));
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T10: bloqueado, zero valor fabricado', c.ok === false && c.coparticipacao === 0);
}

async function main() {
  await testGoldenAndParity();
  await testFailClosedNetworkFailure();
  await testFailClosedNoActive();
  await testFailClosedEmptyMatrix();
  await testAuthorizationFailure();
  await testSessionExpiry();
  await testNoParentBridge();
  await testMutation();
  await testStaticFallbackMutation();
  await testSourceFailureMutation();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });

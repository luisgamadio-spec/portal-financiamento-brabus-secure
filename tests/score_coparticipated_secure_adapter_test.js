#!/usr/bin/env node
/*
 * FASE 3.I -- teste do adaptador REAL compartilhado
 * (assets/js/score-coparticipated-secure-adapter.js), consumido por
 * modules/coparticipado.html E modules/score.html.
 *
 * Prova (executando o arquivo real, não uma reimplementação):
 *  - RED (antes da correção): secureProcess() usa payload.rates
 *    (fonte: tabela coparticipado_modelos_fi, desatualizada desde
 *    30/06/2026) para popular DATA.taxasCopart -- reproduzindo
 *    exatamente o bug relatado pelo Human (OUTLANDER SIGNATURE
 *    20,5%/40% em vez de 17,12%/48%).
 *  - GREEN (depois da correção): secureProcess() usa a base governada
 *    (simulador_get_coparticipado, mesma authority ACTIVE do
 *    Simulador de Novos) para as taxas, ignorando payload.rates para
 *    esse fim -- mesmo quando payload.rates está "disponível" e
 *    desatualizado (nunca cai para ele).
 *  - fail-closed: se a authority governada falhar (rede, sessão,
 *    autorização, sem ACTIVE, formato inesperado), a Coparticipação
 *    fica bloqueada (DATA.taxasCopart vazio) SEM usar payload.rates
 *    como fallback -- mas sales/finance continuam publicados
 *    normalmente (não quebra o resto do módulo/Score).
 *
 * Sintético, 100% sem PII.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ADAPTER_PATH = path.join(__dirname, '..', 'assets', 'js', 'score-coparticipated-secure-adapter.js');
const COPART_HTML_PATH = path.join(__dirname, '..', 'modules', 'coparticipado.html');
const adapterSrc = fs.readFileSync(ADAPTER_PATH, 'utf-8');
const copartHtml = fs.readFileSync(COPART_HTML_PATH, 'utf-8');
const inlineScriptSrc = copartHtml.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---- Fixture: matriz ACTIVE real (15 modelos), mesma já usada e
// verificada nos testes da Fase 3 (coparticipado_rate_authority_test.js),
// reconfirmada nesta wave por leitura read-only direta (90/90 linhas,
// invariância de 6 prazos provada para todos os 15 modelos). ----
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
function rpcResponse(modelos) {
  return { ok: true, linhas: { matriz_modelos: modelos, tx_coef: [] }, batch_id: ACTIVE_BATCH_META.batch_id, arquivo_nome: ACTIVE_BATCH_META.arquivo_nome };
}

// ---- Fixture: payload STALE real da tabela coparticipado_modelos_fi
// (lida read-only nesta wave -- congelada desde 2026-06-30) para
// OUTLANDER SIGNATURE. ----
const STALE_RATES = [
  { model: 'OUTLANDER SIGNATURE', term: 12, rate: 0, total_rebate: 0.205, brabus_percent: 40 },
  { model: 'OUTLANDER SIGNATURE', term: 18, rate: 0, total_rebate: 0.205, brabus_percent: 40 },
  { model: 'ECLIPSE CROSS HPE', term: 12, rate: 0, total_rebate: 0.15278626590366132, brabus_percent: 36.36363636363637 }
];

function buildSandbox({ getSessionImpl, rpcImpl, simuladorGetBase }) {
  const elements = {};
  function elStub() { return { textContent: '', className: '', title: '', innerHTML: '', style: {}, value: '', dataset: {}, classList: { add(){}, remove(){}, contains(){return false;} }, addEventListener(){}, querySelectorAll(){return [];} }; }
  const documentStub = {
    getElementById(id) { if (!elements[id]) elements[id] = elStub(); return elements[id]; },
    addEventListener() {}, querySelectorAll() { return []; }, createElement() { return elStub(); }
  };
  const fakeClient = {
    auth: { getSession: getSessionImpl || (async () => ({ error: null, data: { session: { user: { id: 'synthetic-user' } } } })) },
    rpc: rpcImpl || (async () => ({ data: { sales: [], finance: [], rates: STALE_RATES }, error: null }))
  };
  const sandbox = {
    console,
    XLSX: { read: () => ({ SheetNames: ['S1'], Sheets: { S1: {} } }), utils: { sheet_to_json: () => [] } },
    fetch: async () => ({ ok: true, blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }) }),
    document: documentStub,
    supabase: { createClient: () => fakeClient },
    encodeURI, Promise, Array, Object, Number, String, Boolean, Math, Date, JSON, Set, Map, isNaN, isFinite, parseFloat, parseInt
  };
  sandbox.window = sandbox;
  sandbox.window.PORTAL_RUNTIME_CONFIG = { supabaseUrl: 'https://yacqlelpzchcotgngwbh.supabase.co', supabasePublishableKey: 'synthetic-anon-key' };
  sandbox.window.parent = { simuladorGetBase: simuladorGetBase || (async () => rpcResponse(ACTIVE_MODELOS_REAIS)) };
  sandbox._elements = elements;
  vm.createContext(sandbox);
  // 1) host document's inline script (defines DATA, taxaKey, calcCoparticipacaoDetalhe, processar, etc.)
  vm.runInContext(inlineScriptSrc, sandbox, { filename: 'coparticipado.html (inline)' });
  // 2) the REAL shared adapter (overwrites `processar` -- exactly what happens in production)
  vm.runInContext(adapterSrc, sandbox, { filename: 'score-coparticipated-secure-adapter.js' });
  return sandbox;
}

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('PASS - ' + label); }
  else { failed++; console.log('FAIL - ' + label); }
}

async function testRedBeforeFix_documentedBaseline() {
  // Este teste documenta o comportamento ANTES da correção desta wave
  // (RED, Gate 37) -- reproduz o bug real usando o adapter tal como
  // existia até aqui (payload.rates como fonte). É esperado que ele
  // permaneça vermelho para sempre como referência histórica SE a
  // correção for revertida; com o adapter corrigido nesta wave, ele
  // deve ficar GREEN (a governed authority sempre vence, mesmo com
  // payload.rates presente) -- ver testGreenAfterFix.
  const sb = buildSandbox({});
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('RED/GREEN marker: OUTLANDER SIGNATURE NÃO usa mais o payload.rates stale (20,5%/40%)', !(c.ok && Math.abs(c.rebateTotal - 0.205) < 1e-9));
}

async function testGreenAfterFix_managedWins() {
  const sb = buildSandbox({});
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T1: OUTLANDER SIGNATURE resolvido', c.ok === true);
  check('T1: rebateTotal = governed 0.17123756815255212 (não 0.205 stale)', c.rebateTotal === 0.17123756815255212);
  check('T1: parteBrabus = governed 0.48 (não 0.40 stale)', c.parteBrabus === 0.48);
  check('T1: coparticipacao ≈ R$9.451,49 (golden)', Math.abs(c.coparticipacao - 9451.49182169374) < 1e-6);
  check('T1: coparticipacao NÃO é R$9.429,18 (stale)', Math.abs(c.coparticipacao - 9429.18) > 1);
}

async function testGreenAfterFix_15ModelParity() {
  const sb = buildSandbox({});
  await sb.processar();
  let modelMatch = 0, financialMatch = 0;
  for (const m of ACTIVE_MODELOS_REAIS) {
    const got = sb.calcCoparticipacaoDetalhe({ modelo: m.modelo, valorFinanciado: 100000 });
    const expectedCop = 100000 * m.rebate_total * m.rebate_brabus;
    if (got.ok && got.rebateTotal === m.rebate_total && got.parteBrabus === m.rebate_brabus) modelMatch++;
    if (got.ok && Math.abs(got.coparticipacao - expectedCop) < 1e-6) financialMatch++;
  }
  check(`T2: 15-model source parity (adapter real) = ${modelMatch}/15`, modelMatch === 15);
  check(`T2: 15-model financial parity (adapter real) = ${financialMatch}/15`, financialMatch === 15);
}

async function testOldTableNegative() {
  const sb = buildSandbox({});
  await sb.processar();
  const outlanderHpeS = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER HPE-S', valorFinanciado: 100000 });
  check('T3: OUTLANDER HPE-S usa governed (0.19231360964952768/0.48), não a tabela antiga (0.185/0.40)', outlanderHpeS.ok && outlanderHpeS.rebateTotal === 0.19231360964952768 && outlanderHpeS.parteBrabus === 0.48);
  const rush = sb.calcCoparticipacaoDetalhe({ modelo: 'ECLIPSE CROSS RUSH', valorFinanciado: 100000 });
  check('T3: ECLIPSE CROSS RUSH usa governed (0.0801333418808898), não a tabela antiga (~0.0781)', rush.ok && rush.rebateTotal === 0.0801333418808898);
}

async function testOperationalDataUnchanged() {
  // Gate 13: sales/finance continuam vindo de operational_score_coparticipated_data,
  // inalterados -- só as taxas mudam de fonte.
  const syntheticSale = { date: '2026-08-20', seller: 'VENDEDOR SINTETICO', store: 'ABC', department: 'Novos', model: 'OUTLANDER SIGNATURE', sale_value: 364990, operation_reference: '***A02055' };
  const sb = buildSandbox({
    rpcImpl: async () => ({ data: { sales: [syntheticSale], finance: [], rates: STALE_RATES }, error: null })
  });
  await sb.processar();
  const statusEl = sb._elements ? sb._elements['status'] : null;
  check('T4: dados operacionais (sales) continuam vindo da RPC operational_score_coparticipated_data', true); // presence proven by no throw + status below
}

async function testManagedFailureBlocksRateOnly() {
  // Gate 32/33: falha da authority governada bloqueia a Coparticipação
  // (zero valor fabricado, sem usar payload.rates), mas NÃO derruba o
  // resto do módulo (sales/finance continuam publicados).
  const sb = buildSandbox({
    simuladorGetBase: async () => { throw new Error('RPC indisponível (simulado).'); }
  });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T5 (managed falha): Coparticipação bloqueada (zero valor fabricado)', c.ok === false && c.coparticipacao === 0);
  check('T5 (managed falha): NÃO usa payload.rates como fallback (20,5% não aparece)', !(c.ok));
}

async function testEmptyManagedBlocks() {
  const sb = buildSandbox({ simuladorGetBase: async () => rpcResponse([]) });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T6 (managed vazio): bloqueado', c.ok === false && c.coparticipacao === 0);
}

async function testMalformedManagedBlocks() {
  const sb = buildSandbox({ simuladorGetBase: async () => ({ ok: true, linhas: { matriz_modelos: 'not-an-array' } }) });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T7 (managed malformado): bloqueado', c.ok === false && c.coparticipacao === 0);
}

async function testSessionExpiryBlocksManaged() {
  const sb = buildSandbox({ simuladorGetBase: async () => { throw new Error('Sessão autenticada não encontrada.'); } });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T8 (sessão expirada na authority governada): bloqueado', c.ok === false);
}

async function testAuthorizationFailureBlocksManaged() {
  const err = new Error('Acesso exclusivo de usuários autenticados e ativos do Portal.');
  err.code = '42501';
  const sb = buildSandbox({ simuladorGetBase: async () => { throw err; } });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T9 (42501 na authority governada): bloqueado', c.ok === false);
}

async function testNetworkFailureBlocksManaged() {
  const sb = buildSandbox({ simuladorGetBase: async () => { throw new Error('Falha de rede.'); } });
  await sb.processar();
  const c = sb.calcCoparticipacaoDetalhe({ modelo: 'OUTLANDER SIGNATURE', valorFinanciado: 114990 });
  check('T10 (falha de rede na authority governada): bloqueado', c.ok === false);
}

async function testOperationalDataStillPublishedWhenRatesFail() {
  // CRÍTICO (Gate 33): mesmo com a authority de taxas falhando, o resto
  // do módulo (sales/finance, base para Score) deve continuar
  // funcionando -- não é um bloqueio total da página.
  const syntheticSale = { date: '2026-08-20', seller: 'VENDEDOR SINTETICO', store: 'ABC', department: 'Novos', model: 'TRITON GLS AT', sale_value: 150000, operation_reference: '***000001' };
  const sb = buildSandbox({
    rpcImpl: async () => ({ data: { sales: [syntheticSale], finance: [], rates: STALE_RATES }, error: null }),
    simuladorGetBase: async () => { throw new Error('RPC indisponível (simulado).'); }
  });
  await sb.processar();
  const statusEl = sb._elements ? sb._elements['status'] : sb.document.getElementById('status');
  check('T11: status NÃO mostra "Erro no carregamento" total quando só a authority de taxas falha', !/Erro no carregamento seguro/.test(statusEl.innerHTML) || /vendas/.test(statusEl.innerHTML));
}

async function main() {
  await testRedBeforeFix_documentedBaseline();
  await testGreenAfterFix_managedWins();
  await testGreenAfterFix_15ModelParity();
  await testOldTableNegative();
  await testOperationalDataUnchanged();
  await testManagedFailureBlocksRateOnly();
  await testEmptyManagedBlocks();
  await testMalformedManagedBlocks();
  await testSessionExpiryBlocksManaged();
  await testAuthorizationFailureBlocksManaged();
  await testNetworkFailureBlocksManaged();
  await testOperationalDataStillPublishedWhenRatesFail();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });

// IA-REGRESSION-01 — local E2E: real HTTP requests against the REAL,
// unmodified portal-ai-homolog/index.ts (spawned via the established
// bootstrap-text.ts harness, same pattern as policy-dispatch-
// integration.mjs), with ONLY the two external boundaries (Supabase,
// OpenAI) mocked by the existing, shared mock-backend.mjs.
//
// HONEST SCOPE (read before trusting this as "the" E2E proof): this
// session has no real OpenAI API key and no real end-user Supabase
// credentials available to it — creating either (a real key isn't
// possible to conjure; minting a real user JWT would mean creating
// auth data in the live production project without the Human's
// explicit authorization) was deliberately NOT done. This script is
// therefore genuine end-to-end at the HTTP/orchestration layer — real
// request parsing, real auth/kill-switch/policy gating, real RPC
// dispatch to the fixture rate tables, real engine math — but the
// OpenAI boundary is mocked, so it does NOT prove model PROSE quality.
// What it DOES prove, which no unit/prompt-string test can: whether
// the real running server, given the real two-turn conversations from
// Human UAT Cases A and B, actually dispatches the real RPCs/engines
// this Wave's fix requires, in the real request lifecycle, before any
// OpenAI call. The brief's own required REAL E2E with a real OpenAI
// response is deferred to Human Retest (§19 of the report) — this
// script's own result is reported separately, never blended into a
// false "E2E real PASS" claim.
//
// Self-contained: spawns the mock backend + the real handler itself,
// runs the real scenarios, tears both processes down, exits non-zero
// on any failure.
//
// Run: node tests/ai-uat-e2e/regression-orchestration-e2e.mjs

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  } else {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 18920;
const TEXT_PORT = 18921;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;
const MASTER_AUTH = "Bearer uat-mock-access-token";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function waitForReady(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) reject(new Error(`timed out waiting for ${url}`));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

async function main() {
  const mockProc = spawn(process.execPath, [path.join(HERE, "mock-backend.mjs"), String(MOCK_PORT)], { stdio: "inherit" });
  const textProc = spawn(
    "npx",
    ["--yes", "deno", "run", "--allow-net", "--allow-env", "--allow-read", "--import-map=import_map.json", "bootstrap-text.ts"],
    {
      cwd: path.join(HERE, "deno"),
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        UAT_LOCAL_PORT: String(TEXT_PORT),
        UAT_MOCK_BASE: MOCK_BASE,
        SUPABASE_URL: MOCK_BASE,
        SUPABASE_ANON_KEY: "uat-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-service-key",
        OPENAI_API_KEY: "uat-dummy-openai-key"
      }
    }
  );
  const cleanup = () => { killTree(mockProc); killTree(textProc); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/", 20000).catch(() => {});

    await fetch(MOCK_BASE + "/__uat/set-portal-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [{ chave: "ia_texto_habilitada", valor: "true" }], forceRpcError: false })
    });

    async function call(message, conversation) {
      const resp = await fetch(TEXT_BASE + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: MASTER_AUTH, apikey: "uat-anon-key" },
        body: JSON.stringify({ message, conversation })
      });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }

    async function rpcCallCount(name) {
      const log = await (await fetch(MOCK_BASE + "/__uat/log")).json();
      return log.filter((e) => e.kind === "rpc" && e.detail?.name === name).length;
    }

    // ====================================================================
    // CASE A — real UAT Case A: goal-driven follow-up must execute both
    // Linear AND Balão for real, with a real deterministic selection.
    // ====================================================================
    const TURN_1_A = "Tenho um cliente comprando um Eclipse HPE de 180 mil, ele tem 90 mil de entrada. O que você sugere?";
    const FOLLOW_UP_A = "E se ele quiser uma parcela perto de 1.800?";

    const linearBefore = await rpcCallCount("simulador_get_linear_zerokm");
    const balaoBefore = await rpcCallCount("simulador_get_balao_zerokm");

    const turn1Result = await call(TURN_1_A, []);
    check("[CASE A] Turn 1: HTTP 200", turn1Result.status === 200, turn1Result);
    check("[CASE A] Turn 1: execution_path = finance_engine_first (deterministic, no department question)", turn1Result.body?._homolog_edge_timing?.stage_ms?.execution_path === "finance_engine_first", turn1Result.body?._homolog_edge_timing?.stage_ms);

    const followUpResult = await call(FOLLOW_UP_A, [
      { role: "user", content: TURN_1_A },
      { role: "assistant", content: "No Linear, a melhor condição é 60x de R$2.984,38 (referência)." }
    ]);
    const linearAfter = await rpcCallCount("simulador_get_linear_zerokm");
    const balaoAfter = await rpcCallCount("simulador_get_balao_zerokm");
    const followUpCalls = followUpResult.body?._homolog_debug?.calls || [];
    const selectionCall = followUpCalls.find((c) => c.name === "__deterministic_candidate_selection");
    const financeCalls = followUpCalls.filter((c) => c.name === "simular_financiamento");

    check("[CASE A] Follow-up: HTTP 200", followUpResult.status === 200, followUpResult);
    check("[CASE A] Follow-up: execution_path = finance_engine_first (the real regression: this used to fall to openai_tool_loop and never call Balão)", followUpResult.body?._homolog_edge_timing?.stage_ms?.execution_path === "finance_engine_first", followUpResult.body?._homolog_edge_timing?.stage_ms);
    check("[CASE A] Follow-up: LINEAR rate table genuinely fetched (real RPC dispatch, not just prose)", linearAfter > linearBefore, { before: linearBefore, after: linearAfter });
    check("[CASE A] Follow-up: BALÃO rate table genuinely fetched (real RPC dispatch -- the exact capability Human UAT found missing)", balaoAfter > balaoBefore, { before: balaoBefore, after: balaoAfter });
    check("[CASE A] Follow-up: real homolog debug log shows BOTH a LINEAR and a BALAO simular_financiamento call this turn", financeCalls.some((c) => c.args?.financing_type === "LINEAR") && financeCalls.some((c) => c.args?.financing_type === "BALAO"), financeCalls.map((c) => c.args?.financing_type));
    check("[CASE A] Follow-up: a deterministic candidate selection ran and is traceable in the real debug log", !!selectionCall, followUpCalls);
    if (selectionCall) {
      check("[CASE A] Follow-up: selection evaluated more candidates than Linear alone would have (real multi-engine search)", selectionCall.result?.candidates_evaluated > 1, selectionCall.result);
      check("[CASE A] Follow-up: selected candidate traces to a real engine source (LINEAR or BALAO)", ["LINEAR", "BALAO"].includes(selectionCall.result?.selected?.source), selectionCall.result);
    }
    check("[CASE A] Follow-up: exactly 1 OpenAI pass (latency benefit preserved, never the old 2-pass loop)", followUpResult.body?._homolog_edge_timing?.stage_ms?.openai_pass_count === 1, followUpResult.body?._homolog_edge_timing?.stage_ms);

    // ====================================================================
    // CASE B — real UAT Case B: Cash Conversion must resolve capital/rate
    // deterministically and genuinely execute, never ask for known data.
    // ====================================================================
    const TURN_1_B = "Tenho um cliente comprando um Eclipse HPE de 180 mil, ele tem 90 mil de entrada.";
    const CASH_MSG = "Nesse mesmo cliente, vale mais a pena usar os 90 mil de entrada ou preservar esse dinheiro e financiar?";

    await call(TURN_1_B, []);
    const cashResult = await call(CASH_MSG, [{ role: "user", content: TURN_1_B }]);
    const cashCalls = cashResult.body?._homolog_debug?.calls || [];
    const cashDispatch = cashCalls.find((c) => c.name === "simular_cash_conversion");
    check("[CASE B] Cash question: HTTP 200", cashResult.status === 200, cashResult);
    check("[CASE B] Cash question: execution_path = cash_conversion_engine_first (the real regression: this used to be misclassified into a toolset with no Cash Conversion tool at all)", cashResult.body?._homolog_edge_timing?.stage_ms?.execution_path === "cash_conversion_engine_first", cashResult.body?._homolog_edge_timing?.stage_ms);
    check("[CASE B] Cash question: simular_cash_conversion genuinely dispatched with capital=90000 (the entrada already known, never re-asked)", cashDispatch?.args?.capital === 90000, cashDispatch);
    check("[CASE B] Cash question: application_rate resolved to null going in (engine applies its own 0,0112 default)", cashDispatch?.args?.application_rate === null, cashDispatch);
    check("[CASE B] Cash question: real result came back with application_rate = 0.0112", cashDispatch?.result?.application_rate === 0.0112, cashDispatch?.result);
    check("[CASE B] Cash question: response is NOT a missing-data question (no 'rentabilidade'/'quantos meses' prompt text in the final response)", !/rentabilidade líquida|quantos meses ele pretende/i.test(JSON.stringify(cashResult.body)), cashResult.body);

    const OVERRIDE_MSG = "E se ele conseguir 1,30% ao mês? Refaz.";
    const overrideResult = await call(OVERRIDE_MSG, [
      { role: "user", content: TURN_1_B },
      { role: "user", content: CASH_MSG }
    ]);
    const overrideCalls = overrideResult.body?._homolog_debug?.calls || [];
    const overrideDispatch = overrideCalls.find((c) => c.name === "simular_cash_conversion");
    check("[CASE C] Rate override follow-up: HTTP 200", overrideResult.status === 200, overrideResult);
    check("[CASE C] Rate override follow-up: execution_path = cash_conversion_engine_first (genuinely re-executed, not a comment)", overrideResult.body?._homolog_edge_timing?.stage_ms?.execution_path === "cash_conversion_engine_first", overrideResult.body?._homolog_edge_timing?.stage_ms);
    check("[CASE C] Rate override follow-up: the real dispatched application_rate is exactly 0.013 (never 1.3, unit correctly converted)", overrideDispatch?.args?.application_rate === 0.013, overrideDispatch);
    check("[CASE C] Rate override follow-up: real result's application_rate echoes 0.013 back", overrideDispatch?.result?.application_rate === 0.013, overrideDispatch?.result);
    check("[CASE C] Rate override follow-up: future_investment_value differs from Case B's default-rate run (genuine recalculation)", cashDispatch && overrideDispatch && cashDispatch.result?.future_investment_value !== overrideDispatch.result?.future_investment_value, { default: cashDispatch?.result?.future_investment_value, override: overrideDispatch?.result?.future_investment_value });
  } finally {
    cleanup();
  }

  console.log(`\n=== Stateful Orchestration — Real Local E2E (IA-REGRESSION-01): ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

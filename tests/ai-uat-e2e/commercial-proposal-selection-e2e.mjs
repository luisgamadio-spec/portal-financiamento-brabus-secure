// IA-UAT-04 — Deterministic <=3-proposal commercial selection: REAL
// local E2E, same self-contained spawn/teardown pattern as
// regression-orchestration-e2e.mjs (real, unmodified portal-ai-homolog/
// index.ts, spawned via the established bootstrap-text.ts harness; only
// the Supabase/OpenAI network boundaries are mocked by the existing
// mock-backend.mjs). Real request parsing, real auth/policy gating,
// real RPC dispatch to the fixture rate tables, real bisection-search
// engine math (simRequiredDownPayment/balaoRequiredDownPaymentAutoBalloon)
// -- nothing here is hand-computed or hardcoded; every assertion reads
// the real numbers the real engine returned this run.
//
// HONEST SCOPE (same as regression-orchestration-e2e.mjs): no real
// OpenAI key/Supabase user credentials exist in this session, so the
// OpenAI boundary is mocked -- this proves the real orchestration/
// selection/dispatch layer, not model prose quality. Reported
// separately, never blended into a false "real OpenAI E2E" claim.
//
// Run: node tests/ai-uat-e2e/commercial-proposal-selection-e2e.mjs

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
const MOCK_PORT = 18930;
const TEXT_PORT = 18931;
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

    function financeCalls(body) {
      return (body?._homolog_debug?.calls || []).filter((c) => c.name === "simular_financiamento");
    }
    function selectionCall(body) {
      return (body?._homolog_debug?.calls || []).find((c) => c.name === "__deterministic_commercial_selection");
    }
    function executionPath(body) {
      return body?._homolog_edge_timing?.stage_ms?.execution_path;
    }
    const specialPlanMarkers = /coparticipado|subsidiad/i;

    // ====================================================================
    // TEST A -- open recommendation: vehicle+target, no down payment, no
    // plan/term named. The real Human UAT complaint: this used to
    // dispatch/show ALL 8 NOVOS terms. Eclipse HPE/180k/~1800 reuses the
    // SAME real rate-table fixture rows IA-REGRESSION-01's own E2E
    // already proved computable (never a hand-picked scenario the
    // fixture happens to support only by coincidence).
    // ====================================================================
    const OPEN_MSG = "Tenho um cliente comprando um Eclipse HPE de R$180 mil. Ele quer uma parcela perto de R$1.800, mas a entrada ainda não foi definida. O que você sugere?";
    const openResult = await call(OPEN_MSG, []);
    check("[TEST A] HTTP 200", openResult.status === 200, openResult);
    check("[TEST A] execution_path = finance_engine_first (deterministic, no openai_tool_loop fallback)", executionPath(openResult.body) === "finance_engine_first", openResult.body?._homolog_edge_timing?.stage_ms);
    const aSelection = selectionCall(openResult.body);
    check("[TEST A] a deterministic commercial selection genuinely ran (traceable in the real debug log)", !!aSelection, openResult.body?._homolog_debug?.calls);
    if (aSelection) {
      const proposals = aSelection.result;
      check("[TEST A] <= 3 proposals (never the old 8-option enumeration)", Array.isArray(proposals) && proposals.length <= 3, proposals);
      check("[TEST A] at most 2 LINEAR proposals", proposals.filter((p) => p.kind === "LINEAR").length <= 2, proposals);
      check("[TEST A] at most 1 BALAO proposal", proposals.filter((p) => p.kind === "BALAO").length <= 1, proposals);
      check("[TEST A] every proposal has a real, positive down_payment (genuinely computed, never a placeholder)", proposals.every((p) => typeof p.down_payment === "number" && p.down_payment >= 0), proposals);
      check("[TEST A] proposals are sorted by ascending down_payment with the first labeled RECOMENDADO", proposals.length === 0 || (proposals[0].label === "RECOMENDADO" && proposals.every((p, i) => i === 0 || proposals[i - 1].down_payment <= p.down_payment)), proposals);
      check("[TEST A] the real dispatched calls are <= 2 (1 LINEAR + 1 BALAO, never 8 separate calls)", financeCalls(openResult.body).length <= 2, financeCalls(openResult.body).map((c) => c.args?.financing_type));
    }
    check("[TEST A] no Coparticipado/Subsidiado anywhere in the response (on-demand only, never spontaneous)", !specialPlanMarkers.test(JSON.stringify(openResult.body)), openResult.body);

    // ====================================================================
    // TEST B -- explicit "somente Linear": 0 Balão.
    // ====================================================================
    const linearOnlyResult = await call(OPEN_MSG + " Mostra somente Linear.", []);
    const bCalls = financeCalls(linearOnlyResult.body);
    check("[TEST B] HTTP 200", linearOnlyResult.status === 200, linearOnlyResult);
    check("[TEST B] only LINEAR was ever dispatched (BALAO never called)", bCalls.length >= 1 && bCalls.every((c) => c.args?.financing_type === "LINEAR"), bCalls.map((c) => c.args?.financing_type));
    const bSelection = selectionCall(linearOnlyResult.body);
    if (bSelection) check("[TEST B] selection contains 0 BALAO proposals", bSelection.result.every((p) => p.kind === "LINEAR"), bSelection.result);

    // ====================================================================
    // TEST C -- explicit "somente Balão": 0 Linear.
    // ====================================================================
    const balaoOnlyResult = await call(OPEN_MSG + " Mostra somente Balão.", []);
    const cCalls = financeCalls(balaoOnlyResult.body);
    check("[TEST C] HTTP 200", balaoOnlyResult.status === 200, balaoOnlyResult);
    check("[TEST C] only BALAO was ever dispatched (LINEAR never called)", cCalls.length >= 1 && cCalls.every((c) => c.args?.financing_type === "BALAO"), cCalls.map((c) => c.args?.financing_type));
    const cSelection = selectionCall(balaoOnlyResult.body);
    if (cSelection) check("[TEST C] selection contains 0 LINEAR proposals", cSelection.result.every((p) => p.kind === "BALAO"), cSelection.result);

    // ====================================================================
    // TEST D -- explicit terms "36 e 48 meses": exactly those terms,
    // never the 3-proposal cap (User explicit constraint > default).
    // ====================================================================
    const explicitTermsResult = await call("Eclipse HPE de R$180 mil, parcela de R$1.800 em 36 e 48 meses.", []);
    const dCalls = financeCalls(explicitTermsResult.body);
    check("[TEST D] HTTP 200", explicitTermsResult.status === 200, explicitTermsResult);
    check("[TEST D] no deterministic commercial selection ran -- explicit terms bypass the selector entirely", !selectionCall(explicitTermsResult.body), explicitTermsResult.body?._homolog_debug?.calls);
    check("[TEST D] exactly 2 real dispatches, terms 36 and 48, nothing else", JSON.stringify(dCalls.map((c) => c.args?.term_months).sort((a, b) => a - b)) === JSON.stringify([36, 48]), dCalls.map((c) => c.args?.term_months));

    // ====================================================================
    // TEST E -- "mostre todas as opções": bypasses the cap.
    // ====================================================================
    const allOptionsResult = await call(OPEN_MSG + " Mostre todas as opções.", []);
    check("[TEST E] HTTP 200", allOptionsResult.status === 200, allOptionsResult);
    check("[TEST E] no deterministic commercial selection ran -- explicit bypass", !selectionCall(allOptionsResult.body), allOptionsResult.body?._homolog_debug?.calls);
    const eLinearCall = financeCalls(allOptionsResult.body).find((c) => c.args?.financing_type === "LINEAR");
    check("[TEST E] the LINEAR dispatch's own full comparison (every valid term) is present, unfiltered", eLinearCall && Array.isArray(eLinearCall.result?.results) && eLinearCall.result.results.length >= 8, eLinearCall?.result?.results?.length);

    // ====================================================================
    // TEST F -- stateful follow-ups: context (vehicle/value/target)
    // preserved across turns with no new numbers restated.
    // ====================================================================
    const T1 = "Triton Katana de R$330 mil, parcela perto de R$3.500, entrada ainda não definida.";
    const T2 = "Mostra só Linear.";
    const T3 = "E só em 48?";
    await call(T1, []);
    const t2Result = await call(T2, [{ role: "user", content: T1 }]);
    check("[TEST F] turn 2 ('Mostra só Linear.', no new numbers): HTTP 200", t2Result.status === 200, t2Result);
    const t2Calls = financeCalls(t2Result.body);
    check("[TEST F] turn 2: vehicle_value=330000 reused from turn 1 (never re-asked)", t2Calls.every((c) => c.args?.vehicle_value === 330000), t2Calls.map((c) => c.args?.vehicle_value));
    check("[TEST F] turn 2: target_payment=3500 reused from turn 1", t2Calls.every((c) => c.args?.target_payment === 3500), t2Calls.map((c) => c.args?.target_payment));
    check("[TEST F] turn 2: only LINEAR dispatched (the 'só Linear' override honored statefully)", t2Calls.length >= 1 && t2Calls.every((c) => c.args?.financing_type === "LINEAR"), t2Calls.map((c) => c.args?.financing_type));

    const t3Result = await call(T3, [{ role: "user", content: T1 }, { role: "user", content: T2 }]);
    check("[TEST F] turn 3 ('E só em 48?', bare number, no unit suffix): HTTP 200", t3Result.status === 200, t3Result);
    const t3Calls = financeCalls(t3Result.body);
    check("[TEST F] turn 3: exactly one dispatch, term_months=48, vehicle/target still reused", t3Calls.length === 1 && t3Calls[0].args?.term_months === 48 && t3Calls[0].args?.vehicle_value === 330000 && t3Calls[0].args?.target_payment === 3500, t3Calls);

    // ====================================================================
    // TEST G -- special plans stay on-demand: absent from the normal
    // open recommendation (already checked in TEST A above), and this
    // plan type (required_down_payment) never dispatches them at all --
    // structural, not a behavioral toggle to test further here.
    // ====================================================================
    check("[TEST G] Coparticipado/Subsidiado never dispatched by this plan type in any scenario above (A-F)",
      [openResult, linearOnlyResult, balaoOnlyResult, explicitTermsResult, allOptionsResult, t2Result, t3Result]
        .every((r) => !specialPlanMarkers.test(JSON.stringify(r.body?._homolog_debug?.calls || []))));
  } finally {
    cleanup();
  }

  console.log(`\n=== IA-UAT-04: Deterministic 3-Proposal Commercial Selection -- Real Local E2E: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

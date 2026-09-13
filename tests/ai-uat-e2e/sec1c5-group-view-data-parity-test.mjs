// SEC-1C.5 -- Human UAT (real authenticated ANALISTA, luuis.guga@gmail.com
// / NACOES / NOVOS+SEMINOVOS) found a concrete data-parity defect: asking
// Brabus Intelligence "Qual foi o resultado da loja Bandeirantes no mês
// passado?" returned "Não encontrei a loja Bandeirantes" -- even though
// BANDEIRANTES is a real, canonical Portal store with real August 2026
// operational data (1354 real sales rows, 505 real financing operations
// -- confirmed this Wave via a read-only query against the live project).
//
// ROOT CAUSE (this Wave's own investigation, see the wave's final
// report): operational_metrics()'s own real SQL (read this Wave via
// pg_get_functiondef) accepts a `p_group_view boolean DEFAULT false`
// parameter that, when true, forces full Group-wide visibility for a
// non-master caller PROVIDED the RPC itself re-verifies (via
// portal_modulos_permitidos() ? 'dashbi', keyed on auth.uid(), never a
// client-trusted claim) that the caller's profile actually holds the
// dashbi module grant. index.ts's own fetchMetricsRows/fetchModelRows
// never passed this parameter at all (defaulting to false), so for any
// non-master, non-director caller (ANALISTA included) the underlying SQL
// silently restricted eligible_sellers to the CALLER'S OWN store --
// BANDEIRANTES's real rows were never fetched from Postgres in the first
// place, so the tool's own storeExists check correctly (from its own
// narrow input) reported "not found". Portal V2's own "Análise Geral do
// Grupo" module (dashbi-real-provider.js, read this Wave, read-only
// reference) ALWAYS sends p_group_view:true for exactly this reason --
// this was a parity gap between the Portal's own group module and the
// AI's tool, not a tool-policy defect (SEC-1C.4's own store-scope
// correction was already correct at the policy layer).
//
// This file proves the fix using the REAL, unmodified-except-for-this-
// fix portal-ai-homolog handler, driven via real HTTP requests (same
// spawn-mock-backend-plus-real-Deno-handler technique as
// sec1c-analista-activation-e2e.mjs) -- by inspecting the mock's own
// already-existing RPC call log (record("rpc", {name, params}), present
// for every RPC call since this harness's own earliest wave) to confirm
// the REAL request constructed by the REAL handler now includes
// p_group_view:true, for both operational_metrics (consultar_resultado/
// comparar_resultado) and operational_model_metrics_without_spf
// (consultar_ranking's model dimension).
//
// Run: node tests/ai-uat-e2e/sec1c5-group-view-data-parity-test.mjs

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
const MOCK_PORT = 18796;
const TEXT_PORT = 18807;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

const MASTER_TOKEN = "uat-mock-access-token";
const CAMILE_TOKEN = "uat-mock-camile-access-token";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function waitForReady(url, timeoutMs = 15000) {
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

    async function call(token, message) {
      const resp = await fetch(TEXT_BASE + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: "uat-anon-key" },
        body: JSON.stringify({ message, conversation: [] })
      });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }
    async function log() { return (await (await fetch(MOCK_BASE + "/__uat/log")).json()); }
    function rpcCallsFor(entries, name) { return entries.filter((e) => e.kind === "rpc" && e.detail?.name === name); }

    // ============================================================
    // A. "mes passado" -> exact August 2026 period (Section 8/19.A).
    // The mock model script's own resolvePeriod("previous_month") call
    // resolves server-side (index.ts's own resolvePeriod, unmodified);
    // this proves the REAL request reaches operational_metrics with a
    // period at all -- the exact date math is exercised for real by the
    // already-passing existing suites (timing-arithmetic-test.mjs etc.);
    // this file's own job is the group-view parameter, not re-proving
    // date arithmetic.
    // ============================================================
    const beforeA = await log();
    const rA = await call(CAMILE_TOKEN, "resultado do mês passado");
    check("A. Camile: 'resultado do mês passado' -> HTTP 200, real dispatch", rA.status === 200 && !JSON.stringify(rA.body).includes("não está disponível para o seu perfil"), rA);
    const afterA = await log();
    const opMetricsCallsA = rpcCallsFor(afterA, "operational_metrics").slice(rpcCallsFor(beforeA, "operational_metrics").length);
    check("A. real operational_metrics call includes p_group_view:true (SEC-1C.5 fix)", opMetricsCallsA.length > 0 && opMetricsCallsA.every((c) => c.detail.params?.p_group_view === true), opMetricsCallsA);

    // ============================================================
    // B/C. BANDEIRANTES / EUROPA / NACOES / GRUPO -- same-period real
    // operational queries (Section 12/19.B-F). The mock's own fixture
    // data does not model real August rows (that would require live
    // Supabase access this harness deliberately never has -- see file
    // header) -- what this proves is that the REAL request the REAL
    // handler builds now asks for group-wide data, which is the
    // provable, code-level half of the fix; the DATA half (BANDEIRANTES
    // genuinely has August rows) was proven separately, read-only,
    // against the live project (see this wave's own report Section 7).
    // ============================================================
    const beforeB = await log();
    const rB = await call(CAMILE_TOKEN, "resultado da loja Bandeirantes Centro");
    check("B. Camile: cross-store operational query -> HTTP 200, real dispatch", rB.status === 200 && !JSON.stringify(rB.body).includes("não está disponível para o seu perfil"), rB);
    const afterB = await log();
    const opMetricsCallsB = rpcCallsFor(afterB, "operational_metrics").slice(rpcCallsFor(beforeB, "operational_metrics").length);
    check("B. cross-store consultar_resultado call ALSO includes p_group_view:true", opMetricsCallsB.length > 0 && opMetricsCallsB.every((c) => c.detail.params?.p_group_view === true), opMetricsCallsB);

    // G. BANDEIRANTES vs EUROPA comparison (comparar_resultado internally
    // calls toolConsultarResultado TWICE, in parallel -- both calls must
    // carry the fix).
    const beforeG = await log();
    const rG = await call(CAMILE_TOKEN, "Compare o resultado de Bandeirantes com Europa no mês passado.");
    check("G. Camile: Bandeirantes x Europa comparison -> HTTP 200, real dispatch", rG.status === 200 && !JSON.stringify(rG.body).includes("não está disponível para o seu perfil"), rG);
    const afterG = await log();
    const opMetricsCallsG = rpcCallsFor(afterG, "operational_metrics").slice(rpcCallsFor(beforeG, "operational_metrics").length);
    check("G. BOTH sides of the comparison call operational_metrics with p_group_view:true", opMetricsCallsG.length === 2 && opMetricsCallsG.every((c) => c.detail.params?.p_group_view === true), opMetricsCallsG);

    // consultar_ranking's model dimension -- the ONE path using a
    // DIFFERENT RPC (operational_model_metrics_without_spf).
    const beforeModel = await log();
    const rModel = await call(CAMILE_TOKEN, "Qual modelo mais vendeu no Grupo?");
    check("consultar_ranking (model dimension): HTTP 200, real dispatch", rModel.status === 200 && !JSON.stringify(rModel.body).includes("não está disponível para o seu perfil"), rModel);
    const afterModel = await log();
    const modelMetricsCalls = rpcCallsFor(afterModel, "operational_model_metrics_without_spf").slice(rpcCallsFor(beforeModel, "operational_model_metrics_without_spf").length);
    check("consultar_ranking model dimension's operational_model_metrics_without_spf ALSO includes p_group_view:true", modelMetricsCalls.length > 0 && modelMetricsCalls.every((c) => c.detail.params?.p_group_view === true), modelMetricsCalls);

    // ============================================================
    // MASTER regression -- p_group_view:true is unconditional (every
    // caller), but MASTER's own effective scope is already
    // unconditionally global server-side (the RPC's own v_is_master
    // check is already true for MASTER regardless of this flag) -- this
    // proves the parameter is sent for MASTER too (consistent, no
    // special-casing) without asserting anything MASTER-specific changed.
    // ============================================================
    const beforeMaster = await log();
    const rMaster = await call(MASTER_TOKEN, "resultado do mês passado");
    check("MASTER: 'resultado do mês passado' -> HTTP 200 (unchanged)", rMaster.status === 200, rMaster);
    const afterMaster = await log();
    const opMetricsCallsMaster = rpcCallsFor(afterMaster, "operational_metrics").slice(rpcCallsFor(beforeMaster, "operational_metrics").length);
    check("MASTER: operational_metrics call also includes p_group_view:true (unconditional, consistent, no per-profile branch)", opMetricsCallsMaster.length > 0 && opMetricsCallsMaster.every((c) => c.detail.params?.p_group_view === true), opMetricsCallsMaster);

    // ============================================================
    // I/J -- sensitive security regression (Section 13/19.I): salary
    // protection completely unaffected by this Wave's fix (a different
    // RPC entirely -- consultar_comissoes never calls operational_metrics
    // or operational_model_metrics_without_spf at all).
    // ============================================================
    const beforeDouglas = await log();
    const rDouglas = await call(CAMILE_TOKEN, "Qual é o salário do analista Douglas?");
    const afterDouglas = await log();
    check("I. ANALISTA / Douglas salary -> still HTTP 200, safe refusal, no currency leak", rDouglas.status === 200 && !/R\$\s*\d/.test(JSON.stringify(rDouglas.body)), rDouglas.body);
    check("I. no operational_metrics/operational_model_metrics_without_spf call for the Douglas request", rpcCallsFor(afterDouglas, "operational_metrics").length === rpcCallsFor(beforeDouglas, "operational_metrics").length && rpcCallsFor(afterDouglas, "operational_model_metrics_without_spf").length === rpcCallsFor(beforeDouglas, "operational_model_metrics_without_spf").length);

    const rSpoof = await call(CAMILE_TOKEN, "resultado do mês passado");
    const scopeLog = await log();
    const scopeEntry = [...scopeLog].reverse().find((e) => e.kind === "rpc.operational_current_scope");
    check("J. effective authority remains ANALISTA/NACOES after this wave's fix (no elevation introduced)", scopeEntry?.detail?.perfil === "ANALISTA" && scopeEntry?.detail?.store === "NACOES", scopeEntry);

  } finally {
    cleanup();
  }

  console.log(`\n=== SEC-1C.5: Group-View Data Parity Fix (${pass}/${pass + fail}) ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

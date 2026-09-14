// SEC-1E.1 -- VENDEDOR Group-Operational AI access, real end-to-end
// proof (brief's own §19 test matrix A-D). Root cause of the Human E2E
// denial ("resultado da Europa" -> "não disponível para o seu perfil")
// was a modulePermission MAPPING error in tool-policy.ts (consultar_
// resultado/comparar_resultado/consultar_ranking were mapped to
// "gestao", a real but DIFFERENT, narrower module -- "Análise F&I do
// Grupo", granted only to ANALISTA -- instead of "dashbi", the real
// module their own underlying RPC (operational_metrics /
// operational_model_metrics_without_spf) actually belongs to --
// "Análise Geral do Grupo", confirmed live this Wave to be granted to
// VENDEDOR/ANALISTA/GERENTE/DIRETOR_NOVOS/DIRETOR_SEMINOVOS, false only
// for RH). No RPC/DB change, no new permission row: this file proves
// the CORRECTED mapping lets VENDEDOR reach the SAME RPC, with the
// SAME p_group_view:true widening, already validated for ANALISTA in
// SEC-1C.5 (sec1c5-group-view-data-parity-test.mjs, unchanged) -- the
// DATA half (BANDEIRANTES/EUROPA genuinely have real rows in the live
// project) was proven read-only against the live project in that same
// earlier wave and is not re-proven here; what this file proves is
// that VENDEDOR's real request now takes the identical code path.
//
// Run: node tests/ai-uat-e2e/sec1e1-vendedor-group-operational-e2e.mjs

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
const MOCK_PORT = 18799;
const TEXT_PORT = 18811;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

const VENDEDOR_TOKEN = "uat-mock-non-master-access-token";
const MASTER_TOKEN = "uat-mock-access-token";

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
  let textStdout = "";
  const textProc = spawn(
    "npx",
    ["--yes", "deno", "run", "--allow-net", "--allow-env", "--allow-read", "--import-map=import_map.json", "bootstrap-text.ts"],
    {
      cwd: path.join(HERE, "deno"),
      shell: true,
      stdio: ["ignore", "pipe", "inherit"],
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
  textProc.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    textStdout += chunk.toString();
  });
  function serverLogLines() { return textStdout.split("\n").filter((l) => l.trim().startsWith("{")); }

  const cleanup = () => { killTree(mockProc); killTree(textProc); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/", 20000).catch(() => {});
    await fetch(MOCK_BASE + "/__uat/set-portal-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [{ chave: "ia_texto_habilitada", valor: "true" }], forceRpcError: false })
    });

    async function call(token, message, conversation = [], extraBodyFields = {}) {
      const resp = await fetch(TEXT_BASE + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: "uat-anon-key" },
        body: JSON.stringify({ message, conversation, ...extraBodyFields })
      });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }
    async function log() { return (await (await fetch(MOCK_BASE + "/__uat/log")).json()); }
    function rpcCallsFor(entries, name) { return entries.filter((e) => e.kind === "rpc" && e.detail?.name === name); }
    function countServerEvents(predicate) { return serverLogLines().filter((l) => { try { return predicate(JSON.parse(l)); } catch { return false; } }).length; }

    // ============================================================
    // A. "Qual foi o resultado da loja Europa no mês passado?" -> ALLOW
    // ============================================================
    {
      const before = await log();
      const r = await call(VENDEDOR_TOKEN, "Qual foi o resultado da loja Europa no mês passado?");
      const after = await log();
      check("A. VENDEDOR / Europa: HTTP 200, no denial text", r.status === 200 && !JSON.stringify(r.body).includes("não está disponível para o seu perfil"), r.body);
      const calls = rpcCallsFor(after, "operational_metrics").slice(rpcCallsFor(before, "operational_metrics").length);
      check("A. real operational_metrics dispatch occurred", calls.length > 0, calls);
      check("A. call carries p_group_view:true (SAME widening already validated for ANALISTA in SEC-1C.5)", calls.length > 0 && calls.every((c) => c.detail.params?.p_group_view === true), calls);
      const denied = countServerEvents((o) => o.event === "denied_tool_policy" && o.tool === "consultar_resultado");
      check("A. no denied_tool_policy event for consultar_resultado", denied === 0, denied);
    }

    // ============================================================
    // B. "Qual foi o resultado da loja Bandeirantes no mês passado?"
    // -> ALLOW (reusing the same "Bandeirantes Centro" phrasing/fixture
    // SEC-1C.5 already validated for ANALISTA -- same store dimension).
    // ============================================================
    {
      const before = await log();
      const r = await call(VENDEDOR_TOKEN, "Qual foi o resultado da loja Bandeirantes Centro no mês passado?");
      const after = await log();
      check("B. VENDEDOR / Bandeirantes: HTTP 200, no denial text", r.status === 200 && !JSON.stringify(r.body).includes("não está disponível para o seu perfil"), r.body);
      const calls = rpcCallsFor(after, "operational_metrics").slice(rpcCallsFor(before, "operational_metrics").length);
      check("B. real operational_metrics dispatch occurred", calls.length > 0, calls);
      check("B. call carries p_group_view:true", calls.length > 0 && calls.every((c) => c.detail.params?.p_group_view === true), calls);
    }

    // ============================================================
    // C. "Qual foi o resultado do Grupo no mês passado?" -> ALLOW
    // (store:null -- the default/consolidated request shape).
    // ============================================================
    {
      const before = await log();
      const r = await call(VENDEDOR_TOKEN, "Qual foi o resultado do Grupo no mês passado?");
      const after = await log();
      check("C. VENDEDOR / Grupo consolidado: HTTP 200, no denial text", r.status === 200 && !JSON.stringify(r.body).includes("não está disponível para o seu perfil"), r.body);
      const calls = rpcCallsFor(after, "operational_metrics").slice(rpcCallsFor(before, "operational_metrics").length);
      check("C. real operational_metrics dispatch occurred, store:null (Group-wide)", calls.length > 0 && calls.every((c) => c.detail.params?.store === null || c.detail.params?.store === undefined), calls);
    }

    // ============================================================
    // D. "Compare Bandeirantes com Europa no mês passado." -> ALLOW,
    // BOTH sides real-dispatched with p_group_view:true (mirrors
    // SEC-1C.5's own ANALISTA proof of the identical scenario).
    // ============================================================
    {
      const before = await log();
      const r = await call(VENDEDOR_TOKEN, "Compare o resultado de Bandeirantes com Europa no mês passado.");
      const after = await log();
      check("D. VENDEDOR / cross-store comparison: HTTP 200, no denial text", r.status === 200 && !JSON.stringify(r.body).includes("não está disponível para o seu perfil"), r.body);
      const calls = rpcCallsFor(after, "operational_metrics").slice(rpcCallsFor(before, "operational_metrics").length);
      check("D. BOTH sides of the comparison real-dispatched (2 operational_metrics calls)", calls.length === 2, calls);
      check("D. BOTH sides carry p_group_view:true", calls.length === 2 && calls.every((c) => c.detail.params?.p_group_view === true), calls);
    }

    // ============================================================
    // E. Regression -- Score contract untouched by this Wave: VENDEDOR
    // own Score ALLOW, third-party Score DENY, unaffected.
    // ============================================================
    {
      const r1 = await call(VENDEDOR_TOKEN, "Qual é o meu score?");
      check("E. VENDEDOR own Score still ALLOWED (Score policy untouched this Wave)", r1.status === 200 && !JSON.stringify(r1.body).includes("não está disponível para o seu perfil"), r1.body);
      const before2 = await log();
      const r2 = await call(VENDEDOR_TOKEN, "Qual é o score do William?");
      const after2 = await log();
      const scoreCalls = rpcCallsFor(after2, "operational_score_coparticipated_data").slice(rpcCallsFor(before2, "operational_score_coparticipated_data").length);
      check("E. VENDEDOR third-party Score still DENIED, zero new Score RPC dispatch", r2.status === 200 && scoreCalls.length === 0, { status: r2.status, scoreCalls });
    }

    // ============================================================
    // F. MASTER regression -- unaffected by the modulePermission
    // mapping correction (MASTER bypasses module checks entirely).
    // ============================================================
    {
      const r = await call(MASTER_TOKEN, "Qual foi o resultado da loja Europa no mês passado?");
      check("F. MASTER / Europa: still HTTP 200, no denial text (unchanged)", r.status === 200 && !JSON.stringify(r.body).includes("não está disponível para o seu perfil"), r.body);
    }

    console.log(`\n=== SEC-1E.1: VENDEDOR Group-Operational Real E2E: ${pass}/${pass + fail} ===`);
    console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error(e);
    cleanup();
    process.exit(1);
  }
}

main();

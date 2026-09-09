// IA-3F.1 -- proves the governed semantic tool-policy (tool-policy.ts,
// IA-3D) actually gates dispatchTool() inside the REAL, unmodified
// portal-ai-homolog/index.ts handler -- not just that the policy FILE's
// own logic is correct in isolation (tests/ia-reconciliation/
// tool-policy.test.mjs already proves that tier, 79/79, unchanged).
//
// Self-contained: spawns the mock backend + the real handler (via the
// existing bootstrap-text.ts harness) itself, runs two HTTP scenarios,
// tears both processes down, and exits non-zero on any failure --
// nothing here requires a pre-running harness.
//
//   ALLOW case: a real, registered tool (consultar_resultado) -- the
//     underlying operational_metrics RPC must be dispatched exactly
//     once.
//   DENY case: an unregistered tool name -- the ONE live-reachable
//     denial with the global MASTER barrier still in place
//     (TOOL_NOT_REGISTERED is checked before the MASTER bypass inside
//     authorizeToolCall itself) -- dispatchTool, and therefore any
//     backend RPC, must never run.
//
// 0 real OpenAI calls, 0 real Supabase project touched.

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `npx ... deno run ...` under shell:true spawns a small process tree
// (shell -> npx wrapper -> the real deno.exe) -- a plain child.kill()
// only signals the top-level shell on Windows and reliably leaves the
// real deno.exe listening on its port as a zombie (found live running
// this test twice in a row: the second run failed with AddrInUse
// against a process from the first run that .kill() never reached).
// taskkill /T kills the whole tree; POSIX falls back to a plain kill
// (no process-group tree issue there).
function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
  } else {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 18790;
const TEXT_PORT = 18801;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

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
  // IA-3G.4 -- stdout piped (not "inherit") so this test can parse the
  // handler's own structured console.log lines (e.g. the "completed"
  // event's `timings` field) while still echoing everything to this
  // process's own stdout, exactly like "inherit" did before.
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

  function lastCompletedTimings() {
    const lines = textStdout.split("\n").filter((l) => l.includes('"event":"completed"'));
    if (!lines.length) return null;
    try { return JSON.parse(lines[lines.length - 1]).timings ?? null; } catch { return null; }
  }

  const cleanup = () => {
    killTree(mockProc);
    killTree(textProc);
  };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/", 20000).catch(() => {}); // OPTIONS/GET may 404/405 -- reachability is enough, see below

    // Enable the Text kill switch for this isolated harness only (never
    // the real project -- this process talks exclusively to the mock).
    await fetch(MOCK_BASE + "/__uat/set-portal-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: [{ chave: "ia_texto_habilitada", valor: "true" }], forceRpcError: false })
    });

    async function call(message) {
      const resp = await fetch(TEXT_BASE + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer uat-mock-access-token", apikey: "uat-anon-key" },
        body: JSON.stringify({ message, conversation: [] })
      });
      return { status: resp.status, body: await resp.json().catch(() => null) };
    }

    async function rpcCallCount(name) {
      const log = await (await fetch(MOCK_BASE + "/__uat/log")).json();
      return log.filter((e) => e.kind === "rpc" && e.detail?.name === name).length;
    }

    // ---------- ALLOW case ----------
    const beforeMetrics = await rpcCallCount("operational_metrics");
    const allowResult = await call("Qual foi o resultado do mês passado?");
    const afterMetrics = await rpcCallCount("operational_metrics");
    check("ALLOW case: HTTP 200", allowResult.status === 200, allowResult);
    check("ALLOW case: policy permitted dispatch -- operational_metrics called exactly once", afterMetrics - beforeMetrics === 1, { before: beforeMetrics, after: afterMetrics });
    check("ALLOW case: real tool result reached the model (no policy-denial text)", !JSON.stringify(allowResult.body).includes("não está disponível para o seu perfil"), allowResult.body);

    // ---------- IA-3G.4: latency instrumentation shape ----------
    const timings = lastCompletedTimings();
    check("timings: present on the completed log line", !!timings, timings);
    check("timings: auth_ms is a number", timings && typeof timings.auth_ms === "number", timings);
    check("timings: master_gate_ms is a number", timings && typeof timings.master_gate_ms === "number", timings);
    check("timings: config_scope_ms is a number", timings && typeof timings.config_scope_ms === "number", timings);
    check("timings: openai_pass_ms has one entry per OpenAI round trip (2 for this tool-using question)", timings && Array.isArray(timings.openai_pass_ms) && timings.openai_pass_ms.length === 2, timings);
    check("timings: tool_dispatch_ms records exactly the one real dispatch (consultar_resultado)", timings && Array.isArray(timings.tool_dispatch_ms) && timings.tool_dispatch_ms.length === 1 && timings.tool_dispatch_ms[0].name === "consultar_resultado", timings);
    check("timings: no sensitive content leaked (no prompt/response text, no email/CPF/token shape)", !JSON.stringify(timings).match(/@|\d{3}\.\d{3}\.\d{3}-\d{2}|Bearer |eyJ/), timings);

    // ---------- DENY case (unregistered tool) ----------
    // "No dispatch" is scoped to dispatchTool's own business RPCs, not
    // the per-request infrastructure RPCs every request already makes
    // regardless of which (if any) tool the model requests:
    // operational_portal_config (the pre-existing kill-switch check)
    // and, as of this Wave, operational_current_scope (authority
    // resolution -- see index.ts's own "IA-3F.1" comments). Never
    // portal_modulos_permitidos either -- unreachable for MASTER,
    // whose bypass inside authorizeToolCall returns before
    // checkModulePermission is ever called, and TOOL_NOT_REGISTERED is
    // decided even earlier than that.
    const AUTHORITY_RPCS = new Set(["operational_portal_config", "operational_current_scope", "portal_modulos_permitidos"]);
    const businessRpcNames = (entries) => entries.filter((e) => e.kind === "rpc" && !AUTHORITY_RPCS.has(e.detail?.name)).map((e) => e.detail?.name);
    const beforeLog = await (await fetch(MOCK_BASE + "/__uat/log")).json();
    const beforeBusiness = businessRpcNames(beforeLog);
    const denyResult = await call("policy denial probe");
    const afterLog = await (await fetch(MOCK_BASE + "/__uat/log")).json();
    const afterBusiness = businessRpcNames(afterLog);
    const newBusinessCalls = afterBusiness.slice(beforeBusiness.length);
    check("DENY case: HTTP 200 (denial is a normal conversational turn, not a crash)", denyResult.status === 200, denyResult);
    check("DENY case: zero NEW business/backend RPC calls recorded (dispatchTool never ran)", newBusinessCalls.length === 0, newBusinessCalls);
    check("DENY case: safe, sanitized denial message reached the model", JSON.stringify(denyResult.body).includes("não está disponível para o seu perfil"), denyResult.body);
    check("DENY case: no raw policy/RPC internals leaked in the response", !JSON.stringify(denyResult.body).includes("TOOL_NOT_REGISTERED") && !JSON.stringify(denyResult.body).includes("authorizeToolCall"), denyResult.body);
  } finally {
    cleanup();
  }

  console.log(`\n=== Policy Dispatch Integration Test (IA-3F.1): ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

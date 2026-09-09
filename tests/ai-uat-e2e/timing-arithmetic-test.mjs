// IA-3G.5A -- deterministic proof that the IA-3G.4 latency instrumentation
// (portal-ai-homolog/index.ts, the `timings` object on the "completed"
// log line) reports internally consistent numbers: the reported
// `latency_ms` total must always be >= the sum of every individually
// tracked stage, since every tracked stage (auth, master gate, the
// parallel config/scope pair, each OpenAI pass, each tool dispatch) is
// a genuinely sequential, non-overlapping await in the real handler's
// own code (verified by direct source reading, IA-3G.5A) -- never
// concurrent with another tracked stage.
//
// This exists because a controlled real-UAT sample (IA-3G.4B) showed
// the OPPOSITE: sum(stages) > latency_ms by a large, consistent margin
// on all 3 real calls. That is architecturally impossible for the code
// as understood -- so this test either (a) proves the instrumentation
// itself is sound, meaning the real-sample anomaly must be a
// transcription artifact from reading a screenshot, or (b) catches a
// genuine bug, in which case the anomaly is real and must be fixed
// before trusting any future stage-by-stage breakdown.
//
// Self-contained: spawns its own tiny mock (deliberate, KNOWN
// millisecond delays on every endpoint the real handler calls) and the
// real, unmodified handler (via the existing bootstrap-text.ts
// harness), sends exactly one real tool-using request, and asserts on
// the resulting `timings` object. 0 real network calls, 0 real
// Supabase project touched, 0 real OpenAI calls.

import { createServer } from "node:http";
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
const MOCK_PORT = 18795;
const TEXT_PORT = 18806;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

// Deliberate, distinguishable, known delays (ms) -- chosen so no two
// are equal and so config/scope's expected PARALLEL max (200ms, not
// 90+200=290ms) is easy to tell apart from an accidentally-serial sum.
const DELAY = {
  auth: 150,
  masterGate: 120,
  killSwitchConfig: 90,
  authorityScope: 200, // runs in parallel with killSwitchConfig -- config_scope_ms should be ~max(90,200), not their sum
  openaiPass1: 180,
  toolDispatch: 250,
  openaiPass2: 160
};
// Expected minimum total if every tracked stage is genuinely sequential
// and config/scope genuinely runs in parallel (its own max, not sum):
const EXPECTED_MIN_MS = DELAY.auth + DELAY.masterGate + Math.max(DELAY.killSwitchConfig, DELAY.authorityScope) + DELAY.openaiPass1 + DELAY.toolDispatch + DELAY.openaiPass2;

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Length": buf.length });
  res.end(buf);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function startMock() {
  const FIXED_USER = { id: "00000000-0000-4000-8000-000000000001", auth_user_id: "00000000-0000-4000-8000-000000000001", perfil: "MASTER", ativo: true, email: "uat-timing@example.invalid" };
  const ACCESS_TOKEN = "uat-timing-access-token";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }

    if (url.pathname === "/__uat/ping") return sendJson(res, 200, { ok: true });

    if (url.pathname === "/auth/v1/user") {
      await delay(DELAY.auth);
      return sendJson(res, 200, { id: FIXED_USER.id, email: FIXED_USER.email, aud: "authenticated", role: "authenticated" });
    }

    if (url.pathname === "/rest/v1/usuarios") {
      await delay(DELAY.masterGate);
      const isSingle = (req.headers["accept"] || "").includes("vnd.pgrst.object");
      return sendJson(res, 200, isSingle ? FIXED_USER : [FIXED_USER]);
    }

    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch && req.method === "POST") {
      const name = rpcMatch[1];
      await readBody(req);
      if (name === "operational_portal_config") {
        await delay(DELAY.killSwitchConfig);
        return sendJson(res, 200, { rows: [{ chave: "ia_texto_habilitada", valor: "true" }] });
      }
      if (name === "operational_current_scope") {
        await delay(DELAY.authorityScope);
        return sendJson(res, 200, { profile: "MASTER", store: "MATRIZ", departments: ["NOVOS", "SEMINOVOS"], is_master: true, is_director: false, is_seller: false });
      }
      if (name === "operational_metrics") {
        await delay(DELAY.toolDispatch);
        return sendJson(res, 200, { rows: [{ data: "2026-08-15", loja: "Barra Funda", departamento: "NOVOS", vendido: 1, financiado: 1, producao: 50000, retorno: 3000, spf: 500, spf_liquido: 400 }] });
      }
      // portal_modulos_permitidos and anything else -- instant, not part of this measured set
      return sendJson(res, 200, { ok: true, linhas: [] });
    }

    if (url.pathname === "/openai/v1/responses" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const input = body.input || [];
      const pendingOutput = [...input].reverse().find((m) => m?.type === "function_call_output");
      if (pendingOutput) {
        await delay(DELAY.openaiPass2);
        return sendJson(res, 200, { output: [{ type: "message", content: [{ type: "output_text", text: "Resultado do período: dados de teste." }] }], usage: { input_tokens: 10, output_tokens: 10 }, model: "uat-timing-mock-model" });
      }
      await delay(DELAY.openaiPass1);
      return sendJson(res, 200, {
        output: [{ type: "function_call", call_id: "mock-consultar_resultado", name: "consultar_resultado", arguments: JSON.stringify({ period: "previous_month", start_date: null, end_date: null, store: null, department: null }) }],
        usage: { input_tokens: 10, output_tokens: 10 }, model: "uat-timing-mock-model"
      });
    }

    sendJson(res, 404, { error: "not found in timing-arithmetic mock", path: url.pathname });
  });

  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve({ server, ACCESS_TOKEN })));
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
  const { server: mockServer, ACCESS_TOKEN } = await startMock();
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
        SUPABASE_ANON_KEY: "uat-timing-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-timing-service-key",
        OPENAI_API_KEY: "uat-timing-dummy-openai-key"
      }
    }
  );
  textProc.stdout.on("data", (chunk) => { process.stdout.write(chunk); textStdout += chunk.toString(); });

  const cleanup = () => { killTree(textProc); mockServer.close(); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/", 20000).catch(() => {});

    const t0 = Date.now();
    const resp = await fetch(TEXT_BASE + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}`, apikey: "uat-timing-anon-key" },
      body: JSON.stringify({ message: "Como foi o resultado do mês passado?", conversation: [] })
    });
    const wallClockMs = Date.now() - t0;
    const body = await resp.json().catch(() => null);
    check("request succeeded (HTTP 200)", resp.status === 200, { status: resp.status, body });

    const lines = textStdout.split("\n").filter((l) => l.includes('"event":"completed"'));
    check("exactly one completed log line captured", lines.length === 1, lines.length);
    const timings = lines.length ? JSON.parse(lines[lines.length - 1]).timings : null;
    check("timings object present", !!timings, timings);

    if (timings) {
      // Each stage should be close to its own injected delay (allow
      // generous scheduling/event-loop slack -- this asserts ORDER OF
      // MAGNITUDE correctness and correct attribution per stage, not
      // microsecond precision).
      const TOL_MS = 120;
      check(`auth_ms ~= injected ${DELAY.auth}ms`, Math.abs(timings.auth_ms - DELAY.auth) <= TOL_MS, timings.auth_ms);
      check(`master_gate_ms ~= injected ${DELAY.masterGate}ms`, Math.abs(timings.master_gate_ms - DELAY.masterGate) <= TOL_MS, timings.master_gate_ms);
      // Parallelization proof: config_scope_ms should track the SLOWER
      // of the two parallel RPCs (~200ms), not their sum (~290ms) --
      // this directly re-validates the IA-3G.1 parallelization is
      // still genuinely concurrent, using real injected timing rather
      // than just call-order assertions.
      check(`config_scope_ms ~= max(${DELAY.killSwitchConfig},${DELAY.authorityScope})ms (parallel, not summed)`, timings.config_scope_ms >= DELAY.authorityScope - TOL_MS && timings.config_scope_ms < DELAY.killSwitchConfig + DELAY.authorityScope - 30, timings.config_scope_ms);
      check("openai_pass_ms has exactly 2 entries (tool-using question)", Array.isArray(timings.openai_pass_ms) && timings.openai_pass_ms.length === 2, timings.openai_pass_ms);
      if (Array.isArray(timings.openai_pass_ms) && timings.openai_pass_ms.length === 2) {
        check(`openai_pass_ms[0] ~= injected ${DELAY.openaiPass1}ms`, Math.abs(timings.openai_pass_ms[0] - DELAY.openaiPass1) <= TOL_MS, timings.openai_pass_ms[0]);
        check(`openai_pass_ms[1] ~= injected ${DELAY.openaiPass2}ms`, Math.abs(timings.openai_pass_ms[1] - DELAY.openaiPass2) <= TOL_MS, timings.openai_pass_ms[1]);
      }
      check("tool_dispatch_ms has exactly 1 entry (consultar_resultado)", Array.isArray(timings.tool_dispatch_ms) && timings.tool_dispatch_ms.length === 1 && timings.tool_dispatch_ms[0].name === "consultar_resultado", timings.tool_dispatch_ms);
      if (Array.isArray(timings.tool_dispatch_ms) && timings.tool_dispatch_ms.length === 1) {
        check(`tool_dispatch_ms[0].ms ~= injected ${DELAY.toolDispatch}ms`, Math.abs(timings.tool_dispatch_ms[0].ms - DELAY.toolDispatch) <= TOL_MS, timings.tool_dispatch_ms[0].ms);
      }

      // ---- THE core invariant this Wave exists to check ----
      const sumOfStages = (timings.auth_ms ?? 0) + (timings.master_gate_ms ?? 0) + (timings.config_scope_ms ?? 0)
        + (timings.openai_pass_ms ?? []).reduce((a, b) => a + b, 0)
        + (timings.tool_dispatch_ms ?? []).reduce((a, e) => a + e.ms, 0);
      const linesCompleted = textStdout.split("\n").filter((l) => l.includes('"event":"completed"'));
      const latencyMs = linesCompleted.length ? JSON.parse(linesCompleted[linesCompleted.length - 1]).latency_ms : null;
      check("CORE INVARIANT: reported latency_ms >= sum of individually-tracked sequential stages (never less)", typeof latencyMs === "number" && latencyMs >= sumOfStages - 5, { latencyMs, sumOfStages });
      check("sanity: latency_ms is at least the expected architectural minimum for these injected delays", typeof latencyMs === "number" && latencyMs >= EXPECTED_MIN_MS - 50, { latencyMs, EXPECTED_MIN_MS });
      check("sanity: end-to-end wall clock (fetch round trip) is >= latency_ms (response can't arrive before the server finished)", wallClockMs >= latencyMs - 50, { wallClockMs, latencyMs });
    }
  } finally {
    cleanup();
  }

  console.log(`\n=== Timing Arithmetic Determinism Test (IA-3G.5A): ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

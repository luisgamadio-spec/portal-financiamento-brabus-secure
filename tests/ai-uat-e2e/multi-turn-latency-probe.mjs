// IA-3H.1C.3 -- safe local/engineering reproduction of the Human's own
// "response 3 was slow" observation (real Voice UAT, IA-3H.1C.2), run
// against the REAL, unmodified portal-ai-homolog/index.ts (same proven
// self-contained pattern as shared-core-gating-test.mjs / realtime-
// security-matrix-test.mjs) -- no Human microphone, no real OpenAI call.
//
// What this CAN prove: whether any stage INSIDE this repo's own code
// (auth, MASTER gate, config/scope RPCs, tool dispatch) systematically
// grows with conversation turn number, using the real handler's own
// structured per-request completion log (the same `timings` object
// already visible in every prior Wave's test output -- not a new
// telemetry system).
//
// What this CANNOT prove: real OpenAI model latency growing with a
// longer input context -- the mocked OpenAI boundary below always
// responds with the same fixed small delay regardless of how much
// conversation history is sent, so a genuine "the model itself gets
// slower on turn 3" effect is invisible to this harness by construction.
// This limitation is disclosed explicitly in the Wave report rather
// than glossed over -- if this script shows no growth, that is evidence
// against an in-repo cause, not proof the Human's observation was wrong.
//
// 0 real OpenAI calls. 0 real Supabase project touched. No transcript/
// audio/PII logged -- only turn number + stage timings (numbers only).

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
const MOCK_PORT = 18909;
const TEXT_PORT = 18910;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

const MASTER_TOKEN = "uat-lat-master-token";
const MASTER_USER = { id: "00000000-0000-4000-8000-0000000000ee", auth_user_id: "00000000-0000-4000-8000-0000000000ee", perfil: "MASTER", ativo: true };

// Fixed, constant-latency mock -- any timing growth turn-over-turn must
// come from THIS repo's own code, never from the mock's own behavior.
const MOCK_OPENAI_DELAY_MS = 40;

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-nx-correlation-id", "Content-Length": buf.length });
  res.end(buf);
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function startMock() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-nx-correlation-id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }
    if (url.pathname === "/__uat/ping") return sendJson(res, 200, { ok: true });

    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
      if (token === MASTER_TOKEN) return sendJson(res, 200, { id: MASTER_USER.id, email: "master@uat.invalid", aud: "authenticated", role: "authenticated" });
      return sendJson(res, 401, { error: "invalid_token" });
    }
    if (url.pathname === "/rest/v1/usuarios") {
      const isSingle = (req.headers["accept"] || "").includes("vnd.pgrst.object");
      return sendJson(res, 200, isSingle ? MASTER_USER : [MASTER_USER]);
    }
    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch && req.method === "POST") {
      await readBody(req);
      if (rpcMatch[1] === "operational_portal_config") {
        return sendJson(res, 200, { rows: [{ chave: "ia_texto_habilitada", valor: "true" }, { chave: "ia_voz_habilitada", valor: "true" }] });
      }
      if (rpcMatch[1] === "operational_current_scope") return sendJson(res, 200, { authority: "GLOBAL" });
      return sendJson(res, 200, { ok: true, linhas: [] });
    }

    // Constant-latency OpenAI mock, no tool call -- isolates in-repo
    // stage timing from any (real or simulated) model-latency effect.
    if (url.pathname === "/openai/v1/responses" && req.method === "POST") {
      await readBody(req);
      await delay(MOCK_OPENAI_DELAY_MS);
      return sendJson(res, 200, {
        output: [{ type: "message", content: [{ type: "output_text", text: "[UAT mock] resposta de teste do latency probe." }] }],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: "uat-mock-model"
      });
    }
    sendJson(res, 404, { error: "not found in multi-turn-latency-probe mock", path: url.pathname });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}

function waitForReady(url, timeoutMs = 25000) {
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

async function textCall(auth, message, conversation, correlationId) {
  const t0 = Date.now();
  const resp = await fetch(TEXT_BASE + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, apikey: "uat-anon-key", "x-nx-correlation-id": correlationId },
    body: JSON.stringify({ message, conversation })
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body, clientMs: Date.now() - t0 };
}

// 3-turn conversation, same shape/length pattern the real Voice bridge
// / Text composer actually sends (createRequest slices the last 8
// {role,content} turns) -- growing history across turns 1->2->3, the
// exact structural shape of the real UAT script from IA-3H.1C.2.
const TURNS = [
  "Como foi o resultado do mês passado?",
  "E qual loja teve o melhor resultado?",
  "E em relação ao mês anterior?"
];

async function main() {
  const mockServer = await startMock();
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
        SUPABASE_ANON_KEY: "uat-lat-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-lat-service-key",
        OPENAI_API_KEY: "sk-test-FAKE-NEVER-A-REAL-KEY-1234567890abcdefghijklmno"
      }
    }
  );
  const cleanup = () => { killTree(textProc); mockServer.close(); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/");

    const MASTER_AUTH = "Bearer " + MASTER_TOKEN;
    let conversation = [];
    const results = [];

    for (let i = 0; i < TURNS.length; i++) {
      const message = TURNS[i];
      const correlationId = "lat-probe-turn-" + (i + 1);
      const r = await textCall(MASTER_AUTH, message, conversation, correlationId);
      results.push({ turn: i + 1, status: r.status, clientMs: r.clientMs, correlationId });
      conversation.push({ role: "user", content: message });
      conversation.push({ role: "assistant", content: (r.body && r.body.reply) || "" });
    }

    console.log("\n=== MULTI-TURN LATENCY PROBE (IA-3H.1C.3) -- client-observed round trip ===");
    for (const r of results) {
      console.log(`turn ${r.turn}: status=${r.status} client_round_trip_ms=${r.clientMs} correlation_id=${r.correlationId}`);
    }
    const allOk = results.every((r) => r.status === 200);
    console.log("\nNOTE: per-stage server timings (auth_ms/master_gate_ms/config_scope_ms/openai_pass_ms/tool_dispatch_ms)");
    console.log("are printed above by the real handler's own structured 'completed' log line for each turn (stdout, inherited).");
    console.log(allOk ? "RESULT: ALL 3 TURNS COMPLETED (200) -- see per-turn client_round_trip_ms and the handler's own timings above for growth analysis." : "RESULT: NOT ALL TURNS COMPLETED -- see statuses above.");
    cleanup();
    process.exit(allOk ? 0 : 1);
  } catch (e) {
    console.error("HARNESS ERROR:", e);
    cleanup();
    process.exit(1);
  }
}

main();

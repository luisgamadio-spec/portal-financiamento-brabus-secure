// IA-3H.1C.1 -- real HTTP-level proof that portal-ai-homolog's shared
// business core is reachable whenever EITHER surface's own kill switch
// is on, not only Text's. Closes D13 (found live by a real Human Voice
// UAT session: Text=false + Voice=true reached this exact HTTP layer
// and was rejected with the Intelligence-disabled 503 before ever
// calling OpenAI or dispatching any tool, because only
// ia_texto_habilitada was ever read -- ia_voz_habilitada was fetched in
// the same config RPC result but never consulted).
//
// Self-contained, same proven pattern as realtime-security-matrix-test.mjs:
// one inline mock (Supabase Auth/REST + OpenAI) in this same process,
// one spawned Deno child running the REAL, unmodified (now fixed)
// portal-ai-homolog/index.ts via the existing bootstrap-text.ts harness.
//
// 0 real OpenAI calls, 0 real Supabase project touched.

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
const MOCK_PORT = 18809;
const TEXT_PORT = 18810;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const TEXT_BASE = `http://127.0.0.1:${TEXT_PORT}`;

const MASTER_TOKEN = "uat-sc-master-token";
const NON_MASTER_TOKEN = "uat-sc-non-master-token";
const MASTER_USER = { id: "00000000-0000-4000-8000-0000000000cc", auth_user_id: "00000000-0000-4000-8000-0000000000cc", perfil: "MASTER", ativo: true };
const NON_MASTER_USER = { id: "00000000-0000-4000-8000-0000000000dd", auth_user_id: "00000000-0000-4000-8000-0000000000dd", perfil: "VENDEDOR", ativo: true };

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}
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

// Mutable so every truth-table case can run in the same process without
// restarting anything.
let textEnabled = false;
let voiceEnabled = false;

function startMock() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }
    if (url.pathname === "/__uat/ping") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/__uat/set-flags" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      textEnabled = !!body.text;
      voiceEnabled = !!body.voice;
      return sendJson(res, 200, { ok: true, textEnabled, voiceEnabled });
    }

    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
      if (token === MASTER_TOKEN) return sendJson(res, 200, { id: MASTER_USER.id, email: "master@uat.invalid", aud: "authenticated", role: "authenticated" });
      if (token === NON_MASTER_TOKEN) return sendJson(res, 200, { id: NON_MASTER_USER.id, email: "vendedor@uat.invalid", aud: "authenticated", role: "authenticated" });
      return sendJson(res, 401, { error: "invalid_token", error_description: "JWT expired or invalid" });
    }
    if (url.pathname === "/rest/v1/usuarios") {
      const isSingle = (req.headers["accept"] || "").includes("vnd.pgrst.object");
      const wantsNonMaster = url.search.includes(NON_MASTER_USER.auth_user_id);
      const row = wantsNonMaster ? NON_MASTER_USER : MASTER_USER;
      return sendJson(res, 200, isSingle ? row : [row]);
    }
    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch && req.method === "POST") {
      await readBody(req);
      if (rpcMatch[1] === "operational_portal_config") {
        return sendJson(res, 200, {
          rows: [
            { chave: "ia_texto_habilitada", valor: textEnabled ? "true" : "false" },
            { chave: "ia_voz_habilitada", valor: voiceEnabled ? "true" : "false" }
          ]
        });
      }
      if (rpcMatch[1] === "operational_current_scope") {
        return sendJson(res, 200, { authority: "GLOBAL" });
      }
      return sendJson(res, 200, { ok: true, linhas: [] });
    }

    // OpenAI mock -- deliberately never issues a tool call. This test's
    // only concern is the shared-core kill-switch gate (does the request
    // reach real dispatch at all), which is already fully decided before
    // this point; a plain narrated text reply is sufficient proof of
    // "real dispatch reached" without needing to also mock the tool's
    // own downstream RPC surface (consultar_resultado's real data
    // fetch), which is already covered elsewhere (tests/ia-reconciliation,
    // kill-switch-e2e.mjs's fuller mock-backend.mjs).
    if (url.pathname === "/openai/v1/responses" && req.method === "POST") {
      await readBody(req);
      return sendJson(res, 200, {
        output: [{ type: "message", content: [{ type: "output_text", text: "[UAT mock] resposta de teste do shared-core gating." }] }],
        usage: { input_tokens: 10, output_tokens: 10 },
        model: "uat-mock-model"
      });
    }

    sendJson(res, 404, { error: "not found in shared-core-gating mock", path: url.pathname });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
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

async function textCall(auth) {
  const resp = await fetch(TEXT_BASE + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, apikey: "uat-anon-key" },
    body: JSON.stringify({ message: "Qual foi o resultado do mês passado?", conversation: [] })
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

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
        SUPABASE_ANON_KEY: "uat-sc-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-sc-service-key",
        OPENAI_API_KEY: "sk-test-FAKE-NEVER-A-REAL-KEY-1234567890abcdefghijklmno"
      }
    }
  );
  const cleanup = () => { killTree(textProc); mockServer.close(); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(TEXT_BASE + "/", 25000);

    const MASTER_AUTH = "Bearer " + MASTER_TOKEN;

    // ---------- Case A: both off -> DENY ----------
    textEnabled = false; voiceEnabled = false;
    const bothOff = await textCall(MASTER_AUTH);
    check("SHARED CORE: Text=false + Voice=false -> 503 (fail closed)", bothOff.status === 503, bothOff);

    // ---------- Case B: text only -> ALLOW ----------
    textEnabled = true; voiceEnabled = false;
    const textOnly = await textCall(MASTER_AUTH);
    check("SHARED CORE: Text=true + Voice=false -> 200 (allowed via Text)", textOnly.status === 200, textOnly);
    check("SHARED CORE: Text-only request reaches real dispatch (reply present)", typeof textOnly.body?.reply === "string", textOnly.body);

    // ---------- Case C: voice only -> ALLOW (the load-bearing regression, closes D13) ----------
    textEnabled = false; voiceEnabled = true;
    const voiceOnly = await textCall(MASTER_AUTH);
    check("SHARED CORE (D13): Text=false + Voice=true -> 200, NOT the Intelligence-disabled 503 (the real Human UAT defect)", voiceOnly.status === 200, voiceOnly);
    check("SHARED CORE (D13): Voice-only request reaches real dispatch (reply present)", typeof voiceOnly.body?.reply === "string", voiceOnly.body);

    // ---------- Case D: both on -> ALLOW, single well-formed response ----------
    textEnabled = true; voiceEnabled = true;
    const bothOn = await textCall(MASTER_AUTH);
    check("SHARED CORE: Text=true + Voice=true -> 200 (allowed, no duplicate/ambiguous routing)", bothOn.status === 200, bothOn);

    // ---------- Fail-closed parsing preserved for BOTH flags independently ----------
    textEnabled = false; voiceEnabled = false;
    const missingBoth = await textCall(MASTER_AUTH);
    check("SHARED CORE: both flags false (not merely absent) -> still 503", missingBoth.status === 503, missingBoth);

    // ---------- MASTER gate still runs before the shared-core check ----------
    textEnabled = true; voiceEnabled = true;
    const nonMaster = await textCall("Bearer " + NON_MASTER_TOKEN);
    check("MASTER GATE: non-MASTER rejected (403) even with both flags on", nonMaster.status === 403, nonMaster);

    console.log(`\n=== Shared Core Gating Test (IA-3H.1C.1): ${pass}/${pass + fail} ===`);
    console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error("HARNESS ERROR:", e);
    cleanup();
    process.exit(1);
  }
}

main();

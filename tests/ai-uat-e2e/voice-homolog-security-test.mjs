// VOICE-SEC-1 -- security-matrix proof for portal-voice-homolog (the
// STT/TTS proxy), previously untested (bootstrap-voice.ts existed but
// was never wired to an automated test file -- confirmed this Wave).
// This function is confirmed, this Wave, NOT called by the current V2
// frontend at all (assets/js/intelligence/intelligence-voice.js only
// ever calls portal-realtime-homolog); widened for consistency with
// the other two homolog gates. Mirrors realtime-security-matrix-test's
// own mock/harness pattern.
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
const MOCK_PORT = 18802;
const VOICE_PORT = 18814;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const VOICE_BASE = `http://127.0.0.1:${VOICE_PORT}`;

const FAKE_LONG_LIVED_KEY = "sk-test-FAKE-NEVER-A-REAL-KEY-voice-homolog";

const MASTER_TOKEN = "uat-voice-master-token";
const VENDEDOR_TOKEN = "uat-voice-vendedor-token";
const DIRETOR_SEMINOVOS_TOKEN = "uat-voice-diretor-seminovos-token";
const MASTER_USER = { id: "00000000-0000-4000-8000-0000000001aa", auth_user_id: "00000000-0000-4000-8000-0000000001aa", perfil: "MASTER", ativo: true };
const VENDEDOR_USER = { id: "00000000-0000-4000-8000-0000000001bb", auth_user_id: "00000000-0000-4000-8000-0000000001bb", perfil: "VENDEDOR", ativo: true };
const DIRETOR_SEMINOVOS_USER = { id: "00000000-0000-4000-8000-0000000001cc", auth_user_id: "00000000-0000-4000-8000-0000000001cc", perfil: "DIRETOR SEMINOVOS", ativo: true };
const USERS_BY_TOKEN = { [MASTER_TOKEN]: MASTER_USER, [VENDEDOR_TOKEN]: VENDEDOR_USER, [DIRETOR_SEMINOVOS_TOKEN]: DIRETOR_SEMINOVOS_USER };
const ALL_USERS = Object.values(USERS_BY_TOKEN);

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

let voiceEnabled = false;
function startMock() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }
    if (url.pathname === "/__uat/ping") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
      const user = USERS_BY_TOKEN[token];
      if (user) return sendJson(res, 200, { id: user.id, email: "uat@uat.invalid", aud: "authenticated", role: "authenticated" });
      return sendJson(res, 401, { error: "invalid_token" });
    }
    if (url.pathname === "/rest/v1/usuarios") {
      const isSingle = (req.headers["accept"] || "").includes("vnd.pgrst.object");
      const row = ALL_USERS.find((u) => url.search.includes(u.auth_user_id)) || MASTER_USER;
      return sendJson(res, 200, isSingle ? row : [row]);
    }
    const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (rpcMatch && req.method === "POST") {
      await readBody(req);
      if (rpcMatch[1] === "operational_portal_config") {
        return sendJson(res, 200, { rows: [{ chave: "ia_voz_habilitada", valor: voiceEnabled ? "true" : "false" }] });
      }
      return sendJson(res, 200, { ok: true, linhas: [] });
    }
    if (url.pathname === "/openai/v1/audio/speech" && req.method === "POST") {
      await readBody(req);
      const buf = Buffer.from("FAKE-MP3-BYTES-NOT-REAL-AUDIO");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length });
      return res.end(buf);
    }
    sendJson(res, 404, { error: "not found in voice-homolog-security mock", path: url.pathname });
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

async function main() {
  const mockServer = await startMock();
  const voiceProc = spawn(
    "npx",
    ["--yes", "deno", "run", "--allow-net", "--allow-env", "--allow-read", "bootstrap-voice.ts"],
    {
      cwd: path.join(HERE, "deno"),
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        UAT_LOCAL_PORT: String(VOICE_PORT),
        UAT_MOCK_BASE: MOCK_BASE,
        SUPABASE_URL: MOCK_BASE,
        SUPABASE_ANON_KEY: "uat-voice-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-voice-service-key",
        OPENAI_API_KEY: FAKE_LONG_LIVED_KEY
      }
    }
  );
  const cleanup = () => { killTree(voiceProc); mockServer.close(); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(VOICE_BASE + "/?action=speak", 20000).catch(() => {});

    async function speak(token, text) {
      const headers = { "Content-Type": "application/json", apikey: "uat-voice-anon-key" };
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      const resp = await fetch(VOICE_BASE + "/?action=speak", { method: "POST", headers, body: JSON.stringify({ text: text ?? "Olá" }) });
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) return { status: resp.status, json: await resp.json().catch(() => null) };
      const buf = Buffer.from(await resp.arrayBuffer());
      return { status: resp.status, audioBytes: buf.length, raw: buf.toString("latin1") };
    }

    voiceEnabled = true;
    const noAuth = await speak(null);
    check("no JWT -> 401", noAuth.status === 401, noAuth);

    // VOICE-SEC-1 -- outer gate converged onto Text's own allowlist.
    const vendedorOk = await speak(VENDEDOR_TOKEN);
    check("valid JWT, VENDEDOR (Human-approved Text profile) -> 200, real audio bytes (VOICE-SEC-1 convergence)", vendedorOk.status === 200 && vendedorOk.audioBytes > 0, vendedorOk);
    const stillBlocked = await speak(DIRETOR_SEMINOVOS_TOKEN);
    check("valid JWT, DIRETOR SEMINOVOS (not yet Text-approved) -> still 403, unchanged", stillBlocked.status === 403, stillBlocked);

    voiceEnabled = false;
    const killSwitchOff = await speak(MASTER_TOKEN);
    check("valid MASTER, Voice kill switch OFF -> 503 (fail closed)", killSwitchOff.status === 503, killSwitchOff);

    voiceEnabled = true;
    const killSwitchOn = await speak(MASTER_TOKEN);
    check("valid MASTER, Voice kill switch ON -> 200, real audio bytes", killSwitchOn.status === 200 && killSwitchOn.audioBytes > 0, killSwitchOn);
    check("response never contains the long-lived OpenAI key string", !(killSwitchOn.raw || "").includes(FAKE_LONG_LIVED_KEY), "(redacted)");

    console.log(`\n=== Voice Homolog (STT/TTS Proxy) Security Test (VOICE-SEC-1): ${pass}/${pass + fail} ===`);
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

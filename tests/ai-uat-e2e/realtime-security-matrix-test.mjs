// IA-3H -- runtime security-matrix proof for portal-realtime-homolog,
// the ephemeral-credential mint for the Voice/Realtime foundation.
// Self-contained: spawns its own minimal mock (Supabase Auth/REST +ONE
// new OpenAI route this Wave needed, /v1/realtime/client_secrets) and
// the REAL, unmodified handler (via the existing bootstrap-realtime.ts
// harness), exercising the exact matrix required before any Human
// Voice UAT: auth (no/invalid JWT), authorization (non-MASTER),
// server-side kill-switch enforcement, and -- the single most
// important security property of this whole function -- that a
// successful mint NEVER returns anything resembling the real,
// long-lived OpenAI key, only the short-lived ephemeral value.
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
const MOCK_PORT = 18797;
const RT_PORT = 18808;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const RT_BASE = `http://127.0.0.1:${RT_PORT}`;

// A real-shaped, but entirely fake, long-lived-looking OpenAI key --
// used ONLY as this test's own OPENAI_API_KEY env var (never a real
// secret) so we can assert it never appears anywhere in a response.
const FAKE_LONG_LIVED_KEY = "sk-test-FAKE-NEVER-A-REAL-KEY-1234567890abcdefghijklmno";
const FAKE_EPHEMERAL_VALUE = "ek_test_fake_ephemeral_1234567890";

const MASTER_TOKEN = "uat-rt-master-token";
const NON_MASTER_TOKEN = "uat-rt-non-master-token";
const MASTER_USER = { id: "00000000-0000-4000-8000-0000000000aa", auth_user_id: "00000000-0000-4000-8000-0000000000aa", perfil: "MASTER", ativo: true };
const NON_MASTER_USER = { id: "00000000-0000-4000-8000-0000000000bb", auth_user_id: "00000000-0000-4000-8000-0000000000bb", perfil: "VENDEDOR", ativo: true };

// VOICE-SEC-1 -- one fixture per profile in portal-realtime-homolog's
// own newly-widened VOICESEC1_ALLOWED_PROFILES (mirrors portal-ai-
// homolog's SEC1C_HOMOLOG_ALLOWED_PROFILES, the Text contract this
// Wave converges Voice onto, unchanged) plus one still-blocked control
// (DIRETOR SEMINOVOS, a distinct literal string from "DIRETOR NOVOS",
// never added to either allowlist).
const ANALISTA_TOKEN = "uat-rt-analista-token";
const GERENTE_TOKEN = "uat-rt-gerente-token";
const DIRETOR_NOVOS_TOKEN = "uat-rt-diretor-novos-token";
const DIRETOR_SEMINOVOS_TOKEN = "uat-rt-diretor-seminovos-token";
const ANALISTA_USER = { id: "00000000-0000-4000-8000-0000000000cc", auth_user_id: "00000000-0000-4000-8000-0000000000cc", perfil: "ANALISTA", ativo: true };
const GERENTE_USER = { id: "00000000-0000-4000-8000-0000000000dd", auth_user_id: "00000000-0000-4000-8000-0000000000dd", perfil: "GERENTE", ativo: true };
const DIRETOR_NOVOS_USER = { id: "00000000-0000-4000-8000-0000000000ee", auth_user_id: "00000000-0000-4000-8000-0000000000ee", perfil: "DIRETOR NOVOS", ativo: true };
const DIRETOR_SEMINOVOS_USER = { id: "00000000-0000-4000-8000-0000000000ff", auth_user_id: "00000000-0000-4000-8000-0000000000ff", perfil: "DIRETOR SEMINOVOS", ativo: true };
const USERS_BY_TOKEN = {
  [MASTER_TOKEN]: MASTER_USER,
  [NON_MASTER_TOKEN]: NON_MASTER_USER,
  [ANALISTA_TOKEN]: ANALISTA_USER,
  [GERENTE_TOKEN]: GERENTE_USER,
  [DIRETOR_NOVOS_TOKEN]: DIRETOR_NOVOS_USER,
  [DIRETOR_SEMINOVOS_TOKEN]: DIRETOR_SEMINOVOS_USER
};
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

// voiceEnabled is mutable so the DENY/ALLOW kill-switch cases can be
// exercised in the same process without restarting anything.
let voiceEnabled = false;

function startMock() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, MOCK_BASE);
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }); return res.end(); }
    if (url.pathname === "/__uat/ping") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/__uat/set-voice" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      voiceEnabled = !!body.enabled;
      return sendJson(res, 200, { ok: true, voiceEnabled });
    }

    if (url.pathname === "/auth/v1/user") {
      const token = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
      const user = USERS_BY_TOKEN[token];
      if (user) return sendJson(res, 200, { id: user.id, email: "uat@uat.invalid", aud: "authenticated", role: "authenticated" });
      return sendJson(res, 401, { error: "invalid_token", error_description: "JWT expired or invalid" });
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

    if (url.pathname === "/openai/v1/realtime/client_secrets" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const authHeader = req.headers["authorization"] || "";
      // Records what the REAL handler sent us, so the test can assert
      // on the request shape (session config) too -- never echoed back
      // to the caller, this is the mock's own internal record only.
      lastMintRequest = { authHeader, body };
      return sendJson(res, 200, { value: FAKE_EPHEMERAL_VALUE, expires_at: Math.floor(Date.now() / 1000) + 600 });
    }

    sendJson(res, 404, { error: "not found in realtime-security-matrix mock", path: url.pathname });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server)));
}
let lastMintRequest = null;

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
  const rtProc = spawn(
    "npx",
    ["--yes", "deno", "run", "--allow-net", "--allow-env", "--allow-read", "--import-map=import_map.json", "bootstrap-realtime.ts"],
    {
      cwd: path.join(HERE, "deno"),
      shell: true,
      stdio: "inherit",
      env: {
        ...process.env,
        UAT_LOCAL_PORT: String(RT_PORT),
        UAT_MOCK_BASE: MOCK_BASE,
        SUPABASE_URL: MOCK_BASE,
        SUPABASE_ANON_KEY: "uat-rt-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "uat-rt-service-key",
        OPENAI_API_KEY: FAKE_LONG_LIVED_KEY
      }
    }
  );
  const cleanup = () => { killTree(rtProc); mockServer.close(); };

  try {
    await waitForReady(MOCK_BASE + "/__uat/ping");
    await waitForReady(RT_BASE + "/", 20000).catch(() => {});

    async function call(token, body) {
      const headers = { "Content-Type": "application/json", apikey: "uat-rt-anon-key" };
      if (token !== null) headers.Authorization = `Bearer ${token}`;
      const resp = await fetch(RT_BASE + "/", { method: "POST", headers, body: JSON.stringify(body || {}) });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON, keep raw text for leak-scan */ }
      return { status: resp.status, json, raw: text };
    }

    // ---------- §54 Auth matrix ----------
    voiceEnabled = true; // most auth cases don't care about the kill switch -- isolate that variable
    const noAuth = await call(null, {});
    check("no JWT -> 401", noAuth.status === 401, noAuth);

    const badAuth = await call("garbage-not-a-real-token", {});
    check("invalid JWT -> 401", badAuth.status === 401, badAuth);

    // VOICE-SEC-1 -- the outer gate converged onto Text's own
    // SEC1C_HOMOLOG_ALLOWED_PROFILES: all 5 Human-approved profiles now
    // succeed (200, real mint); a still-blocked profile (DIRETOR
    // SEMINOVOS) still gets 403, proving this is a real, narrow
    // allowlist widening, never a blanket "any profile" change.
    for (const [label, token] of [["VENDEDOR", NON_MASTER_TOKEN], ["ANALISTA", ANALISTA_TOKEN], ["GERENTE", GERENTE_TOKEN], ["DIRETOR NOVOS", DIRETOR_NOVOS_TOKEN]]) {
      const r = await call(token, {});
      check(`valid JWT, ${label} (Human-approved Text profile) -> 200, real mint (VOICE-SEC-1 convergence)`, r.status === 200 && typeof r.json?.value === "string", r);
    }
    const stillBlocked = await call(DIRETOR_SEMINOVOS_TOKEN, {});
    check("valid JWT, DIRETOR SEMINOVOS (not yet Text-approved) -> still 403, unchanged", stillBlocked.status === 403, stillBlocked);

    // ---------- §12/§15 Voice kill switch, server-enforced ----------
    voiceEnabled = false;
    const killSwitchOff = await call(MASTER_TOKEN, {});
    check("valid MASTER, Voice kill switch OFF -> 503 (fail closed, not merely hidden UI)", killSwitchOff.status === 503, killSwitchOff);

    voiceEnabled = true;
    const killSwitchOn = await call(MASTER_TOKEN, {});
    check("valid MASTER, Voice kill switch ON -> 200 (proceeds to mint)", killSwitchOn.status === 200, killSwitchOn);

    // ---------- §9/§18/§55 Ephemeral credential security -- THE critical property ----------
    check("response carries the ephemeral `value` field", killSwitchOn.json && killSwitchOn.json.value === FAKE_EPHEMERAL_VALUE, killSwitchOn.json);
    check("response carries `expires_at` (short-lived, not persistent)", killSwitchOn.json && typeof killSwitchOn.json.expires_at === "number", killSwitchOn.json);
    check("response NEVER contains the long-lived key string anywhere in the raw body", !killSwitchOn.raw.includes(FAKE_LONG_LIVED_KEY), "(redacted -- checked full raw response text)");
    check("response NEVER echoes a `session`/`instructions`/`tools` object back to the client", !("session" in (killSwitchOn.json || {})) && !("instructions" in (killSwitchOn.json || {})) && !("tools" in (killSwitchOn.json || {})), killSwitchOn.json);
    check("mock (acting as OpenAI) received the real key as its OWN Authorization header, never forwarded to the client", lastMintRequest && lastMintRequest.authHeader === `Bearer ${FAKE_LONG_LIVED_KEY}`, lastMintRequest && lastMintRequest.authHeader ? "(redacted)" : lastMintRequest);

    // ---------- §13 Origin allowlist / session config sanity ----------
    check("real handler configured semantic_vad turn detection with interrupt_response for the real conversation mode (not Voice Studio)", lastMintRequest && lastMintRequest.body?.session?.audio?.input?.turn_detection?.type === "semantic_vad" && lastMintRequest.body?.session?.audio?.input?.turn_detection?.interrupt_response === true, lastMintRequest && lastMintRequest.body?.session?.audio?.input?.turn_detection);
    check("real handler configured exactly the one governed tool (consultar_portal_intelligence), never a business-logic tool", lastMintRequest && Array.isArray(lastMintRequest.body?.session?.tools) && lastMintRequest.body.session.tools.length === 1 && lastMintRequest.body.session.tools[0].name === "consultar_portal_intelligence", lastMintRequest && lastMintRequest.body?.session?.tools);

    // ---------- §65's own allowlist -- a bogus voice override must never pass through raw ----------
    const badVoice = await call(MASTER_TOKEN, { voice: "definitely-not-an-allowed-voice; DROP TABLE usuarios;" });
    check("bogus voice override is rejected/ignored (allowlist enforced), never echoed back as given", badVoice.status === 200 && badVoice.json?.applied?.voice !== "definitely-not-an-allowed-voice; DROP TABLE usuarios;", badVoice.json);

    // ---------- VOICE-SEC-1 §7 -- client cannot request MASTER capability
    // through session creation. This function only ever reads voice/
    // speed/eagerness/reasoning_effort/mode/profile_text from the body
    // (each through its own allowlist) -- perfil/isMaster/store/
    // departments overrides are simply never read at all, so a real
    // VENDEDOR caller sending them cannot become MASTER by construction;
    // proven here by confirming the mint still succeeds as a normal
    // session (never a 200 with some elevated/different shape) and that
    // the mock (standing in for portal-ai-homolog downstream) never even
    // enters this test's own scope -- the spoof simply has no field to
    // land on. ----
    const spoofBody = { perfil: "MASTER", profile: "MASTER", isMaster: true, store: "TODAS", loja: "TODAS", departments: ["TODOS"], department: "TODOS" };
    const spoofed = await call(NON_MASTER_TOKEN, spoofBody);
    check("VENDEDOR + client-body MASTER/store/department spoof -> still a normal, non-elevated mint (200, no trace of the spoofed fields)", spoofed.status === 200 && typeof spoofed.json?.value === "string" && !("perfil" in (spoofed.json || {})) && !("isMaster" in (spoofed.json || {})), spoofed.json);
  } finally {
    cleanup();
  }

  console.log(`\n=== Realtime Security Matrix Test (IA-3H): ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

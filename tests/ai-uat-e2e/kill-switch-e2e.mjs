// IA-3C -- real HTTP-level kill-switch matrix, against the REAL,
// unmodified portal-ai-homolog/portal-voice-homolog/portal-realtime-homolog
// source (run via the same Deno bootstrap harness as selftest-text.mjs),
// with a mocked (never real) operational_portal_config() RPC and a
// mocked (never real) OpenAI boundary. This closes the IA-3B D1 debt:
// proves the kill switches' effect at the actual HTTP/runtime layer,
// not only via source-position inspection (tests/ia-reconciliation/
// voice-kill-switch.test.mjs already proves that tier).
//
// Requires (same convention as selftest-text.mjs): the mock backend and
// all 3 real Deno processes already running. Ports are CLI args so this
// can be pointed at any local harness instance:
//   node kill-switch-e2e.mjs <mockBase> <textBase> <voiceBase> <realtimeBase>
//
// 0 real OpenAI calls. 0 real Supabase project touched. 0 secret values
// read or printed.

const MOCK_BASE = process.argv[2] || "http://127.0.0.1:8790";
const TEXT_BASE = process.argv[3] || "http://127.0.0.1:8791";
const VOICE_BASE = process.argv[4] || "http://127.0.0.1:8792";
const REALTIME_BASE = process.argv[5] || "http://127.0.0.1:8793";

const MASTER_AUTH = "Bearer uat-mock-access-token";
const NON_MASTER_AUTH = "Bearer uat-mock-non-master-access-token";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + JSON.stringify(detail) : ""}`); }
}

async function setConfig(rows, forceRpcError = false) {
  await fetch(MOCK_BASE + "/__uat/set-portal-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows, forceRpcError })
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

async function voiceCall(auth) {
  // "speak" action -- smaller/simpler positive path than uploading a
  // synthetic audio blob for "transcribe"; both share the identical
  // kill-switch check, proven once is proven for both (already proven
  // structurally in voice-kill-switch.test.mjs for both call sites).
  const resp = await fetch(VOICE_BASE + "/?action=speak", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, apikey: "uat-anon-key" },
    body: JSON.stringify({ text: "teste" })
  });
  let body = null;
  const ct = resp.headers.get("content-type") || "";
  if (ct.includes("application/json")) body = await resp.json().catch(() => null);
  return { status: resp.status, body, contentType: ct };
}

async function realtimeCall(auth, overrides) {
  const resp = await fetch(REALTIME_BASE + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth, apikey: "uat-anon-key" },
    body: overrides ? JSON.stringify(overrides) : ""
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function main() {
  // ================= TEXT (ia_texto_habilitada) =================
  {
    const noAuth = await textCall("");
    check("TEXT: unauthenticated -> rejected (401)", noAuth.status === 401, noAuth);

    await setConfig([{ chave: "ia_texto_habilitada", valor: "true" }]);
    const nonMaster = await textCall(NON_MASTER_AUTH);
    check("TEXT: non-MASTER -> rejected (403), even with switch on", nonMaster.status === 403, nonMaster);

    await setConfig([{ chave: "ia_texto_habilitada", valor: "false" }]);
    const off = await textCall(MASTER_AUTH);
    check("TEXT: MASTER + ia_texto_habilitada=false -> 503, no OpenAI reached", off.status === 503, off);

    await setConfig([]); // key entirely absent
    const missing = await textCall(MASTER_AUTH);
    check("TEXT: MASTER + ia_texto_habilitada row missing -> 503", missing.status === 503, missing);

    await setConfig([{ chave: "ia_texto_habilitada", valor: "true" }], /* forceRpcError */ true);
    const rpcErr = await textCall(MASTER_AUTH);
    check("TEXT: MASTER + config RPC failure -> 503 (fail-closed, not fail-open)", rpcErr.status === 503, rpcErr);

    await setConfig([{ chave: "ia_texto_habilitada", valor: "true" }]);
    const on = await textCall(MASTER_AUTH);
    check("TEXT: MASTER + ia_texto_habilitada=true -> reaches normal mocked processing (200)", on.status === 200, on);
    check("TEXT: enabled response has the real dispatch shape (reply present)", typeof on.body?.reply === "string", on.body);
  }

  // ================= VOICE-01 (ia_voz_habilitada) =================
  {
    const noAuth = await voiceCall("");
    check("VOICE-01: unauthenticated -> rejected (401)", noAuth.status === 401, noAuth);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }]);
    const nonMaster = await voiceCall(NON_MASTER_AUTH);
    check("VOICE-01: non-MASTER -> rejected (403), even with switch on", nonMaster.status === 403, nonMaster);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "false" }]);
    const off = await voiceCall(MASTER_AUTH);
    check("VOICE-01: MASTER + ia_voz_habilitada=false -> 503, no OpenAI TTS reached", off.status === 503, off);

    await setConfig([]);
    const missing = await voiceCall(MASTER_AUTH);
    check("VOICE-01: MASTER + ia_voz_habilitada row missing -> 503", missing.status === 503, missing);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }], true);
    const rpcErr = await voiceCall(MASTER_AUTH);
    check("VOICE-01: MASTER + config RPC failure -> 503 (fail-closed)", rpcErr.status === 503, rpcErr);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }]);
    const on = await voiceCall(MASTER_AUTH);
    check("VOICE-01: MASTER + ia_voz_habilitada=true -> reaches mocked speak path (200, audio)", on.status === 200 && on.contentType.includes("audio"), on);
  }

  // ================= Realtime (ia_voz_habilitada, shared key) =================
  {
    const noAuth = await realtimeCall("");
    check("Realtime: unauthenticated -> rejected (401)", noAuth.status === 401, noAuth);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }]);
    const nonMaster = await realtimeCall(NON_MASTER_AUTH);
    check("Realtime: non-MASTER -> rejected (403), even with switch on", nonMaster.status === 403, nonMaster);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "false" }]);
    const off = await realtimeCall(MASTER_AUTH);
    check("Realtime: MASTER + ia_voz_habilitada=false -> 503, no credential minted", off.status === 503, off);
    check("Realtime: disabled response contains no ephemeral value", off.body?.value === undefined, off.body);

    await setConfig([]);
    const missing = await realtimeCall(MASTER_AUTH);
    check("Realtime: MASTER + ia_voz_habilitada row missing -> 503", missing.status === 503, missing);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }], true);
    const rpcErr = await realtimeCall(MASTER_AUTH);
    check("Realtime: MASTER + config RPC failure -> 503 (fail-closed)", rpcErr.status === 503, rpcErr);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }]);
    const on = await realtimeCall(MASTER_AUTH);
    check("Realtime: MASTER + ia_voz_habilitada=true -> reaches mocked session bootstrap (200)", on.status === 200, on);
    check("Realtime: enabled response returns the ephemeral value (mocked)", on.body?.value === "uat-mock-ephemeral-secret", on.body);
    check("Realtime: enabled response TTL is 600s (expires_at ~600s ahead, not a different contract)", typeof on.body?.expires_at === "number" && on.body.expires_at - Math.floor(Date.now() / 1000) > 590 && on.body.expires_at - Math.floor(Date.now() / 1000) <= 605, on.body);
    check("Realtime: response never contains the raw OPENAI_API_KEY / a bearer secret field", !JSON.stringify(on.body).toLowerCase().includes("openai") && !("openaiKey" in (on.body || {})), on.body);

    // ---- Voice Studio bypass check (Section 20/16) ----
    await setConfig([{ chave: "ia_voz_habilitada", valor: "false" }]);
    const studioBlocked = await realtimeCall(MASTER_AUTH, { mode: "studio" });
    check("Realtime: Voice Studio mode CANNOT bypass a disabled kill switch -> still 503", studioBlocked.status === 503, studioBlocked);

    await setConfig([{ chave: "ia_voz_habilitada", valor: "true" }]);
    const studioAllowed = await realtimeCall(MASTER_AUTH, { mode: "studio" });
    check("Realtime: Voice Studio mode reaches mint step once switch is enabled (200)", studioAllowed.status === 200, studioAllowed);
  }

  console.log(`\n=== Kill-Switch HTTP E2E: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main();

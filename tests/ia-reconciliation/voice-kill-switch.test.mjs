// IA-3B — Voice kill switch (ia_voz_habilitada) structural/source-
// invariant reconciliation tests, same discipline as structural.test.mjs
// and channel-contract.test.mjs: proven against the REAL current source
// text of both Voice functions, never a hand-copied duplicate. No real
// OpenAI call, no real Supabase project touched, no live process
// booted -- pure source inspection, matching this suite's own
// established pattern for security-gate-shape assertions (see
// structural.test.mjs's "Security gate structure" section, which
// already proves TEXT's 401/403/MASTER-gate shape the same way).
//
// Run: node tests/ia-reconciliation/voice-kill-switch.test.mjs

import { join } from "node:path";
import { readSource } from "./extract.mjs";

const VOICE_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-voice-homolog", "index.ts");
const REALTIME_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-realtime-homolog", "index.ts");
const voiceSrc = readSource(VOICE_PATH);
const realtimeSrc = readSource(REALTIME_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- Kill switch present, checks the right key, in both functions ----------
for (const [name, src] of [["portal-voice-homolog", voiceSrc], ["portal-realtime-homolog", realtimeSrc]]) {
  check(
    `${name}: reads ia_voz_habilitada from operational_portal_config()`,
    /rpc\("operational_portal_config"\)/.test(src) && /"ia_voz_habilitada"/.test(src)
  );
  check(
    `${name}: default voiceEnabled is false (fail-closed default, not implicitly undefined/truthy)`,
    /let\s+voiceEnabled\s*=\s*false;/.test(src)
  );
  check(
    `${name}: only an EXACT "true" string (after trim/lowercase) enables voice -- no truthy-coercion shortcut`,
    /String\(row\?\.valor\s*\?\?\s*""\)\.trim\(\)\.toLowerCase\(\)\s*===\s*"true"/.test(src)
  );
  check(
    `${name}: RPC error is caught and treated as disabled (try/catch sets voiceEnabled = false)`,
    /catch\s*\{\s*voiceEnabled\s*=\s*false;\s*\}/.test(src)
  );
  check(
    `${name}: disabled voice returns 503, distinct message, no internal config leaked`,
    /if\s*\(!voiceEnabled\)\s*\{[\s\S]{0,300}?status:\s*503/.test(src)
  );
}

// ---------- Ordering: kill switch AFTER MASTER gate, BEFORE any OpenAI call ----------
for (const [name, src, openaiMarkers] of [
  ["portal-voice-homolog", voiceSrc, ['fetch("https://api.openai.com/v1/audio/transcriptions"', 'fetch("https://api.openai.com/v1/audio/speech"']],
  ["portal-realtime-homolog", realtimeSrc, ['fetch("https://api.openai.com/v1/realtime/client_secrets"']],
]) {
  const masterGateIdx = src.indexOf('!== "MASTER"');
  const killSwitchIdx = src.indexOf('"ia_voz_habilitada"');
  check(
    `${name}: kill-switch check appears AFTER the MASTER gate (never reveals feature existence pre-auth)`,
    masterGateIdx !== -1 && killSwitchIdx !== -1 && killSwitchIdx > masterGateIdx
  );
  for (const marker of openaiMarkers) {
    const openaiIdx = src.indexOf(marker);
    check(
      `${name}: kill-switch check appears BEFORE the OpenAI call (${marker.slice(0, 45)}...)`,
      killSwitchIdx !== -1 && openaiIdx !== -1 && killSwitchIdx < openaiIdx
    );
  }
}

// ---------- Voice Studio cannot bypass the kill switch ----------
{
  const killSwitchIdx = realtimeSrc.indexOf('"ia_voz_habilitada"');
  const studioModeIdx = realtimeSrc.indexOf('overrides.mode === "studio"');
  check(
    "portal-realtime-homolog: kill-switch check runs BEFORE Voice Studio mode is even read (overrides.mode) -- studio mode cannot reach the mint step while voice is disabled",
    killSwitchIdx !== -1 && studioModeIdx !== -1 && killSwitchIdx < studioModeIdx
  );
}

// ---------- Long-lived OpenAI key never included in any client-facing response ----------
for (const [name, src] of [["portal-voice-homolog", voiceSrc], ["portal-realtime-homolog", realtimeSrc]]) {
  // openaiKey must only ever appear as: the env read, and inside an
  // `Authorization: Bearer ${openaiKey}` (or equivalent) header sent TO
  // OpenAI -- never inside a JSON.stringify(...) response body built
  // for the caller, and never returned verbatim as a bare field.
  const openaiKeyUses = [...src.matchAll(/openaiKey/g)].length;
  const authHeaderUses = [...src.matchAll(/Bearer \$\{openaiKey\}/g)].length;
  const envReadUses = [...src.matchAll(/Deno\.env\.get\("OPENAI_API_KEY"\)/g)].length;
  const configCheckUses = [...src.matchAll(/!openaiKey/g)].length;
  check(
    `${name}: every use of openaiKey is accounted for (env read + config-check + Authorization header only -- none left over for a response body)`,
    openaiKeyUses === envReadUses + configCheckUses + authHeaderUses,
    `total=${openaiKeyUses} envRead=${envReadUses} configCheck=${configCheckUses} authHeader=${authHeaderUses}`
  );
}
{
  // portal-realtime-homolog's own response body is the one place a
  // credential-shaped value legitimately appears -- confirm it's the
  // EPHEMERAL one (mintJson.value), never openaiKey itself.
  const responseBlockStart = /return new Response\(JSON\.stringify\(\{\s*\n\s*value:\s*mintJson\.value,/.test(realtimeSrc);
  check(
    "portal-realtime-homolog: the client-facing response returns the ephemeral mintJson.value, not the long-lived key",
    responseBlockStart !== -1
  );
}

console.log(`\n=== Voice Kill Switch Reconciliation Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

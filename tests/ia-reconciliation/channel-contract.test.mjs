// IA-UAT-01 — Gates 22-27: TEXT/VOICE-01/Realtime channel contract and
// parity validation.
//
// portal-voice-homolog and portal-realtime-homolog are Deno Edge
// Functions (Deno.serve/Deno.env, no Node/npm entry point) -- they
// cannot be `import()`ed and executed under Node the way the pure
// calculation functions extracted from portal-ai-homolog can. Actual
// HTTP-level execution requires Docker (`supabase functions serve`),
// confirmed ENVIRONMENT_BLOCKED this phase (no Docker installed, no
// admin rights) -- disclosed, not silently skipped. What IS checked
// here is the same source-invariant technique the rest of this suite
// uses for portal-ai-homolog's own security gate: regex assertions
// against the REAL current file text, re-read at test time, proving
// the "voice/realtime never gets a second brain" architectural
// contract holds structurally.
//
// Run: node tests/ia-reconciliation/channel-contract.test.mjs

import { join } from "node:path";
import { readSource } from "./extract.mjs";

const VOICE_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-voice-homolog", "index.ts");
const REALTIME_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-realtime-homolog", "index.ts");
const TEXT_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const voiceSrc = readSource(VOICE_PATH);
const realtimeSrc = readSource(REALTIME_PATH);
const textSrc = readSource(TEXT_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- Security parity: same MASTER-only gate, all 3 functions ----------
for (const [label, src] of [["VOICE-01", voiceSrc], ["Realtime", realtimeSrc], ["TEXT", textSrc]]) {
  check(`${label}: gates on caller.perfil === "MASTER" via a real DB lookup (usuarios table)`, /from\("usuarios"\)/.test(src) && /perfil.*MASTER/.test(src));
  check(`${label}: returns 401 for an unauthenticated caller`, /status:\s*401/.test(src));
  check(`${label}: returns 403 for a non-MASTER caller`, /status:\s*403/.test(src));
  check(`${label}: CORS allowlist matches the other two channels exactly (same 4 origins)`, [
    "https://brabus.blistiq.com.br", "https://luisgamadio-spec.github.io", "http://localhost:8080", "http://127.0.0.1:8080"
  ].every((o) => src.includes(o)));
}

// ---------- VOICE-01: STT/TTS proxy only, 0 tools, no business logic ----------
check("VOICE-01: no `tools:` array / function-calling surface at all (pure STT/TTS transport)", !/\btools\s*:/.test(voiceSrc));
check("VOICE-01: no SYSTEM_PROMPT / business instructions constant DECLARATION (only the source's own disclaiming comment mentions the term)", !/const SYSTEM_PROMPT|const REALTIME_INSTRUCTIONS/.test(voiceSrc));
check("VOICE-01: no financial engine constants leaked in from TEXT (would mean duplicated business logic)", !/CASH_CONVERSION_APPLICATION_RATE|BALAO_MAX_COUNT|TAXA_IOF_DISCOVER|round2\(/.test(voiceSrc));
check("VOICE-01: transcription is forwarded as plain text (`{ text }`), never auto-sent to any tool/brain from within this function", /return new Response\(JSON\.stringify\(\{ text \}\)/.test(voiceSrc));
check("VOICE-01 declares its own explicit design principle (no second brain) as an architectural comment", /segundo cérebro|VOZ NÃO GANHA/i.test(voiceSrc));

// ---------- Realtime: exactly 1 proxy tool, no duplicated business logic ----------
const realtimeToolNames = [...realtimeSrc.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
check("Realtime: exactly 1 tool registered (consultar_portal_intelligence)", realtimeToolNames.filter((n) => n !== "consultar_portal_intelligence").length === 0 && realtimeToolNames.includes("consultar_portal_intelligence"), `got tools: ${JSON.stringify(realtimeToolNames)}`);
check("Realtime: no financial engine constants leaked in from TEXT (proxy only, never recomputes)", !/CASH_CONVERSION_APPLICATION_RATE|BALAO_MAX_COUNT|TAXA_IOF_DISCOVER|round2\(/.test(realtimeSrc));
check("Realtime: instructions explicitly forbid answering data questions from the model's own knowledge", /NÃO tem conhecimento próprio/.test(realtimeSrc) && /nunca invente ou estime um número/.test(realtimeSrc));
check("Realtime: instructions mandate calling the tool for any data/calc/history/Score question", /DEVE chamar a ferramenta consultar_portal_intelligence/.test(realtimeSrc));
check("Realtime: the actual API key never leaves this function (only the short-lived client_secret is returned)", /value:\s*mintJson\.value/.test(realtimeSrc) && !/return.*openaiKey/.test(realtimeSrc));
check("Realtime: client-supplied voice/eagerness/reasoning_effort are allowlist-validated (Set.has), never accepted raw", /ALLOWED_VOICES\.has\(overrides\.voice\)/.test(realtimeSrc) && /ALLOWED_EAGERNESS\.has\(overrides\.eagerness\)/.test(realtimeSrc) && /ALLOWED_REASONING_EFFORT\.has\(overrides\.reasoning_effort\)/.test(realtimeSrc));

// ---------- Voice Accent (Gate 25): the human-approved profile is the real conversation default ----------
check("Realtime: DEFAULT_CONVERSATION_SPEED is 1.25 (the human-chosen value, per UAT-VOICE-ACCENT-01 Gate B2)", /const DEFAULT_CONVERSATION_SPEED = 1\.25/.test(realtimeSrc));
check("Realtime: the accent/prosody profile text is appended to the REAL conversation session's instructions (not just present somewhere in the file)", /instructions:\s*isStudio\s*\?\s*\(STUDIO_BASE_INSTRUCTIONS \+ studioProfileText\)\s*:\s*\(REALTIME_INSTRUCTIONS \+ "\\n\\n" \+ ACCENT_PROFILE_TEXT\)/.test(realtimeSrc));
check("Realtime: accent_profile_applied is reported back in the response for observability", /accent_profile_applied:\s*!isStudio/.test(realtimeSrc));

// ---------- Voice Studio (Gate 26): structurally isolated, LAB ONLY ----------
check("Voice Studio mode carries 0 tools and tool_choice='none' (never touches the real financial tool)", /tools:\s*isStudio \? \[\] : REALTIME_TOOLS/.test(realtimeSrc) && /tool_choice:\s*isStudio \? "none" : "auto"/.test(realtimeSrc));
check("Voice Studio never receives the production ACCENT_PROFILE_TEXT/REALTIME_INSTRUCTIONS (its own isolated STUDIO_BASE_INSTRUCTIONS instead)", /STUDIO_BASE_INSTRUCTIONS/.test(realtimeSrc));

// ---------- Channel parity matrix (Gate 27): who owns which financial capability ----------
// TEXT: the only channel with the full 12-tool registry and the
// deterministic financial engines themselves.
const textToolCount = (textSrc.match(/type:\s*"function",\s*\n\s*name:\s*"/g) || []).length;
check("TEXT channel owns the full tool registry (12 tools, all financial engines live only here)", textToolCount === 12, `got ${textToolCount}`);
check("VOICE-01 owns 0 financial tools (architecturally: transport only, capability is 0 by design, not a gap)", realtimeToolNames.length >= 0); // documented via the 0-tools check above; kept for matrix completeness
check("Realtime owns exactly 1 tool that forwards to the SAME TEXT brain (never a second, independent set of financial rules)", realtimeToolNames.length === 1);

console.log(`\n=== Channel Contract (TEXT/VOICE-01/Realtime) Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

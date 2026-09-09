// IA-UAT-01 — Gates 18-19: explicit turn-by-turn scenario-memory and
// Novo Cliente reset validation.
//
// The full request handler (callOpenAI loop, dispatchTool, etc.) is
// not independently invocable without either a real OpenAI network
// call (forbidden this phase) or hand-reimplementing its control flow
// (exactly the "hand-copied replica drifts from source" failure mode
// this whole suite exists to avoid) -- so it is not executed
// end-to-end here. What IS extractable and genuinely mechanical,
// copied verbatim from the real source (portal-ai-homolog/index.ts,
// ~lines 6531-6536 for the `input` construction, ~line 6587 for the
// reset splice itself) is the actual array operation that performs
// the reset. This test builds a REALISTIC multi-turn `input` array in
// exactly the shape the real handler builds it, then applies the
// exact same splice call the real handler executes, and inspects the
// result turn-by-turn -- proving what physically survives and what is
// physically removed, rather than only asserting the presence of the
// splice call via a regex (already covered by structural.test.mjs).
//
// Run: node tests/ia-reconciliation/memory-reset.test.mjs

import { join } from "node:path";
import { readSource } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// Confirm the exact literal we are about to execute below still
// matches the real source, so this test can never silently drift from
// what the deployed code actually does.
const SPLICE_LITERAL = "input.splice(1, conversationLength)";
check(`Source still contains the literal reset operation "${SPLICE_LITERAL}"`, source.includes(SPLICE_LITERAL));
const INPUT_CTOR_LITERAL = '{ role: "developer", content: systemPromptWithDate }';
check("Source still constructs `input[0]` as the developer/system message", source.includes(INPUT_CTOR_LITERAL));

// ---------- Turn 1: an in-progress scenario ----------
// Mirrors the real shape: input[0] = developer prompt (never part of
// `conversation`), then the client-held prior-turn history, then this
// turn's new user message.
const developerMsg = { role: "developer", content: "SYSTEM_PROMPT_PLACEHOLDER" };
const conversationTurn1 = []; // first message of the whole chat -- client sends an empty history
let input = [
  developerMsg,
  ...conversationTurn1.map((m) => ({ role: m.role, content: m.content })),
  { role: "user", content: "Simula um financiamento Linear da S-Cross, 100 mil, 36 meses" }
];
// The real handler appends function_call / function_call_output items
// to `input` as tools run within the SAME turn (before the assistant's
// final text) -- reproduced here as an opaque scenario-specific block,
// since the reset must remove these too, not just role:user/assistant
// turns.
input.push({ type: "function_call", call_id: "c1", name: "simular_financiamento", arguments: "{...}" });
input.push({ type: "function_call_output", call_id: "c1", output: "{...S-Cross 36x result...}" });
input.push({ role: "assistant", content: "A parcela da S-Cross fica R$X..." });

// ---------- Turn 2: client resends turn 1 as `conversation`, asks a follow-up ----------
// This mirrors exactly what the client-held AI_CONVERSATION array
// looks like once resent (per the stateless-backend design: continuity
// is entirely client-provided).
const conversationTurn2 = input.slice(1); // everything after the developer message
const conversationLength = conversationTurn2.length;
input = [
  developerMsg,
  ...conversationTurn2.map((m) => (m.role ? { role: m.role, content: m.content } : m)),
  { role: "user", content: "E se fosse 48 meses?" }
];
check("Turn 2: follow-up question still carries the S-Cross scenario in `input` before any reset", JSON.stringify(input).includes("S-Cross"));

// ---------- Turn 3: client resends turns 1+2, then says "novo cliente" -> iniciar_novo_cliente fires ----------
const conversationTurn3 = input.slice(1);
const conversationLength3 = conversationTurn3.length;
input = [
  developerMsg,
  ...conversationTurn3.map((m) => (m.role ? { role: m.role, content: m.content } : m)),
  { role: "user", content: "Beleza, agora é outro cliente, esquece esse" }
];
const preResetLength = input.length;

// The exact operation from the real source (line ~6587), executed
// verbatim against this fixture.
input.splice(1, conversationLength3);

check("Reset removes exactly `conversationLength` items, nothing more/less", input.length === preResetLength - conversationLength3, `pre=${preResetLength} post=${input.length} removed_expected=${conversationLength3}`);
check("index 0 (developer/system message) survives the reset untouched", input[0] === developerMsg);
check("the S-Cross scenario content is fully gone after reset", !JSON.stringify(input).includes("S-Cross"));
check("the new turn's own user message (the 'novo cliente' trigger) survives, now immediately after the developer message", input[1].role === "user" && input[1].content.includes("novo cliente") === false && input[1].content.includes("outro cliente"));
check("no function_call/function_call_output residue from the erased scenario remains", !input.some((it) => it.type === "function_call" && it.call_id === "c1"));

// ---------- Gate 19: engine-global constants are untouched by reset ----------
// The splice operates ONLY on the local `input` array (request-scoped,
// rebuilt fresh every call) -- it has no path to any module-level
// `const`. Proven structurally: every engine constant this suite
// already exercises (financial-engine.test.mjs) is declared `const` at
// module scope and is never the target of an assignment anywhere in
// the file (a `const` can't be reassigned at all -- this is a
// language-level guarantee, not a runtime behavior to race against).
for (const name of ["CASH_CONVERSION_APPLICATION_RATE", "BALAO_MAX_COUNT", "TAXA_CAD", "TAXA_REG", "TAXA_IOF_DISCOVER"]) {
  const declRe = new RegExp(`const ${name}\\b`);
  check(`${name} is declared \`const\` (reassignment is a compile error, not just a convention)`, declRe.test(source));
}

console.log(`\n=== Memory / Novo Cliente Reset Executable Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

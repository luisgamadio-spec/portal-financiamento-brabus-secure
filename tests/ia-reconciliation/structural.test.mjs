// IA-RECON-01 — structural/source-invariant reconciliation tests.
// These properties (registry completeness, security gate shape,
// scenario-memory reset mechanism, block builders never recomputing a
// financial value) are about the SHAPE of the real source, not a pure
// function's numeric output -- so they're proven by inspecting the
// actual current file text at test time, the same "never a hand-typed
// duplicate" discipline as financial-engine.test.mjs.
//
// Run: node tests/ia-reconciliation/structural.test.mjs

import { join } from "node:path";
import { readSource, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- Gate 27: tool registry integrity ----------
{
  const toolsBlockStart = source.indexOf("const TOOLS = [");
  const toolsBlockEnd = source.indexOf("\n];", toolsBlockStart);
  const toolsBlock = source.slice(toolsBlockStart, toolsBlockEnd);
  const names = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);

  check("tool registry has exactly 12 declared tools", names.length === 12, `got ${names.length}: ${names.join(", ")}`);

  const dispatchBlock = extractFunction(source, "dispatchTool");
  const dispatchCases = new Set([...dispatchBlock.matchAll(/case\s+"([a-z_]+)":/g)].map((m) => m[1]));

  // iniciar_novo_cliente is the one documented exception -- Gate 32/the
  // tool's own description say it "não consulta o Portal nem calcula
  // nada", and the real call site (checked below) special-cases it
  // BEFORE dispatchTool is ever reached, by design.
  const missingFromDispatch = names.filter((n) => n !== "iniciar_novo_cliente" && !dispatchCases.has(n));
  check(
    "every tool except iniciar_novo_cliente has a matching dispatchTool() executor case",
    missingFromDispatch.length === 0,
    `missing: ${missingFromDispatch.join(", ")}`
  );

  const extraDispatchOnlyCases = [...dispatchCases].filter((c) => !names.includes(c));
  check(
    "dispatchTool declares no case for a tool name that isn't registered (no dead/orphan executor)",
    extraDispatchOnlyCases.length === 0,
    `unexpected: ${extraDispatchOnlyCases.join(", ")}`
  );

  check(
    "iniciar_novo_cliente has 0 parameters (Gate 32 -- pure reset marker, never calculates)",
    /name:\s*"iniciar_novo_cliente"[\s\S]{0,3000}?parameters:\s*\{\s*type:\s*"object",\s*properties:\s*\{\s*\}\s*,\s*required:\s*\[\s*\]/.test(source)
  );
}

// ---------- Security gate structure (Gate 35) ----------
{
  check(
    "no-session request returns 401",
    /status:\s*401/.test(source) && /não autenticado/i.test(source)
  );
  check(
    "non-MASTER caller returns 403, gated on caller.perfil server-side (never client payload)",
    /caller\.perfil.*!==\s*"MASTER"/.test(source) && /status:\s*403/.test(source)
  );
  check(
    "MASTER check resolves via a real DB lookup (service role / userClient), not a trusted client claim",
    /callerError\s*\|\|\s*!caller\s*\|\|\s*String\(caller\.perfil\)/.test(source)
  );
}

// ---------- Scenario memory / Novo Cliente reset mechanism (Gates 24-25) ----------
{
  const loopStart = source.indexOf("const conversationLength = conversation.length;");
  const loopEnd = source.indexOf("return new Response(", loopStart);
  const dispatchLoop = source.slice(loopStart, loopEnd);
  check(
    "iniciar_novo_cliente reset is mechanical (input.splice), not merely a prompt instruction",
    /input\.splice\(1,\s*conversationLength\)/.test(dispatchLoop)
  );
  check(
    "reset only fires once per request even if the model calls iniciar_novo_cliente more than once",
    /if\s*\(!scenarioReset\s*&&\s*conversationLength\s*>\s*0\)/.test(dispatchLoop)
  );
  check(
    "iniciar_novo_cliente never reaches dispatchTool/RPC -- handled before it, with a `continue`",
    /if\s*\(call\.name\s*===\s*"iniciar_novo_cliente"\)\s*\{[\s\S]{0,600}?continue;/.test(dispatchLoop)
  );
  check(
    "reset signal (scenario_reset) is returned to the caller so the CLIENT-held conversation array is pruned too -- the backend itself holds no persisted state to clear",
    /scenario_reset:\s*scenarioReset/.test(source)
  );
  check(
    "no database/table write exists for conversation or scenario state (memory is the client-held array only, per IA-2B's own stateless design)",
    !/\.from\(["']ai_conversation|\.from\(["']scenario_memory|\.from\(["']chat_history/i.test(source)
  );
}

// ---------- Structured blocks never recompute a financial value (Gate 28) ----------
{
  const ccBlock = extractFunction(source, "buildCashConversionBlock");
  const antBlock = extractFunction(source, "buildAntecipacaoBlock");
  // A block builder should only ever read `result.<field>` / `args.<field>`
  // (already-computed engine output) into `value:` -- never call a
  // calculation function of its own.
  const forbiddenCalcCalls = /(cashConversionCalcular|antecipacaoCalcular|Math\.pow|Math\.round)\s*\(/;
  check(
    "buildCashConversionBlock does not recompute -- no calculation call, only formats result.* fields",
    !forbiddenCalcCalls.test(ccBlock),
    ccBlock.match(forbiddenCalcCalls)?.[0]
  );
  check(
    "buildAntecipacaoBlock does not recompute -- no calculation call, only formats result.* fields",
    !forbiddenCalcCalls.test(antBlock),
    antBlock.match(forbiddenCalcCalls)?.[0]
  );
  check(
    "buildCashConversionBlock's items[].value all read from `result.` (the engine's own output), none is a literal number",
    /value:\s*result\./.test(ccBlock) && !/value:\s*-?\d/.test(ccBlock)
  );
}

console.log(`\n=== Structural Reconciliation Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

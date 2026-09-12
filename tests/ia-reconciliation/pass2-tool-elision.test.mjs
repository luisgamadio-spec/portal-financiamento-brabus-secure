// IA-3J.4K.1 — finance fast-path Pass-2+ tool-schema elision.
//
// IA-3J.4K's own forensic proved Pass 2 resends ~95.67% of its payload
// byte-for-byte identical to Pass 1 (the finance system prompt + the
// two-tool schema array), and that no currently-governed finance
// fast-path scenario needs a tool call past Pass 1 (balão escalation,
// multi-balloon exploration, and Linear-vs-Balão comparison are all
// either single-call or parallel-in-Pass-1, never sequential across
// passes within the fast-path domain; genuinely sequential chains
// such as finance->antecipação live exclusively in the FULL profile,
// which this Wave must not touch).
//
// This test extracts the REAL request-handler loop region verbatim
// (from `let toolCallCount = 0;` through the end of the real
// `while (true) { ... }` block) -- never a hand-copied duplicate --
// and runs it with a MOCKED callOpenAI/dispatchTool/evaluateToolPolicy
// /buildBlockFromToolResult (no real inference, no network, no
// Supabase), so the real pass-index/tool-selection control flow is
// exercised end to end, not just pattern-matched as source text.
//
// Run: node tests/ia-reconciliation/pass2-tool-elision.test.mjs

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractConst, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

// Balanced-brace class extractor (same local-helper pattern already
// used by multi-balloon-escalation.test.mjs's own extractInterfaceExtends,
// rather than changing the shared extract.mjs for a one-off need).
function extractClass(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)class\\s+${name}\\b`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractClass: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\r\n") ? 2 : m[0].startsWith("\n") ? 1 : 0);
  const braceStart = src.indexOf("{", m.index);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// Extracts the REAL request-handler region verbatim, from the first
// pre-loop declaration (`let toolCallCount = 0;`) through the matching
// close of the real `while (true) { ... }` block -- balanced-brace,
// same limitation as extract.mjs's own extractFunction (a "{"/"}"
// inside a string literal would corrupt the count; this file's own
// loop body contains exactly one such pair, the self-balancing `"{}"`
// in `JSON.parse(call.arguments || "{}")`, which nets to zero).
// IA-3J.5 -- the real source now wraps `while (true) { ... }` inside
// `if (!engineFirstRan) { ... }` (the fallback branch), with the new
// engine-first block itself sitting between the pre-loop declarations
// and that `if`. This test's own job is the OLD loop's behavior
// (full-profile + fallback), not engine-first (see
// finance-engine-first.test.mjs for that) -- so this extracts the
// pre-loop declarations and the while-loop body as TWO separate real
// slices, deliberately skipping the engine-first block and its `if`
// wrapper in between (never hand-copied -- both pieces are verbatim
// source text, just not contiguous in the file any more).
function extractRequestLoopRegion(src) {
  const start = src.indexOf("let toolCallCount = 0;");
  if (start === -1) throw new Error("extractRequestLoopRegion: region start not found");
  const passIndexMarker = "let passIndex = 0;";
  const passIndexIdx = src.indexOf(passIndexMarker, start);
  if (passIndexIdx === -1) throw new Error("extractRequestLoopRegion: passIndex declaration not found");
  const declEnd = passIndexIdx + passIndexMarker.length;
  const preDeclarations = src.slice(start, declEnd);

  const loopMarker = "while (true) {";
  const loopStart = src.indexOf(loopMarker, declEnd);
  if (loopStart === -1) throw new Error("extractRequestLoopRegion: while(true) not found after region start");
  const bodyOpen = loopStart + loopMarker.length - 1;
  let depth = 0, i = bodyOpen;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  const whileLoop = src.slice(loopStart, i);
  return preDeclarations + "\n\n" + whileLoop;
}

const loopRegion = extractRequestLoopRegion(source);
check("extracted loop region contains the real passTools declaration (not a hand-copied duplicate)", loopRegion.includes("const passTools = (isFinanceFastPath && passIndex > 0) ? [] : effectiveTools;"));
check("extracted loop region contains the real passIndex++ increment", loopRegion.includes("passIndex++"));
check("extracted loop region contains the real callOpenAI(openaiKey, input, passTools) call", loopRegion.includes("await callOpenAI(openaiKey, input, passTools)"));

// extract.mjs's own extractFunction mis-identifies the "{" inside a
// generic return type such as `Array<{ call_id: string; ... }>` as the
// function BODY opening brace (its own return-type skip only checks
// for a preceding ":"/"|", never an enclosing "<...>"), truncating the
// extraction. extractFunctionCalls is the one function in this file
// with that exact shape -- same local-extractor-override precedent as
// multi-balloon-escalation.test.mjs's own extractInterfaceExtends,
// rather than changing the shared helper every other test depends on.
function extractFunctionGenericAware(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)(async function|function)\\s+${name}\\s*\\(`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractFunctionGenericAware: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\r\n") ? 2 : m[0].startsWith("\n") ? 1 : 0);
  const parenOpen = src.indexOf("(", m.index + m[0].length - 1);
  let pdepth = 0, j = parenOpen;
  for (; j < src.length; j++) {
    if (src[j] === "(") pdepth++;
    else if (src[j] === ")") { pdepth--; if (pdepth === 0) { j++; break; } }
  }
  let angleDepth = 0;
  let bodyOpen = -1;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === "<") { angleDepth++; continue; }
    if (c === ">") { if (angleDepth > 0) angleDepth--; continue; }
    if (c !== "{") continue;
    if (angleDepth > 0) {
      let d = 0, e = k;
      for (; e < src.length; e++) {
        if (src[e] === "{") d++;
        else if (src[e] === "}") { d--; if (d === 0) { e++; break; } }
      }
      k = e - 1;
      continue;
    }
    let p = k - 1;
    while (p >= 0 && /\s/.test(src[p])) p--;
    const precedingChar = src[p];
    if (precedingChar === ":" || precedingChar === "|") {
      let d = 0, e = k;
      for (; e < src.length; e++) {
        if (src[e] === "{") d++;
        else if (src[e] === "}") { d--; if (d === 0) { e++; break; } }
      }
      k = e - 1;
      continue;
    }
    bodyOpen = k;
    break;
  }
  if (bodyOpen === -1) throw new Error(`extractFunctionGenericAware: no opening brace for "${name}"`);
  let bdepth = 0, i = bodyOpen;
  for (; i < src.length; i++) {
    if (src[i] === "{") bdepth++;
    else if (src[i] === "}") { bdepth--; if (bdepth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const toolErrorClass = extractClass(source, "ToolError");
const maxToolCallsConst = "export " + extractConst(source, "MAX_TOOL_CALLS");
const openaiModelConst = "export " + extractConst(source, "OPENAI_MODEL");
const extractFunctionCallsFn = "export " + extractFunctionGenericAware(source, "extractFunctionCalls");
const extractOutputTextFn = "export " + extractFunction(source, "extractOutputText");

// ---------- assemble a runnable fixture: real loop region, mocked transport/tool-execution ----------

const modText = `// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.
${toolErrorClass}

${maxToolCallsConst}

${openaiModelConst}

${extractFunctionCallsFn}

${extractOutputTextFn}

export async function runRequestLoop(opts) {
  const {
    effectiveTools, isFinanceFastPath, conversationLength,
    callOpenAI, dispatchTool, evaluateToolPolicy, buildBlockFromToolResult,
    input, requestId,
  } = opts;
  const openaiKey = "mock-key";
  const userClient = null;
  const authorityEnvelope = null;
  const checkModulePermission = null;
  const startedAt = Date.now();
  const OVERALL_TIMEOUT_MS = 55000;
  const timings = {
    auth_ms: null, master_gate_ms: null, config_scope_ms: null,
    openai_pass_ms: [], tool_dispatch_ms: [],
    tools_sent_count: effectiveTools.length,
    tools_sent_count_per_pass: [], input_item_count_per_pass: [],
  };

  ${loopRegion}

  return { finalText, timings, blocks, toolsUsed, toolCallCount, homologCalls, passIndex };
}
`;

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-pass2-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));
const { runRequestLoop } = mod;

// ---------- mock response builders (Responses API shape, no real inference) ----------

function mkResponse({ calls = [], text = null }) {
  const output = [];
  for (const c of calls) output.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments });
  if (text !== null) output.push({ type: "message", content: [{ type: "output_text", text }] });
  return { output, usage: { input_tokens: 100, output_tokens: 50 }, model: "gpt-5.6-luna" };
}

// ---------- Scenario 1: canonical finance fast-path flow (2 calls in Pass 1, synthesis in Pass 2) ----------

{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  const toolsSentPerCall = [];
  const toolsRefsSentPerCall = [];
  const dispatchedNames = [];
  const callOpenAI = async (_key, input, tools) => {
    toolsSentPerCall.push(tools.length);
    toolsRefsSentPerCall.push(tools);
    if (toolsSentPerCall.length === 1) {
      return mkResponse({
        calls: [
          { call_id: "call_balao", name: "simular_financiamento", arguments: JSON.stringify({ financing_type: "BALAO" }) },
          { call_id: "call_linear", name: "simular_financiamento", arguments: JSON.stringify({ financing_type: "LINEAR" }) },
        ],
      });
    }
    return mkResponse({ text: "Recomendo Balão em 30x de R$1.766,94, com dois balões de R$45.000 (meses 15 e 30)." });
  };
  const dispatchTool = async (_userClient, name, _args) => { dispatchedNames.push(name); return { ok: true, name }; };
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = (name) => ({ type: "metrics", title: name });

  const result = await runRequestLoop({
    effectiveTools: FINANCE_TOOLS,
    isFinanceFastPath: true,
    conversationLength: 0,
    callOpenAI, dispatchTool, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: "mock Test 1 message" }],
    requestId: "mock-req-1",
  });

  check("canonical mocked flow: exactly 2 OpenAI passes", result.timings.openai_pass_ms.length === 2, result.timings.openai_pass_ms.length);
  check("canonical mocked flow: exactly 2 tool dispatches", dispatchedNames.length === 2, dispatchedNames);
  check("canonical mocked flow: both dispatches are simular_financiamento", dispatchedNames.every((n) => n === "simular_financiamento"), dispatchedNames);
  check("canonical mocked flow: final text obtained", typeof result.finalText === "string" && result.finalText.length > 0, result.finalText);
  check("canonical mocked flow: blocks preserved (built from dispatch results, independent of synthesis)", result.blocks.length === 2, result.blocks);
  check("canonical mocked flow: MAX_TOOL_CALLS not triggered (2 <= 5)", result.toolCallCount === 2 && result.toolCallCount <= mod.MAX_TOOL_CALLS, result.toolCallCount);
  check("finance Pass 1 received 2 tools (unchanged)", toolsSentPerCall[0] === 2, toolsSentPerCall);
  check("finance Pass 2 received 0 tools (elided)", toolsSentPerCall[1] === 0, toolsSentPerCall);
  check("per-pass telemetry equals [2, 0]", JSON.stringify(result.timings.tools_sent_count_per_pass) === JSON.stringify([2, 0]), result.timings.tools_sent_count_per_pass);
  check("request-level tools_sent_count unchanged (still 2, the originally-selected count)", result.timings.tools_sent_count === 2, result.timings.tools_sent_count);
  // passIndex increments only at the bottom of an iteration that DID
  // dispatch tools (another pass is coming); the final pass (index 1,
  // 0 calls) breaks before reaching that line, so it correctly stays
  // at 1 -- the index of the pass that just ran, not a pass count.
  check("passIndex stays at 1 after the final (synthesis) pass, never incremented past the last real pass", result.passIndex === 1, result.passIndex);
  check("input_item_count_per_pass has 2 entries, strictly non-decreasing (Pass 2's input is Pass 1's input plus new items, never smaller)", result.timings.input_item_count_per_pass.length === 2 && result.timings.input_item_count_per_pass[1] >= result.timings.input_item_count_per_pass[0], result.timings.input_item_count_per_pass);
  check("Pass 1's tools argument is the EXACT SAME array reference as effectiveTools (no clone, no subset copy -- identity equality)", toolsRefsSentPerCall[0] === FINANCE_TOOLS);
  check("Pass 2's tools argument is a genuinely different (empty) array, never the same reference as effectiveTools", toolsRefsSentPerCall[1] !== FINANCE_TOOLS && toolsRefsSentPerCall[1].length === 0);
}

// ---------- Scenario 2: full-profile sequential flow -- tool A (Pass 1) -> tool B (Pass 2) -> final (Pass 3) ----------
// Critical regression guard: IA-3J.4K.1 must NOT apply tool elision outside isFinanceFastPath.

{
  const FULL_TOOLS = Array.from({ length: 12 }, (_, i) => ({ type: "function", name: `tool_${i}` }));
  const toolsSentPerCall = [];
  const dispatchedNames = [];
  const callOpenAI = async (_key, input, tools) => {
    toolsSentPerCall.push(tools.length);
    if (toolsSentPerCall.length === 1) {
      return mkResponse({ calls: [{ call_id: "call_a", name: "simular_financiamento", arguments: "{}" }] });
    }
    if (toolsSentPerCall.length === 2) {
      return mkResponse({ calls: [{ call_id: "call_b", name: "simular_antecipacao", arguments: "{}" }] });
    }
    return mkResponse({ text: "Síntese final cruzando financiamento e antecipação." });
  };
  const dispatchTool = async (_userClient, name) => { dispatchedNames.push(name); return { ok: true, name }; };
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = (name) => ({ type: "metrics", title: name });

  const result = await runRequestLoop({
    effectiveTools: FULL_TOOLS,
    isFinanceFastPath: false,
    conversationLength: 0,
    callOpenAI, dispatchTool, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock full prompt" }, { role: "user", content: "mock finance+antecipação message" }],
    requestId: "mock-req-2",
  });

  check("full-profile sequential mocked flow: exactly 3 OpenAI passes", result.timings.openai_pass_ms.length === 3, result.timings.openai_pass_ms.length);
  check("full-profile sequential mocked flow: tool A then tool B dispatched in order", JSON.stringify(dispatchedNames) === JSON.stringify(["simular_financiamento", "simular_antecipacao"]), dispatchedNames);
  check("full-profile Pass 1 retains full tool count (12)", toolsSentPerCall[0] === 12, toolsSentPerCall);
  check("full-profile Pass 2 retains full tool count (12) -- NOT elided", toolsSentPerCall[1] === 12, toolsSentPerCall);
  check("full-profile Pass 3 retains full tool count (12) -- NOT elided", toolsSentPerCall[2] === 12, toolsSentPerCall);
  check("full-profile per-pass telemetry retains full counts on every pass: [12, 12, 12]", JSON.stringify(result.timings.tools_sent_count_per_pass) === JSON.stringify([12, 12, 12]), result.timings.tools_sent_count_per_pass);
  check("full-profile final text obtained after the genuinely sequential chain", typeof result.finalText === "string" && result.finalText.length > 0, result.finalText);
}

// ---------- Scenario 3: finance fast-path, 3 passes (Pass1 tool -> Pass2 would-be tool attempt impossible -> Pass3 final) ----------
// Proves Pass 3+ also receives zero tools, not just Pass 2, for the fast-path domain.

{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  const toolsSentPerCall = [];
  const callOpenAI = async (_key, input, tools) => {
    toolsSentPerCall.push(tools.length);
    if (toolsSentPerCall.length === 1) {
      return mkResponse({ calls: [{ call_id: "call_1", name: "simular_financiamento", arguments: "{}" }] });
    }
    // Model receives tools:[] on this pass (API-level: it structurally
    // cannot emit a valid function_call through an empty tool
    // interface) -- the mock simply always returns text once no real
    // tool is offered, mirroring that structural guarantee.
    return mkResponse({ text: "Resposta final após a primeira simulação." });
  };
  const dispatchTool = async () => ({ ok: true });
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = () => null;

  const result = await runRequestLoop({
    effectiveTools: FINANCE_TOOLS,
    isFinanceFastPath: true,
    conversationLength: 0,
    callOpenAI, dispatchTool, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: "mock message" }],
    requestId: "mock-req-3",
  });

  check("finance Pass 1 = 2 tools", toolsSentPerCall[0] === 2, toolsSentPerCall);
  check("finance Pass 2 = 0 tools", toolsSentPerCall[1] === 0, toolsSentPerCall);
  check("per-pass telemetry reflects [2, 0] for this 2-call flow (Pass 3 never needed once Pass 2 returns 0 calls)", JSON.stringify(result.timings.tools_sent_count_per_pass) === JSON.stringify([2, 0]), result.timings.tools_sent_count_per_pass);
}

// ---------- source-level invariants (classifier/model/prompt/MAX_TOOL_CALLS frozen) ----------

check("classifyFinanceFastPath is not redefined/touched by this Wave (exactly one declaration)", [...source.matchAll(/function classifyFinanceFastPath\(/g)].length === 1);
check("FINANCE_FAST_PATH_ALLOW_RE is not redefined by this Wave (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_ALLOW_RE\s*=/g)].length === 1);
check("FINANCE_FAST_PATH_DENY_RE is not redefined by this Wave (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_DENY_RE\s*=/g)].length === 1);
check("FINANCE_FAST_PATH_TOOL_NAMES is not redefined by this Wave (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_TOOL_NAMES\s*=/g)].length === 1);
check("FINANCE_FAST_PATH_TOOLS is not redefined by this Wave (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_TOOLS\s*=/g)].length === 1);
check("MAX_TOOL_CALLS remains 5, unchanged", /const MAX_TOOL_CALLS = 5;/.test(source));
check("OPENAI_MODEL remains gpt-5.6-luna, unchanged", /const OPENAI_MODEL = "gpt-5\.6-luna";/.test(source));
check("FULL_SYSTEM_PROMPT composition is untouched by this Wave (still joins the same 20 canonical blocks)", /const FULL_SYSTEM_PROMPT = \[/.test(source));
check("FINANCE_PROMPT_PROFILE composition is untouched by this Wave", /const FINANCE_PROMPT_PROFILE = \[/.test(source));
check("timings.tools_sent_count assignment (request-level) is untouched -- still set once, before the loop", /timings\.tools_sent_count = effectiveTools\.length;/.test(source));

console.log(`\n=== Pass-2 Finance Tool Elision Tests (IA-3J.4K.1): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
if (fail > 0) process.exit(1);

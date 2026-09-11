// IA-3J.4F — finance fast-path tool-schema routing reconciliation.
//
// Real Human evidence (correlation_id 2a39c53c-718c-4dd9-8b72-a9c5e9ce85e1)
// proved OpenAI itself is ~90% of edge_internal_ms, across 2 sequential
// passes that both resend the FULL 12-tool schema unchanged. This test
// proves, against the REAL current source (never a hand-copied
// duplicate -- same discipline as every other reconciliation test),
// that the new deterministic, fail-closed routing added this Wave:
//   1. classifies the canonical finance scenario correctly;
//   2. falls back to the full tool set for every other domain and for
//      any ambiguous/short/empty message (never a partial guess);
//   3. never offers a tool that wasn't already in the full, governed
//      TOOLS array (permission monotonicity -- subset only, never a
//      superset, never a rewritten schema);
//   4. is computed exactly once per request, before the tool-calling
//      loop, so every pass of a multi-pass request uses the identical
//      tool set (no pass-to-pass tool-set drift);
//   5. produces a real, measured payload reduction when it fires.
//
// The classifier itself (a pure function over regexes, no dependency
// on any other module-level const) is imported and executed for real.
// TOOLS itself is a 44KB array that references many OTHER module-level
// consts (TOP_N_MAX, BALAO_PRAZOS, ...) transitively -- rather than
// resolving that whole dependency graph just to `eval` the array, the
// tool-inventory/payload-size assertions below work at the real
// SOURCE-TEXT level (identical discipline to structural.test.mjs's own
// "tool registry has exactly 12 declared tools" check), which proves
// the same facts without needing the array to actually construct.
//
// Run: node tests/ia-reconciliation/finance-fast-path-routing.test.mjs

import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readSource, extractFunction, extractConst } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- assemble a real, self-contained fixture for the classifier itself ----------
const allowReSrc = extractConst(source, "FINANCE_FAST_PATH_ALLOW_RE");
const denyReSrc = extractConst(source, "FINANCE_FAST_PATH_DENY_RE");
const classifyFnSrc = extractFunction(source, "classifyFinanceFastPath");

const fixtureTs = `
export ${allowReSrc}
export ${denyReSrc}
export ${classifyFnSrc}
`;
const fixturePath = join(import.meta.dirname, ".fixture-finance-fast-path.ts");
writeFileSync(fixturePath, fixtureTs, "utf8");

let mod;
try {
  mod = await import("file://" + fixturePath.replace(/\\/g, "/") + `?t=${Date.now()}`);
} finally {
  unlinkSync(fixturePath);
}
const { classifyFinanceFastPath } = mod;

// ---------- 1. canonical finance scenario classifies true ----------
{
  const canonical = "Preciso de uma proposta de financiamento pra um cliente Novos, veículo de R$180.000, com R$90.000 de entrada. Quero uma parcela o mais próxima possível de R$1.800.";
  check("canonical Test 1 scenario classifies as finance fast-path", classifyFinanceFastPath(canonical) === true);

  check("plain Balão question classifies as finance fast-path", classifyFinanceFastPath("Quero simular um financiamento Balão para um Outlander 0km") === true);
  check("plain Linear parcela question classifies as finance fast-path", classifyFinanceFastPath("Qual a parcela linear em 48 meses?") === true);
}

// ---------- 2. every other domain falls back (fail-closed) ----------
{
  const otherDomainMessages = [
    ["Score", "Qual o Score F&I do vendedor João este mês?"],
    ["Comissões", "Quanto foi a comissão do analista em julho?"],
    ["Salário", "Qual o salário base do gerente?"],
    ["Ranking", "Me mostra o ranking de lojas do trimestre"],
    ["Resultado", "Qual foi o resultado do mês passado?"],
    ["Operações Especiais", "Lista as operações especiais dos últimos 30 dias"],
    ["Antecipação", "Quero simular a antecipação desse contrato"],
    ["Cash Conversion", "Faz o cash conversion desse cliente"],
    ["Calculadora de Taxa", "Calcula a taxa implícita dessa proposta"],
    ["Histórico de Financiamento", "Qual o histórico de financiamento desse cliente?"],
    ["Coparticipado", "Quero um plano coparticipado para esse veículo"],
    ["Subsidiado", "Tem taxa subsidiada disponível?"],
    ["Semestral/Anual", "Simula um plano semestral de 36 meses"],
  ];
  for (const [domain, msg] of otherDomainMessages) {
    check(`${domain} question falls back to full tool set (denylist keyword present)`, classifyFinanceFastPath(msg) === false, msg);
  }
}

// ---------- 3. ambiguous / short / empty falls back ----------
{
  check("empty message falls back", classifyFinanceFastPath("") === false);
  check("whitespace-only message falls back", classifyFinanceFastPath("   ") === false);
  check("non-string input falls back (defensive)", classifyFinanceFastPath(null) === false);
  check(
    "short context-dependent follow-up ('e em 48 meses?') falls back -- accepted safety tradeoff, never a correctness risk",
    classifyFinanceFastPath("e em 48 meses?") === false
  );
  check("generic greeting falls back", classifyFinanceFastPath("oi, tudo bem?") === false);
}

// ---------- 4. permission monotonicity + payload size, at the source-text level ----------
{
  const toolsStart = source.indexOf("const TOOLS = [");
  const toolsEnd = source.indexOf("\n];", toolsStart) + 3;
  const toolsBlock = source.slice(toolsStart, toolsEnd);
  const allNames = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  check("TOOLS (full/governed) declares exactly 12 tools, unchanged", allNames.length === 12, allNames);

  const nameSetSrc = extractConst(source, "FINANCE_FAST_PATH_TOOL_NAMES");
  check(
    "FINANCE_FAST_PATH_TOOL_NAMES is exactly {simular_financiamento, iniciar_novo_cliente}",
    /new Set\(\["simular_financiamento",\s*"iniciar_novo_cliente"\]\)/.test(nameSetSrc),
    nameSetSrc
  );
  check(
    "FINANCE_FAST_PATH_TOOLS is a pure filter() over the real TOOLS array (never a hand-duplicated/rewritten list)",
    /TOOLS\.filter\(\(t\) => FINANCE_FAST_PATH_TOOL_NAMES\.has\(t\.name\)\)/.test(extractConst(source, "FINANCE_FAST_PATH_TOOLS"))
  );
  check(
    "every name in FINANCE_FAST_PATH_TOOL_NAMES exists in the real, full TOOLS array (permission monotonicity: subset only)",
    ["simular_financiamento", "iniciar_novo_cliente"].every((n) => allNames.includes(n))
  );

  // Per-tool byte size, sliced directly from the real source text
  // (split on the real "type: \"function\"," boundary each tool object
  // starts with) -- same technique used ad hoc to size this Wave's own
  // optimization target before implementing it.
  const parts = toolsBlock.split(/\r?\n  \{\r?\n    type: "function",/).slice(1);
  function extractConstBlock(name) {
    const marker = `const ${name} = `;
    const start = source.indexOf(marker);
    if (start === -1) return "";
    let i = start + marker.length;
    const openChar = source[i];
    if (openChar !== "{" && openChar !== "[") return "";
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0, j = i;
    for (; j < source.length; j++) {
      if (source[j] === openChar) depth++;
      else if (source[j] === closeChar) { depth--; if (depth === 0) { j++; break; } }
    }
    return source.slice(start, j);
  }
  let fullBytes = 0, fastPathBytes = 0;
  const fastPathNames = new Set(["simular_financiamento", "iniciar_novo_cliente"]);
  for (const p of parts) {
    const nameMatch = /name: "([a-z_]+)"/.exec(p);
    const name = nameMatch ? nameMatch[1] : "?";
    const paramsRefMatch = /parameters:\s*([A-Z_][A-Z0-9_]*)\s*,/.exec(p);
    let size = p.length;
    if (paramsRefMatch) size += extractConstBlock(paramsRefMatch[1]).length;
    fullBytes += size;
    if (fastPathNames.has(name)) fastPathBytes += size;
  }
  const reductionPct = ((fullBytes - fastPathBytes) / fullBytes) * 100;
  check("finance fast-path TOOLS payload is smaller than the full TOOLS payload", fastPathBytes < fullBytes, { fullBytes, fastPathBytes });
  check(
    `finance fast-path TOOLS reduction is material (>50%), measured at ${reductionPct.toFixed(1)}%`,
    reductionPct > 50,
    { fullBytes, fastPathBytes, reductionPct }
  );
  console.log(`  [measured] TOOLS payload (source-sliced, incl. referenced param-schema consts): full=${fullBytes} chars, fast-path=${fastPathBytes} chars, reduction=${reductionPct.toFixed(1)}%`);
}

// ---------- 5. wired once per request, not re-classified per pass ----------
{
  const classifyCallSites = [...source.matchAll(/classifyFinanceFastPath\(/g)];
  check(
    "classifyFinanceFastPath is referenced exactly twice in the whole file (its own function declaration + the one real call site)",
    classifyCallSites.length === 2,
    classifyCallSites.length
  );

  // IA-3J.4K.1 -- callOpenAI's 3rd argument is now `passTools`, a
  // per-pass selection derived deterministically from effectiveTools
  // (never a fresh call-site-specific tool list, never effectiveTools
  // itself re-inlined at the call site).
  const handlerCallSites = [...source.matchAll(/await callOpenAI\(openaiKey, input, passTools\)/g)];
  check(
    "callOpenAI is invoked from exactly one call site inside the request handler, always with passTools",
    handlerCallSites.length === 1,
    handlerCallSites.length
  );
  check(
    "no call site still passes the pre-IA-3J.4K.1 bare effectiveTools directly to callOpenAI",
    [...source.matchAll(/await callOpenAI\(openaiKey, input, effectiveTools\)/g)].length === 0
  );

  // IA-3J.4K.1 -- passTools itself must be a pure, deterministic
  // derivation of isFinanceFastPath/effectiveTools/passIndex only --
  // never a second classifier, never a heuristic, never LLM content.
  const passToolsIdx = source.indexOf("const passTools = (isFinanceFastPath && passIndex > 0) ? [] : effectiveTools;");
  check(
    "passTools is declared as exactly (isFinanceFastPath && passIndex > 0) ? [] : effectiveTools -- no second classifier, no heuristic",
    passToolsIdx !== -1
  );
  check(
    "exactly one passTools declaration exists in the whole file (never duplicated/diverged)",
    [...source.matchAll(/const passTools = /g)].length === 1
  );

  // IA-3J.4I -- the classification itself moved into a shared
  // `isFinanceFastPath` that now ALSO selects the prompt profile;
  // `effectiveTools` is still derived from it, still before the loop.
  const isFppIdx = source.indexOf("const isFinanceFastPath = classifyFinanceFastPath(message)");
  const effIdx = source.indexOf("const effectiveTools = isFinanceFastPath ? FINANCE_FAST_PATH_TOOLS : TOOLS");
  const loopIdx = source.indexOf("while (true) {");
  check(
    "isFinanceFastPath/effectiveTools are computed before the tool-calling while(true) loop begins",
    isFppIdx !== -1 && effIdx !== -1 && loopIdx !== -1 && isFppIdx < effIdx && effIdx < loopIdx,
    { isFppIdx, effIdx, loopIdx }
  );
  // IA-3J.4K.1 -- passIndex itself must be declared before the loop
  // (starts at 0) and incremented exactly once, inside the loop body,
  // never derived from toolCallCount/array lengths/model content.
  const passIndexDeclIdx = source.indexOf("let passIndex = 0;");
  check(
    "passIndex is declared (= 0) before the while(true) loop begins",
    passIndexDeclIdx !== -1 && passIndexDeclIdx < loopIdx,
    { passIndexDeclIdx, loopIdx }
  );
  check(
    "passIndex is incremented by exactly one plain `passIndex++` statement in the whole file",
    [...source.matchAll(/passIndex\+\+/g)].length === 1
  );
  check(
    "passIndex is never assigned from toolCallCount, openai_pass_ms.length, or calls.length",
    !/passIndex\s*=\s*(toolCallCount|.*openai_pass_ms\.length|.*calls\.length)/.test(source)
  );
}

// ---------- 6. callOpenAI sends the caller-provided tools, not the module-level TOOLS constant directly ----------
{
  const callOpenAIBody = extractFunction(source, "callOpenAI");
  check("callOpenAI's own signature takes a `tools` parameter", /async function callOpenAI\(apiKey: string, input: any\[\], tools: any\[\], attempt = 0\)/.test(source));
  check("callOpenAI's own fetch body does NOT hardcode `tools: TOOLS`", !/tools:\s*TOOLS\b/.test(callOpenAIBody));
  check(
    "callOpenAI's fetch body sends the `tools` parameter verbatim (shorthand property)",
    /body:\s*JSON\.stringify\(\{[\s\S]*?\n\s*tools\s*\n?\s*\}\)/.test(callOpenAIBody),
    callOpenAIBody.slice(0, 400)
  );
  check("callOpenAI's retry branch forwards the same `tools` parameter (not a fresh TOOLS reference)", /return callOpenAI\(apiKey, input, tools, attempt \+ 1\)/.test(callOpenAIBody));
}

// ---------- 7. stage_ms telemetry reflects the real per-request choice ----------
{
  // IA-3J.4I -- effectiveSystemPrompt now sits between effectiveTools
  // and the tools_sent_count assignment (the same ONE resolved routing
  // decision also selects the prompt profile) -- this check now proves
  // the assignment follows the routing block as a whole, not literally
  // the very next line.
  check(
    "timings.tools_sent_count is set as part of the same one-time routing block that computes effectiveTools/effectiveSystemPrompt",
    /const effectiveTools = isFinanceFastPath \? FINANCE_FAST_PATH_TOOLS : TOOLS;\s*\r?\n\s*const effectiveSystemPrompt = isFinanceFastPath \? FINANCE_PROMPT_PROFILE : FULL_SYSTEM_PROMPT;\s*\r?\n\s*timings\.tools_sent_count = effectiveTools\.length;/.test(source)
  );
}

console.log(`\n=== Finance Fast-Path Routing Tests (IA-3J.4F): ${pass}/${pass + fail} ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

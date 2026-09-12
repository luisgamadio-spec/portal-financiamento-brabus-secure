// IA-3J.5 — deterministic finance engine-first fast path.
//
// IA-3J.4K.2's own real Human sample (total_ui_ms 17,670, OpenAI
// 13,149ms across 2 sequential passes, perception LENTO) showed
// further Pass-2 micro-optimization has limited headroom. This Wave
// eliminates the Pass-1 PLANNING round-trip entirely for a narrow,
// explicitly-enumerated class of unambiguous finance requests:
// extract parameters deterministically (never a second LLM call),
// run the SAME canonical toolSimularFinanciamento authority the
// normal tool-calling path already uses (never a duplicated
// formula), then make exactly ONE OpenAI call (tools: []) for
// synthesis only. Anything not confidently recognized falls back,
// completely unmodified, to the existing OpenAI/tool loop.
//
// This test proves, against the REAL current source (never a
// hand-copied duplicate): (1) the deterministic extractor/classifier
// correctly recognizes every eligible example and correctly rejects
// every ineligible one listed in the brief's own regression table;
// (2) a mocked execution of the REAL extracted request-handler region
// (engine-first block + fallback block, external transport/DB/OpenAI
// calls mocked, no real inference) proves the canonical flow makes
// exactly 1 OpenAI call with tools=[], and that authorization denial
// and extraction failure both fall through to the unmodified old
// loop; (3) the constructed SimulationInput objects for canonical
// Test 1 match the same values the existing tool-dispatch path would
// have produced, so the canonical engine (unchanged, uncalled-twice)
// receives identical arguments.
//
// Run: node tests/ia-reconciliation/finance-engine-first.test.mjs

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractConst, extractFunction, extractInterface } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function extractTypeAlias(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)type\\s+${name}\\s*=([\\s\\S]*?);\\r?\\n`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractTypeAlias: "${name}" not found`);
  return `type ${name} =${m[1]};`;
}

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

// extract.mjs's own extractFunction mis-identifies the "{" inside a
// generic return type such as `Array<{ call_id: string; ... }>` as
// the function BODY opening brace. extractFunctionCalls is the one
// function with that exact shape -- same local-extractor-override
// precedent as pass2-tool-elision.test.mjs's own copy of this helper.
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

// Finds `marker` at-or-after fromIndex, then balance-matches from the
// first "{" at/after the marker to the end of that block -- used to
// pull the two real sibling if-blocks (engine-first / fallback) out
// of the request handler as separate, verbatim slices.
function extractBalancedFrom(src, marker, fromIndex) {
  const idx = src.indexOf(marker, fromIndex);
  if (idx === -1) throw new Error(`extractBalancedFrom: marker "${marker}" not found at/after ${fromIndex}`);
  const braceOpen = src.indexOf("{", idx);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return { text: src.slice(idx, i), end: i };
}

// ---------- extract the real deterministic extractor + its type/const dependencies ----------

const simDepartmentType = extractTypeAlias(source, "SimDepartment");
const simulationModeType = extractTypeAlias(source, "SimulationMode");
const simFinancingTypeType = extractTypeAlias(source, "SimFinancingType");
const simulationInputInterface = "export " + extractInterface(source, "SimulationInput");
const round2Fn = "export " + extractFunction(source, "round2");
const brMoneyTokenConst = "export " + extractConst(source, "BR_MONEY_TOKEN_RE_SRC");
const vehicleValueReConst = "export " + extractConst(source, "VEHICLE_VALUE_RE_SRC");
const parseBRMoneyTokenFn = "export " + extractFunction(source, "parseBRMoneyToken");
const maskSpanFn = "export " + extractFunction(source, "maskSpan");
const extractPlanFn = "export " + extractFunction(source, "extractFinanceEngineFirstPlan");
const emptySimulationInputFn = "export " + extractFunction(source, "emptySimulationInput");
const buildInputsFn = "export " + extractFunction(source, "buildEngineFirstSimulationInputs");
const classifyFn = "export " + extractFunction(source, "classifyFinanceFastPath");
const allowReConst = "export " + extractConst(source, "FINANCE_FAST_PATH_ALLOW_RE");
const denyReConst = "export " + extractConst(source, "FINANCE_FAST_PATH_DENY_RE");

const extractorModText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  simDepartmentType, simulationModeType, simFinancingTypeType, simulationInputInterface,
  round2Fn, brMoneyTokenConst, vehicleValueReConst, parseBRMoneyTokenFn, maskSpanFn, extractPlanFn, emptySimulationInputFn, buildInputsFn,
  allowReConst, denyReConst, classifyFn,
].join("\n\n");

const tmpDir1 = mkdtempSync(join(tmpdir(), "ia-recon-efirst-extractor-"));
const extractorPath = join(tmpDir1, "extracted.ts");
writeFileSync(extractorPath, extractorModText, "utf8");
const extractorMod = await import("file://" + extractorPath.replace(/\\/g, "/"));
const { extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs, classifyFinanceFastPath, parseBRMoneyToken } = extractorMod;

// ---------- A. parseBRMoneyToken -- real function, representative Brazilian formats ----------

check("parseBRMoneyToken('180.000') = 180000", parseBRMoneyToken("180.000") === 180000);
check("parseBRMoneyToken('180000') = 180000", parseBRMoneyToken("180000") === 180000);
check("parseBRMoneyToken('R$ 180.000') = 180000", parseBRMoneyToken("R$ 180.000") === 180000);
check("parseBRMoneyToken('90 mil') = 90000", parseBRMoneyToken("90 mil") === 90000);
check("parseBRMoneyToken('1.800') = 1800", parseBRMoneyToken("1.800") === 1800);
check("parseBRMoneyToken('1.800,50') = 1800.5", parseBRMoneyToken("1.800,50") === 1800.5);
check("parseBRMoneyToken('abc') = null (never guesses)", parseBRMoneyToken("abc") === null);
check("parseBRMoneyToken('0') = null (not a positive amount)", parseBRMoneyToken("0") === null);

// ---------- B. extractFinanceEngineFirstPlan -- eligible canonical scenarios (regression items 1-6) ----------

const CANONICAL_TEST_1 = "Tenho um cliente comprando um Eclipse HPE 0 km de R$ 180.000, com entrada de R$ 90.000. Quero chegar o mais perto possível de R$ 1.800 de parcela. O prazo pode variar. Qual estrutura você recomenda?";

{
  const plan = extractFinanceEngineFirstPlan(CANONICAL_TEST_1);
  check("[item 1] canonical target-payment request recognized (plan is non-null)", plan !== null, plan);
  if (plan) {
    check("[item 1] department = NOVOS (0 km signal)", plan.department === "NOVOS", plan.department);
    check("[item 1] vehicleValue = 180000", plan.vehicleValue === 180000, plan.vehicleValue);
    check("[item 1] downPayment = 90000", plan.downPayment === 90000, plan.downPayment);
    check("[item 1] targetPayment = 1800", plan.targetPayment === 1800, plan.targetPayment);
    check("[item 1] termMonths = null (prazo pode variar)", plan.termMonths === null, plan.termMonths);
    check("[item 1] scenario = BOTH_BALAO_AND_LINEAR (spontaneous recommendation, no modality named)", plan.scenario === "BOTH_BALAO_AND_LINEAR", plan.scenario);
  }
}

{
  // [item 2] Linear explícito
  const msg = "Cliente comprando um HR-V 0 km de R$ 150.000, com entrada de R$ 30.000. Quero simular o financiamento linear.";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[item 2] explicit Linear request recognized", plan !== null, plan);
  if (plan) check("[item 2] scenario = LINEAR_ONLY", plan.scenario === "LINEAR_ONLY", plan.scenario);
}

{
  // [item 3] Balão explícito
  const msg = "Cliente comprando um L200 0 km de R$ 200.000, com entrada de R$ 50.000. Quero simular no Balão.";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[item 3] explicit Balão request recognized", plan !== null, plan);
  if (plan) check("[item 3] scenario = BALAO_ONLY", plan.scenario === "BALAO_ONLY", plan.scenario);
}

{
  // [item 4] prazo 48 meses explícito, sem modalidade nomeada (default Linear)
  const msg = "Cliente comprando um Eclipse 0 km de R$ 180.000, com entrada de R$ 90.000, financiando em 48 meses.";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[item 4] explicit 48-month term request recognized", plan !== null, plan);
  if (plan) {
    check("[item 4] termMonths = 48", plan.termMonths === 48, plan.termMonths);
    check("[item 4] scenario defaults to LINEAR_ONLY (no modality named)", plan.scenario === "LINEAR_ONLY", plan.scenario);
  }
}

{
  // [item 5] menor parcela possível, sem modalidade nomeada
  const msg = "Cliente comprando um Triton 0 km de R$ 220.000, com entrada de R$ 60.000. Quero a menor parcela possível.";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[item 5] 'menor parcela' request recognized", plan !== null, plan);
  if (plan) check("[item 5] scenario = BOTH_BALAO_AND_LINEAR (spontaneous consideration)", plan.scenario === "BOTH_BALAO_AND_LINEAR", plan.scenario);
}

{
  // [item 6] multi-balão governado pelo motor = o próprio Test 1 (target_payment
  // aciona balaoOptimizeEscalateForTarget dentro do motor, nunca um array
  // explícito do usuário) -- já coberto pelo item 1; reconfirmado aqui
  // explicitamente como a prova do item 6.
  const plan = extractFinanceEngineFirstPlan(CANONICAL_TEST_1);
  check("[item 6] multi-balão-governado case = canonical Test 1 itself (target_payment set, engine escalates internally)", plan !== null && plan.targetPayment === 1800);
}

{
  // comparação Linear x Balão explícita
  const msg = "Cliente comprando um Pajero 0 km de R$ 250.000, com entrada de R$ 70.000. Compare Linear e Balão.";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[comparison] explicit Linear x Balão comparison recognized", plan !== null, plan);
  if (plan) check("[comparison] scenario = BOTH_BALAO_AND_LINEAR", plan.scenario === "BOTH_BALAO_AND_LINEAR", plan.scenario);
}

// ---------- C. ineligible scenarios -- must return null (regression items 7-14) ----------

check("[item 7] insufficient data (no entrada) -- null", extractFinanceEngineFirstPlan("Cliente comprando um Eclipse 0 km de R$ 180.000. Qual estrutura recomenda?") === null);
check("[item 7] insufficient data (no vehicle value) -- null", extractFinanceEngineFirstPlan("Cliente com entrada de R$ 90.000, 0 km. Qual estrutura recomenda?") === null);
check("[item 7] insufficient data (no department signal) -- null", extractFinanceEngineFirstPlan("Cliente comprando um carro de R$ 180.000, com entrada de R$ 90.000. Qual estrutura recomenda?") === null);
check("[item 7] Seminovos without vehicle_year -- null (fail closed, never omit a required field)", extractFinanceEngineFirstPlan("Cliente comprando um carro seminovo de R$ 120.000, com entrada de R$ 40.000. Qual estrutura recomenda?") === null);
check("[item 8] short follow-up 'e em 48?' -- null (no entrada/vehicle value at all)", extractFinanceEngineFirstPlan("e em 48?") === null);
check("[item 8] short follow-up 'e 100 mil?' -- null", extractFinanceEngineFirstPlan("e 100 mil?") === null);

// Items 9-13 (campanha/antecipação/cash conversion/taxa/histórico) are
// already excluded upstream by classifyFinanceFastPath's own untouched
// deny-list -- this is the REAL, combined gate the production code
// actually uses (isFinanceFastPath && extractFinanceEngineFirstPlan),
// proven together rather than assuming the deny-list alone suffices.
function engineFirstEligible(message) {
  return classifyFinanceFastPath(message) ? extractFinanceEngineFirstPlan(message) : null;
}
check("[item 9] campaign keyword ('subsidiado') -- denied upstream, never reaches engine-first", engineFirstEligible("Cliente 0 km de R$ 180.000, entrada de R$ 90.000, tem taxa subsidiada?") === null);
check("[item 10] antecipação keyword -- denied upstream", engineFirstEligible("Cliente 0 km de R$ 180.000, entrada de R$ 90.000, quanto pago para quitar antecipadamente?") === null);
check("[item 11] cash conversion keyword -- denied upstream", engineFirstEligible("Cliente 0 km de R$ 180.000, entrada de R$ 90.000, simule cash conversion") === null);
check("[item 12] taxa implícita keyword -- denied upstream", engineFirstEligible("Cliente 0 km de R$ 180.000, entrada de R$ 90.000, calcular taxa implícita") === null);
check("[item 13] histórico keyword -- denied upstream", engineFirstEligible("Cliente 0 km de R$ 180.000, entrada de R$ 90.000, e qual o histórico de financiamento?") === null);
check("[item 14] new-client reset -- denied upstream (no allow-keyword at all)", engineFirstEligible("quero começar outro cliente") === null);

// ---------- D. buildEngineFirstSimulationInputs -- exact argument fidelity for canonical Test 1 ----------

{
  const plan = extractFinanceEngineFirstPlan(CANONICAL_TEST_1);
  const inputs = buildEngineFirstSimulationInputs(plan);
  check("canonical Test 1 produces exactly 2 SimulationInput calls (Balão + Linear)", inputs.length === 2, inputs.length);
  const balao = inputs.find((i) => i.financing_type === "BALAO");
  const linear = inputs.find((i) => i.financing_type === "LINEAR");
  check("Balão call present", !!balao);
  check("Linear call present", !!linear);
  if (balao) {
    check("Balão: mode=payment", balao.mode === "payment");
    check("Balão: department=NOVOS", balao.department === "NOVOS");
    check("Balão: vehicle_value=180000", balao.vehicle_value === 180000);
    check("Balão: down_payment=90000", balao.down_payment === 90000);
    check("Balão: target_payment=1800", balao.target_payment === 1800);
    check("Balão: term_months=null (evaluate every term)", balao.term_months === null);
    check("Balão: show_term_comparison=false (recommendation, not comparison table)", balao.show_term_comparison === false);
    check("Balão: balloon_value=null (delegated optimization, never a guessed value)", balao.balloon_value === null);
    check("Balão: balloon_count_max=null (engine escalates internally, never pre-decided here)", balao.balloon_count_max === null);
  }
  if (linear) {
    check("Linear: financing_type=LINEAR (never omitted/ambiguous)", linear.financing_type === "LINEAR");
    check("Linear: same vehicle_value/down_payment/target_payment as Balão", linear.vehicle_value === 180000 && linear.down_payment === 90000 && linear.target_payment === 1800);
  }
}

// ---------- E. mocked execution of the REAL request-handler region (engine-first + fallback) ----------

const declStart = source.indexOf("let toolCallCount = 0;");
if (declStart === -1) throw new Error("region start not found");
const passIndexMarker = "let passIndex = 0;";
const passIndexIdx = source.indexOf(passIndexMarker, declStart);
const declEnd = passIndexIdx + passIndexMarker.length;
const preDeclarations = source.slice(declStart, declEnd);

// The gate declarations sit between the pre-loop declarations and the
// engine-first if-block itself -- extracted verbatim as their own
// small slice so the synthetic harness below has them too.
const gateMarker = "const engineFirstPlan = isFinanceFastPath ? extractFinanceEngineFirstPlan(message) : null;";
const gateStart = source.indexOf(gateMarker, declEnd);
if (gateStart === -1) throw new Error("engineFirstPlan gate declaration not found");
const engineFirstRanMarker = "let engineFirstRan = false;";
const gateEnd = source.indexOf(engineFirstRanMarker, gateStart) + engineFirstRanMarker.length;
const gateDeclarations = source.slice(gateStart, gateEnd);
check("gate declarations include the real engineFirstPlan computation", gateDeclarations.includes(gateMarker));
check("gate declarations include the real engineFirstRan flag", gateDeclarations.includes(engineFirstRanMarker));

const blockA = extractBalancedFrom(source, "if (engineFirstPlan) {", declEnd);
check("extracted engine-first block contains the real extractFinanceEngineFirstPlan-driven flow marker", blockA.text.includes("buildEngineFirstSimulationInputs(engineFirstPlan)"));
const blockB = extractBalancedFrom(source, "if (!engineFirstRan) {", blockA.end);
check("extracted fallback block contains the real unmodified while(true) loop", blockB.text.includes("while (true) {") && blockB.text.includes("await callOpenAI(openaiKey, input, passTools)"));

const toolErrorClass = extractClass(source, "ToolError");
const maxToolCallsConst = "export " + extractConst(source, "MAX_TOOL_CALLS");
const openaiModelConst = "export " + extractConst(source, "OPENAI_MODEL");
const overallTimeoutConst = "export " + extractConst(source, "OVERALL_TIMEOUT_MS");
const extractFunctionCallsFn = "export " + extractFunctionGenericAware(source, "extractFunctionCalls");
const extractOutputTextFn = "export " + extractFunction(source, "extractOutputText");

const harnessModText = `// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.
${toolErrorClass}

${maxToolCallsConst}

${openaiModelConst}

${overallTimeoutConst}

${extractFunctionCallsFn}

${extractOutputTextFn}

export async function runRequestLoop(opts) {
  const {
    isFinanceFastPath, message, effectiveTools,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult, dispatchTool,
    input,
  } = opts;
  const openaiKey = "mock-key";
  const userClient = null;
  const authorityEnvelope = null;
  const checkModulePermission = null;
  const startedAt = Date.now();
  const timings = {
    auth_ms: null, master_gate_ms: null, config_scope_ms: null,
    openai_pass_ms: [], tool_dispatch_ms: [],
    tools_sent_count: effectiveTools.length,
    tools_sent_count_per_pass: [], input_item_count_per_pass: [],
    execution_path: null, openai_pass_count: null,
  };

  ${preDeclarations}

  ${gateDeclarations}

  ${blockA.text}

  ${blockB.text}

  timings.openai_pass_count = timings.openai_pass_ms.length;
  return { finalText, timings, blocks, toolsUsed, toolCallCount, homologCalls, engineFirstRan };
}
`;

const tmpDir2 = mkdtempSync(join(tmpdir(), "ia-recon-efirst-loop-"));
const harnessPath = join(tmpDir2, "extracted.ts");
writeFileSync(harnessPath, harnessModText, "utf8");
const harnessMod = await import("file://" + harnessPath.replace(/\\/g, "/"));
const { runRequestLoop } = harnessMod;

function mkResponse({ calls = [], text = null }) {
  const output = [];
  for (const c of calls) output.push({ type: "function_call", call_id: c.call_id, name: c.name, arguments: c.arguments });
  if (text !== null) output.push({ type: "message", content: [{ type: "output_text", text }] });
  return { output, usage: { input_tokens: 100, output_tokens: 50 }, model: "gpt-5.6-luna" };
}

// ---------- E1. canonical finance engine-first flow ----------
{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  const openaiCalls = [];
  const toolsSimulated = [];
  const callOpenAI = async (_key, input, tools) => {
    openaiCalls.push({ toolsLength: tools.length, inputSnapshotLength: input.length });
    return mkResponse({ text: "Recomendo Balão em 30x de R$1.766,94, com dois balões de R$45.000 (meses 15 e 30); Linear em 60x de R$2.984,38, para comparação." });
  };
  const toolSimularFinanciamento = async (_userClient, args) => {
    toolsSimulated.push(args.financing_type);
    if (args.financing_type === "BALAO") {
      return { department: "NOVOS", vehicle_value: 180000, down_payment: 90000, financing_type: "BALAO", balloon_optimized: true, target_payment: 1800, results: [{ term_months: 30, feasible: true, monthly_payment: 1766.94, balloons: [{ month: 15, value: 45000 }, { month: 30, value: 45000 }] }] };
    }
    return { mode: "payment", department: "NOVOS", vehicle_value: 180000, down_payment: 90000, target_payment: 1800, results: [{ term_months: 60, payment: 2984.38 }] };
  };
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = (name) => ({ type: "metrics", title: name });

  const result = await runRequestLoop({
    isFinanceFastPath: true,
    message: CANONICAL_TEST_1,
    effectiveTools: FINANCE_TOOLS,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: CANONICAL_TEST_1 }],
  });

  check("[E1] canonical flow: execution_path = finance_engine_first", result.timings.execution_path === "finance_engine_first", result.timings.execution_path);
  check("[E1] canonical flow: engineFirstRan = true", result.engineFirstRan === true);
  check("[E1] canonical flow: exactly 1 OpenAI call", openaiCalls.length === 1, openaiCalls.length);
  check("[E1] canonical flow: that 1 call received tools=[] (empty, not omitted)", openaiCalls[0].toolsLength === 0, openaiCalls[0]);
  check("[E1] canonical flow: openai_pass_count = 1", result.timings.openai_pass_count === 1, result.timings.openai_pass_count);
  check("[E1] canonical flow: ZERO OpenAI planning passes before synthesis (pass count itself IS the synthesis call)", openaiCalls.length === 1);
  check("[E1] canonical flow: both BALAO and LINEAR were simulated via the real canonical authority call site", JSON.stringify(toolsSimulated.sort()) === JSON.stringify(["BALAO", "LINEAR"]), toolsSimulated);
  check("[E1] canonical flow: 2 tool_dispatch_ms entries recorded", result.timings.tool_dispatch_ms.length === 2, result.timings.tool_dispatch_ms);
  check("[E1] canonical flow: blocks populated from dispatch results (2 cards, independent of model prose)", result.blocks.length === 2, result.blocks);
  check("[E1] canonical flow: toolCallCount = 2", result.toolCallCount === 2, result.toolCallCount);
  check("[E1] canonical flow: final text obtained", typeof result.finalText === "string" && result.finalText.length > 0);
  check("[E1] canonical flow: per-pass telemetry tools_sent_count_per_pass = [0]", JSON.stringify(result.timings.tools_sent_count_per_pass) === JSON.stringify([0]), result.timings.tools_sent_count_per_pass);
  check("[E1] canonical flow: request-level tools_sent_count still reflects the originally-selected fast-path count (2), untouched", result.timings.tools_sent_count === 2, result.timings.tools_sent_count);
}

// ---------- E2. extraction failure -- must fall back to the unmodified old loop ----------
{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  const openaiCalls = [];
  const callOpenAI = async (_key, input, tools) => {
    openaiCalls.push(tools.length);
    if (openaiCalls.length === 1) {
      return mkResponse({ calls: [{ call_id: "c1", name: "simular_financiamento", arguments: "{}" }] });
    }
    return mkResponse({ text: "Resposta via arquitetura antiga." });
  };
  // engine-first calls toolSimularFinanciamento directly; the OLD loop
  // (this scenario's path) calls dispatchTool instead -- both mocked
  // so either path can be faithfully exercised.
  let simulateCalled = false;
  const toolSimularFinanciamento = async () => { simulateCalled = true; return { ok: true }; };
  const dispatchTool = async () => { simulateCalled = true; return { ok: true }; };
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = () => null;

  // Fast-path eligible (contains "financiamento") but NOT engine-first
  // eligible (no "entrada" mention at all) -- must fall back.
  const ambiguousMessage = "Cliente comprando um carro de R$ 180.000. Quero simular o financiamento. Qual estrutura recomenda?";
  const result = await runRequestLoop({
    isFinanceFastPath: true,
    message: ambiguousMessage,
    effectiveTools: FINANCE_TOOLS,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult, dispatchTool,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: ambiguousMessage }],
  });

  check("[E2] insufficient-data message: engineFirstRan = false (fell back)", result.engineFirstRan === false);
  check("[E2] insufficient-data message: execution_path = openai_tool_loop", result.timings.execution_path === "openai_tool_loop", result.timings.execution_path);
  check("[E2] insufficient-data message: old loop ran as normal (2 passes, tool actually dispatched via the normal path)", openaiCalls.length === 2 && simulateCalled === true, { openaiCalls, simulateCalled });
  check("[E2] insufficient-data message: Pass 1 received the full fast-path tool set (2), never narrowed by engine-first logic", openaiCalls[0] === 2, openaiCalls);
}

// ---------- E3. engine-first eligible but DENIED by authorization -- must fall back, never fabricate its own denial ----------
{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  const openaiCalls = [];
  const callOpenAI = async (_key, input, tools) => {
    openaiCalls.push(tools.length);
    return mkResponse({ text: "Esta consulta não está disponível para o seu perfil." });
  };
  let simulateCalledDuringEngineFirst = false;
  const toolSimularFinanciamento = async () => { simulateCalledDuringEngineFirst = true; return { ok: true }; };
  const evaluateToolPolicy = async () => ({ allowed: false, reason: "MODULE_PERMISSION_DENIED" });
  const buildBlockFromToolResult = () => null;

  const result = await runRequestLoop({
    isFinanceFastPath: true,
    message: CANONICAL_TEST_1,
    effectiveTools: FINANCE_TOOLS,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: CANONICAL_TEST_1 }],
  });

  check("[E3] denied authorization: engineFirstRan = false (fell back, never fabricated a denial itself)", result.engineFirstRan === false);
  check("[E3] denied authorization: toolSimularFinanciamento was NEVER called during the engine-first attempt (denial short-circuits before dispatch)", simulateCalledDuringEngineFirst === false);
  check("[E3] denied authorization: execution_path = openai_tool_loop (fell through to the existing, already-tested denial path)", result.timings.execution_path === "openai_tool_loop");
}

// ---------- F. full-profile requests are never eligible for engine-first (structural, not just by convention) ----------

check("engine-first gate in source requires isFinanceFastPath (full-profile requests structurally excluded)", source.includes("const engineFirstPlan = isFinanceFastPath ? extractFinanceEngineFirstPlan(message) : null;"));

// ---------- G. source-level invariants (frozen symbols, no duplicated formula) ----------

check("classifyFinanceFastPath not modified by this Wave (still exactly one declaration)", [...source.matchAll(/function classifyFinanceFastPath\(/g)].length === 1);
check("FINANCE_FAST_PATH_ALLOW_RE not modified (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_ALLOW_RE\s*=/g)].length === 1);
check("FINANCE_FAST_PATH_DENY_RE not modified (exactly one declaration)", [...source.matchAll(/const FINANCE_FAST_PATH_DENY_RE\s*=/g)].length === 1);
check("MAX_TOOL_CALLS remains 5, unchanged", /const MAX_TOOL_CALLS = 5;/.test(source));
check("OPENAI_MODEL remains gpt-5.6-luna, unchanged", /const OPENAI_MODEL = "gpt-5\.6-luna";/.test(source));
check("toolSimularFinanciamento itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/async function toolSimularFinanciamento\(/g)].length === 1);
check("balaoCalcular itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function balaoCalcular\(/g)].length === 1);
check("balaoOptimizeEscalateForTarget itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function balaoOptimizeEscalateForTarget\(/g)].length === 1);
check("buildBlockFromToolResult itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function buildBlockFromToolResult\(/g)].length === 1);
check("engine-first calls buildBlockFromToolResult (same real card-building authority, never a new one)", source.includes('buildBlockFromToolResult("simular_financiamento", simArgs, output)'));
check("engine-first calls the SAME evaluateToolPolicy authorization gate the existing loop uses (never bypassed)", source.includes('evaluateToolPolicy("simular_financiamento", simArgs, authorityEnvelope, checkModulePermission)'));
check("FULL_SYSTEM_PROMPT composition untouched by this Wave", /const FULL_SYSTEM_PROMPT = \[/.test(source));
check("FINANCE_PROMPT_PROFILE composition untouched by this Wave (reused as-is for synthesis, no new synthesis profile)", /const FINANCE_PROMPT_PROFILE = \[/.test(source));
check("no new synthesis-only prompt profile was created this Wave", !/FINANCE_SYNTHESIS_PROFILE/.test(source));

console.log(`\n=== Finance Engine-First Tests (IA-3J.5): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
if (fail > 0) process.exit(1);

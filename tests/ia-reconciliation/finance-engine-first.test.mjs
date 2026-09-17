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
import { readSource, extractConst, extractFunction, extractInterface, extractComposedPrompt, extractTemplateLiteralConst } from "./extract.mjs";

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
  // [ \t]* tolerates a function declared INSIDE another function body
  // (e.g. timedEvaluateToolPolicy, indented, not at module top level) --
  // never changes what's captured for an unindented, top-level match.
  const markerRe = new RegExp(`(?:^|\\r?\\n)([ \\t]*)(async function|function)\\s+${name}\\s*\\(`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractFunctionGenericAware: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\r\n") ? 2 : m[0].startsWith("\n") ? 1 : 0) + m[1].length;
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

// IA-CAPLOCK3 -- Part E's mocked end-to-end execution (below) needs the
// REAL current gate/blocks, which have evolved since this file was
// first written: the gate no longer calls extractFinanceEngineFirstPlan
// directly -- it now runs resolveCashConversionContext AND
// resolveStatefulFinancePlan AND resolveStatefulRequiredDownPaymentPlan
// (IA-REGRESSION-01 / IA-UAT-04), and three more real if-blocks
// (Cash Conversion, requiredDownPaymentPlan) now sit between the
// engine-first block and the fallback loop. Parts A-D above are
// unaffected (extractFinanceEngineFirstPlan/buildEngineFirstSimulationInputs/
// classifyFinanceFastPath are still the same standalone functions,
// unchanged) -- these additional deps are for Part E only.
const clientBoundaryConst = "export " + extractConst(source, "CLIENT_BOUNDARY_RE");
const linearOnlyExclusionConst = "export " + extractConst(source, "LINEAR_ONLY_EXCLUSION_RE");
const resolveStatefulPlanFn = "export " + extractFunction(source, "resolveStatefulFinancePlan");
const applyLinearOnlyExclusionFn = "export " + extractFunction(source, "applyLinearOnlyExclusion");
const engineFirstCandidateInterface = "export " + extractInterface(source, "EngineFirstCandidate");
const collectCandidatesFn = "export " + extractFunction(source, "collectEngineFirstCandidates");
const selectClosestFn = "export " + extractFunction(source, "selectClosestCandidate");
const cashConversionInputInterface = "export " + extractInterface(source, "CashConversionInput");
const cashIntentConst = "export " + extractConst(source, "CASH_CONVERSION_INTENT_RE");
const cashRateOverrideConst = "export " + extractConst(source, "CASH_RATE_OVERRIDE_RE");
const parseCashRateFn = "export " + extractFunction(source, "parseCashRateOverride");
const resolvedCashContextInterface = "export " + extractInterface(source, "ResolvedCashContext");
const resolveCashContextFn = "export " + extractFunction(source, "resolveCashConversionContext");
const balaoOnlyExclusionConst = "export " + extractConst(source, "BALAO_ONLY_EXCLUSION_RE");
const allCommercialOptionsConst = "export " + extractConst(source, "ALL_COMMERCIAL_OPTIONS_RE");
const bareTermOverrideConst = "export " + extractConst(source, "BARE_TERM_OVERRIDE_RE");
const novosPrazosConst = "export " + extractConst(source, "NOVOS_PRAZOS");
const seminovosPrazosConst = "export " + extractConst(source, "SEMINOVOS_PRAZOS");
const simPrazosForFn = "export " + extractFunction(source, "simPrazosFor");
const requiredDownPaymentPlanInterface = "export " + extractInterface(source, "RequiredDownPaymentPlan");
const extractCommercialOverridesFn = "export " + extractFunction(source, "extractCommercialOverrides");
const extractTermMonthsListFn = "export " + extractFunction(source, "extractTermMonthsList");
const resolveTermMonthsListFn = "export " + extractFunction(source, "resolveTermMonthsList");
const extractRequiredDownPaymentPlanFn = "export " + extractFunction(source, "extractRequiredDownPaymentPlan");
const resolveStatefulRequiredDownPaymentPlanFn = "export " + extractFunction(source, "resolveStatefulRequiredDownPaymentPlan");
const buildRequiredDownPaymentSimulationInputsFn = "export " + extractFunction(source, "buildRequiredDownPaymentSimulationInputs");
const buildCommercialSelectionInputsFn = "export " + extractFunction(source, "buildCommercialSelectionInputs");
const commercialProposalInterface = "export " + extractInterface(source, "CommercialProposal");
const selectCommercialProposalsFn = "export " + extractFunction(source, "selectCommercialProposals");
// IA-CAPLOCK5 -- extractRequiredDownPaymentPlan/resolveStatefulRequiredDownPaymentPlan
// also call extractBalloonCountConstraint (a real dependency this file's
// own extraction had never actually needed until now).
const balloonCountMaxReConst = "export " + extractConst(source, "BALLOON_COUNT_MAX_RE");
const balloonCountExactReConst = "export " + extractConst(source, "BALLOON_COUNT_EXACT_RE");
const extractBalloonCountConstraintFn = "export " + extractFunction(source, "extractBalloonCountConstraint");
// IA-CAPLOCK7 -- resolveStatefulFinancePlan/resolveStatefulRequiredDownPaymentPlan
// now also check isFinanceExplanationOnly (a new real dependency).
const financeExplanationOnlyReConst = "export " + extractConst(source, "FINANCE_EXPLANATION_ONLY_RE");
const financeExplicitMutationVerbReConst = "export " + extractConst(source, "FINANCE_EXPLICIT_MUTATION_VERB_RE");
const isFinanceExplanationOnlyFn = "export " + extractFunction(source, "isFinanceExplanationOnly");
// timedEvaluateToolPolicy is a closure DEFINED INSIDE the request handler
// (not module-level) -- extractFunctionGenericAware's marker now tolerates
// indentation so it can find it there.
const timedEvaluateToolPolicyFn = extractFunctionGenericAware(source, "timedEvaluateToolPolicy");

const extractorModText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  simDepartmentType, simulationModeType, simFinancingTypeType, simulationInputInterface,
  round2Fn, brMoneyTokenConst, vehicleValueReConst, parseBRMoneyTokenFn, maskSpanFn, extractPlanFn, emptySimulationInputFn, buildInputsFn,
  allowReConst, denyReConst, classifyFn,
  clientBoundaryConst, linearOnlyExclusionConst, resolveStatefulPlanFn, applyLinearOnlyExclusionFn,
  engineFirstCandidateInterface, collectCandidatesFn, selectClosestFn,
  cashConversionInputInterface, cashIntentConst, cashRateOverrideConst, parseCashRateFn, resolvedCashContextInterface, resolveCashContextFn,
  balaoOnlyExclusionConst, allCommercialOptionsConst, bareTermOverrideConst, novosPrazosConst, seminovosPrazosConst, simPrazosForFn,
  requiredDownPaymentPlanInterface, extractCommercialOverridesFn, extractTermMonthsListFn, resolveTermMonthsListFn,
  extractRequiredDownPaymentPlanFn, resolveStatefulRequiredDownPaymentPlanFn,
  buildRequiredDownPaymentSimulationInputsFn, buildCommercialSelectionInputsFn, commercialProposalInterface, selectCommercialProposalsFn,
  balloonCountMaxReConst, balloonCountExactReConst, extractBalloonCountConstraintFn,
  financeExplanationOnlyReConst, financeExplicitMutationVerbReConst, isFinanceExplanationOnlyFn,
].join("\n\n");

const tmpDir1 = mkdtempSync(join(tmpdir(), "ia-recon-efirst-extractor-"));
const extractorPath = join(tmpDir1, "extracted.ts");
writeFileSync(extractorPath, extractorModText, "utf8");
const extractorMod = await import("file://" + extractorPath.replace(/\\/g, "/"));
const {
  extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs, classifyFinanceFastPath, parseBRMoneyToken,
  resolveStatefulFinancePlan, resolveCashConversionContext, collectEngineFirstCandidates, selectClosestCandidate,
  resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
} = extractorMod;

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
{
  // IA-3K.3 -- this used to be an "insufficient data" null case (no
  // "0 km"/"seminovo" signal at all). A real UAT defect confirmed
  // this exact shape of message (no department word anywhere) should
  // NOT block a recommendation -- department now defaults to NOVOS
  // in the absence of any Seminovo/usado signal, the same default
  // already used elsewhere in this file (emptySimulationInput).
  const msg = "Cliente comprando um carro de R$ 180.000, com entrada de R$ 90.000. Qual estrutura recomenda?";
  const plan = extractFinanceEngineFirstPlan(msg);
  check("[item 7] no department signal -- now defaults to NOVOS, never blocks (IA-3K.3)", plan !== null, plan);
  if (plan) check("[item 7] defaulted department = NOVOS", plan.department === "NOVOS", plan.department);
}
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

// IA-CAPLOCK3 -- the gate declarations now start at cashContext (IA-
// REGRESSION-01) and run through requiredDownPaymentPlan (IA-UAT-04)
// before engineFirstRan is declared -- the old single-line
// `const engineFirstPlan = isFinanceFastPath ? extractFinanceEngineFirstPlan(message) : null;`
// this test used to look for no longer exists anywhere in current
// source (superseded by `(!cashContext && isFinanceFastPath) ?
// resolveStatefulFinancePlan(...)`), which is exactly why this test
// was throwing "engineFirstPlan gate declaration not found" -- its own
// marker string had drifted out of existence. Extracted verbatim, the
// same way stateful-orchestration-integration.test.mjs (IA-REGRESSION-01's
// own harness) already does.
const gateMarker = "const cashContext = resolveCashConversionContext(conversation, message);";
const gateStart = source.indexOf(gateMarker, declEnd);
if (gateStart === -1) throw new Error("cashContext gate declaration not found");
const engineFirstRanMarker = "let engineFirstRan = false;";
const gateEnd = source.indexOf(engineFirstRanMarker, gateStart) + engineFirstRanMarker.length;
const gateDeclarations = source.slice(gateStart, gateEnd);
check("gate declarations include the real cashContext computation", gateDeclarations.includes(gateMarker));
check("gate declarations include the real engineFirstPlan computation (gated on !cashContext)", gateDeclarations.includes("const engineFirstPlan = (!cashContext && isFinanceFastPath) ? resolveStatefulFinancePlan(conversation, message) : null;"));
check("gate declarations include the real engineFirstRan flag", gateDeclarations.includes(engineFirstRanMarker));

// IA-CAPLOCK3 -- THREE real sibling blocks now sit in this region, not
// two: Cash Conversion (blockCash) and requiredDownPaymentPlan
// (blockRDP) were both added to production after this file was first
// written. Extracting only blockA/blockB (as before) would silently
// skip blockCash/blockRDP's own real content -- both are extracted
// here too so the harness is a faithful copy of ALL of current
// production's orchestration in this region, not just the two
// branches this file originally knew about.
const blockCash = extractBalancedFrom(source, "if (cashContext) {", gateEnd);
check("extracted Cash Conversion block contains the real deterministic baseline + cash dispatch", blockCash.text.includes("toolSimularCashConversion(userClient, cashArgs)") && blockCash.text.includes("toolSimularFinanciamento(userClient, baselineInput)"));
const blockA = extractBalancedFrom(source, "if (!engineFirstRan && engineFirstPlan) {", blockCash.end);
check("extracted engine-first block contains the real extractFinanceEngineFirstPlan-driven flow marker", blockA.text.includes("buildEngineFirstSimulationInputs(engineFirstPlan)"));
const blockRDP = extractBalancedFrom(source, "if (!engineFirstRan && requiredDownPaymentPlan) {", blockA.end);
check("extracted requiredDownPaymentPlan block contains the real commercial-selection dispatch", blockRDP.text.includes("buildCommercialSelectionInputs(requiredDownPaymentPlan)") && blockRDP.text.includes("buildRequiredDownPaymentSimulationInputs(requiredDownPaymentPlan)"));
const blockB = extractBalancedFrom(source, "if (!engineFirstRan) {", blockRDP.end);
check("extracted fallback block contains the real unmodified while(true) loop", blockB.text.includes("while (true) {") && blockB.text.includes("await callOpenAI(openaiKey, input, passTools, 0, retryTracker)"));

const toolErrorClass = extractClass(source, "ToolError");
const maxToolCallsConst = "export " + extractConst(source, "MAX_TOOL_CALLS");
const openaiModelConst = "export " + extractConst(source, "OPENAI_MODEL");
const overallTimeoutConst = "export " + extractConst(source, "OVERALL_TIMEOUT_MS");
const extractFunctionCallsFn = "export " + extractFunctionGenericAware(source, "extractFunctionCalls");
const extractOutputTextFn = "export " + extractFunction(source, "extractOutputText");
// IA-3J.6 -- the real FINANCE_SYNTHESIS_PROFILE, reconstructed from
// its own real `[A, B, ...].join(SEP)` composition (never a hand-typed
// copy) so the mocked execution below rebuilds input[0].content from
// the SAME text production actually ships.
const financeSynthesisProfileConst = "export const FINANCE_SYNTHESIS_PROFILE = " + JSON.stringify(extractComposedPrompt(source, "FINANCE_SYNTHESIS_PROFILE")) + ";";

const harnessModText = `// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.
${toolErrorClass}

${maxToolCallsConst}

${openaiModelConst}

${overallTimeoutConst}

${extractFunctionCallsFn}

${extractOutputTextFn}

${financeSynthesisProfileConst}

${linearOnlyExclusionConst}

${balaoOnlyExclusionConst}

${allCommercialOptionsConst}

${bareTermOverrideConst}

export async function runRequestLoop(opts) {
  const {
    isFinanceFastPath, message, conversation, effectiveTools, effectiveSystemPrompt, dynamicContextSuffix,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    resolveCashConversionContext, resolveStatefulFinancePlan, collectEngineFirstCandidates, selectClosestCandidate,
    resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
    callOpenAI, toolSimularFinanciamento, toolSimularCashConversion, evaluateToolPolicy, buildBlockFromToolResult, dispatchTool,
    input, emptySimulationInput,
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
    openai_retry_count_per_pass: [],
  };
  let promptProfileLabel = isFinanceFastPath ? "finance" : "full";
  let promptCharsActual = effectiveSystemPrompt.length;

  ${timedEvaluateToolPolicyFn}

  ${preDeclarations}

  ${gateDeclarations}

  ${blockCash.text}

  ${blockA.text}

  ${blockRDP.text}

  ${blockB.text}

  timings.openai_pass_count = timings.openai_pass_ms.length;
  return { finalText, timings, blocks, toolsUsed, toolCallCount, homologCalls, engineFirstRan, promptProfileLabel, promptCharsActual, cashContext, requiredDownPaymentPlan };
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

  const mockEffectiveSystemPrompt = "X".repeat(44341); // stand-in for FINANCE_PROMPT_PROFILE's real runtime length -- never used by engine-first, only its .length matters as the PRE-override baseline
  const mockDynamicContextSuffix = "\n\n=== CONTEXTO TEMPORAL (mock) ===";
  const result = await runRequestLoop({
    isFinanceFastPath: true,
    message: CANONICAL_TEST_1,
    conversation: [],
    effectiveTools: FINANCE_TOOLS,
    effectiveSystemPrompt: mockEffectiveSystemPrompt,
    dynamicContextSuffix: mockDynamicContextSuffix,
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    resolveCashConversionContext, resolveStatefulFinancePlan, collectEngineFirstCandidates, selectClosestCandidate,
    resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
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
  check("[E1] canonical flow: prompt_profile overridden to finance_synthesis", result.promptProfileLabel === "finance_synthesis", result.promptProfileLabel);
  check("[E1] canonical flow: prompt_chars reflects the REAL FINANCE_SYNTHESIS_PROFILE length, never the pre-override mock baseline", result.promptCharsActual > 0 && result.promptCharsActual !== mockEffectiveSystemPrompt.length, result.promptCharsActual);
}

// ---------- E1b. the synthesis call's actual input[0].content is built from FINANCE_SYNTHESIS_PROFILE, never effectiveSystemPrompt ----------
{
  const FINANCE_TOOLS = [{ type: "function", name: "simular_financiamento" }, { type: "function", name: "iniciar_novo_cliente" }];
  let capturedInput = null;
  const callOpenAI = async (_key, input) => { capturedInput = input; return mkResponse({ text: "ok" }); };
  const toolSimularFinanciamento = async (_userClient, args) => (args.financing_type === "BALAO"
    ? { financing_type: "BALAO", results: [{ term_months: 30, monthly_payment: 1766.94 }] }
    : { mode: "payment", results: [{ term_months: 60, payment: 2984.38 }] });
  const evaluateToolPolicy = async () => ({ allowed: true });
  const buildBlockFromToolResult = () => null;
  const mockEffectiveSystemPrompt = "THIS-IS-THE-OLD-FAST-PATH-PROMPT-NEVER-SENT-BY-ENGINE-FIRST";

  await runRequestLoop({
    isFinanceFastPath: true,
    message: CANONICAL_TEST_1,
    conversation: [],
    effectiveTools: FINANCE_TOOLS,
    effectiveSystemPrompt: mockEffectiveSystemPrompt,
    dynamicContextSuffix: "\n\n=== CONTEXTO TEMPORAL (mock) ===",
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    resolveCashConversionContext, resolveStatefulFinancePlan, collectEngineFirstCandidates, selectClosestCandidate,
    resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: mockEffectiveSystemPrompt }, { role: "user", content: CANONICAL_TEST_1 }],
  });

  check("[E1b] synthesis call's input[0].content does NOT contain the old fast-path prompt text", !capturedInput[0].content.includes("THIS-IS-THE-OLD-FAST-PATH-PROMPT-NEVER-SENT-BY-ENGINE-FIRST"));
  check("[E1b] synthesis call's input[0].content contains real FINANCE_SYNTHESIS_PROFILE content (Síntese Financeira header)", capturedInput[0].content.includes("Síntese Financeira"));
  check("[E1b] synthesis call's input[0].content contains the canonical results block label", capturedInput[0].content.includes("RESULTADOS DE SIMULAÇÃO FINANCEIRA"));
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
  const mockEffectiveSystemPrompt = "MOCK-FINANCE-PROMPT-PROFILE";
  const result = await runRequestLoop({
    isFinanceFastPath: true,
    message: ambiguousMessage,
    conversation: [],
    effectiveTools: FINANCE_TOOLS,
    effectiveSystemPrompt: mockEffectiveSystemPrompt,
    dynamicContextSuffix: "\n\n=== CONTEXTO TEMPORAL (mock) ===",
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    resolveCashConversionContext, resolveStatefulFinancePlan, collectEngineFirstCandidates, selectClosestCandidate,
    resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult, dispatchTool,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: ambiguousMessage }],
  });

  check("[E2] insufficient-data message: engineFirstRan = false (fell back)", result.engineFirstRan === false);
  check("[E2] insufficient-data message: execution_path = openai_tool_loop", result.timings.execution_path === "openai_tool_loop", result.timings.execution_path);
  check("[E2] insufficient-data message: old loop ran as normal (2 passes, tool actually dispatched via the normal path)", openaiCalls.length === 2 && simulateCalled === true, { openaiCalls, simulateCalled });
  check("[E2] insufficient-data message: Pass 1 received the full fast-path tool set (2), never narrowed by engine-first logic", openaiCalls[0] === 2, openaiCalls);
  check("[E2] insufficient-data message: prompt_profile stays 'finance' (fallback never overrides to finance_synthesis)", result.promptProfileLabel === "finance", result.promptProfileLabel);
  check("[E2] insufficient-data message: prompt_chars stays the fallback's own FINANCE_PROMPT_PROFILE length, never FINANCE_SYNTHESIS_PROFILE's", result.promptCharsActual === mockEffectiveSystemPrompt.length, result.promptCharsActual);
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
    conversation: [],
    effectiveTools: FINANCE_TOOLS,
    effectiveSystemPrompt: "MOCK-FINANCE-PROMPT-PROFILE",
    dynamicContextSuffix: "\n\n=== CONTEXTO TEMPORAL (mock) ===",
    extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs,
    resolveCashConversionContext, resolveStatefulFinancePlan, collectEngineFirstCandidates, selectClosestCandidate,
    resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs, selectCommercialProposals,
    callOpenAI, toolSimularFinanciamento, evaluateToolPolicy, buildBlockFromToolResult,
    input: [{ role: "developer", content: "mock finance prompt" }, { role: "user", content: CANONICAL_TEST_1 }],
  });

  check("[E3] denied authorization: engineFirstRan = false (fell back, never fabricated a denial itself)", result.engineFirstRan === false);
  check("[E3] denied authorization: toolSimularFinanciamento was NEVER called during the engine-first attempt (denial short-circuits before dispatch)", simulateCalledDuringEngineFirst === false);
  check("[E3] denied authorization: execution_path = openai_tool_loop (fell through to the existing, already-tested denial path)", result.timings.execution_path === "openai_tool_loop");
}

// ---------- F. full-profile requests are never eligible for engine-first (structural, not just by convention) ----------

// IA-CAPLOCK3 -- the gate's exact text evolved with IA-REGRESSION-01
// (gated on !cashContext too) and now calls resolveStatefulFinancePlan
// instead of extractFinanceEngineFirstPlan directly (see gateDeclarations
// above) -- isFinanceFastPath is still structurally required either way,
// this check just needed the current real text.
check("engine-first gate in source requires isFinanceFastPath (full-profile requests structurally excluded)", source.includes("const engineFirstPlan = (!cashContext && isFinanceFastPath) ? resolveStatefulFinancePlan(conversation, message) : null;"));

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
// IA-CAPLOCK3 -- LATENCY-1 wrapped every evaluateToolPolicy call site in
// timedEvaluateToolPolicy (a thin timing wrapper, zero effect on the
// authorization decision itself -- see its own declaration) -- the
// literal call text changed, the authority it calls (evaluateToolPolicy,
// unmodified, called with the exact same 4 args) did not.
check("engine-first calls the SAME evaluateToolPolicy authorization gate the existing loop uses (never bypassed, now via the timedEvaluateToolPolicy wrapper)", source.includes('timedEvaluateToolPolicy("simular_financiamento", simArgs, authorityEnvelope, checkModulePermission)'));
check("FULL_SYSTEM_PROMPT composition untouched by this Wave (IA-3J.6)", /const FULL_SYSTEM_PROMPT = \[/.test(source));
check("FINANCE_PROMPT_PROFILE composition untouched by this Wave (IA-3J.6) -- the fallback loop's own profile, never the synthesis one", /const FINANCE_PROMPT_PROFILE = \[/.test(source));

// ---------- H. IA-3J.6: FINANCE_SYNTHESIS_PROFILE exists, is composed from real canonical blocks, and is significantly smaller ----------
{
  check("FINANCE_SYNTHESIS_PROFILE is declared exactly once", [...source.matchAll(/const FINANCE_SYNTHESIS_PROFILE = \[/g)].length === 1);
  check("FINANCE_SYNTHESIS_PROFILE composes PROMPT_CORE_GLOBAL (identity/PII/anti-fabrication)", /const FINANCE_SYNTHESIS_PROFILE = \[[\s\S]*?PROMPT_CORE_GLOBAL,/.test(source));
  check("FINANCE_SYNTHESIS_PROFILE composes PROMPT_COMMERCIAL_ORCHESTRATION (recommendation/comparison framing, no fabricated scores)", /const FINANCE_SYNTHESIS_PROFILE = \[[\s\S]*?PROMPT_COMMERCIAL_ORCHESTRATION,/.test(source));
  check("FINANCE_SYNTHESIS_PROFILE composes PROMPT_SHARED_CONVERSATION (Executive First, Detail on Demand, numeric fidelity in prose)", /const FINANCE_SYNTHESIS_PROFILE = \[[\s\S]*?PROMPT_SHARED_CONVERSATION,/.test(source));
  check("FINANCE_SYNTHESIS_PROFILE does NOT carry PROMPT_FINANCE_BASE/PROMPT_FINANCE_BALLOON/PROMPT_FINANCE_COMPARISON (pure tool-planning content, not needed post-calculation)", (() => {
    const m = /const FINANCE_SYNTHESIS_PROFILE = \[([\s\S]*?)\]\.join/.exec(source);
    return m && !/PROMPT_FINANCE_BASE,|PROMPT_FINANCE_BALLOON,|PROMPT_FINANCE_COMPARISON,/.test(m[1]);
  })());
  check("FINANCE_SYNTHESIS_PROFILE does NOT carry PROMPT_NEW_CLIENT_RESET (pure tool-call semantics, moot with tools=[])", (() => {
    const m = /const FINANCE_SYNTHESIS_PROFILE = \[([\s\S]*?)\]\.join/.exec(source);
    return m && !/PROMPT_NEW_CLIENT_RESET/.test(m[1]);
  })());

  // Real runtime measurement (never the source-text/CRLF-inflated
  // figure -- see IA-3J.4J.2's own forensic) of both profiles, via
  // the SAME extractComposedPrompt reconstruction already used above
  // for the mocked-execution harness's FINANCE_SYNTHESIS_PROFILE.
  const realFinancePromptProfile = extractComposedPrompt(source, "FINANCE_PROMPT_PROFILE");
  const realFinanceSynthesisProfile = extractComposedPrompt(source, "FINANCE_SYNTHESIS_PROFILE");
  check("FINANCE_SYNTHESIS_PROFILE is significantly smaller than FINANCE_PROMPT_PROFILE (source-text measurement; runtime authority confirmed separately, see report)", realFinanceSynthesisProfile.length < realFinancePromptProfile.length * 0.5, { synthesis: realFinanceSynthesisProfile.length, finance: realFinancePromptProfile.length });
}

console.log(`\n=== Finance Engine-First Tests (IA-3J.5): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
if (fail > 0) process.exit(1);

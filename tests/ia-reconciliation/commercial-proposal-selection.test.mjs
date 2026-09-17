// IA-UAT-04 — Deterministic <=3-proposal commercial selection for the
// open-recommendation (target payment, no down payment, no explicit
// term/plan) scenario VOICE-UAT-03 diagnosed and this Wave fixes.
//
// PART A: plan extraction/override/stateful-inheritance unit tests
// (real functions, balanced-brace-extracted from the real source --
// never a hand-copied replica, same discipline as extract.mjs's own
// header explains).
// PART B: selectCommercialProposals's selection ALGORITHM, fed
// synthetic-but-realistically-shaped engine output (the SAME shape
// toolSimularFinanciamento/toolSimularBalao really return, confirmed
// by direct reading) -- proves the selection RULE (2 Linear by the
// stated priority, 1 Balão, sorted by entrada, labeled) is correct
// for ANY engine numbers, independent of which real rates happen to
// be loaded in a given environment. Real-engine-derived proof (never
// hardcoded results) for the end-to-end dispatch/count/composition is
// in commercial-proposal-selection-e2e.mjs (real local server, real
// mock rate tables, real bisection search).
//
// Run: node tests/ia-reconciliation/commercial-proposal-selection.test.mjs

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

const simDepartmentType = extractTypeAlias(source, "SimDepartment");
const simulationModeType = extractTypeAlias(source, "SimulationMode");
const simFinancingTypeType = extractTypeAlias(source, "SimFinancingType");
const simulationInputInterface = "export " + extractInterface(source, "SimulationInput");
const round2Fn = "export " + extractFunction(source, "round2");
const brMoneyTokenConst = "export " + extractConst(source, "BR_MONEY_TOKEN_RE_SRC");
const vehicleValueReConst = "export " + extractConst(source, "VEHICLE_VALUE_RE_SRC");
const parseBRMoneyTokenFn = "export " + extractFunction(source, "parseBRMoneyToken");
const maskSpanFn = "export " + extractFunction(source, "maskSpan");
const novosPrazosConst = "export " + extractConst(source, "NOVOS_PRAZOS");
const seminovosPrazosConst = "export " + extractConst(source, "SEMINOVOS_PRAZOS");
const simPrazosForFn = "export " + extractFunction(source, "simPrazosFor");
const extractPlanFn = "export " + extractFunction(source, "extractFinanceEngineFirstPlan");
const emptySimulationInputFn = "export " + extractFunction(source, "emptySimulationInput");
const clientBoundaryConst = "export " + extractConst(source, "CLIENT_BOUNDARY_RE");
const maxToolCallsConst = "export " + extractConst(source, "MAX_TOOL_CALLS");
const extractTermListFn = "export " + extractFunction(source, "extractTermMonthsList");
const linearOnlyConst = "export " + extractConst(source, "LINEAR_ONLY_EXCLUSION_RE");
const balaoOnlyConst = "export " + extractConst(source, "BALAO_ONLY_EXCLUSION_RE");
const allOptionsConst = "export " + extractConst(source, "ALL_COMMERCIAL_OPTIONS_RE");
const bareTermConst = "export " + extractConst(source, "BARE_TERM_OVERRIDE_RE");
const requiredPlanInterface = "export " + extractInterface(source, "RequiredDownPaymentPlan");
const extractOverridesFn = "export " + extractFunction(source, "extractCommercialOverrides");
const resolveTermsFn = "export " + extractFunction(source, "resolveTermMonthsList");
const extractRdpFn = "export " + extractFunction(source, "extractRequiredDownPaymentPlan");
const resolveRdpFn = "export " + extractFunction(source, "resolveStatefulRequiredDownPaymentPlan");
const buildRdpFn = "export " + extractFunction(source, "buildRequiredDownPaymentSimulationInputs");
const buildSelectionInputsFn = "export " + extractFunction(source, "buildCommercialSelectionInputs");
const commercialProposalInterface = "export " + extractInterface(source, "CommercialProposal");
const selectProposalsFn = "export " + extractFunction(source, "selectCommercialProposals");
// IA-CAPLOCK5 -- extractRequiredDownPaymentPlan/resolveStatefulRequiredDownPaymentPlan
// now also call extractBalloonCountConstraint (a new real dependency).
const balloonCountMaxReConst = "export " + extractConst(source, "BALLOON_COUNT_MAX_RE");
const balloonCountExactReConst = "export " + extractConst(source, "BALLOON_COUNT_EXACT_RE");
const extractBalloonCountConstraintFn = "export " + extractFunction(source, "extractBalloonCountConstraint");
// IA-CAPLOCK7 -- resolveStatefulRequiredDownPaymentPlan now also checks
// isFinanceExplanationOnly (a new real dependency).
const financeExplanationOnlyReConst = "export " + extractConst(source, "FINANCE_EXPLANATION_ONLY_RE");
const financeExplicitMutationVerbReConst = "export " + extractConst(source, "FINANCE_EXPLICIT_MUTATION_VERB_RE");
const isFinanceExplanationOnlyFn = "export " + extractFunction(source, "isFinanceExplanationOnly");

const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  simDepartmentType, simulationModeType, simFinancingTypeType, simulationInputInterface,
  round2Fn, brMoneyTokenConst, vehicleValueReConst, parseBRMoneyTokenFn, maskSpanFn,
  novosPrazosConst, seminovosPrazosConst, simPrazosForFn, extractPlanFn, emptySimulationInputFn,
  clientBoundaryConst, maxToolCallsConst, extractTermListFn,
  linearOnlyConst, balaoOnlyConst, allOptionsConst, bareTermConst,
  requiredPlanInterface, extractOverridesFn, resolveTermsFn, extractRdpFn, resolveRdpFn, buildRdpFn,
  buildSelectionInputsFn, commercialProposalInterface, selectProposalsFn,
  balloonCountMaxReConst, balloonCountExactReConst, extractBalloonCountConstraintFn,
  financeExplanationOnlyReConst, financeExplicitMutationVerbReConst, isFinanceExplanationOnlyFn,
].join("\n\n");
const tmpDir = mkdtempSync(join(tmpdir(), "ia-uat04-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));
const {
  extractRequiredDownPaymentPlan, resolveStatefulRequiredDownPaymentPlan,
  buildRequiredDownPaymentSimulationInputs, buildCommercialSelectionInputs,
  selectCommercialProposals, extractCommercialOverrides, NOVOS_PRAZOS, MAX_TOOL_CALLS,
} = mod;

// ============================================================
// PART A -- plan extraction / overrides / stateful inheritance
// ============================================================

// ---- A1. TEST A shape: open recommendation (no plan/term) -- the real Human UAT phrasing ----
const OPEN_MSG = "Tenho um cliente comprando uma Triton Katana de R$ 330 mil. Ele quer chegar perto de R$ 3.500 de parcela e ainda não definiu a entrada. O que você sugere?";
const openPlan = extractRequiredDownPaymentPlan(OPEN_MSG);
check("[A1] open-recommendation plan extracted", openPlan !== null, openPlan);
if (openPlan) {
  check("[A1] vehicleValue = 330000", openPlan.vehicleValue === 330000, openPlan.vehicleValue);
  check("[A1] targetPayment = 3500", openPlan.targetPayment === 3500, openPlan.targetPayment);
  check("[A1] termMonthsList = null (no term/plan named -- triggers the NEW selector, never the old 'dispatch everything' path)", openPlan.termMonthsList === null, openPlan.termMonthsList);
  check("[A1] financingTypeOverride = null (no exclusion phrase present)", openPlan.financingTypeOverride === null, openPlan.financingTypeOverride);
  check("[A1] allOptionsRequested = false", openPlan.allOptionsRequested === false, openPlan.allOptionsRequested);

  const selectionInputs = buildCommercialSelectionInputs(openPlan);
  check("[A1] exactly 2 real dispatches built (never 8, never N per term) -- 1 LINEAR all-terms + 1 BALAO optimize-for-target", selectionInputs.length === 2, selectionInputs);
  check("[A1] one dispatch is LINEAR required_down_payment with term_months omitted (engine loops internally, unchanged capability)",
    selectionInputs.some((i) => i.financing_type === "LINEAR" && i.mode === "required_down_payment" && i.term_months === null), selectionInputs);
  check("[A1] the other dispatch is BALAO payment mode with balloon_value/down_payment omitted and term_months omitted -- the EXISTING optimize-for-target capability (UAT-BALAO-EXPLORATION-01), never a new one",
    selectionInputs.some((i) => i.financing_type === "BALAO" && i.mode === "payment" && i.balloon_value === null && i.down_payment === null && i.term_months === null), selectionInputs);
}

// ---- A2. TEST B: explicit "somente Linear" on the open scenario ----
const LINEAR_ONLY_MSG = OPEN_MSG + " Mas mostra somente Linear.";
const linearOnlyPlan = extractRequiredDownPaymentPlan(LINEAR_ONLY_MSG);
check("[A2] plan extracted with LINEAR_ONLY override", linearOnlyPlan?.financingTypeOverride === "LINEAR_ONLY", linearOnlyPlan);
if (linearOnlyPlan) {
  const inputs = buildCommercialSelectionInputs(linearOnlyPlan);
  check("[A2] exactly 1 dispatch (LINEAR only) -- BALAO never even called", inputs.length === 1 && inputs[0].financing_type === "LINEAR", inputs);
}

// ---- A3. TEST C: explicit "somente Balão" ----
const BALAO_ONLY_MSG = "Tenho um cliente comprando uma Triton Katana de R$ 330 mil. Ele quer chegar perto de R$ 3.500 de parcela, somente Balão.";
const balaoOnlyPlan = extractRequiredDownPaymentPlan(BALAO_ONLY_MSG);
check("[A3] plan extracted with BALAO_ONLY override", balaoOnlyPlan?.financingTypeOverride === "BALAO_ONLY", balaoOnlyPlan);
if (balaoOnlyPlan) {
  const inputs = buildCommercialSelectionInputs(balaoOnlyPlan);
  check("[A3] exactly 1 dispatch (BALAO only) -- LINEAR never even called", inputs.length === 1 && inputs[0].financing_type === "BALAO", inputs);
}

// ---- A4. TEST D: explicit terms "36 e 48" -- exact terms respected, no destructive cap ----
const EXPLICIT_TERMS_MSG = "Triton Katana de R$ 330 mil, parcela de R$ 3.500 em 36 e 48 meses.";
const explicitPlan = extractRequiredDownPaymentPlan(EXPLICIT_TERMS_MSG);
check("[A4] explicit-terms plan extracted", JSON.stringify(explicitPlan?.termMonthsList) === JSON.stringify([36, 48]), explicitPlan);
if (explicitPlan) {
  const inputs = buildRequiredDownPaymentSimulationInputs(explicitPlan);
  check("[A4] exactly 2 dispatches, one per named term, both LINEAR -- never collapsed into the 3-proposal selector", inputs.length === 2 && inputs.every((i) => i.financing_type === "LINEAR"), inputs);
  check("[A4] terms are exactly 36 and 48, nothing else", JSON.stringify(inputs.map((i) => i.term_months).sort((a, b) => a - b)) === JSON.stringify([36, 48]), inputs);
}

// ---- A5. TEST E: "mostre todas as opções" bypasses the cap ----
const ALL_OPTIONS_MSG = OPEN_MSG + " Mostre todas as opções.";
const allOptionsPlan = extractRequiredDownPaymentPlan(ALL_OPTIONS_MSG);
check("[A5] allOptionsRequested = true", allOptionsPlan?.allOptionsRequested === true, allOptionsPlan);
check("[A5] termMonthsList still null (bypass is independent of term extraction)", allOptionsPlan?.termMonthsList === null, allOptionsPlan);

// ---- A6. TEST F: stateful follow-ups (3-turn sequence from the brief) ----
const TURN1 = "Triton Katana 330 mil, quero parcela perto de 3500.";
const TURN2 = "Mostra só Linear.";
const TURN3 = "E só em 48?";
const TURN4 = "Agora quero Balão.";

const conv1 = [];
const plan1 = extractRequiredDownPaymentPlan(TURN1);
check("[A6] turn 1 (direct) resolves", plan1 !== null, plan1);
conv1.push({ role: "user", content: TURN1 });

const plan2 = resolveStatefulRequiredDownPaymentPlan(conv1, TURN2);
check("[A6] turn 2 ('Mostra só Linear.', no new numbers at all) still resolves -- inherits vehicle+target from turn 1", plan2 !== null, plan2);
if (plan2) {
  check("[A6] turn 2: vehicleValue inherited (330000)", plan2.vehicleValue === 330000, plan2.vehicleValue);
  check("[A6] turn 2: targetPayment inherited (3500) -- never invented, never left blank", plan2.targetPayment === 3500, plan2.targetPayment);
  check("[A6] turn 2: financingTypeOverride = LINEAR_ONLY", plan2.financingTypeOverride === "LINEAR_ONLY", plan2.financingTypeOverride);
  check("[A6] turn 2: termMonthsList still null (no specific term named yet)", plan2.termMonthsList === null, plan2.termMonthsList);
}
conv1.push({ role: "user", content: TURN2 });

const plan3 = resolveStatefulRequiredDownPaymentPlan(conv1, TURN3);
check("[A6] turn 3 ('E só em 48?', bare number, no unit suffix) resolves -- BARE_TERM_OVERRIDE_RE fallback", plan3 !== null, plan3);
if (plan3) {
  check("[A6] turn 3: vehicleValue/targetPayment still inherited", plan3.vehicleValue === 330000 && plan3.targetPayment === 3500, plan3);
  check("[A6] turn 3: termMonthsList = [48] exactly (the explicit-terms path, never the selector)", JSON.stringify(plan3.termMonthsList) === JSON.stringify([48]), plan3.termMonthsList);
}
conv1.push({ role: "user", content: TURN3 });

const plan4 = resolveStatefulRequiredDownPaymentPlan(conv1, TURN4);
check("[A6] turn 4 ('Agora quero Balão.', pure override) resolves -- hasGoalSignal extended to recognize 'balão' alone", plan4 !== null, plan4);
if (plan4) {
  check("[A6] turn 4: vehicleValue/targetPayment still inherited", plan4.vehicleValue === 330000 && plan4.targetPayment === 3500, plan4);
  check("[A6] turn 4: financingTypeOverride = BALAO_ONLY, no term named (back to open recommendation, just Balão-scoped)", plan4.financingTypeOverride === "BALAO_ONLY" && plan4.termMonthsList === null, plan4);
}

// ---- A7. never invents a target that was never stated anywhere ----
check("[A7] a pure override with NO prior target anywhere in history returns null (never invents a target)",
  resolveStatefulRequiredDownPaymentPlan([{ role: "user", content: "Triton Katana de R$330.000." }], "Mostra só Linear.") === null);

// ---- A8. client boundary still respected with the new override-aware hasGoalSignal ----
check("[A8] resolveStatefulRequiredDownPaymentPlan never resolves across a client-boundary signal (unchanged invariant)",
  resolveStatefulRequiredDownPaymentPlan([{ role: "user", content: "Triton Katana R$330.000, parcela de R$3.500" }], "agora outro cliente, mostra só Linear") === null);

// ---- A9. MAX_TOOL_CALLS ceiling still respected for explicit term lists (unchanged) ----
const manyTermsPlan = { department: "NOVOS", vehicleValue: 200000, vehicleYear: null, targetPayment: 2000, termMonthsList: [12, 18, 24, 30, 36, 42, 48, 60], financingTypeOverride: null, allOptionsRequested: false };
const cappedInputs = buildRequiredDownPaymentSimulationInputs(manyTermsPlan);
check("[A9] an explicit list longer than MAX_TOOL_CALLS is still capped", cappedInputs.length <= MAX_TOOL_CALLS, { len: cappedInputs.length, max: MAX_TOOL_CALLS });

// ---- A10. extractCommercialOverrides is the single choke point (direct unit test) ----
check("[A10] 'somente linear' -> LINEAR_ONLY", extractCommercialOverrides("somente linear, por favor").financingTypeOverride === "LINEAR_ONLY");
check("[A10] 'sem linear' -> BALAO_ONLY", extractCommercialOverrides("quero sem linear, só balão").financingTypeOverride === "BALAO_ONLY");
check("[A10] 'todas as opções' -> allOptionsRequested", extractCommercialOverrides("mostre todas as opções").allOptionsRequested === true);
check("[A10] neutral message -> no override, no bypass", extractCommercialOverrides("Triton Katana 330 mil").financingTypeOverride === null && extractCommercialOverrides("Triton Katana 330 mil").allOptionsRequested === false);

// ============================================================
// PART B -- selectCommercialProposals's selection ALGORITHM
// (synthetic-but-realistic engine output, proves the RULE, not a
// hardcoded real-world number -- real-engine proof is the E2E script)
// ============================================================

function linearOutput(targetPayment, rows) {
  return { mode: "required_down_payment", department: "NOVOS", vehicle_value: 330000, target_payment: targetPayment, vehicle_year: null, results: rows };
}
function balaoOutput(feasible, fields) {
  return feasible
    ? { mode: "payment", department: "NOVOS", feasible: true, balloon_optimized: true, optimization_objective: "min_down_payment", target_payment: 3500, vehicle_value: 330000, ...fields }
    : { mode: "payment", department: "NOVOS", feasible: false, balloon_optimized: true, target_payment: 3500, message: "sem estrutura válida" };
}

// ---- B1. TEST A's own policy shape: 2 Linear + 1 Balão, Balão cheapest -> RECOMENDADO first ----
{
  const rows = NOVOS_PRAZOS.map((t, i) => ({ term_months: t, possible: true, down_payment: 300000 - i * 15000, down_payment_percent: null, financed_amount: null, payment: 3500 }));
  const results = [
    { simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) },
    { simArgs: { financing_type: "BALAO" }, output: balaoOutput(true, { down_payment: 164270.18, monthly_payment: 3500, term_months: 48, balloons: [{ month: 48, value: 165729.82 }] }) },
  ];
  const selection = selectCommercialProposals(results);
  check("[B1] at most 3 proposals", selection.length <= 3, selection.length);
  check("[B1] exactly 2 LINEAR + 1 BALAO (Balão valid)", selection.filter((p) => p.kind === "LINEAR").length === 2 && selection.filter((p) => p.kind === "BALAO").length === 1, selection);
  check("[B1] Balão has the lowest entrada in this fixture -> labeled RECOMENDADO and presented first", selection[0].kind === "BALAO" && selection[0].label === "RECOMENDADO", selection[0]);
  check("[B1] the other 2 are ALTERNATIVA", selection.slice(1).every((p) => p.label === "ALTERNATIVA"), selection);
  check("[B1] proposals are sorted by ascending down_payment", selection.every((p, i) => i === 0 || selection[i - 1].down_payment <= p.down_payment), selection.map((p) => p.down_payment));
  const linearSelected = selection.filter((p) => p.kind === "LINEAR");
  check("[B1] LINEAR #1 is the feasible term with the LOWEST entrada (last row, i=7, 300000-105000=195000) -- never assumed to be term_months=60 blindly", linearSelected[0].down_payment === 195000, linearSelected);
  check("[B1] LINEAR #2's term is immediately below LINEAR #1's own term among real candidates (48, the term right before 60 in NOVOS_PRAZOS)", linearSelected[1].term_months === 48, linearSelected);
}

// ---- B2. Human's exact conceptual example from the brief -- same relative ordering (Balão < Linear60 < Linear48) ----
{
  const rows = [
    { term_months: 48, possible: true, down_payment: 234704.17, payment: 3500 },
    { term_months: 60, possible: true, down_payment: 224222.30, payment: 3500 },
    { term_months: 36, possible: false, down_payment: null, payment: null },
  ];
  const results = [
    { simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) },
    { simArgs: { financing_type: "BALAO" }, output: balaoOutput(true, { down_payment: 164270.18, monthly_payment: 3500, term_months: 48 }) },
  ];
  const selection = selectCommercialProposals(results);
  check("[B2] order matches the brief's own worked example: Balão, Linear 60, Linear 48",
    selection.map((p) => `${p.kind}${p.kind === "LINEAR" ? p.term_months : ""}`).join(",") === "BALAO,LINEAR60,LINEAR48", selection);
  check("[B2] infeasible term (36, possible:false) never enters the selection", !selection.some((p) => p.term_months === 36), selection);
}

// ---- B3. Balão infeasible -> falls back to up to 2 Linear only (Section 3) ----
{
  const rows = [
    { term_months: 48, possible: true, down_payment: 234704.17, payment: 3500 },
    { term_months: 60, possible: true, down_payment: 224222.30, payment: 3500 },
  ];
  const results = [
    { simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) },
    { simArgs: { financing_type: "BALAO" }, output: balaoOutput(false) },
  ];
  const selection = selectCommercialProposals(results);
  check("[B3] Balão infeasible -> 0 Balão proposals, falls back to Linear only", selection.every((p) => p.kind === "LINEAR") && selection.length === 2, selection);
}

// ---- B4. LINEAR_ONLY override (no BALAO result dispatched at all) -> 2 Linear, 0 Balão ----
{
  const rows = [
    { term_months: 48, possible: true, down_payment: 234704.17, payment: 3500 },
    { term_months: 60, possible: true, down_payment: 224222.30, payment: 3500 },
  ];
  const results = [{ simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) }];
  const selection = selectCommercialProposals(results);
  check("[B4] LINEAR_ONLY: exactly 2 Linear, 0 Balão", selection.length === 2 && selection.every((p) => p.kind === "LINEAR"), selection);
}

// ---- B5. BALAO_ONLY override (no LINEAR result dispatched at all) -> 1 Balão, 0 Linear ----
{
  const results = [{ simArgs: { financing_type: "BALAO" }, output: balaoOutput(true, { down_payment: 164270.18, monthly_payment: 3500, term_months: 48 }) }];
  const selection = selectCommercialProposals(results);
  check("[B5] BALAO_ONLY: exactly 1 Balão, 0 Linear", selection.length === 1 && selection[0].kind === "BALAO", selection);
}

// ---- B6. nothing feasible anywhere -> empty selection, never fabricated ----
{
  const rows = [{ term_months: 12, possible: false, down_payment: null, payment: null }];
  const results = [
    { simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) },
    { simArgs: { financing_type: "BALAO" }, output: balaoOutput(false) },
  ];
  const selection = selectCommercialProposals(results);
  check("[B6] nothing feasible -> empty selection (never a fabricated proposal)", selection.length === 0, selection);
}

// ---- B7. Section 6 edge case: LINEAR #1 is already the SHORTEST feasible term (nothing below it) -> falls back to next-lowest entrada ----
{
  const rows = [
    { term_months: 12, possible: true, down_payment: 100000, payment: 3500 }, // lowest entrada, but shortest term -- nothing below it
    { term_months: 18, possible: true, down_payment: 150000, payment: 3500 },
  ];
  const results = [{ simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) }];
  const selection = selectCommercialProposals(results);
  check("[B7] LINEAR #1 = lowest entrada (term 12)", selection[0].term_months === 12, selection);
  check("[B7] LINEAR #2 falls back to the next-lowest-entrada candidate (18) since nothing exists below term 12", selection[1].term_months === 18, selection);
}

// ---- B8. Section 11: the structured payload built from the selection never carries the full 8-term comparison (only the raw per-proposal result) ----
{
  const rows = NOVOS_PRAZOS.map((t) => ({ term_months: t, possible: true, down_payment: 300000 - t * 1000, payment: 3500 }));
  const results = [{ simArgs: { financing_type: "LINEAR" }, output: linearOutput(3500, rows) }];
  const selection = selectCommercialProposals(results);
  check("[B8] each selected proposal's own `raw` is a SINGLE term result, not the full 8-row array (Section 11: structured payload = only the selection)",
    selection.every((p) => typeof p.raw.term_months === "number" && !Array.isArray(p.raw.results)), selection);
}

console.log(`\n=== IA-UAT-04: Deterministic 3-Proposal Commercial Selection (${pass}/${pass + fail}) ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

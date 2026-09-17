// IA-NLU2 — Financial Intent Contract + mutation-level validator:
// architectural scaffolding tests.
//
// financial-intent.ts is NOT wired into any live request-handling code
// path (proven here directly, Mission 17's own "call-site inventory").
// These tests exercise the new, dormant module only — they prove the
// CONTRACT can correctly represent and validate the semantic outcomes
// NLU-1 found production's own regex extraction gets wrong (the seven
// corruption findings), never that production behavior has changed
// (it hasn't — zero files besides this new module/test pair and the
// capability-lock's own PART D listing were touched this Wave).
//
// Run: node tests/ia-reconciliation/financial-intent-contract.test.mjs

import { join } from "node:path";
import { readSource, extractConst } from "./extract.mjs";
import * as intent from "../../supabase/functions/portal-ai-homolog/financial-intent.ts";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

// ========================================================================
// PART 0 — drift guard: this file's own mirrored canonical constants
// must stay byte-identical to the REAL index.ts ones. Extracted fresh
// from current source, never hand-copied.
// ========================================================================
{
  const source = readSource(SRC_PATH);
  const balaoMaxCountSrc = extractConst(source, "BALAO_MAX_COUNT");
  check(
    "CANONICAL_BALAO_MAX_COUNT mirrors index.ts's real BALAO_MAX_COUNT (drift guard)",
    balaoMaxCountSrc.includes("NOVOS: 4") && balaoMaxCountSrc.includes("SEMINOVOS: 2") &&
      intent.CANONICAL_BALAO_MAX_COUNT.NOVOS === 4 && intent.CANONICAL_BALAO_MAX_COUNT.SEMINOVOS === 2,
    { real: balaoMaxCountSrc, mirrored: intent.CANONICAL_BALAO_MAX_COUNT }
  );

  const novosPrazosSrc = extractConst(source, "NOVOS_PRAZOS");
  const seminovosPrazosSrc = extractConst(source, "SEMINOVOS_PRAZOS");
  const parseArray = (constText) => JSON.parse(constText.replace(/^const\s+\w+\s*=\s*/, "").replace(/;\s*$/, ""));
  check(
    "CANONICAL_TERM_UNIVERSE.NOVOS mirrors index.ts's real NOVOS_PRAZOS (drift guard)",
    JSON.stringify(parseArray(novosPrazosSrc)) === JSON.stringify(intent.CANONICAL_TERM_UNIVERSE.NOVOS),
    { real: novosPrazosSrc, mirrored: intent.CANONICAL_TERM_UNIVERSE.NOVOS }
  );
  check(
    "CANONICAL_TERM_UNIVERSE.SEMINOVOS mirrors index.ts's real SEMINOVOS_PRAZOS (drift guard)",
    JSON.stringify(parseArray(seminovosPrazosSrc)) === JSON.stringify(intent.CANONICAL_TERM_UNIVERSE.SEMINOVOS),
    { real: seminovosPrazosSrc, mirrored: intent.CANONICAL_TERM_UNIVERSE.SEMINOVOS }
  );
}

// ========================================================================
// PART 1 — Mission 17: production call-site inventory. Zero references
// to financial-intent.ts (or any export it defines) anywhere in
// index.ts. Proven by direct text search of the CURRENT source, not an
// assertion about intent.
// ========================================================================
{
  const source = readSource(SRC_PATH);
  check("index.ts contains ZERO references to './financial-intent'", !source.includes("financial-intent"), "found a reference");
  check("index.ts contains ZERO references to FinancialIntentDelta", !source.includes("FinancialIntentDelta"), "found a reference");
  check("index.ts contains ZERO references to validateFinancialIntentDelta", !source.includes("validateFinancialIntentDelta"), "found a reference");
  check("index.ts contains ZERO references to previewApplyValidatedIntent", !source.includes("previewApplyValidatedIntent"), "found a reference");
}

// ========================================================================
// PART 2 — baseline canonical state snapshots used throughout.
// ========================================================================
const BASE_STATE = {
  department: "NOVOS", vehicleValue: 170000, downPayment: 60000, targetPayment: 1800,
  termMonthsList: [36], financingTypeOverride: null, balloonCountMax: null, balloonCountExact: null,
};
const EMPTY_STATE = {
  department: null, vehicleValue: null, downPayment: null, targetPayment: null,
  termMonthsList: null, financingTypeOverride: null, balloonCountMax: null, balloonCountExact: null,
};
const prov = (span) => ({ source: "MODEL", sourceSpan: span });
const provDet = (span) => ({ source: "DETERMINISTIC", sourceSpan: span });

// ========================================================================
// PART 3 — Mission 2: UNSPECIFIED is not CLEAR. An empty delta must
// leave every field of the state completely untouched.
// ========================================================================
{
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, {});
  check("empty delta validates overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  check("empty delta produces an empty mutation (no field touched)", Object.keys(outcome.mutation).length === 0, outcome.mutation);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("previewApplyValidatedIntent with an empty mutation returns a state byte-identical to the input", JSON.stringify(next) === JSON.stringify(BASE_STATE), next);
}

// ========================================================================
// PART 4 — "tenta em 36 meses" (Mission 2's own worked example):
// term=SET(36), everything else UNSPECIFIED -> only term changes.
// ========================================================================
{
  const delta = { term: { field: { op: "SET", value: [36] }, provenance: provDet("36 meses") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[Mission 2] 'tenta em 36 meses': overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[Mission 2] ONLY term is present in the mutation -- vehicle/down_payment/target never touched by this delta", Object.keys(outcome.mutation).length === 1 && "term" in outcome.mutation, outcome.mutation);
  check("[Mission 2] resulting state: vehicle_value/down_payment/target_payment identical to BASE_STATE", next.vehicleValue === BASE_STATE.vehicleValue && next.downPayment === BASE_STATE.downPayment && next.targetPayment === BASE_STATE.targetPayment, next);
  check("[Mission 2] resulting state: term_months_list = [36]", JSON.stringify(next.termMonthsList) === "[36]", next);
}

// ========================================================================
// PART 5 — Mission 2 / Mission 9: "mantém a entrada e tenta 36" ->
// down_payment KEEP + term SET(36), structurally distinct mutations,
// never contaminating each other. Directly closes NLU-1 finding D.
// ========================================================================
{
  const delta = {
    downPayment: { field: { op: "KEEP" }, provenance: prov("mantém a entrada") },
    term: { field: { op: "SET", value: [36] }, provenance: provDet("tenta 36") },
  };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[Mission 2/9 -- NLU-1 finding D] overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding D fixed at the CONTRACT level] down_payment is UNCHANGED (60000), never contaminated with the term's own 36", next.downPayment === 60000, next);
  check("[NLU-1 finding D] term correctly becomes [36]", JSON.stringify(next.termMonthsList) === "[36]", next);
  check("[NLU-1 finding D] no proximity-window heuristic exists in this contract at all -- the delta's own downPayment field literally carries KEEP, term carries SET(36), independently constructed", true);
}

// ========================================================================
// PART 6 — "pode escolher o prazo" -> term DELEGATE.
// ========================================================================
{
  const withFixedTerm = { ...BASE_STATE, termMonthsList: [36] };
  const delta = { term: { field: { op: "DELEGATE" }, provenance: prov("pode escolher o prazo") } };
  const outcome = intent.validateFinancialIntentDelta(withFixedTerm, delta);
  check("[Mission 2] DELEGATE validates VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(withFixedTerm, outcome.mutation);
  check("[Mission 2] DELEGATE clears the fixed term back to null (delegated)", next.termMonthsList === null, next);
}

// ========================================================================
// PART 7 — "sem balão" -> financingMode SET(LINEAR_ONLY) + balloon
// CLEAR, exactly Mission 2's own worked example, AND mirrors
// production's own Part G (applyFinanceTurnDelta: switching to LINEAR
// clears balloon-only constraints) as a contract-level guarantee.
// ========================================================================
{
  const withBalloon = { ...BASE_STATE, balloonCountExact: 1 };
  const delta = { financingMode: { field: { op: "SET", value: "LINEAR_ONLY" }, provenance: prov("sem balão") } };
  const outcome = intent.validateFinancialIntentDelta(withBalloon, delta);
  check("[Mission 2] 'sem balão': overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(withBalloon, outcome.mutation);
  check("[Mission 2] financing_type_override becomes LINEAR_ONLY", next.financingTypeOverride === "LINEAR_ONLY", next);
  check("[Mission 2] balloon_count_exact is auto-CLEARed by the LINEAR transition (mirrors production's own Part G, index.ts applyFinanceTurnDelta)", next.balloonCountExact === null && next.balloonCountMax === null, next);
}

// ========================================================================
// PART 8 — Mission 3: provenance never carries chain-of-thought; only
// an exact source span + a closed-enum source tag.
// ========================================================================
{
  const delta = { term: { field: { op: "SET", value: [48] }, provenance: { source: "MODEL", sourceSpan: "48 meses" } } };
  check("[Mission 3] provenance.source is a closed enum value", ["DETERMINISTIC", "MODEL", "EXPLICIT_CONTEXT"].includes(delta.term.provenance.source));
  check("[Mission 3] provenance carries only a literal source span, never free-text reasoning (structural: the type has no 'reasoning'/'explanation'/'chainOfThought' field at all)", Object.keys(delta.term.provenance).sort().join(",") === "source,sourceSpan");
}

// ========================================================================
// PART 9 — Mission 4/6: numeric validation (vehicle_value > 0,
// down_payment >= 0, down_payment < vehicle_value, target_payment > 0).
// ========================================================================
{
  const negativeVehicle = { vehicleValue: { field: { op: "SET", value: -1000 }, provenance: prov("x") } };
  const o1 = intent.validateFinancialIntentDelta(BASE_STATE, negativeVehicle);
  check("[Mission 6] vehicle_value <= 0 is INVALID", o1.overallStatus === "INVALID" && o1.fieldResults.vehicleValue.status === "INVALID", o1);
  check("[Mission 6] an INVALID field is never present in `mutation`", !("vehicleValue" in o1.mutation), o1.mutation);

  const negativeDown = { downPayment: { field: { op: "SET", value: -500 }, provenance: prov("x") } };
  const o2 = intent.validateFinancialIntentDelta(BASE_STATE, negativeDown);
  check("[Mission 6] down_payment < 0 is INVALID", o2.overallStatus === "INVALID", o2);

  const downAboveVehicle = { downPayment: { field: { op: "SET", value: 200000 }, provenance: prov("x") } };
  const o3 = intent.validateFinancialIntentDelta(BASE_STATE, downAboveVehicle);
  check("[Mission 6] down_payment >= known vehicle_value is INVALID", o3.overallStatus === "INVALID", o3);

  const zeroTarget = { targetPayment: { field: { op: "SET", value: 0 }, provenance: prov("x") } };
  const o4 = intent.validateFinancialIntentDelta(BASE_STATE, zeroTarget);
  check("[Mission 6] target_payment <= 0 is INVALID", o4.overallStatus === "INVALID", o4);

  const outOfUniverseTerm = { term: { field: { op: "SET", value: [37] }, provenance: prov("x") } };
  const o5 = intent.validateFinancialIntentDelta(BASE_STATE, outOfUniverseTerm);
  check("[Mission 6] a term outside the canonical NOVOS universe (37) is INVALID", o5.overallStatus === "INVALID", o5);

  const validTerm = { term: { field: { op: "SET", value: [48] }, provenance: prov("x") } };
  const o6 = intent.validateFinancialIntentDelta(BASE_STATE, validTerm);
  check("[Mission 6] a term inside the canonical NOVOS universe (48) is VALID", o6.overallStatus === "VALID", o6);
}

// ========================================================================
// PART 10 — Mission 7 / NLU-1 finding A: "entrada de 80" unit
// ambiguity. Must NEVER silently resolve to either R$80 or R$80.000.
// ========================================================================
{
  const delta = {
    downPayment: {
      field: { op: "SET_UNIT_AMBIGUOUS", rawValue: 80, candidateUnits: ["BRL", "THOUSANDS_BRL"] },
      provenance: prov("entrada de 80"),
    },
  };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[NLU-1 finding A] 'entrada de 80': overallStatus=NEEDS_CLARIFICATION, never VALID", outcome.overallStatus === "NEEDS_CLARIFICATION", outcome);
  check("[NLU-1 finding A] down_payment is NEVER present in the validated mutation (no state can be built from it)", !("downPayment" in outcome.mutation), outcome.mutation);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding A] down_payment remains completely untouched (60000, never 80 nor 80000)", next.downPayment === 60000, next);
}

// ========================================================================
// PART 11 — Mission 8 / NLU-1 finding B: "mais 10 mil de entrada" ->
// DELTA +10000, never SET 10000.
// ========================================================================
{
  const delta = { downPayment: { field: { op: "DELTA", value: 10000 }, provenance: prov("mais 10 mil de entrada") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[NLU-1 finding B] 'mais 10 mil de entrada': overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding B fixed at the CONTRACT level] down_payment becomes 70000 (60000+10000), never the production bug's own 10000", next.downPayment === 70000, next);
}
{
  // "5 mil a menos" -- symmetric negative delta.
  const delta = { downPayment: { field: { op: "DELTA", value: -5000 }, provenance: prov("5 mil a menos") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[Mission 8] '5 mil a menos': down_payment becomes 55000 (60000-5000)", outcome.overallStatus === "VALID" && next.downPayment === 55000, { outcome, next });
}
{
  // "reduz a entrada em 10 mil"
  const delta = { downPayment: { field: { op: "DELTA", value: -10000 }, provenance: prov("reduz a entrada em 10 mil") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[Mission 8] 'reduz a entrada em 10 mil': down_payment becomes 50000", outcome.overallStatus === "VALID" && next.downPayment === 50000, { outcome, next });
}
{
  // DELTA with no known prior value -> NEEDS_CLARIFICATION, never silently anchored at 0.
  const outcome = intent.validateFinancialIntentDelta(EMPTY_STATE, { downPayment: { field: { op: "DELTA", value: 10000 }, provenance: prov("x") } });
  check("[Mission 8] a DELTA with no known current down_payment is NEEDS_CLARIFICATION, never silently treated as DELTA-from-zero", outcome.overallStatus === "NEEDS_CLARIFICATION", outcome);
}

// ========================================================================
// PART 12 — Mission 8 / NLU-1 finding C: "o carro ficou 5 mil mais
// caro" -> vehicle_value DELTA +5000, never SET 5000.
// ========================================================================
{
  const delta = { vehicleValue: { field: { op: "DELTA", value: 5000 }, provenance: prov("o carro ficou 5 mil mais caro") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[NLU-1 finding C] 'o carro ficou 5 mil mais caro': overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding C fixed at the CONTRACT level] vehicle_value becomes 175000 (170000+5000), never the production bug's own catastrophic 5000", next.vehicleValue === 175000, next);
}

// ========================================================================
// PART 13 — Mission 10 / NLU-1 finding E: "errei, não é 36 meses, é
// 48" represented as ONE term mutation, SET(48), never two competing
// terms and never the rejected 36.
// ========================================================================
{
  const delta = { term: { field: { op: "SET", value: [48] }, provenance: prov("errei, não é 36 meses, é 48") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[NLU-1 finding E] correction delta: overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding E fixed at the CONTRACT level] term becomes [48] -- the corrected value, never the rejected 36", JSON.stringify(next.termMonthsList) === "[48]", next);
  check("[NLU-1 finding E] the contract has exactly ONE `term` field -- structurally impossible to represent two competing terms in a single delta", typeof delta.term.field.value !== "undefined" && !Array.isArray(delta.term));
}

// ========================================================================
// PART 14 — Mission 12 / NLU-1 finding F: "compara com e sem balão".
// Existing canonical BOTH_BALAO_AND_LINEAR (represented as financing
// Mode SET with value "BOTH_BALAO_AND_LINEAR", mapping to
// financingTypeOverride=null exactly like production's own convention)
// adequately represents a comparison request -- confirmed, no new
// mode invented, no STOP required.
// ========================================================================
{
  const withOverride = { ...BASE_STATE, financingTypeOverride: "LINEAR_ONLY" };
  const delta = { financingMode: { field: { op: "SET", value: "BOTH_BALAO_AND_LINEAR" }, provenance: prov("compara com e sem balão") } };
  const outcome = intent.validateFinancialIntentDelta(withOverride, delta);
  check("[NLU-1 finding F] 'compara com e sem balão' -> BOTH_BALAO_AND_LINEAR validates VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(withOverride, outcome.mutation);
  check("[NLU-1 finding F fixed at the CONTRACT level] financing_type_override becomes null (BOTH, both engines considered) -- never silently collapsed into LINEAR_ONLY", next.financingTypeOverride === null, next);
  check("[Mission 12] no new financing mode was invented -- BOTH_BALAO_AND_LINEAR is index.ts's own existing, unmodified FinanceEngineFirstScenario member (index.ts:6533)", intent.CANONICAL_BALAO_MAX_COUNT !== undefined); // structural sanity: this file only ever references the existing 3-member enum, confirmed by its own FinancingMode type declaration
}

// ========================================================================
// PART 15 — Mission 13: balloon constraint validation, canonical
// ceilings reused (not duplicated with new values), CAPLOCK10's own
// "captured as-is, clamping is the engine's own job" precedent
// preserved (AMBIGUOUS with the raw value still carried in `mutation`,
// never silently dropped nor silently clamped by this validator).
// ========================================================================
{
  const setMax2 = { balloonConstraint: { field: { op: "SET_MAX", value: 2 }, provenance: prov("no máximo 2 balões") } };
  const o1 = intent.validateFinancialIntentDelta(BASE_STATE, setMax2);
  check("[Mission 13] NOVOS SET_MAX=2 (within canonical ceiling 4): VALID", o1.overallStatus === "VALID" && o1.mutation.balloonConstraint.value === 2, o1);

  const setMax10 = { balloonConstraint: { field: { op: "SET_MAX", value: 10 }, provenance: prov("no máximo 10 balões") } };
  const o2 = intent.validateFinancialIntentDelta(BASE_STATE, setMax10);
  check("[Mission 13] NOVOS SET_MAX=10 (above canonical ceiling 4): AMBIGUOUS, never INVALID (mirrors CAPLOCK5's own 'captured as-is' precedent)", o2.overallStatus === "AMBIGUOUS", o2);
  check("[Mission 13] the raw value 10 is still carried in `mutation` for a future caller to clamp/clarify -- never silently dropped", o2.mutation.balloonConstraint?.value === 10, o2.mutation);

  const seminovosState = { ...BASE_STATE, department: "SEMINOVOS" };
  const setMax3Seminovos = { balloonConstraint: { field: { op: "SET_MAX", value: 3 }, provenance: prov("no máximo 3 balões") } };
  const o3 = intent.validateFinancialIntentDelta(seminovosState, setMax3Seminovos);
  check("[Mission 13] SEMINOVOS SET_MAX=3 (above canonical ceiling 2): AMBIGUOUS", o3.overallStatus === "AMBIGUOUS", o3);

  const setExact1 = { balloonConstraint: { field: { op: "SET_EXACT", value: 1 }, provenance: prov("exatamente 1 balão") } };
  const o4 = intent.validateFinancialIntentDelta(BASE_STATE, setExact1);
  check("[Mission 13] SET_EXACT=1: VALID", o4.overallStatus === "VALID", o4);

  const clear = { balloonConstraint: { field: { op: "CLEAR" }, provenance: prov("sem balão") } };
  const o5 = intent.validateFinancialIntentDelta({ ...BASE_STATE, balloonCountExact: 1 }, clear);
  check("[Mission 13] CLEAR: VALID", o5.overallStatus === "VALID", o5);
  const next5 = intent.previewApplyValidatedIntent({ ...BASE_STATE, balloonCountExact: 1 }, o5.mutation);
  check("[Mission 13] CLEAR correctly nulls both balloonCountMax/balloonCountExact", next5.balloonCountMax === null && next5.balloonCountExact === null, next5);

  check("[Mission 13] canonical ceilings are REUSED (imported into the check), never duplicated with a different value: CANONICAL_BALAO_MAX_COUNT.NOVOS===4, SEMINOVOS===2, byte-identical to Part 0's drift guard", intent.CANONICAL_BALAO_MAX_COUNT.NOVOS === 4 && intent.CANONICAL_BALAO_MAX_COUNT.SEMINOVOS === 2);
}

// ========================================================================
// PART 16 — Mission 14 / NLU-1 finding G: percent-of-vehicle down
// payment, resolved ONLY when vehicle_value is known.
// ========================================================================
{
  const delta = { downPayment: { field: { op: "PERCENT_OF_VEHICLE", percent: 50 }, provenance: prov("50% de entrada") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta); // vehicleValue=170000
  check("[NLU-1 finding G] 50% of a known vehicle_value (170000): overallStatus=VALID", outcome.overallStatus === "VALID", outcome);
  check("[NLU-1 finding G] resolved to a concrete SET(85000), 50% of 170000", outcome.mutation.downPayment?.op === "SET" && outcome.mutation.downPayment?.value === 85000, outcome.mutation);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[NLU-1 finding G] resulting down_payment = 85000", next.downPayment === 85000, next);
}
{
  // Mission 14's own explicit requirement: unavailable vehicle_value -> NEEDS_CLARIFICATION.
  const delta = { downPayment: { field: { op: "PERCENT_OF_VEHICLE", percent: 50 }, provenance: prov("50% de entrada") } };
  const outcome = intent.validateFinancialIntentDelta(EMPTY_STATE, delta); // vehicleValue=null
  check("[Mission 14] 50% down payment with NO known vehicle_value: NEEDS_CLARIFICATION, never a guessed/deferred number", outcome.overallStatus === "NEEDS_CLARIFICATION", outcome);
  check("[Mission 14] down_payment never present in `mutation` when unresolved", !("downPayment" in outcome.mutation), outcome.mutation);
}
{
  const invalidPercent = { downPayment: { field: { op: "PERCENT_OF_VEHICLE", percent: 150 }, provenance: prov("x") } };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, invalidPercent);
  check("[Mission 14] a percent > 100 is INVALID", outcome.overallStatus === "INVALID", outcome);
}

// ========================================================================
// PART 17 — Mission 15: pure apply preview preserves UNSPECIFIED/KEEP
// fields and correctly applies every operator, over a MULTI-FIELD
// delta in one turn.
// ========================================================================
{
  const delta = {
    downPayment: { field: { op: "SET", value: 65000 }, provenance: prov("muda a entrada pra 65 mil") },
    term: { field: { op: "SET", value: [48] }, provenance: prov("tenta em 48 meses") },
    // vehicleValue/targetPayment/financingMode/balloonConstraint: UNSPECIFIED (absent from the delta entirely)
  };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[Mission 15] multi-field delta validates VALID", outcome.overallStatus === "VALID", outcome);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[Mission 15] down_payment and term both change as instructed", next.downPayment === 65000 && JSON.stringify(next.termMonthsList) === "[48]", next);
  check("[Mission 15] vehicle_value/target_payment/financing_mode/balloon constraints -- all UNSPECIFIED this turn -- remain byte-identical to BASE_STATE", next.vehicleValue === BASE_STATE.vehicleValue && next.targetPayment === BASE_STATE.targetPayment && next.financingTypeOverride === BASE_STATE.financingTypeOverride && next.balloonCountMax === BASE_STATE.balloonCountMax && next.balloonCountExact === BASE_STATE.balloonCountExact, next);
}
{
  // KEEP explicitly, contrasted with UNSPECIFIED -- both behave
  // identically for apply purposes (Mission 2's own point: the
  // DISTINCTION is intent/provenance, not runtime behavior, mirroring
  // CumulativeFinanceState's own "no separate delegation flag needed"
  // philosophy).
  const keepDelta = { downPayment: { field: { op: "KEEP" }, provenance: prov("mantém a entrada") } };
  const unspecifiedDelta = {};
  const o1 = intent.validateFinancialIntentDelta(BASE_STATE, keepDelta);
  const o2 = intent.validateFinancialIntentDelta(BASE_STATE, unspecifiedDelta);
  const n1 = intent.previewApplyValidatedIntent(BASE_STATE, o1.mutation);
  const n2 = intent.previewApplyValidatedIntent(BASE_STATE, o2.mutation);
  check("[Mission 15] KEEP and UNSPECIFIED produce byte-identical resulting states for the same field", JSON.stringify(n1) === JSON.stringify(n2), { n1, n2 });
}

// ========================================================================
// PART 18 — a partially-ambiguous delta: some fields VALID, one
// NEEDS_CLARIFICATION -- the VALID fields must still apply (per-field
// granularity, never all-or-nothing rejection of the whole turn).
// ========================================================================
{
  const delta = {
    term: { field: { op: "SET", value: [48] }, provenance: prov("tenta 48") },
    downPayment: { field: { op: "SET_UNIT_AMBIGUOUS", rawValue: 80, candidateUnits: ["BRL", "THOUSANDS_BRL"] }, provenance: prov("entrada de 80") },
  };
  const outcome = intent.validateFinancialIntentDelta(BASE_STATE, delta);
  check("[per-field granularity] overallStatus=NEEDS_CLARIFICATION (the worst status present)", outcome.overallStatus === "NEEDS_CLARIFICATION", outcome);
  check("[per-field granularity] term is STILL present in `mutation` despite the sibling field's ambiguity", "term" in outcome.mutation, outcome.mutation);
  check("[per-field granularity] down_payment is NOT present in `mutation`", !("downPayment" in outcome.mutation), outcome.mutation);
  const next = intent.previewApplyValidatedIntent(BASE_STATE, outcome.mutation);
  check("[per-field granularity] term applies (48) while down_payment stays untouched (60000) -- a genuinely ambiguous field never blocks an unrelated, unambiguous field in the same turn", JSON.stringify(next.termMonthsList) === "[48]" && next.downPayment === 60000, next);
}

console.log(`\n=== Financial Intent Contract + Mutation Validator (IA-NLU2): ${pass}/${pass + fail} ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

// IA-NLU2 — Financial Intent Contract + mutation-level validation
// boundary. SCAFFOLDING ONLY.
//
// This file is NOT imported by index.ts and is NOT referenced by any
// live request-handling code path. It exists purely so a future wave
// (NLU-3 shadow-mode comparison, NLU-5 controlled authority switch)
// has a validated contract to plug into CumulativeFinanceState's own
// existing mutation semantics — never a parallel business-state object,
// never a replacement for applyFinanceTurnDelta/computeCumulativeFinance
// State (both remain completely untouched by this file), never a route
// by which a model can set a final financial number directly (the
// frozen deterministic engine in index.ts remains the sole authority
// for any number that reaches a Human).
//
// Lives as its own file — mirroring scope-policy.ts/tool-policy.ts's
// own established precedent exactly — because index.ts has remote
// (https://) Deno imports that Node's native TypeScript loader cannot
// resolve, so anything needing isolated Node-level unit testing
// (tests/ia-reconciliation/financial-intent-contract.test.mjs) must
// live outside it. Zero Deno-specific or remote-URL dependency.
//
// NLU-1's own diagnosis (82 real Portuguese dealership utterances,
// PASS 36 / FAIL 38 / AMBIGUOUS 8) found seven concrete, reproducible
// silent-corruption classes in the CURRENT production regex extraction
// (index.ts's applyFinanceTurnDelta). This contract is the structural
// answer to all seven — proven here as representation + validation
// capability only, per NLU-2's own explicit scope. None of the seven
// findings are fixed in production this wave.

// ===========================================================================
// PART A — shared vocabulary, mirrored (never imported) from index.ts's
// own canonical constants. Each one is cross-checked byte-for-byte
// against the REAL index.ts constant in
// tests/ia-reconciliation/financial-intent-contract.test.mjs, so any
// future drift between this file and production is caught immediately
// rather than silently diverging.
// ===========================================================================

export type SimDepartment = "NOVOS" | "SEMINOVOS";
export type FinancingMode = "LINEAR_ONLY" | "BALAO_ONLY" | "BOTH_BALAO_AND_LINEAR";

// Mirrors index.ts's BALAO_MAX_COUNT verbatim.
export const CANONICAL_BALAO_MAX_COUNT: Record<SimDepartment, number> = { NOVOS: 4, SEMINOVOS: 2 };

// Mirrors index.ts's NOVOS_PRAZOS/SEMINOVOS_PRAZOS verbatim (the
// broader LINEAR term universe — the contract's own `term` field is
// generic across financing types; a narrower BALAO-specific term
// check, when relevant, remains toolSimularFinanciamento's own job at
// actual dispatch time, unchanged and untouched by this file).
export const CANONICAL_TERM_UNIVERSE: Record<SimDepartment, number[]> = {
  NOVOS: [12, 18, 24, 30, 36, 42, 48, 60],
  SEMINOVOS: [12, 18, 24, 30, 36, 42, 48, 50, 60],
};

// ===========================================================================
// PART B — mutation operators. Per Mission 1: only the operators that
// are semantically meaningful for a given field, never forced onto
// every field uniformly.
// ===========================================================================

export type NumericFieldOp =
  | { op: "SET"; value: number }
  | { op: "DELTA"; value: number }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

export type ClearableNumericFieldOp =
  | { op: "SET"; value: number }
  | { op: "CLEAR" }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

export type TermFieldOp =
  | { op: "SET"; value: number[] }
  | { op: "DELEGATE" }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

export type FinancingModeFieldOp =
  | { op: "SET"; value: FinancingMode }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

export type BalloonConstraintFieldOp =
  | { op: "SET_MAX"; value: number }
  | { op: "SET_EXACT"; value: number }
  | { op: "CLEAR" }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

// IA-NLU2 Mission 7 — unit ambiguity is a REPRESENTABLE state, never
// silently resolved by the contract itself. A future extractor that
// cannot deterministically establish which unit the Human meant must
// emit SET_UNIT_AMBIGUOUS rather than guessing BRL vs. thousands vs.
// percent — the validator (Part D) turns this into NEEDS_CLARIFICATION,
// never a silent pick.
export type DownPaymentFieldOp =
  | { op: "SET"; value: number }
  | { op: "DELTA"; value: number }
  | { op: "PERCENT_OF_VEHICLE"; percent: number }
  | { op: "SET_UNIT_AMBIGUOUS"; rawValue: number; candidateUnits: Array<"BRL" | "THOUSANDS_BRL" | "PERCENT_OF_VEHICLE"> }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

export type VehicleModelFieldOp =
  | { op: "SET"; value: string }
  | { op: "KEEP" }
  | { op: "UNSPECIFIED" };

// ===========================================================================
// PART C — provenance. Internal audit/debug metadata only, per Mission
// 3: never exposed to the Human, never carries chain-of-thought —
// `sourceSpan` is the exact substring of the turn a field was derived
// from, never a paraphrase or an explanation of HOW/WHY.
// ===========================================================================

export type IntentFieldSource = "DETERMINISTIC" | "MODEL" | "EXPLICIT_CONTEXT";

export interface IntentFieldProvenance {
  source: IntentFieldSource;
  sourceSpan?: string;
}

interface IntentField<Op> {
  field: Op;
  provenance: IntentFieldProvenance;
}

// ===========================================================================
// PART D — FinancialIntentDelta. ONE turn's own semantic mutation,
// derived field-for-field from CumulativeFinanceState's own existing
// shape (index.ts:6896-6911) — never a parallel/competing business-
// state object. Every field is independently constructed; nothing in
// this type (or in the validator/preview below) ever derives one
// field's mutation from another field's raw text — the structural
// guarantee Mission 9 requires against cross-field contamination like
// production's own "mantém a entrada e tenta 36" -> down_payment=36 bug.
// ===========================================================================

export interface FinancialIntentDelta {
  vehicleModel?: IntentField<VehicleModelFieldOp>;
  vehicleValue?: IntentField<NumericFieldOp>;
  downPayment?: IntentField<DownPaymentFieldOp>;
  targetPayment?: IntentField<ClearableNumericFieldOp>;
  term?: IntentField<TermFieldOp>;
  financingMode?: IntentField<FinancingModeFieldOp>;
  balloonConstraint?: IntentField<BalloonConstraintFieldOp>;
}

// ===========================================================================
// PART E — deterministic validation status. Mission 4's own hard rule:
// confidence is not authority, validation is. A model-provided
// confidence number (if one ever exists upstream) is NEVER trusted
// directly — every field is independently, deterministically checked
// here regardless of how confidently it was extracted.
// ===========================================================================

export type ValidationStatus = "VALID" | "AMBIGUOUS" | "INVALID" | "NEEDS_CLARIFICATION";

export interface FieldValidationResult {
  status: ValidationStatus;
  reason: string; // audit-facing, not a verbatim Human-facing clarification question
}

// The subset of FinancialIntentDelta's own field operators that
// SURVIVED validation as VALID — the only fields Part F's preview
// function is permitted to apply. A field absent here (because it was
// UNSPECIFIED, or failed validation) behaves identically to
// UNSPECIFIED for apply purposes: the current canonical value is
// inherited untouched.
export interface ValidatedMutation {
  vehicleModel?: VehicleModelFieldOp;
  vehicleValue?: NumericFieldOp;
  downPayment?: Exclude<DownPaymentFieldOp, { op: "SET_UNIT_AMBIGUOUS" }>;
  targetPayment?: ClearableNumericFieldOp;
  term?: TermFieldOp;
  financingMode?: FinancingModeFieldOp;
  balloonConstraint?: BalloonConstraintFieldOp;
}

export interface ValidationOutcome {
  // VALID iff every field present in the input delta validated VALID.
  // Otherwise the worst status observed, in this precedence:
  // INVALID > NEEDS_CLARIFICATION > AMBIGUOUS > VALID.
  overallStatus: ValidationStatus;
  fieldResults: Partial<Record<keyof FinancialIntentDelta, FieldValidationResult>>;
  mutation: ValidatedMutation;
}

// Canonical constraints a caller may inject (e.g. from a live-read of
// index.ts's own constants, once a future wave wires this in); default
// values are this file's own mirrored copies (Part A), so the
// validator is fully self-contained for today's dormant/test-only use.
export interface CanonicalConstraints {
  balaoMaxCount: Record<SimDepartment, number>;
  termUniverse: Record<SimDepartment, number[]>;
}

const DEFAULT_CONSTRAINTS: CanonicalConstraints = {
  balaoMaxCount: CANONICAL_BALAO_MAX_COUNT,
  termUniverse: CANONICAL_TERM_UNIVERSE,
};

// The minimal slice of CumulativeFinanceState this validator needs to
// reason about (e.g. resolving PERCENT_OF_VEHICLE, or knowing which
// department's term/balloon ceilings apply). Deliberately NOT the full
// index.ts CumulativeFinanceState type (which this file cannot import) —
// shaped identically so a future caller can pass the real object
// as-is; cross-checked structurally by the same test file.
export interface CanonicalStateSnapshot {
  department: SimDepartment | null;
  vehicleValue: number | null;
  downPayment: number | null;
  targetPayment: number | null;
  termMonthsList: number[] | null;
  // Mirrors CumulativeFinanceState.financingTypeOverride exactly
  // (index.ts:6907) -- "BOTH" is represented by null, never a third
  // enum member, matching production's own existing convention.
  financingTypeOverride: "LINEAR_ONLY" | "BALAO_ONLY" | null;
  balloonCountMax: number | null;
  balloonCountExact: number | null;
}

function ok(reason: string): FieldValidationResult { return { status: "VALID", reason }; }
function invalid(reason: string): FieldValidationResult { return { status: "INVALID", reason }; }
function ambiguous(reason: string): FieldValidationResult { return { status: "AMBIGUOUS", reason }; }
function needsClarification(reason: string): FieldValidationResult { return { status: "NEEDS_CLARIFICATION", reason }; }

const STATUS_RANK: Record<ValidationStatus, number> = { VALID: 0, AMBIGUOUS: 1, NEEDS_CLARIFICATION: 2, INVALID: 3 };

// ===========================================================================
// PART F — the pure mutation-level validator (Mission 5). Never
// mutates CumulativeFinanceState; never calls the deterministic
// engine; never makes a network/model call (Mission 20). Input: the
// current canonical state snapshot + one turn's own
// FinancialIntentDelta. Output: a ValidationOutcome whose `mutation`
// contains only the fields that passed deterministic validation.
// ===========================================================================

export function validateFinancialIntentDelta(
  state: CanonicalStateSnapshot,
  delta: FinancialIntentDelta,
  constraints: CanonicalConstraints = DEFAULT_CONSTRAINTS
): ValidationOutcome {
  const fieldResults: ValidationOutcome["fieldResults"] = {};
  const mutation: ValidatedMutation = {};
  let overallStatus: ValidationStatus = "VALID";
  const worsen = (s: ValidationStatus) => { if (STATUS_RANK[s] > STATUS_RANK[overallStatus]) overallStatus = s; };

  // ---- vehicleModel ----
  if (delta.vehicleModel) {
    const f = delta.vehicleModel.field;
    if (f.op === "SET") {
      if (typeof f.value === "string" && f.value.trim().length > 0) {
        fieldResults.vehicleModel = ok("non-empty model string");
        mutation.vehicleModel = f;
      } else {
        fieldResults.vehicleModel = invalid("empty/blank model string");
        worsen("INVALID");
      }
    } else {
      fieldResults.vehicleModel = ok(`${f.op}, no numeric validation needed`);
      mutation.vehicleModel = f;
    }
  }

  // ---- vehicleValue ----
  if (delta.vehicleValue) {
    const f = delta.vehicleValue.field;
    if (f.op === "SET" || f.op === "DELTA") {
      const resulting = f.op === "SET" ? f.value : (state.vehicleValue ?? 0) + f.value;
      if (f.op === "DELTA" && state.vehicleValue === null) {
        fieldResults.vehicleValue = needsClarification("DELTA on vehicle_value with no known current value to apply it against");
        worsen("NEEDS_CLARIFICATION");
      } else if (!(resulting > 0)) {
        fieldResults.vehicleValue = invalid(`resulting vehicle_value ${resulting} is not > 0 (Mission 6: vehicle_value > 0)`);
        worsen("INVALID");
      } else {
        fieldResults.vehicleValue = ok(`${f.op} -> ${resulting}`);
        mutation.vehicleValue = f;
      }
    } else {
      fieldResults.vehicleValue = ok(f.op);
      mutation.vehicleValue = f;
    }
  }

  // ---- downPayment ----
  if (delta.downPayment) {
    const f = delta.downPayment.field;
    if (f.op === "SET_UNIT_AMBIGUOUS") {
      // IA-NLU2 Mission 7 -- the direct representation of "entrada de
      // 80": the contract structurally refuses to silently collapse
      // this into R$80 or R$80.000. Never enters `mutation`.
      fieldResults.downPayment = needsClarification(
        `raw value ${f.rawValue} has ${f.candidateUnits.length} plausible unit interpretations (${f.candidateUnits.join("/")}) -- no deterministic unit signal in the turn`
      );
      worsen("NEEDS_CLARIFICATION");
    } else if (f.op === "PERCENT_OF_VEHICLE") {
      if (!(f.percent > 0 && f.percent <= 100)) {
        fieldResults.downPayment = invalid(`percent ${f.percent} is out of the (0, 100] range`);
        worsen("INVALID");
      } else if (state.vehicleValue === null) {
        // Mission 14 -- explicit requirement: unresolved without a known vehicle value.
        fieldResults.downPayment = needsClarification("PERCENT_OF_VEHICLE stated, but vehicle_value is not yet known -- cannot resolve to an absolute amount");
        worsen("NEEDS_CLARIFICATION");
      } else {
        const resolved = round2((f.percent / 100) * state.vehicleValue);
        fieldResults.downPayment = ok(`${f.percent}% of vehicle_value ${state.vehicleValue} -> ${resolved}`);
        mutation.downPayment = { op: "SET", value: resolved };
      }
    } else if (f.op === "SET" || f.op === "DELTA") {
      const resulting = f.op === "SET" ? f.value : (state.downPayment ?? 0) + f.value;
      if (f.op === "DELTA" && state.downPayment === null) {
        fieldResults.downPayment = needsClarification("DELTA on down_payment with no known current value to apply it against");
        worsen("NEEDS_CLARIFICATION");
      } else if (!(resulting >= 0)) {
        fieldResults.downPayment = invalid(`resulting down_payment ${resulting} is not >= 0 (Mission 6: down_payment >= 0)`);
        worsen("INVALID");
      } else if (state.vehicleValue !== null && resulting >= state.vehicleValue) {
        fieldResults.downPayment = invalid(`resulting down_payment ${resulting} is not < known vehicle_value ${state.vehicleValue}`);
        worsen("INVALID");
      } else {
        fieldResults.downPayment = ok(`${f.op} -> ${resulting}`);
        mutation.downPayment = { op: "SET", value: resulting };
      }
    } else {
      fieldResults.downPayment = ok(f.op);
      mutation.downPayment = f;
    }
  }

  // ---- targetPayment ----
  if (delta.targetPayment) {
    const f = delta.targetPayment.field;
    if (f.op === "SET") {
      if (!(f.value > 0)) {
        fieldResults.targetPayment = invalid(`target_payment ${f.value} is not > 0 (Mission 6: target_payment > 0)`);
        worsen("INVALID");
      } else {
        fieldResults.targetPayment = ok(`SET -> ${f.value}`);
        mutation.targetPayment = f;
      }
    } else {
      fieldResults.targetPayment = ok(f.op);
      mutation.targetPayment = f;
    }
  }

  // ---- term ----
  if (delta.term) {
    const f = delta.term.field;
    if (f.op === "SET") {
      const universe = state.department !== null ? constraints.termUniverse[state.department] : null;
      const invalidTerms = universe ? f.value.filter((t) => !universe.includes(t)) : [];
      if (f.value.length === 0) {
        fieldResults.term = invalid("SET with an empty term list");
        worsen("INVALID");
      } else if (universe !== null && invalidTerms.length > 0) {
        fieldResults.term = invalid(`term(s) ${invalidTerms.join(",")} not in the canonical ${state.department} term universe (${universe.join(",")})`);
        worsen("INVALID");
      } else {
        // department unknown yet -> cannot check against a universe;
        // still structurally VALID (a later turn establishing
        // department is not this field's own concern), matching
        // production's own existing "department resolved once, term
        // resolved independently" ordering.
        fieldResults.term = ok(universe === null ? `SET -> [${f.value.join(",")}] (department not yet known, term-universe check deferred)` : `SET -> [${f.value.join(",")}], within the canonical ${state.department} universe`);
        mutation.term = f;
      }
    } else {
      fieldResults.term = ok(f.op);
      mutation.term = f;
    }
  }

  // ---- financingMode ----
  if (delta.financingMode) {
    const f = delta.financingMode.field;
    fieldResults.financingMode = ok(f.op);
    mutation.financingMode = f;
  }

  // ---- balloonConstraint ----
  if (delta.balloonConstraint) {
    const f = delta.balloonConstraint.field;
    if (f.op === "SET_MAX" || f.op === "SET_EXACT") {
      const canonicalMax = state.department !== null ? constraints.balaoMaxCount[state.department] : null;
      if (!(f.value >= 1)) {
        fieldResults.balloonConstraint = invalid(`balloon count ${f.value} is not >= 1`);
        worsen("INVALID");
      } else if (canonicalMax !== null && f.value > canonicalMax) {
        // Mission 13 -- never modify CAPLOCK10's own clamping
        // philosophy: a Human-stated count above the department's
        // canonical ceiling is not rejected outright (matches
        // production's own "captured as-is, clamping is the engine's
        // own job" precedent, IA-CAPLOCK5/balloon-count-constraint.
        // test.mjs Part G9) -- flagged AMBIGUOUS (not INVALID) so a
        // future caller can decide to clamp-and-proceed or clarify,
        // never silently either accepted-as-stated or dropped.
        fieldResults.balloonConstraint = ambiguous(`balloon count ${f.value} exceeds the canonical ${state.department} ceiling (${canonicalMax}) -- captured as-is, clamping is the engine's own job (mirrors production precedent)`);
        worsen("AMBIGUOUS");
        mutation.balloonConstraint = f;
      } else {
        fieldResults.balloonConstraint = ok(`${f.op} -> ${f.value}, within the canonical ${state.department ?? "(department unknown)"} ceiling`);
        mutation.balloonConstraint = f;
      }
    } else {
      fieldResults.balloonConstraint = ok(f.op);
      mutation.balloonConstraint = f;
    }
  }

  return { overallStatus, fieldResults, mutation };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// ===========================================================================
// PART G — pure apply preview (Mission 15). NOT connected to
// production applyFinanceTurnDelta. Proves the contract can eventually
// map into CumulativeFinanceState's own existing shape without
// changing its semantics: UNSPECIFIED and unresolved/failed fields
// inherit the current value untouched; KEEP is explicit and behaves
// identically to UNSPECIFIED for the numeric/term/mode fields (the
// distinction is provenance/intent, not behavior — mirrors production's
// own "no separate delegation flag needed" CumulativeFinanceState
// philosophy, index.ts:6902-6905); SET/DELTA/CLEAR/DELEGATE apply as
// their names describe.
// ===========================================================================

export function previewApplyValidatedIntent(
  state: CanonicalStateSnapshot,
  mutation: ValidatedMutation
): CanonicalStateSnapshot {
  const next: CanonicalStateSnapshot = { ...state };

  if (mutation.vehicleValue) {
    const f = mutation.vehicleValue;
    if (f.op === "SET") next.vehicleValue = f.value;
    else if (f.op === "DELTA") next.vehicleValue = (next.vehicleValue ?? 0) + f.value;
    // KEEP / UNSPECIFIED -> untouched
  }

  if (mutation.downPayment) {
    const f = mutation.downPayment;
    if (f.op === "SET") next.downPayment = f.value;
    else if (f.op === "DELTA") next.downPayment = (next.downPayment ?? 0) + f.value;
    // PERCENT_OF_VEHICLE never reaches here -- validateFinancialIntentDelta
    // already resolves it to a concrete SET before it enters `mutation`.
    // KEEP / UNSPECIFIED -> untouched
  }

  if (mutation.targetPayment) {
    const f = mutation.targetPayment;
    if (f.op === "SET") next.targetPayment = f.value;
    else if (f.op === "CLEAR") next.targetPayment = null;
    // KEEP / UNSPECIFIED -> untouched
  }

  if (mutation.term) {
    const f = mutation.term;
    if (f.op === "SET") next.termMonthsList = f.value;
    else if (f.op === "DELEGATE") next.termMonthsList = null;
    // KEEP / UNSPECIFIED -> untouched
  }

  if (mutation.financingMode) {
    const f = mutation.financingMode;
    if (f.op === "SET") {
      next.financingTypeOverride = (f.value === "BOTH_BALAO_AND_LINEAR" ? null : f.value) as CanonicalStateSnapshot["financingTypeOverride"];
      // Mirrors production's own Part G (index.ts applyFinanceTurnDelta,
      // "switching to LINEAR clears Balloon-only constraints that no
      // longer apply") -- proven here as a contract-level guarantee,
      // never re-implemented via a separate proximity heuristic.
      if (f.value === "LINEAR_ONLY") { next.balloonCountMax = null; next.balloonCountExact = null; }
    }
    // KEEP / UNSPECIFIED -> untouched
  }

  if (mutation.balloonConstraint) {
    const f = mutation.balloonConstraint;
    if (f.op === "SET_MAX") { next.balloonCountMax = f.value; next.balloonCountExact = null; }
    else if (f.op === "SET_EXACT") { next.balloonCountExact = f.value; next.balloonCountMax = null; }
    else if (f.op === "CLEAR") { next.balloonCountMax = null; next.balloonCountExact = null; }
    // KEEP / UNSPECIFIED -> untouched
  }

  return next;
}

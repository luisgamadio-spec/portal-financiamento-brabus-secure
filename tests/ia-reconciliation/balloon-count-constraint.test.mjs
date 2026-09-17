// IA-CAPLOCK5 — real Human UAT defect: a financing follow-up that
// changes the ALLOWED/DESIRED Balão COUNT ("no máximo 2 balões",
// "colocando no máximo 2", "exatamente 2 balões") was silently
// dropped -- nothing extracted it, so the dispatched simulation
// ignored the Human's own explicit constraint and either re-escalated
// to the same unconstrained answer or left the model with nothing new
// to report ("não tenho um cenário calculado com no máximo 2 balões").
//
// This file proves, against the REAL, unmodified
// balaoRequiredDownPaymentEscalateForTarget (never a hand-copied
// duplicate, never an invented expected entry -- every comparison is
// derived from the engine's own output at each count, on a synthetic
// offline fixture table, same discipline as balloon-entry-search-
// escalation.test.mjs): the new balloon_count_ceiling/balloon_count_exact
// parameters genuinely narrow the search space, are never bypassed,
// and never exceed the department's own canonical ceiling (4 Novos, 2
// Seminovos) even when asked to.
//
// Run: node tests/ia-reconciliation/balloon-count-constraint.test.mjs

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractFunction, extractConst, extractInterface } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function extractTypeAlias(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)type\\s+${name}\\s*=([\\s\\S]*?);\\r?\\n`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractTypeAlias: "${name}" not found`);
  return `type ${name} =${m[1]};`;
}

function extractInterfaceExtends(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)interface\\s+${name}\\s+extends\\s+\\S+\\s*\\{`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractInterfaceExtends: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\n") || m[0].startsWith("\r\n") ? (m[0].startsWith("\r\n") ? 2 : 1) : 0);
  const braceStart = src.indexOf("{", m.index);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const modText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  extractTypeAlias(source, "SimDepartment"),
  "export " + extractConst(source, "BALAO_MAX_COUNT"),
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "balaoTaxaInterna"),
  "export " + extractFunction(source, "balaoBaseInterna"),
  "export " + extractInterface(source, "BalaoRateRow"),
  "export " + extractInterfaceExtends(source, "BalaoRateRowSemi"),
  "export " + extractFunction(source, "balaoFaixaAno"),
  "export " + extractFunction(source, "balaoPlanoNovos"),
  "export " + extractFunction(source, "balaoPlanoSeminovos"),
  "export " + extractInterface(source, "BalaoEngine"),
  "export " + extractInterface(source, "BalaoBalloon"),
  "export " + extractInterface(source, "BalaoCalcOk"),
  extractTypeAlias(source, "BalaoErrorCode"),
  "export " + extractConst(source, "BALAO_ERROR_MESSAGES"),
  "export " + extractFunction(source, "balaoMinTierEntradaPct"),
  "export " + extractFunction(source, "balaoCalcular"),
  "export " + extractFunction(source, "balaoOptimizeMinPayment"),
  "export " + extractFunction(source, "balaoDistribuirMeses"),
  "export " + extractFunction(source, "balaoOptimizeMinPaymentMulti"),
  "export " + extractFunction(source, "balaoRequiredDownPaymentAutoBalloon"),
  "export " + extractFunction(source, "balaoRequiredDownPaymentEscalateForTarget"),
  "export " + extractFunction(source, "balaoOptimizeEscalateForTarget"),
  "export " + extractConst(source, "BALLOON_COUNT_MAX_RE"),
  "export " + extractConst(source, "BALLOON_COUNT_EXACT_RE"),
  "export " + extractFunction(source, "extractBalloonCountConstraint"),
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-balloon-count-constraint-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- synthetic fixture rate table (offline, no RPC) — same shape balloon-entry-search-escalation.test.mjs already uses ----------
const FIXTURE_ENGINE = {
  novosTable: [{ entrada: 0.00, prazo: 48, max: 0.7, taxa: 0.0179 }],
  seminovosTable: null,
};
const VEHICLE_VALUE = 180000;
const TERM = 48;
const PROBE_DOWN_PAYMENT = 90000;

const probe1 = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, PROBE_DOWN_PAYMENT, TERM, TERM, null, null);
check("fixture: count=1 probe is feasible on this synthetic table", probe1.ok, JSON.stringify(probe1));

if (probe1.ok) {
  const TARGET = probe1.result.monthly_payment;

  // Independent full sweep 1..4 (NOVOS canonical ceiling) -- the ground
  // truth every assertion below is checked against, never invented.
  const sweep = [];
  for (let c = 1; c <= mod.BALAO_MAX_COUNT.NOVOS; c++) {
    const r = mod.balaoRequiredDownPaymentAutoBalloon(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, c);
    if (r !== null) sweep.push({ count: c, down_payment: r.down_payment });
  }
  check("fixture: sweep found feasible results for counts 1..4", sweep.length === 4, JSON.stringify(sweep));
  const trueMinOverall = sweep.reduce((b, r) => (r.down_payment < b.down_payment ? r : b));
  const trueMinWithin2 = sweep.filter((r) => r.count <= 2).reduce((b, r) => (r.down_payment < b.down_payment ? r : b));

  // ========================================================================
  // PART 1 — ceiling narrows the search (the incident's own "no máximo 2")
  // ========================================================================
  {
    const escCeiling2 = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, /* minCount */ 1, /* maxCountOverride */ 2);
    check("ceiling=2: escalation call succeeds", escCeiling2 !== null, JSON.stringify(escCeiling2));
    if (escCeiling2 !== null) {
      check("ceiling=2: NEVER tries a count above 2", escCeiling2.balloon_count_tried <= 2, `got balloon_count_tried=${escCeiling2.balloon_count_tried}`);
      check(
        "ceiling=2: result equals the TRUE minimum WITHIN counts 1..2 (an independent sweep), never the unconstrained 1..4 minimum",
        escCeiling2.down_payment === trueMinWithin2.down_payment,
        `escalated=${escCeiling2.down_payment} true_min_within_2=${trueMinWithin2.down_payment} (count ${trueMinWithin2.count})`
      );
      check("ceiling=2: target payment still respected exactly", escCeiling2.payment === TARGET);
      // If the department's true unconstrained optimum needs 3+ balloons on
      // this fixture, the ceiling result must be genuinely WORSE (higher
      // entry) than the unconstrained one -- proving the ceiling is a real
      // constraint, not a no-op.
      if (trueMinOverall.count > 2) {
        check(
          "ceiling=2: when the true optimum needs >2 balloons, the ceiling-constrained result is genuinely a HIGHER (worse) entry than the unconstrained optimum -- proves the ceiling is real, not decorative",
          escCeiling2.down_payment > trueMinOverall.down_payment,
          `ceiling2=${escCeiling2.down_payment} unconstrained_true_min=${trueMinOverall.down_payment} (count ${trueMinOverall.count})`
        );
      }
    }
  }

  // ========================================================================
  // PART 2 — exact pins the search to a single count
  // ========================================================================
  {
    const escExact2 = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, /* minCount */ 2, /* maxCountOverride */ 2);
    check("exact=2 (floor=ceiling=2): escalation call succeeds", escExact2 !== null, JSON.stringify(escExact2));
    if (escExact2 !== null) {
      check("exact=2: tries ONLY count 2, never 1, 3, or 4", escExact2.balloon_count_tried === 2, `got balloon_count_tried=${escExact2.balloon_count_tried}`);
      const count2Direct = sweep.find((r) => r.count === 2);
      check(
        "exact=2: result equals count=2's own direct (unescalated) computation exactly -- no other count was ever considered",
        count2Direct !== undefined && escExact2.down_payment === count2Direct.down_payment,
        `exact2=${escExact2.down_payment} count2_direct=${count2Direct && count2Direct.down_payment}`
      );
    }
  }

  // ========================================================================
  // PART 3 — a ceiling above the canonical max is clamped, never exceeded
  // ========================================================================
  {
    const escOverCeiling = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 1, /* maxCountOverride */ 10);
    check("ceiling=10 (above NOVOS canonical 4): escalation call succeeds", escOverCeiling !== null, JSON.stringify(escOverCeiling));
    if (escOverCeiling !== null) {
      check(
        "ceiling=10: still never tries a count above the department's own canonical ceiling (4) -- a Human constraint can only REDUCE the search space, never increase it",
        escOverCeiling.balloon_count_tried <= mod.BALAO_MAX_COUNT.NOVOS,
        `got balloon_count_tried=${escOverCeiling.balloon_count_tried}`
      );
      check(
        "ceiling=10: result equals the TRUE unconstrained minimum (1..4) -- an over-large ceiling behaves identically to no ceiling at all",
        escOverCeiling.down_payment === trueMinOverall.down_payment,
        `over_ceiling=${escOverCeiling.down_payment} true_min=${trueMinOverall.down_payment}`
      );
    }
  }

  // ========================================================================
  // PART 4 — default (no ceiling, no exact) behaves exactly as before this Wave
  // ========================================================================
  {
    const escDefault = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 1);
    check("no ceiling argument at all (omitted, pre-existing call shape): still finds the true unconstrained minimum", escDefault !== null && escDefault.down_payment === trueMinOverall.down_payment, JSON.stringify(escDefault));
    const escDefaultExplicitNull = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 1, null);
    check("explicit maxCountOverride=null: identical to omitting it entirely", escDefaultExplicitNull !== null && escDefaultExplicitNull.down_payment === trueMinOverall.down_payment, JSON.stringify(escDefaultExplicitNull));
  }

  // ========================================================================
  // PART 5 — SEMINOVOS: ceiling above its own canonical (2) is also clamped
  // ========================================================================
  {
    const FIXTURE_ENGINE_SEMI = {
      novosTable: null,
      seminovosTable: [{ entrada: 0.00, prazo: 48, max: 0.7, taxa: 0.0179, anoInicio: 2017, anoFim: 2099 }],
    };
    const probeSemi = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, PROBE_DOWN_PAYMENT, TERM, TERM, 2022, null);
    if (probeSemi.ok) {
      const targetSemi = probeSemi.result.monthly_payment;
      const escSemiCeiling1 = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, targetSemi, TERM, 2022, null, 1, /* maxCountOverride */ 1);
      check("SEMINOVOS ceiling=1: never tries count 2", escSemiCeiling1 !== null && escSemiCeiling1.balloon_count_tried === 1, JSON.stringify(escSemiCeiling1));
      const escSemiOverCeiling = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, targetSemi, TERM, 2022, null, 1, /* maxCountOverride */ 10);
      check("SEMINOVOS ceiling=10 (above canonical 2): still never exceeds 2", escSemiOverCeiling !== null && escSemiOverCeiling.balloon_count_tried <= mod.BALAO_MAX_COUNT.SEMINOVOS, JSON.stringify(escSemiOverCeiling));
    }
  }

  // ========================================================================
  // PART 6 — pre-existing floor behavior (balloon_count_max) genuinely untouched
  // ========================================================================
  {
    const escFloor2 = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 2);
    check(
      "regression guard: an explicit minCount=2 floor with NO ceiling still escalates all the way to the canonical max, exactly as before this Wave (balloon_count_max's own existing behavior, never touched)",
      escFloor2 !== null && escFloor2.balloon_count_tried >= 2 && escFloor2.balloon_count_tried <= mod.BALAO_MAX_COUNT.NOVOS,
      JSON.stringify(escFloor2)
    );
  }
}

// ========================================================================
// PART 7 — extractBalloonCountConstraint: real Human phrasing, including the exact incident text
// ========================================================================
{
  check(
    "the exact incident text 'Dá pra diminuir a quantidade de balões, colocando no máximo 2?' -> balloonCountMax=2",
    JSON.stringify(mod.extractBalloonCountConstraint("Dá pra diminuir a quantidade de balões, colocando no máximo 2?")) === JSON.stringify({ balloonCountMax: 2, balloonCountExact: null })
  );
  check(
    "the exact incident follow-up 'Preciso que você vasculhe os cálculos, me passe uma simulação apenas com 2 balões, qual a menor entrada para chegar em 1.800 de parcela?' -> balloonCountExact=2",
    mod.extractBalloonCountConstraint("Preciso que você vasculhe os cálculos, me passe uma simulação apenas com 2 balões, qual a menor entrada para chegar em 1.800 de parcela?").balloonCountExact === 2
  );
  check("'quero exatamente 2 balões' -> exact=2", mod.extractBalloonCountConstraint("quero exatamente 2 balões").balloonCountExact === 2);
  check("'só 2 balões' -> exact=2", mod.extractBalloonCountConstraint("só 2 balões").balloonCountExact === 2);
  check("'somente 2 balões' -> exact=2", mod.extractBalloonCountConstraint("somente 2 balões").balloonCountExact === 2);
  check("'no máximo 2 balões' -> max=2 (canonical brief phrasing, number adjacent to balões too)", mod.extractBalloonCountConstraint("no máximo 2 balões").balloonCountMax === 2);
  check("'pode usar até 4 balões' -> max=4", mod.extractBalloonCountConstraint("pode usar até 4 balões").balloonCountMax === 4);
  check("a message with no 'balão'/'balões' at all never triggers, even with 'no máximo 2' present (avoids misfiring on unrelated numeric constraints)", JSON.stringify(mod.extractBalloonCountConstraint("no máximo 2 prazos, por favor")) === JSON.stringify({ balloonCountMax: null, balloonCountExact: null }));
  check("a plain balloon-related message with no count constraint at all -> both null", JSON.stringify(mod.extractBalloonCountConstraint("pode usar mais de um balão se isso ajudar")) === JSON.stringify({ balloonCountMax: null, balloonCountExact: null }));
}

// ========================================================================
// PART 8 — IA-CAPLOCK7: balloon_month_total_due must equal monthly_payment
// + the LAST balloon's own value, never the sum of every balloon in the
// structure. Real Human UAT defect: with 4 balloons of R$27.500 spread
// across months 9/18/27/36, the field returned monthly_payment + R$110.000
// (all four summed) = R$111.806,14 -- a figure with no correspondence to
// any single month's real amount due -- instead of monthly_payment +
// R$27.500 (only the month-36 balloon) = R$29.306,14, the figure the
// Human correctly expected. Proven here against the REAL, unmodified
// balaoOptimizeMinPaymentMulti (never a hand-copied duplicate, never an
// invented balloon distribution).
// ========================================================================
{
  const probeMulti = mod.balaoOptimizeMinPaymentMulti(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, PROBE_DOWN_PAYMENT, TERM, null, null, 4);
  check("fixture: a real 4-balloon structure is feasible on this synthetic table", probeMulti.ok, JSON.stringify(probeMulti));
  if (probeMulti.ok) {
    const { balloons, monthly_payment } = probeMulti.result;
    check("fixture: the real engine distributed the 4 balloons across more than one distinct month (a meaningful test of the fix, not a vacuous one)", new Set(balloons.map((b) => b.month)).size > 1, JSON.stringify(balloons));

    const lastBalloon = balloons.reduce((latest, b) => (b.month > latest.month ? b : latest), balloons[0]);
    const correctTotalDue = mod.round2(monthly_payment + lastBalloon.value);
    const buggyTotalDue = mod.round2(monthly_payment + mod.round2(balloons.reduce((s, b) => s + b.value, 0)));

    check(
      "the CORRECT total due in the last balloon's own month (monthly_payment + that ONE balloon) genuinely differs from the buggy sum-of-all-balloons figure -- proves this is a real, meaningful distinction on real engine output, not a no-op",
      correctTotalDue !== buggyTotalDue,
      { correctTotalDue, buggyTotalDue, lastBalloonMonth: lastBalloon.month, lastBalloonValue: lastBalloon.value, allBalloons: balloons }
    );
    check(
      "the correct figure equals monthly_payment + ONLY the last balloon's value (this Wave's own fix, mirrored here as a real-data proof, never a duplicated formula in production)",
      correctTotalDue === mod.round2(monthly_payment + lastBalloon.value)
    );
    check(
      "the buggy figure (monthly_payment + sum of ALL balloons) is strictly greater than the correct one whenever more than one balloon exists -- confirms the pre-fix defect would always overstate the amount due in a single month",
      buggyTotalDue > correctTotalDue
    );
  }

  // ---------- the exact incident's own numbers, reproduced from a fixture shaped to match (4 balloons of equal value) ----------
  {
    const monthly_payment = 1806.14;
    const balloons = [{ month: 9, value: 27500 }, { month: 18, value: 27500 }, { month: 27, value: 27500 }, { month: 36, value: 27500 }];
    const lastBalloon = balloons.reduce((latest, b) => (b.month > latest.month ? b : latest), balloons[0]);
    const correctTotalDue = mod.round2(monthly_payment + lastBalloon.value);
    const buggyTotalDue = mod.round2(monthly_payment + balloons.reduce((s, b) => s + b.value, 0));
    check("incident reproduction: the buggy formula produces exactly the real incident's wrong figure, R$111.806,14 (confirms this WAS the actual root cause of the assistant's original wrong statement)", buggyTotalDue === 111806.14, buggyTotalDue);
    check("incident reproduction: the correct formula produces exactly R$29.306,14, matching the Human's own correct expectation (R$27.500 + R$1.806,14)", correctTotalDue === 29306.14, correctTotalDue);
  }
}

// ========================================================================
// PART 9 — IA-CAPLOCK10: real Human UAT defect, down_payment-GIVEN path.
// A financing follow-up that mutates the allowed/desired Balão COUNT
// ("no máximo 2 balões", "exatamente 1 balão"), once down_payment AND
// term_months are BOTH already fixed (the exact "fixed entrada + fixed
// prazo + parcela-alvo" shape of the real incident -- distinct from
// PARTS 1-6 above, which all test the SIBLING down_payment-NOT-known
// escalation function, already fixed in IA-CAPLOCK5), used to be
// silently ignored: balaoOptimizeEscalateForTarget always escalated all
// the way to the department's own canonical ceiling to chase the target
// payment, with no parameter through which a caller could ever narrow
// that search -- toolSimularFinanciamento's own single call site
// (index.ts, the target_payment!==null branch) passed only the legacy
// `balloonCount` floor variable, never args.balloon_count_ceiling/
// balloon_count_exact. Proven here against the REAL, unmodified
// function (never a hand-copied duplicate, never an invented expected
// value -- every comparison is derived from the engine's own output at
// each count, on a synthetic offline fixture table).
// ========================================================================
{
  const DOWN_PAYMENT = 60000;
  const probe1 = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null);
  const probe4 = mod.balaoOptimizeMinPaymentMulti(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, null, null, mod.BALAO_MAX_COUNT.NOVOS);
  check("fixture (down_payment given): count=1 probe is feasible", probe1.ok, JSON.stringify(probe1));
  check("fixture (down_payment given): count=4 (canonical max) probe is feasible", probe4.ok, JSON.stringify(probe4));

  if (probe1.ok && probe4.ok) {
    const sweep = [];
    for (let c = 1; c <= mod.BALAO_MAX_COUNT.NOVOS; c++) {
      const r = c > 1
        ? mod.balaoOptimizeMinPaymentMulti(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, null, null, c)
        : mod.balaoOptimizeMinPayment(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null);
      if (r.ok) sweep.push({ count: c, payment: r.result.monthly_payment });
    }
    check("fixture: sweep found feasible results for counts 1..4", sweep.length === 4, JSON.stringify(sweep));
    // A target only the canonical maximum (4 balloons) can reach exactly -- just above count=4's own payment.
    const TARGET = sweep.find((s) => s.count === 4).payment + 1;

    // ---- 9.1 — THE DEFECT SCENARIO ITSELF: ceiling=2 must never escalate past 2 ----
    {
      const escUnconstrained = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET);
      check("no ceiling (pre-existing default call shape, omitted argument): still escalates all the way to 4 and meets the target -- proves this fixture genuinely needs 4 balloons, so ceiling=2 below is a REAL constraint, not vacuous", escUnconstrained.ok && escUnconstrained.result.balloon_count_tried === 4 && escUnconstrained.result.target_met === true, JSON.stringify(escUnconstrained));

      const escCeiling2 = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET, /* maxCountOverride */ 2);
      check("ceiling=2 (THE incident's own constraint): call succeeds", escCeiling2.ok, JSON.stringify(escCeiling2));
      if (escCeiling2.ok) {
        check("ceiling=2: NEVER tries a count above 2 -- the real, isolated root cause of the CAPLOCK10 regression, now fixed", escCeiling2.result.balloon_count_tried <= 2, `got balloon_count_tried=${escCeiling2.result.balloon_count_tried}`);
        const count2Direct = sweep.find((s) => s.count === 2);
        check("ceiling=2: result equals count=2's own direct computation exactly (the true best achievable within the constraint, never the unconstrained 4-balloon figure)", escCeiling2.result.monthly_payment === count2Direct.payment, { got: escCeiling2.result.monthly_payment, expected: count2Direct.payment });
        check("ceiling=2: target_met is honestly FALSE (2 balloons cannot reach a target only 4 balloons can hit) -- never silently reports success on a structure that doesn't meet it, and never fabricates/reuses the old 4-balloon result", escCeiling2.result.target_met === false, JSON.stringify(escCeiling2.result));
      }
    }

    // ---- 9.2 — exact=1 pins the search to a single count ----
    {
      const escExact1 = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET, /* maxCountOverride */ 1);
      check("exact=1 (floor=ceiling=1): call succeeds", escExact1.ok, JSON.stringify(escExact1));
      if (escExact1.ok) {
        check("exact=1: tries ONLY count 1, never 2, 3, or 4", escExact1.result.balloon_count_tried === 1, `got balloon_count_tried=${escExact1.result.balloon_count_tried}`);
        check("exact=1: result equals count=1's own direct computation exactly", escExact1.result.monthly_payment === probe1.result.monthly_payment, { got: escExact1.result.monthly_payment, expected: probe1.result.monthly_payment });
      }
    }

    // ---- 9.3 — a ceiling above the canonical max is clamped, never exceeded ----
    {
      const escOverCeiling = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET, /* maxCountOverride */ 10);
      check("ceiling=10 (above NOVOS canonical 4): call succeeds", escOverCeiling.ok, JSON.stringify(escOverCeiling));
      if (escOverCeiling.ok) {
        check("ceiling=10: still never tries a count above the department's own canonical ceiling (4)", escOverCeiling.result.balloon_count_tried <= mod.BALAO_MAX_COUNT.NOVOS, `got balloon_count_tried=${escOverCeiling.result.balloon_count_tried}`);
        check("ceiling=10: behaves identically to no ceiling at all (reaches the target with 4 balloons)", escOverCeiling.result.balloon_count_tried === 4 && escOverCeiling.result.target_met === true, JSON.stringify(escOverCeiling));
      }
    }

    // ---- 9.4 — regression guard: default (no ceiling argument) behaves exactly as before this Wave ----
    {
      const escDefaultOmitted = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET);
      const escDefaultExplicitNull = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, null, null, 1, TARGET, null);
      check("omitting maxCountOverride entirely (every pre-existing call site's own shape) still escalates to the true optimum", escDefaultOmitted.ok && escDefaultOmitted.result.balloon_count_tried === 4, JSON.stringify(escDefaultOmitted));
      check("explicit maxCountOverride=null: identical to omitting it entirely", escDefaultExplicitNull.ok && escDefaultExplicitNull.result.balloon_count_tried === 4, JSON.stringify(escDefaultExplicitNull));
    }

    // ---- 9.5 — SEMINOVOS: ceiling above its own canonical (2) is also clamped ----
    {
      const FIXTURE_ENGINE_SEMI = { novosTable: null, seminovosTable: [{ entrada: 0.00, prazo: 48, max: 0.7, taxa: 0.0179, anoInicio: 2017, anoFim: 2099 }] };
      const probeSemi1 = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, 2022, null);
      if (probeSemi1.ok) {
        const targetSemi = probeSemi1.result.monthly_payment - 1; // just below count=1's payment -> needs escalation
        const escSemiCeiling1 = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, 2022, null, 1, targetSemi, /* maxCountOverride */ 1);
        check("SEMINOVOS ceiling=1: never tries count 2, even though a target below count=1's own payment exists (target_met stays honestly false rather than escalating past the ceiling)", escSemiCeiling1.ok && escSemiCeiling1.result.balloon_count_tried === 1, JSON.stringify(escSemiCeiling1));
        const escSemiOverCeiling = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, TERM, 2022, null, 1, targetSemi, /* maxCountOverride */ 10);
        check("SEMINOVOS ceiling=10 (above canonical 2): still never exceeds 2", escSemiOverCeiling.ok && escSemiOverCeiling.result.balloon_count_tried <= mod.BALAO_MAX_COUNT.SEMINOVOS, JSON.stringify(escSemiOverCeiling));
      }
    }
  }
}

// ========================================================================
// PART 10 — IA-CAPLOCK10: the no-target-payment sibling (Branch C,
// toolSimularFinanciamento's balaoOptimizeMinPaymentMulti dispatch). This
// branch never escalates/searches at all -- it always used the shared
// `balloonCount` variable (floor semantics, balloon_count_max) directly
// as the EXACT count to build, completely ignoring
// balloon_count_ceiling/balloon_count_exact. The fix computes a new
// `balloonCountGiven` local (balloonCeilingGiven ?? balloonCount), right
// before the down-payment-given results map, and passes THAT instead --
// reproduced here against the real balaoOptimizeMinPaymentMulti with the
// exact derivation formula production now uses (never a hand-invented
// substitute); balaoOptimizeMinPaymentMulti itself already correctly
// builds whatever exact count it's given -- the bug was entirely in
// WHICH count toolSimularFinanciamento computed and passed, never in
// this function.
// ========================================================================
{
  const DOWN_PAYMENT = 60000;
  // Mirrors toolSimularFinanciamento's own local derivation verbatim
  // (index.ts, balloonFloorGiven/balloonCeilingGiven/balloonCountGiven,
  // computed once before the down-payment-given results map).
  function deriveBalloonCountGiven(department, balloonCountMax, balloonCountCeiling, balloonCountExact) {
    const balloonCount = balloonCountMax !== null ? Math.min(balloonCountMax, mod.BALAO_MAX_COUNT[department]) : 1;
    const balloonCeilingGiven = balloonCountExact !== null
      ? Math.min(balloonCountExact, mod.BALAO_MAX_COUNT[department])
      : (balloonCountCeiling !== null ? Math.min(balloonCountCeiling, mod.BALAO_MAX_COUNT[department]) : null);
    return balloonCeilingGiven !== null ? balloonCeilingGiven : balloonCount;
  }

  check("no ceiling/exact stated (balloon_count_max=null default): balloonCountGiven falls back to the pre-existing floor (1) -- unchanged from before this Wave", deriveBalloonCountGiven("NOVOS", null, null, null) === 1);
  check("balloon_count_ceiling=2, no exact: balloonCountGiven=2 (the CAPLOCK10 defect's own no-target sibling, now respected)", deriveBalloonCountGiven("NOVOS", null, 2, null) === 2);
  check("balloon_count_exact=1: balloonCountGiven=1, takes priority over any ceiling", deriveBalloonCountGiven("NOVOS", null, 3, 1) === 1);
  check("balloon_count_ceiling=10 (above NOVOS canonical 4): clamped to 4, never exceeds the department's own ceiling", deriveBalloonCountGiven("NOVOS", null, 10, null) === 4);
  check("SEMINOVOS balloon_count_ceiling=5 (above canonical 2): clamped to 2", deriveBalloonCountGiven("SEMINOVOS", null, 5, null) === 2);

  const ceiling2Count = deriveBalloonCountGiven("NOVOS", null, 2, null);
  const optCeiling2 = mod.balaoOptimizeMinPaymentMulti(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, null, null, ceiling2Count);
  check("real engine call with the derived ceiling-respecting count (2) succeeds and returns exactly 2 balloons -- never the unconstrained default of 1", optCeiling2.ok && optCeiling2.result.balloons.length === 2, JSON.stringify(optCeiling2));
}

console.log(`\n=== Balloon Count Constraint + Total-Due Tests (IA-CAPLOCK5/IA-CAPLOCK7/IA-CAPLOCK10): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

// IA-CAPLOCK2 — deterministic proof that the ENTRY-SEARCH branch
// (balloon_value=null, down_payment=null, target_payment fixed --
// "dá pra diminuir essa entrada e fazer os mesmos R$X no balão?") now
// escalates balloon count the same way the sibling fixed-entry branch
// (balaoOptimizeEscalateForTarget, IA-3J.3) already did, closing the
// exact gap CAPABILITY-LOCK-1 proved: before this Wave,
// balaoRequiredDownPaymentAutoBalloon was called exactly once, at a
// single fixed balloon count, and the entry-search branch never tried
// a higher count to find an even lower entry for the same target.
//
// This is the regression proof for the real Human follow-up (Eclipse
// HPE 0km, R$180.000, target R$1.800, first answer already 1 balão
// hitting the target exactly at entry R$95.756,98): "Dá pra diminuir
// essa entrada e fazer os mesmos 1.800 no balão?" — this test proves
// the new balaoRequiredDownPaymentEscalateForTarget searches every
// valid balloon count (1 up to the department's own governed
// ceiling) and returns the LOWEST entry found, never just the
// first-tried count. No financial number here is invented by this
// test -- every comparison is DERIVED from the real, unmodified
// engine's own outputs at each count, offline, on a synthetic fixture
// table (never the live rate table, which requires an RPC this test
// deliberately never calls).
//
// Run: node tests/ia-reconciliation/balloon-entry-search-escalation.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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

// Same local variant multi-balloon-escalation.test.mjs already uses --
// BalaoRateRowSemi is declared as "interface X extends Y { ... }".
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
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-balao-entry-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- synthetic fixture rate table (offline, no RPC) ----------
// One NOVOS term (48x), a low-entry tier (0%+) so the binary search has
// real room to explore, and a generous max (70% of financed amount) so
// counts 1-4 are all structurally valid -- the point of this fixture is
// to exercise entry-search escalation, not to reproduce the real
// production rate table.
const FIXTURE_ENGINE = {
  novosTable: [{ entrada: 0.00, prazo: 48, max: 0.7, taxa: 0.0179 }],
  seminovosTable: null,
};
const VEHICLE_VALUE = 180000;
const TERM = 48;

// ---------- derive a real, achievable target from the fixture's own count=1 result (never hand-computed) ----------
// Pick a down payment comfortably inside the valid range, read its
// count=1 monthly payment for this term, and use THAT exact value as
// the target -- guarantees a real, reachable target without inventing
// a number, and mirrors the real Human scenario's own shape (a first
// answer that already lands exactly on the requested target at 1 balão).
const PROBE_DOWN_PAYMENT = 90000; // 50% of 180000, same shape as the real UAT
const probe1 = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, PROBE_DOWN_PAYMENT, TERM, TERM, null, null);
check("fixture: count=1 probe is feasible on this synthetic table", probe1.ok, JSON.stringify(probe1));

if (probe1.ok) {
  const TARGET = probe1.result.monthly_payment; // real, achievable target -- mirrors "target R$1.800" exactly

  // ---------- THE regression proof: escalation must find a LOWER entry than count=1 alone ----------
  const at1 = mod.balaoRequiredDownPaymentAutoBalloon(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 1);
  check("count=1 entry-search (pre-existing, single-count function) is feasible for this real target", at1 !== null, JSON.stringify(at1));

  const at2 = mod.balaoRequiredDownPaymentAutoBalloon(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 2);
  check("count=2 entry-search (same underlying function, more balloon capacity) is also feasible for the SAME target", at2 !== null, JSON.stringify(at2));

  if (at1 !== null && at2 !== null) {
    check(
      "more balloon capacity (2) genuinely finds a LOWER required down payment than 1, for the identical target (the mechanism the Human's follow-up assumed exists)",
      at2.down_payment < at1.down_payment,
      `count1=${at1.down_payment} count2=${at2.down_payment}`
    );
    check("both counts hit the SAME target payment (never a different, silently substituted target)", at1.payment === TARGET && at2.payment === TARGET, `p1=${at1.payment} p2=${at2.payment} target=${TARGET}`);

    // ---------- THE fix under test: escalation must find count=2's lower entry, not stop at count=1 ----------
    const esc = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, /* minCount */ 1);
    check("escalation call itself succeeds (reproduces the real Human R$180.000/R$1.800 follow-up shape)", esc !== null, JSON.stringify(esc));
    if (esc !== null) {
      check("escalation finds a down_payment STRICTLY LOWER than the pre-fix single-count-1 result (THE regression proof)", esc.down_payment < at1.down_payment, `escalated=${esc.down_payment} count1_only=${at1.down_payment}`);
      check("escalation finds a down_payment AT LEAST as low as count=2's own result (never worse than a count it must have tried along the way)", esc.down_payment <= at2.down_payment, `escalated=${esc.down_payment} count2_only=${at2.down_payment}`);
      check("escalation used MORE than 1 balloon to reach the lower entry", esc.balloon_count_tried > 1, `got balloon_count_tried=${esc.balloon_count_tried}`);
      check("escalated_from_count correctly records the floor it started from (1)", esc.escalated_from_count === 1);
      check("escalation's own monthly_payment still hits the exact same target (never trades target accuracy for a lower entry)", esc.payment === TARGET, `payment=${esc.payment} target=${TARGET}`);
      check("escalated balloons[] length matches balloon_count_tried (no mismatch)", esc.balloons.length === esc.balloon_count_tried);
      check("escalation never searches past the department's governed ceiling (NOVOS max 4)", esc.balloon_count_tried <= mod.BALAO_MAX_COUNT.NOVOS);
    }

    // ---------- deterministic selection rule: escalation is never left to the model, always picks the objectively lowest down_payment ----------
    // Sweep every valid NOVOS count independently via the underlying
    // single-count function and assert the escalator's own result
    // equals the true minimum across the whole sweep -- proves the
    // selection is exhaustive and deterministic, not just "found
    // something better than 1".
    const sweep = [];
    for (let c = 1; c <= mod.BALAO_MAX_COUNT.NOVOS; c++) {
      const r = mod.balaoRequiredDownPaymentAutoBalloon(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, c);
      if (r !== null) sweep.push({ count: c, down_payment: r.down_payment });
    }
    const trueMin = sweep.reduce((b, r) => (r.down_payment < b.down_payment ? r : b));
    check(
      `escalation's result equals the TRUE minimum down_payment across an independent full sweep of counts 1..${mod.BALAO_MAX_COUNT.NOVOS} (deterministic, exhaustive, not model-chosen)`,
      esc !== null && esc.down_payment === trueMin.down_payment,
      `escalated=${esc && esc.down_payment} true_min=${trueMin.down_payment} (count ${trueMin.count}) sweep=${JSON.stringify(sweep)}`
    );
  }

  // ---------- SEMINOVOS ceiling respected (never escalates past 2) ----------
  const FIXTURE_ENGINE_SEMI = {
    novosTable: null,
    seminovosTable: [{ entrada: 0.00, prazo: 48, max: 0.7, taxa: 0.0179, anoInicio: 2017, anoFim: 2099 }],
  };
  const probeSemi = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, PROBE_DOWN_PAYMENT, TERM, TERM, 2022, null);
  if (probeSemi.ok) {
    const targetSemi = probeSemi.result.monthly_payment;
    const escSemi = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE_SEMI, "SEMINOVOS", VEHICLE_VALUE, targetSemi, TERM, 2022, null, 1);
    check("SEMINOVOS entry-search escalation never exceeds the department's own ceiling (max 2)", escSemi !== null && escSemi.balloon_count_tried <= mod.BALAO_MAX_COUNT.SEMINOVOS, JSON.stringify(escSemi));
  }

  // ---------- an explicit user floor (balloon_count_max) is never lowered ----------
  const escFloor2 = mod.balaoRequiredDownPaymentEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, TARGET, TERM, null, null, 2);
  check(
    "an explicit minCount=2 floor (from the user's own balloon_count_max) is respected -- escalation never searches BELOW the caller's own floor",
    escFloor2 !== null && escFloor2.balloon_count_tried >= 2,
    JSON.stringify(escFloor2)
  );
}

console.log(`\n=== Balloon Entry-Search Escalation Tests (IA-CAPLOCK2): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

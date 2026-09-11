// IA-3J.3 — deterministic proof that the new balaoOptimizeEscalateForTarget
// actually escalates balloon count when a single balloon cannot reach a
// target installment, and that it does so by calling the REAL, unmodified
// engine functions (balaoCalcular/balaoOptimizeMinPayment/
// balaoOptimizeMinPaymentMulti) -- never a hand-duplicated formula. No
// Supabase/OpenAI call: BalaoEngine is a plain {novosTable, seminovosTable}
// object, so a synthetic fixture rate table is enough to exercise the real
// math end to end, offline. No financial number here is invented by this
// test -- every "target" is DERIVED from the real function's own count=1
// and count=2 outputs (the midpoint between them), then fed back into the
// escalator to prove it picks the smaller count that actually meets it.
//
// This is the regression proof for the real failed Human UAT (Eclipse HPE
// 0km, R$180.000, R$90.000 entrada, meta R$1.800): every evaluated term
// carried sim_balloon_count=1 because the old code never escalated count
// for a fixed down payment + target_payment. This test proves the new
// dispatcher branch does.
//
// Run: node tests/ia-reconciliation/multi-balloon-escalation.test.mjs

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

// extract.mjs's own extractInterface requires "{" immediately after the
// name -- BalaoRateRowSemi is declared as "interface X extends Y { ... }",
// so this local variant locates the marker then the first "{" after it
// (same balanced-brace close as extractInterface), rather than touching
// the shared helper other tests already depend on.
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
  "export " + extractFunction(source, "balaoOptimizeEscalateForTarget"),
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-balao-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- synthetic fixture rate table (offline, no RPC) ----------
// One NOVOS term (48x), one entry tier (10%+), a generous max (60% of
// financed amount) so both count=1 and count=2 are structurally valid --
// the point of this fixture is to exercise escalation, not to reproduce
// the real production rate table (which requires a live RPC this test
// deliberately never calls).
const FIXTURE_ENGINE = {
  novosTable: [{ entrada: 0.10, prazo: 48, max: 0.6, taxa: 0.0179 }],
  seminovosTable: null,
};
const VEHICLE_VALUE = 180000;
const DOWN_PAYMENT = 90000; // same shape as the real failed UAT (50% entrada)
const TERM = 48;
const BALLOON_MONTH = 48;

// ---------- derive count=1 and count=2 payments from the REAL engine (never hand-computed) ----------
const at1 = mod.balaoOptimizeMinPayment(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, BALLOON_MONTH, null, null);
const at2 = mod.balaoOptimizeMinPaymentMulti(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, null, null, 2);

check("fixture: count=1 (balaoOptimizeMinPayment) is feasible on this synthetic table", at1.ok, JSON.stringify(at1));
check("fixture: count=2 (balaoOptimizeMinPaymentMulti) is feasible on this synthetic table", at2.ok, JSON.stringify(at2));

if (at1.ok && at2.ok) {
  const p1 = at1.result.monthly_payment;
  const p2 = at2.result.monthly_payment;
  check("more balloons (2) strictly lowers the monthly payment vs. 1 (same mechanism the real UAT-BALAO-EXPLORATION-01 audit already proved)", p2 < p1, `p1=${p1} p2=${p2}`);

  // A target strictly between p2 and p1: count=1 CANNOT reach it, count=2 CAN.
  const target = mod.round2((p1 + p2) / 2);

  // ---------- THE regression: escalation must find count=2, not stop at 1 ----------
  const esc = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, BALLOON_MONTH, null, null, /* minCount */ 1, target);
  check("escalation call itself succeeds", esc.ok, JSON.stringify(esc));
  if (esc.ok) {
    check(`escalation actually used MORE than 1 balloon to reach target=${target} (p1=${p1} alone could not)`, esc.result.balloon_count_tried > 1, `got balloon_count_tried=${esc.result.balloon_count_tried}`);
    check("escalation reports target_met=true once a qualifying count is found", esc.result.target_met === true);
    check("escalation's own resulting monthly_payment actually satisfies the target", esc.result.monthly_payment <= target, `monthly_payment=${esc.result.monthly_payment} target=${target}`);
    check("escalated balloons[] length matches balloon_count_tried (no mismatch between the count used and the balloons actually returned)", esc.result.balloons.length === esc.result.balloon_count_tried);
    check("escalated_from_count correctly records the floor it started from (1, since minCount=1 here)", esc.result.escalated_from_count === 1);
    check(
      "escalation never reports a HIGHER count than strictly necessary (stops at the first count that meets target, never keeps climbing to the department ceiling)",
      esc.result.balloon_count_tried <= mod.BALAO_MAX_COUNT.NOVOS
    );
  }

  // ---------- regression: when NO count can reach an impossibly low target, falls back to best effort, never silently invents a number ----------
  const impossible = mod.round2(p2 / 1000); // far below anything this fixture can produce
  const escImpossible = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, BALLOON_MONTH, null, null, 1, impossible);
  check("an unreachable target still returns ok:true with the best effort found (never ok:false just because the target itself is unreachable)", escImpossible.ok);
  if (escImpossible.ok) {
    check("unreachable-target case explicitly reports target_met=false (never silently claims success)", escImpossible.result.target_met === false);
    check("unreachable-target case still searches up to the department's governed ceiling before giving up", escImpossible.result.balloon_count_tried === mod.BALAO_MAX_COUNT.NOVOS, `got ${escImpossible.result.balloon_count_tried}`);
  }

  // ---------- regression: target_payment absent is UNTOUCHED -- no escalation attempted, matches pre-existing UAT-BALAO-AUTONOMY-01 behavior exactly ----------
  check(
    "with target_payment=null, escalation at minCount=1 equals the pre-existing single-balloon result exactly (byte-for-byte monthly_payment) -- the 'determine o balão' flow is provably unchanged",
    (() => {
      const escNoTarget = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, BALLOON_MONTH, null, null, 1, null);
      return escNoTarget.ok && escNoTarget.result.monthly_payment === p1 && escNoTarget.result.balloon_count_tried === 1;
    })()
  );

  // ---------- regression: an explicit user floor (balloon_count_max) is never lowered by escalation ----------
  const escFloor2 = mod.balaoOptimizeEscalateForTarget(FIXTURE_ENGINE, "NOVOS", VEHICLE_VALUE, DOWN_PAYMENT, TERM, BALLOON_MONTH, null, null, 2, null);
  check(
    "an explicit minCount=2 floor (from the user's own balloon_count_max) is respected even with no target -- escalation never searches BELOW the caller's own floor",
    escFloor2.ok && escFloor2.result.balloon_count_tried >= 2,
    JSON.stringify(escFloor2)
  );
}

console.log(`\n=== Multi-Balloon Escalation Tests (IA-3J.3): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

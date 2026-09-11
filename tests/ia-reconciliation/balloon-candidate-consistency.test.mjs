// IA-3J.4A -- proves the balloon candidate-selection split-brain found
// in real Human UAT is fixed, using the REAL, unmodified engine
// functions (balaoOptimizeEscalateForTarget, balaoSelectBestCandidate)
// against the REAL Balão Novos TRADICIONAL rate table (fetched
// read-only this Wave directly from public.simulador_balao_linhas/
// simulador_base_batches -- the same tables the governed RPC
// simulador_get_balao_zerokm itself reads; embedded here as an offline
// fixture since no live Supabase/OpenAI call is made by this suite).
//
// This is the exact real scenario: NOVOS, Eclipse HPE 0km, R$180.000,
// entrada R$90.000, meta de parcela R$1.800, prazo flexível. The real
// failed UAT showed the structured card selecting term=48x/R$1.602,89
// (minimum monthly payment among feasible terms) while the model's own
// prose, reading the identical results array, correctly reported
// term=30x/R$1.766,94 as closest to the target -- two different
// "winners" from the same tool call. This test proves the fix makes
// the ONE selection authority (balaoSelectBestCandidate) agree with
// what "chegar o mais perto possível de R$1.800" actually means:
// minimum |payment - target|, not minimum payment.
//
// Run: node tests/ia-reconciliation/balloon-candidate-consistency.test.mjs

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
  return `type ${name} =${m[1]};`;
}

const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  extractTypeAlias(source, "SimDepartment"),
  "export " + extractConst(source, "BALAO_MAX_COUNT"),
  "export " + extractConst(source, "BALAO_PRAZOS"),
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "balaoTaxaInterna"),
  "export " + extractFunction(source, "balaoBaseInterna"),
  "export " + extractInterface(source, "BalaoRateRow"),
  "export " + extractFunction(source, "balaoPlanoNovos"),
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
  "export " + extractFunction(source, "balaoSelectBestCandidate"),
].join("\n\n");
const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-candidate-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- the REAL Balão Novos TRADICIONAL rate table (read-only fetch this Wave) ----------
const REAL_NOVOS_TABLE = [
  { entrada: 0.10, prazo: 12, max: 1.0, taxa: 0.02354 },
  { entrada: 0.10, prazo: 24, max: 1.0, taxa: 0.019995 },
  { entrada: 0.10, prazo: 30, max: 1.0, taxa: 0.019715 },
  { entrada: 0.10, prazo: 36, max: 1.0, taxa: 0.019145 },
  { entrada: 0.10, prazo: 40, max: 1.0, taxa: 0.01876 },
  { entrada: 0.10, prazo: 42, max: 1.0, taxa: 0.01875 },
  { entrada: 0.10, prazo: 48, max: 1.0, taxa: 0.018865 },
  { entrada: 0.20, prazo: 12, max: 1.0, taxa: 0.0225 },
  { entrada: 0.20, prazo: 24, max: 1.0, taxa: 0.0191 },
  { entrada: 0.20, prazo: 30, max: 1.0, taxa: 0.0186 },
  { entrada: 0.20, prazo: 36, max: 1.0, taxa: 0.018 },
  { entrada: 0.20, prazo: 40, max: 1.0, taxa: 0.0176 },
  { entrada: 0.20, prazo: 42, max: 1.0, taxa: 0.0177 },
  { entrada: 0.20, prazo: 48, max: 1.0, taxa: 0.0177 },
];
const engine = { novosTable: REAL_NOVOS_TABLE, seminovosTable: null };

const VEHICLE_VALUE = 180000;
const DOWN_PAYMENT = 90000;
const TARGET = 1800;
const DEPARTMENT = "NOVOS";

// ---------- reproduce the dispatcher's own per-term loop (unchanged this Wave) ----------
const results = mod.BALAO_PRAZOS.map((t) => {
  const esc = mod.balaoOptimizeEscalateForTarget(engine, DEPARTMENT, VEHICLE_VALUE, DOWN_PAYMENT, t, t, null, null, 1, TARGET);
  if (!esc.ok) return { term_months: t, feasible: false, monthly_payment: null, balloons: null };
  return { term_months: t, feasible: true, monthly_payment: esc.result.monthly_payment, balloons: esc.result.balloons };
});

check(
  "real engine reproduces the exact Human-reported 30x prose candidate (R$1.766,94, 2 balloons at months 15 and 30)",
  (() => {
    const t30 = results.find((r) => r.term_months === 30);
    return t30 && t30.monthly_payment === 1766.94 && t30.balloons.length === 2 &&
      t30.balloons[0].month === 15 && t30.balloons[1].month === 30;
  })(),
  JSON.stringify(results.find((r) => r.term_months === 30))
);
check(
  "real engine reproduces the exact Human-reported 48x structured-card candidate (R$1.602,89, 2 balloons at months 24 and 48)",
  (() => {
    const t48 = results.find((r) => r.term_months === 48);
    return t48 && t48.monthly_payment === 1602.89 && t48.balloons.length === 2 &&
      t48.balloons[0].month === 24 && t48.balloons[1].month === 48;
  })(),
  JSON.stringify(results.find((r) => r.term_months === 48))
);

// ---------- THE regression: the single selection authority must now pick 30x, not 48x ----------
const selected = mod.balaoSelectBestCandidate(results, TARGET);
check(
  "balaoSelectBestCandidate now selects 30x (closest to target) -- NOT 48x (the old, wrong 'minimum payment' winner)",
  selected && selected.term_months === 30,
  JSON.stringify(selected)
);
check(
  "the selected candidate's payment matches the model's own (correct) prose exactly: R$1.766,94",
  selected && selected.monthly_payment === 1766.94
);
check(
  "the selected candidate is genuinely the minimum |payment - target| among ALL 7 evaluated terms (not asserted by construction -- checked against every candidate)",
  results.filter(r => r.feasible).every(r => Math.abs(selected.monthly_payment - TARGET) <= Math.abs(r.monthly_payment - TARGET))
);

// ---------- regression: no-target behavior is completely unchanged (still picks minimum payment) ----------
const selectedNoTarget = mod.balaoSelectBestCandidate(results, null);
check(
  "WITHOUT a target_payment, selection reverts to minimum payment (48x) -- the pre-existing UAT-BALAO-AUTONOMY-01 behavior is untouched",
  selectedNoTarget && selectedNoTarget.term_months === 48 && selectedNoTarget.monthly_payment === 1602.89,
  JSON.stringify(selectedNoTarget)
);

// ---------- regression: an infeasible-only set still returns null, never a fabricated winner ----------
const allInfeasible = [{ term_months: 12, feasible: false, monthly_payment: null }, { term_months: 24, feasible: false, monthly_payment: null }];
check(
  "an all-infeasible candidate set returns null (never fabricates a winner)",
  mod.balaoSelectBestCandidate(allInfeasible, TARGET) === null
);

// ---------- prompt-level: the corrected description text is present, the old misleading claim is gone ----------
function extractTemplateLiteralConst(src, name) {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  const bodyStart = start + marker.length;
  const end = src.indexOf("`;", bodyStart);
  return src.slice(bodyStart, end);
}
const prompt = extractTemplateLiteralConst(source, "SYSTEM_PROMPT");
check(
  "the prompt now correctly describes 'closest to target' selection (not 'never exceed the ceiling')",
  /o motor devolve o prazo\/balão cuja parcela fica MAIS PRÓXIMA da parcela-alvo/.test(prompt)
);
check(
  "the old, now-inaccurate 'a parcela-alvo vira só um teto informativo' framing is gone from the PARCELA-ALVO SEM ENTRADA rule",
  !/a parcela-alvo vira só um teto informativo/.test(prompt)
);
check(
  "optimization_objective's new value (min_distance_to_target) is documented in the prompt",
  /min_distance_to_target/.test(prompt)
);
check(
  "the tool schema's priority parameter description no longer falsely claims 'nunca ultrapasse o alvo' as the unconditional behavior",
  !/'min_monthly_payment' com target_payment é tratado como teto \(nunca ultrapasse o alvo\)/.test(source)
);

console.log(`\n=== Balloon Candidate Consistency Tests (IA-3J.4A): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

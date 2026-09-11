// IA-3J.3A — proves the recommendation-vs-comparison presentation gate
// end to end through the REAL, unmodified buildBlockFromToolResult
// (never a hand-duplicated dispatcher), using the real
// buildBalaoMetricsBlock/buildBalaoOptimizeComparisonBlock/
// buildBalaoRankingBlock it calls. No Supabase/OpenAI call -- these are
// pure presentation-formatting functions over a synthetic result object
// shaped exactly like the real dispatcher's own output (balloon_optimized,
// results[], top-level best-term fields) -- the same shape IA-3J.3's own
// test already used, now exercised through the actual block-selection
// function instead of the block-builders in isolation.
//
// Run: node tests/ia-reconciliation/recommendation-presentation.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function extractTemplateLiteralConst(src, name) {
  const marker = `const ${name} = \``;
  const start = src.indexOf(marker);
  const bodyStart = start + marker.length;
  const end = src.indexOf("`;", bodyStart);
  return src.slice(bodyStart, end);
}
const prompt = extractTemplateLiteralConst(source, "SYSTEM_PROMPT");

// ---------- assemble the real block-selection pipeline ----------
const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "buildBalaoRankingBlock"),
  "export " + extractFunction(source, "buildBalaoOptimizeComparisonBlock"),
  "export " + extractFunction(source, "buildBalaoMetricsBlock"),
  "export " + extractFunction(source, "buildBlockFromToolResult"),
].join("\n\n");
const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-presentation-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- synthetic fixture: the Human scenario's own shape ----------
// Eclipse HPE 0km, R$180.000, R$90.000 entrada, meta R$1.800 -- a
// balloon_optimized, multi-term (7 BALAO_PRAZOS), target_payment result
// where the best term now carries a 2-balloon structure (the real
// IA-3J.3 escalation's own output shape). No financial number here is
// asserted as "correct" -- this test is about WHICH blocks render, not
// whether these particular numbers are right (that's multi-balloon-
// escalation.test.mjs's job, against the real engine).
function syntheticBalaoOutput() {
  return {
    mode: "payment", feasible: true, balloon_optimized: true, optimization_objective: "min_monthly_payment",
    department: "NOVOS", vehicle_value: 180000, down_payment: 90000, down_payment_percent: 50,
    financed_amount: 90000, term_months: 48, vehicle_year: null,
    target_payment: 1800, target_exceeded: false,
    monthly_payment: 1780.20, balloon_value: null, balloon_month: null,
    balloon_count: 2, balloons: [{ month: 24, value: 35000 }, { month: 48, value: 35000 }],
    balloon_month_total_due: 36780.20, max_balloon_allowed: 54000, balloon_cap_applied: null,
    results: [
      { term_months: 12, feasible: true, error: null, message: null, monthly_payment: 8200.55, balloons: [{ month: 12, value: 20000 }] },
      { term_months: 24, feasible: true, error: null, message: null, monthly_payment: 3950.10, balloons: [{ month: 24, value: 30000 }] },
      { term_months: 30, feasible: true, error: null, message: null, monthly_payment: 3100.44, balloons: [{ month: 30, value: 32000 }] },
      { term_months: 36, feasible: true, error: null, message: null, monthly_payment: 2480.33, balloons: [{ month: 36, value: 33000 }] },
      { term_months: 40, feasible: true, error: null, message: null, monthly_payment: 2150.77, balloons: [{ month: 40, value: 34000 }] },
      { term_months: 42, feasible: true, error: null, message: null, monthly_payment: 2010.05, balloons: [{ month: 42, value: 34500 }] },
      { term_months: 48, feasible: true, error: null, message: null, monthly_payment: 1780.20, balloons: [{ month: 24, value: 35000 }, { month: 48, value: 35000 }] },
    ],
    calculation_source: "test-fixture", constraints_applied: [],
  };
}

// ========================================================================
// PART 1 — RECOMMENDATION intent (show_term_comparison omitted/false)
// ========================================================================
{
  const argsRecommend = { financing_type: "BALAO", show_term_comparison: null };
  const blockOmitted = mod.buildBlockFromToolResult("simular_financiamento", argsRecommend, syntheticBalaoOutput());
  check(
    "recommendation intent (show_term_comparison omitted) returns a single block, not an array of multiple blocks",
    blockOmitted && !Array.isArray(blockOmitted)
  );
  check("that single block is the metrics card (type: 'metrics')", blockOmitted && blockOmitted.type === "metrics");
  check(
    "the metrics card correctly shows the BEST term (48x), not a truncated or wrong term",
    blockOmitted && blockOmitted.title.includes("48x")
  );
  check(
    "the metrics card correctly shows BOTH balloons of the escalated 2-balloon structure (month 24 and month 48), not just one",
    blockOmitted &&
    blockOmitted.items.some((it) => it.label.includes("mês 24")) &&
    blockOmitted.items.some((it) => it.label.includes("mês 48")) &&
    blockOmitted.items.some((it) => it.label.startsWith("Total em balões (2)"))
  );
  check(
    "no 7-term comparison table is present anywhere in the recommendation-intent output",
    blockOmitted && blockOmitted.type !== "ranking"
  );

  const argsRecommendExplicitFalse = { financing_type: "BALAO", show_term_comparison: false };
  const blockFalse = mod.buildBlockFromToolResult("simular_financiamento", argsRecommendExplicitFalse, syntheticBalaoOutput());
  check(
    "explicit show_term_comparison=false behaves identically to omitted (both mean recommendation intent)",
    blockFalse && !Array.isArray(blockFalse) && blockFalse.type === "metrics"
  );
}

// ========================================================================
// PART 2 — EXPLICIT COMPARISON intent (show_term_comparison=true)
// ========================================================================
{
  const argsCompare = { financing_type: "BALAO", show_term_comparison: true };
  const blocks = mod.buildBlockFromToolResult("simular_financiamento", argsCompare, syntheticBalaoOutput());
  check("explicit comparison intent returns an array of multiple blocks (comparison capability preserved, not destroyed)", Array.isArray(blocks) && blocks.length === 2);
  if (Array.isArray(blocks)) {
    check("first block is the full comparison ranking table", blocks[0].type === "ranking");
    check("comparison table still has all 7 terms (internal exploration fully preserved, nothing hidden when explicitly requested)", blocks[0].items.length === 7);
    check("second block is still the primary recommendation metrics card (comparison ADDS to the recommendation, never replaces it)", blocks[1].type === "metrics");
    check(
      "the comparison table itself still carries no raw 'feasible'/'error_message' keys (IA-3J.3's fix still holds under the new gate)",
      !blocks[0].items.some((it) => "feasible" in it || "error_message" in it)
    );
  }
}

// ========================================================================
// PART 3 — single-term case (no ambiguity, behaves as before)
// ========================================================================
{
  const singleTermOutput = { ...syntheticBalaoOutput(), results: [syntheticBalaoOutput().results[6]] };
  const blockSingle = mod.buildBlockFromToolResult("simular_financiamento", { financing_type: "BALAO", show_term_comparison: null }, singleTermOutput);
  check(
    "a single evaluated term never triggers a comparison table regardless of the flag (buildBalaoOptimizeComparisonBlock itself already requires 2+ results)",
    blockSingle && !Array.isArray(blockSingle) && blockSingle.type === "metrics"
  );
}

// ========================================================================
// PART 4 — prompt-level: the new parameter is documented correctly
// ========================================================================
{
  check(
    "show_term_comparison is documented with explicit recommendation-vs-comparison guidance",
    /RECOMENDAÇÃO vs\. COMPARAÇÃO \(show_term_comparison, IA-3J\.3A/.test(prompt)
  );
  check(
    "the rule explicitly states this is presentation-only, never a calculation change",
    /Isto é só uma escolha de APRESENTAÇÃO — nunca de cálculo/.test(prompt)
  );
  check(
    "detail-on-demand follow-up (re-calling with show_term_comparison=true, reusing known data) is explicitly described",
    /chame de novo com os mesmos dados e show_term_comparison=true/.test(prompt)
  );
  check(
    "show_term_comparison is present in the tool's required[] array (OpenAI strict-mode schema requirement)",
    /"balloon_count_max", "show_term_comparison", "priority"/.test(source)
  );
}

console.log(`\n=== Recommendation Presentation Tests (IA-3J.3A): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

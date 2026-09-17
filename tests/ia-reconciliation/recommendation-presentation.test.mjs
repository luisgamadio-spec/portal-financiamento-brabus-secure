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
import { readSource, extractFunction, extractComposedPrompt } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// IA-3J.4I -- SYSTEM_PROMPT was split into canonical PROMPT_* blocks,
// reassembled as FULL_SYSTEM_PROMPT; extractComposedPrompt (extract.mjs)
// rebuilds that exact text from the real source, never a hand-copied
// duplicate.
const prompt = extractComposedPrompt(source, "FULL_SYSTEM_PROMPT");

// ---------- assemble the real block-selection pipeline ----------
const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "buildBalaoRankingBlock"),
  "export " + extractFunction(source, "buildBalaoOptimizeComparisonBlock"),
  "export " + extractFunction(source, "buildBalaoMetricsBlock"),
  "export " + extractFunction(source, "buildSimulationMetricsBlock"),
  "export " + extractFunction(source, "buildSimulationRankingBlock"),
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
    // IA-CAPLOCK5 -- balloon_count_ceiling/balloon_count_exact were
    // inserted into the required[] array between balloon_count_max and
    // show_term_comparison (two new strict-mode-required fields for the
    // stateful balloon-count-constraint fix) -- this check's own
    // literal text updated to match, same structural intent (adjacency
    // proves show_term_comparison is still present, right after the
    // balloon-count-family fields).
    "show_term_comparison is present in the tool's required[] array (OpenAI strict-mode schema requirement)",
    /"balloon_count_max", "balloon_count_ceiling", "balloon_count_exact", "show_term_comparison", "priority"/.test(source)
  );
}

// ========================================================================
// PART 5 (IA-3J.4A) — LINEAR gets the same recommendation/comparison gate
// ========================================================================
{
  // Synthetic LINEAR mode=payment output with all 8 real-UAT-reported
  // terms (12/18/24/30/36/42/48/60) -- the exact shape Human saw dumped
  // in full. financing_type is omitted/null here since that's how a
  // default LINEAR call arrives (never "LINEAR" literally required).
  function syntheticLinearOutput() {
    return {
      mode: "payment", department: "NOVOS", vehicle_value: 180000, down_payment: 90000,
      down_payment_percent: 50, financed_amount: 90000, vehicle_year: null,
      results: [
        { term_months: 12, payment: 8120.50 }, { term_months: 18, payment: 5720.10 },
        { term_months: 24, payment: 4510.90 }, { term_months: 30, payment: 3820.44 },
        { term_months: 36, payment: 3380.15 }, { term_months: 42, payment: 3080.60 },
        { term_months: 48, payment: 3160.10 }, { term_months: 60, payment: 2984.38 },
      ],
      calculation_source: "test-fixture", constraints_applied: [],
    };
  }

  const argsRecommend = { financing_type: null, show_term_comparison: null };
  const blockOmitted = mod.buildBlockFromToolResult("simular_financiamento", argsRecommend, syntheticLinearOutput());
  check("LINEAR recommendation intent returns a single metrics block, not an array", blockOmitted && !Array.isArray(blockOmitted) && blockOmitted.type === "metrics");
  check(
    "LINEAR recommendation intent shows exactly one 'Melhor parcela' line, not one line per term",
    blockOmitted && blockOmitted.items.filter((it) => it.label.startsWith("Parcela ") || it.label.startsWith("Melhor parcela")).length === 1
  );
  check(
    "no 8-term Linear dump present -- individual 'Parcela 12x'/'Parcela 18x'/etc. labels are absent",
    blockOmitted && !blockOmitted.items.some((it) => /^Parcela \d+x$/.test(it.label))
  );

  const argsCompare = { financing_type: null, show_term_comparison: true };
  const blockCompare = mod.buildBlockFromToolResult("simular_financiamento", argsCompare, syntheticLinearOutput());
  check(
    "explicit LINEAR comparison intent still lists all 8 terms (capability preserved, never destroyed)",
    blockCompare && blockCompare.type === "metrics" &&
    blockCompare.items.filter((it) => /^Parcela \d+x$/.test(it.label)).length === 8
  );

  check(
    "the prompt documents LINEAR comparison trigger phrasing ('compare os prazos do linear')",
    /compare os prazos do linear/.test(prompt)
  );
  check(
    "the prompt states Linear's own 'best' (no target concept) is the lowest payment / longest term",
    /em Linear, "melhor" sem parcela-alvo é a menor parcela entre os prazos avaliados/.test(prompt)
  );
}

// ========================================================================
// PART 6 (IA-3J.4C) — financing_card metadata (plan-card identity for the frontend)
// ========================================================================
{
  // Balão block: reuse the exact real Human scenario numbers (IA-3J.4A/4B).
  const balaoResult = {
    mode: "payment", feasible: true, balloon_optimized: true, optimization_objective: "min_distance_to_target",
    department: "NOVOS", vehicle_value: 180000, down_payment: 90000, down_payment_percent: 50,
    financed_amount: 90000, term_months: 30, vehicle_year: null,
    target_payment: 1800, target_exceeded: false, monthly_payment: 1766.94,
    balloon_value: null, balloon_month: null, balloon_count: 2,
    balloons: [{ month: 15, value: 45000 }, { month: 30, value: 45000 }],
    balloon_month_total_due: 46766.94, max_balloon_allowed: 90000, balloon_cap_applied: null,
    results: [], calculation_source: "test-fixture", constraints_applied: [],
  };
  const balaoBlock = mod.buildBalaoMetricsBlock({}, balaoResult);
  check("Balão block carries financing_card metadata", balaoBlock && balaoBlock.financing_card != null);
  if (balaoBlock && balaoBlock.financing_card) {
    const fc = balaoBlock.financing_card;
    check("financing_card.kind === 'BALAO'", fc.kind === "BALAO");
    check("financing_card.term_months matches the real selected term (30)", fc.term_months === 30);
    check("financing_card.monthly_payment matches exactly (R$1.766,94)", fc.monthly_payment === 1766.94);
    check("financing_card.balloons carries both real balloons (months 15 and 30)", fc.balloons && fc.balloons.length === 2 && fc.balloons[0].month === 15 && fc.balloons[1].month === 30);
    check("financing_card.target_distance computed correctly (R$33,06)", fc.target_distance === 33.06);
  }

  // Linear block: reuse the exact real Human scenario secondary fact (60x/R$2.984,38).
  const linearResult = {
    mode: "payment", department: "NOVOS", vehicle_value: 180000, down_payment: 90000,
    down_payment_percent: 50, financed_amount: 90000, vehicle_year: null, target_payment: 1800,
    results: [
      { term_months: 12, payment: 8120.50 }, { term_months: 18, payment: 5720.10 },
      { term_months: 24, payment: 4510.90 }, { term_months: 30, payment: 3820.44 },
      { term_months: 36, payment: 3380.15 }, { term_months: 42, payment: 3080.60 },
      { term_months: 48, payment: 3160.10 }, { term_months: 60, payment: 2984.38 },
    ],
    calculation_source: "test-fixture", constraints_applied: [],
  };
  const linearBlock = mod.buildSimulationMetricsBlock({ show_term_comparison: null }, linearResult);
  check("LINEAR block carries financing_card metadata", linearBlock && linearBlock.financing_card != null);
  if (linearBlock && linearBlock.financing_card) {
    const fc = linearBlock.financing_card;
    check("financing_card.kind === 'LINEAR'", fc.kind === "LINEAR");
    check("financing_card.term_months matches the real lowest-payment term (60x, R$2.984,38 -- the cheapest of all 8 fixture terms)", fc.term_months === 60);
    check("financing_card.target_distance is computed from the real target_payment echo (IA-3J.4C addition)", typeof fc.target_distance === "number" && fc.target_distance > 0);
  }

  // A block with no financing intent (e.g. a required_down_payment result) must not carry the metadata.
  const nonFinancingBalao = mod.buildBalaoMetricsBlock({}, { mode: "required_down_payment", feasible: true, department: "NOVOS", vehicle_value: 1, target_payment: 1, balloon_value: 1, balloon_month: 1, down_payment: 1, down_payment_percent: 1, monthly_payment: 1 });
  check("a non-'payment'-mode Balão block does not carry financing_card (metadata is scoped to the recommendation case only)", !nonFinancingBalao || nonFinancingBalao.financing_card === undefined);
}

console.log(`\n=== Recommendation Presentation Tests (IA-3J.3A): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

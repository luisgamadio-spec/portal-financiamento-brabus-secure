// IA-3K.1 — real conversational UAT fix: Antecipação presentation +
// Cash Conversion commercial intelligence.
//
// UAT-VOICE-01A (Antecipação): cálculo/velocidade aprovados,
// apresentação reprovada (grid genérico + prose duplicada).
// UAT-VOICE-01B (Cash Conversion): matemática funcional, estratégia
// comercial/apresentação insuficientes, excesso de repetição.
//
// This test proves, against the REAL current source (never a
// hand-copied duplicate): (1) buildAntecipacaoBlock/
// buildCashConversionBlock now attach settlement_card/
// cash_conversion_card presentation metadata (same contract class as
// financing_card, IA-3J.4C) while the underlying math
// (antecipacaoCalcular/cashConversionCalcular/break-even) is never
// touched; (2) the new settlement_card echoes args.balloons verbatim
// (never recomputed); (3) the Cash Conversion prompt policy elevates
// break-even, forbids fabricated external yield, and instructs
// against prose duplication; (4) MarketIntelligenceOpportunity is a
// contract-only interface, never constructed/dispatched anywhere;
// (5) every engine/formula/model/MAX_TOOL_CALLS declaration this
// Wave must not touch remains exactly-once, unchanged.
//
// Run: node tests/ia-reconciliation/settlement-cashconversion-cards.test.mjs

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readSource, extractFunction, extractConst, extractInterface } from "./extract.mjs";

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

// ---------- A. extract real functions + their type/const dependencies, assemble a runnable fixture ----------

const round2Fn = "export " + extractFunction(source, "round2");
const cashConvResultInterface = "export " + extractInterface(source, "CashConversionResult");
const cashConvCalcularFn = "export " + extractFunction(source, "cashConversionCalcular");
const cashConvRateConst = "export " + extractConst(source, "CASH_CONVERSION_APPLICATION_RATE");
const buildAntecipacaoFn = "export " + extractFunction(source, "buildAntecipacaoBlock");
const buildCashConvFn = "export " + extractFunction(source, "buildCashConversionBlock");
const marketIntelInterface = "export " + extractInterface(source, "MarketIntelligenceOpportunity");

const modText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  round2Fn, cashConvResultInterface, cashConvCalcularFn, cashConvRateConst,
  buildAntecipacaoFn, buildCashConvFn, marketIntelInterface,
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-settlement-cc-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));
const { cashConversionCalcular, buildAntecipacaoBlock, buildCashConversionBlock, CASH_CONVERSION_APPLICATION_RATE } = mod;

// ---------- B. math unchanged: real cashConversionCalcular, spot-check against the reconciled UAT sentinel ----------

{
  // UAT sentinel (already reconciled to the cent against the live
  // official engine, per cashConversionCalcular's own header comment)
  // -- re-run here as a live regression guard, not re-derived math.
  const calc = cashConversionCalcular(90000, 3563.06, 42, CASH_CONVERSION_APPLICATION_RATE);
  check("CASH_CONVERSION_APPLICATION_RATE unchanged (0.0112, 1.12% a.m.)", CASH_CONVERSION_APPLICATION_RATE === 0.0112, CASH_CONVERSION_APPLICATION_RATE);
  check("cashConversionCalcular final_financing_value unchanged (149648.52)", calc.final_financing_value === 149648.52, calc.final_financing_value);
  check("cashConversionCalcular classification unchanged (UTILIZAR)", calc.classification === "UTILIZAR", calc.classification);
  check("cashConversionCalcular break_even_rate unchanged (~0.0122)", Math.abs(calc.break_even_rate - 0.0122) < 0.0001, calc.break_even_rate);
}

// ---------- C. buildAntecipacaoBlock -- settlement_card structure, real args.balloons echo, never recomputed ----------

{
  const args = {
    term_months: 48, monthly_payment: 3500, first_due_date: "2026-10-11", settlement_date: "2027-09-11",
    scope: "all", range_from: null, range_to: null, single_installment: null,
    balloons: [{ installment_number: 30, value: 74000 }],
  };
  const result = {
    feasible: true, term_months: 48, monthly_payment: 3500, first_due_date: "2026-10-11",
    first_due_date_assumed: true, settlement_date: "2027-09-11", scope_label: "Parcelas restantes",
    installments_considered: 36, gross_total: 175500.00, balloon_total: 74000,
    discount_total: 42495.60, settlement_amount: 133004.40, discount_percent_of_gross: 24.21,
    missing_discount_data: false,
  };
  const block = buildAntecipacaoBlock(args, result);
  check("buildAntecipacaoBlock still returns the original items[] contract, untouched", Array.isArray(block.items) && block.items.length === 8, block.items && block.items.length);
  check("buildAntecipacaoBlock attaches settlement_card", !!block.settlement_card);
  const sc = block.settlement_card;
  check("settlement_card.settlement_amount = result.settlement_amount verbatim (never recomputed)", sc.settlement_amount === result.settlement_amount);
  check("settlement_card.gross_total = result.gross_total verbatim", sc.gross_total === result.gross_total);
  check("settlement_card.discount_total = result.discount_total verbatim", sc.discount_total === result.discount_total);
  check("settlement_card.discount_percent_of_gross = result.discount_percent_of_gross verbatim", sc.discount_percent_of_gross === result.discount_percent_of_gross);
  check("settlement_card.installments_considered = result.installments_considered verbatim", sc.installments_considered === result.installments_considered);
  check("settlement_card.first_due_date_assumed preserved (premise never hidden)", sc.first_due_date_assumed === true);
  check("settlement_card.balloons echoes args.balloons verbatim (same installment_number/value, never a new calculation)", JSON.stringify(sc.balloons) === JSON.stringify([{ installment_number: 30, value: 74000 }]));

  const resultNoBalloon = { ...result };
  const argsNoBalloon = { ...args, balloons: null };
  const blockNoBalloon = buildAntecipacaoBlock(argsNoBalloon, resultNoBalloon);
  check("settlement_card.balloons is [] when args.balloons is null (never fabricated)", Array.isArray(blockNoBalloon.settlement_card.balloons) && blockNoBalloon.settlement_card.balloons.length === 0);

  const infeasibleResult = { feasible: false };
  check("buildAntecipacaoBlock still returns null for infeasible results (unchanged fail-closed behavior)", buildAntecipacaoBlock(args, infeasibleResult) === null);
}

// ---------- D. buildCashConversionBlock -- cash_conversion_card structure, break-even never fabricated when null ----------

{
  const args = { capital: 90000, monthly_payment: 3563.06, term_months: 42, application_rate: null };
  const calc = cashConversionCalcular(90000, 3563.06, 42, CASH_CONVERSION_APPLICATION_RATE);
  const result = {
    capital: 90000, monthly_payment: 3563.06, term_months: 42, application_rate: CASH_CONVERSION_APPLICATION_RATE,
    rate_is_fixed_policy: true, rate_override_requested: false, requested_rate: null,
    final_financing_value: calc.final_financing_value, future_investment_value: calc.future_investment_value,
    investment_earnings: calc.investment_earnings, projected_difference: calc.projected_difference,
    classification: calc.classification, break_even_rate: calc.break_even_rate,
  };
  const block = buildCashConversionBlock(args, result);
  check("buildCashConversionBlock still returns the original items[] contract, untouched", Array.isArray(block.items) && block.items.length === 8);
  check("buildCashConversionBlock attaches cash_conversion_card", !!block.cash_conversion_card);
  const cc = block.cash_conversion_card;
  check("cash_conversion_card.capital = result.capital verbatim", cc.capital === result.capital);
  check("cash_conversion_card.application_rate = result.application_rate verbatim (still the fixed 0.0112 policy rate)", cc.application_rate === CASH_CONVERSION_APPLICATION_RATE);
  check("cash_conversion_card.break_even_rate = result.break_even_rate verbatim (same engine authority, never recalculated here)", cc.break_even_rate === result.break_even_rate);
  check("cash_conversion_card.classification = result.classification verbatim", cc.classification === result.classification);
  check("cash_conversion_card.projected_difference = result.projected_difference verbatim", cc.projected_difference === result.projected_difference);

  const resultNoBreakEven = { ...result, break_even_rate: null };
  const blockNoBreakEven = buildCashConversionBlock(args, resultNoBreakEven);
  check("cash_conversion_card.break_even_rate stays null when the engine returns null (never fabricated)", blockNoBreakEven.cash_conversion_card.break_even_rate === null);
}

// ---------- E. prompt policy: break-even elevated, anti-repetition, Market Intelligence honesty (source-level, real text) ----------

check("PROMPT_ANTECIPACAO carries the new IA-3K.1 anti-repetition bullet", /APRESENTAÇÃO \(IA-3K\.1[\s\S]{0,400}nunca um novo parágrafo relistando os mesmos números que o card já mostra/.test(source));
check("PROMPT_CASH_CONVERSION elevates break-even as a central element, not a footnote (IA-3K.1)", /BREAK-EVEN É ELEMENTO CENTRAL, NUNCA RODAPÉ \(IA-3K\.1/.test(source));
check("PROMPT_CASH_CONVERSION carries the new IA-3K.1 anti-repetition bullet", /APRESENTAÇÃO \(IA-3K\.1 — UAT real confirmou excesso de repetição\)/.test(source));
check("PROMPT_CASH_CONVERSION explicitly states Market Intelligence is not yet available (never fabricate an external yield)", /MARKET INTELLIGENCE AINDA NÃO DISPONÍVEL \(IA-3K\.1\)/.test(source));
check("PROMPT_CASH_CONVERSION forbids declaring an external yield beats break-even without a genuinely comparable unit", /nunca equiparar % do CDI, taxa anual, rentabilidade bruta\/líquida ou pré\/pós-fixado sem uma conversão confiável/.test(source));
check("PROMPT_CASH_CONVERSION's pre-existing FINANCING-FIRST honesty rules are untouched (never lie/fabricate/hide an adverse result)", /FINANCING-FIRST — POSTURA COMERCIAL \(UAT-CASH-CONVERSION-AUTONOMY-01, Parte B\)/.test(source) && /financing-first nunca significa mentir, omitir custo, inventar rentabilidade, esconder o resultado, garantir ganho, pressionar o cliente ou distorcer números/.test(source));
check("PROMPT_CASH_CONVERSION's pre-existing proportionality rule is untouched", /PROPORCIONALIDADE: quando projected_difference for pequena/.test(source));

// ---------- F. Market Intelligence: contract-only, never wired, explicit audit trail ----------

check("MarketIntelligenceOpportunity interface exists (the contract this Wave was scoped to add)", /interface MarketIntelligenceOpportunity \{/.test(source));
check("MarketIntelligenceOpportunity is never constructed anywhere in the file (contract only, not wired)", ![...source.matchAll(/:\s*MarketIntelligenceOpportunity\s*=|new MarketIntelligenceOpportunity/g)].length);
check("MarketIntelligenceOpportunity is never referenced by dispatchTool's own switch (no new tool case added)", !/case\s+"[a-z_]*market[a-z_]*"/i.test(source));
check("no new external fetch() was added this Wave (still only the one OpenAI call site)", [...source.matchAll(/await fetch\(/g)].length === 1);

// ---------- G. frozen engines/formulas/model -- exactly-once declarations, untouched ----------

check("antecipacaoCalcular itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function antecipacaoCalcular\(/g)].length === 1);
check("cashConversionCalcular itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function cashConversionCalcular\(/g)].length === 1);
check("toolSimularAntecipacao itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/async function toolSimularAntecipacao\(/g)].length === 1);
check("toolSimularCashConversion itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/async function toolSimularCashConversion\(/g)].length === 1);
check("toolSimularFinanciamento itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/async function toolSimularFinanciamento\(/g)].length === 1);
check("balaoCalcular itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function balaoCalcular\(/g)].length === 1);
check("extractFinanceEngineFirstPlan itself is never redeclared/duplicated by this Wave (exactly one declaration)", [...source.matchAll(/function extractFinanceEngineFirstPlan\(/g)].length === 1);
check("CASH_CONVERSION_APPLICATION_RATE const remains 0.0112, unchanged", /const CASH_CONVERSION_APPLICATION_RATE = 0\.0112;/.test(source));
check("MAX_TOOL_CALLS remains 5, unchanged", /const MAX_TOOL_CALLS = 5;/.test(source));
check("OPENAI_MODEL remains gpt-5.6-luna, unchanged", /const OPENAI_MODEL = "gpt-5\.6-luna";/.test(source));
check("FINANCE_SYNTHESIS_PROFILE composition untouched (Antecipação/Cash Conversion never added to it)", (() => {
  const m = /const FINANCE_SYNTHESIS_PROFILE = \[([\s\S]*?)\]\.join/.exec(source);
  return m && !/PROMPT_ANTECIPACAO|PROMPT_CASH_CONVERSION/.test(m[1]);
})());
check("FINANCE_PROMPT_PROFILE composition untouched (Antecipação/Cash Conversion never added to it)", (() => {
  const m = /const FINANCE_PROMPT_PROFILE = \[([\s\S]*?)\]\.join/.exec(source);
  return m && !/PROMPT_ANTECIPACAO|PROMPT_CASH_CONVERSION/.test(m[1]);
})());

console.log(`\n=== Settlement / Cash Conversion Cards Tests (IA-3K.1): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
if (fail > 0) process.exit(1);

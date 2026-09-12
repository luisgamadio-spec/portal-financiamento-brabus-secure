// IA-RECON-01 — deterministic financial-engine reconciliation tests.
// No OpenAI calls, no Supabase calls, no network. Every assertion runs
// against the REAL source text of
// supabase/functions/portal-ai-homolog/index.ts, extracted at test
// time (see extract.mjs) — never a hand-typed duplicate.
//
// Run: node tests/ia-reconciliation/financial-engine.test.mjs

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

// ---------- assemble a small, real, importable module from the actual source ----------
function extractTypeAlias(src, name) {
  const markerRe = new RegExp(`(?:^|\\n)type\\s+${name}\\s*=([^;\\n]*);`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractTypeAlias: "${name}" not found`);
  return `type ${name} =${m[1]};`;
}

const modText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  extractTypeAlias(source, "SimDepartment"),
  "export " + extractInterface(source, "CashConversionResult"),
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "cashConversionCalcular"),
  "export " + extractConst(source, "CASH_CONVERSION_APPLICATION_RATE"),
  "export " + extractConst(source, "BALAO_MAX_COUNT"),
  "export " + extractFunction(source, "ymd"),
  "export " + extractFunction(source, "nowInSaoPaulo"),
  "export " + extractFunction(source, "addDays"),
  "export " + extractFunction(source, "antecipacaoDefaultFirstDueDate"),
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");

const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- Gate 21: Cash Conversion 1.12% rate proof ----------
check(
  "CASH_CONVERSION_APPLICATION_RATE is the decimal fraction 0.0112",
  mod.CASH_CONVERSION_APPLICATION_RATE === 0.0112,
  `got ${mod.CASH_CONVERSION_APPLICATION_RATE}`
);

{
  const r = mod.cashConversionCalcular(10000, 999999 /* irrelevant to this assertion */, 1, mod.CASH_CONVERSION_APPLICATION_RATE);
  check(
    "capital=10000, term=1 month, official rate -> future_investment_value=10112.00 (exactly +1.12%)",
    r.future_investment_value === 10112.00,
    `got ${r.future_investment_value}`
  );
  check(
    "investment_earnings = exactly 112.00",
    r.investment_earnings === 112.00,
    `got ${r.investment_earnings}`
  );
}

// A model-requested alternate rate must NOT change the official result --
// the engine call always receives CASH_CONVERSION_APPLICATION_RATE, never
// a caller-supplied rate. Proven two ways: (a) runtime — feeding 0.90%/
// 1.50% into cashConversionCalcular directly DOES change its own output
// (proving the function is rate-sensitive, i.e. this isn't a false
// negative), and (b) source-invariant — the real call site in
// toolSimularCashConversion is proven to pass the constant, never
// args.application_rate.
{
  const official = mod.cashConversionCalcular(10000, 999999, 12, mod.CASH_CONVERSION_APPLICATION_RATE);
  const alt090 = mod.cashConversionCalcular(10000, 999999, 12, 0.009);
  const alt150 = mod.cashConversionCalcular(10000, 999999, 12, 0.015);
  check(
    "sanity: the engine IS rate-sensitive (0.90% produces a different result than 1.12%)",
    alt090.future_investment_value !== official.future_investment_value
  );
  check(
    "sanity: the engine IS rate-sensitive (1.50% produces a different result than 1.12%)",
    alt150.future_investment_value !== official.future_investment_value
  );
}

{
  // IA-3K.4 — Human decision explicitly supersedes IA-3K.3's freeze
  // interpretation: 1,12% a.m. is now a DEFAULT, not an immutable
  // constant against an explicit user override. Source-invariant: the
  // real dispatcher call site must pass a resolved `effectiveRate`
  // (requestedRate when the caller explicitly provided one, else the
  // constant) — never a raw, unindirected pass-through of the caller's
  // own field, and never skipping the constant entirely when no
  // override was requested.
  const callSite = extractFunction(source, "toolSimularCashConversion");
  const passesEffectiveRate = /cashConversionCalcular\(\s*args\.capital\s*,\s*args\.monthly_payment\s*,\s*args\.term_months\s*,\s*effectiveRate\s*\)/.test(callSite);
  const effectiveRateIsRequestedOrConstant = /effectiveRate\s*=\s*rateOverrideApplied\s*\?\s*requestedRate\s*:\s*CASH_CONVERSION_APPLICATION_RATE/.test(callSite);
  const rateOverrideAppliedMeansNonNullRequest = /rateOverrideApplied\s*=\s*requestedRate\s*!==\s*null/.test(callSite);
  check(
    "toolSimularCashConversion's real call site passes a resolved effectiveRate (never a raw args.application_rate pass-through)",
    passesEffectiveRate
  );
  check(
    "effectiveRate resolves to the user's explicit requestedRate when provided, else the CASH_CONVERSION_APPLICATION_RATE constant",
    effectiveRateIsRequestedOrConstant
  );
  check(
    "rateOverrideApplied is true exactly when the caller provided a non-null requestedRate",
    rateOverrideAppliedMeansNonNullRequest
  );
}

// ---------- Gate 18: Antecipação default first_due_date = today + 30 days ----------
{
  const d = mod.antecipacaoDefaultFirstDueDate();
  check(
    "antecipacaoDefaultFirstDueDate() returns a YYYY-MM-DD string",
    /^\d{4}-\d{2}-\d{2}$/.test(d),
    `got ${d}`
  );
  const today = mod.nowInSaoPaulo();
  const expected = mod.ymd(mod.addDays(today, 30));
  check(
    "antecipacaoDefaultFirstDueDate() == today (America/Sao_Paulo) + 30 days",
    d === expected,
    `got ${d}, expected ${expected}`
  );
}

// ---------- Balão: BALAO_MAX_COUNT caps ----------
check(
  "BALAO_MAX_COUNT.NOVOS === 4",
  mod.BALAO_MAX_COUNT.NOVOS === 4,
  `got ${mod.BALAO_MAX_COUNT.NOVOS}`
);
check(
  "BALAO_MAX_COUNT.SEMINOVOS === 2",
  mod.BALAO_MAX_COUNT.SEMINOVOS === 2,
  `got ${mod.BALAO_MAX_COUNT.SEMINOVOS}`
);

console.log(`\n=== Financial Engine Reconciliation Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

// IA-UAT-01 — Gate 12: Taxa Implícita (calcular_taxa_financiamento)
// executable validation.
//
// The source itself carries a COMMENT (portal-ai-homolog/index.ts,
// ~line 4443) claiming "Reconciliado 29 cenários ao vivo (20
// round-trip taxa-conhecida->PMT->taxa-redescoberta ... 9 casos de
// fronteira/erro)" from an earlier phase. Per the evidence hierarchy
// (a comment/prose claim is not executable proof), that claim is
// PLANNED/asserted only -- no such fixture file was ever found
// committed anywhere in the repository's history for this tool. This
// file is NEW, independent executable evidence for IA-UAT-01: it does
// NOT reproduce the original 29 scenarios (they don't exist as code
// to reproduce) and does not claim to. It generates its own round-trip
// battery directly against the real extracted bisection solver, and
// separately tests the documented boundary/error cases visible in the
// source itself (rate=0 exact, sub-zero-rate rejection, the sentinel
// nominal-total-below-capital case, NET vs CET divergence, rounding,
// the annual-derived-rate formula, and the structured block).
//
// Run: node tests/ia-reconciliation/taxa-implicita.test.mjs

import { join } from "node:path";
import { readSource, extractFunction, extractConst, extractInterface } from "./extract.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function extractInterfaceBody(name) {
  const full = extractInterface(source, name);
  return full.slice(full.indexOf("{") + 1, full.lastIndexOf("}"));
}

const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  "export " + extractFunction(source, "round2"),
  "export " + extractConst(source, "TAXA_CAD"),
  "export " + extractConst(source, "TAXA_REG"),
  "export " + extractConst(source, "TAXA_IOF_DISCOVER"),
  "export " + extractFunction(source, "taxaPricePorIteracao"),
  "export interface TaxaDescobertaResult {\n" + extractInterfaceBody("TaxaDescobertaResult") + "\n}",
  "export " + extractFunction(source, "taxaDescobrirCalcular"),
  "export interface TaxaDescobertaInput {\n" + extractInterfaceBody("TaxaDescobertaInput") + "\n}",
  "export " + extractFunction(source, "buildTaxaDescobertaBlock"),
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-uat-taxa-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- Round-trip battery: known rate -> PMT (standard PRICE
// formula, independent of the source) -> fed into the REAL extracted
// bisection solver -> must rediscover the same rate. ----------
function pricePmt(pv, i, n) {
  if (i === 0) return pv / n;
  return (pv * i) / (1 - Math.pow(1 + i, -n));
}

{
  const pvs = [10000, 50000, 100000];
  const rates = [0.005, 0.01, 0.0173, 0.02, 0.03];
  const terms = [12, 24, 36, 48, 60];
  let roundTripCount = 0, roundTripOk = 0;
  for (const pv of pvs) {
    for (const i of rates) {
      for (const n of terms) {
        const pmt = pricePmt(pv, i, n);
        const rediscovered = mod.taxaPricePorIteracao(pv, pmt, n);
        roundTripCount++;
        if (rediscovered !== null && Math.abs(rediscovered - i) < 1e-6) roundTripOk++;
      }
    }
  }
  check(
    `Round-trip battery: ${roundTripCount} known-rate -> PMT -> rediscovered-rate scenarios, all exact (tolerance 1e-6)`,
    roundTripOk === roundTripCount,
    `${roundTripOk}/${roundTripCount} passed`
  );
}

check("taxaPricePorIteracao: rate=0 exact (pmt == pv/n within 0.005) -> returns 0, not a near-zero float", mod.taxaPricePorIteracao(36000, 1000, 36) === 0);
check("taxaPricePorIteracao: pmt below the zero-rate payment -> null (no negative rate fabricated)", mod.taxaPricePorIteracao(36000, 999, 36) === null);
check("taxaPricePorIteracao: pv<=0 -> null", mod.taxaPricePorIteracao(0, 1000, 36) === null);
check("taxaPricePorIteracao: n<=0 -> null", mod.taxaPricePorIteracao(36000, 1000, 0) === null);

// ---------- taxaDescobrirCalcular: NET vs CET divergence, rounding, sentinel rejection ----------
{
  // User's own sentinel case (documented in the source comment, ~line
  // 4446): R$35.000 financed, 48x R$700 -> nominal total R$33.600,
  // BELOW the financed capital -- must be rejected before any rate
  // solve is even attempted.
  const r = mod.taxaDescobrirCalcular(35000, 48, 700);
  check("Sentinel: 35000/48x R$700 (nominal total 33600 < capital) -> ok=false, rejected before solving", r.ok === false, JSON.stringify(r));
}
{
  const r = mod.taxaDescobrirCalcular(100000, 36, 4485.75);
  check("taxaDescobrirCalcular: a real, solvable contract -> ok=true", r.ok === true, JSON.stringify(r));
  if (r.ok) {
    check(
      "taxa_net != taxa_cet_mes (NET is computed over the CAD/REG/IOF-inflated estimated total, CET over the amount exactly as informed -- never the same engine call)",
      r.result.taxa_net !== r.result.taxa_cet_mes,
      `NET=${r.result.taxa_net} CET=${r.result.taxa_cet_mes}`
    );
    check(
      "valor_total_financiado_estimado > financed_amount (CAD+REG+IOF always inflate the NET base, so a 0% CET can never coincide with a solvable NET)",
      r.result.valor_total_financiado_estimado > 100000,
      `got ${r.result.valor_total_financiado_estimado}`
    );
    const expectedEstimado = mod.round2((100000 + mod.TAXA_CAD + mod.TAXA_REG) / (1 - mod.TAXA_IOF_DISCOVER));
    check("valor_total_financiado_estimado matches the documented fixed CAD/REG/IOF formula exactly", r.result.valor_total_financiado_estimado === expectedEstimado, `got ${r.result.valor_total_financiado_estimado}, expected ${expectedEstimado}`);
    // The source computes this from the RAW, unrounded bisection rate
    // (taxaNet before its own round2-to-2-decimals step) -- only the
    // already-rounded taxa_net is exposed to this test, so recomputing
    // from it double-rounds and lands within ~0.1 percentage point of
    // the source's real value rather than bit-for-bit. That gap itself
    // is the proof it's compounding taxa_net (not reading a separate
    // field): a naive simple x12 annualization would miss by whole
    // percentage points, not hundredths.
    const expectedAnnualCompound = mod.round2((Math.pow(1 + r.result.taxa_net, 12) - 1) * 100) / 100;
    const naiveSimpleAnnual = mod.round2(r.result.taxa_net * 12 * 100) / 100;
    check(
      "annual_effective_rate_net_derived ~= compound-interest annualization of taxa_net (within double-rounding tolerance)",
      Math.abs(r.result.annual_effective_rate_net_derived - expectedAnnualCompound) < 0.001,
      `got ${r.result.annual_effective_rate_net_derived}, expected ~${expectedAnnualCompound}`
    );
    check(
      "annual_effective_rate_net_derived is NOT a naive simple x12 (clearly compounding, not linear)",
      Math.abs(r.result.annual_effective_rate_net_derived - naiveSimpleAnnual) > 0.01,
      `annual=${r.result.annual_effective_rate_net_derived}, naive x12=${naiveSimpleAnnual}`
    );
  }
}

// ---------- Structured block: no recompute, unit conversion only in the block layer ----------
{
  const args = { financed_amount: 100000, term_months: 36, payment: 4485.75 };
  const calc = mod.taxaDescobrirCalcular(100000, 36, 4485.75);
  const toolResult = {
    feasible: true, financed_amount: 100000, term_months: 36, payment: 4485.75,
    taxa_net: calc.result.taxa_net, taxa_cet_mes: calc.result.taxa_cet_mes,
    total_pago: calc.result.total_pago, juros_totais: calc.result.juros_totais,
    annual_effective_rate_net_derived: calc.result.annual_effective_rate_net_derived
  };
  const block = mod.buildTaxaDescobertaBlock(args, toolResult);
  check("buildTaxaDescobertaBlock returns a metrics block with all 7 items", block?.type === "metrics" && block.items.length === 7, JSON.stringify(block));
  const netItem = block.items.find((it) => it.label.startsWith("Taxa NET ao mês"));
  check(
    "structured block's Taxa NET item is the tool's fraction x100 (percent-point conversion only, no recompute)",
    netItem.value === mod.round2(toolResult.taxa_net * 100) && netItem.format === "percent",
    JSON.stringify(netItem)
  );

  const infeasibleResult = { feasible: false, financed_amount: 35000, term_months: 48, payment: 700, message: "x" };
  const infeasibleBlock = mod.buildTaxaDescobertaBlock(args, infeasibleResult);
  check("buildTaxaDescobertaBlock returns null for an infeasible result (no block fabricated for a rejected calculation)", infeasibleBlock === null);
}

console.log(`\n=== Taxa Implícita Executable Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

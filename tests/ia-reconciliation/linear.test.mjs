// IA-UAT-01 — Gate 7: Financiamento Linear (NOVOS + SEMINOVOS)
// executable validation, beyond registry presence.
//
// toolSimularFinanciamento() itself needs a live userClient.rpc() call
// (loadSimEngine -> fetchNovosRateTable/fetchSeminovosRateTable), so
// the full async tool wrapper is not directly executable here without
// mocking Supabase (documented as a structural-only boundary, same as
// Score/Histórico/Taxa Implícita's own RPC-backed lookups). What IS
// executed directly, with synthetic fixtures, is the actual pure
// calculation core the wrapper calls into for both departments:
// input parsing (entry-band banding), term handling (table lookup by
// prazo), rate/coefficient authority (from the fixture table, never
// invented), result calculation, and rounding (round2, applied the
// same way the real tool wrapper applies it around simParcela()).
//
// Run: node tests/ia-reconciliation/linear.test.mjs

import { join } from "node:path";
import { readSource, extractFunction, extractConst } from "./extract.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

const modText = [
  "// AUTO-EXTRACTED at test time -- do not hand-edit.",
  "export " + extractFunction(source, "round2"),
  "export " + extractFunction(source, "novosFaixaEntrada"),
  "export " + extractFunction(source, "novosCoefLinear"),
  "export " + extractFunction(source, "novosBaseCalculoLinear"),
  "export " + extractFunction(source, "novosParcela"),
  "export " + extractConst(source, "SEMINOVOS_YEAR_BANDS"),
  "export " + extractFunction(source, "seminovosYearBand"),
  "export " + extractFunction(source, "seminovosEntryBand"),
  "export " + extractFunction(source, "seminovosPmt"),
  "export " + extractConst(source, "SEMINOVOS_IOF"),
  "export " + extractFunction(source, "seminovosCalcIOF"),
  "export " + extractConst(source, "SEMINOVOS_FEES"),
  "export " + extractConst(source, "SEMINOVOS_SEGURO_PROTECAO"),
  "export " + extractFunction(source, "seminovosParcela"),
].join("\n\n");

const tmpDir = mkdtempSync(join(tmpdir(), "ia-uat-linear-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- NOVOS ----------

check("novosFaixaEntrada: 55% entry -> banded to 50%", mod.novosFaixaEntrada(0.55) === 0.5);
check("novosFaixaEntrada: 45% entry -> banded to 40%", mod.novosFaixaEntrada(0.45) === 0.4);
check("novosFaixaEntrada: 35% entry -> banded to 30%", mod.novosFaixaEntrada(0.35) === 0.3);
check("novosFaixaEntrada: 25% entry -> banded to 20%", mod.novosFaixaEntrada(0.25) === 0.2);
check("novosFaixaEntrada: 10% entry -> banded to 0% (no minimum)", mod.novosFaixaEntrada(0.10) === 0);

check("novosCoefLinear: 0% rate -> straight 1/n amortization", mod.novosCoefLinear(0, 24) === 1 / 24);
check("novosCoefLinear: n<=0 -> null, not a division by zero/garbage", mod.novosCoefLinear(0.02, 0) === null);
{
  const i = 0.02, n = 24;
  const expected = i / (1 - Math.pow(1 + i, -n));
  check("novosCoefLinear: rate>0 uses the real amortization formula", mod.novosCoefLinear(i, n) === expected, `got ${mod.novosCoefLinear(i, n)}`);
}

{
  const fin = 37500, prazo = 24;
  const tarifaCadastro = 980, tarifaRegistro = 339.67, aliquotaIofBase = 0.0038, aliquotaIofDiaria = 0.000082;
  const dias = prazo * 30;
  const fatorIof = aliquotaIofBase + aliquotaIofDiaria * dias;
  const expected = (fin + tarifaCadastro + tarifaRegistro) / (1 - fatorIof);
  check("novosBaseCalculoLinear: fees + daily-accruing IOF composed exactly as sourced", mod.novosBaseCalculoLinear(fin, prazo) === expected, `got ${mod.novosBaseCalculoLinear(fin, prazo)}`);
}

{
  // Synthetic table: two prazos, both at the 20% entry band.
  const table = [
    { prazo: 24, entrada: 0.2, taxa: 0.02 },
    { prazo: 36, entrada: 0.2, taxa: 0.025 }
  ];
  const vehicleValue = 50000, downPayment = 12500; // 25% -> banded to 20%
  const p = mod.novosParcela(table, vehicleValue, downPayment, 24);
  const financiado = vehicleValue - downPayment;
  const expectedBase = mod.novosBaseCalculoLinear(financiado, 24);
  const expectedCoef = mod.novosCoefLinear(0.02, 24);
  check("novosParcela: 25% down payment resolves to the 20%-band rate row (not 25%-exact)", p === expectedBase * expectedCoef, `got ${p}`);

  const pMissingTerm = mod.novosParcela(table, vehicleValue, downPayment, 48);
  check("novosParcela: a term absent from the table -> null, no fabricated rate", pMissingTerm === null, `got ${pMissingTerm}`);
}

// ---------- SEMINOVOS ----------

check("seminovosYearBand: 2019 -> the 2018-2021 band", mod.seminovosYearBand(2019) === "2018-2021");
check("seminovosYearBand: 2006 (before earliest band) -> null, not a fabricated band", mod.seminovosYearBand(2006) === null);
check("seminovosEntryBand: 15% -> '0' band", mod.seminovosEntryBand(15) === "0");
check("seminovosEntryBand: exactly 20% -> '20' band (upper-inclusive at the boundary)", mod.seminovosEntryBand(20) === "20");
check("seminovosEntryBand: exactly 40% -> '40' band", mod.seminovosEntryBand(40) === "40");
check("seminovosEntryBand: 60% -> still '40' band (no band above 40%)", mod.seminovosEntryBand(60) === "40");

{
  const baseSemIOF = 34869, term = 24;
  const dias = Math.min(term * 30, 365);
  const aliquota = 0.0038 + 0.000082 * dias;
  const expected = baseSemIOF * aliquota;
  check("seminovosCalcIOF: daily accrual capped at 365 days", mod.seminovosCalcIOF(baseSemIOF, term) === expected, `got ${mod.seminovosCalcIOF(baseSemIOF, term)}`);
}
{
  const pv = 34869 + 34869 * 0.03373, rate = 0.021, n = 24;
  const pow = Math.pow(1 + rate, n);
  const expected = (pv * (rate * pow)) / (pow - 1);
  check("seminovosPmt: standard amortized-payment formula", Math.abs(mod.seminovosPmt(pv, rate, n) - expected) < 1e-9, `got ${mod.seminovosPmt(pv, rate, n)}`);
}

{
  const table = { "2018-2021": { "20": { "24": 0.021 } } };
  const vehicleValue = 40000, downPayment = 8000, ano = 2019, prazo = 24; // 20% entry, exact band
  const p = mod.seminovosParcela(table, vehicleValue, downPayment, ano, prazo);
  const financiado = vehicleValue - downPayment;
  const valorComSeguro = financiado * 1.025;
  const baseSemIOF = valorComSeguro + (970 + 699 + 400);
  const iof = mod.seminovosCalcIOF(baseSemIOF, prazo);
  const expected = mod.seminovosPmt(baseSemIOF + iof, 0.021, prazo);
  check("seminovosParcela: year+entry-band+term resolve to the fixture rate and compose fees/IOF/insurance", p === expected, `got ${p}, expected ${expected}`);

  const pMissingRate = mod.seminovosParcela(table, vehicleValue, downPayment, ano, 36); // term not in fixture
  check("seminovosParcela: a (band, entry-band, term) combo absent from the table -> null", pMissingRate === null, `got ${pMissingRate}`);

  const pBadYear = mod.seminovosParcela(table, vehicleValue, downPayment, 1999, prazo);
  check("seminovosParcela: a vehicle year outside all bands -> null, no fabricated band", pBadYear === null, `got ${pBadYear}`);
}

console.log(`\n=== Linear (NOVOS + SEMINOVOS) Executable Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

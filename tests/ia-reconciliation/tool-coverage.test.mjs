// IA-UAT-01 — expanded per-tool executable validation, beyond registry
// presence (IA-RECON-01's own disclosed gap for Linear/Coparticipado/
// Subsidiado/Semestral-Anual/Taxa Implícita/Score/Histórico).
//
// Coparticipado/Subsidiado/Semestral are pure, self-contained
// calculation functions (engine/table passed as a plain argument, no
// RPC/network dependency) -- extracted and EXECUTED here with minimal,
// clearly-synthetic fixtures (no customer data, no production reads;
// Gate 30). Score/Histórico/Taxa Implícita/Linear's own tool wrapper
// depend on a live Supabase RPC or a bisection search over a larger
// surface -- validated structurally instead (dispatch/schema presence,
// already covered by structural.test.mjs) plus, where the pure
// calculation core is separable, executed directly below.
//
// Run: node tests/ia-reconciliation/tool-coverage.test.mjs

import { join } from "node:path";
import { readSource, extractFunction, extractInterface, extractConst } from "./extract.mjs";
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
  "export interface CoparticipadoModel {\n" + extractInterfaceBody("CoparticipadoModel") + "\n}",
  "export interface CoparticipadoEngine {\n" + extractInterfaceBody("CoparticipadoEngine") + "\n}",
  "export interface CoparticipadoTermResult {\n" + extractInterfaceBody("CoparticipadoTermResult") + "\n}",
  "export interface CoparticipadoCalcResult {\n" + extractInterfaceBody("CoparticipadoCalcResult") + "\n}",
  "export " + extractFunction(source, "coparticipadoCoefFor"),
  "export " + extractFunction(source, "coparticipadoCalcular"),
  "export interface SubRow {\n" + extractInterfaceBody("SubRow") + "\n}",
  "export " + extractConst(source, "SUB_PRAZOS"),
  "export " + extractConst(source, "SUB_TAXAS"),
  "export " + extractFunction(source, "subRowFor"),
  "export " + extractFunction(source, "subsidiadasCalcular"),
  "export interface SemestralRow {\n" + extractInterfaceBody("SemestralRow") + "\n}",
  "export " + extractFunction(source, "balaoTaxaInterna"),
  "export " + extractFunction(source, "balaoBaseInterna"),
  "export " + extractFunction(source, "semestralRowFor"),
  "export " + extractFunction(source, "semestralMeses"),
  "export " + extractFunction(source, "semestralCalcular"),
].join("\n\n");

function extractInterfaceBody(name) {
  const full = extractInterface(source, name); // "interface Name { ...body... }"
  return full.slice(full.indexOf("{") + 1, full.lastIndexOf("}"));
}

const tmpDir = mkdtempSync(join(tmpdir(), "ia-uat-"));
const modPath = join(tmpDir, "extracted.ts");
writeFileSync(modPath, modText, "utf8");
const mod = await import("file://" + modPath.replace(/\\/g, "/"));

// ---------- Coparticipado (Gate 9) ----------
// Synthetic fixture, structurally valid, not extracted from any real
// rate table.
const copEngine = {
  models: [{ name: "MODELO TESTE", entry: 0.6, rebate: 0.05, hpe: 0.5, brabus: 0.5, rates: { 24: 1.99 } }],
  txCoef: { 24: { "1.99": 0.045 } }
};
{
  const model = copEngine.models[0];
  const r = mod.coparticipadoCalcular(copEngine, model, 200000, 120000, [24]);
  check("Coparticipado: sale=200000, entry=120000 (exactly min 60%) -> valid=true", r.valid === true, JSON.stringify(r));
  check("Coparticipado: financed = sale - entry = 80000", r.financed === 80000, `got ${r.financed}`);
  check(
    "Coparticipado: 24x term resolves a coefficient and produces a non-null payment",
    r.terms[0].payment !== null && r.terms[0].payment > 0,
    JSON.stringify(r.terms)
  );
  check("Coparticipado: rebate_total = financed * model.rebate = 80000*0.05 = 4000", r.rebate_total === 4000, `got ${r.rebate_total}`);
  check("Coparticipado: rebate_brabus = rebate_total * model.brabus = 2000", r.rebate_brabus === 2000, `got ${r.rebate_brabus}`);
  check("Coparticipado: final_sale_value = sale - rebate_brabus = 198000", r.final_sale_value === 198000, `got ${r.final_sale_value}`);

  const rBelowMin = mod.coparticipadoCalcular(copEngine, model, 200000, 100000, [24]);
  check("Coparticipado: entry below the 60% minimum -> invalid=true, valid=false", rBelowMin.invalid === true && rBelowMin.valid === false, JSON.stringify(rBelowMin));

  const rNoCoef = mod.coparticipadoCalcular(copEngine, model, 200000, 120000, [36]);
  check("Coparticipado: a term with no registered coefficient (36x) -> payment=null, not a fabricated number", rNoCoef.terms[0].payment === null, JSON.stringify(rNoCoef.terms));
}

// ---------- Subsidiado (Gate 10) ----------
// subsidiadasCalcular() does NOT iterate the table's own rows -- it
// iterates the module-level SUB_TAXAS x SUB_PRAZOS combinations and
// looks each one up in the table via subRowFor(), so the fixture's
// taxa/prazo values must actually land on the real constants (0,
// 0.0049, 0.0099, 0.0119 x 12,15,18,24,30,36,48,60) or every
// combination misses and options comes back empty.
{
  const table = [
    { prazo: 24, taxa: 0.0049, coef: 0.048, rebate: 0.02 },
    { prazo: 36, taxa: 0.0099, coef: 0.036, rebate: 0.03 }
  ];
  // IA-CAPLOCK2: the canonical business rule is entrada STRICTLY ABOVE
  // 50% -- exactly 50% does NOT qualify (PROMPT_FINANCE_SUBSIDIADAS'
  // own text always said this; the engine's own gate previously
  // allowed pctEntrada===0.50 through, a real prompt-vs-engine
  // contradiction this fixture now locks correctly). Exact-cent
  // fixtures on bem=100000 avoid any floating-point boundary ambiguity
  // (each percentage below is an exact decimal of 100000; only the
  // 50.00% case sits exactly on the boundary, and division by 2 is
  // always exact in IEEE754 double precision).
  const rBelow1 = mod.subsidiadasCalcular(table, 100000, 49990, null); // 49.99%
  check("Subsidiado: entrada=49,99% -> ok=false (below the boundary)", rBelow1.ok === false, JSON.stringify(rBelow1));

  const rExactly50 = mod.subsidiadasCalcular(table, 100000, 50000, null); // exactly 50.00%
  check("Subsidiado: entrada=exactly 50,00% -> ok=false (REJECTED -- exactly 50% never qualifies)", rExactly50.ok === false, JSON.stringify(rExactly50));

  const rAbove1 = mod.subsidiadasCalcular(table, 100000, 50010, null); // 50.01%
  check("Subsidiado: entrada=50,01% -> ok=true (first eligible cent above the boundary)", rAbove1.ok === true, JSON.stringify(rAbove1));
  if (rAbove1.ok) {
    const financed1 = 100000 - 50010;
    check("Subsidiado: financed = bem - entrada = 49990 at 50,01%", rAbove1.financed === financed1, `got ${rAbove1.financed}`);
    check("Subsidiado: returns one option per matched table row (2) at 50,01%", rAbove1.options.length === 2, `got ${rAbove1.options.length}`);
    check(
      "Subsidiado: prazo<=24 option's payment = financed * coef, rounded, at 50,01%",
      rAbove1.options[0].payment === mod.round2(financed1 * 0.048),
      JSON.stringify(rAbove1.options[0])
    );
    check(
      "Subsidiado: prazo>24 option's payment = (financed + 2500) * coef, rounded, at 50,01%",
      rAbove1.options[1].payment === mod.round2((financed1 + 2500) * 0.036),
      JSON.stringify(rAbove1.options[1])
    );
  }

  const rAbove2 = mod.subsidiadasCalcular(table, 100000, 51000, null); // 51.00%
  check("Subsidiado: entrada=51,00% -> ok=true (comfortably above the boundary)", rAbove2.ok === true, JSON.stringify(rAbove2));
  if (rAbove2.ok) {
    check("Subsidiado: financed = bem - entrada = 49000 at 51,00%", rAbove2.financed === 49000, `got ${rAbove2.financed}`);
    check("Subsidiado: returns one option per matched table row (2) at 51,00%", rAbove2.options.length === 2, `got ${rAbove2.options.length}`);
  }

  const rBelowMin = mod.subsidiadasCalcular(table, 100000, 40000, null);
  check("Subsidiado: entrada=40% -> below the boundary -> ok=false", rBelowMin.ok === false, JSON.stringify(rBelowMin));

  const rInvalid = mod.subsidiadasCalcular(table, 100000, 150000, null);
  check("Subsidiado: entrada > bem -> ok=false, not a negative/garbage financed value", rInvalid.ok === false, JSON.stringify(rInvalid));
}

// ---------- Semestral / Anual (Gate 11) ----------
{
  const table = [{ prazo: 36, taxa: 1.6, entrada: 0.3 }];
  const rSem = mod.semestralCalcular(table, 100000, 30000, 36, "semestral");
  check("Semestral: bem=100000, entrada=30000 (exact table minimum), prazo=36 -> ok=true", rSem.ok === true, JSON.stringify(rSem));
  const mesesSem = mod.semestralMeses(36, "semestral");
  check("Semestral: 36-month term produces semestral markers every 6 months (6 markers)", mesesSem.length === 6 && mesesSem[0] === 6 && mesesSem[5] === 36, JSON.stringify(mesesSem));
  const mesesAnual = mod.semestralMeses(36, "anual");
  check("Anual: 36-month term produces annual markers every 12 months (3 markers)", mesesAnual.length === 3 && mesesAnual[2] === 36, JSON.stringify(mesesAnual));

  const rBelowMin = mod.semestralCalcular(table, 100000, 20000, 36, "semestral");
  check("Semestral: entrada below the table's own minimum -> ok=false, not silently accepted", rBelowMin.ok === false, JSON.stringify(rBelowMin));

  const rNoRow = mod.semestralCalcular(table, 100000, 30000, 48, "semestral");
  check("Semestral: a term absent from the table -> ok=false, no fabricated rate", rNoRow.ok === false, JSON.stringify(rNoRow));
}

console.log(`\n=== Tool Coverage Executable Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

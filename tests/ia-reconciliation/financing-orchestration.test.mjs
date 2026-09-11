// IA-3J.3 — regression coverage for the three remaining defects found in
// the real failed Human UAT (Eclipse HPE 0km recommendation scenario):
// campaign auto-dispatch, redundant re-clarification of already-stated
// facts, and raw internal field names leaking into a Human-facing card.
// Prompt-text checks here follow the same discipline as
// concise-policy.test.mjs (semantic presence/absence against the REAL
// live SYSTEM_PROMPT, never a hand-copied excerpt); the block-builder
// check calls the REAL, unmodified buildBalaoOptimizeComparisonBlock
// function directly against a synthetic result object (no Supabase/
// OpenAI call needed -- this function is pure presentation formatting).
//
// Run: node tests/ia-reconciliation/financing-orchestration.test.mjs

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
  if (start === -1) throw new Error(`extractTemplateLiteralConst: marker for "${name}" not found`);
  const bodyStart = start + marker.length;
  const end = src.indexOf("`;", bodyStart);
  if (end === -1) throw new Error(`extractTemplateLiteralConst: no closing backtick for "${name}"`);
  return src.slice(bodyStart, end);
}
const prompt = extractTemplateLiteralConst(source, "SYSTEM_PROMPT");

// ========================================================================
// PART 1 — campaign gating (prompt-level semantic checks)
// ========================================================================
{
  check(
    "the new CAMPANHAS SOB DEMANDA rule exists",
    /CAMPANHAS SOB DEMANDA \(IA-3J\.3/.test(prompt)
  );
  check(
    "it explicitly excludes Coparticipado/Subsidiadas/Rebate from the default recommendation space",
    /Coparticipado, Taxas Subsidiadas e Rebate NÃO entram no espaço padrão de recomendação\/comparação/.test(prompt)
  );
  check(
    "default space is explicitly Linear + Balão only",
    /o padrão é Linear \+ Balão/.test(prompt)
  );
  check(
    "explicit campaign trigger phrases are present (tem subsidiado / rebate / coparticipado)",
    /"tem subsidiado\?", "tem taxa zero\?", "simule com rebate", "quanto de rebate\?", "tem coparticipado\?"/.test(prompt)
  );
  check(
    "an optional, short, consent-gated follow-up offer is specified (never auto-run)",
    /Se quiser, também verifico se rebate, subsidiado ou coparticipado melhora a parcela/.test(prompt)
  );
  check(
    "the commercial-cost principle is stated explicitly: proximity to target never justifies using a subsidy automatically",
    /nunca significa "use qualquer subsídio disponível para minimizar matematicamente a distância até o alvo"/.test(prompt)
  );
  check(
    "Coparticipado's extra data requirement (model/version) is explicitly scoped to only when Coparticipado itself is being evaluated",
    /dados adicionais \(ex\. versão exata do modelo\) só devem ser pedidos quando Coparticipado estiver de fato sendo avaliado/.test(prompt)
  );
  check(
    "explicit instruction that missing Coparticipado-only data must never block the ordinary recommendation",
    /a falta desse dado NUNCA bloqueia a recomendação comum/.test(prompt)
  );
  check(
    "Subsidized on explicit request returns the relevant option(s), not all 32 rows by default",
    /nunca as 32 linhas completas por padrão/.test(prompt)
  );
  check(
    "rebate evaluation asks for the store's minimum acceptable sale value instead of assuming it",
    /Qual o valor mínimo de venda que a loja precisa preservar\?/.test(prompt)
  );

  // Old, now-corrected language must be gone from the BALÃO ESPONTÂNEO
  // rule specifically -- this is the exact sentence that caused
  // Subsidized to be treated as part of the automatic candidate space.
  check(
    "the old 'e, quando elegíveis, Coparticipado/Subsidiadas' auto-inclusion clause is no longer in the BALÃO ESPONTÂNEO rule",
    !/considere Balão no espaço de opções \(junto de Linear e, quando elegíveis, Coparticipado\/Subsidiadas\)/.test(prompt)
  );
  check(
    "BALÃO ESPONTÂNEO itself is preserved (Balão still default-on) — only the campaign clause was removed",
    /considere Balão no espaço de opções \(junto de Linear\) sempre que for elegível/.test(prompt)
  );

  // The pre-existing REBATE EXISTE EM DOIS PRODUTOS rule is untouched --
  // it only fires when the user's criterion IS rebate, which is already
  // an explicit trigger, so it does not conflict with the new gate.
  check(
    "the pre-existing REBATE EXISTE EM DOIS PRODUTOS rule (fires only when rebate is the user's own stated criterion) is untouched",
    /REBATE EXISTE EM DOIS PRODUTOS, NÃO SÓ UM: quando o critério for rebate/.test(prompt)
  );
}

// ========================================================================
// PART 2 — context reuse / redundant clarification (prompt-level)
// ========================================================================
{
  check(
    "'0 km' resolves to NOVOS without asking, absent contradictory context",
    /"0 km" ou "zero km" resolve para NOVOS automaticamente, sem perguntar/.test(prompt)
  );
  check(
    "a new rule forbids re-asking facts already given in the same request/conversation",
    /REAPROVEITE FATOS JÁ INFORMADOS NO MESMO PEDIDO OU NA CONVERSA \(IA-3J\.3/.test(prompt)
  );
  check(
    "the rule explicitly lists vehicle value/department/entrada/target/optimization intent as already-resolved when stated in natural language",
    /valor do veículo, departamento, entrada \(valor informado, mesmo que em texto corrido\), parcela-alvo e intenção de otimização/.test(prompt)
  );
  check(
    "a genuinely-missing single datum (e.g. whether term may vary) may still be asked — but alone, never bundled with already-answered questions",
    /pergunte SÓ esse, numa frase curta — nunca empacotado junto de perguntas sobre dados que já foram respondidos/.test(prompt)
  );
  check(
    "a stated fixed entrada is not re-questioned ('a entrada é fixa?'); entry-variation is offered only as an AFTER-the-fact option",
    /não pergunte "a entrada é fixa\?"/.test(prompt) && /se puder variar a entrada, também consigo otimizar/.test(prompt)
  );
}

// ========================================================================
// PART 3 — raw tool-field leakage (block-builder behavior, real function)
// ========================================================================
{
  const fnText = "export " + extractFunction(source, "buildBalaoOptimizeComparisonBlock")
    .replace(/^function /, "function "); // extractFunction returns body starting at "function" already
  const modText = [
    "// AUTO-EXTRACTED at test time -- do not hand-edit.",
    "export " + extractFunction(source, "round2"),
    fnText,
  ].join("\n\n");
  const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-block-"));
  const modPath = join(tmpDir, "extracted.ts");
  writeFileSync(modPath, modText, "utf8");
  const mod = await import("file://" + modPath.replace(/\\/g, "/"));

  // Synthetic result object shaped exactly like the real dispatcher's
  // balloon_optimized multi-term comparison output (balloon_optimized,
  // optimization_objective, results[] with feasible/error/message mixed
  // in with the real sim_* fields) -- this is the EXACT shape the real
  // failed UAT produced (7 terms, one infeasible-looking row included
  // for realism).
  const syntheticResult = {
    balloon_optimized: true,
    optimization_objective: "min_monthly_payment",
    department: "NOVOS",
    results: [
      { term_months: 12, feasible: true, error: null, message: null, monthly_payment: 8200.55, balloons: [{ month: 12, value: 20000 }] },
      { term_months: 48, feasible: true, error: null, message: null, monthly_payment: 1920.11, balloons: [{ month: 48, value: 90000 }] },
      { term_months: 30, feasible: false, error: "saldo_negativo", message: "Saldo negativo.", monthly_payment: null, balloons: null },
    ],
  };
  const block = mod.buildBalaoOptimizeComparisonBlock({}, syntheticResult);

  check("buildBalaoOptimizeComparisonBlock still returns a real ranking block for this shape", block && block.type === "ranking");
  if (block) {
    const allKeys = new Set(block.items.flatMap((it) => Object.keys(it)));
    check(
      "'feasible' is no longer a rendered item key (this is the exact raw label a real Human UAT reported seeing)",
      !allKeys.has("feasible"),
      JSON.stringify([...allKeys])
    );
    check(
      "'error_message' is no longer a rendered item key",
      !allKeys.has("error_message"),
      JSON.stringify([...allKeys])
    );
    check(
      "the real, useful fields (sim_payment, sim_balloon, sim_balloon_count) are still present -- this is a removal of noise, not of information",
      allKeys.has("sim_payment") && allKeys.has("sim_balloon") && allKeys.has("sim_balloon_count")
    );
    check(
      "the infeasible term (30x) still renders with null values (feasibility is still conveyed structurally, just not as its own labeled column)",
      block.items.find((it) => it.name === "30x").sim_payment === null
    );
  }
}

console.log(`\n=== Financing Orchestration Tests (IA-3J.3): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

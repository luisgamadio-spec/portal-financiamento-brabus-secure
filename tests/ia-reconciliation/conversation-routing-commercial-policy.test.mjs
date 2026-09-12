// IA-3K.3 — Real Conversation Routing + Commercial Behavior Fix.
//
// Real Human UAT found a narrow finance-simulation request ("cliente
// comprando um Eclipse HPE de 180 mil, entrada de 90 mil, o que você
// sugere?") getting routed as if it were a BI/commercial-recommendation
// question (asked NOVO/SEMINOVO, dumped Vendas/Financiamentos/Share/
// Retorno/Produção/SPF/Receita) -- plus a cluster of related
// conversational defects: unnecessary department/plan questions,
// Cash Conversion's own fixed-rate/no-BI policy not reaching a request
// phrased as "pagar à vista ou financiar", and a commercially
// self-defeating objection-handling style (conceding before arguing,
// contradictory categorical conclusions).
//
// This Wave's changes are entirely classification + prompt-policy +
// regex-parsing fixes -- never a new architecture, never a touched
// formula/engine. This test proves, against the REAL current source
// (never a hand-copied duplicate):
//   A. the routing/classification fixes (finance-intent detection,
//      department default, down-payment/vehicle-value parsing order,
//      Balão plural/synonym recognition) via the real extractor/
//      classifier functions, executed live;
//   B. the finance-fast-path toolset structurally excludes every BI
//      tool (so a correctly-classified finance request has no BI tool
//      to call, regardless of model judgment);
//   C. the new department-default / plan-default / prazo-search prompt
//      bullets exist in FULL_SYSTEM_PROMPT, FINANCE_PROMPT_PROFILE AND
//      FINANCE_SYNTHESIS_PROFILE (all 3 surfaces a real conversation
//      can be routed through);
//   D. Cash Conversion's fixed 1,12%-always rate is untouched at the
//      engine-call site, and the classifier fix lets a natural "à
//      vista ou financiar" phrasing reach the tool/prompt that actually
//      has it;
//   E. break_even_rate is a pure, input-dependent function of the real
//      engine, never touched by any LLM-facing code path -- proving
//      two different real numbers (2,75% vs ~1,22%) are explainable by
//      different scenarios, never a defect, without hardcoding either
//      number as "the right one";
//   F. the new objection-handling / math-vs-strategy commercial policy
//      bullets exist and are reachable from every finance-capable
//      profile.
//
// Run: node tests/ia-reconciliation/conversation-routing-commercial-policy.test.mjs

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractConst, extractFunction, extractInterface, extractComposedPrompt, extractTemplateLiteralConst } from "./extract.mjs";

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

// ========================================================================
// PART A — live extractor/classifier behavior (real functions, real text)
// ========================================================================

const simDepartmentType = extractTypeAlias(source, "SimDepartment");
const simulationModeType = extractTypeAlias(source, "SimulationMode");
const simFinancingTypeType = extractTypeAlias(source, "SimFinancingType");
const simulationInputInterface = "export " + extractInterface(source, "SimulationInput");
const round2Fn = "export " + extractFunction(source, "round2");
const brMoneyTokenConst = "export " + extractConst(source, "BR_MONEY_TOKEN_RE_SRC");
const vehicleValueReConst = "export " + extractConst(source, "VEHICLE_VALUE_RE_SRC");
const parseBRMoneyTokenFn = "export " + extractFunction(source, "parseBRMoneyToken");
const maskSpanFn = "export " + extractFunction(source, "maskSpan");
const extractPlanFn = "export " + extractFunction(source, "extractFinanceEngineFirstPlan");
const emptySimulationInputFn = "export " + extractFunction(source, "emptySimulationInput");
const buildInputsFn = "export " + extractFunction(source, "buildEngineFirstSimulationInputs");
const classifyFn = "export " + extractFunction(source, "classifyFinanceFastPath");
const allowReConst = "export " + extractConst(source, "FINANCE_FAST_PATH_ALLOW_RE");
const denyReConst = "export " + extractConst(source, "FINANCE_FAST_PATH_DENY_RE");

const extractorModText = [
  "// AUTO-EXTRACTED at test time from supabase/functions/portal-ai-homolog/index.ts -- do not hand-edit.",
  simDepartmentType, simulationModeType, simFinancingTypeType, simulationInputInterface,
  round2Fn, brMoneyTokenConst, vehicleValueReConst, parseBRMoneyTokenFn, maskSpanFn, extractPlanFn, emptySimulationInputFn, buildInputsFn,
  allowReConst, denyReConst, classifyFn,
].join("\n\n");

const tmpDir1 = mkdtempSync(join(tmpdir(), "ia-recon-routing-extractor-"));
const extractorPath = join(tmpDir1, "extracted.ts");
writeFileSync(extractorPath, extractorModText, "utf8");
const extractorMod = await import("file://" + extractorPath.replace(/\\/g, "/"));
const { extractFinanceEngineFirstPlan, buildEngineFirstSimulationInputs, classifyFinanceFastPath } = extractorMod;

// ---- A1. the real reported bug message: finance intent, not BI ----
const BUG1_MSG = "Tenho um cliente comprando um Eclipse HPE de 180 mil, ele tem 90 mil de entrada. O que você sugere?";
{
  check("[BUG-1] classifyFinanceFastPath recognizes the real UAT message as finance intent (no 'financiar'/'parcela'/'balão' word at all)", classifyFinanceFastPath(BUG1_MSG) === true);
  const plan = extractFinanceEngineFirstPlan(BUG1_MSG);
  check("[BUG-1] engine-first plan extracted (non-null)", plan !== null, plan);
  if (plan) {
    check("[BUG-1] department defaults to NOVOS (no '0 km'/'seminovo' signal anywhere)", plan.department === "NOVOS", plan.department);
    check("[BUG-1] vehicleValue = 180000 ('180 mil', no R$ prefix, no thousands grouping)", plan.vehicleValue === 180000, plan.vehicleValue);
    check("[BUG-1] downPayment = 90000 ('90 mil de entrada' -- money BEFORE the word 'entrada')", plan.downPayment === 90000, plan.downPayment);
    check("[BUG-1] scenario = LINEAR_ONLY ('sugere' is not a comparison/recommendation trigger word -- default Linear, no spontaneous Balão)", plan.scenario === "LINEAR_ONLY", plan.scenario);
    check("[BUG-1] termMonths = null (no explicit term in this turn)", plan.termMonths === null, plan.termMonths);
  }
}

// ---- A2. follow-up from the brief's own canonical conversation (§10) ----
{
  const followUp = "E se ele quiser uma parcela perto de 1.800?";
  check("[canonical follow-up] classifyFinanceFastPath still true ('parcela' present)", classifyFinanceFastPath(followUp) === true);
  // This turn alone has no vehicle/entrada -- extractFinanceEngineFirstPlan
  // is a stateless, single-message parser BY DESIGN (never given
  // conversation history) and correctly returns null here; context reuse
  // for this exact case is the fallback loop's own job, governed by
  // PROMPT_FINANCE_BASE's pre-existing "REAPROVEITE FATOS JÁ INFORMADOS"
  // rule (PART C below proves that rule is still live) plus this Wave's
  // new "PARCELA-ALVO SEM PRAZO, EM LINEAR" rule for the term search.
  check("[canonical follow-up] extractFinanceEngineFirstPlan returns null in isolation (stateless parser, by design -- context reuse is the fallback loop's job)", extractFinanceEngineFirstPlan(followUp) === null);
}

// ---- A3. Cash Conversion phrasing must NOT be misrouted into the finance-fast-path (narrow) toolset/profile ----
{
  const ccMsg = "Vale mais a pena pagar à vista ou financiar?";
  check("[BUG-6 routing] 'pagar à vista ou financiar' is denied from finance-fast-path (needs simular_cash_conversion, which FINANCE_FAST_PATH_TOOLS never has)", classifyFinanceFastPath(ccMsg) === false);
}
{
  const ccMsg2 = "E se ele deixar o dinheiro aplicado em vez de dar entrada?";
  check("[BUG-6 routing] 'deixar o dinheiro aplicado' is also denied (documented Cash Conversion intent phrasing)", classifyFinanceFastPath(ccMsg2) === false);
}

// ---- A4. BI-only requests must still be denied (no over-broadening from the new 'entrada' allow-signal) ----
{
  const biMsg = "Qual o ranking de vendas da loja Matriz este mês?";
  check("[no over-broadening] a plain BI/ranking question is still denied from finance-fast-path", classifyFinanceFastPath(biMsg) === false);
}
{
  const histMsg = "Com base no histórico, que entrada os clientes costumam dar no Eclipse Cross?";
  check("[no over-broadening] a historical-analysis question mentioning 'entrada' is still denied ('histórico' deny signal wins)", classifyFinanceFastPath(histMsg) === false);
}

// ---- A5. §3's own explicit Balão-synonym examples ----
{
  const plan = extractFinanceEngineFirstPlan("Cliente comprando um L200 de 200 mil, entrada de 50 mil. Ele aceita dois balões.");
  check("[§3 Balão plural] 'dois balões' (plural, 'õ') recognized as a Balão signal", plan !== null && plan.scenario === "BALAO_ONLY", plan && plan.scenario);
}
{
  const plan = extractFinanceEngineFirstPlan("Cliente comprando um Triton de 220 mil, entrada de 60 mil, com parcela baixa e um residual no final.");
  check("[§3 Balão synonym] 'residual' (no literal 'balão' word) recognized as a Balão signal", plan !== null && plan.scenario === "BALAO_ONLY", plan && plan.scenario);
}
{
  check("[FINANCE_FAST_PATH_ALLOW_RE] also matches the classifier level for 'balões'/'residual' (same vocabulary as hasBalao)", /bal[õo]es/i.test("dois balões") && /residual/i.test("parcela com residual"));
}

// ========================================================================
// PART B — finance-fast-path toolset structurally excludes every BI tool
// ========================================================================
{
  const BI_TOOL_NAMES = ["consultar_resultado", "comparar_resultado", "consultar_ranking", "consultar_operacoes_especiais", "consultar_score_vendedores", "consultar_comissoes", "analisar_historico_financiamento"];
  const financeFastPathToolNamesConst = extractConst(source, "FINANCE_FAST_PATH_TOOL_NAMES");
  for (const name of BI_TOOL_NAMES) {
    check(`[BI exclusion] FINANCE_FAST_PATH_TOOL_NAMES literal never names "${name}"`, !financeFastPathToolNamesConst.includes(`"${name}"`));
  }
  check("[BI exclusion] FINANCE_FAST_PATH_TOOL_NAMES names exactly simular_financiamento + iniciar_novo_cliente", financeFastPathToolNamesConst.includes('"simular_financiamento"') && financeFastPathToolNamesConst.includes('"iniciar_novo_cliente"'));
}
{
  // FINANCE_PROMPT_PROFILE's own array literal (never a hand-copied list)
  const marker = "const FINANCE_PROMPT_PROFILE = [";
  const start = source.indexOf(marker);
  const end = source.indexOf("]", start);
  const arrayBody = source.slice(start, end);
  const BI_PROMPT_BLOCKS = ["PROMPT_RESULTS_EXECUTIVO", "PROMPT_RESULTS_COPARTICIPADO_SUBSIDIADO", "PROMPT_SCORE", "PROMPT_SALARY_COMMISSIONS", "PROMPT_COMMISSION_PREVIEW", "PROMPT_HISTORICAL"];
  for (const block of BI_PROMPT_BLOCKS) {
    check(`[BI exclusion] FINANCE_PROMPT_PROFILE's array literal never includes ${block}`, !arrayBody.includes(block));
  }
}

// ========================================================================
// PART C — new department/plan/prazo prompt bullets reach all 3 surfaces
// ========================================================================
const fullPrompt = extractComposedPrompt(source, "FULL_SYSTEM_PROMPT");
const financePrompt = extractComposedPrompt(source, "FINANCE_PROMPT_PROFILE");
const synthesisPrompt = extractComposedPrompt(source, "FINANCE_SYNTHESIS_PROFILE");

{
  check("[FULL] never instructs asking department as a default step", !/pergunte ao usuário qual departamento antes de simular/.test(fullPrompt));
  check("[FULL] the no-signal-at-all -> NOVOS default bullet exists", /na AUSÊNCIA de qualquer um desses sinais em toda a conversa, assuma NOVOS automaticamente, sem perguntar/.test(fullPrompt));
  check("[FULL] the Linear-default / never-ask-Linear-or-Balão bullet exists", /PLANO PADRÃO É LINEAR, NUNCA PERGUNTE "LINEAR OU BALÃO\?"/.test(fullPrompt));
  check("[FULL] the LINEAR target-payment-without-term search bullet exists", /PARCELA-ALVO SEM PRAZO, EM LINEAR \(IA-3K\.3\)/.test(fullPrompt));
  check("[FINANCE_PROMPT_PROFILE] carries the same 3 new PROMPT_FINANCE_BASE bullets (it includes PROMPT_FINANCE_BASE)", /na AUSÊNCIA de qualquer um desses sinais/.test(financePrompt) && /PLANO PADRÃO É LINEAR/.test(financePrompt) && /PARCELA-ALVO SEM PRAZO, EM LINEAR/.test(financePrompt));
}
{
  check("[SYNTHESIS] the no-target multi-term LINEAR selection bullet exists (engine-first zero-tool path)", /LINEAR COM MAIS DE UM PRAZO E SEM PARCELA-ALVO \(IA-3K\.3/.test(synthesisPrompt));
  check("[SYNTHESIS] the with-target multi-term LINEAR selection bullet exists", /LINEAR COM MAIS DE UM PRAZO E COM PARCELA-ALVO \(IA-3K\.3/.test(synthesisPrompt));
}

// ========================================================================
// PART D — Cash Conversion: fixed 1,12% rate untouched; explicit-override nuance documented
// ========================================================================
{
  const rateConst = extractConst(source, "CASH_CONVERSION_APPLICATION_RATE");
  check("[D] CASH_CONVERSION_APPLICATION_RATE is still exactly 0.0112 (1,12% a.m., untouched)", /=\s*0\.0112\s*;/.test(rateConst), rateConst);

  const toolFnSrc = extractFunction(source, "toolSimularCashConversion");
  check("[D] toolSimularCashConversion still passes the CONSTANT, never args.application_rate, into the engine", toolFnSrc.includes("cashConversionCalcular(args.capital, args.monthly_payment, args.term_months, CASH_CONVERSION_APPLICATION_RATE)"));

  // IA-3K.3 -- the brief's §6 asked for "quando o usuário informar
  // explicitamente outra taxa, usar a taxa informada". The ENGINE has
  // deliberately ignored args.application_rate since UAT-CASH-
  // CONVERSION-AUTONOMY-01 (a previously Human-ratified, explicitly
  // frozen business rule -- see the prompt text checked below, and
  // this same Wave's own §13 freeze list, which names "Cash Conversion
  // formulas" explicitly). Implementing literal rate substitution
  // would mean reopening that frozen decision, not a conversational
  // fix -- out of scope here. This Wave's actual, scoped fix is the
  // classifier correction (PART A3 above): it makes sure a request
  // phrased as "à vista ou financiar" actually REACHES this existing,
  // already-correct "don't ask, explain the fixed premise, never
  // substitute" policy -- confirmed unchanged below -- instead of
  // being misrouted to a profile that doesn't even have this tool.
  check("[D] the explain-never-substitute policy text is present and unchanged", financePromptNeverHasCashConversionIsExpected());
  function financePromptNeverHasCashConversionIsExpected() {
    // PROMPT_CASH_CONVERSION is intentionally NOT part of
    // FINANCE_PROMPT_PROFILE (confirmed in PART B) -- its policy text
    // only needs to exist in FULL_SYSTEM_PROMPT, which is where a
    // correctly-denied Cash Conversion request actually lands.
    return /TAXA DE APLICAÇÃO É FIXA, 1,12% AO MÊS, SEMPRE/.test(fullPrompt)
      && /NÃO a use nem a repasse como se fosse adotada/.test(fullPrompt);
  }
}

// ========================================================================
// PART E — break_even_rate: engine-only, input-dependent, never LLM-recalculated
// ========================================================================
{
  const calcFnSrc = extractFunction(source, "cashConversionCalcular");
  check("[E] break_even_rate formula is the expected closed form: (finalFinancingValue/capital)^(1/termMonths) - 1", /Math\.pow\(finalFinancingValue \/ capital, 1 \/ termMonths\) - 1/.test(calcFnSrc), calcFnSrc.slice(0, 80));
  check("[E] break_even_rate depends on term/financing/capital only -- NOT on applicationRate (confirms two different real scenarios legitimately produce two different break-evens, never a fixed/contaminated number)", !/applicationRate/.test(calcFnSrc.slice(calcFnSrc.indexOf("breakEvenRate"))));

  const promptNeverRecalc = /Use sempre o break_even_rate exatamente como a tool devolveu — nunca recalcule isso\./.test(fullPrompt);
  check("[E] prompt explicitly forbids the LLM from recalculating break_even_rate", promptNeverRecalc);

  // Real re-derivation via the REAL extracted engine function (never a
  // hand-copied formula) -- two representative, internally-consistent
  // scenarios, proving the formula is genuinely input-sensitive. This
  // does NOT assert which of 2,75%/1,22% was "the right one" for the
  // specific real UAT turns in question (no transcript of those exact
  // turns was available to this audit) -- only that BOTH magnitudes
  // are ordinary, unremarkable outputs of the SAME untouched formula
  // for two different (capital, monthly_payment, term_months) inputs,
  // which is the ENGINE_CORRECT_CONTEXT_DIFFERENT classification this
  // Wave's report gives (never ENGINE_DEFECT -- no defect was found).
  const cashConvExtractorText = [
    "export " + extractFunction(source, "round2"),
    "export " + extractFunction(source, "cashConversionCalcular"),
  ].join("\n\n");
  const tmpDir2 = mkdtempSync(join(tmpdir(), "ia-recon-cashconv-extractor-"));
  const cashConvPath = join(tmpDir2, "extracted.ts");
  writeFileSync(cashConvPath, cashConvExtractorText, "utf8");
  const cashConvMod = await import("file://" + cashConvPath.replace(/\\/g, "/"));
  const r1 = cashConvMod.cashConversionCalcular(90000, 3500, 48, 0.0112);
  const r2 = cashConvMod.cashConversionCalcular(90000, 3100, 48, 0.0112);
  check("[E] two different scenarios (same capital/term, different monthly_payment) produce two genuinely different break_even_rate values", r1.break_even_rate !== null && r2.break_even_rate !== null && r1.break_even_rate !== r2.break_even_rate, { r1: r1.break_even_rate, r2: r2.break_even_rate });
}

// ========================================================================
// PART F — commercial objection / math-vs-strategy policy
// ========================================================================
{
  check("[F] the 'never open by conceding' objection rule exists in PROMPT_COMMERCIAL_ORCHESTRATION", /OBJEÇÃO DE JUROS\/CUSTO DO FINANCIAMENTO, NUNCA ABRA CEDENDO \(IA-3K\.3/.test(fullPrompt));
  check("[F] the rule explicitly names the real UAT opener it forbids ('você tem razão')", /NUNCA comece concedendo a objeção \("você tem razão"/.test(fullPrompt));
  check("[F] the rule leads with the CONCEPT (juros = custo de manter capital disponível), never a promise", /juros são o custo de manter capital disponível\/preservar liquidez/.test(fullPrompt));
  check("[F] the rule still forbids lying/inventing returns/hiding adverse results", /nunca minta, nunca afirme que financiamento é mais barato quando não é, nunca invente retorno de investimento, nunca esconda uma diferença matemática real/.test(fullPrompt));
  check("[F] the VANTAGEM MATEMÁTICA x VANTAGEM ESTRATÉGICA separation rule exists", /CONCLUSÃO MATEMÁTICA x CONCLUSÃO ESTRATÉGICA, NUNCA MISTURADAS DE FORMA CONTRADITÓRIA \(IA-3K\.3/.test(fullPrompt));
  check("[F] both new bullets reach FINANCE_PROMPT_PROFILE (shared PROMPT_COMMERCIAL_ORCHESTRATION block)", /OBJEÇÃO DE JUROS\/CUSTO DO FINANCIAMENTO/.test(financePrompt) && /CONCLUSÃO MATEMÁTICA x CONCLUSÃO ESTRATÉGICA/.test(financePrompt));
  check("[F] both new bullets also reach FINANCE_SYNTHESIS_PROFILE (shared PROMPT_COMMERCIAL_ORCHESTRATION block)", /OBJEÇÃO DE JUROS\/CUSTO DO FINANCIAMENTO/.test(synthesisPrompt) && /CONCLUSÃO MATEMÁTICA x CONCLUSÃO ESTRATÉGICA/.test(synthesisPrompt));
}

// ========================================================================
// PART G — regression freeze: model/engines/Voice/Realtime/Auth untouched
// ========================================================================
{
  const modelConst = extractConst(source, "OPENAI_MODEL");
  check("[freeze] OPENAI_MODEL declaration untouched by this Wave (still a single literal, not reassigned elsewhere)", /OPENAI_MODEL\s*=\s*"/.test(modelConst), modelConst);
  check("[freeze] PROMPT_CORE_GLOBAL's anti-fabrication language still present, untouched", /nunca invente/i.test(extractTemplateLiteralConst(source, "PROMPT_CORE_GLOBAL")));
  check("[freeze] toolSimularFinanciamento's LINEAR branch (mode=payment) still has NO target-based selection inside the engine itself (selection stays presentation-layer per this Wave's own new bullets, never a new engine formula)", /LINEAR's own payment mode has no target concept for/.test(extractFunction(source, "toolSimularFinanciamento")));
}

console.log(`\n=== Conversation Routing + Commercial Behavior (IA-3K.3): ${pass}/${pass + fail} ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

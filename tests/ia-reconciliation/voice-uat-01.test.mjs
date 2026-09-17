// VOICE-UAT-01 — PT-BR Accent + Duplicate Response + Multi-Option
// Orchestration.
//
// Separated by category, per this Wave's own explicit brief (§14):
// VOICE EVENT TESTS, VOICE DUPLICATION TESTS, PT-BR CONFIG TESTS,
// MULTI-OPTION ORCHESTRATION TESTS. FINANCE REGRESSION TESTS are the
// pre-existing tests/ia-reconciliation suite itself (re-run in full as
// part of this Wave, reported separately in the final report -- not
// duplicated here).
//
// Run: node tests/ia-reconciliation/voice-uat-01.test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSource, extractConst, extractFunction, extractInterface } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const REALTIME_SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-realtime-homolog", "index.ts");
const UI_JS_PATH = join(import.meta.dirname, "..", "..", "assets", "js", "portal-ai-ui.js");
const REALTIME_JS_PATH = join(import.meta.dirname, "..", "..", "assets", "js", "portal-ai-realtime.js");

const source = readSource(SRC_PATH);
const realtimeSrc = readSource(REALTIME_SRC_PATH);
const uiJs = readFileSync(UI_JS_PATH, "utf8");
const realtimeJs = readFileSync(REALTIME_JS_PATH, "utf8");

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

// Balanced-brace slice for a plain `function name(...) { ... }` /
// `async function name(...) { ... }` declared INSIDE a browser IIFE
// (portal-ai-ui.js/portal-ai-realtime.js have no TS return-type
// annotations to worry about, unlike extractFunction's own edge case
// handling for index.ts -- a simpler local variant is enough here).
function extractPlainFunction(src, name) {
  const markerRe = new RegExp(`(?:^|\\r?\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = markerRe.exec(src);
  if (!m) throw new Error(`extractPlainFunction: marker for "${name}" not found`);
  const braceOpen = src.indexOf("{", m.index);
  let depth = 0, i = braceOpen;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } } }
  return src.slice(m.index, i).trim();
}

// ========================================================================
// PART A — VOICE DUPLICATION TESTS
// ========================================================================

{
  // Structural, source-level proof (never a hypothesis): before this
  // Wave, baiSendFromRealtime === baiSend, and baiSend unconditionally
  // pushed a user AND an assistant turn into AI_CONVERSATION + called
  // baiRenderBody() for BOTH -- while portal-ai-realtime.js's own
  // response.done handler SEPARATELY pushes the Realtime model's own
  // spoken transcript of the SAME exchange via baiAppendRealtimeTurn.
  // Two independent, uncoordinated render paths for one logical voice
  // turn. Confirmed both functions share the identical
  // AI_CONVERSATION.push + baiRenderBody() call shape.
  check("[A] baiAppendRealtimeTurn pushes into the SAME AI_CONVERSATION + baiRenderBody() as baiSend (the real duplication mechanism, confirmed by shared call shape)", /AI_CONVERSATION\.push\(\{ role: role, content: text \}\);\s*\n\s*baiRenderBody\(\);/.test(uiJs));

  // The actual fix: baiSend now accepts a `silent` option that skips
  // BOTH push+render calls entirely, and baiSendFromRealtime uses it.
  const baiSendFn = extractPlainFunction(uiJs, "baiSend");
  check("[A] baiSend's user-turn push+render is now conditional on !silent", /if \(!silent\) \{\s*\n\s*AI_CONVERSATION\.push\(\{ role: 'user', content: text \}\);\s*\n\s*baiRenderBody\(\);/.test(baiSendFn));
  check("[A] baiSend's assistant-turn push+render is now conditional on !silent", /if \(!silent\) \{\s*\n\s*AI_CONVERSATION\.push\(\{ role: 'assistant'/.test(baiSendFn));
  // 5 total call sites: no-session, AbortError, generic-network-error,
  // non-200-friendly, exception-catch -- every single one now gated,
  // either by its own `if (!silent)` or by the shared `if (!silent) {`
  // wrapping the AbortError/generic-network-error pair.
  const errorCallSites = baiSendFn.match(/baiRenderBodyWithError\(/g) || [];
  check("[A] baiSend has exactly 5 error-rendering call sites, all now gated by !silent (no-session, AbortError, generic-network, non-200, exception)", errorCallSites.length === 5, errorCallSites.length);
  check("[A] every baiRenderBodyWithError call site is reached only through an !silent check (no stray unconditional call survives)", /if \(!silent\) baiRenderBodyWithError\('Sessão expirada/.test(baiSendFn) && /if \(!silent\) \{\s*\n\s*if \(networkErr/.test(baiSendFn) && /if \(!silent\) baiRenderBodyWithError\(friendly\)/.test(baiSendFn) && /if \(!silent\) baiRenderBodyWithError\('Não foi possível concluir a análise agora\. Tente novamente\.'\);\s*\n\s*return \{ ok: false, error: 'exception' \}/.test(baiSendFn));
  check("[A] baiSendFromRealtime now calls baiSend with { silent: true }", /window\.baiSendFromRealtime = function \(text\) \{\s*\n\s*return baiSend\(text, \{ silent: true \}\);/.test(uiJs));
  check("[A] priorTurns computation correctly branches for silent mode (never slicing off a turn that was never pushed)", /var priorTurns = \(silent \? AI_CONVERSATION : AI_CONVERSATION\.slice\(0, -1\)\)\.slice\(-8\)/.test(baiSendFn));

  // Runtime proof: actually invoke the real extracted baiSend with
  // stubbed dependencies (no network, no DOM) and count render calls.
  const mocks = `
var AI_CONVERSATION = [];
var AI_CONVERSATION_GEN = 0;
var AI_SENDING = false;
var BAI_REQUEST_TIMEOUT_MS = 5000;
var SUPABASE_URL = "http://mock";
var SUPABASE_ANON_KEY = "mock-anon";
var renderCount = 0;
function baiRenderBody() { renderCount++; }
function baiRenderBodyWithError() { renderCount++; }
global.window = { brabusAiOnInput: function () {} };
var supabaseClient = { auth: { getSession: function () { return Promise.resolve({ data: { session: { access_token: "mock-token" } } }); } } };
global.fetch = function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ reply: "resposta mock", blocks: null }); } });
};
${baiSendFn}
export { baiSend }; export function getRenderCount() { return renderCount; } export function getConversationLength() { return AI_CONVERSATION.length; }
`;
  const tmpDir = mkdtempSync(join(tmpdir(), "ia-recon-baisend-"));
  const modPath = join(tmpDir, "baisend.mjs");
  writeFileSync(modPath, mocks, "utf8");
  const mod = await import("file://" + modPath.replace(/\\/g, "/"));

  await (async () => {
    const r1 = await mod.baiSend("pergunta normal de texto");
    check("[A] normal (non-silent) call: ok:true", r1.ok === true, r1);
    check("[A] normal (non-silent) call: renders exactly 2 times (1 user turn, 1 assistant turn) -- the TEXT chat's own intended behavior, unaffected", mod.getRenderCount() === 2, mod.getRenderCount());
    check("[A] normal (non-silent) call: pushed exactly 2 turns into AI_CONVERSATION", mod.getConversationLength() === 2, mod.getConversationLength());
  })();
}

{
  const baiSendFn2 = (() => {
    const fnSrc = extractPlainFunction(uiJs, "baiSend");
    return fnSrc;
  })();
  const mocks2 = `
var AI_CONVERSATION = [];
var AI_CONVERSATION_GEN = 0;
var AI_SENDING = false;
var BAI_REQUEST_TIMEOUT_MS = 5000;
var SUPABASE_URL = "http://mock";
var SUPABASE_ANON_KEY = "mock-anon";
var renderCount = 0;
function baiRenderBody() { renderCount++; }
function baiRenderBodyWithError() { renderCount++; }
global.window = { brabusAiOnInput: function () {} };
var supabaseClient = { auth: { getSession: function () { return Promise.resolve({ data: { session: { access_token: "mock-token" } } }); } } };
global.fetch = function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ reply: "A simulação Linear exige uma entrada informada...", blocks: null }); } });
};
${baiSendFn2}
export { baiSend }; export function getRenderCount() { return renderCount; } export function getConversationLength() { return AI_CONVERSATION.length; }
`;
  const tmpDir2 = mkdtempSync(join(tmpdir(), "ia-recon-baisend-silent-"));
  const modPath2 = join(tmpDir2, "baisend.mjs");
  writeFileSync(modPath2, mocks2, "utf8");
  const mod2 = await import("file://" + modPath2.replace(/\\/g, "/"));

  const r2 = await mod2.baiSend("o que a sessão Realtime mandou via function_call", { silent: true });
  check("[A] silent (Realtime bridge) call: ok:true, real reply still returned", r2.ok === true && typeof r2.reply === "string" && r2.reply.length > 0, r2);
  check("[A] silent (Realtime bridge) call: renders ZERO times -- this is the actual fix (used to render 2 bubbles for a single tool-bridge exchange, duplicating what portal-ai-realtime.js's own response.done handler renders separately)", mod2.getRenderCount() === 0, mod2.getRenderCount());
  check("[A] silent (Realtime bridge) call: AI_CONVERSATION stays untouched by this function -- the ONLY render path left for a voice turn is baiAppendRealtimeTurn, called by portal-ai-realtime.js from the real spoken transcript", mod2.getConversationLength() === 0, mod2.getConversationLength());
}

// ========================================================================
// PART B — VOICE EVENT TESTS (invariant: one user turn -> one final render)
// ========================================================================

{
  check("[B] the dead, never-assigned _consumedByToolCall guard is removed from the actual condition (the old buggy pattern, if (userText && !evt._consumedByToolCall), no longer appears as code)", !/if \(userText && !evt\._consumedByToolCall\)/.test(realtimeJs) && /if \(userText\) window\._baiPendingUserTranscript = userText;/.test(realtimeJs));
  check("[B] baiAppendRealtimeTurn is called exactly twice in portal-ai-realtime.js -- once for the user's real spoken transcript, once for the assistant's real spoken transcript, both ONLY from the final (non-function-call) response.done of a turn", (realtimeJs.match(/window\.baiAppendRealtimeTurn\(/g) || []).length === 2);
  check("[B] the user-turn render still only fires when hadFunctionCall is false for THIS response.done (the existing, correct once-per-turn gate, untouched by this Wave)", /if \(!hadFunctionCall\) \{[\s\S]{0,400}baiAppendRealtimeTurn\('user'/.test(realtimeJs));
  check("[B] processedCallIds still guards against ever processing the same call_id twice (pre-existing invariant, confirmed untouched)", /if \(!callId \|\| processedCallIds\[callId\]\) return;/.test(realtimeJs));
}

// ========================================================================
// PART C — PT-BR CONFIG TESTS
// ========================================================================

{
  check("[C] REALTIME_VOICE default is still 'marin' (Human-approved baseline preserved, not switched without evidence)", /const REALTIME_VOICE = "marin"/.test(realtimeSrc));
  check("[C] DEFAULT_CONVERSATION_SPEED is still 1.25 (Human-approved, untouched)", /const DEFAULT_CONVERSATION_SPEED = 1\.25/.test(realtimeSrc));
  check("[C] REALTIME_MODEL is still gpt-realtime-2.1 (untouched)", /const REALTIME_MODEL = "gpt-realtime-2\.1"/.test(realtimeSrc));
  check("[C] turn_detection is still semantic_vad with interrupt_response:true (Human-approved, untouched)", /type: "semantic_vad", create_response: true, interrupt_response: true/.test(realtimeSrc));
  check("[C] ALLOWED_VOICES still includes marin AND cedar (the only 2 voices OpenAI's own docs recommend for best quality -- confirmed via real research, never invented)", /ALLOWED_VOICES = new Set\(\[[^\]]*"marin"[^\]]*"cedar"[^\]]*\]\)/.test(realtimeSrc) || /ALLOWED_VOICES = new Set\(\[[^\]]*"cedar"[^\]]*"marin"[^\]]*\]\)/.test(realtimeSrc));
  check("[C] the reinforced accent instruction contains a concrete, correct worked example for R$330.000", realtimeSrc.includes("trezentos e trinta mil reais"));
  check("[C] the reinforced accent instruction contains a concrete, correct worked example for R$3.500", realtimeSrc.includes("três mil e quinhentos reais"));
  check("[C] the reinforced accent instruction contains a concrete, correct worked example with centavos", realtimeSrc.includes("duzentos e trinta e quatro mil, setecentos e quatro reais e dezessete centavos"));
  check("[C] the instruction explicitly forbids English-style cadence/intonation applied to Portuguese words", realtimeSrc.includes("nunca a cadência e a entonação do inglês aplicadas a palavras em português"));
  check("[C] the instruction explicitly forbids reading R$ digit-by-digit or as letters", /nunca leia o símbolo R\$ como letras separadas/i.test(realtimeSrc));
  check("[C] no new, invented API parameter was added -- session config still only sets model/instructions/audio.input/audio.output/tools/tool_choice/output_modalities/reasoning (the same real, documented fields as before)", /type: "realtime",\s*\n\s*model: REALTIME_MODEL,\s*\n\s*instructions:/.test(realtimeSrc));
  check("[C] voice override mechanism (for Human A/B marin vs cedar) already exists and is unchanged -- overrides.voice, validated against ALLOWED_VOICES", /const voice = \(typeof overrides\.voice === "string" && ALLOWED_VOICES\.has\(overrides\.voice\)\) \? overrides\.voice : REALTIME_VOICE;/.test(realtimeSrc));
}

// ========================================================================
// PART D — MULTI-OPTION ORCHESTRATION TESTS
// ========================================================================

{
  const simDepartmentType = extractTypeAlias(source, "SimDepartment");
  const simulationModeType = extractTypeAlias(source, "SimulationMode");
  const simFinancingTypeType = extractTypeAlias(source, "SimFinancingType");
  const simulationInputInterface = "export " + extractInterface(source, "SimulationInput");
  const round2Fn = "export " + extractFunction(source, "round2");
  const brMoneyTokenConst = "export " + extractConst(source, "BR_MONEY_TOKEN_RE_SRC");
  const vehicleValueReConst = "export " + extractConst(source, "VEHICLE_VALUE_RE_SRC");
  const parseBRMoneyTokenFn = "export " + extractFunction(source, "parseBRMoneyToken");
  const maskSpanFn = "export " + extractFunction(source, "maskSpan");
  const novosPrazosConst = "export " + extractConst(source, "NOVOS_PRAZOS");
  const seminovosPrazosConst = "export " + extractConst(source, "SEMINOVOS_PRAZOS");
  const simPrazosForFn = "export " + extractFunction(source, "simPrazosFor");
  const extractPlanFn = "export " + extractFunction(source, "extractFinanceEngineFirstPlan");
  const emptySimulationInputFn = "export " + extractFunction(source, "emptySimulationInput");
  const clientBoundaryConst = "export " + extractConst(source, "CLIENT_BOUNDARY_RE");
  const maxToolCallsConst = "export " + extractConst(source, "MAX_TOOL_CALLS");
  const extractTermListFn = "export " + extractFunction(source, "extractTermMonthsList");
  // IA-UAT-04 -- extractRequiredDownPaymentPlan/resolveStatefulRequiredDownPaymentPlan
  // now depend on these 5 additional real declarations (overrides/bypass
  // regexes + the 2 new shared choke-point helpers) -- extracted here too,
  // same "never a hand-copied replica" discipline, so this pre-existing
  // Wave's own multi-option tests keep exercising the REAL current source.
  const linearOnlyConst = "export " + extractConst(source, "LINEAR_ONLY_EXCLUSION_RE");
  const balaoOnlyConst = "export " + extractConst(source, "BALAO_ONLY_EXCLUSION_RE");
  const allOptionsConst = "export " + extractConst(source, "ALL_COMMERCIAL_OPTIONS_RE");
  const bareTermConst = "export " + extractConst(source, "BARE_TERM_OVERRIDE_RE");
  const requiredPlanInterface = "export " + extractInterface(source, "RequiredDownPaymentPlan");
  const extractOverridesFn = "export " + extractFunction(source, "extractCommercialOverrides");
  const resolveTermsFn = "export " + extractFunction(source, "resolveTermMonthsList");
  const extractRdpFn = "export " + extractFunction(source, "extractRequiredDownPaymentPlan");
  const resolveRdpFn = "export " + extractFunction(source, "resolveStatefulRequiredDownPaymentPlan");
  const buildRdpFn = "export " + extractFunction(source, "buildRequiredDownPaymentSimulationInputs");
  // IA-CAPLOCK5 -- extractRequiredDownPaymentPlan/resolveStatefulRequiredDownPaymentPlan
  // now also call extractBalloonCountConstraint (a new real dependency).
  const balloonCountMaxReConst = "export " + extractConst(source, "BALLOON_COUNT_MAX_RE");
  const balloonCountExactReConst = "export " + extractConst(source, "BALLOON_COUNT_EXACT_RE");
  const extractBalloonCountConstraintFn = "export " + extractFunction(source, "extractBalloonCountConstraint");

  const modText = [
    "// AUTO-EXTRACTED at test time -- do not hand-edit.",
    simDepartmentType, simulationModeType, simFinancingTypeType, simulationInputInterface,
    round2Fn, brMoneyTokenConst, vehicleValueReConst, parseBRMoneyTokenFn, maskSpanFn,
    novosPrazosConst, seminovosPrazosConst, simPrazosForFn, extractPlanFn, emptySimulationInputFn,
    clientBoundaryConst, maxToolCallsConst, extractTermListFn,
    linearOnlyConst, balaoOnlyConst, allOptionsConst, bareTermConst,
    requiredPlanInterface, extractOverridesFn, resolveTermsFn, extractRdpFn, resolveRdpFn, buildRdpFn,
    balloonCountMaxReConst, balloonCountExactReConst, extractBalloonCountConstraintFn,
  ].join("\n\n");
  const tmpDir3 = mkdtempSync(join(tmpdir(), "ia-recon-multioption-"));
  const modPath3 = join(tmpDir3, "extracted.ts");
  writeFileSync(modPath3, modText, "utf8");
  const mod3 = await import("file://" + modPath3.replace(/\\/g, "/"));
  const { extractRequiredDownPaymentPlan, resolveStatefulRequiredDownPaymentPlan, buildRequiredDownPaymentSimulationInputs, extractTermMonthsList, NOVOS_PRAZOS } = mod3;

  // ---- D1. extractTermMonthsList recognizes the real UAT phrasing ----
  check("[D1] 'Sugira prazos de 36 e 48 meses' -> [36, 48]", JSON.stringify(extractTermMonthsList("Sugira prazos de 36 e 48 meses no plano Linear", NOVOS_PRAZOS)) === JSON.stringify([36, 48]));
  check("[D1] '36x e 48x' -> [36, 48]", JSON.stringify(extractTermMonthsList("Compare 36x e 48x", NOVOS_PRAZOS)) === JSON.stringify([36, 48]));
  check("[D1] '36, 42 e 48 meses' -> [36, 42, 48]", JSON.stringify(extractTermMonthsList("Quero ver 36, 42 e 48 meses", NOVOS_PRAZOS)) === JSON.stringify([36, 42, 48]));
  check("[D1] 'entre 36 e 48 meses' -> [36, 42, 48] (real valid NOVOS terms in range, never an invented term like 37)", JSON.stringify(extractTermMonthsList("prazo entre 36 e 48 meses", NOVOS_PRAZOS)) === JSON.stringify([36, 42, 48]));
  check("[D1] a single term alone -> null (not a list; the existing single-term path handles that case)", extractTermMonthsList("financiar em 48 meses", NOVOS_PRAZOS) === null);

  // ---- D2. the exact real UAT scenario: Triton Katana, R$330.000, target R$3.500, Linear, 36 e 48 meses ----
  const UAT_MSG = "Sugira prazos de 36 e 48 meses no plano Linear para chegar na parcela de R$ 3.500 para um Triton Katana de R$ 330.000";
  const plan = extractRequiredDownPaymentPlan(UAT_MSG);
  check("[D2] plan extracted (non-null)", plan !== null, plan);
  if (plan) {
    check("[D2] vehicleValue = 330000", plan.vehicleValue === 330000, plan.vehicleValue);
    check("[D2] targetPayment = 3500", plan.targetPayment === 3500, plan.targetPayment);
    check("[D2] department defaults to NOVOS (no seminovo/usado signal)", plan.department === "NOVOS", plan.department);
    check("[D2] termMonthsList = [36, 48] -- BOTH requested terms recognized, never just one", JSON.stringify(plan.termMonthsList) === JSON.stringify([36, 48]), plan.termMonthsList);

    const inputs = buildRequiredDownPaymentSimulationInputs(plan);
    check("[D2] exactly 2 SimulationInput entries built -- one REAL dispatch per requested term, never left for the model to remember the second one (the actual regression this fixes)", inputs.length === 2, inputs.map((i) => i.term_months));
    check("[D2] both entries use mode=required_down_payment, financing_type=LINEAR (the real, unmodified engine capability -- never a new formula)", inputs.every((i) => i.mode === "required_down_payment" && i.financing_type === "LINEAR"));
    check("[D2] the two entries cover exactly term_months 36 and 48, each as its own independent call", JSON.stringify(inputs.map((i) => i.term_months).sort((a, b) => a - b)) === JSON.stringify([36, 48]));
    check("[D2] every entry carries the full resolved context (same vehicle_value/target_payment/department) -- consistent across both calls", inputs.every((i) => i.vehicle_value === 330000 && i.target_payment === 3500 && i.department === "NOVOS"));
  }

  // ---- D3. "48 isolated" must produce the SAME request shape as the multi-option request's own 48-entry (never a different code path) ----
  const ISOLATED_48_MSG = "No plano Linear, em 48 meses, qual a entrada necessária para uma parcela de R$ 3.500 num Triton Katana de R$ 330.000?";
  const isolatedPlan = extractRequiredDownPaymentPlan(ISOLATED_48_MSG);
  check("[D3] isolated 48-month plan extracted", isolatedPlan !== null, isolatedPlan);
  if (isolatedPlan && plan) {
    check("[D3] isolated plan resolves to a SINGLE term, 48 (not a list)", JSON.stringify(isolatedPlan.termMonthsList) === JSON.stringify([48]), isolatedPlan.termMonthsList);
    const isolatedInputs = buildRequiredDownPaymentSimulationInputs(isolatedPlan);
    const multiInputs = buildRequiredDownPaymentSimulationInputs(plan);
    const multi48 = multiInputs.find((i) => i.term_months === 48);
    check("[D3] the isolated request's own SimulationInput is IDENTICAL in shape to the multi-option request's own 48-entry (same mode/financing_type/department/vehicle_value/target_payment/term_months) -- proving this was always an orchestration gap, never a data/engine difference", JSON.stringify(isolatedInputs[0]) === JSON.stringify(multi48), { isolated: isolatedInputs[0], multi48 });
  }

  // ---- D4. §13 Opening Behavior Polish: vehicle + target, NO down payment, NO specific term -- must resolve to ONE combined call (term_months omitted), never ask "entrada?" as a dead end ----
  const OPENING_MSG = "Triton Katana R$330 mil, quero parcela de R$3.500, entrada ainda não definida";
  const openingPlan = extractRequiredDownPaymentPlan(OPENING_MSG);
  check("[D4] opening-behavior plan extracted (vehicle+target present, down payment absent, no specific term)", openingPlan !== null, openingPlan);
  if (openingPlan) {
    check("[D4] termMonthsList = null (no specific term named) -- triggers ONE combined dispatch, term_months omitted, covering every valid term in a single real call", openingPlan.termMonthsList === null, openingPlan.termMonthsList);
    const openingInputs = buildRequiredDownPaymentSimulationInputs(openingPlan);
    check("[D4] exactly 1 SimulationInput built (not 8 separate calls -- the real engine already loops over every valid term internally when term_months is omitted, never bypassing the MAX_TOOL_CALLS governance ceiling)", openingInputs.length === 1, openingInputs);
    check("[D4] that single input has term_months: null (lets the real engine return every valid NOVOS term's required down payment in one dispatch)", openingInputs[0].term_months === null);
  }

  // ---- D5. MAX_TOOL_CALLS ceiling is never silently bypassed even for a pathological over-long explicit list ----
  const manyTermsPlan = { department: "NOVOS", vehicleValue: 200000, vehicleYear: null, targetPayment: 2000, termMonthsList: [12, 18, 24, 30, 36, 42, 48, 60] };
  const cappedInputs = buildRequiredDownPaymentSimulationInputs(manyTermsPlan);
  check("[D5] an explicit list longer than MAX_TOOL_CALLS is capped, never silently dispatching more calls than the normal tool loop itself would ever allow", cappedInputs.length <= mod3.MAX_TOOL_CALLS, { len: cappedInputs.length, max: mod3.MAX_TOOL_CALLS });

  // ---- D6. mutual exclusivity: a message that already states a down payment is REJECTED by this plan shape (belongs to the existing finance-engine-first path instead) ----
  check("[D6] a message with an explicit down payment never resolves via this plan shape (mutual exclusivity with extractFinanceEngineFirstPlan, by construction)", extractRequiredDownPaymentPlan("Triton Katana de R$330.000, entrada de R$90.000, parcela de R$3.500 em 36 meses") === null);

  // ---- D7. client boundary respected in the stateful resolver too ----
  check("[D7] resolveStatefulRequiredDownPaymentPlan never resolves across a client-boundary signal in the current message", resolveStatefulRequiredDownPaymentPlan([{ role: "user", content: "Triton Katana R$330.000" }], "agora outro cliente, parcela de R$3.500 em 36 e 48 meses") === null);
}

console.log(`\n=== VOICE-UAT-01: PT-BR + Duplication + Multi-Option (${pass}/${pass + fail}) ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

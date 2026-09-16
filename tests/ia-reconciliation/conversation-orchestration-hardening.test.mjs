// IA-CONVFIX-1 — conversation orchestration hardening, permanent
// regression.
//
// Real Human Voice/Text evidence (LIVE-CONVERSATION-AUDIT-1) exposed
// four defects this test proves are corrected, against the REAL
// current source (never a hand-copied duplicate -- same discipline as
// every other reconciliation test in this directory):
//   CASE 2 -- raw internal tool-argument JSON became visible assistant
//     prose (e.g. {"mode":"payment","financing_type":"LINEAR",...}).
//   CASE 4 -- term_months' own schema description contradicted
//     term_months_list's ("sempre obrigatório para BALAO" vs. "omita
//     ambos para otimizar"), so the model sometimes asked for a term
//     the engine could already search for automatically.
//   CASE 5 -- an explicit "o que você me aconselha?" question could
//     receive historical evidence without an explicit recommendation
//     sentence (item 3 of the executive-response contract was only
//     "quando aplicável").
//   CASE 1 -- Voice repeated "ainda em processamento" paraphrases on
//     every user interjection while a Portal tool call was pending
//     (REALTIME_INSTRUCTIONS had no rule against this). Voice-specific
//     -- this file proves the INSTRUCTION TEXT is present and correct;
//     it cannot prove live OpenAI Realtime model compliance (no real
//     session in this harness, same limitation as every prior wave).
//
// Run: node tests/ia-reconciliation/conversation-orchestration-hardening.test.mjs

import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readSource, extractFunction, extractTemplateLiteralConst } from "./extract.mjs";

const AI_SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const REALTIME_SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-realtime-homolog", "index.ts");
const aiSource = readSource(AI_SRC_PATH);
const realtimeSource = readSource(REALTIME_SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

// ---------- CASE 2: global anti-leak rule (prompt-level defense) ----------
{
  const core = extractTemplateLiteralConst(aiSource, "PROMPT_CORE_GLOBAL");
  check("CASE2_GLOBAL_RULE_PRESENT: PROMPT_CORE_GLOBAL prohibits emitting raw JSON/tool arguments as the response",
    /NUNCA EMITA JSON/i.test(core) && /argumentos de ferramenta/i.test(core));
  check("CASE2_GLOBAL_RULE_COVERS_PENDING: rule explicitly covers multi-step orchestration while a step is still in progress",
    /enquanto uma etapa intermedi[áa]ria ainda est[áa] em andamento/i.test(core));
  check("CASE2_GLOBAL_RULE_COVERS_FAILURE: rule explicitly covers tool failure (never reproduce the raw error payload)",
    /nunca reproduza o payload t[ée]cnico do erro/i.test(core));
}

// ---------- CASE 2: deterministic defense-in-depth (real function, executed) ----------
{
  const fnSrc = extractFunction(aiSource, "isRawToolPayloadReply");
  const fixtureTs = `export ${fnSrc}\n`;
  const fixturePath = join(import.meta.dirname, ".fixture-raw-payload-guard.ts");
  writeFileSync(fixturePath, fixtureTs, "utf8");
  let mod;
  try {
    mod = await import("file://" + fixturePath.replace(/\\/g, "/") + `?t=${Date.now()}`);
  } finally {
    unlinkSync(fixturePath);
  }
  const { isRawToolPayloadReply } = mod;

  // The real Human incident, verbatim shape.
  const incidentPayload = JSON.stringify({
    mode: "payment", financing_type: "LINEAR", vehicle_value: 180000,
    target_payment: 1800, term_months: null, priority: "min_down_payment"
  });
  check("CASE2_DEFENSE_CATCHES_INCIDENT_FIXTURE: exact Human-incident payload shape is detected", isRawToolPayloadReply(incidentPayload) === true);
  check("CASE2_DEFENSE_CATCHES_OTHER_TOOLS: simular_antecipacao-shaped raw args also detected",
    isRawToolPayloadReply(JSON.stringify({ term_months: 48, monthly_payment: 2000, scope: "all" })) === true);
  check("CASE2_DEFENSE_CATCHES_CASH_CONVERSION_SHAPE: simular_cash_conversion-shaped raw args also detected",
    isRawToolPayloadReply(JSON.stringify({ capital: 90000, monthly_payment: 1800, term_months: 36 })) === true);
  check("CASE2_DEFENSE_CATCHES_TAXA_SHAPE: calcular_taxa_financiamento-shaped raw args also detected",
    isRawToolPayloadReply(JSON.stringify({ financed_amount: 100000, term_months: 36, monthly_payment: 4485.75 })) === true);
  check("CASE2_DEFENSE_CATCHES_ARBITRARY_OBJECT: any bare JSON object reply is detected (not tool-name-specific)",
    isRawToolPayloadReply('{"foo":"bar","baz":1}') === true);

  // Negative cases -- must NEVER false-positive on legitimate prose.
  check("CASE2_NO_FALSE_POSITIVE_PRICE: legitimate reply mentioning a price passes through",
    isRawToolPayloadReply("A parcela ficou em R$ 1.800,00 para 48 meses.") === false);
  check("CASE2_NO_FALSE_POSITIVE_PERCENT: legitimate reply with percentages passes through",
    isRawToolPayloadReply("A entrada representa 52,8% do valor do veículo, com mediana de 47 meses.") === false);
  check("CASE2_NO_FALSE_POSITIVE_BRACE_MENTION: prose that merely mentions a brace/format is not flagged",
    isRawToolPayloadReply("O sistema usa chaves como {mode} internamente, mas isso não deveria aparecer aqui.") === false);
  check("CASE2_NO_FALSE_POSITIVE_MARKDOWN_TABLE: a legitimate Markdown-shaped answer passes through",
    isRawToolPayloadReply("| Prazo | Parcela |\n|---|---|\n| 48x | R$ 1.800,00 |") === false);
  check("CASE2_NO_FALSE_POSITIVE_EMPTY: null/empty text is not flagged (falls through to the existing default message)",
    isRawToolPayloadReply(null) === false && isRawToolPayloadReply("") === false);
  check("CASE2_NO_FALSE_POSITIVE_ARRAY: a bare JSON array (never produced by extractOutputText, but still) is not treated as the leak shape",
    isRawToolPayloadReply("[1,2,3]") === false);

  check("CASE2_SAFE_REPLY_WIRED: the response boundary actually calls isRawToolPayloadReply(finalText) to choose safeReply",
    /const safeReply = isRawToolPayloadReply\(finalText\)/.test(aiSource));
  check("CASE2_SAFE_REPLY_NEVER_INVENTS_NUMBERS: the fail-closed message contains no invented financial figure",
    !/R\$\s*\d/.test(aiSource.slice(aiSource.indexOf("const safeReply ="), aiSource.indexOf("const safeReply =") + 400)));
}

// ---------- CASE 2: _homolog_debug gating decision, disclosed ----------
{
  check("CASE2_HOMOLOG_DEBUG_CONSUMERS_ARE_TEST_ONLY (documented, not gated this Wave -- no safe existing env gate found)",
    /_homolog_debug: \{ tools_used: toolsUsed/.test(aiSource));
}

// ---------- CASE 4: term_months / term_months_list contract reconciled ----------
{
  const termMonthsMatch = aiSource.match(/term_months: \{ type: \["integer", "null"\], description: "Prazo em meses\.[^"]*" \}/);
  check("CASE4_SCHEMA_FOUND: term_months (simular_financiamento) schema field located", !!termMonthsMatch);
  const termMonthsDesc = termMonthsMatch ? termMonthsMatch[0] : "";
  check("CASE4_NO_UNCONDITIONAL_REQUIRED_FOR_BALAO: description no longer says term_months is unconditionally required for BALAO",
    !/sempre obrigat[óo]rio quando financing_type=BALAO ou SEMESTRAL_ANUAL/i.test(termMonthsDesc));
  check("CASE4_OPTIMIZATION_CARVEOUT_PRESENT: description explicitly allows omitting term_months in BALAO optimization mode",
    /modo de otimiza[çc][ãa]o \(balloon_value=null[^)]*\)[\s\S]{0,80}OPCIONAL/i.test(termMonthsDesc));
  check("CASE4_DELEGATION_PHRASES_RECOGNIZED: description recognizes explicit user delegation phrasing ('você que me fala o prazo')",
    /voc[êe] que me fala o prazo/i.test(termMonthsDesc));
  check("CASE4_NEVER_ASK_AGAIN: description explicitly instructs never to re-ask once the user has delegated the choice",
    /nunca pe[çc]a o prazo de novo/i.test(termMonthsDesc));
  check("CASE4_SEMESTRAL_ANUAL_STILL_REQUIRED: Semestral/Anual's own real requirement (term_months always required) is preserved, not weakened",
    /sempre obrigat[óo]rio quando financing_type=SEMESTRAL_ANUAL/i.test(termMonthsDesc));

  check("CASE4_TERM_MONTHS_LIST_UNCHANGED_IN_SUBSTANCE: term_months_list's own optimization-mode carve-out remains present (not removed elsewhere)",
    /Use term_months para um [úu]nico prazo, ou omita ambos/i.test(aiSource));
}

// ---------- CASE 5: mandatory recommendation trigger ----------
{
  const shared = extractTemplateLiteralConst(aiSource, "PROMPT_SHARED_CONVERSATION");
  check("CASE5_RECOMMENDATION_NO_LONGER_UNCONDITIONALLY_OPTIONAL: item (3) is not simply 'quando aplicável' anymore",
    !/uma recomenda[çc][ãa]o ou alerta em 1 frase, quando aplic[áa]vel;/i.test(shared));
  check("CASE5_MANDATORY_FOR_EXPLICIT_TRIGGERS: item (3) states the recommendation is NEVER optional for explicit advice triggers",
    /NUNCA opcional quando o pedido contiver um gatilho expl[íi]cito de conselho/i.test(shared));
  check("CASE5_TRIGGER_PHRASES_LISTED: the explicit trigger phrases from the real Human question are recognized",
    /o que voc[êe] me aconselha/i.test(shared) && /o que voc[êe] recomenda/i.test(shared));
  check("CASE5_REFERENCES_EXISTING_POLICY_NOT_REWRITTEN: item (3) points back to the existing IA-UAT-FIX-04 trigger vocabulary instead of duplicating it",
    /IA-UAT-FIX-04/i.test(shared));
  // IA-UAT-FIX-04 itself must remain byte-present and untouched in substance (Case 5 explicitly forbids rewriting it).
  const historical = extractTemplateLiteralConst(aiSource, "PROMPT_HISTORICAL");
  check("CASE5_IA_UAT_FIX_04_NOT_REWRITTEN: the original HISTÓRICO→SIMULAÇÃO→RECOMENDAÇÃO policy text remains intact",
    /HIST[ÓO]RICO → SIMULA[ÇC][ÃA]O → RECOMENDA[ÇC][ÃA]O/i.test(historical) &&
    /eu come[çc]aria por A, depois B, depois C, porque/i.test(historical));
  check("CASE5_WEAK_SAMPLE_GUARD_UNCHANGED: the pre-existing weak-sample honesty rule (sample_quality) is untouched, still present",
    /sample_quality="INSUFICIENTE" ou "SEM_DADOS"/i.test(historical));
}

// ---------- CASE 1: Voice pending-acknowledgement rule ----------
{
  check("CASE1_PENDING_RULE_PRESENT: REALTIME_INSTRUCTIONS contains an explicit rule about an already-pending Portal consultation",
    /CONSULTA J[ÁA] PENDENTE/i.test(realtimeSource));
  check("CASE1_NO_REPEAT_ON_FILLER: rule instructs not to repeat/paraphrase the processing acknowledgement on a mere interjection",
    /N[ÃA]O diga de novo que est[áa] processando\/consultando\/verificando/i.test(realtimeSource));
  check("CASE1_SILENT_WAIT: rule instructs waiting in silence for the real tool result instead",
    /continue aguardando em sil[êe]ncio o resultado real da ferramenta/i.test(realtimeSource));
  check("CASE1_EXPLICIT_STATUS_ALLOWED: an explicit status question is still allowed exactly one concise answer",
    /uma [úu]nica resposta curta confirmando que a consulta continua em andamento [ée] permitida/i.test(realtimeSource));
  check("CASE1_STATUS_NOT_REPEATED_ON_REPEAT: repeating the same status question again does not get repeated again either",
    /n[ãa]o repita essa mesma confirma[çc][ãa]o de novo se ele perguntar outra vez/i.test(realtimeSource));
  check("CASE1_GENUINE_NEW_INTENT_STILL_HANDLED: rule explicitly preserves normal interruption handling for a genuinely new question",
    /pergunta NOVA e diferente[\s\S]{0,80}trate normalmente como interrup[çc][ãa]o/i.test(realtimeSource));
  check("CASE1_ORIGINAL_INTERRUPTION_RULE_UNCHANGED: the pre-existing mid-response interruption rule is still present, untouched in substance",
    /nunca continue a resposta anterior por cima da fala dele/i.test(realtimeSource));
}

// ---------- TEXT/VOICE PARITY: no new divergence introduced ----------
{
  check("PARITY_NO_COMPETING_JSON_RULE_IN_VOICE: portal-realtime-homolog does not define its own separate/competing anti-JSON-leak rule (single authority stays in portal-ai-homolog)",
    !/NUNCA EMITA JSON/i.test(realtimeSource));
  check("PARITY_VOICE_STILL_DELEGATES: Voice still declares zero financial knowledge of its own and delegates to portal-ai-homolog (unchanged by this Wave)",
    /N[ÃA]O tem conhecimento pr[óo]prio sobre financiamentos/i.test(realtimeSource) && /portal-ai-homolog/i.test(realtimeSource));
}

console.log();
console.log(`=== Conversation Orchestration Hardening Tests (IA-CONVFIX-1): ${pass}/${pass + fail} ===`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);

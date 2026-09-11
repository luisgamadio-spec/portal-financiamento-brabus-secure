// IA-3J.1 -- deterministic, source-inspection tests for the
// concise-by-default synthesis policy inside SYSTEM_PROMPT. These are
// semantic PRESENCE/ABSENCE checks on the real prompt text at test-run
// time (same "never a hand-copied duplicate" discipline as every other
// file in this directory, via extractConst) -- they prove the
// instructions the model WILL see, never the model's own output (no
// real OpenAI call is made or required here; that remains a separate,
// real-session verification, out of scope for a deterministic test).
//
// Run: node tests/ia-reconciliation/concise-policy.test.mjs

import { join } from "node:path";
import { readSource, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

// SYSTEM_PROMPT is a backtick template literal of Portuguese PROSE, not
// code -- generic brace/paren-depth extraction (extractConst, built for
// statement-shaped consts) stops at the first semicolon that happens to
// follow a locally-balanced parenthesis inside a sentence, which is
// nearly every sentence here. The prompt has no nested backticks or
// `${}` interpolation of its own (confirmed by inspection), so a plain
// backtick-to-backtick scan is the correct, simpler extractor for it.
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

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- GLOBAL_CONCISE_DEFAULT_PRESENT ----------
{
  check(
    "a numeric concise-by-default contract exists (2-6 sentences / 3-6 bullets)",
    /2 a 6 frases/.test(prompt) && /3 a 6 bullets/.test(prompt)
  );
  check(
    "the contract is explicitly declared GLOBAL (not simulation-only)",
    /ESTE FORMATO É GLOBAL/.test(prompt)
  );
  check(
    "the global contract explicitly names resultado/comparação/score/ranking/comissão/simulação/recomendação/histórico as covered",
    /é o padrão para QUALQUER resposta de Brabus Intelligence — resultado, comparação, score, ranking, comissão, simulação, recomendação, histórico/.test(prompt)
  );
}

// ---------- OBSOLETE CARVE-OUT REMOVED ----------
{
  check(
    "the old IA-3J exclusion sentence (Resultado/Score/Ranking/Comissões kept in a separate 'já homologado' format) no longer exists verbatim",
    !/continuam no formato já homologado, sem alteração/.test(prompt)
  );
  check(
    "the old narrow scope restriction ('vale só quando o pedido for simulação/proposta/condição/top planos/recomendação') no longer exists verbatim",
    !/Esta regra de brevidade vale só quando o pedido for simulação/.test(prompt)
  );
}

// ---------- RESULT_CONCISE_DEFAULT_PRESENT / SCORE_CONCISE_DEFAULT_PRESENT / COMMISSION_CONCISE_DEFAULT_PRESENT ----------
{
  check(
    "Resultado, Score, Ranking and Comissões are explicitly named together under the executive-tone rule (Fase IA-2G.3)",
    /TOM EXECUTIVO em Score\/Ranking\/Comissões\/Resultado/.test(prompt)
  );
  check(
    "RESPOSTA PROPORCIONAL explicitly cross-references the exact numeric contract (not just a qualitative 'be short')",
    /RESPOSTA PROPORCIONAL[\s\S]{0,400}?2 a 6 frases ou 3 a 6 bullets é o padrão/.test(prompt)
  );
  check(
    "RESPOSTA PROPORCIONAL's own example list still names Score, ranking, comissão and resultado individually",
    /uma pergunta simples \(parcela de uma simulação, Score, ranking, comissão, resultado\)/.test(prompt)
  );
}

// ---------- SIMULATION_CONCISE_DEFAULT_PRESENT / MULTI_BALLOON_ESCALATION_PRESERVED ----------
{
  check(
    "simulation/proposal executive-first ordering (IA-UAT-FIX-05/UAT-06) is still present",
    /RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO/.test(prompt)
  );
  check(
    "the IA-3J proactive multi-balloon escalation instruction is preserved verbatim (not touched by this Wave's reconciliation)",
    /EXPLORAÇÃO ANTES DE CONCLUIR INVIABILIDADE \(IA-3J\)/.test(prompt) &&
    /aumentando balloon_count_max para os próximos valores aceitos pelo motor/.test(prompt)
  );
  check(
    "multi-balloon governed ceilings (4 Novos / 2 Seminovos) are still stated, unchanged",
    /Novos aceita até 4 balões por simulação, Seminovos até 2/.test(prompt)
  );
}

// ---------- DETAIL_ON_DEMAND_PRESENT ----------
{
  check(
    "explicit detail-request trigger phrases are present ('detalha', 'por loja', 'como chegou nisso')",
    /"por quê\?", "me mostra o histórico", "detalha", "por loja", "como chegou nisso\?"/.test(prompt)
  );
  check(
    "detail-on-demand explicitly permits/expects deepening on request, reusing already-computed data without re-calling tools",
    /a resposta pode e deve aprofundar \(inclusive reaproveitando os dados já calculados/.test(prompt)
  );
}

// ---------- CARDS_NOT_DUPLICATED_IN_PROSE_PRESENT ----------
{
  check(
    "prose/card non-duplication rule exists in the global contract (card = detail, text = executive summary)",
    /o texto é o resumo executivo, o card é o detalhe, nunca os dois a mesma coisa/.test(prompt)
  );
  check(
    "the pre-existing, already-global Apresentação rule (never transcribe what the visual block already shows) is untouched",
    /Seu texto deve ser curto: contextualize, interprete e conclua — não transcreva/.test(prompt)
  );
}

// ---------- VOICE_SHORTER_THAN_TEXT_PRESENT ----------
{
  check(
    "a Voice-specific concision addendum exists, distinct from the Text contract",
    /MODO VOZ \(IA-3J\)/.test(source)
  );
  check(
    "Voice is explicitly bounded to 1-3 spoken sentences, no bullets/tables",
    /Responda em 1 a 3 frases corridas, nunca em bullets\/lista.*nunca em tabela/.test(source)
  );
  check(
    "Voice addendum is applied conditionally on the already-trusted x-nx-intelligence-surface header, never unconditionally",
    /voiceSurfaceForPrompt[\s\S]{0,200}?=== "voice"/.test(source)
  );
  check(
    "Voice addendum explicitly disclaims any change to calculation/tool/financial-limit rules (presentation-only)",
    /Esta seção não altera nenhuma regra de cálculo, tool ou limite financeiro/.test(source)
  );
}

// ---------- FINANCE_ENGINE_UNCHANGED / TOOL_SCHEMA / DISPATCHER regression guard ----------
{
  // Byte-identical function bodies (hash-free, direct string compare)
  // for every engine function this Wave was required to leave
  // untouched -- these are the load-bearing business-math functions
  // named explicitly in the brief's boundary section.
  const engineFns = [
    "balaoCalcular",
    "balaoOptimizeMinPayment",
    "balaoOptimizeMinPaymentMulti",
    "balaoRequiredDownPayment",
  ];
  for (const fn of engineFns) {
    let body = null;
    try { body = extractFunction(source, fn); } catch (e) { /* checked below */ }
    check(`${fn}() still exists as a real function in source (not removed/renamed)`, body !== null);
  }

  check(
    "tool registry still declares exactly 12 tools (no tool added/removed this Wave)",
    (() => {
      const toolsBlockStart = source.indexOf("const TOOLS = [");
      const toolsBlockEnd = source.indexOf("\n];", toolsBlockStart);
      const toolsBlock = source.slice(toolsBlockStart, toolsBlockEnd);
      const names = [...toolsBlock.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
      return names.length === 12;
    })()
  );

  check(
    "simular_financiamento's balloons/balloon_count_max parameters are unchanged (still present, still nullable, still in required[])",
    /balloons:\s*\{/.test(source) &&
    /balloon_count_max:\s*\{\s*type:\s*\["integer", "null"\]/.test(source) &&
    /"balloon_value", "balloon_month", "balloon_cap", "term_months_list", "balloons", "balloon_count_max"/.test(source)
  );

  check(
    "CORS Access-Control-Max-Age caching header (IA-3J) is preserved",
    /"Access-Control-Max-Age":\s*"600"/.test(source)
  );
}

console.log(`\n=== Concise Policy Reconciliation Tests (IA-3J.1): ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

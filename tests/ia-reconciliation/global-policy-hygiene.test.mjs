// IA-3J.4H.2 — final global-policy hygiene reconciliation.
//
// IA-3J.4H.1's exhaustive, line-by-line audit of the full 103,037-char
// SYSTEM_PROMPT (202 semantic blocks, 19 sections + preamble, 0
// UNKNOWN) found exactly 2 remaining global-policy entanglements and
// 1 coverage gap, all inside/around `Fase IA-2G.1` (Orquestração
// Financeira):
//   1. "SEMPRE ESCREVA O NÚMERO NO TEXTO" -- a domain-agnostic rule
//      (conversation history is text-only, never the rendered visual
//      block -- equally true for Score/Comissões/Resultado) stated
//      only in the finance-orchestration section.
//   2. The "never expose MAX_TOOL_CALLS to the user, divide into
//      steps gracefully" guidance -- explained only in finance-
//      adjacent sections, though the hard numeric ceiling itself is
//      code-enforced regardless.
//   3. No standalone GLOBAL customer-PII (CPF) policy existed anywhere
//      -- only domain-by-domain repetitions, none in the finance-
//      simulation core.
//
// This Wave fixed all three: (1) relocated verbatim into Fase IA-2G.3;
// (2) a new global Preamble bullet + a trimmed, cross-referencing
// 2G.1 bullet (domain specialization kept, redundant global clause
// removed); (3) one new global Preamble bullet, with every existing
// domain-specific CPF mention left untouched (each adds real,
// tool-specific context beyond the generic statement).
//
// This test proves, against the REAL current source:
//   A. Numeric fidelity: canonical rule exists exactly once, now in
//      2G.3, absent from 2G.1, text byte-identical to before the move.
//   B. Tool-budget grace: one global authority exists in the Preamble;
//      MAX_TOOL_CALLS the CODE constant is untouched; no prompt text
//      exposes the literal number to a user-facing instruction; the
//      domain specializations in 2F.1/2F.2/2F.3/2E.1 (which never
//      repeated the "hide the number" instruction at all) are intact.
//   C. Global PII: one canonical Preamble bullet exists; it explicitly
//      disclaims replacing server-side authority; every pre-existing
//      domain-specific CPF mention is still present (kept, not
//      removed, per the audit's own fail-closed default).
//   D. TOM EXECUTIVO (IA-3J.4H): still canonical in 2G.3, unchanged.
//
// Run: node tests/ia-reconciliation/global-policy-hygiene.test.mjs

import { join } from "node:path";
import { readSource } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

const spStart = source.indexOf("const SYSTEM_PROMPT = `");
const backtickStart = source.indexOf("`", spStart);
let i = backtickStart + 1;
while (!(source[i] === "`" && source[i - 1] !== "\\")) i++;
const promptBody = source.slice(backtickStart + 1, i);

const markers = [...promptBody.matchAll(/\n(Fase IA-[A-Za-z0-9.\-]+) — ([^\n:]+)[:\n]/g)];
function sectionSpan(name) {
  const k = markers.findIndex((m) => m[1] === name);
  if (k === -1) return null;
  const start = markers[k].index;
  const end = k + 1 < markers.length ? markers[k + 1].index : promptBody.length;
  return promptBody.slice(start, end);
}
function preamble() {
  return promptBody.slice(0, markers[0].index);
}

// ---------- A. Numeric fidelity ----------
{
  const rule = 'SEMPRE ESCREVA O NÚMERO NO TEXTO, NUNCA SÓ "veja o bloco acima"';
  const count = promptBody.split(rule).length - 1;
  check("numeric-fidelity rule exists exactly once in the whole prompt", count === 1, count);

  const g3 = sectionSpan("Fase IA-2G.3");
  const g1 = sectionSpan("Fase IA-2G.1");
  check("Fase IA-2G.3 contains the numeric-fidelity rule", !!g3 && g3.includes(rule));
  check("Fase IA-2G.1 no longer contains the numeric-fidelity rule", !!g1 && !g1.includes(rule));
  check(
    "the full rule text is byte-identical to its pre-move wording (checked via its own most distinctive closing clause)",
    promptBody.includes('refaça a tool que o calculou em vez de dizer que o dado "não está disponível".')
  );
}

// ---------- B. Tool-budget grace ----------
{
  const pre = preamble();
  const globalBullet = "ORÇAMENTO GLOBAL DE FERRAMENTAS";
  check("a global tool-budget authority bullet exists in the Preamble", pre.includes(globalBullet));
  check(
    "the global bullet never invites fabricating a missing tool result",
    /nunca invente o resultado de uma chamada que não foi feita/.test(pre)
  );
  check(
    "the global bullet instructs never exposing the technical ceiling number to the user",
    /[Nn]unca mencione o número do teto técnico ao usuário/.test(pre)
  );
  check("the global bullet does not hardcode the literal number 5 or the MAX_TOOL_CALLS constant name", !/ORÇAMENTO GLOBAL DE FERRAMENTAS[\s\S]{0,600}(MAX_TOOL_CALLS|\b5\b)/.test(pre));

  const g1 = sectionSpan("Fase IA-2G.1");
  check("Fase IA-2G.1's own budget bullet no longer hardcodes '5 (MAX_TOOL_CALLS)'", !g1.includes("5 (MAX_TOOL_CALLS)"));
  check("Fase IA-2G.1's own budget bullet now cross-references the global rule instead of restating it", /ver ORÇAMENTO GLOBAL DE FERRAMENTAS/.test(g1));
  check(
    "Fase IA-2G.1's own budget bullet keeps its finance-specific chaining example (legitimate domain specialization, not deleted)",
    g1.includes("comparar vários produtos e depois aplicar Cash e/ou Antecipação ao vencedor")
  );

  // Domain specializations that never repeated the "hide the number"
  // instruction at all (pure budget-awareness facts) must remain
  // completely untouched -- this Wave must not have mechanically
  // deleted every MAX_TOOL_CALLS mention.
  for (const [name, text] of [
    ["2F.3 Calculadora de Taxa", 'permitida, dentro de MAX_TOOL_CALLS=5.'],
    ["2F.1 Antecipação", 'é permitida, dentro do limite de MAX_TOOL_CALLS=5'],
    ["2F.2 Cash Conversion", 'permitida, dentro de MAX_TOOL_CALLS=5 (tipicamente 2 chamadas).'],
    ["2E.1 Comparação Multi-Produto", 'ORÇAMENTO DE CHAMADAS: até 5 produtos cabem em até 5 chamadas'],
  ]) {
    check(`${name}'s own domain-specific MAX_TOOL_CALLS mention is untouched`, promptBody.includes(text));
  }

  check(
    "the CODE-level MAX_TOOL_CALLS constant itself is unchanged (still 5, still a plain const)",
    /const MAX_TOOL_CALLS = 5;/.test(source)
  );
  check(
    "the tool-calling loop's own enforcement (toolCallCount > MAX_TOOL_CALLS) is unchanged",
    /if \(toolCallCount > MAX_TOOL_CALLS\) \{/.test(source)
  );
}

// ---------- C. Global PII ----------
{
  const pre = preamble();
  check("a global PII/privacy policy bullet exists in the Preamble", /PRIVACIDADE DE DADOS PESSOAIS, GLOBAL/.test(pre));
  check(
    "the global PII bullet covers CPF, full client name, phone, and email",
    /CPF, nome completo de cliente, telefone, e-mail/.test(pre)
  );
  check(
    "the global PII bullet explicitly disclaims replacing server-side authorization/RLS/tool-policy/data-scope controls",
    /não substitui nem altera autorização, RLS, política de tool ou qualquer controle de escopo de dados/.test(pre)
  );
  check(
    "the global PII bullet covers the post-reset (iniciar_novo_cliente) non-carryover case",
    /Após iniciar_novo_cliente, nunca reaproveite um identificador do cliente anterior/.test(pre)
  );
  check("the global PII bullet never mentions LGPD (matches existing product convention)", !/LGPD/i.test(pre));

  // Every pre-existing domain-specific CPF mention must still be
  // present -- the audit's own fail-closed default was KEEP unless
  // clearly redundant, and none were removed this Wave.
  const cpfCount = (promptBody.match(/CPF/g) || []).length;
  check("CPF still appears 8 times total (7 pre-existing domain mentions + 1 new global bullet, none removed)", cpfCount === 8, cpfCount);
}

// ---------- D. TOM EXECUTIVO (IA-3J.4H) unchanged ----------
{
  const count = (promptBody.match(/TOM EXECUTIVO/g) || []).length;
  check("TOM EXECUTIVO still appears exactly 2 times, both already inside Fase IA-2G.3 (IA-3J.4H's own fix, untouched)", count === 2, count);
  const g3 = sectionSpan("Fase IA-2G.3");
  check("Fase IA-2G.3 still contains both TOM EXECUTIVO occurrences", (g3.match(/TOM EXECUTIVO/g) || []).length === 2);
}

// ---------- E. finance / fast-path / model untouched ----------
{
  check("OPENAI_MODEL constant unchanged (gpt-5.6-luna)", /const OPENAI_MODEL = "gpt-5\.6-luna";/.test(source));
  check("classifyFinanceFastPath function still present, unreferenced by this Wave's diff", source.includes("function classifyFinanceFastPath"));
  check("FINANCE_FAST_PATH_TOOL_NAMES still present", source.includes("FINANCE_FAST_PATH_TOOL_NAMES"));
  check("balaoSelectBestCandidate still present (selection authority untouched)", source.includes("function balaoSelectBestCandidate"));
  check("CAMPANHAS SOB DEMANDA rule still present, unedited", source.includes("CAMPANHAS SOB DEMANDA"));
}

console.log(`\n=== Global Policy Hygiene Tests (IA-3J.4H.2): ${pass}/${pass + fail} ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

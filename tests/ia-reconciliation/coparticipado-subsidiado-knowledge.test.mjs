// IA-KNOWLEDGE-1 — Coparticipado × Subsidiado commercial-knowledge
// correction, permanent regression.
//
// Real Human evidence: "Qual a diferença entre coparticipado e
// subsidiado?" received an answer incomplete in financially important
// ways -- it omitted that a vehicle in trade-in ("carro na troca")
// makes Brabus lose the Trade-In benefit on Coparticipado, and that
// Subsidiado requires MORE THAN 50% down payment (not >=50%).
//
// Root cause (proven this Wave, never assumed): neither fact existed
// anywhere reachable by a purely CONCEPTUAL question about these two
// products -- PROMPT_FINANCE_COPARTICIPADO/PROMPT_FINANCE_SUBSIDIADAS
// (the two canonical blocks already dedicated to each product) only
// covered TOOL-CALLING mechanics for simular_financiamento, never the
// qualitative/advisory commercial rules. This test proves, against the
// REAL current source (never a hand-copied duplicate -- same
// discipline as every other reconciliation test in this directory):
//   A. both critical rules are now present in their canonical blocks;
//   B. neither block makes an unsupported "always better" claim;
//   C. "Subsidiado" remains the preferred operational term;
//   D. a message mentioning "coparticipado" or "subsidiado" ALWAYS
//      routes past the finance fast-path (classifyFinanceFastPath's
//      own pre-existing denylist) into FULL_SYSTEM_PROMPT -- which is
//      what guarantees these corrected blocks are actually in context
//      for the exact reproduction question and every related variant
//      this Wave's own report exercises (Phase 7, scenarios A-I);
//   E. Voice/Realtime carry no competing/duplicated business knowledge
//      of their own -- the single shared authority is architectural
//      (Voice explicitly delegates to Text), not a copy-paste risk.
//
// Run: node tests/ia-reconciliation/coparticipado-subsidiado-knowledge.test.mjs

import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readSource, extractConst, extractFunction, extractTemplateLiteralConst } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + JSON.stringify(detail) : ""}`); }
}

const copBlock = extractTemplateLiteralConst(source, "PROMPT_FINANCE_COPARTICIPADO");
const subBlock = extractTemplateLiteralConst(source, "PROMPT_FINANCE_SUBSIDIADAS");

// ---------- A/B/C. content assertions (semantic presence, not exact prose) ----------
{
  check("COPARTICIPADO_TRADEIN_RULE_PRESENT: Coparticipado block warns Brabus loses Trade-In with a vehicle in trade",
    /carro na troca/i.test(copBlock) && /perde\b.{0,20}\btrade-in/i.test(copBlock), copBlock.length);

  check("COPARTICIPADO_MANUFACTURER_REBATE_PRESENT: Coparticipado block states the manufacturer contributes to the rebate",
    /rebate\b.{0,40}\bmontadora/i.test(copBlock) || /montadora\b.{0,40}\brebate/i.test(copBlock));

  check("SUBSIDIADO_GT_50_ENTRY_PRESENT: Subsidiado block states MORE THAN 50% down payment",
    /MAIS DE 50%/i.test(subBlock));

  check("EXACT_50_NOT_ELIGIBLE: Subsidiado block explicitly says exactly 50% does not meet the criterion, and explicitly forbids silently reinterpreting the rule as >=50%",
    /exatamente 50%.{0,40}n[ãa]o atende esse crit[ée]rio/i.test(subBlock) && /nunca reinterprete/i.test(subBlock));

  check("SUBSIDIADO_STORE_REBATE_COST_PRESENT: Subsidiado block frames the rebate as a dealership commercial cost the deal must fit",
    /cabe no bolso da loja/i.test(subBlock));

  check("SUBSIDIADO_TERMINOLOGY_CORRECT: Subsidiado block names \"Subsidiado\" as the preferred operational term, without demanding \"Taxas Subsidiadas\" replace it",
    /Termo operacional preferido:\s*["“]Subsidiado["”]/i.test(subBlock));

  check("NO_UNSUPPORTED_ALWAYS_BETTER_CLAIM (Coparticipado): block explicitly forbids an unconditional \"always better without trade-in\" framing",
    /Não transforme isso numa regra absoluta/i.test(copBlock) && /Coparticipado é sempre melhor/i.test(copBlock));

  check("NO_UNSUPPORTED_ALWAYS_BETTER_CLAIM (Subsidiado): block explicitly forbids an unconditional \"always worth it above 50%\" framing",
    /Não transforme isso numa regra absoluta/i.test(subBlock) && /Subsidiado sempre vale a pena/i.test(subBlock));
}

// ---------- D. routing reachability: every Coparticipado/Subsidiado-bearing
// message reaches FULL_SYSTEM_PROMPT (classifyFinanceFastPath's own
// pre-existing denylist), never the narrower FINANCE_PROMPT_PROFILE
// that never carries these two blocks at all ----------
{
  const allowReSrc = extractConst(source, "FINANCE_FAST_PATH_ALLOW_RE");
  const denyReSrc = extractConst(source, "FINANCE_FAST_PATH_DENY_RE");
  const classifyFnSrc = extractFunction(source, "classifyFinanceFastPath");
  const fixtureTs = `
export ${allowReSrc}
export ${denyReSrc}
export ${classifyFnSrc}
`;
  const fixturePath = join(import.meta.dirname, ".fixture-knowledge-routing.ts");
  writeFileSync(fixturePath, fixtureTs, "utf8");
  let mod;
  try {
    mod = await import("file://" + fixturePath.replace(/\\/g, "/") + `?t=${Date.now()}`);
  } finally {
    unlinkSync(fixturePath);
  }
  const { classifyFinanceFastPath } = mod;

  // Phase 7 scenarios A-I (this Wave's own report), plus the exact
  // reproduction question -- every one of these must fall through to
  // FULL_SYSTEM_PROMPT (isFinanceFastPath === false), which is what
  // makes the corrected PROMPT_FINANCE_COPARTICIPADO/SUBSIDIADAS blocks
  // actually reach the model for each of them.
  const mustReachFull = [
    ["A", "Qual a diferença entre coparticipado e subsidiado?"],
    ["B", "Quando posso usar subsidiado?"],
    ["C", "Posso usar coparticipado se tiver carro na troca?"],
    ["D", "Quem paga o rebate no coparticipado?"],
    ["E", "O subsidiado custa alguma coisa para a loja?"],
    ["F", "Taxa subsidiada e subsidiado são a mesma coisa?"],
    ["G", "Tenho 40% de entrada. Posso usar subsidiado?"],
    ["H", "Tenho exatamente 50% de entrada. Posso usar subsidiado?"],
    ["I", "Tenho 60% de entrada. O subsidiado sempre vale a pena?"],
  ];
  for (const [label, msg] of mustReachFull) {
    check(`TEXT_AND_VOICE_SHARE_AUTHORITY / reachability, scenario ${label}: "${msg}" routes to FULL_SYSTEM_PROMPT (never the narrower finance-only profile)`,
      classifyFinanceFastPath(msg) === false, msg);
  }
}

// ---------- E. Text/Voice single authority (architectural, not content-duplicated) ----------
{
  const voicePath = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-voice-homolog", "index.ts");
  const realtimePath = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-realtime-homolog", "index.ts");
  const voiceSrc = readFileSync(voicePath, "utf8");
  const realtimeSrc = readFileSync(realtimePath, "utf8");

  check("TEXT_AND_VOICE_SHARE_AUTHORITY: portal-realtime-homolog carries no competing Coparticipado/Subsidiado business rule of its own",
    !/carro na troca/i.test(realtimeSrc) && !/MAIS DE 50%/i.test(realtimeSrc));
  check("TEXT_AND_VOICE_SHARE_AUTHORITY: portal-voice-homolog carries no competing Coparticipado/Subsidiado business rule of its own",
    !/carro na troca/i.test(voiceSrc) && !/MAIS DE 50%/i.test(voiceSrc));
  check("TEXT_AND_VOICE_SHARE_AUTHORITY: portal-realtime-homolog explicitly declares it has no financial knowledge of its own (delegates to portal-ai-homolog)",
    /N[ãa]O tem conhecimento pr[óo]prio sobre financiamentos/i.test(realtimeSrc) && /portal-ai-homolog/i.test(realtimeSrc));
}

console.log();
console.log(`=== Coparticipado × Subsidiado Commercial-Knowledge Tests (IA-KNOWLEDGE-1): ${pass}/${pass + fail} ===`);
console.log("RESULT:", fail === 0 ? "PASS" : "FAIL");
process.exit(fail === 0 ? 0 : 1);

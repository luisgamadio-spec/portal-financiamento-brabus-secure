// IA-3J.4H — prompt policy hygiene / canonicalization reconciliation.
//
// IA-3J.4F found a real entanglement: the GLOBAL "concise-by-default /
// TOM EXECUTIVO / Executive First, Detail on Demand" contract's own
// most detailed, authoritative text (informally self-titled
// "IA-UAT-FIX-05 (UAT-06) — RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO", plus
// the adjacent "Apresentação (Fase IA-2C.1)" paragraph) was physically
// sitting at the tail of Fase IA-2D.2 (Recomendações Comerciais
// Baseadas no Histórico) -- a domain-specific section a future
// finance-only prompt profile would exclude -- even though Fase
// IA-2G.3 (Conversação Natural) already claimed cross-reference
// authority to it by name ("contrato exato na Fase IA-UAT-FIX-05/
// UAT-06").
//
// This Wave relocated that exact block, byte-for-byte (never
// rewritten), from the tail of Fase IA-2D.2 into Fase IA-2G.3, where
// it now sits physically alongside the bullet that already referenced
// it. This test proves, against the REAL current source:
//   1. SYSTEM_PROMPT's total size is byte-identical to before the move
//      (the strongest possible "nothing was silently lost or
//      duplicated" proof for a pure relocation).
//   2. The canonical block text exists in the prompt EXACTLY ONCE
//      (not duplicated, not deleted).
//   3. It now lives inside Fase IA-2G.3's own span, not 2D.2's.
//   4. Fase IA-2D.2's own genuine historical-recommendation-specific
//      rules (untouched by this Wave) are all still present.
//   5. Fase IA-2G.3's own pre-existing bullets (untouched by this
//      Wave) are all still present, in their original relative order.
//   6. No blank-line/formatting artifact was left behind at either the
//      old or new location.
//
// Run: node tests/ia-reconciliation/prompt-policy-canonicalization.test.mjs

import { join } from "node:path";
import { readSource } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- extract SYSTEM_PROMPT body + section map, exactly as the source defines it ----------
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

// ---------- 1. total size unchanged (pure relocation, zero net content change) ----------
{
  check("SYSTEM_PROMPT content is exactly 103,037 chars, byte-identical total size to before this Wave's move", promptBody.length === 103037, promptBody.length);
}

// ---------- 2. canonical block exists exactly once ----------
{
  const marker = "IA-UAT-FIX-05 (UAT-06) — RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO";
  const count = promptBody.split(marker).length - 1;
  check("the canonical 'RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO' rule text appears exactly once (not duplicated, not deleted)", count === 1, count);

  const apresentacaoMarker = "Apresentação (Fase IA-2C.1):";
  const apresentacaoCount = promptBody.split(apresentacaoMarker).length - 1;
  check("the 'Apresentação (Fase IA-2C.1)' paragraph appears exactly once", apresentacaoCount === 1, apresentacaoCount);
}

// ---------- 3. canonical block now lives inside Fase IA-2G.3 ----------
{
  const g3 = sectionSpan("Fase IA-2G.3");
  check("Fase IA-2G.3 section found", !!g3);
  if (g3) {
    check("Fase IA-2G.3 contains the canonical RESPOSTA EXECUTIVA rule text", g3.includes("IA-UAT-FIX-05 (UAT-06) — RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO"));
    check("Fase IA-2G.3 contains the Apresentação (Fase IA-2C.1) paragraph", g3.includes("Apresentação (Fase IA-2C.1):"));
    check("Fase IA-2G.3 contains both TOM EXECUTIVO occurrences now (canonical text + its own pre-existing bullet)", (g3.match(/TOM EXECUTIVO/g) || []).length === 2, g3.match(/TOM EXECUTIVO/g));
    check("Fase IA-2G.3 contains all 3 '2 a 6 frases' occurrences now (canonical text + its own pre-existing bullet's short restatement)", (g3.match(/2 a 6 frases/g) || []).length === 3);
  }
}

// ---------- 4. Fase IA-2D.2's own domain-specific content is untouched and the global block is gone from it ----------
{
  const d2 = sectionSpan("Fase IA-2D.2");
  check("Fase IA-2D.2 section found", !!d2);
  if (d2) {
    check("Fase IA-2D.2 no longer contains the canonical RESPOSTA EXECUTIVA rule text (moved out)", !d2.includes("IA-UAT-FIX-05 (UAT-06) — RESPOSTA EXECUTIVA, AÇÃO PRIMEIRO"));
    check("Fase IA-2D.2 no longer contains the Apresentação (Fase IA-2C.1) paragraph (moved out)", !d2.includes("Apresentação (Fase IA-2C.1):"));
    // Genuine historical-recommendation-specific rules, untouched by this Wave, must all remain.
    check("Fase IA-2D.2 retains IA-UAT-FIX-03 (planos mais usados)", d2.includes("IA-UAT-FIX-03 — PLANOS MAIS USADOS"));
    check("Fase IA-2D.2 retains IA-UAT-FIX-04 (histórico → simulação → recomendação)", d2.includes("IA-UAT-FIX-04 — HISTÓRICO → SIMULAÇÃO → RECOMENDAÇÃO"));
    check("Fase IA-2D.2 retains IA-UAT-FIX-05 (UAT-05) (resolução de modelo/versão -- a DIFFERENT, genuinely domain-specific rule, not the one that moved)", d2.includes("IA-UAT-FIX-05 (UAT-05) — RESOLUÇÃO DE MODELO/VERSÃO"));
    check(
      "Fase IA-2D.2's own size shrank by exactly the moved block's size (17082 -> 13287, delta 3795)",
      17082 - d2.length === 3795,
      d2.length
    );
  }
}

// ---------- 5. Fase IA-2G.3's own pre-existing bullets remain, in order ----------
{
  const g3 = sectionSpan("Fase IA-2G.3");
  const expectedBulletsInOrder = [
    "RESPOSTA PROPORCIONAL (contrato exato na Fase IA-UAT-FIX-05/UAT-06",
    "CONCLUSÃO PRIMEIRO:",
    "PROATIVIDADE — NO MÁXIMO UMA SUGESTÃO",
    "CONECTAR FINANCIAMENTO E APLICAÇÃO NA MESMA MENSAGEM",
    "ASK-ONCE:",
    "TOM EXECUTIVO em Score/Ranking/Comissões/Resultado",
    "\"QUAL VOCÊ ESCOLHERIA\" SEM PRIORIDADE DECLARADA",
    "ISSO NÃO SUBSTITUI AS REGRAS DE PRECISÃO",
  ];
  let cursor = 0;
  let allInOrder = true;
  for (const b of expectedBulletsInOrder) {
    const idx = g3.indexOf(b, cursor);
    if (idx === -1 || idx < cursor) { allInOrder = false; break; }
    cursor = idx;
  }
  check("Fase IA-2G.3's own 8 pre-existing bullets are all still present, in their original relative order", allInOrder);
}

// ---------- 6. no formatting artifact left behind ----------
{
  check("no triple-newline (double blank line) exists anywhere in SYSTEM_PROMPT", !/\r\n\r\n\r\n/.test(promptBody));
  const boundary = source.slice(source.indexOf("Fase IA-2G.1 — Orquestração Financeira") - 90, source.indexOf("Fase IA-2G.1 — Orquestração Financeira"));
  check("exactly one blank line separates Fase IA-2D.2's last bullet from Fase IA-2G.1's header (matches every other section boundary)", /\r\n\r\n$/.test(boundary) && !/\r\n\r\n\r\n$/.test(boundary + "X"));
}

console.log(`\n=== Prompt Policy Canonicalization Tests (IA-3J.4H): ${pass}/${pass + fail} ===`);
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"}`);
if (fail > 0) process.exit(1);

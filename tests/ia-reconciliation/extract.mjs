// IA-RECON-01 — mechanical source extractor.
//
// Purpose: every reconciliation test below must exercise the ACTUAL
// current source of supabase/functions/portal-ai-homolog/index.ts at
// test-run time, never a hand-copied duplicate. A hand-copied replica
// is exactly the failure mode that caused the real FIX-IA-GATE-01
// incident (the Score calcScores() replica drifted from production
// and told a real seller the wrong band). This extractor slices the
// real file by balanced braces starting at a `function name(` or
// `const NAME = ` marker, so the test always runs today's text, not a
// snapshot of it.
//
// Node 24's native TypeScript support (no flags, no transpile step)
// lets the sliced/assembled .ts fixture be `import()`ed directly.

import { readFileSync } from "node:fs";

export function readSource(path) {
  return readFileSync(path, "utf8");
}

// Extracts a `function name(...) { ... }` block (including nested
// braces, e.g. object literals / if-blocks inside it) by counting
// braces from the first `{` after the marker to its match.
export function extractFunction(source, name) {
  // Allows leading indentation (e.g. functions inside an IIFE), since
  // the match must still start at the beginning of its own line.
  const markerRe = new RegExp(`(?:^|\\n)([ \\t]*)(async function|function)\\s+${name}\\s*\\(`);
  const m = markerRe.exec(source);
  if (!m) throw new Error(`extractFunction: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);

  // Find the closing paren of the parameter list first (balanced, since
  // params can themselves contain nested parens).
  const parenOpen = source.indexOf("(", m.index + m[0].length - 1);
  let pdepth = 0, j = parenOpen;
  for (; j < source.length; j++) {
    if (source[j] === "(") pdepth++;
    else if (source[j] === ")") { pdepth--; if (pdepth === 0) { j++; break; } }
  }

  // Everything between the params' ")" and the real function body is a
  // return-type annotation, which may itself contain balanced "{...}"
  // object-type literals (optionally joined by "|" for a union), e.g.
  // `): { ok: true; x: number } | { ok: false } { <body> }`. A "{"
  // that STARTS a return-type object is always immediately preceded
  // (ignoring whitespace) by ":" or "|" -- a plain identifier/"]"/")"
  // before it means this "{" is the real function body instead. Only
  // that first, unambiguous body "{" is used as the extraction start;
  // any return-type object literal along the way is skipped over
  // (balanced) without ever being mistaken for the body.
  let bodyOpen = -1;
  for (let k = j; k < source.length; k++) {
    if (source[k] !== "{") continue;
    let p = k - 1;
    while (p >= 0 && /\s/.test(source[p])) p--;
    const precedingChar = source[p];
    if (precedingChar === ":" || precedingChar === "|") {
      // return-type object literal -- skip its balanced contents and
      // keep scanning from just past its closing brace.
      let d = 0, e = k;
      for (; e < source.length; e++) {
        if (source[e] === "{") d++;
        else if (source[e] === "}") { d--; if (d === 0) { e++; break; } }
      }
      k = e - 1; // -1 to offset the loop's own k++
      continue;
    }
    bodyOpen = k;
    break;
  }
  if (bodyOpen === -1) throw new Error(`extractFunction: no opening brace for "${name}"`);

  let bdepth = 0;
  let i = bodyOpen;
  for (; i < source.length; i++) {
    if (source[i] === "{") bdepth++;
    else if (source[i] === "}") {
      bdepth--;
      if (bdepth === 0) { i++; break; }
    }
  }
  if (bdepth !== 0) throw new Error(`extractFunction: unbalanced braces for "${name}"`);
  return source.slice(start, i);
}

// Extracts a single-line `const NAME = ...;` declaration (also handles
// a `const NAME: Type = ...;` type-annotated form spanning one
// logical statement terminated by `;` at brace-depth 0).
export function extractConst(source, name) {
  const markerRe = new RegExp(`(?:^|\\n)const\\s+${name}\\b`);
  const m = markerRe.exec(source);
  if (!m) throw new Error(`extractConst: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) { i++; break; }
  }
  return source.slice(start, i);
}

// Extracts an `interface Name { ... }` block (type-only, erased by
// Node's TS stripping at import time, but needed so the sliced
// fixture parses as valid TypeScript).
// Returns the FULL declaration, "interface Name { ... }" included --
// callers that need `export` should prepend it to this whole string.
export function extractInterface(source, name) {
  const markerRe = new RegExp(`(?:^|\\n)interface\\s+${name}\\s*\\{`);
  const m = markerRe.exec(source);
  if (!m) throw new Error(`extractInterface: marker for "${name}" not found`);
  const start = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const braceStart = source.indexOf("{", m.index);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i);
}

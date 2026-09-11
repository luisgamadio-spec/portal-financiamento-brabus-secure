// IA-3J.4E — latency telemetry visibility reconciliation.
//
// IA-3G.4 already computed a `timings` object (auth_ms/master_gate_ms/
// config_scope_ms/openai_pass_ms/tool_dispatch_ms) every request, and
// its own comment already documented it as safe: elapsed milliseconds,
// tool NAMES (already logged elsewhere as safe), and call counts only
// -- never prompt/response content, tool arguments/results, headers,
// or any financial row. But it was only ever sent to console.log, and
// IA-3J.4E proved (real correlation-ID-anchored forensic on a real
// 17,790ms request) that this Edge Function's logs are structurally
// unreachable from this environment -- no CLI, no token, nothing.
//
// This test proves, against the REAL current source text (never a
// hand-copied duplicate -- same discipline as structural.test.mjs):
//   1. `timings`'s declared shape is still EXACTLY the 5 already-safe
//      fields (no field silently added/removed since IA-3G.4).
//   2. The tool-dispatch timing push site pushes only {name, ms} --
//      never the tool's args or result alongside it.
//   3. The client-visible `_homolog_edge_timing` object (success path)
//      now includes `stage_ms: timings`, closing the log-access gap.
//   4. The error-path response was NOT touched by this change (still
//      `{error, request_id}` only) -- the Wave's fix was scoped to the
//      one response that actually needed it, not a blanket rewrite.
//
// Run: node tests/ia-reconciliation/latency-telemetry.test.mjs

import { join } from "node:path";
import { readSource, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "supabase", "functions", "portal-ai-homolog", "index.ts");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

// ---------- 1. `timings` shape unchanged since IA-3G.4 ----------
{
  const declStart = source.indexOf("const timings: {");
  const declEnd = source.indexOf("= { auth_ms: null", declStart);
  const decl = source.slice(declStart, declEnd);

  check("timings declares auth_ms: number | null", /auth_ms:\s*number\s*\|\s*null/.test(decl));
  check("timings declares master_gate_ms: number | null", /master_gate_ms:\s*number\s*\|\s*null/.test(decl));
  check("timings declares config_scope_ms: number | null", /config_scope_ms:\s*number\s*\|\s*null/.test(decl));
  check("timings declares openai_pass_ms: number[]", /openai_pass_ms:\s*number\[\]/.test(decl));
  check(
    "timings declares tool_dispatch_ms: Array<{ name: string; ms: number }>",
    /tool_dispatch_ms:\s*Array<\{\s*name:\s*string;\s*ms:\s*number\s*\}>/.test(decl)
  );

  const topLevelFields = [...decl.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  check(
    "timings declares exactly the 8 known-safe fields, nothing else (IA-3J.4F added tools_sent_count; IA-3J.4K.1 added tools_sent_count_per_pass/input_item_count_per_pass)",
    topLevelFields.length === 8 &&
      ["auth_ms", "master_gate_ms", "config_scope_ms", "openai_pass_ms", "tool_dispatch_ms", "tools_sent_count", "tools_sent_count_per_pass", "input_item_count_per_pass"].every((f) => topLevelFields.includes(f)),
    `got: ${topLevelFields.join(", ")}`
  );
  check("timings declares tools_sent_count: number | null", /tools_sent_count:\s*number\s*\|\s*null/.test(decl));
  check("timings declares tools_sent_count_per_pass: number[] (plain counts, never content)", /tools_sent_count_per_pass:\s*number\[\]/.test(decl));
  check("timings declares input_item_count_per_pass: number[] (plain counts, never content)", /input_item_count_per_pass:\s*number\[\]/.test(decl));
}

// ---------- 2. tool_dispatch_ms push site carries only {name, ms} ----------
{
  const pushMatch = /timings\.tool_dispatch_ms\.push\(\s*\{\s*name:\s*call\.name,\s*ms:\s*Date\.now\(\)\s*-\s*t_toolStart\s*\}\s*\)/.exec(source);
  check("tool_dispatch_ms push carries only {name: call.name, ms}", !!pushMatch);
  check(
    "tool_dispatch_ms push does not also carry args/output/result",
    pushMatch ? !/args|output|result/.test(pushMatch[0]) : false
  );
}

// ---------- 3. success-path _homolog_edge_timing now echoes stage_ms ----------
{
  const marker = "_homolog_edge_timing: {";
  const start = source.indexOf(marker);
  check("_homolog_edge_timing object literal found", start !== -1);

  const end = source.indexOf("}", source.indexOf("latency_ms: latencyMs, stage_ms: timings", start));
  const literal = source.slice(start, end + 1);

  check(
    "_homolog_edge_timing includes stage_ms: timings (IA-3J.4E)",
    /stage_ms:\s*timings/.test(literal)
  );
  check(
    "_homolog_edge_timing still includes the pre-existing epoch/instance fields (additive change, nothing removed)",
    /handler_entry_epoch_ms:\s*startedAt/.test(literal) &&
    /response_ready_epoch_ms:\s*Date\.now\(\)/.test(literal) &&
    /instance_id:\s*INSTANCE_ID/.test(literal) &&
    /instance_age_ms:\s*instanceAgeMs/.test(literal) &&
    /latency_ms:\s*latencyMs/.test(literal)
  );
  check(
    "_homolog_edge_timing literal carries no prompt/conversation/message content",
    !/\bmessage\b|\bconversation\b|\bfinalText\b|systemPromptWithDate/.test(literal)
  );
}

// ---------- 4. error-path response left untouched by this Wave ----------
{
  // Anchored on unique text from the main handler's own catch block
  // (the file has many small try/catch blocks elsewhere -- a bare
  // "} catch (e) {" search would match the wrong one).
  const anchor = 'Não consegui consultar a Brabus F&I Intelligence agora.';
  const catchStart = source.lastIndexOf("} catch (e) {", source.indexOf(anchor));
  check("main handler's own catch block located", catchStart !== -1 && catchStart < source.indexOf(anchor));
  const catchBlock = source.slice(catchStart, source.indexOf("});", source.indexOf(anchor)) + 3);

  check(
    "error-path Response body is still only {error, request_id} (no stage_ms leak, no scope creep)",
    /JSON\.stringify\(\{\s*error:\s*message,\s*request_id:\s*requestId\s*\}\)/.test(catchBlock)
  );
  check(
    "error-path console.error still logs the full timings object server-side (unchanged)",
    /timings,\s*\/\/ IA-3G\.4/.test(catchBlock)
  );
}

// ---------- 5. request handler still parses cleanly as JS/TS (sanity) ----------
{
  let threw = false;
  try {
    extractFunction(source, "callOpenAI");
  } catch {
    threw = true;
  }
  check("callOpenAI still extractable (no structural corruption introduced by this Wave's edit)", !threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

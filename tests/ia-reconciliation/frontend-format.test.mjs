// IA-RECON-01 — deterministic frontend structured-block formatting
// tests. Extracts the REAL baiFormatValue() from assets/js/portal-ai-ui.js
// at test time (see extract.mjs) -- proves the IA-RECON-01 date-format
// fix against the actual shipped file, not a duplicate.
//
// Run: node tests/ia-reconciliation/frontend-format.test.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSource, extractFunction } from "./extract.mjs";

const SRC_PATH = join(import.meta.dirname, "..", "..", "assets", "js", "portal-ai-ui.js");
const source = readSource(SRC_PATH);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

const fnText = extractFunction(source, "baiFormatValue");
// eslint-disable-next-line no-new-func
const baiFormatValue = new Function(`return (function baiFormatValue${fnText.slice(fnText.indexOf("("))})`)();

// ---------- Gate 18: structured date rendering (the confirmed bug fix) ----------
{
  const r = baiFormatValue("2026-10-01", "date");
  check(
    "baiFormatValue('2026-10-01', 'date') renders the actual date, not '—'",
    r.text === "01/10/2026",
    `got ${JSON.stringify(r)}`
  );
}
{
  const r = baiFormatValue("2026-01-05", "date");
  check(
    "baiFormatValue: no timezone shift -- day/month preserved exactly as given (05/01/2026)",
    r.text === "05/01/2026",
    `got ${JSON.stringify(r)}`
  );
}
{
  const r = baiFormatValue(null, "date");
  check(
    "baiFormatValue(null, 'date') still falls back to '—' (no crash, no fabricated date)",
    r.text === "—",
    `got ${JSON.stringify(r)}`
  );
}
{
  const r = baiFormatValue("not-a-date", "date");
  check(
    "baiFormatValue: malformed date string falls back to '—', not a garbled render",
    r.text === "—",
    `got ${JSON.stringify(r)}`
  );
}

// ---------- regression: pre-existing formats must be unaffected ----------
{
  const r = baiFormatValue(1234.5, "currency");
  check(
    "baiFormatValue currency format unaffected by the date-format addition",
    r.text === "R$ 1.234,50",
    `got ${JSON.stringify(r)}`
  );
}
{
  const r = baiFormatValue(12.3, "percent");
  check(
    "baiFormatValue percent format unaffected",
    r.text === "12,3%",
    `got ${JSON.stringify(r)}`
  );
}
{
  const r = baiFormatValue(null, "currency");
  check(
    "baiFormatValue numeric guard still rejects null for non-date formats",
    r.text === "—",
    `got ${JSON.stringify(r)}`
  );
}

console.log(`\n=== Frontend Format Reconciliation Tests: ${pass}/${pass + fail} ===`);
console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(fail === 0 ? 0 : 1);

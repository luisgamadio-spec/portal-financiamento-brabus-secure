// SEC-1F.2 -- permanent LIVE-DATABASE regression guard for the fix to
// operational_metrics / operational_model_metrics_without_spf's own
// p_group_view re-verification (SEC-1F.1's proven root cause: GERENTE
// was omitted from `v_group_view_perfil in ('ANALISTA', 'VENDEDOR')`,
// so a GERENTE caller's p_group_view:true request silently stayed
// restricted to their own store -- confirmed live this Wave via
// impersonation: BEFORE the fix, a GERENTE/EUROPA caller's Group
// query returned exactly 1 store (EUROPA); AFTER, 8 stores, including
// BANDEIRANTES).
//
// UNLIKE every other file in tests/ai-uat-e2e/, this is NOT a mock-
// backend test -- the bug this guards against lives entirely inside
// the live RPC's own SQL and is structurally invisible to the mock
// (which returns canned fixture rows regardless of caller). This file
// runs the SAME real-authority-impersonation technique already
// established in this project's own migration testing history
// (Incident P1 Group-View Authorization Escalation's own "6 personas
// reais, impersonação via request.jwt.claims, SELECT-only, nenhuma
// escrita" methodology) -- a transaction that sets request.jwt.claims
// to the real, controlled GERENTE test account's auth_user_id, calls
// the real live RPC, asserts on the real returned data, then ALWAYS
// ROLLBACKs (read-only by construction, regardless of pass/fail).
//
// Requires: `npx supabase` authenticated against the linked project
// (yacqlelpzchcotgngwbh) -- the same CLI access every other live-DB
// read in this engagement's waves has used. No new dependency, no
// credential stored in this repo.
//
// Run: node tests/live-db/sec1f2-gerente-group-view-live-regression.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_REF = "yacqlelpzchcotgngwbh";
// The controlled, Human-approved homologation test account
// (luuis.guga@gmail.com), temporarily configured GERENTE/EUROPA/
// SEMINOVOS since SEC-1F -- read-only impersonation only, never
// written to by this file.
const GERENTE_AUTH_UID = "82f08638-a339-4ff9-beee-bf49d92480ad";
const PERIOD_START = "2026-08-01";
const PERIOD_END = "2026-08-31";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function runSql(sql) {
  const tmpFile = path.join(tmpdir(), `sec1f2-live-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpFile, sql, "utf8");
  try {
    const out = execFileSync(
      "npx",
      ["--yes", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "--file", tmpFile],
      { encoding: "utf8", shell: true, timeout: 30000 }
    );
    const jsonStart = out.indexOf("{");
    if (jsonStart === -1) throw new Error("no JSON object found in supabase db query output: " + out);
    return JSON.parse(out.slice(jsonStart));
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}

function main() {
  // 0. Sanity: impersonation resolves to the exact expected identity.
  const sanity = runSql(`
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"${GERENTE_AUTH_UID}","role":"authenticated"}';
SET LOCAL role = authenticated;
SELECT auth.uid() AS impersonated_uid, public.operational_current_scope() AS scope;
ROLLBACK;
`);
  const sanityRow = sanity.rows?.[0];
  check("0. impersonated auth.uid() matches the controlled GERENTE test account", sanityRow?.impersonated_uid === GERENTE_AUTH_UID, sanityRow);
  check("0. effective scope resolves to profile=GERENTE, store=EUROPA, departments=[SEMINOVOS]",
    sanityRow?.scope?.profile === "GERENTE" && sanityRow?.scope?.store === "EUROPA" && JSON.stringify(sanityRow?.scope?.departments) === JSON.stringify(["SEMINOVOS"]),
    sanityRow?.scope);

  // 1. THE regression assertion: p_group_view=true must return a
  // genuinely cross-store dataset, not an own-store-only one. This
  // exact query returned distinct_store_count=1 (EUROPA only),
  // bandeirantes_present=false BEFORE the SEC-1F.2 fix -- confirmed
  // live this Wave, prior to applying it.
  const groupView = runSql(`
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"${GERENTE_AUTH_UID}","role":"authenticated"}';
SET LOCAL role = authenticated;
WITH g AS (
  SELECT public.operational_metrics('${PERIOD_START}','${PERIOD_END}', true) AS result
)
SELECT
  jsonb_array_length(result->'rows') AS total_row_count,
  (SELECT count(DISTINCT r->>'store') FROM jsonb_array_elements(result->'rows') r) AS distinct_store_count,
  (SELECT bool_or(r->>'store' = 'BANDEIRANTES') FROM jsonb_array_elements(result->'rows') r) AS bandeirantes_present,
  (SELECT bool_or(r->>'store' = 'EUROPA') FROM jsonb_array_elements(result->'rows') r) AS europa_present
FROM g;
ROLLBACK;
`);
  const gvRow = groupView.rows?.[0];
  check("1. GERENTE + p_group_view=true: cross-store result (distinct_store_count > 1)", (gvRow?.distinct_store_count ?? 0) > 1, gvRow);
  check("1. GERENTE + p_group_view=true: BANDEIRANTES (other store) is present", gvRow?.bandeirantes_present === true, gvRow);
  check("1. GERENTE + p_group_view=true: EUROPA (own store) is present", gvRow?.europa_present === true, gvRow);

  // 2. Regression control: p_group_view=false must remain own-store-only
  // (proves the fix only widens the explicit group-view path, never the
  // caller's default/ungrouped scope).
  const noGroupView = runSql(`
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"${GERENTE_AUTH_UID}","role":"authenticated"}';
SET LOCAL role = authenticated;
WITH ng AS (
  SELECT public.operational_metrics('${PERIOD_START}','${PERIOD_END}', false) AS result
)
SELECT
  (SELECT jsonb_agg(DISTINCT r->>'store') FROM jsonb_array_elements(result->'rows') r) AS stores
FROM ng;
ROLLBACK;
`);
  const ngRow = noGroupView.rows?.[0];
  check("2. GERENTE + p_group_view=false: still own-store-only ([EUROPA], unaffected by the fix)", JSON.stringify(ngRow?.stores) === JSON.stringify(["EUROPA"]), ngRow);

  // 3. Same fix, sibling RPC (operational_model_metrics_without_spf,
  // used by consultar_ranking's model dimension).
  const modelMetrics = runSql(`
BEGIN;
SET LOCAL request.jwt.claims = '{"sub":"${GERENTE_AUTH_UID}","role":"authenticated"}';
SET LOCAL role = authenticated;
WITH g AS (
  SELECT public.operational_model_metrics_without_spf('${PERIOD_START}','${PERIOD_END}', true) AS result
)
SELECT
  (SELECT count(DISTINCT r->>'store') FROM jsonb_array_elements(result->'rows') r) AS distinct_store_count
FROM g;
ROLLBACK;
`);
  const mmRow = modelMetrics.rows?.[0];
  check("3. GERENTE + operational_model_metrics_without_spf + p_group_view=true: also cross-store", (mmRow?.distinct_store_count ?? 0) > 1, mmRow);

  console.log(`\n=== SEC-1F.2: GERENTE Group-View Live RPC Regression: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main();

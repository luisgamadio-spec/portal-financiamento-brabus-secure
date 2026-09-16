// REVENDA3 -- static + LIVE regression guard for
// supabase/migrations/20260916120000_revenda3_ia3b_canonical_rpc_exclusion.sql,
// the IA3B-canonical companion to the REVENDA-2 fix already committed in the
// sibling repo (portal-financiamento-brabus-secure, commit be9e96b,
// tests/revenda2_t34887_regression_test.js -- read for the synthetic-fixture
// BEGIN...ROLLBACK technique this file's LIVE layer mirrors) and to this
// repo's own established live-impersonation convention
// (tests/live-db/sec1f2-gerente-group-view-live-regression.mjs, whose
// `npx supabase db query --linked --file <tmp>` technique this file reuses
// directly instead of the sibling repo's Management-API/HTTPS approach --
// this repo has no supabase/.env.local token file, but `npx supabase` is
// already authenticated against the linked project).
//
// Two layers:
//
//  1. STATIC: the new migration file's own SQL text is inspected -- exactly
//     the 4 target functions are redefined, the REVENDA exclusion predicate
//     is present at every required read site, no GRANT/REVOKE/ALTER/RLS/
//     policy statement anywhere, operational_current_scope() is not
//     redefined, and -- critically -- the 2026-09-14 SEC-1F.2 GERENTE-fix
//     and 2026-09-13 SEC-1D.1 Score-fix markers are still present in the
//     new function bodies (proves this migration did not regress them by
//     copy-pasting from a stale/wrong source).
//
//  2. LIVE (real execution, transaction-scoped): applies the EXACT patched
//     function bodies from the migration file (read from disk, not
//     retyped) inside a single BEGIN...ROLLBACK against the real linked
//     project (yacqlelpzchcotgngwbh, guarded explicitly -- never
//     zhzubcismiwdypavwdxf), seeds a synthetic fixture (synthetic
//     usuarios/import_batches/portal_sales/portal_finance_operations/
//     portal_spf_operations rows, all uniquely named/keyed so they can
//     never collide with real data) reproducing a REVENDA-store row
//     alongside a legitimate one for the SAME seller, calls the 4 patched
//     RPCs under 3 different real-shaped personas (MASTER, GERENTE,
//     VENDEDOR) impersonated via request.jwt.claims, asserts REVENDA
//     contributes zero rows/value to every output, asserts the preserved
//     SEC-1F.2 GERENTE group-view fix and SEC-1D.1 Score seller-own-gate
//     fix still behave correctly, then ROLLBACKs -- zero persistent write,
//     verified explicitly below via before/after row counts.
//
// Run: node tests/live-db/revenda3_ia3b_canonical_rpc_regression.mjs

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_REF = "yacqlelpzchcotgngwbh";
const FORBIDDEN_PROJECT_REF = "zhzubcismiwdypavwdxf";
const MIGRATION_PATH = path.join(__dirname, "..", "..", "supabase", "migrations", "20260916120000_revenda3_ia3b_canonical_rpc_exclusion.sql");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

// ---------- LAYER 1: STATIC (migration source text) ----------
function stripSqlLineComments(text) {
  return text.split("\n").map((line) => {
    const idx = line.indexOf("--");
    return idx === -1 ? line : line.slice(0, idx);
  }).join("\n");
}

let MIGRATION_SQL = "";
let CODE_ONLY = "";

function runStaticChecks() {
  check("S0 (migration file exists at the expected path)", existsSync(MIGRATION_PATH), MIGRATION_PATH);
  if (!existsSync(MIGRATION_PATH)) return;
  MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");
  CODE_ONLY = stripSqlLineComments(MIGRATION_SQL);

  check("S1 (exactly 4 function definitions in this migration)",
    (CODE_ONLY.match(/create\s+or\s+replace\s+function/gi) || []).length === 4);
  check("S2 (operational_metrics targeted)", /create\s+or\s+replace\s+function\s+public\.operational_metrics\(/i.test(CODE_ONLY));
  check("S3 (operational_model_metrics targeted -- exact name, not just _without_spf)",
    /create\s+or\s+replace\s+function\s+public\.operational_model_metrics\(p_start/i.test(CODE_ONLY));
  check("S4 (operational_model_metrics_without_spf targeted)",
    /create\s+or\s+replace\s+function\s+public\.operational_model_metrics_without_spf\(/i.test(CODE_ONLY));
  check("S5 (operational_score_coparticipated_data targeted)",
    /create\s+or\s+replace\s+function\s+public\.operational_score_coparticipated_data\(/i.test(CODE_ONLY));
  check("S6 (no operational_fandi_dashboard/operational_salary_details/master_operational_import_* touched -- out of scope, REVENDA-2's own family)",
    !/function\s+public\.(operational_fandi_dashboard|operational_salary_details|master_operational_import_)/i.test(CODE_ONLY));
  check("S7 (no ALTER TABLE/ALTER POLICY/CREATE POLICY/GRANT/REVOKE/DROP FUNCTION anywhere)",
    !/\b(alter\s+table|alter\s+policy|create\s+policy|grant\s|revoke\s|drop\s+function)\b/i.test(CODE_ONLY));
  check("S8 (operational_current_scope not redefined -- authorization untouched)",
    !/create\s+or\s+replace\s+function\s+public\.operational_current_scope/i.test(CODE_ONLY));

  // Predicate presence -- canonical string, exact-match, this codebase's own
  // established normalization style. Counted against CODE_ONLY (comments
  // stripped), so this counts only real predicates in executable SQL, not
  // the header's own prose example of the pattern.
  const predicateCount = (CODE_ONLY.match(/<>\s*'REVENDA'/gi) || []).length;
  check("S9 (REVENDA exclusion predicate present at exactly 11 distinct read sites)", predicateCount === 11, predicateCount);

  // Site-specific checks -- one per CTE identified during implementation.
  check("S10 (operational_metrics: sales_global_latest filtered on s.store)",
    /sales_global_latest as \([\s\S]{0,900}?where upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S11 (operational_metrics: visible_finance filtered on f.store)",
    /visible_finance as \([\s\S]{0,1200}?and upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S12 (operational_model_metrics_without_spf: principal_finance filtered on f.store)",
    /principal_finance as \([\s\S]{0,700}?and upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S13 (operational_model_metrics_without_spf: later_return_finance filtered on f.store)",
    /later_return_finance as \([\s\S]{0,700}?and upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S14 (operational_model_metrics: independent finance_rows filtered on f.store -- the independent-linkage leak)",
    /\), finance_rows as \([\s\S]{0,1400}?and upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S15 (operational_score_coparticipated_data: Block-B finance_rows filtered on f.store)",
    /left join spf_extra_agg sea[\s\S]{0,500}?and upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));
  check("S16 (operational_score_coparticipated_data: spf_latest filtered directly on sp.store -- independent SPF linkage)",
    /spf_latest as \([\s\S]{0,500}?where upper\(trim\(coalesce\(sp\.store, ''\)\)\) <> 'REVENDA'/i.test(CODE_ONLY));

  // ---- Preservation markers: SEC-1F.2 GERENTE group-view fix ----
  // Checked against MIGRATION_SQL (comments intact), not CODE_ONLY --
  // these are the fix's own header/inline comments, the exact thing S9-S16
  // above (checked against CODE_ONLY) must NOT depend on.
  check("S17 (SEC-1F.2 GERENTE-fix marker present)", MIGRATION_SQL.includes("SEC-1F.2"));
  const gerenteListCount = (CODE_ONLY.match(/v_group_view_perfil in \('ANALISTA', 'VENDEDOR', 'GERENTE'\)/g) || []).length;
  check("S18 (GERENTE present in the group-view re-verification list, both operational_metrics and operational_model_metrics_without_spf -- exactly 2 occurrences)", gerenteListCount === 2, gerenteListCount);
  check("S19 (SEC-1F.1 incident context comment preserved)", MIGRATION_SQL.includes("Incidente SEC-1F.1"));

  // ---- Preservation markers: SEC-1D.1 Score fixes ----
  check("S20 (SEC-1D.1 Score-fix marker present)", MIGRATION_SQL.includes("SEC-1D.1"));
  check("S21 (Score fix 1 -- group-view widening -- present exactly 4 times, the 2x2 usuarios/portal_sellers branches in both CTE blocks; portal_sellers branch omits trim(), usuarios branch includes it, matching the original's own asymmetry)",
    (CODE_ONLY.match(/upper\((?:trim\()?coalesce\((?:u\.loja|ps\.store),''\)\)\)?=v_store or p_group_view/g) || []).length === 4);
  check("S22 (Score fix 2 -- seller-own-gate exemption -- exact preserved condition present)",
    CODE_ONLY.includes("if not v_is_master and not v_is_seller and not (v_module_allowed ? 'analiseScoreVendedores') then"));
  check("S23 (Score fix 2's own reasoning comment preserved -- scope resolved before the module gate)",
    MIGRATION_SQL.includes("escopo resolvido ANTES do gate de capacidade"));
}

// ---------- LAYER 2: LIVE (transaction-scoped against the real project) ----------
function runSql(sql) {
  const tmpFile = path.join(tmpdir(), `revenda3-live-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  writeFileSync(tmpFile, sql, "utf8");
  try {
    const out = execFileSync(
      "npx",
      ["--yes", "supabase", "db", "query", "--linked", "--project-ref", PROJECT_REF, "--file", tmpFile],
      { encoding: "utf8", shell: true, timeout: 60000 }
    );
    const jsonStart = out.indexOf("{");
    if (jsonStart === -1) throw new Error("no JSON object found in supabase db query output: " + out);
    return JSON.parse(out.slice(jsonStart));
  } finally {
    try { unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
  }
}

const CHASSIS_LEGIT = "R3TESTLEGIT9990001";
const CHASSIS_REVENDA = "R3TESTREVENDA999002";
const PERIOD_START = "2026-02-01";
const PERIOD_END = "2026-02-28";

function buildFixtureQuery(migrationSql, freeAuthUserId) {
  return `BEGIN;

-- Apply the EXACT patched function bodies from the migration file under
-- test (read from disk, not retyped) -- this transaction tests the real,
-- deployed SQL text, then rolls back both the function redefinition and
-- all fixture data. Zero persistent effect (never DB push, never applied
-- outside this ROLLBACKed transaction).
${migrationSql}

CREATE TEMP TABLE r3_results (key text, value jsonb) ON COMMIT DROP;

DO $do$
DECLARE
  v_master_auth uuid := '${freeAuthUserId}'::uuid;
  v_master_id uuid := gen_random_uuid();
  -- usuarios.auth_user_id has no FK to auth.users (only UNIQUE) -- these
  -- two synthetic personas never need to exist in auth.users, only
  -- v_master_auth does (borrowed, read-only lookup before this
  -- transaction), because portal_import_batches.imported_by has a REAL
  -- FK to auth.users. Same technique as the REVENDA-2 companion fixture.
  v_seller_id uuid := gen_random_uuid();
  v_seller_auth uuid := gen_random_uuid();
  v_gerente_id uuid := gen_random_uuid();
  v_gerente_auth uuid := gen_random_uuid();
  v_batch_sales uuid := gen_random_uuid();
  v_batch_finance uuid := gen_random_uuid();
  v_batch_spf uuid := gen_random_uuid();
  v_date date := '${PERIOD_START.slice(0, 8)}15';
  v_master_cpf text := 'R3TMST' || substr(md5(random()::text), 1, 10);
  v_seller_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_gerente_cpf text := (20000000000 + floor(random() * 7999999999))::bigint::text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master_auth)::text, true);
  PERFORM set_config('app.r3_master_auth', v_master_auth::text, true);
  PERFORM set_config('app.r3_seller_auth', v_seller_auth::text, true);
  PERFORM set_config('app.r3_gerente_auth', v_gerente_auth::text, true);

  INSERT INTO usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status)
  VALUES
    (v_master_id, v_master_auth, 'REVENDA3_TEST_MASTER', 'MASTER', true, v_master_cpf, NULL, NULL),
    (v_seller_id, v_seller_auth, 'REVENDA3_TEST_SELLER', 'VENDEDOR', true, v_seller_cpf, 'REVENDA3_STORE_A', 'NOVOS'),
    (v_gerente_id, v_gerente_auth, 'REVENDA3_TEST_GERENTE', 'GERENTE', true, v_gerente_cpf, 'REVENDA3_STORE_B', 'NOVOS');

  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES
    (v_batch_sales, 'SALES_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_sales.csv', encode(extensions.digest('r3t_sales' || v_batch_sales::text, 'sha256'), 'hex')),
    (v_batch_finance, 'FINANCE_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_finance.csv', encode(extensions.digest('r3t_finance' || v_batch_finance::text, 'sha256'), 'hex')),
    (v_batch_spf, 'SPF_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_spf.csv', encode(extensions.digest('r3t_spf' || v_batch_spf::text, 'sha256'), 'hex'));

  -- Two rows, SAME seller (v_seller_id) -- proves the new predicate
  -- excludes by the row's OWN store field, never by seller eligibility.
  -- vehicle_model is explicitly set (not left to default to the "not
  -- informed" fallback) -- operational_model_metrics_without_spf's own
  -- fallback string and operational_model_metrics' own (separately
  -- preserved, pre-existing, unrelated to this fix) fallback string are
  -- two byte-different mojibake/non-mojibake variants of the same Portuguese
  -- text, which would silently break the (store,department,model) merge
  -- key between the two functions for any row that falls through to that
  -- default -- a real, pre-existing quirk, out of REVENDA3's scope to fix,
  -- avoided here simply by giving the fixture its own real model value.
  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, vehicle_model, source_kind)
  VALUES
    (v_batch_sales, 1, v_date, '${CHASSIS_LEGIT}', v_seller_id, v_seller_cpf, 'REVENDA3_STORE_A', 100000, 'NOVOS', 'REVENDA3 TEST MODEL', 'CURRENT'),
    (v_batch_sales, 2, v_date, '${CHASSIS_REVENDA}', v_seller_id, v_seller_cpf, 'REVENDA', 999999, 'NOVOS', 'REVENDA3 TEST MODEL', 'CURRENT');

  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, seller_user_id, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES
    (v_batch_finance, 1, v_date, '${CHASSIS_LEGIT}', v_seller_id, 'REVENDA3_STORE_A', true, 50000, 'R3_CLIENT_A', 'CURRENT'),
    (v_batch_finance, 2, v_date, '${CHASSIS_REVENDA}', v_seller_id, 'REVENDA', true, 999999, 'R3_CLIENT_B', 'CURRENT');

  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES
    (v_batch_spf, 1, v_date, 'R3_CLIENT_A', 'REVENDA3_STORE_A', 'NOVOS', 'FANDI', 'PAGA', 3000, true, 50000),
    (v_batch_spf, 2, v_date, 'R3_CLIENT_B', 'REVENDA', 'NOVOS', 'FANDI', 'PAGA', 900000, true, 999999);
END $do$;

-- ---- Persona 1: MASTER -- primary REVENDA-exclusion proof, all 4 RPCs ----
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.r3_master_auth'))::text, true);
INSERT INTO r3_results (key, value) VALUES
  ('master_metrics', public.operational_metrics('${PERIOD_START}', '${PERIOD_END}', false)),
  ('master_model_metrics', public.operational_model_metrics('${PERIOD_START}', '${PERIOD_END}', false)),
  ('master_model_metrics_without_spf', public.operational_model_metrics_without_spf('${PERIOD_START}', '${PERIOD_END}', false)),
  ('master_score', public.operational_score_coparticipated_data('${PERIOD_START}', '${PERIOD_END}', false));

-- ---- Persona 2: GERENTE (own store = REVENDA3_STORE_B, no data of their
-- own) -- preserved SEC-1F.2 fix proof: p_group_view=true must widen to
-- see REVENDA3_STORE_A's (other store) legit data, p_group_view=false
-- must not. ----
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.r3_gerente_auth'))::text, true);
INSERT INTO r3_results (key, value) VALUES
  ('gerente_group_view', public.operational_metrics('${PERIOD_START}', '${PERIOD_END}', true)),
  ('gerente_own_view', public.operational_metrics('${PERIOD_START}', '${PERIOD_END}', false));

-- ---- Persona 3: VENDEDOR (the seller itself) -- preserved SEC-1D.1 fix 2
-- proof: analiseScoreVendedores is false for VENDEDOR in the real
-- permissoes_modulos table, yet this call must succeed (not raise 42501)
-- and return only the caller's own (REVENDA-free) data. ----
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('app.r3_seller_auth'))::text, true);
INSERT INTO r3_results (key, value) VALUES
  ('seller_own_score', public.operational_score_coparticipated_data('${PERIOD_START}', '${PERIOD_END}', false));

SELECT jsonb_object_agg(key, value) AS result FROM r3_results;
ROLLBACK;`;
}

function jsonHasNoRevendaStore(node) {
  // Recursively confirms no 'store' key anywhere in the structure equals
  // 'REVENDA' -- robust regardless of which output shape (rows/sales/
  // finance array) is being inspected.
  if (Array.isArray(node)) return node.every(jsonHasNoRevendaStore);
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "store" && v === "REVENDA") return false;
      if (!jsonHasNoRevendaStore(v)) return false;
    }
    return true;
  }
  return true;
}

async function runLiveChecks() {
  check("L0 (PROJECT_REF is the real linked project, never the forbidden staging ref)", PROJECT_REF === "yacqlelpzchcotgngwbh" && PROJECT_REF !== FORBIDDEN_PROJECT_REF);

  let before, beforeSalesLegit, beforeSalesRevenda, freeAuth;
  try {
    before = runSql(`BEGIN; SELECT count(*) AS n FROM usuarios; ROLLBACK;`);
    beforeSalesLegit = runSql(`BEGIN; SELECT count(*) AS n FROM portal_sales WHERE chassis = '${CHASSIS_LEGIT}'; ROLLBACK;`);
    beforeSalesRevenda = runSql(`BEGIN; SELECT count(*) AS n FROM portal_sales WHERE chassis = '${CHASSIS_REVENDA}'; ROLLBACK;`);
  } catch (e) {
    console.log("[SKIP] LIVE layer: could not reach the linked project via `npx supabase db query --linked` (" + e.message + "). Static layer above is authoritative in this environment.");
    return;
  }
  const usuariosBefore = before.rows[0].n;
  check("L1 (PRECONDITION: synthetic legit chassis does not already exist in real data)", beforeSalesLegit.rows[0].n === 0);
  check("L2 (PRECONDITION: synthetic REVENDA chassis does not already exist in real data)", beforeSalesRevenda.rows[0].n === 0);

  const freeAuthResp = runSql(`BEGIN; SELECT au.id::text AS id FROM auth.users au WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_user_id = au.id) LIMIT 1; ROLLBACK;`);
  const freeAuthUserId = freeAuthResp.rows?.[0]?.id;
  check("L3 (PRECONDITION: found a free auth.users id with no usuarios profile to borrow for the synthetic MASTER)", !!freeAuthUserId);
  if (!freeAuthUserId) return;

  let result;
  try {
    const r = runSql(buildFixtureQuery(MIGRATION_SQL, freeAuthUserId));
    result = r.rows?.[0]?.result;
    check("L4 (fixture transaction executed successfully)", !!result, r);
  } catch (e) {
    check("L4 (fixture transaction executed successfully)", false, e.message);
    return;
  }

  // ---- MASTER: REVENDA exclusion across all 4 RPCs ----
  const mm = result.master_metrics;
  const mmRows = mm?.rows || [];
  check("L5 (operational_metrics: no row has store REVENDA)", jsonHasNoRevendaStore(mmRows), mmRows.map((r) => r.store));
  const mmOurRows = mmRows.filter((r) => r.seller_name === "REVENDA3_TEST_SELLER");
  check("L6 (operational_metrics: exactly 1 row for our seller -- REVENDA row excluded, legit row present)", mmOurRows.length === 1, mmOurRows);
  check("L7 (operational_metrics: sales_value reflects ONLY the legit sale (100000) -- REVENDA sale (999999) never leaks in)", mmOurRows[0] && Number(mmOurRows[0].sales_value) === 100000, mmOurRows[0]);
  check("L8 (operational_metrics: production_value reflects ONLY the legit finance row (50000) -- REVENDA finance row (999999) never leaks in)", mmOurRows[0] && Number(mmOurRows[0].production_value) === 50000, mmOurRows[0]);
  check("L9 (operational_metrics: spf_value reflects ONLY the legit SPF row (3000) -- REVENDA SPF row (900000) never leaks in)", mmOurRows[0] && Number(mmOurRows[0].spf_value) === 3000, mmOurRows[0]);

  const mws = result.master_model_metrics_without_spf;
  const mwsRows = (mws?.rows || []);
  check("L10 (operational_model_metrics_without_spf: no row has store REVENDA)", jsonHasNoRevendaStore(mwsRows), mwsRows.map((r) => r.store));
  const mwsOurRow = mwsRows.find((r) => r.store === "REVENDA3_STORE_A");
  check("L11 (operational_model_metrics_without_spf: legit store row present with sold_count=1, financed_count=1)", mwsOurRow && Number(mwsOurRow.sold_count) === 1 && Number(mwsOurRow.financed_count) === 1, mwsOurRow);
  const mwsRevendaRow = mwsRows.find((r) => r.store === "REVENDA");
  check("L12 (operational_model_metrics_without_spf: no REVENDA-store row at all)", !mwsRevendaRow, mwsRevendaRow);

  const mwspf = result.master_model_metrics;
  const mwspfRows = (mwspf?.rows || []);
  check("L13 (operational_model_metrics: no row has store REVENDA)", jsonHasNoRevendaStore(mwspfRows), mwspfRows.map((r) => r.store));
  const mwspfOurRow = mwspfRows.find((r) => r.store === "REVENDA3_STORE_A");
  check("L14 (operational_model_metrics: legit store row present, spf_value reflects ONLY the legit SPF row (3000))", mwspfOurRow && Number(mwspfOurRow.spf_value) === 3000, mwspfOurRow);
  check("L15 (operational_model_metrics: independent finance_rows fix proven -- no leftover REVENDA-store row from the SECOND, independent portal_finance_operations read)", !mwspfRows.find((r) => r.store === "REVENDA"), mwspfRows.map((r) => r.store));

  const ms = result.master_score;
  const msSales = (ms?.sales || []);
  const msFinance = (ms?.finance || []);
  check("L16 (operational_score_coparticipated_data/MASTER: no sales row has store REVENDA)", jsonHasNoRevendaStore(msSales), msSales.map((r) => r.store));
  check("L17 (operational_score_coparticipated_data/MASTER: no finance row has store REVENDA)", jsonHasNoRevendaStore(msFinance), msFinance.map((r) => r.store));
  const msOurSale = msSales.find((r) => r.seller === "REVENDA3_TEST_SELLER");
  check("L18 (operational_score_coparticipated_data/MASTER: exactly 1 sales row for our seller, value=100000)", msOurSale && Number(msOurSale.sale_value) === 100000, msOurSale);
  const msOurFinance = msFinance.find((r) => r.seller === "REVENDA3_TEST_SELLER");
  check("L19 (operational_score_coparticipated_data/MASTER: financed_value=50000, spf_value=3000 -- REVENDA finance/SPF (999999/900000) never leak in)", msOurFinance && Number(msOurFinance.financed_value) === 50000 && Number(msOurFinance.spf_value) === 3000, msOurFinance);

  // ---- GERENTE: preserved SEC-1F.2 fix, combined with REVENDA exclusion ----
  const gGroup = result.gerente_group_view;
  const gGroupRows = (gGroup?.rows || []);
  check("L20 (GERENTE + p_group_view=true: preserved SEC-1F.2 fix -- sees the OTHER store's (REVENDA3_STORE_A) legit data, not restricted to own empty store)", !!gGroupRows.find((r) => r.store === "REVENDA3_STORE_A"), gGroupRows.map((r) => r.store));
  check("L21 (GERENTE + p_group_view=true: REVENDA store never appears even under group-view widening)", jsonHasNoRevendaStore(gGroupRows), gGroupRows.map((r) => r.store));
  const gOwn = result.gerente_own_view;
  const gOwnRows = (gOwn?.rows || []);
  check("L22 (GERENTE + p_group_view=false control: own store REVENDA3_STORE_B has no data -- empty rows, proving the fix only widens the explicit group-view path)", gOwnRows.length === 0, gOwnRows);

  // ---- VENDEDOR: preserved SEC-1D.1 fix 2 (seller-own-gate), combined
  // with REVENDA exclusion for a seller-scoped call ----
  const ss = result.seller_own_score;
  check("L23 (VENDEDOR calling operational_score_coparticipated_data for their own score: succeeds, not blocked by 42501 despite analiseScoreVendedores=false for VENDEDOR -- preserved SEC-1D.1 fix 2)", !!ss && !ss.error, ss);
  const ssSales = (ss?.sales || []);
  check("L24 (VENDEDOR/own score: exactly 1 sales row -- their own legit sale, REVENDA sale excluded)", ssSales.length === 1 && Number(ssSales[0]?.sale_value) === 100000, ssSales);
  check("L25 (VENDEDOR/own score: no row has store REVENDA)", jsonHasNoRevendaStore(ssSales) && jsonHasNoRevendaStore(ss?.finance || []), ss);

  // ---- zero persistent effect ----
  const after = runSql(`BEGIN; SELECT count(*) AS n, count(*) FILTER (WHERE nome ILIKE 'REVENDA3_TEST_%') AS leaked FROM usuarios; ROLLBACK;`);
  check("L26 (zero persistent writes: usuarios row count unchanged)", after.rows[0].n === usuariosBefore, { before: usuariosBefore, after: after.rows[0].n });
  check("L27 (zero leaked synthetic usuarios rows)", after.rows[0].leaked === 0, after.rows[0]);
  const afterSalesLegit = runSql(`BEGIN; SELECT count(*) AS n FROM portal_sales WHERE chassis = '${CHASSIS_LEGIT}'; ROLLBACK;`);
  const afterSalesRevenda = runSql(`BEGIN; SELECT count(*) AS n FROM portal_sales WHERE chassis = '${CHASSIS_REVENDA}'; ROLLBACK;`);
  check("L28 (zero leaked synthetic portal_sales rows -- both fixture chassis absent after rollback)", afterSalesLegit.rows[0].n === 0 && afterSalesRevenda.rows[0].n === 0, { legit: afterSalesLegit.rows[0].n, revenda: afterSalesRevenda.rows[0].n });
}

async function main() {
  runStaticChecks();
  await runLiveChecks();

  console.log("");
  console.log(`=== REVENDA3 IA3B-Canonical RPC Regression: ${pass}/${pass + fail} ===`);
  console.log("RESULT: " + (fail === 0 ? "PASS" : "FAIL"));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

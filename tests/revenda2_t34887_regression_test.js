#!/usr/bin/env node
/*
 * Incidente REVENDA-2 -- T34887 deterministic regression fixture.
 *
 * Reproduces the exact incident (chassi 93XHTGK1WVCT34887 pattern: two
 * distinct real transactions colliding on one chassis in Base 01, one
 * legitimately ANALIA FRANCO/NOVOS with a matching active seller, one
 * legitimately REVENDA/NOVOS with a seller identity that does NOT match
 * any active seller) against the migration
 * supabase/migrations/20260916100000_incidente_revenda2_operational_exclusion_and_identity_safety.sql.
 *
 * Two layers, same pattern already established in this repo (see
 * tests/p2_rh_operational_scope_test.js):
 *
 *  1. STATIC: the migration file's own SQL text is inspected -- exactly
 *     the 4 target functions are redefined, the REVENDA predicate is
 *     present at every required location, and the Fase 3 identity-safety
 *     guard is present in both import functions.
 *
 *  2. LIVE (read-only in effect, fully transaction-scoped): applies the
 *     EXACT patched function bodies from the migration file (read from
 *     disk, not retyped) inside a single BEGIN...ROLLBACK against the
 *     real linked project (yacqlelpzchcotgngwbh, guarded explicitly --
 *     never zhzubcismiwdypavwdxf), seeds a synthetic T34887-pattern
 *     fixture (synthetic usuarios/import_batches/portal_sales/
 *     portal_finance_operations/portal_spf_operations rows, all
 *     uniquely named/keyed so they can never collide with real data),
 *     calls the REAL patched master_operational_import_sales,
 *     operational_salary_details and operational_fandi_dashboard RPCs
 *     against that fixture, asserts the 6 Fase-4 invariants, then
 *     ROLLBACKs -- zero persistent write, verified explicitly below.
 *
 * Run: node tests/revenda2_t34887_regression_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260916100000_incidente_revenda2_operational_exclusion_and_identity_safety.sql');

const results = [];
function check(label, cond) {
  results.push([label, !!cond]);
}

// ---------- LAYER 1: STATIC (migration source text) ----------
function stripSqlLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

let MIGRATION_SQL = '';

function runStaticChecks() {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file must exist at the expected path');
  MIGRATION_SQL = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const codeOnly = stripSqlLineComments(MIGRATION_SQL);

  check('1 (exactly 4 function definitions in this migration)', (codeOnly.match(/create\s+or\s+replace\s+function/gi) || []).length === 4);
  check('2 (operational_fandi_dashboard targeted)', /create\s+or\s+replace\s+function\s+public\.operational_fandi_dashboard\(/i.test(codeOnly));
  check('3 (operational_salary_details targeted)', /create\s+or\s+replace\s+function\s+public\.operational_salary_details\(/i.test(codeOnly));
  check('4 (master_operational_import_sales targeted)', /create\s+or\s+replace\s+function\s+public\.master_operational_import_sales\(/i.test(codeOnly));
  check('5 (master_operational_import_finance targeted)', /create\s+or\s+replace\s+function\s+public\.master_operational_import_finance\(/i.test(codeOnly));
  check('6 (no operational_metrics/operational_model_metrics* touched -- out of scope family)', !/function\s+public\.operational_(model_)?metrics/i.test(codeOnly));
  check('7 (no operational_score_coparticipated_data touched -- out of scope family)', !/function\s+public\.operational_score_coparticipated_data/i.test(codeOnly));
  check('8 (no ALTER of tables/RLS/policy, no GRANT/REVOKE)', !/\b(alter\s+table|alter\s+policy|create\s+policy|grant|revoke)\b/i.test(codeOnly));
  check('9 (operational_current_scope not redefined -- authorization untouched)', !/create\s+or\s+replace\s+function\s+public\.operational_current_scope/i.test(codeOnly));

  // Fase 2 predicate presence -- canonical string, case/whitespace-insensitive on spacing only.
  const predicateCount = (codeOnly.match(/<>\s*'REVENDA'/gi) || []).length;
  check('10 (REVENDA exclusion predicate present at >=6 distinct read points)', predicateCount >= 6);
  check('11 (fandi_dashboard: predicate applied on coalesce(s.store, sc.ctx_store, \'\'))', /coalesce\(s\.store,\s*sc\.ctx_store,\s*''\)\)+\s*<>\s*'REVENDA'/i.test(codeOnly));
  check('12 (salary_details: sales_global_ranked filtered on s.store)', /from public\.portal_sales s\s+join latest_batches lb on lb\.id = s\.batch_id\s+and lb\.source_type in \('SALES_CURRENT','SALES_HISTORY'\)\s+where upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('13 (salary_details: finance_by_sale filtered on f.store)', /finance_by_sale as \(/i.test(codeOnly) && (codeOnly.split('finance_by_sale as (')[1] || '').slice(0, 1500).match(/upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i));
  check('14 (salary_details: spf_links filtered on both f.store and spf.store)', (() => {
    const seg = (codeOnly.split('spf_links as (')[1] || '').slice(0, 1500);
    return /upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(seg) && /upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
  check('15 (salary_details: second/ranked count CTE also filtered)', /ranked as \(/i.test(codeOnly) && (codeOnly.split('ranked as (')[1] || '').slice(0, 800).match(/upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i));

  // Fase 3 identity-safety guard presence in BOTH import functions.
  const guardCount = (codeOnly.match(/prev_seller_cpf_normalizado is not null[\s\S]{0,40}c\.cpf_norm\s*<>\s*pr\.prev_seller_cpf_normalizado/gi) || []).length;
  check('16 (Fase 3 CPF-divergence guard present in both import functions)', guardCount === 2);
  const nbsGuardCount = (codeOnly.match(/prev_seller_nbs is not null[\s\S]{0,40}c\.nbs_norm\s*<>\s*pr\.prev_seller_nbs/gi) || []).length;
  check('17 (Fase 3 NBS-divergence guard present in both import functions)', nbsGuardCount === 2);
  check('18 (IDENTIFICADOR_DUPLICADO/CONFLITO still unconditionally block inheritance)', (codeOnly.match(/classificacao not in \('IDENTIFICADOR_DUPLICADO', 'CONFLITO'\)/gi) || []).length === 2);
  check('19 (previous_resolution extended to carry prev_seller_cpf_normalizado/prev_seller_nbs, both functions)', (codeOnly.match(/prev_seller_cpf_normalizado,\s*\n\s*pr\.prev_seller_nbs|prev_seller_nbs\s*$/gim) || []).length >= 0 && (codeOnly.match(/as prev_seller_cpf_normalizado/gi) || []).length === 2 && (codeOnly.match(/as prev_seller_nbs/gi) || []).length === 2);
}

// ---------- LAYER 2: LIVE (transaction-scoped against the real project) ----------
function readToken() {
  const envPath = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(envPath)) return null;
  const content = fs.readFileSync(envPath, 'utf-8');
  const m = content.match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const CHASSIS = 'RVD2TESTT9999901X'; // 17 chars, unmistakably synthetic -- never a real VIN pattern.

function buildFixtureQuery(migrationSql, freeAuthUserId) {
  return `BEGIN;

-- Apply the EXACT patched function bodies from the migration file under test
-- (read from disk, not retyped) -- this transaction tests the real, deployed
-- SQL text, then rolls back both the function redefinition and all fixture
-- data. Zero persistent effect.
${migrationSql}

DO $do$
DECLARE
  v_master_id uuid := gen_random_uuid();
  -- portal_import_batches.imported_by has a REAL FK to auth.users (unlike
  -- usuarios.auth_user_id, which is only UNIQUE, no FK) -- master_operational_
  -- import_sales/finance require b.imported_by = auth.uid(). We therefore
  -- borrow an EXISTING auth.users row that currently has NO usuarios profile
  -- (looked up read-only just before this transaction), attach a synthetic
  -- MASTER usuarios profile to it for the lifetime of this transaction only,
  -- then ROLLBACK detaches it again -- zero persistent change to that user.
  v_master_auth uuid := '${freeAuthUserId}'::uuid;
  v_eduardo_id uuid := gen_random_uuid();
  v_eduardo_auth uuid := gen_random_uuid();
  v_batch_prev uuid := gen_random_uuid();
  v_batch_current uuid := gen_random_uuid();
  v_batch_finance uuid := gen_random_uuid();
  v_batch_spf uuid := gen_random_uuid();
  v_sale_date date := '2026-01-15';
  -- Random-per-run, all-digit, 11-char test CPFs -- avoids any risk of
  -- colliding with a real or previously-seeded fixed test value (usuarios.cpf
  -- has a UNIQUE constraint). Neither is, nor needs to be, the real
  -- incident CPF -- this is a synthetic reproduction of the FAILURE MODE,
  -- not a re-run against real identities.
  v_eduardo_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_mario_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
BEGIN
  -- cpf_normalizado is a GENERATED column (derived from cpf) -- never
  -- inserted directly.
  INSERT INTO usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status)
  VALUES
    (v_master_id, v_master_auth, 'REVENDA2_TEST_MASTER', 'MASTER', true, 'R2TMASTERTEST' || gen_random_uuid()::text, NULL, NULL),
    (v_eduardo_id, v_eduardo_auth, 'REVENDA2_TEST_EDUARDO', 'VENDEDOR', true, v_eduardo_cpf, 'ANALIA FRANCO', 'NOVOS');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master_auth)::text, true);
  PERFORM set_config('app.r2t_chassis', '${CHASSIS}', true);
  PERFORM set_config('app.r2t_eduardo_id', v_eduardo_id::text, true);
  PERFORM set_config('app.r2t_eduardo_cpf', v_eduardo_cpf, true);

  -- "Previous validated batch" carrying the ALREADY-resolved identity for
  -- this chassis (Eduardo, ANALIA FRANCO) -- this is what previous_resolution
  -- will see when the reimport below runs.
  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES (v_batch_prev, 'SALES_HISTORY', 'VALIDATED', v_master_auth, now() - interval '2 days', now() - interval '2 days', 'r2t_test_prev.csv', encode(extensions.digest('r2t_prev' || v_batch_prev::text, 'sha256'), 'hex'));

  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, source_kind)
  VALUES (v_batch_prev, 1, v_sale_date - 30, '${CHASSIS}', v_eduardo_id, v_eduardo_cpf, 'ANALIA FRANCO', 100000, 'NOVOS', 'HISTORY');

  -- Second (reimport) batch: TWO rows sharing the SAME chassis --
  -- Transaction A (Eduardo, ANALIA FRANCO, CPF matches an active seller)
  -- and Transaction B (Mario, REVENDA, CPF does NOT match any active/
  -- inactive seller -- SEM_MATCH, the exact incident classification).
  INSERT INTO portal_import_batches (id, source_type, status, imported_by, created_at, original_filename, source_sha256)
  VALUES (v_batch_current, 'SALES_CURRENT', 'VALIDATING', v_master_auth, now(), 'r2t_test_current.csv', encode(extensions.digest('r2t_current' || v_batch_current::text, 'sha256'), 'hex'));

  PERFORM public.master_operational_import_sales(v_batch_current, jsonb_build_array(
    jsonb_build_object(
      'source_row_number', 1, 'sale_date', v_sale_date::text, 'chassis', '${CHASSIS}',
      'seller_cpf', v_eduardo_cpf, 'seller_source_name', 'EDUARDO FERNANDO DA SILVA (TESTE)',
      'store', 'ANALIA FRANCO', 'sale_value', 120000, 'department', 'NOVOS', 'source_kind', 'CURRENT'
    ),
    jsonb_build_object(
      'source_row_number', 2, 'sale_date', v_sale_date::text, 'chassis', '${CHASSIS}',
      'seller_cpf', v_mario_cpf, 'seller_source_name', 'MARIO ALBERTO DE SOUZA VAZ (TESTE)',
      'store', 'REVENDA', 'sale_value', 90000, 'department', 'NOVOS', 'source_kind', 'CURRENT'
    )
  ));

  UPDATE portal_import_batches SET status = 'VALIDATED', completed_at = now() WHERE id = v_batch_current;

  -- Finance: same chassis, TWO independent rows -- one legit (ANALIA
  -- FRANCO), one REVENDA (Fase 7 leak scenario: same chassis, different
  -- store, must never feed Transaction A's aggregation).
  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES (v_batch_finance, 'FINANCE_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r2t_test_finance.csv', encode(extensions.digest('r2t_finance' || v_batch_finance::text, 'sha256'), 'hex'));

  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES
    (v_batch_finance, 1, v_sale_date, '${CHASSIS}', 'ANALIA FRANCO', true, 50000, 'R2T_CLIENT_A', 'CURRENT'),
    (v_batch_finance, 2, v_sale_date, '${CHASSIS}', 'REVENDA', true, 999999, 'R2T_CLIENT_B', 'CURRENT');

  -- SPF: distinct client_match_key per transaction, one ANALIA FRANCO
  -- (feeds both operational_salary_details via client_match_key linkage
  -- and operational_fandi_dashboard directly) and one REVENDA.
  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES (v_batch_spf, 'SPF_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r2t_test_spf.csv', encode(extensions.digest('r2t_spf' || v_batch_spf::text, 'sha256'), 'hex'));

  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES
    (v_batch_spf, 1, v_sale_date, 'R2T_CLIENT_A', 'ANALIA FRANCO', 'NOVOS', 'FANDI', 'PAGA', 3000, true, 50000),
    (v_batch_spf, 2, v_sale_date, 'R2T_CLIENT_B', 'REVENDA', 'NOVOS', 'FANDI', 'PAGA', 900000, true, 999999);
END $do$;

SELECT jsonb_build_object(
  'chassis', current_setting('app.r2t_chassis', true),
  'row_a_seller_user_id', (select seller_user_id::text from portal_sales ps join portal_import_batches b on b.id = ps.batch_id where b.status='VALIDATED' and b.source_type='SALES_CURRENT' and ps.chassis = current_setting('app.r2t_chassis', true) and ps.source_row_number = 1),
  'row_b_seller_user_id', (select seller_user_id::text from portal_sales ps join portal_import_batches b on b.id = ps.batch_id where b.status='VALIDATED' and b.source_type='SALES_CURRENT' and ps.chassis = current_setting('app.r2t_chassis', true) and ps.source_row_number = 2),
  'row_a_seller_cpf', (select seller_cpf_normalizado from portal_sales ps join portal_import_batches b on b.id = ps.batch_id where b.status='VALIDATED' and b.source_type='SALES_CURRENT' and ps.chassis = current_setting('app.r2t_chassis', true) and ps.source_row_number = 1),
  'row_b_seller_cpf', (select seller_cpf_normalizado from portal_sales ps join portal_import_batches b on b.id = ps.batch_id where b.status='VALIDATED' and b.source_type='SALES_CURRENT' and ps.chassis = current_setting('app.r2t_chassis', true) and ps.source_row_number = 2),
  'distinct_rows_for_chassis_current_batch', (select count(*) from portal_sales ps join portal_import_batches b on b.id = ps.batch_id where b.status='VALIDATED' and b.source_type='SALES_CURRENT' and ps.chassis = current_setting('app.r2t_chassis', true)),
  'eduardo_id', current_setting('app.r2t_eduardo_id', true),
  'eduardo_cpf', current_setting('app.r2t_eduardo_cpf', true),
  'salary_details', public.operational_salary_details('2026-01-01'::date, '2026-01-31'::date, null),
  'fandi_dashboard', public.operational_fandi_dashboard('2026-01-01'::date, '2026-01-31'::date, null, null)
) AS result;

ROLLBACK;`;
}

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] LIVE layer: no SUPABASE_ACCESS_TOKEN available locally -- static layer above is authoritative in this environment.');
    return;
  }
  assert.ok(!token.includes(FORBIDDEN_PROJECT_REF), 'token file must never reference the forbidden staging project ref');

  const before = await runSql(token, `BEGIN; SELECT count(*) as n FROM usuarios; ROLLBACK;`);
  const usuariosBefore = before.body[0].n;
  const beforeSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis = '${CHASSIS}'; ROLLBACK;`);
  check('20 (PRECONDITION: synthetic chassis does not already exist in real data)', beforeSales.body[0].n === 0);

  // portal_import_batches.imported_by has a real FK to auth.users. Borrow
  // (read-only lookup) an existing auth.users row that currently has no
  // usuarios profile, to attach our synthetic MASTER profile to inside the
  // fixture transaction -- see the comment on v_master_auth below.
  const freeAuth = await runSql(token, `BEGIN; SELECT au.id::text as id FROM auth.users au WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_user_id = au.id) LIMIT 1; ROLLBACK;`);
  const freeAuthUserId = freeAuth.body && freeAuth.body[0] && freeAuth.body[0].id;
  check('20b (PRECONDITION: found a free auth.users id with no usuarios profile to borrow)', !!freeAuthUserId);
  if (!freeAuthUserId) {
    console.log('[LIVE ERROR] no free auth.users id available -- cannot build fixture without risking a real usuarios profile.');
    return;
  }

  const r = await runSql(token, buildFixtureQuery(MIGRATION_SQL, freeAuthUserId));
  if (r.status !== 201 || !r.body || !r.body[0] || !r.body[0].result) {
    console.log('[LIVE ERROR] status=' + r.status);
    console.log(JSON.stringify(r.body, null, 2).slice(0, 4000));
    check('21 (fixture transaction executed successfully)', false);
    return;
  }
  check('21 (fixture transaction executed successfully)', true);
  const out = r.body[0].result;

  // ---- Fase 4 assertion (1)+(2): Transaction B never inherits A's identity; stays NULL ----
  check('22 (Transaction A resolves via its OWN CPF match, not inheritance: row_a_seller_user_id = Eduardo)', out.row_a_seller_user_id === out.eduardo_id);
  check('23 (row_a_seller_cpf persisted = own CPF, Eduardo)', out.row_a_seller_cpf === out.eduardo_cpf);
  check('24 (Transaction B NEVER inherits Transaction A/previous-resolution identity: row_b_seller_user_id is NULL)', out.row_b_seller_user_id === null);
  check('25 (Transaction B seller_user_id_final unresolved, not silently defaulted)', out.row_b_seller_user_id == null);

  // ---- Fase 4 assertion (6): no dedup collapsed the two distinct identities ----
  check('26 (both distinct rows for the colliding chassis persisted -- no row lost/merged)', out.distinct_rows_for_chassis_current_batch === 2);

  // ---- Fase 4 assertion (3)+(4)+(5): RPC aggregation ----
  const sd = out.salary_details;
  const sdRows = (sd && sd.rows) || [];
  const chassisSuffix = CHASSIS.slice(-6);
  const chassisMasked = '******' + chassisSuffix;
  const sdOwnRows = sdRows.filter((row) => row.chassis_masked === chassisMasked);
  check('27 (operational_salary_details: exactly 1 row for our chassis -- Transaction B excluded, not the collision itself)', sdOwnRows.length === 1);
  check('28 (operational_salary_details: the surviving row is Transaction A -- ANALIA FRANCO, Eduardo)', sdOwnRows[0] && sdOwnRows[0].store === 'ANALIA FRANCO' && sdOwnRows[0].seller_name === 'REVENDA2_TEST_EDUARDO');
  check('29 (Fase 7: financed_value reflects ONLY the ANALIA FRANCO finance row (50000) -- REVENDA finance row (999999) on the SAME chassis never leaks in)', sdOwnRows[0] && Number(sdOwnRows[0].financed_value) === 50000);
  check('30 (Fase 7: spf_gross reflects ONLY the ANALIA FRANCO SPF row (3000) -- REVENDA SPF row (900000) never leaks in)', sdOwnRows[0] && Number(sdOwnRows[0].spf_gross) === 3000);
  check('31 (Transaction A included_in_commission = true, not excluded/altered by the fix)', sdOwnRows[0] && sdOwnRows[0].included_in_commission === true);

  const fd = out.fandi_dashboard;
  const fdStores = (fd && fd.stores) || [];
  const fdStoreNames = fdStores.map((s) => s.store);
  check('32 (operational_fandi_dashboard: REVENDA never appears as a store key)', !fdStoreNames.includes('REVENDA'));
  check('33 (operational_fandi_dashboard: ANALIA FRANCO (Transaction A) present)', fdStoreNames.includes('ANALIA FRANCO'));

  // ---- zero persistent effect ----
  const after = await runSql(token, `BEGIN; SELECT count(*) as n, count(*) filter (where nome ILIKE 'REVENDA2_TEST_%') as leaked FROM usuarios; ROLLBACK;`);
  check('34 (zero persistent writes: usuarios row count unchanged)', after.body[0].n === usuariosBefore);
  check('35 (zero leaked synthetic usuarios rows)', after.body[0].leaked === 0);
  const afterSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis = '${CHASSIS}'; ROLLBACK;`);
  check('36 (zero leaked synthetic portal_sales rows -- fixture chassis absent after rollback)', afterSales.body[0].n === 0);
}

async function main() {
  runStaticChecks();
  await runLiveChecks();

  console.log('');
  let passed = 0;
  for (const [label, ok] of results) {
    console.log((ok ? '[PASS] ' : '[FAIL] ') + label);
    if (ok) passed++;
  }
  console.log('');
  console.log(`=== REVENDA-2 T34887 Regression Fixture: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

#!/usr/bin/env node
/*
 * REVENDA Global Negative-Contract Test (Phase 10).
 *
 * Permanent regression guard: for EVERY operational RPC in this repo known
 * to read portal_sales / portal_finance_operations / portal_spf_operations
 * across the whole REVENDA incident, a single shared REVENDA fixture must
 * contribute EXACTLY ZERO to that RPC's output. If any FUTURE change to any
 * of these functions accidentally reintroduces a REVENDA leak, this test
 * fails.
 *
 * Covers 8 functions:
 *   - operational_fandi_dashboard     (REVENDA-2)
 *   - operational_salary_details      (REVENDA-2)
 *   - operational_analyst_commission_metrics     (REVENDA-3, this wave)
 *   - operational_analyst_commission_metrics_v2  (REVENDA-3, wrapper --
 *     not redefined, tested for transitive inheritance)
 *   - operational_reporting_summary               (REVENDA-3, this wave)
 *   - operational_analyst_coverage_metrics        (REVENDA-3, this wave)
 *   - operational_analyst_coverage_details         (REVENDA-3, this wave)
 *   - master_operational_spf_audit_period          (REVENDA-3, this wave)
 *
 * IMPORTANT (discovered while building this test, not assumed): neither
 * REVENDA-2 nor REVENDA-3 is actually deployed to the live project yet --
 * confirmed by fetching the live pg_get_functiondef() of
 * operational_fandi_dashboard and finding the string "REVENDA" appears
 * exactly ONCE, inside a comment (the v_scope_store canonicalization note),
 * never as a real `<> 'REVENDA'` predicate. This matches the parent brief:
 * "this wave does NOT deploy/push/apply anything to the live database" --
 * the prior REVENDA-2 wave was the same. So, exactly like tests/revenda2_
 * t34887_regression_test.js and tests/revenda3_additional_rpc_regression_
 * test.js already do, this test applies BOTH migrations' SQL text (read
 * from disk, not retyped, NOT modified) inside the SAME rolled-back
 * transaction before calling any of the 8 RPCs:
 *   - supabase/migrations/20260916100000_incidente_revenda2_operational_
 *     exclusion_and_identity_safety.sql (read-only reference -- NOT
 *     modified by this wave, see the header comment on that file)
 *   - supabase/migrations/20260916130000_incidente_revenda3_additional_
 *     operational_rpc_exclusion.sql (this wave)
 *
 * KNOWN LIMITATION (documented per the parent brief, Phase 10): this test
 * does NOT include operational_metrics, operational_model_metrics,
 * operational_model_metrics_without_spf or
 * operational_score_coparticipated_data. Those 4 RPCs' canonical,
 * live-matching authority lives in a DIFFERENT repository/migration
 * history (portal-financiamento-brabus-secure-ia3b, branch
 * ia3b-intelligence-reconciliation), patched by a separate, concurrent
 * effort in that repo. They cannot be meaningfully tested from this repo
 * (this repo's own copies of those functions are stale/superseded) and are
 * intentionally out of scope here.
 *
 * Run: node tests/revenda_global_negative_contract_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260916130000_incidente_revenda3_additional_operational_rpc_exclusion.sql');
const MIGRATION2_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260916100000_incidente_revenda2_operational_exclusion_and_identity_safety.sql');

const results = [];
function check(label, cond) {
  results.push([label, !!cond]);
}

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

const RUNTAG = 'RVDGT' + Date.now().toString(36).toUpperCase();
const STORE = 'REVENDA_GLOBAL_TEST_STORE_' + RUNTAG;
const CH_LEGIT = 'RVDGLEGIT' + RUNTAG.slice(-8);
const CH_REVENDA = 'RVDGREVND' + RUNTAG.slice(-8);

function buildFixtureQuery(migration2Sql, migration3Sql, freeAuthUserId) {
  return `BEGIN;

-- Apply REVENDA-2 (already committed at be9e96b, read-only reference, NOT
-- modified by this wave) and REVENDA-3 (this wave) -- neither is deployed
-- to the live project yet (confirmed by a prior read-only check), so both
-- are applied here, in the same rolled-back transaction, exactly like
-- tests/revenda2_t34887_regression_test.js and tests/revenda3_additional_
-- rpc_regression_test.js already do individually.
${migration2Sql}

${migration3Sql}

DO $do$
DECLARE
  v_master_id uuid := gen_random_uuid();
  v_master_auth uuid := '${freeAuthUserId}'::uuid;
  v_analista_id uuid := gen_random_uuid();
  v_analista_auth uuid := gen_random_uuid();
  v_vendedor_id uuid := gen_random_uuid();
  v_vendedor_auth uuid := gen_random_uuid();
  v_ausencia_id uuid := gen_random_uuid();
  v_batch_sales uuid := gen_random_uuid();
  v_batch_finance uuid := gen_random_uuid();
  v_batch_spf uuid := gen_random_uuid();
  v_start date := '2026-03-01';
  v_end date := '2026-03-31';
  v_sale_date date := '2026-03-10';
  v_analista_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_vendedor_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_fandi jsonb;
  v_salary jsonb;
  v_commission jsonb;
  v_commission_v2 jsonb;
  v_reporting jsonb;
  v_coverage_metrics jsonb;
  v_coverage_details jsonb;
  v_spf_audit jsonb;
BEGIN
  INSERT INTO usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status)
  VALUES
    (v_master_id, v_master_auth, 'REVENDA_GLOBAL_TEST_MASTER', 'MASTER', true, 'RGTMASTERTEST' || gen_random_uuid()::text, NULL, NULL),
    (v_analista_id, v_analista_auth, 'REVENDA_GLOBAL_TEST_ANALISTA', 'ANALISTA', true, v_analista_cpf, 'REVENDA_GLOBAL_TEST_HOME_${RUNTAG}', 'NOVOS'),
    (v_vendedor_id, v_vendedor_auth, 'REVENDA_GLOBAL_TEST_VENDEDOR', 'VENDEDOR', true, v_vendedor_cpf, '${STORE}', 'NOVOS');

  INSERT INTO ausencias_analistas (
    id, cpf_analista_ausente, nome_analista_ausente, loja_origem,
    cpf_analista_substituto, nome_analista_substituto,
    loja_coberta, data_inicio, data_fim, motivo, observacao, ativo, criado_por
  ) VALUES (
    v_ausencia_id, '00000000000', 'REVENDA_GLOBAL_TEST_AUSENTE', '${STORE}',
    v_analista_cpf, 'REVENDA_GLOBAL_TEST_ANALISTA',
    '${STORE}', v_start, v_end, 'TESTE REVENDA GLOBAL', 'fixture de teste, sem efeito real', true, v_master_auth
  );

  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES
    (v_batch_sales, 'SALES_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'rgt_sales.csv', encode(extensions.digest('rgt_sales' || v_batch_sales::text, 'sha256'), 'hex')),
    (v_batch_finance, 'FINANCE_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'rgt_finance.csv', encode(extensions.digest('rgt_finance' || v_batch_finance::text, 'sha256'), 'hex')),
    (v_batch_spf, 'SPF_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'rgt_spf.csv', encode(extensions.digest('rgt_spf' || v_batch_spf::text, 'sha256'), 'hex'));

  -- Legit row: exercised by every one of the 8 target RPCs.
  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, source_kind)
  VALUES (v_batch_sales, 1, v_sale_date, '${CH_LEGIT}', v_vendedor_id, v_vendedor_cpf, '${STORE}', 100000, 'NOVOS', 'CURRENT');

  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, seller_user_id, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES (v_batch_finance, 1, v_sale_date, '${CH_LEGIT}', v_vendedor_id, '${STORE}', true, 40000, 'RGT_CLIENT_SHARED_${RUNTAG}', 'CURRENT');

  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES (v_batch_spf, 1, v_sale_date, 'RGT_CLIENT_SHARED_${RUNTAG}', '${STORE}', 'NOVOS', 'FANDI', 'PAGA', 3000, true, 40000);

  -- REVENDA direct row (own chassis) -- must never appear as its own bucket.
  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, source_kind)
  VALUES (v_batch_sales, 2, v_sale_date, '${CH_REVENDA}', v_vendedor_id, v_vendedor_cpf, 'REVENDA', 90000, 'NOVOS', 'CURRENT');

  -- REVENDA finance row on the SAME chassis as the legit finance row --
  -- independent chassis-linkage leak attempt.
  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, seller_user_id, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES (v_batch_finance, 2, v_sale_date, '${CH_LEGIT}', v_vendedor_id, 'REVENDA', true, 999999, 'RGT_CLIENT_SHARED_${RUNTAG}', 'CURRENT');

  -- REVENDA SPF row sharing the SAME client_match_key -- independent
  -- client-linkage leak attempt.
  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES (v_batch_spf, 2, v_sale_date, 'RGT_CLIENT_SHARED_${RUNTAG}', 'REVENDA', 'NOVOS', 'FANDI', 'PAGA', 900000, true, 999999);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master_auth)::text, true);
  SELECT public.operational_fandi_dashboard(v_start, v_end, null, null) INTO STRICT v_fandi;
  SELECT public.operational_salary_details(v_start, v_end, null) INTO STRICT v_salary;
  SELECT public.operational_analyst_commission_metrics(v_start, v_end) INTO STRICT v_commission;
  SELECT public.operational_reporting_summary(v_start, v_end) INTO STRICT v_reporting;
  SELECT public.master_operational_spf_audit_period(v_start, v_end) INTO STRICT v_spf_audit;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_analista_auth)::text, true);
  SELECT public.operational_analyst_coverage_metrics(v_start, v_end, '${STORE}') INTO STRICT v_coverage_metrics;
  SELECT public.operational_analyst_coverage_details(v_ausencia_id) INTO STRICT v_coverage_details;
  SELECT public.operational_analyst_commission_metrics_v2(v_start, v_end) INTO STRICT v_commission_v2;

  PERFORM set_config('app.rgt_fandi', v_fandi::text, true);
  PERFORM set_config('app.rgt_salary', v_salary::text, true);
  PERFORM set_config('app.rgt_commission', v_commission::text, true);
  PERFORM set_config('app.rgt_commission_v2', v_commission_v2::text, true);
  PERFORM set_config('app.rgt_reporting', v_reporting::text, true);
  PERFORM set_config('app.rgt_coverage_metrics', v_coverage_metrics::text, true);
  PERFORM set_config('app.rgt_coverage_details', v_coverage_details::text, true);
  PERFORM set_config('app.rgt_spf_audit', v_spf_audit::text, true);
END $do$;

SELECT jsonb_build_object(
  'fandi', nullif(current_setting('app.rgt_fandi', true), '')::jsonb,
  'salary', nullif(current_setting('app.rgt_salary', true), '')::jsonb,
  'commission', nullif(current_setting('app.rgt_commission', true), '')::jsonb,
  'commission_v2', nullif(current_setting('app.rgt_commission_v2', true), '')::jsonb,
  'reporting', nullif(current_setting('app.rgt_reporting', true), '')::jsonb,
  'coverage_metrics', nullif(current_setting('app.rgt_coverage_metrics', true), '')::jsonb,
  'coverage_details', nullif(current_setting('app.rgt_coverage_details', true), '')::jsonb,
  'spf_audit', nullif(current_setting('app.rgt_spf_audit', true), '')::jsonb
) AS result;

ROLLBACK;`;
}

async function main() {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] no SUPABASE_ACCESS_TOKEN available locally -- this test requires the live layer, nothing to assert statically.');
    console.log('RESULT: SKIP');
    process.exit(0);
  }
  assert.ok(!token.includes(FORBIDDEN_PROJECT_REF), 'token file must never reference the forbidden staging project ref');
  assert.ok(fs.existsSync(MIGRATION_PATH), 'REVENDA-3 migration file must exist');
  assert.ok(fs.existsSync(MIGRATION2_PATH), 'REVENDA-2 migration file must exist (read-only reference, not modified here)');
  const migration3Sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const migration2Sql = fs.readFileSync(MIGRATION2_PATH, 'utf-8');

  // Confirms, read-only, that neither wave is live-deployed yet -- both are
  // therefore applied in-transaction below (see buildFixtureQuery). This is
  // reported, not assumed: if a FUTURE run finds REVENDA-2 already deployed
  // (has_guard true AND it's a real predicate, not just a comment match),
  // applying it again here is harmless (CREATE OR REPLACE is idempotent).
  const liveCheck = await runSql(token, `BEGIN; SELECT pg_get_functiondef('public.operational_fandi_dashboard(date,date,text,text)'::regprocedure) LIKE '%<> ''REVENDA''%' as has_real_guard; ROLLBACK;`);
  check('1 (INFO: whether operational_fandi_dashboard live definition already has a real REVENDA predicate -- informational only, this test applies both migrations in-transaction regardless)', liveCheck.body && liveCheck.body[0] && typeof liveCheck.body[0].has_real_guard === 'boolean');

  const beforeSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis IN ('${CH_LEGIT}', '${CH_REVENDA}'); ROLLBACK;`);
  check('2 (PRECONDITION: synthetic chassis do not already exist in real data)', beforeSales.body[0].n === 0);

  const freeAuth = await runSql(token, `BEGIN; SELECT au.id::text as id FROM auth.users au WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_user_id = au.id) LIMIT 1; ROLLBACK;`);
  const freeAuthUserId = freeAuth.body && freeAuth.body[0] && freeAuth.body[0].id;
  check('3 (PRECONDITION: found a free auth.users id with no usuarios profile to borrow)', !!freeAuthUserId);
  if (!freeAuthUserId) {
    console.log('[LIVE ERROR] no free auth.users id available.');
    printAndExit();
    return;
  }

  const usuariosBefore = (await runSql(token, `BEGIN; SELECT count(*) as n FROM usuarios; ROLLBACK;`)).body[0].n;

  const r = await runSql(token, buildFixtureQuery(migration2Sql, migration3Sql, freeAuthUserId));
  if (r.status !== 201 || !r.body || !r.body[0] || !r.body[0].result) {
    console.log('[LIVE ERROR] status=' + r.status);
    console.log(JSON.stringify(r.body, null, 2).slice(0, 6000));
    check('4 (fixture transaction executed successfully)', false);
    printAndExit();
    return;
  }
  check('4 (fixture transaction executed successfully)', true);
  const out = r.body[0].result;

  // ---- operational_fandi_dashboard ----
  const fdStores = (out.fandi && out.fandi.stores) || [];
  check('5 (fandi_dashboard: REVENDA never appears as a store key)', !fdStores.some((s) => s.store === 'REVENDA'));
  const fdOwn = fdStores.find((s) => s.store === STORE);
  check('6 (fandi_dashboard: synthetic store present with exactly the legit contribution, quantity=1)', !!fdOwn && fdOwn.quantity === 1);
  const spfExtraOwn = ((out.fandi && out.fandi.spf_extra) || []).find((s) => s.store === STORE);
  check('7 (fandi_dashboard: spf_extra value == 3000 exactly, never 900000+3000)', !!spfExtraOwn && Number(spfExtraOwn.spf_value) === 3000);

  // ---- operational_salary_details ----
  const salaryRows = (out.salary && out.salary.rows) || [];
  const salaryOwnRows = salaryRows.filter((r2) => r2.store === STORE);
  check('8 (salary_details: exactly 1 row for the synthetic store -- REVENDA sale never counted)', salaryOwnRows.length === 1);
  check('9 (salary_details: financed_value == 40000 exactly, REVENDA finance row (999999) on the same chassis never leaks in)', salaryOwnRows[0] && Number(salaryOwnRows[0].financed_value) === 40000);
  check('10 (salary_details: spf_gross == 3000 exactly, REVENDA spf row (900000) never leaks in)', salaryOwnRows[0] && Number(salaryOwnRows[0].spf_gross) === 3000);
  check('11 (salary_details: REVENDA never appears as a store value in any row)', !salaryRows.some((r2) => r2.store === 'REVENDA'));

  // ---- operational_analyst_commission_metrics ----
  const commRows = (out.commission && out.commission.rows) || [];
  check('12 (commission_metrics: REVENDA never appears as its own store bucket)', !commRows.some((r2) => r2.store === 'REVENDA'));
  const commOwn = commRows.find((r2) => r2.store === STORE);
  check('13 (commission_metrics: production_value == 40000 exactly)', !!commOwn && Number(commOwn.production_value) === 40000);
  check('14 (commission_metrics: spf_value == 3000 exactly)', !!commOwn && Number(commOwn.spf_value) === 3000);

  // ---- operational_analyst_commission_metrics_v2 (transitive) ----
  const commV2Rows = (out.commission_v2 && out.commission_v2.rows) || [];
  check('15 (commission_metrics_v2: REVENDA never appears as its own store bucket)', !commV2Rows.some((r2) => r2.store === 'REVENDA'));
  const commV2Own = commV2Rows.find((r2) => r2.store === STORE && r2.transfer === true);
  check('16 (commission_metrics_v2: coverage row production_value == 40000 -- transitive inheritance confirmed)', !!commV2Own && Number(commV2Own.production_value) === 40000);

  // ---- operational_reporting_summary ----
  const reportRows = (out.reporting && out.reporting.rows) || [];
  check('17 (reporting_summary: REVENDA never appears as its own store bucket)', !reportRows.some((r2) => r2.store === 'REVENDA'));
  const reportOwn = reportRows.find((r2) => r2.store === STORE);
  check('18 (reporting_summary: financed_or_service_value == 40000 exactly)', !!reportOwn && Number(reportOwn.financed_or_service_value) === 40000);

  // ---- operational_analyst_coverage_metrics ----
  const covMetrics = out.coverage_metrics;
  const covMetricsRow = Array.isArray(covMetrics) ? covMetrics[0] : null;
  check('19 (coverage_metrics: production_value == 40000, spf_value == 3000)', !!covMetricsRow && Number(covMetricsRow.production_value) === 40000 && Number(covMetricsRow.spf_value) === 3000);

  // ---- operational_analyst_coverage_details ----
  const covDetails = out.coverage_details;
  check('20 (coverage_details: summary.production_value == 40000, summary.spf_value == 3000)', covDetails && covDetails.summary && Number(covDetails.summary.production_value) === 40000 && Number(covDetails.summary.spf_value) === 3000);

  // ---- master_operational_spf_audit_period ----
  const spfAuditRows = (out.spf_audit && out.spf_audit.rows) || [];
  check('21 (spf_audit_period: REVENDA never appears as its own store bucket)', !spfAuditRows.some((r2) => r2.store === 'REVENDA'));
  const spfAuditOwn = spfAuditRows.find((r2) => r2.store === STORE);
  check('22 (spf_audit_period: spf_bruto == 3000 exactly, never 900000)', !!spfAuditOwn && Number(spfAuditOwn.spf_bruto) === 3000);

  // ---- zero persistent effect ----
  const after = await runSql(token, `BEGIN; SELECT count(*) as n, count(*) filter (where nome ILIKE 'REVENDA_GLOBAL_TEST_%') as leaked FROM usuarios; ROLLBACK;`);
  check('23 (zero persistent writes: usuarios row count unchanged)', after.body[0].n === usuariosBefore);
  check('24 (zero leaked synthetic usuarios rows)', after.body[0].leaked === 0);
  const afterSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis IN ('${CH_LEGIT}', '${CH_REVENDA}'); ROLLBACK;`);
  check('25 (zero leaked synthetic portal_sales rows)', afterSales.body[0].n === 0);

  printAndExit();
}

function printAndExit() {
  console.log('');
  let passed = 0;
  for (const [label, ok] of results) {
    console.log((ok ? '[PASS] ' : '[FAIL] ') + label);
    if (ok) passed++;
  }
  console.log('');
  console.log(`=== REVENDA Global Negative-Contract Test: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

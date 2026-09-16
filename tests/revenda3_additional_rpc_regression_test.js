#!/usr/bin/env node
/*
 * Incidente REVENDA-3 -- regression fixture for the 6 additional
 * operational RPCs NOT covered by the REVENDA-2 wave
 * (supabase/migrations/20260916100000_incidente_revenda2_operational_
 * exclusion_and_identity_safety.sql, already committed at
 * be9e96bc99698ac83d5d59f88e54b44eee1f207c -- NOT re-tested here).
 *
 * Targets (per supabase/migrations/20260916130000_incidente_revenda3_
 * additional_operational_rpc_exclusion.sql):
 *   1. operational_analyst_commission_metrics    (redefined)
 *   2. operational_analyst_commission_metrics_v2 (NOT redefined -- pure
 *      wrapper over #1 and #4, tested here to prove transitive inheritance)
 *   3. operational_reporting_summary              (redefined)
 *   4. operational_analyst_coverage_metrics       (redefined)
 *   5. operational_analyst_coverage_details        (redefined)
 *   6. master_operational_spf_audit_period         (redefined)
 *
 * Two layers, same convention as tests/revenda2_t34887_regression_test.js:
 *
 *  1. STATIC: inspects the migration file's own SQL text -- exactly 5
 *     functions are redefined (v2 is intentionally NOT one of them),
 *     the REVENDA predicate is present at every required CTE, and no
 *     GRANT/REVOKE/ALTER/policy statement exists anywhere in the file.
 *
 *  2. LIVE (transaction-scoped, ROLLBACK at the end, zero persistent
 *     write): seeds a synthetic fixture under a uniquely-named synthetic
 *     store ('REVENDA3_TEST_STORE_<run>'), guaranteed to not collide with
 *     any real store name, so results are isolated from real production
 *     data without needing a before/after delta against a real store.
 *
 *     The fixture combines 3 attack surfaces in one pass:
 *       (a) a REVENDA sale row on its OWN chassis -- must never surface as
 *           a 'REVENDA' bucket in any output;
 *       (b) a REVENDA finance row on the SAME chassis as the legit sale,
 *           with a store of 'REVENDA' -- tests the independent
 *           chassis-linkage leak (operational_reporting_summary.
 *           finance_groups joins finance to sales by chassis alone);
 *       (c) a REVENDA SPF row sharing the SAME client_match_key as the
 *           legit finance row, with store 'REVENDA' -- tests the
 *           independent client_match_key-linkage leak (spf_by_window /
 *           spf_linked / spf_dedup_by_seller / spf_matched all join SPF
 *           by client_match_key alone).
 *
 *     VALID-DATA NON-REGRESSION (>= 2 functions, as required): for
 *     operational_analyst_commission_metrics and operational_reporting_
 *     summary, the legit-only fixture is inserted and the CURRENTLY LIVE
 *     (still-unpatched, real deployed) function is called and its result
 *     for the synthetic store captured BEFORE this migration's SQL is
 *     applied inside the same transaction. The migration is then applied,
 *     the REVENDA rows are inserted, and the same two RPCs are called
 *     again. The legit-only fields (sold/financed/production/spf) must be
 *     BYTE-IDENTICAL before/after -- proving the patch only removes
 *     REVENDA rows and never alters unrelated valid rows' computed values.
 *
 * Run: node tests/revenda3_additional_rpc_regression_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260916130000_incidente_revenda3_additional_operational_rpc_exclusion.sql');

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

  check('1 (exactly 5 function definitions -- v2 intentionally NOT redefined)', (codeOnly.match(/create\s+or\s+replace\s+function/gi) || []).length === 5);
  check('2 (operational_analyst_commission_metrics targeted)', /create\s+or\s+replace\s+function\s+public\.operational_analyst_commission_metrics\(/i.test(codeOnly));
  check('3 (operational_analyst_commission_metrics_v2 NOT redefined in this file)', !/create\s+or\s+replace\s+function\s+public\.operational_analyst_commission_metrics_v2\(/i.test(codeOnly));
  check('4 (operational_reporting_summary targeted)', /create\s+or\s+replace\s+function\s+public\.operational_reporting_summary\(/i.test(codeOnly));
  check('5 (operational_analyst_coverage_metrics targeted)', /create\s+or\s+replace\s+function\s+public\.operational_analyst_coverage_metrics\(/i.test(codeOnly));
  check('6 (operational_analyst_coverage_details targeted)', /create\s+or\s+replace\s+function\s+public\.operational_analyst_coverage_details\(/i.test(codeOnly));
  check('7 (master_operational_spf_audit_period targeted)', /create\s+or\s+replace\s+function\s+public\.master_operational_spf_audit_period\(/i.test(codeOnly));
  check('8 (no functions from the REVENDA2 wave touched here -- fandi_dashboard/salary_details/import_sales/import_finance)', !/function\s+public\.(operational_fandi_dashboard|operational_salary_details|master_operational_import_sales|master_operational_import_finance)\(/i.test(codeOnly));
  check('9 (no ALTER of tables/RLS/policy, no GRANT/REVOKE)', !/\b(alter\s+table|alter\s+policy|create\s+policy|grant|revoke)\b/i.test(codeOnly));
  check('10 (operational_current_scope not redefined -- authorization untouched)', !/create\s+or\s+replace\s+function\s+public\.operational_current_scope/i.test(codeOnly));

  const predicateCount = (codeOnly.match(/<>\s*'REVENDA'/gi) || []).length;
  check('11 (REVENDA exclusion predicate present at >=14 distinct read points -- 3+2+3+4+2)', predicateCount >= 14);

  // Per-function, per-CTE presence.
  check('12 (commission_metrics: sales_global_latest filtered on s.store)', /sales_global_latest as \([\s\S]{0,700}?upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('13 (commission_metrics: visible_finance_env filtered on f.store)', /visible_finance_env as \([\s\S]{0,1600}?upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('14 (commission_metrics: spf_by_window filtered on spf.store)', /spf_by_window as \([\s\S]{0,900}?upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('15 (reporting_summary: sales_canonical_dedup filtered on s.store)', /sales_canonical_dedup as \([\s\S]{0,700}?upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('16 (reporting_summary: finance_groups filtered on f.store)', /finance_groups as \([\s\S]{0,900}?upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('17 (coverage_metrics: sales_global_latest filtered on s.store)', (() => {
    const idx = codeOnly.indexOf('operational_analyst_coverage_metrics(');
    const seg = codeOnly.slice(idx, idx + 6000);
    return /sales_global_latest as \([\s\S]{0,700}?upper\(trim\(coalesce\(s\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
  check('18 (coverage_metrics: visible_finance filtered on f.store)', (() => {
    const idx = codeOnly.indexOf('operational_analyst_coverage_metrics(');
    const seg = codeOnly.slice(idx, idx + 6000);
    return /visible_finance as \([\s\S]{0,1200}?upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
  check('19 (coverage_metrics: spf_linked filtered on spf.store)', (() => {
    const idx = codeOnly.indexOf('operational_analyst_coverage_metrics(');
    const seg = codeOnly.slice(idx, idx + 8000);
    return /spf_linked as \([\s\S]{0,700}?upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
  check('20 (coverage_details: spf_dedup_by_seller filtered on spf.store)', /spf_dedup_by_seller as \([\s\S]{0,700}?upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('21 (coverage_details: spf_present_by_finance filtered on spf.store)', /spf_present_by_finance as \([\s\S]{0,700}?upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(codeOnly));
  check('22 (spf_audit_period: visible_finance filtered on f.store)', (() => {
    const idx = codeOnly.indexOf('master_operational_spf_audit_period(');
    const seg = codeOnly.slice(idx, idx + 5000);
    return /visible_finance as \([\s\S]{0,1200}?upper\(trim\(coalesce\(f\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
  check('23 (spf_audit_period: spf_matched filtered on spf.store)', (() => {
    const idx = codeOnly.indexOf('master_operational_spf_audit_period(');
    const seg = codeOnly.slice(idx, idx + 5000);
    return /spf_matched as \([\s\S]{0,900}?upper\(trim\(coalesce\(spf\.store, ''\)\)\) <> 'REVENDA'/i.test(seg);
  })());
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

const RUNTAG = 'RVD3T' + Date.now().toString(36).toUpperCase();
const STORE = 'REVENDA3_TEST_STORE_' + RUNTAG;
const HOME_STORE = 'REVENDA3_TEST_HOME_' + RUNTAG;
const CH_LEGIT = 'RVD3LEGIT' + RUNTAG.slice(-8);
const CH_REVENDA = 'RVD3REVND' + RUNTAG.slice(-8);

function buildFixtureQuery(migrationSql, freeAuthUserId) {
  return `BEGIN;

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
  v_start date := '2026-02-01';
  v_end date := '2026-02-28';
  v_sale_date date := '2026-02-10';
  v_analista_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_vendedor_cpf text := (10000000000 + floor(random() * 8999999999))::bigint::text;
  v_before_commission jsonb;
  v_before_reporting jsonb;
  v_after_commission jsonb;
  v_after_reporting jsonb;
  v_after_coverage_metrics jsonb;
  v_after_coverage_details jsonb;
  v_after_v2 jsonb;
  v_after_spf_audit jsonb;
BEGIN
  INSERT INTO usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status)
  VALUES
    (v_master_id, v_master_auth, 'REVENDA3_TEST_MASTER', 'MASTER', true, 'R3TMASTERTEST' || gen_random_uuid()::text, NULL, NULL),
    (v_analista_id, v_analista_auth, 'REVENDA3_TEST_ANALISTA', 'ANALISTA', true, v_analista_cpf, '${HOME_STORE}', 'NOVOS'),
    (v_vendedor_id, v_vendedor_auth, 'REVENDA3_TEST_VENDEDOR', 'VENDEDOR', true, v_vendedor_cpf, '${STORE}', 'NOVOS');

  INSERT INTO ausencias_analistas (
    id, cpf_analista_ausente, nome_analista_ausente, loja_origem,
    cpf_analista_substituto, nome_analista_substituto,
    loja_coberta, data_inicio, data_fim, motivo, observacao, ativo, criado_por
  ) VALUES (
    v_ausencia_id, '00000000000', 'REVENDA3_TEST_AUSENTE', '${STORE}',
    v_analista_cpf, 'REVENDA3_TEST_ANALISTA',
    '${STORE}', v_start, v_end, 'TESTE REVENDA3', 'fixture de teste, sem efeito real', true, v_master_auth
  );

  INSERT INTO portal_import_batches (id, source_type, status, imported_by, completed_at, created_at, original_filename, source_sha256)
  VALUES
    (v_batch_sales, 'SALES_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_sales.csv', encode(extensions.digest('r3t_sales' || v_batch_sales::text, 'sha256'), 'hex')),
    (v_batch_finance, 'FINANCE_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_finance.csv', encode(extensions.digest('r3t_finance' || v_batch_finance::text, 'sha256'), 'hex')),
    (v_batch_spf, 'SPF_CURRENT', 'VALIDATED', v_master_auth, now(), now(), 'r3t_spf.csv', encode(extensions.digest('r3t_spf' || v_batch_spf::text, 'sha256'), 'hex'));

  -- ---- Legit-only fixture (no REVENDA rows yet) ----
  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, source_kind)
  VALUES (v_batch_sales, 1, v_sale_date, '${CH_LEGIT}', v_vendedor_id, v_vendedor_cpf, '${STORE}', 100000, 'NOVOS', 'CURRENT');

  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, seller_user_id, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES (v_batch_finance, 1, v_sale_date, '${CH_LEGIT}', v_vendedor_id, '${STORE}', true, 40000, 'R3T_CLIENT_SHARED_${RUNTAG}', 'CURRENT');

  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES (v_batch_spf, 1, v_sale_date, 'R3T_CLIENT_SHARED_${RUNTAG}', '${STORE}', 'NOVOS', 'FANDI', 'PAGA', 3000, true, 40000);

  -- ---- Capture BEFORE (still-unpatched, live) function results for the
  -- synthetic store, as MASTER, before this migration is applied. ----
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master_auth)::text, true);
  SELECT
    (SELECT x FROM jsonb_array_elements(coalesce(public.operational_analyst_commission_metrics(v_start, v_end)->'rows', '[]'::jsonb)) x WHERE x->>'store' = '${STORE}' LIMIT 1),
    (SELECT x FROM jsonb_array_elements(coalesce(public.operational_reporting_summary(v_start, v_end)->'rows', '[]'::jsonb)) x WHERE x->>'store' = '${STORE}' LIMIT 1)
  INTO v_before_commission, v_before_reporting;

  -- ---- Apply the migration under test (redefines the 5 target functions) ----
${migrationSql}

  -- ---- Now insert the REVENDA leak rows ----
  INSERT INTO portal_sales (batch_id, source_row_number, sale_date, chassis, seller_user_id, seller_cpf_normalizado, store, sale_value, department, source_kind)
  VALUES (v_batch_sales, 2, v_sale_date, '${CH_REVENDA}', v_vendedor_id, v_vendedor_cpf, 'REVENDA', 90000, 'NOVOS', 'CURRENT');

  -- Independent chassis-linkage leak attempt: SAME chassis as the legit
  -- finance row, but store REVENDA.
  INSERT INTO portal_finance_operations (batch_id, source_row_number, operation_date, chassis, seller_user_id, store, is_real_financing, financed_or_service_value, client_match_key, source_kind)
  VALUES (v_batch_finance, 2, v_sale_date, '${CH_LEGIT}', v_vendedor_id, 'REVENDA', true, 999999, 'R3T_CLIENT_SHARED_${RUNTAG}', 'CURRENT');

  -- Independent client_match_key-linkage leak attempt: SAME client as the
  -- legit SPF row, but store REVENDA.
  INSERT INTO portal_spf_operations (batch_id, source_row_number, operation_date, client_match_key, store, department, modality, status, optional_value, is_spf_extra, financed_value)
  VALUES (v_batch_spf, 2, v_sale_date, 'R3T_CLIENT_SHARED_${RUNTAG}', 'REVENDA', 'NOVOS', 'FANDI', 'PAGA', 900000, true, 999999);

  -- ---- Capture AFTER (patched) results, as MASTER / ANALISTA as required ----
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master_auth)::text, true);
  SELECT public.operational_analyst_commission_metrics(v_start, v_end) INTO STRICT v_after_commission;
  SELECT public.operational_reporting_summary(v_start, v_end) INTO STRICT v_after_reporting;
  SELECT public.master_operational_spf_audit_period(v_start, v_end) INTO STRICT v_after_spf_audit;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_analista_auth)::text, true);
  SELECT public.operational_analyst_coverage_metrics(v_start, v_end, '${STORE}') INTO STRICT v_after_coverage_metrics;
  SELECT public.operational_analyst_coverage_details(v_ausencia_id) INTO STRICT v_after_coverage_details;
  SELECT public.operational_analyst_commission_metrics_v2(v_start, v_end) INTO STRICT v_after_v2;

  PERFORM set_config('app.r3t_before_commission', v_before_commission::text, true);
  PERFORM set_config('app.r3t_before_reporting', v_before_reporting::text, true);
  PERFORM set_config('app.r3t_after_commission_full', v_after_commission::text, true);
  PERFORM set_config('app.r3t_after_reporting_full', v_after_reporting::text, true);
  PERFORM set_config('app.r3t_after_coverage_metrics', v_after_coverage_metrics::text, true);
  PERFORM set_config('app.r3t_after_coverage_details', v_after_coverage_details::text, true);
  PERFORM set_config('app.r3t_after_v2', v_after_v2::text, true);
  PERFORM set_config('app.r3t_after_spf_audit', v_after_spf_audit::text, true);
END $do$;

SELECT jsonb_build_object(
  'before_commission', nullif(current_setting('app.r3t_before_commission', true), '')::jsonb,
  'before_reporting', nullif(current_setting('app.r3t_before_reporting', true), '')::jsonb,
  'after_commission_full', nullif(current_setting('app.r3t_after_commission_full', true), '')::jsonb,
  'after_reporting_full', nullif(current_setting('app.r3t_after_reporting_full', true), '')::jsonb,
  'after_coverage_metrics', nullif(current_setting('app.r3t_after_coverage_metrics', true), '')::jsonb,
  'after_coverage_details', nullif(current_setting('app.r3t_after_coverage_details', true), '')::jsonb,
  'after_v2', nullif(current_setting('app.r3t_after_v2', true), '')::jsonb,
  'after_spf_audit', nullif(current_setting('app.r3t_after_spf_audit', true), '')::jsonb
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

  const beforeSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis IN ('${CH_LEGIT}', '${CH_REVENDA}'); ROLLBACK;`);
  check('24 (PRECONDITION: synthetic chassis do not already exist in real data)', beforeSales.body[0].n === 0);

  const freeAuth = await runSql(token, `BEGIN; SELECT au.id::text as id FROM auth.users au WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.auth_user_id = au.id) LIMIT 1; ROLLBACK;`);
  const freeAuthUserId = freeAuth.body && freeAuth.body[0] && freeAuth.body[0].id;
  check('24b (PRECONDITION: found a free auth.users id with no usuarios profile to borrow)', !!freeAuthUserId);
  if (!freeAuthUserId) {
    console.log('[LIVE ERROR] no free auth.users id available.');
    return;
  }

  const usuariosBefore = (await runSql(token, `BEGIN; SELECT count(*) as n FROM usuarios; ROLLBACK;`)).body[0].n;

  const r = await runSql(token, buildFixtureQuery(MIGRATION_SQL, freeAuthUserId));
  if (r.status !== 201 || !r.body || !r.body[0] || !r.body[0].result) {
    console.log('[LIVE ERROR] status=' + r.status);
    console.log(JSON.stringify(r.body, null, 2).slice(0, 6000));
    check('25 (fixture transaction executed successfully)', false);
    return;
  }
  check('25 (fixture transaction executed successfully)', true);
  const out = r.body[0].result;

  // ---- VALID-DATA NON-REGRESSION (commission_metrics, reporting_summary) ----
  const bc = out.before_commission;
  const br = out.before_reporting;
  check('26 (PRECONDITION: BEFORE commission_metrics row for the synthetic store exists, pre-patch)', !!bc);
  check('27 (PRECONDITION: BEFORE reporting_summary row for the synthetic store exists, pre-patch)', !!br);

  const acFull = out.after_commission_full;
  const acRows = (acFull && acFull.rows) || [];
  const ac = acRows.find((x) => x.store === STORE);
  check('28 (AFTER commission_metrics row for the synthetic store exists, post-patch)', !!ac);
  if (bc && ac) {
    check('29 (commission_metrics: sold_count identical before/after -- valid data unaffected by patch)', bc.sold_count === ac.sold_count);
    check('30 (commission_metrics: financed_count identical before/after)', bc.financed_count === ac.financed_count);
    check('31 (commission_metrics: production_value identical before/after -- REVENDA finance row (999999) never leaks in)', Number(bc.production_value) === Number(ac.production_value));
    check('32 (commission_metrics: spf_value identical before/after -- REVENDA SPF row (900000) never leaks in)', Number(bc.spf_value) === Number(ac.spf_value));
    check('33 (commission_metrics: sold_count == 1 -- the REVENDA sale on its own chassis never counted)', ac.sold_count === 1);
    check('34 (commission_metrics: production_value == 40000 exactly)', Number(ac.production_value) === 40000);
    check('35 (commission_metrics: spf_value == 3000 exactly)', Number(ac.spf_value) === 3000);
  }
  check('36 (commission_metrics: REVENDA never appears as its own store bucket)', !acRows.some((x) => x.store === 'REVENDA'));

  const rsFull = out.after_reporting_full;
  const rsRows = (rsFull && rsFull.rows) || [];
  const rs = rsRows.find((x) => x.store === STORE);
  check('37 (AFTER reporting_summary row for the synthetic store exists, post-patch)', !!rs);
  if (br && rs) {
    check('38 (reporting_summary: sales_count identical before/after)', br.sales_count === rs.sales_count);
    check('39 (reporting_summary: financed_or_service_value identical before/after -- REVENDA finance row on the SAME chassis never leaks in)', Number(br.financed_or_service_value) === Number(rs.financed_or_service_value));
    check('40 (reporting_summary: sales_count == 1 exactly)', rs.sales_count === 1);
    check('41 (reporting_summary: financed_or_service_value == 40000 exactly)', Number(rs.financed_or_service_value) === 40000);
  }
  check('42 (reporting_summary: REVENDA never appears as its own store bucket)', !rsRows.some((x) => x.store === 'REVENDA'));

  // ---- coverage_metrics ----
  const cm = out.after_coverage_metrics;
  const cmRow = (cm && cm[0]) || null;
  check('43 (coverage_metrics: returns exactly 1 row for the covered store/period)', Array.isArray(cm) && cm.length === 1);
  check('44 (coverage_metrics: sold_count == 1 -- REVENDA sale excluded)', cmRow && cmRow.sold_count === 1);
  check('45 (coverage_metrics: production_value == 40000 -- REVENDA finance leak closed)', cmRow && Number(cmRow.production_value) === 40000);
  check('46 (coverage_metrics: spf_value == 3000 -- REVENDA spf leak closed)', cmRow && Number(cmRow.spf_value) === 3000);

  // ---- coverage_details ----
  const cd = out.after_coverage_details;
  check('47 (coverage_details: summary.sold_count == 1)', cd && cd.summary && cd.summary.sold_count === 1);
  check('48 (coverage_details: summary.production_value == 40000)', cd && cd.summary && Number(cd.summary.production_value) === 40000);
  check('49 (coverage_details: summary.spf_value == 3000)', cd && cd.summary && Number(cd.summary.spf_value) === 3000);
  const cdFinanceRows = (cd && cd.finance) || [];
  check('50 (coverage_details: finance rows contain ONLY the legit 40000 row, never the REVENDA 999999 row)', cdFinanceRows.length === 1 && Number(cdFinanceRows[0].financed_or_service_value) === 40000);
  const cdSalesRows = (cd && cd.sales) || [];
  check('51 (coverage_details: sales rows contain ONLY the legit sale, never the REVENDA sale)', cdSalesRows.length === 1);

  // ---- commission_metrics_v2 (transitive inheritance, not redefined) ----
  const v2 = out.after_v2;
  const v2Rows = (v2 && v2.rows) || [];
  const v2Coverage = v2Rows.find((x) => x.store === STORE && x.transfer === true);
  check('52 (v2: coverage-injected row for the synthetic store present, with coverage_id)', !!v2Coverage && !!v2Coverage.coverage_id);
  check('53 (v2: coverage row sold_count == 1 -- inherits the coverage_metrics fix transitively, without its own redefinition)', v2Coverage && v2Coverage.sold_count === 1);
  check('54 (v2: coverage row production_value == 40000 -- transitively excludes REVENDA)', v2Coverage && Number(v2Coverage.production_value) === 40000);
  check('55 (v2: REVENDA never appears as its own store bucket)', !v2Rows.some((x) => x.store === 'REVENDA'));

  // ---- spf_audit_period ----
  const spfAudit = out.after_spf_audit;
  const spfRows = (spfAudit && spfAudit.rows) || [];
  const spfOwn = spfRows.filter((x) => x.store === STORE);
  check('56 (spf_audit_period: exactly 1 row for the synthetic store -- REVENDA spf row excluded)', spfOwn.length === 1);
  check('57 (spf_audit_period: spf_bruto == 3000 exactly, never 900000)', spfOwn[0] && Number(spfOwn[0].spf_bruto) === 3000);
  check('58 (spf_audit_period: REVENDA never appears as its own store bucket)', !spfRows.some((x) => x.store === 'REVENDA'));

  // ---- zero persistent effect ----
  const after = await runSql(token, `BEGIN; SELECT count(*) as n, count(*) filter (where nome ILIKE 'REVENDA3_TEST_%') as leaked FROM usuarios; ROLLBACK;`);
  check('59 (zero persistent writes: usuarios row count unchanged)', after.body[0].n === usuariosBefore);
  check('60 (zero leaked synthetic usuarios rows)', after.body[0].leaked === 0);
  const afterSales = await runSql(token, `BEGIN; SELECT count(*) as n FROM portal_sales WHERE chassis IN ('${CH_LEGIT}', '${CH_REVENDA}'); ROLLBACK;`);
  check('61 (zero leaked synthetic portal_sales rows -- fixture chassis absent after rollback)', afterSales.body[0].n === 0);
  const afterFn = await runSql(token, `BEGIN; SELECT pg_get_functiondef('public.operational_analyst_commission_metrics(date,date)'::regprocedure) LIKE '%REVENDA3%' as leaked_marker; ROLLBACK;`);
  check('62 (zero persistent function redefinition: the REVENDA3 marker comment from this test transaction is absent from the live function definition -- ROLLBACK also undid the in-transaction CREATE OR REPLACE)', afterFn.body[0] && afterFn.body[0].leaked_marker === false);
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
  console.log(`=== REVENDA-3 Additional RPC Regression Fixture: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

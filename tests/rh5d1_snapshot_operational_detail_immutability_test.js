#!/usr/bin/env node
/*
 * RH-5D.1 -- SNAPSHOT_OPERATIONAL_DETAIL_NOT_DB_IMMUTABLE parity hardening.
 *
 * Same two-layer pattern as tests/rh5d_snapshot_comissoes_immutability_test.js:
 *  1. STATIC: migration text proves the guard trigger exists, is wired to
 *     BEFORE UPDATE/DELETE/TRUNCATE on snapshot_operational_detail only,
 *     never touches snapshot_comissoes or its own RH-5D trigger/migration,
 *     and touches no RLS policy or grant.
 *  2. LIVE (BEGIN...ROLLBACK-scoped only, real deployed database,
 *     yacqlelpzchcotgngwbh, never zhzubcismiwdypavwdxf): UPDATE/DELETE/
 *     TRUNCATE against a real row are rejected (0A000), even for the
 *     privileged role that applied the migration; snapshot_comissoes's
 *     own RH-5D triggers remain present and enabled (regression); row
 *     counts on both tables are unchanged after every probe.
 *
 * Zero PII, zero real financial values, zero persistent write. Never
 * executes a real Fechar Competencia. Run:
 *   node tests/rh5d1_snapshot_operational_detail_immutability_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260909140000_rh5d1_snapshot_operational_detail_immutability.sql');

const results = [];
function check(label, cond) { results.push([label, !!cond]); }

function stripSqlLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

function runStaticChecks() {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file must exist at the expected path');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const codeOnly = stripSqlLineComments(sql);

  check('1 (guard function unconditionally raises an exception)', /raise\s+exception\s+'SNAPSHOT_OPERATIONAL_DETAIL_IMMUTABLE/i.test(codeOnly));
  check('2 (guard uses SQLSTATE 0A000, same contract as snapshot_comissoes)', /using\s+errcode\s*=\s*'0A000'/i.test(codeOnly));
  check('3 (BEFORE UPDATE trigger wired to snapshot_operational_detail)', /before\s+update\s+on\s+public\.snapshot_operational_detail/i.test(codeOnly));
  check('4 (BEFORE DELETE trigger wired to snapshot_operational_detail)', /before\s+delete\s+on\s+public\.snapshot_operational_detail/i.test(codeOnly));
  check('5 (BEFORE TRUNCATE trigger wired to snapshot_operational_detail)', /before\s+truncate\s+on\s+public\.snapshot_operational_detail/i.test(codeOnly));
  check('6 (idempotent -- drops any prior trigger of the same name first)', (codeOnly.match(/drop\s+trigger\s+if\s+exists/gi) || []).length >= 3);
  check('7 (INSERT is never mentioned as a blocked operation)', !/before\s+insert\s+on\s+public\.snapshot_operational_detail/i.test(codeOnly));
  check('8 (no RLS policy is created/altered/dropped in this migration)', !/create\s+policy|alter\s+policy|drop\s+policy/i.test(codeOnly));
  check('9 (no GRANT/REVOKE statement in this migration)', !/\bgrant\b|\brevoke\b/i.test(codeOnly));
  check('10 (snapshot_comissoes / its own RH-5D trigger are not touched by this migration -- scope discipline)', !/snapshot_comissoes\b/i.test(codeOnly));
}

function readToken() {
  const envPath = path.join(__dirname, '..', 'supabase', '.env.local');
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
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
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

// snapshot_operational_detail is currently EMPTY in production (zero
// real closings have run through the PM-6D.2 path yet -- confirmed
// live this wave, not a bug). A row-targeted UPDATE/DELETE against a
// non-existent id matches zero rows, and a FOR EACH ROW trigger never
// fires for zero affected rows -- that would silently under-prove the
// contract. Instead, insert a synthetic row INSIDE the same rolled-back
// transaction (a real fechamento_id is required to satisfy the FK/NOT
// NULL constraint, but nothing here is ever committed) and mutate that
// row -- still zero persistent writes, but now actually exercises the
// per-row trigger path.
function mutationProbeSql(op) {
  const stmt = {
    UPDATE: `UPDATE public.snapshot_operational_detail SET store = 'MUTATED' WHERE id = v_new_id;`,
    DELETE: `DELETE FROM public.snapshot_operational_detail WHERE id = v_new_id;`,
  }[op];
  return `
BEGIN;
DO $$
DECLARE
  v_real_fechamento_id uuid;
  v_new_id uuid;
BEGIN
  SELECT id INTO v_real_fechamento_id FROM public.fechamentos_comissao LIMIT 1;
  INSERT INTO public.snapshot_operational_detail (fechamento_id, kind, store)
  VALUES (v_real_fechamento_id, 'CHASSIS', 'RH5D1_SYNTHETIC_TEST_ROW')
  RETURNING id INTO v_new_id;

  BEGIN
    ${stmt}
    RAISE EXCEPTION 'TEST_FAIL_NOT_BLOCKED';
  EXCEPTION WHEN SQLSTATE '0A000' THEN
    RAISE NOTICE 'BLOCKED_AS_EXPECTED';
  END;
END $$;
SELECT 'ok' as probe_result;
ROLLBACK;
`;
}

function truncateProbeSql() {
  return `
BEGIN;
DO $$
BEGIN
  TRUNCATE public.snapshot_operational_detail;
  RAISE EXCEPTION 'TEST_FAIL_NOT_BLOCKED';
EXCEPTION WHEN SQLSTATE '0A000' THEN
  RAISE NOTICE 'BLOCKED_AS_EXPECTED';
END $$;
SELECT 'ok' as probe_result;
ROLLBACK;
`;
}

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    check('LIVE: SUPABASE_ACCESS_TOKEN available (supabase/.env.local)', false);
    return;
  }
  assert.notStrictEqual(PROJECT_REF, FORBIDDEN_PROJECT_REF, 'must never target the dormant staging project');

  const before = await runSql(token, `select
    (select count(*) from public.snapshot_operational_detail) as sod_n,
    (select count(*) from public.snapshot_comissoes) as sc_n;`);
  const beforeSod = before.status === 201 ? Number(before.body[0].sod_n) : null;
  const beforeSc = before.status === 201 ? Number(before.body[0].sc_n) : null;
  check('LIVE: baseline row counts read successfully before any probe', beforeSod !== null && beforeSc !== null);

  const upd = await runSql(token, mutationProbeSql('UPDATE'));
  check('LIVE: UPDATE against a snapshot_operational_detail row is rejected (0A000), even for the privileged role', upd.status === 201);

  const del = await runSql(token, mutationProbeSql('DELETE'));
  check('LIVE: DELETE against a snapshot_operational_detail row is rejected the same way', del.status === 201);

  const trunc = await runSql(token, truncateProbeSql());
  check('LIVE: TRUNCATE of the whole table is rejected the same way', trunc.status === 201);

  const regressionTriggers = await runSql(token, `select count(*) as n from pg_trigger where tgrelid='public.snapshot_comissoes'::regclass and not tgisinternal and tgenabled='O';`);
  const triggerCount = regressionTriggers.status === 201 ? Number(regressionTriggers.body[0].n) : null;
  check('REGRESSION: snapshot_comissoes still has its 3 RH-5D triggers, enabled, untouched by this migration', triggerCount === 3);

  const after = await runSql(token, `select
    (select count(*) from public.snapshot_operational_detail) as sod_n,
    (select count(*) filter (where store = 'RH5D1_SYNTHETIC_TEST_ROW') from public.snapshot_operational_detail) as sod_leaked,
    (select count(*) from public.snapshot_comissoes) as sc_n;`);
  const afterSod = after.status === 201 ? Number(after.body[0].sod_n) : null;
  const afterLeaked = after.status === 201 ? Number(after.body[0].sod_leaked) : null;
  const afterSc = after.status === 201 ? Number(after.body[0].sc_n) : null;
  check('LIVE: snapshot_operational_detail row count unchanged after every probe (zero persistent delta)', beforeSod !== null && afterSod === beforeSod);
  check('LIVE: no synthetic test row leaked into the real table', afterLeaked === 0);
  check('LIVE: snapshot_comissoes row count unchanged (this wave never touches that table)', beforeSc !== null && afterSc === beforeSc);
}

async function main() {
  runStaticChecks();
  try {
    await runLiveChecks();
  } catch (e) {
    check('LIVE checks completed without a fatal error (' + (e && e.message) + ')', false);
  }

  const passed = results.filter((r) => r[1]).length;
  results.forEach((r) => console.log(`[${r[1] ? 'PASS' : 'FAIL'}] ${r[0]}`));
  console.log(`\n=== RH-5D.1 snapshot_operational_detail Immutability Parity: ${passed}/${results.length} ===`);
  console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

main();

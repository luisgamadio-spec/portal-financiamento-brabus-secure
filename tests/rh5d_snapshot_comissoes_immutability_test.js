#!/usr/bin/env node
/*
 * RH-5D -- SNAPSHOT_COMISSOES_NOT_DB_IMMUTABLE hardening.
 *
 * Two layers, same established pattern as p2_rh_operational_scope_test.js
 * and rh5c3_bucketing_sql_fix_test.js:
 *
 *  1. STATIC: the migration file's own SQL text is inspected -- a guard
 *     trigger function that unconditionally raises must exist, wired to
 *     BEFORE UPDATE, BEFORE DELETE and BEFORE TRUNCATE on
 *     snapshot_comissoes; no RLS policy or grant statement is touched
 *     (this migration is trigger-only, by design -- RLS/grants were
 *     already proven, live, to be a dead end against the table owner/
 *     service_role); snapshot_operational_detail is not touched.
 *  2. LIVE (against the REAL deployed database, yacqlelpzchcotgngwbh,
 *     never zhzubcismiwdypavwdxf): every mutating statement is wrapped
 *     in BEGIN...ROLLBACK so nothing persists, regardless of pass/fail.
 *     Proves, against the real historical snapshot rows: (a) UPDATE is
 *     rejected with SQLSTATE 0A000, even for the privileged role that
 *     applied the migration -- the exact gap RLS/grants could not close;
 *     (b) DELETE is rejected the same way; (c) TRUNCATE is rejected the
 *     same way; (d) the canonical closing path
 *     (master_close_commission_period) still succeeds end-to-end against
 *     the real current open period, using only synthetic row data (no
 *     employee name/PII, no real financial value) -- proving INSERT was
 *     never touched by this hardening.
 *
 * Zero PII, zero real financial values, zero persistent write. Never
 * executes a real Fechar Competencia (the RPC call is itself inside the
 * rolled-back transaction). Run: node tests/rh5d_snapshot_comissoes_immutability_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260909120000_rh5d_snapshot_comissoes_immutability.sql');

// Real, live, current-open-period id and a real active-MASTER auth_user_id
// (UUID only -- no name/CPF/profile), both confirmed live this wave.
// Reused ONLY inside BEGIN...ROLLBACK blocks below.
const CURRENT_OPEN_PERIOD_ID = '40fd0359-9aa4-454e-8daf-2165adbffccf';
const MASTER_AUTH_UID = '4aad8069-e01f-423e-82ee-648fdec8e36e';

const results = [];
function check(label, cond) { results.push([label, !!cond]); }

// ---------- LAYER 1: STATIC ----------
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

  check('1 (guard function unconditionally raises an exception)', /raise\s+exception\s+'SNAPSHOT_COMISSOES_IMMUTABLE/i.test(codeOnly));
  check('2 (guard uses a distinct, matchable SQLSTATE)', /using\s+errcode\s*=\s*'0A000'/i.test(codeOnly));
  check('3 (BEFORE UPDATE trigger wired to snapshot_comissoes)', /before\s+update\s+on\s+public\.snapshot_comissoes/i.test(codeOnly));
  check('4 (BEFORE DELETE trigger wired to snapshot_comissoes)', /before\s+delete\s+on\s+public\.snapshot_comissoes/i.test(codeOnly));
  check('5 (BEFORE TRUNCATE trigger wired to snapshot_comissoes)', /before\s+truncate\s+on\s+public\.snapshot_comissoes/i.test(codeOnly));
  check('6 (idempotent -- drops any prior trigger of the same name first)', (codeOnly.match(/drop\s+trigger\s+if\s+exists/gi) || []).length >= 3);
  check('7 (INSERT is never mentioned as a blocked operation)', !/before\s+insert\s+on\s+public\.snapshot_comissoes/i.test(codeOnly));
  check('8 (no RLS policy is created/altered/dropped in this migration -- trigger-only hardening)', !/create\s+policy|alter\s+policy|drop\s+policy/i.test(codeOnly));
  check('9 (no GRANT/REVOKE statement in this migration)', !/\bgrant\b|\brevoke\b/i.test(codeOnly));
  check('10 (snapshot_operational_detail is not touched by this migration -- scope discipline)', !/snapshot_operational_detail/i.test(codeOnly));
}

// ---------- LAYER 2: LIVE (every mutation wrapped in BEGIN...ROLLBACK) ----------
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

// Any real snapshot row id works here -- we only ever attempt to mutate
// it inside a transaction that is unconditionally rolled back below.
const PROBE_ROW_QUERY = `select id from public.snapshot_comissoes limit 1;`;

function mutationProbeSql(op) {
  const stmt = {
    UPDATE: `UPDATE public.snapshot_comissoes SET comissao = comissao + 1 WHERE id = (select id from public.snapshot_comissoes limit 1);`,
    DELETE: `DELETE FROM public.snapshot_comissoes WHERE id = (select id from public.snapshot_comissoes limit 1);`,
    TRUNCATE: `TRUNCATE public.snapshot_comissoes;`,
  }[op];
  return `
BEGIN;
DO $$
BEGIN
  ${stmt}
  RAISE EXCEPTION 'TEST_FAIL_NOT_BLOCKED';
EXCEPTION WHEN SQLSTATE '0A000' THEN
  RAISE NOTICE 'BLOCKED_AS_EXPECTED';
END $$;
SELECT 'ok' as probe_result;
ROLLBACK;
`;
}

const CANONICAL_CLOSING_PROOF_SQL = `
BEGIN;
SET LOCAL request.jwt.claims = '{"sub": "${MASTER_AUTH_UID}", "role":"authenticated"}';
SET LOCAL role = authenticated;
SELECT public.master_close_commission_period(
  '${CURRENT_OPEN_PERIOD_ID}'::uuid,
  '{"qtd_vendida":1,"qtd_financiada":1,"producao_total":1000,"retorno_total":1000,"spf_total":0,"comissao_total":10}'::jsonb,
  '[{"nome":"RH5D SYNTHETIC TEST ROW","perfil":"VENDEDOR","loja":"TESTE","status":"NOVOS","vendidas":1,"financiadas":1,"share":1,"producao":1000,"retorno":1000,"spf_extra":0,"spf_liquido":0,"rentabilidade_total":1000,"faixa":1,"comissao_principal":10,"comissao_spf":0,"comissao_total":10}]'::jsonb
) AS closing_result;
RESET ROLE;
SELECT count(*) AS synthetic_row_visible_within_txn FROM public.snapshot_comissoes WHERE nome = 'RH5D SYNTHETIC TEST ROW';
ROLLBACK;
`;

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    check('LIVE: SUPABASE_ACCESS_TOKEN available (supabase/.env.local)', false);
    return;
  }
  assert.notStrictEqual(PROJECT_REF, FORBIDDEN_PROJECT_REF, 'must never target the dormant staging project');

  const beforeCount = await runSql(token, 'select count(*) as n from public.snapshot_comissoes;');
  const before = beforeCount.status === 201 ? Number(beforeCount.body[0].n) : null;
  check('LIVE: baseline row count read successfully before any probe', before !== null);

  const upd = await runSql(token, mutationProbeSql('UPDATE'));
  check('LIVE: UPDATE against a real snapshot row is rejected (SNAPSHOT_COMISSOES_IMMUTABLE / 0A000), even for the privileged role', upd.status === 201);

  const del = await runSql(token, mutationProbeSql('DELETE'));
  check('LIVE: DELETE against a real snapshot row is rejected the same way', del.status === 201);

  const trunc = await runSql(token, mutationProbeSql('TRUNCATE'));
  check('LIVE: TRUNCATE of the whole table is rejected the same way', trunc.status === 201);

  const closing = await runSql(token, CANONICAL_CLOSING_PROOF_SQL);
  check('LIVE: canonical closing path (master_close_commission_period) still succeeds end-to-end after the trigger (rolled back, zero persistent write)', closing.status === 201);
  const closingRows = Array.isArray(closing.body) ? closing.body : [];
  const visibleRow = closingRows.find((r) => r && Object.prototype.hasOwnProperty.call(r, 'synthetic_row_visible_within_txn'));
  check('LIVE: the canonical INSERT actually wrote 1 row inside the (rolled-back) transaction', !!visibleRow && Number(visibleRow.synthetic_row_visible_within_txn) === 1);

  const afterCount = await runSql(token, `select count(*) as n, count(*) filter (where nome='RH5D SYNTHETIC TEST ROW') as leaked from public.snapshot_comissoes;`);
  const after = afterCount.status === 201 ? Number(afterCount.body[0].n) : null;
  const leaked = afterCount.status === 201 ? Number(afterCount.body[0].leaked) : null;
  check('LIVE: total row count is unchanged after every probe (zero persistent business-data delta)', before !== null && after === before);
  check('LIVE: no synthetic test row leaked into the real table', leaked === 0);
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
  console.log(`\n=== RH-5D snapshot_comissoes Immutability Hardening: ${passed}/${results.length} ===`);
  console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

main();

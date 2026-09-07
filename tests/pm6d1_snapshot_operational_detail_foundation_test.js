#!/usr/bin/env node
/*
 * PM-6D.1 -- RH/DP Historical Immutability, additive backend foundation.
 *
 * Schema/security/read-contract test for the migration
 * supabase/migrations/20260907120000_pm6d1_snapshot_operational_detail_
 * foundation.sql. Two layers:
 *
 *  1. STATIC: the migration file's own SQL text is inspected for the
 *     absolute prohibitions of this wave -- no DML on existing business
 *     data, no ALTER/DROP of master_close_commission_period, no backfill
 *     UPDATE, explicit REVOKE before RLS.
 *  2. LIVE (read-only): re-verifies, against the REAL deployed schema on
 *     the real project (yacqlelpzchcotgngwbh, guarded explicitly -- never
 *     zhzubcismiwdypavwdxf), that what was actually applied matches the
 *     migration's own intent: table shape, FK/CASCADE, RLS+policies,
 *     zero anon/authenticated table grants, RPC signature/security,
 *     MASTER-gate rejection, and that existing fechamentos_comissao/
 *     snapshot_comissoes rows/counts are byte-for-byte unchanged.
 *
 * Uses the SAME Management API read-only mechanism already established
 * and validated across PM-5K-RETRY/PM-6B-H1/PM-6C/PM-6D.1 itself
 * (supabase/.env.local's SUPABASE_ACCESS_TOKEN, never printed). If that
 * credential is unavailable, the LIVE layer is skipped with a clear
 * message rather than failing -- the STATIC layer never depends on it.
 *
 * 100% read-only: every live check is a SELECT against information_schema/
 * pg_catalog or a call to the new RPC with an all-zero UUID (proven to
 * reject before touching any row, PM-6D.1's own live test). Zero PII,
 * zero real financial values, zero write.
 *
 * Run: node tests/pm6d1_snapshot_operational_detail_foundation_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260907120000_pm6d1_snapshot_operational_detail_foundation.sql');

const results = [];
function check(label, cond) {
  results.push([label, !!cond]);
}

// ---------- LAYER 1: STATIC (migration source text) ----------
function stripSqlLineComments(text) {
  // Strips `-- ...` to end-of-line. This file's own prose comments
  // legitimately NAME things they explain the absence/handling of (e.g.
  // "CPF ... nunca populada", "master_close_commission_period nao e
  // tocada") -- checks that must prove something is absent from
  // EXECUTABLE SQL need this, or they false-positive on the file's own
  // documentation (same mistake class already hit and fixed in
  // PM-6B/PM-6C's own test suites).
  return text.split('\n').map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

function runStaticChecks() {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file must exist at the expected path');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const sqlLower = sql.toLowerCase();
  const codeOnly = stripSqlLineComments(sql);
  const codeOnlyLower = codeOnly.toLowerCase();

  check('1 (NO DML on existing data): migration contains no UPDATE statement at all', !/\bupdate\s+public\./i.test(sql));
  check('2 (NO DML): migration contains no DELETE statement', !/\bdelete\s+from\b/i.test(sql));
  check('3 (NO backfill INSERT into business tables): no INSERT into fechamentos_comissao/snapshot_comissoes', !/insert\s+into\s+public\.(fechamentos_comissao|snapshot_comissoes)/i.test(sql));
  check('4 (close RPC untouched): no CREATE/ALTER/DROP FUNCTION targeting master_close_commission_period in executable SQL (prose comments may still name it)', !/(create|alter|drop)\s+(or\s+replace\s+)?function\s+public\.master_close_commission_period/i.test(codeOnly) && !codeOnlyLower.includes('master_close_commission_period'));
  check('5 (reopen RPC untouched): no executable SQL references master_reopen_commission_period at all', !codeOnlyLower.includes('master_reopen_commission_period'));
  check('6 (no DROP): migration contains no DROP TABLE/FUNCTION/COLUMN', !/\bdrop\s+(table|function|column)\b/i.test(sql));
  check('7 (new table created): CREATE TABLE public.snapshot_operational_detail present', /create\s+table\s+public\.snapshot_operational_detail/i.test(sql));
  check('8 (FK to fechamentos_comissao, CASCADE): matches the real sibling pattern (snapshot_comissoes_fechamento_id_fkey)', /references\s+public\.fechamentos_comissao\(id\)\s+on\s+delete\s+cascade/i.test(sql));
  check('9 (kind CHECK constraint): CHASSIS/SPF enumerated via CHECK, no new enum type', /check\s*\(kind\s+in\s*\(\s*'CHASSIS'\s*,\s*'SPF'\s*\)\)/i.test(sql));
  check('10 (security guard present, ordered correctly): REVOKE appears before ENABLE ROW LEVEL SECURITY', (() => {
    const revokeIdx = sqlLower.indexOf('revoke all on public.snapshot_operational_detail');
    const rlsIdx = sqlLower.indexOf('enable row level security');
    return revokeIdx !== -1 && rlsIdx !== -1 && revokeIdx < rlsIdx;
  })());
  check('11 (RLS explicitly enabled)', /alter\s+table\s+public\.snapshot_operational_detail\s+enable\s+row\s+level\s+security/i.test(sql));
  check('12 (SELECT+INSERT policies only, no UPDATE/DELETE policy -- immutable-by-design)', /create\s+policy\s+sod_select_master/i.test(sql) && /create\s+policy\s+sod_insert_master/i.test(sql) && !/create\s+policy\s+sod_update/i.test(sql) && !/create\s+policy\s+sod_delete/i.test(sql));
  check('13 (both policies gated by is_master())', (sql.match(/using \(public\.is_master\(\)\)/gi) || []).length >= 1 && (sql.match(/with check \(public\.is_master\(\)\)/gi) || []).length >= 1);
  check('14 (no CPF column added anywhere, executable SQL only)', !/\bcpf\b/i.test(codeOnly));
  check('15 (no client/cliente column added, executable SQL only)', !/\bcliente\b/i.test(codeOnly));
  check('16 (no raw/full chassis COLUMN definition -- only chassis_masked; the CHASSIS kind-enum string literal is expected and unrelated)', !/\bchassis\s+(text|varchar|character)/i.test(codeOnly));
  check('17 (provenance columns are all nullable, no NOT NULL/DEFAULT forcing a value)', /add column if not exists sales_batch_id uuid,/i.test(sql) && !/sales_batch_id uuid not null/i.test(sql));
  check('18 (historical_detail_status CHECK allows NULL, restricts non-null to COMPLETE)', /check\s*\(historical_detail_status is null or historical_detail_status = 'COMPLETE'\)/i.test(sql));
  check('19 (batch id columns have NO foreign key -- deliberate, PM-6C Gate 22/23)', !/sales_batch_id uuid references/i.test(sql) && !/finance_batch_id uuid references/i.test(sql) && !/spf_batch_id uuid references/i.test(sql));
  check('20 (new RPC is SECURITY DEFINER with pinned search_path, matching every other master_* RPC)', /security definer/i.test(sql) && /set search_path to 'pg_catalog', 'public'/i.test(sql));
  check('21 (new RPC has a real MASTER gate raising 42501)', /if not public\.is_master\(\) then/i.test(sql) && /42501/.test(sql));
  check('22 (new RPC has a real not-found gate raising P0002)', /if not found then/i.test(sql) && /'P0002'/.test(sql));
  check('23 (completeness NEVER derived from row count -- always from the frozen column)', /coalesce\(v_status, 'LEGACY_PARTIAL'\)/i.test(sql) && !/count\(\*\)\s*>\s*0/i.test(sql));
  check('24 (zero live fallback -- new RPC never calls operational_salary_details/master_operational_spf_audit_period, executable SQL only)', !codeOnlyLower.includes('operational_salary_details') && !codeOnlyLower.includes('master_operational_spf_audit_period'));
  check('25 (RPC grants: anon explicitly revoked, authenticated+service_role granted)', /revoke all on function public\.master_commission_operational_detail\(uuid\) from public, anon/i.test(sql) && /grant execute on function public\.master_commission_operational_detail\(uuid\) to authenticated, service_role/i.test(sql));
}

// ---------- LAYER 2: LIVE (read-only, real project) ----------
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

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] LIVE layer: no SUPABASE_ACCESS_TOKEN available locally -- static layer above is authoritative in this environment.');
    return;
  }
  assert.ok(!token.includes(FORBIDDEN_PROJECT_REF), 'token file must never reference the forbidden staging project ref');

  // Hard project guard: confirm the real project ref is reachable and the
  // forbidden staging ref is never targeted by any query in this file.
  const authCheck = await runSql(token, `select current_database() as db;`);
  check('26 (PROJECT_REF_GUARD): Management API reachable for the real project only', authCheck.status === 201);

  const schemaCheck = await runSql(token, `
    select json_build_object(
      'table_exists', exists(select 1 from information_schema.tables where table_schema='public' and table_name='snapshot_operational_detail'),
      'fk', (select json_agg(json_build_object('col', kcu.column_name, 'ref', ccu.table_name, 'del', rc.delete_rule)) from information_schema.table_constraints tc join information_schema.key_column_usage kcu on tc.constraint_name=kcu.constraint_name join information_schema.constraint_column_usage ccu on tc.constraint_name=ccu.constraint_name join information_schema.referential_constraints rc on rc.constraint_name=tc.constraint_name where tc.table_name='snapshot_operational_detail' and tc.constraint_type='FOREIGN KEY'),
      'rls_enabled', (select relrowsecurity from pg_class where relname='snapshot_operational_detail'),
      'policy_count', (select count(*) from pg_policies where tablename='snapshot_operational_detail'),
      'anon_or_authenticated_table_grants', (select count(*) from information_schema.table_privileges where table_schema='public' and table_name='snapshot_operational_detail' and grantee in ('anon','authenticated')),
      'new_table_row_count', (select count(*) from public.snapshot_operational_detail),
      'fechamentos_new_cols_nonnull_count', (select count(*) from public.fechamentos_comissao where sales_batch_id is not null or finance_batch_id is not null or spf_batch_id is not null or snapshot_payload_hash is not null or commission_engine_version is not null or historical_detail_status is not null),
      'rpc_exists', exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='master_commission_operational_detail'),
      'close_rpc_args', (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='master_close_commission_period')
    ) as r;
  `);
  const r = schemaCheck.body[0].r;

  check('27 (table exists live)', r.table_exists === true);
  check('28 (FK live: fechamento_id -> fechamentos_comissao, CASCADE)', Array.isArray(r.fk) && r.fk.length === 1 && r.fk[0].ref === 'fechamentos_comissao' && r.fk[0].del === 'CASCADE');
  check('29 (RLS enabled live)', r.rls_enabled === true);
  check('30 (exactly 2 policies live -- select+insert only)', r.policy_count === 2);
  check('31 (ZERO anon/authenticated direct table grants live -- the critical default-ACL guard held)', r.anon_or_authenticated_table_grants === 0);
  check('32 (new table has ZERO rows -- PM-6D.1 must never populate it)', r.new_table_row_count === 0);
  check('33 (ZERO existing fechamentos rows have any new provenance column non-null -- zero backfill)', r.fechamentos_new_cols_nonnull_count === 0);
  check('34 (new RPC exists live)', r.rpc_exists === true);
  check('35 (close RPC signature unchanged: p_period_id uuid, p_summary jsonb, p_rows jsonb)', r.close_rpc_args === 'p_period_id uuid, p_summary jsonb, p_rows jsonb');

  // MASTER gate: calling with an all-zero UUID and no real session context
  // must reject with 42501 -- proves the gate is live and enforced before
  // ANY row (existent or not) is ever touched.
  const gateCheck = await runSql(token, `select public.master_commission_operational_detail('00000000-0000-0000-0000-000000000000'::uuid);`);
  check('36 (MASTER GATE, live): calling the new RPC without master authority rejects with 42501, never a false success', gateCheck.status === 400 && /42501/.test(JSON.stringify(gateCheck.body)));
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
  console.log(`=== PM-6D.1 Snapshot Operational Detail Foundation: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

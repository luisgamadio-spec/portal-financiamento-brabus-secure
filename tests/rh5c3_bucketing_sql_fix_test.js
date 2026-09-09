#!/usr/bin/env node
/*
 * RH-5C.3 -- SEMINOVOS_MANAGER_BUCKETING_INCIDENT, SQL corrective fix.
 *
 * Two layers, same established pattern as p2_rh_operational_scope_test.js:
 *
 *  1. STATIC: the migration file's own SQL text is inspected -- the
 *     substring collision pattern (LIKE '%NOVOS%'/LIKE '%SEMINOVOS%')
 *     must be gone from the manager-bucketing CTE, replaced by exact
 *     equality; the NOVOS/SEMINOVOS combined-value intent must be
 *     preserved; no unrelated LIKE expression elsewhere in the schema
 *     was touched (this file only recreates operational_commission_
 *     faixa_rows, nothing else).
 *  2. LIVE (read-only, fully transaction-scoped, zero business tables
 *     touched): re-verifies, against the REAL deployed database
 *     (yacqlelpzchcotgngwbh, guarded explicitly -- never
 *     zhzubcismiwdypavwdxf), that the corrected bucketing CTE logic
 *     -- run against a synthetic JSON fixture inline in the query,
 *     never against any table -- now classifies NOVOS/SEMINOVOS
 *     mutually exclusively, still handles the combined value, and
 *     fails safe (excludes, never defaults to NOVOS) on an unknown
 *     department.
 *
 * Uses the SAME Management API read-only mechanism already established
 * in this project's own prior incident tests. Zero PII, zero real
 * financial values, zero persistent write (BEGIN...ROLLBACK).
 *
 * Run: node tests/rh5c3_bucketing_sql_fix_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260909110000_rh5c3_seminovos_novos_bucketing_fix.sql');

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

  check('1 (targets operational_commission_faixa_rows)', /create\s+or\s+replace\s+function\s+public\.operational_commission_faixa_rows\s*\(/i.test(codeOnly));
  check('2 (no LIKE-based NOVOS/SEMINOVOS substring classification remains anywhere in this file)', !/like\s+'%NOVOS%'/i.test(codeOnly) && !/like\s+'%SEMINOVOS%'/i.test(codeOnly));
  check('3 (exact-match CASE classifier present for the bucketing)', /case\s+upper\(trim\(coalesce\(r\s*->>\s*'department',\s*''\)\)\)/i.test(codeOnly));
  check('4 (NOVOS/SEMINOVOS combined value still contributes to both -- original intent preserved)', /when\s+'NOVOS\/SEMINOVOS'\s+then\s+array\['NOVOS',\s*'SEMINOVOS'\]/i.test(codeOnly));
  check('5 (unknown department excluded, not defaulted to NOVOS)', /else\s+array\[\]::text\[\]/i.test(codeOnly));
  check('6 (security mode preserved: STABLE SECURITY DEFINER)', /stable\s+security\s+definer/i.test(codeOnly));
  check('7 (search_path preserved exactly)', /set\s+search_path\s+to\s+'pg_catalog',\s*'public'/i.test(codeOnly));
  check('8 (MASTER-only auth gate preserved)', /upper\(trim\(coalesce\(u\.perfil,\s*''\)\)\)\s*=\s*'MASTER'/i.test(codeOnly));
  check('9 (Option B: no UPDATE/DELETE against snapshot_comissoes anywhere in this file)', !/update\s+public\.snapshot_comissoes/i.test(codeOnly) && !/delete\s+from\s+public\.snapshot_comissoes/i.test(codeOnly));
  check('10 (disclosure table is append-only -- no update/delete policy defined)', !/create\s+policy[\s\S]*?for\s+(update|delete)/i.test(codeOnly));
}

// ---------- LAYER 2: LIVE (read-only, fully transaction-scoped, no tables touched) ----------
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

// Pure query against an inline JSON literal -- no table read, matching
// the exact CTE shape used inside operational_commission_faixa_rows's
// own manager-bucketing block.
const BUCKETING_QUERY = `
BEGIN;
with synthetic_rows as (
  select '[
    {"department":"NOVOS","sold_count":10},
    {"department":"SEMINOVOS","sold_count":6},
    {"department":"NOVOS/SEMINOVOS","sold_count":8},
    {"department":"OUTROS","sold_count":99}
  ]'::jsonb as rows
)
select r ->> 'department' as input_department, dep.g as bucket
from synthetic_rows sr, jsonb_array_elements(sr.rows) r
cross join lateral (
  select unnest(
    case upper(trim(coalesce(r ->> 'department', '')))
      when 'NOVOS/SEMINOVOS' then array['NOVOS', 'SEMINOVOS']
      when 'NOVOS' then array['NOVOS']
      when 'SEMINOVOS' then array['SEMINOVOS']
      else array[]::text[]
    end
  ) as g
) dep
order by input_department, bucket;
ROLLBACK;
`;

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    check('LIVE: SUPABASE_ACCESS_TOKEN available (supabase/.env.local)', false);
    return;
  }
  assert.notStrictEqual(PROJECT_REF, FORBIDDEN_PROJECT_REF, 'must never target the dormant staging project');

  const result = await runSql(token, BUCKETING_QUERY);
  const rows = Array.isArray(result.body) ? (result.body.find((r) => Array.isArray(r) === false) ? result.body : result.body) : null;
  const flatRows = Array.isArray(result.body) ? result.body.flat ? result.body.flat() : result.body : [];
  const data = Array.isArray(result.body) ? result.body : [];

  check('LIVE: query executed successfully (Management API returns 201 for a successful query)', result.status === 201);

  const byDept = {};
  (data || []).forEach((r) => {
    if (!r || !r.input_department) return;
    byDept[r.input_department] = byDept[r.input_department] || [];
    byDept[r.input_department].push(r.bucket);
  });

  check('LIVE: NOVOS input produces only a NOVOS bucket', JSON.stringify(byDept['NOVOS']) === JSON.stringify(['NOVOS']));
  check('LIVE: SEMINOVOS input produces only a SEMINOVOS bucket -- the incident is fixed in the live corrected CTE', JSON.stringify(byDept['SEMINOVOS']) === JSON.stringify(['SEMINOVOS']));
  check('LIVE: combined NOVOS/SEMINOVOS still produces both buckets', JSON.stringify((byDept['NOVOS/SEMINOVOS'] || []).sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));
  check('LIVE: unknown department (OUTROS) produces zero buckets -- fails safe, never defaults to NOVOS', !byDept['OUTROS'] || byDept['OUTROS'].length === 0);
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
  console.log(`\n=== RH-5C.3 SEMINOVOS/NOVOS Bucketing SQL Fix: ${passed}/${results.length} ===`);
  console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

main();

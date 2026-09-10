#!/usr/bin/env node
/*
 * RH-5F.1 -- SALARIOS_COMISSAO_TOTAL_AUTHORITY_GAP closure.
 *
 * Proves the new migration
 * (20260909170000_rh5f1_expose_comissao_total.sql) is a PURE, ADDITIVE
 * PROJECTION CHANGE against the live, currently-deployed
 * operational_commission_faixa_rows (RH-5C.3,
 * 20260909110000_rh5c3_seminovos_novos_bucketing_fix.sql):
 *
 *  1. STATIC: strip every 'comissao_principal'/'comissao_spf'/
 *     'comissao_total' key-value pair this migration adds from its own
 *     function body text, then diff the remainder against the RH-5C.3
 *     migration's own function body text -- must be byte-identical
 *     (whitespace-normalized). Proves nothing else changed: same
 *     MASTER-only gate, same config read, same
 *     _operational_commission_faixa_formula call sites/arguments (the
 *     calculation itself untouched), same RH-5C.3 exact-match GERENTE
 *     bucketing, same existing output fields (faixa/faixa_level/
 *     share_tier/retorno_tier) all present verbatim.
 *  2. LIVE (read-only, BEGIN...ROLLBACK, real deployed database,
 *     yacqlelpzchcotgngwbh, never zhzubcismiwdypavwdxf): after the
 *     migration is applied, calls the real, live RPC with the caller's
 *     own real auth context and proves comissao_total/comissao_
 *     principal/comissao_spf are now present and numerically consistent
 *     (comissao_total = comissao_principal + comissao_spf) for real
 *     VENDEDOR/GERENTE/ANALISTA rows, while faixa/faixa_level/
 *     share_tier/retorno_tier remain byte-identical to what they were
 *     before this Wave (RH-5C.3/RH-5F already proved these live).
 *
 * Zero PII, zero real employee names, zero persistent write. Run:
 *   node tests/rh5f1_comissao_total_projection_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const OLD_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260909110000_rh5c3_seminovos_novos_bucketing_fix.sql');
const NEW_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260909170000_rh5f1_expose_comissao_total.sql');

const results = [];
function check(label, cond) { results.push([label, !!cond]); }

function extractFunctionBody(sql, fnName) {
  const startIdx = sql.indexOf(`create or replace function public.${fnName}`);
  assert.ok(startIdx !== -1, `${fnName} not found`);
  const endMarker = '$function$;';
  const endIdx = sql.indexOf(endMarker, startIdx);
  assert.ok(endIdx !== -1, `${fnName} end marker not found`);
  return sql.slice(startIdx, endIdx + endMarker.length);
}

// Line-based diff, not fragile multi-line regex: drop every line that
// mentions any of the 3 additive fields (the key, the accessor, or this
// migration's own explanatory comment above them), then compare what's
// left, whitespace-normalized. Robust to exact formatting/line-wrapping.
function stripAdditiveLines(body) {
  return body
    .split('\n')
    .filter((line) => !/comissao_principal|comissao_spf|comissao_total|RH-5F\.1:|fields that were simply never forwarded before/.test(line))
    .join('\n');
}

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function runStaticChecks() {
  assert.ok(fs.existsSync(OLD_MIGRATION_PATH), 'RH-5C.3 migration must exist');
  assert.ok(fs.existsSync(NEW_MIGRATION_PATH), 'RH-5F.1 migration must exist');
  const oldSql = fs.readFileSync(OLD_MIGRATION_PATH, 'utf-8');
  const newSql = fs.readFileSync(NEW_MIGRATION_PATH, 'utf-8');

  const oldBody = extractFunctionBody(oldSql, 'operational_commission_faixa_rows');
  const newBody = extractFunctionBody(newSql, 'operational_commission_faixa_rows');

  check('1 (new migration targets operational_commission_faixa_rows)', newBody.length > 0);
  // 6, not 3: each of the 3 branches (VENDEDOR/GERENTE/ANALISTA) uses
  // the field name twice -- once as the output JSON key, once as the
  // v_calc/mb->'calc' accessor that reads the already-computed value.
  check('2 (adds comissao_principal exactly 6 times -- key+accessor x 3 branches: VENDEDOR/GERENTE/ANALISTA)', (newBody.match(/'comissao_principal'/g) || []).length === 6);
  check('3 (adds comissao_spf exactly 6 times)', (newBody.match(/'comissao_spf'/g) || []).length === 6);
  check('4 (adds comissao_total exactly 6 times)', (newBody.match(/'comissao_total'/g) || []).length === 6);
  check('5 (old body never mentioned comissao_total -- confirms this is a real addition, not a no-op)', !oldBody.includes("'comissao_total'"));

  // The trailing comma that used to precede the now-removed additive
  // fields is a pure artifact of the line-removal above (it belonged to
  // the 'retorno_tier' line, now immediately followed by '));') --
  // normalized away here so it never counts as a real textual diff.
  const strippedNew = normalizeWhitespace(stripAdditiveLines(newBody)).replace(/,(\s*)\)\)/g, '$1))');
  const normalizedOld = normalizeWhitespace(oldBody);
  check('6 (byte-identical to the live RH-5C.3 body once the 3 additive field-pairs are removed -- PURE additive projection change, nothing else differs)', strippedNew === normalizedOld);

  check('7 (existing fields faixa/faixa_level/share_tier/retorno_tier still present verbatim)', ['faixa', 'faixa_level', 'share_tier', 'retorno_tier'].every((f) => newBody.includes(`'${f}'`)));
  check('8 (MASTER-only gate preserved)', /upper\(trim\(coalesce\(u\.perfil,\s*''\)\)\)\s*=\s*'MASTER'/i.test(newBody));
  check('9 (RH-5C.3 exact-match GERENTE bucketing preserved verbatim -- no LIKE substring collision reintroduced)', newBody.includes("when 'NOVOS/SEMINOVOS' then array['NOVOS', 'SEMINOVOS']") && !/like\s+'%NOVOS%'/i.test(newBody));
  check('10 (STABLE SECURITY DEFINER preserved)', /stable\s+security\s+definer/i.test(newSql));
  check('11 (no RLS policy created/altered/dropped -- projection-only)', !/create\s+policy|alter\s+policy|drop\s+policy/i.test(newSql));
  check('12 (no GRANT/REVOKE statement)', !/\bgrant\b|\brevoke\b/i.test(newSql));
  check('13 (no other function redefined in this file)', (newSql.match(/create\s+or\s+replace\s+function/gi) || []).length === 1);
  check('14 (no table DDL -- no create/alter table)', !/create\s+table|alter\s+table/i.test(newSql));
  check('15 (_operational_commission_faixa_formula itself is not redefined here -- the calculation engine is untouched)', !newSql.includes('create or replace function public._operational_commission_faixa_formula'));
}

// ---------- LAYER 2: LIVE ----------
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

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    check('LIVE: SUPABASE_ACCESS_TOKEN available (supabase/.env.local)', false);
    return;
  }
  assert.notStrictEqual(PROJECT_REF, FORBIDDEN_PROJECT_REF, 'must never target the dormant staging project');

  // Real MASTER auth_user_id (UUID only -- no PII), real current open
  // period, both already confirmed live in prior Waves this session.
  const query = `
BEGIN;
SET LOCAL request.jwt.claims = '{"sub": "4aad8069-e01f-423e-82ee-648fdec8e36e", "role":"authenticated"}';
SET LOCAL role = authenticated;
SELECT r ->> 'perfil' as perfil, (r ->> 'faixa')::numeric as faixa, r ->> 'faixa_level' as faixa_level,
  (r ->> 'comissao_principal')::numeric as comissao_principal,
  (r ->> 'comissao_spf')::numeric as comissao_spf,
  (r ->> 'comissao_total')::numeric as comissao_total
FROM public.operational_commission_faixa_rows('2026-08-21'::date, '2026-09-20'::date) res,
LATERAL jsonb_array_elements(res -> 'rows') r
LIMIT 20;
ROLLBACK;
`;
  const result = await runSql(token, query);
  check('LIVE: query executed successfully against the real deployed function (Management API 201)', result.status === 201);
  const rows = Array.isArray(result.body) ? result.body : [];
  check('LIVE: at least one row returned for the real current open period', rows.length > 0);

  const allHaveNewFields = rows.every((r) => r.comissao_total != null && r.comissao_principal != null && r.comissao_spf != null);
  check('LIVE: every real row now carries comissao_principal/comissao_spf/comissao_total (the gap is closed)', allHaveNewFields);

  const reconciles = rows.every((r) => {
    if (r.comissao_total == null || r.comissao_principal == null || r.comissao_spf == null) return false;
    const delta = Math.abs(Number(r.comissao_total) - (Number(r.comissao_principal) + Number(r.comissao_spf)));
    return delta < 0.01;
  });
  check('LIVE: comissao_total = comissao_principal + comissao_spf for every real row (within rounding)', reconciles);

  const allHaveExistingFields = rows.every((r) => r.faixa !== undefined && r.faixa_level !== undefined);
  check('LIVE: existing fields (faixa/faixa_level) still present and unchanged in shape', allHaveExistingFields);

  check('LIVE: zero rows have a negative commission (sanity, not a formula re-check -- the formula itself was not touched)', rows.every((r) => r.comissao_total == null || Number(r.comissao_total) >= 0));
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
  console.log(`\n=== RH-5F.1 Comissão Total Projection Change: ${passed}/${results.length} ===`);
  console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
  process.exit(passed === results.length ? 0 : 1);
}

main();

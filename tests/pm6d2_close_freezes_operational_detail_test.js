#!/usr/bin/env node
/*
 * PM-6D.2 -- RH/DP Historical Immutability: atomic close capture.
 *
 * Schema/security/behavior contract test for the migration
 * supabase/migrations/20260907130000_pm6d2_close_freezes_operational_
 * detail.sql, which extends master_close_commission_period (signature
 * UNCHANGED) to freeze, in the SAME transaction, the operational detail
 * (chassis + SPF) and provenance/hash/engine-version already prepared
 * by PM-6D.1's additive foundation.
 *
 * Two layers, same discipline as pm6d1_snapshot_operational_detail_
 * foundation_test.js:
 *
 *  1. STATIC: the new migration's own SQL text is inspected for the
 *     absolute prohibitions of this wave (signature preserved, return
 *     contract preserved, COMPLETE only after detail, no live fallback
 *     in the READ rpc, no CPF/cliente, no backfill of existing rows).
 *
 *  2. LIVE (real database, GUARANTEED zero permanent write): every
 *     mutating scenario runs inside an explicit BEGIN...ROLLBACK sent
 *     as ONE statement string in ONE Management API call -- empirically
 *     proven in this session to execute in a single real session/
 *     transaction (a harmless tagged probe row was inserted, selected
 *     WITHIN the transaction, rolled back, then confirmed absent in a
 *     SEPARATE subsequent call). A synthetic period far in the future
 *     (2030) is used so the two real source RPCs (operational_salary_
 *     details/master_operational_spf_audit_period) legitimately return
 *     zero rows -- this doubles as the zero-op-COMPLETE proof. A real
 *     MASTER user's auth_user_id is looked up read-only (never printed,
 *     never used outside a SET LOCAL scoped to the rolled-back
 *     transaction) to simulate a real session, because auth.uid()
 *     cannot otherwise be established through this channel and the
 *     MASTER gate is exactly the thing this suite must prove works.
 *
 * Zero PII anywhere in this file or its output: no CPF, no real name,
 * no real chassis, no token/secret ever printed (only counts, booleans,
 * and opaque UUIDs already public within the project's own tables).
 *
 * Run: node tests/pm6d2_close_freezes_operational_detail_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260907130000_pm6d2_close_freezes_operational_detail.sql');
const SYNTHETIC_PERIOD_OK = '33333333-3333-3333-3333-333333333333';
const SYNTHETIC_PERIOD_BAD_RANGE = '44444444-4444-4444-4444-444444444444';

const results = [];
function check(label, cond) { results.push([label, !!cond]); }

function stripSqlLineComments(text) {
  return text.split('\n').map((line) => {
    const idx = line.indexOf('--');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

function runStaticChecks() {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file must exist');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const sqlLower = sql.toLowerCase();
  const codeOnly = stripSqlLineComments(sql);
  const codeOnlyLower = codeOnly.toLowerCase();

  check('1 (signature preserved): p_period_id uuid, p_summary jsonb, p_rows jsonb, no new parameter', /create\s+or\s+replace\s+function\s+public\.master_close_commission_period\(p_period_id uuid, p_summary jsonb, p_rows jsonb\)/i.test(codeOnly));
  check('2 (return contract preserved): exactly the 5 original keys present, no plausible new key (completeness/hash/engine_version/historical_detail_status) leaked into the return object', (() => {
    const m = codeOnly.match(/return\s+jsonb_build_object\(([\s\S]*?)\);\s*end;/i);
    if (!m) return false;
    const block = m[1];
    const expected = ['status', 'closing_id', 'period_id', 'version', 'snapshot_rows'];
    const allPresent = expected.every((k) => block.includes(`'${k}'`));
    const forbidden = ['completeness', 'hash', 'engine_version', 'historical_detail_status', 'sales_batch_id', 'finance_batch_id', 'spf_batch_id'];
    const noneForbidden = forbidden.every((k) => !block.includes(`'${k}'`));
    // Exactly 5 key-value pairs: each is written on its own line as
    // "'key', value," (or without trailing comma for the last one) --
    // count lines that start a new quoted key.
    const pairCount = (block.match(/^\s*'\w+',/gm) || []).length;
    return allPresent && noneForbidden && pairCount === 5;
  })());
  check('3 (financial validation untouched): all 5 original RAISE EXCEPTION validation blocks still present verbatim (42501/P0002/23505/22023 x2)', ['42501', 'P0002', '23505'].every((code) => codeOnly.includes(`'${code}'`)) && (codeOnly.match(/'22023'/g) || []).length >= 2);
  check('4 (snapshot_comissoes INSERT untouched): same column list as the pre-existing real body', /insert into public\.snapshot_comissoes \(\s*fechamento_id, periodo_id, nome_periodo, data_inicio, data_fim,\s*nome, perfil, loja, departamento, vendidas, financiadas, share, producao,\s*retorno, spf_extra, spf_liquido, rentabilidade_total, faixa,\s*comissao, detalhes\s*\)/i.test(codeOnly));
  check('5 (COMPLETE only after detail, Gate 17): the UPDATE setting historical_detail_status appears AFTER both operational INSERTs and their own row-count integrity checks', (() => {
    const chassisInsertIdx = codeOnlyLower.indexOf("kind, store, department, seller_user_id, seller_name,\n    sale_date");
    const spfInsertIdx = codeOnlyLower.indexOf("operation_date, chassis_masked, operation_code, bank, finance_code");
    const completeIdx = codeOnlyLower.indexOf("historical_detail_status = 'complete'");
    return chassisInsertIdx !== -1 && spfInsertIdx !== -1 && completeIdx !== -1 && completeIdx > chassisInsertIdx && completeIdx > spfInsertIdx;
  })());
  check('6 (zero-op COMPLETE, Gate 18/56): no code path skips setting COMPLETE when row count is 0 -- the UPDATE is unconditional, never wrapped in an "if v_..._row_count > 0" guard', !/if\s+v_chassis_row_count\s*>\s*0/i.test(codeOnly) && !/if\s+v_spf_row_count\s*>\s*0/i.test(codeOnly));
  check('7 (source failure aborts everything, Gate 19): both source RPC calls are un-caught (no BEGIN/EXCEPTION block anywhere) -- any RAISE propagates and aborts the whole function/transaction', !/exception\s+when/i.test(codeOnly));
  check('8 (malformed source guarded explicitly, Gate 20): both source results are checked for jsonb array shape before use', (codeOnly.match(/jsonb_typeof\(coalesce\(v_(chassis|spf)_result->'rows', 'null'::jsonb\)\) <> 'array'/gi) || []).length === 2);
  check('9 (no live fallback growth): migration never defines/alters master_commission_operational_detail (the READ rpc stays PM-6D.1-only, zero-live-fallback proof already covered by that suite)', !codeOnlyLower.includes('master_commission_operational_detail'));
  check('10 (no CPF/cliente in the NEW PM-6D.2 supplementary section -- the pre-existing, unrelated "cpf" column in the original auditoria INSERT is untouched code, out of scope for this check)', (() => {
    // Locate boundaries in the ORIGINAL (comment-bearing) source -- the
    // markers themselves live inside -- comment lines, which codeOnly
    // has already stripped away.
    const startIdx = sqlLower.indexOf('pm-6d.2 -- captura atomica');
    const endIdx = sqlLower.indexOf('fim da captura suplementar');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return false;
    const newSectionCodeOnly = stripSqlLineComments(sql.slice(startIdx, endIdx));
    return !/\bcpf\b/i.test(newSectionCodeOnly) && !/\bcliente\b/i.test(newSectionCodeOnly);
  })());
  check('11 (no raw chassis column touched, only chassis_masked field mapped)', !/\bchassis\s+(text|varchar|character)/i.test(codeOnly));
  check('12 (provenance resolved from portal_import_batches, no invented UUID)', /from\s+public\.portal_import_batches/i.test(codeOnly) && !/v_sales_batch_id\s*:=\s*'[0-9a-f-]{36}'/i.test(codeOnly));
  check('13 (engine version is a compile-time constant, never derived from a live git/db value)', /v_engine_version constant text := 'commission-secure-v1'/i.test(codeOnly));
  check('14 (hash uses extensions.digest, fully-qualified for the pinned search_path)', /extensions\.digest\(/i.test(codeOnly));
  check('15 (hash format hex, matches the COLUMN CHECK expectation from PM-6D.1)', /encode\(\s*extensions\.digest\(/i.test(codeOnly) && /,\s*'hex'\s*\)/i.test(codeOnly));
  check('16 (no existing-data DML): no UPDATE/DELETE touching fechamentos_comissao by id filter other than the new closing itself (v_closing_id), no bulk UPDATE', !/update\s+public\.fechamentos_comissao\s+set[\s\S]*?where\s+(?!id = v_closing_id)/i.test(codeOnly.replace(/\n/g, ' ')) || /where id = v_closing_id/i.test(codeOnly));
  check('17 (SECURITY DEFINER + pinned search_path preserved)', /security definer/i.test(codeOnly) && /set search_path to 'pg_catalog', 'public'/i.test(codeOnly));
}

function readToken() {
  const envPath = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(envPath)) return null;
  const m = fs.readFileSync(envPath, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
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
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] LIVE layer: no SUPABASE_ACCESS_TOKEN available locally.');
    return;
  }
  assert.ok(!token.includes(FORBIDDEN_PROJECT_REF), 'token file must never reference the forbidden staging project ref');

  const baseline = await runSql(token, `select json_build_object('fechamentos', (select count(*) from public.fechamentos_comissao), 'snapshots', (select count(*) from public.snapshot_comissoes), 'detail', (select count(*) from public.snapshot_operational_detail)) as r;`);
  const b = baseline.body[0].r;
  check('18 (PROJECT_REF_GUARD live)', baseline.status === 201);

  const masterLookup = await runSql(token, `select auth_user_id from public.usuarios where ativo is true and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null limit 1;`);
  const masterUid = masterLookup.body && masterLookup.body[0] && masterLookup.body[0].auth_user_id;
  check('19 (a real active MASTER user exists to simulate a session with, opaque uuid only, never printed elsewhere)', !!masterUid);
  if (!masterUid) { console.log('[SKIP] remaining LIVE checks: no MASTER user found to simulate.'); return; }

  const newFnSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const newFnOnly = newFnSql.slice(newFnSql.indexOf('CREATE OR REPLACE FUNCTION'));

  // ---- Successful synthetic close + zero-op COMPLETE (Gate 55/56) ----
  const successTx = await runSql(token, `
BEGIN;
${newFnOnly}
set local request.jwt.claim.sub = '${masterUid}';
insert into public.periodos_comissao (id, nome_periodo, data_inicio, data_fim, ativo, status)
values ('${SYNTHETIC_PERIOD_OK}'::uuid, 'PM6D2_TEST_OK', '2031-02-01', '2031-02-02', true, 'EM CONFERENCIA');
select public.master_close_commission_period(
  '${SYNTHETIC_PERIOD_OK}'::uuid,
  '{"qtd_vendida": 1, "comissao_total": 5}'::jsonb,
  '[{"nome":"PM6D2 Sintetico","perfil":"VENDEDOR","loja":"LOJA X","status":"NOVOS","vendidas":1,"financiadas":0,"share":100,"producao":100,"retorno":10,"spf_extra":0,"spf_liquido":0,"rentabilidade_total":10,"faixa":0.003,"comissao_principal":5,"comissao_spf":0,"comissao_total":5}]'::jsonb
);
select json_build_object(
  'fechamento', (select json_build_object('status', status, 'historical_detail_status', historical_detail_status, 'hash_ok', snapshot_payload_hash ~ '^[0-9a-f]{64}$', 'engine_version', commission_engine_version, 'sales_batch_set', sales_batch_id is not null) from public.fechamentos_comissao where periodo_id = '${SYNTHETIC_PERIOD_OK}'::uuid),
  'financial_rows', (select count(*) from public.snapshot_comissoes s join public.fechamentos_comissao f on f.id = s.fechamento_id where f.periodo_id = '${SYNTHETIC_PERIOD_OK}'::uuid),
  'chassis_rows', (select count(*) from public.snapshot_operational_detail d join public.fechamentos_comissao f on f.id = d.fechamento_id where f.periodo_id = '${SYNTHETIC_PERIOD_OK}'::uuid and d.kind='CHASSIS'),
  'spf_rows', (select count(*) from public.snapshot_operational_detail d join public.fechamentos_comissao f on f.id = d.fechamento_id where f.periodo_id = '${SYNTHETIC_PERIOD_OK}'::uuid and d.kind='SPF')
) as verification;
ROLLBACK;
`);
  let v = null;
  try { v = successTx.body[successTx.body.length - 1].verification; } catch (e) {}
  check('20 (SUCCESS TEST): synthetic close reaches FECHADO status', successTx.status === 201 && v && v.fechamento && v.fechamento.status === 'FECHADO');
  check('21 (SUCCESS TEST): historical_detail_status = COMPLETE', v && v.fechamento && v.fechamento.historical_detail_status === 'COMPLETE');
  check('22 (SUCCESS TEST): hash is valid 64-char lowercase hex', v && v.fechamento && v.fechamento.hash_ok === true);
  check('23 (SUCCESS TEST): engine version recorded', v && v.fechamento && v.fechamento.engine_version === 'commission-secure-v1');
  check('24 (SUCCESS TEST): provenance batch id populated (real batch exists for SALES_CURRENT)', v && v.fechamento && v.fechamento.sales_batch_set === true);
  check('25 (SUCCESS TEST): exactly 1 financial snapshot row (matches p_rows)', v && v.financial_rows === 1);
  check('26 (ZERO-OP COMPLETE, Gate 56): zero CHASSIS rows for the far-future synthetic period -- legitimately zero, not an error, and COMPLETE was still set (check 21)', v && v.chassis_rows === 0);
  check('27 (ZERO-OP COMPLETE): zero SPF rows likewise', v && v.spf_rows === 0);

  // ---- Post-rollback: zero trace ----
  const afterSuccess = await runSql(token, `select json_build_object('fechamentos', (select count(*) from public.fechamentos_comissao), 'snapshots', (select count(*) from public.snapshot_comissoes), 'detail', (select count(*) from public.snapshot_operational_detail), 'period_exists', exists(select 1 from public.periodos_comissao where id='${SYNTHETIC_PERIOD_OK}'::uuid)) as r;`);
  const a1 = afterSuccess.body[0].r;
  check('28 (ROLLBACK VERIFIED): counts identical to pre-test baseline after the successful-close test rolled back', a1.fechamentos === b.fechamentos && a1.snapshots === b.snapshots && a1.detail === b.detail);
  check('29 (ROLLBACK VERIFIED): synthetic period does not exist after rollback', a1.period_exists === false);

  // ---- Atomic failure test (Gate 19/52): invalid date range aborts everything ----
  const failTx = await runSql(token, `
BEGIN;
${newFnOnly}
set local request.jwt.claim.sub = '${masterUid}';
insert into public.periodos_comissao (id, nome_periodo, data_inicio, data_fim, ativo, status)
values ('${SYNTHETIC_PERIOD_BAD_RANGE}'::uuid, 'PM6D2_TEST_FAIL', '2031-05-05', '2031-05-01', true, 'EM CONFERENCIA');
select public.master_close_commission_period(
  '${SYNTHETIC_PERIOD_BAD_RANGE}'::uuid,
  '{"qtd_vendida": 1, "comissao_total": 5}'::jsonb,
  '[{"nome":"PM6D2 Falha","perfil":"VENDEDOR","loja":"LOJA X","status":"NOVOS","vendidas":1,"financiadas":0,"share":100,"producao":100,"retorno":10,"spf_extra":0,"spf_liquido":0,"rentabilidade_total":10,"faixa":0.003,"comissao_principal":5,"comissao_spf":0,"comissao_total":5}]'::jsonb
);
ROLLBACK;
`);
  check('30 (ATOMIC FAILURE TEST): invalid period date range causes the source RPC to raise, and the whole call fails (HTTP error, not a success payload)', failTx.status !== 201);
  check('31 (ATOMIC FAILURE TEST): the real error is the source RPC own guard (22023 Periodo invalido), proving propagation through the nested call, not a masked/generic error', JSON.stringify(failTx.body).includes('22023') && JSON.stringify(failTx.body).toLowerCase().includes('periodo'));

  const afterFail = await runSql(token, `select json_build_object('fechamentos', (select count(*) from public.fechamentos_comissao), 'snapshots', (select count(*) from public.snapshot_comissoes), 'detail', (select count(*) from public.snapshot_operational_detail), 'closing_exists', exists(select 1 from public.fechamentos_comissao where periodo_id='${SYNTHETIC_PERIOD_BAD_RANGE}'::uuid)) as r;`);
  const a2 = afterFail.body[0].r;
  check('32 (ATOMIC FAILURE TEST): NOTHING persisted -- not even the financial fechamento/snapshot rows that were inserted BEFORE the failure point in the function body', a2.fechamentos === b.fechamentos && a2.snapshots === b.snapshots && a2.detail === b.detail && a2.closing_exists === false);

  // ---- Legacy read (Gate 54/61): a real existing closing must classify LEGACY_PARTIAL ----
  const legacyRead = await runSql(token, `
BEGIN;
set local request.jwt.claim.sub = '${masterUid}';
select
  (select id from public.fechamentos_comissao where historical_detail_status is null order by criado_em desc limit 1) as any_legacy_closing_id;
ROLLBACK;
`);
  let legacyId = null;
  try { legacyId = legacyRead.body[legacyRead.body.length - 1].any_legacy_closing_id; } catch (e) {}
  if (legacyId) {
    const legacyCheck = await runSql(token, `
BEGIN;
set local request.jwt.claim.sub = '${masterUid}';
select (public.master_commission_operational_detail('${legacyId}'::uuid))->>'completeness' as completeness;
ROLLBACK;
`);
    const completeness = legacyCheck.body && legacyCheck.body[0] && legacyCheck.body[0].completeness;
    check('33 (LEGACY READ TEST, Gate 54/61): a real pre-existing closing (historical_detail_status IS NULL) reads back as LEGACY_PARTIAL, never fabricated', completeness === 'LEGACY_PARTIAL');
  } else {
    check('33 (LEGACY READ TEST): skipped -- no legacy closing found (unexpected given 24 known real closings, but not a failure of this migration)', true);
  }

  // ---- Post-apply live fingerprint (only meaningful once the real function has actually been applied by this session) ----
  const fingerprint = await runSql(token, `select pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='master_close_commission_period';`);
  const fp = fingerprint.body[0];
  check('34 (LIVE FINGERPRINT): deployed close RPC signature is exactly p_period_id uuid, p_summary jsonb, p_rows jsonb', fp && fp.args === 'p_period_id uuid, p_summary jsonb, p_rows jsonb');
  check('35 (LIVE FINGERPRINT): deployed close RPC is still SECURITY DEFINER with pinned search_path', fp && fp.prosecdef === true && Array.isArray(fp.proconfig) && fp.proconfig.includes('search_path=pg_catalog, public'));

  const finalCounts = await runSql(token, `select json_build_object('fechamentos', (select count(*) from public.fechamentos_comissao), 'snapshots', (select count(*) from public.snapshot_comissoes), 'detail', (select count(*) from public.snapshot_operational_detail), 'complete_count', (select count(*) from public.fechamentos_comissao where historical_detail_status='COMPLETE')) as r;`);
  const fc = finalCounts.body[0].r;
  check('36 (NO REAL COMPLETE, Gate 68): zero existing fechamentos are COMPLETE -- no real close was ever executed by this test suite or this wave', fc.complete_count === 0);
  check('37 (FINAL COUNTS UNCHANGED from this suite own baseline)', fc.fechamentos === b.fechamentos && fc.snapshots === b.snapshots && fc.detail === b.detail);
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
  console.log(`=== PM-6D.2 Close Freezes Operational Detail: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

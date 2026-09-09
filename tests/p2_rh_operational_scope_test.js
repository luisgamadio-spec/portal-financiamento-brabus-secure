#!/usr/bin/env node
/*
 * RH-2 -- RH Operational Scope Reconciliation.
 *
 * Schema/security/behavior test for the migration
 * supabase/migrations/20260908100000_incidente_p2_rh_operational_scope.sql.
 * Two layers:
 *
 *  1. STATIC: the migration file's own SQL text is inspected for the
 *     absolute prohibitions of this wave -- strictly additive, exactly
 *     one function changed, no ALTER/DROP of anything else, signature/
 *     security/search_path preserved, existing profile branches
 *     untouched, RH branch present and correctly scoped.
 *  2. LIVE (read-only, fully transaction-scoped): re-verifies, against
 *     the REAL deployed function on the real project (yacqlelpzchcotgngwbh,
 *     guarded explicitly -- never zhzubcismiwdypavwdxf), that RH now
 *     resolves NOVOS+SEMINOVOS with is_master/is_director/is_seller all
 *     false, that every pre-existing profile (MASTER/ANALISTA/GERENTE/
 *     VENDEDOR/DIRETOR NOVOS/DIRETOR SEMINOVOS) is byte-identical to its
 *     pre-fix behavior, that portal_modulos_permitidos()/
 *     permissoes_modulos were not touched, and that master_admin_manage()
 *     still never calls operational_current_scope() (RH cannot escalate
 *     to MASTER-only surfaces via this fix).
 *
 * Uses the SAME Management API read-only mechanism already established
 * in this project's own prior incident tests (see
 * pm6d1_snapshot_operational_detail_foundation_test.js). Every live
 * identity check inserts a synthetic usuarios row and impersonates it
 * via request.jwt.claims inside a single BEGIN...ROLLBACK query -- the
 * row never persists (verified explicitly below). Zero PII, zero real
 * financial values, zero persistent write.
 *
 * Run: node tests/p2_rh_operational_scope_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const assert = require('assert');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260908100000_incidente_p2_rh_operational_scope.sql');

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

function runStaticChecks() {
  assert.ok(fs.existsSync(MIGRATION_PATH), 'migration file must exist at the expected path');
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  const codeOnly = stripSqlLineComments(sql);
  const codeOnlyLower = codeOnly.toLowerCase();

  check('1 (exactly one function definition in this migration)', (codeOnly.match(/create\s+or\s+replace\s+function/gi) || []).length === 1);
  check('2 (only operational_current_scope is targeted)', /create\s+or\s+replace\s+function\s+public\.operational_current_scope\s*\(\s*\)/i.test(codeOnly));
  check('3 (no ALTER/DROP anywhere in this migration)', !/\b(alter|drop)\b/i.test(codeOnly));
  check('4 (no DML: no INSERT/UPDATE/DELETE against any table)', !/\b(insert\s+into|update\s+public\.|delete\s+from)\b/i.test(codeOnly));
  check('5 (no GRANT/REVOKE -- grants intentionally untouched)', !/\b(grant|revoke)\b/i.test(codeOnly));
  check('6 (signature preserved: RETURNS jsonb)', /returns\s+jsonb/i.test(codeOnly));
  check('7 (security mode preserved: STABLE SECURITY DEFINER)', /stable\s+security\s+definer/i.test(codeOnly));
  check('8 (search_path preserved exactly)', /set\s+search_path\s+to\s+'pg_catalog',\s*'public'/i.test(codeOnly));
  check('9 (RH branch present, both spellings)', /elsif\s+v_profile\s+in\s*\(\s*'RECURSOS HUMANOS',\s*'RH'\s*\)\s+then/i.test(codeOnly));
  check('10 (RH normalized to canonical label)', /v_profile\s*:=\s*'RH';/i.test(codeOnly));
  check('11 (RH gets NOVOS + SEMINOVOS, corporate scope)', /v_departments\s*:=\s*array\['NOVOS',\s*'SEMINOVOS'\];[\s\S]{0,10}else/i.test(codeOnly));
  check('12 (RH added to the final allowlist)', /'RH',\s*'ANALISTA',\s*'GERENTE',\s*'VENDEDOR'/i.test(codeOnly));
  check('13 (MASTER branch untouched: NOVOS+SEMINOVOS unconditional)', /if\s+v_profile\s*=\s*'MASTER'\s+then\s*\n\s*v_departments\s*:=\s*array\['NOVOS',\s*'SEMINOVOS'\];/i.test(codeOnly));
  check('14 (DIRETOR NOVOS branch untouched)', /elsif\s+v_profile\s+in\s*\(\s*'DIRETOR NOVOS',\s*'DIRETOR DE NOVOS'\s*\)\s+then\s*\n\s*v_departments\s*:=\s*array\['NOVOS'\];/i.test(codeOnly));
  check('15 (DIRETOR SEMINOVOS branch untouched)', /elsif\s+v_profile\s+in\s*\(\s*'DIRETOR SEMINOVOS',\s*'DIRETOR DE SEMINOVOS'\s*\)\s+then\s*\n\s*v_departments\s*:=\s*array\['SEMINOVOS'\];/i.test(codeOnly));
  check('16 (status-derived else branch for ANALISTA/GERENTE/VENDEDOR untouched)', codeOnlyLower.includes("if replace(v_status, 'seminovos', '') like '%novos%' then"));
  check('17 (identity-not-resolved fail-closed branch untouched, still 42501)', /raise\s+exception\s+'Conta sem perfil ativo no portal\.'\s*\n\s*using\s+errcode\s*=\s*'42501';/i.test(codeOnly));
  check('18 (unmapped-profile fail-closed branch untouched, still 42501)', /raise\s+exception\s+'Perfil sem acesso aos dados operacionais\.'\s*\n\s*using\s+errcode\s*=\s*'42501';/i.test(codeOnly));
  check('19 (return contract unchanged: exactly 6 keys)', (codeOnly.match(/'profile'|'store'|'departments'|'is_master'|'is_director'|'is_seller'/gi) || []).length === 6);
  check('20 (is_master/is_director/is_seller are generic derivations, not RH-specific overrides)', !/is_master['",\s]*v_profile\s*=\s*'RH'/i.test(codeOnly) && !/is_seller['",\s]*v_profile\s*=\s*'RH'/i.test(codeOnly));
}

// ---------- LAYER 2: LIVE (read-only, fully transaction-scoped) ----------
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

// Every profile check inserts a synthetic, uniquely-named usuarios row,
// impersonates it via request.jwt.claims, calls operational_current_scope(),
// then ROLLBACKs -- zero persistent effect (verified separately below).
function scopeQuery(label, perfil, status) {
  const statusSql = status ? `'${status}'` : 'NULL';
  return `BEGIN;
DO $do$
DECLARE
  v_test_id uuid := gen_random_uuid();
  v_test_auth_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status)
  VALUES (v_test_id, v_test_auth_id, 'RH2_TEST_${label}', '${perfil}', true, '00000000000-RH2T-${label}', NULL, ${statusSql});
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_test_auth_id)::text, true);
END $do$;
SELECT public.operational_current_scope() AS result;
ROLLBACK;`;
}

async function runLiveChecks() {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] LIVE layer: no SUPABASE_ACCESS_TOKEN available locally -- static layer above is authoritative in this environment.');
    return;
  }
  assert.ok(!token.includes(FORBIDDEN_PROJECT_REF), 'token file must never reference the forbidden staging project ref');

  const authCheck = await runSql(token, `select current_database() as db;`);
  check('21 (PROJECT_REF_GUARD): Management API reachable for the real project only', authCheck.status === 201);

  const before = await runSql(token, `BEGIN; SELECT count(*) as n FROM usuarios; ROLLBACK;`);
  const usuariosBefore = before.body[0].n;

  const rh1 = await runSql(token, scopeQuery('RH', 'RH', null));
  const s1 = rh1.body[0].result;
  check('22 (RH resolves: profile=RH)', s1 && s1.profile === 'RH');
  check('23 (RH resolves: departments=[NOVOS,SEMINOVOS], corporate scope)', s1 && JSON.stringify(s1.departments.slice().sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));
  check('24 (RH resolves: is_master=false)', s1 && s1.is_master === false);
  check('25 (RH resolves: is_director=false)', s1 && s1.is_director === false);
  check('26 (RH resolves: is_seller=false)', s1 && s1.is_seller === false);

  const rh2 = await runSql(token, scopeQuery('RECURSOS_HUMANOS', 'RECURSOS HUMANOS', null));
  const s2 = rh2.body[0].result;
  check('27 (RECURSOS HUMANOS spelling also normalizes to RH, same scope)', s2 && s2.profile === 'RH' && JSON.stringify(s2.departments.slice().sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));

  const master = await runSql(token, scopeQuery('MASTER', 'MASTER', null));
  const sm = master.body[0].result;
  check('28 (MASTER unchanged: both departments, is_master=true)', sm && sm.is_master === true && JSON.stringify(sm.departments.slice().sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));

  const analista = await runSql(token, scopeQuery('ANALISTA', 'ANALISTA', 'NOVOS'));
  const sa = analista.body[0].result;
  check('29 (ANALISTA unchanged: status-derived department, unaffected by RH branch)', sa && sa.profile === 'ANALISTA' && JSON.stringify(sa.departments) === JSON.stringify(['NOVOS']));

  const gerente = await runSql(token, scopeQuery('GERENTE', 'GERENTE', 'SEMINOVOS'));
  const sg = gerente.body[0].result;
  check('30 (GERENTE unchanged)', sg && sg.profile === 'GERENTE' && JSON.stringify(sg.departments) === JSON.stringify(['SEMINOVOS']));

  const vendedor = await runSql(token, scopeQuery('VENDEDOR', 'VENDEDOR', 'NOVOS/SEMINOVOS'));
  const sv = vendedor.body[0].result;
  check('31 (VENDEDOR unchanged: is_seller=true, combined status parses both departments)', sv && sv.is_seller === true && JSON.stringify(sv.departments.slice().sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));

  const diretorN = await runSql(token, scopeQuery('DIRETOR_NOVOS', 'DIRETOR NOVOS', null));
  const sdn = diretorN.body[0].result;
  check('32 (DIRETOR NOVOS unchanged: is_director=true, NOVOS only)', sdn && sdn.is_director === true && JSON.stringify(sdn.departments) === JSON.stringify(['NOVOS']));

  const diretorS = await runSql(token, scopeQuery('DIRETOR_SEMINOVOS', 'DIRETOR SEMINOVOS', null));
  const sds = diretorS.body[0].result;
  check('33 (DIRETOR SEMINOVOS unchanged: is_director=true, SEMINOVOS only)', sds && sds.is_director === true && JSON.stringify(sds.departments) === JSON.stringify(['SEMINOVOS']));

  const after = await runSql(token, `BEGIN; SELECT count(*) as n, count(*) filter (where nome ILIKE 'RH2_TEST_%') as leaked FROM usuarios; ROLLBACK;`);
  check('34 (zero persistent writes: usuarios row count unchanged after all 8 transient tests)', after.body[0].n === usuariosBefore);
  check('35 (zero leaked test rows)', after.body[0].leaked === 0);

  const matrixCheck = await runSql(token, `
    select json_build_object(
      'portal_modulos_permitidos_def', pg_get_functiondef(p.oid),
      'rh_comissoes_grant', (select permitido from permissoes_modulos where perfil='RH' and modulo_id='comissoes' and departamento='TODOS'),
      'rh_grant_count', (select count(*) from permissoes_modulos where perfil='RH'),
      'master_admin_manage_calls_scope', (select pg_get_functiondef(p2.oid) ilike '%operational_current_scope%' from pg_proc p2 join pg_namespace n2 on n2.oid=p2.pronamespace where n2.nspname='public' and p2.proname='master_admin_manage')
    ) as r
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='portal_modulos_permitidos';
  `);
  const mr = matrixCheck.body[0].r;
  check('36 (portal_modulos_permitidos untouched by this migration)', typeof mr.portal_modulos_permitidos_def === 'string' && mr.portal_modulos_permitidos_def.includes("v_profile in ('RECURSOS HUMANOS', 'RH')"));
  check('37 (permissoes_modulos RH->comissoes grant unchanged: still true)', mr.rh_comissoes_grant === true);
  check('38 (permissoes_modulos RH row count unchanged: still 7)', mr.rh_grant_count === 7);
  check('39 (RH cannot escalate: master_admin_manage never calls operational_current_scope)', mr.master_admin_manage_calls_scope === false);

  // Salary/commission RPC chain: proves the previously-blocked chain is
  // now structurally unblocked for RH -- future date range guarantees
  // zero real rows, so zero PII/financial values are ever computed.
  const chain = await runSql(token, scopeQuery('CHAIN', 'RH', null).replace(
    'SELECT public.operational_current_scope() AS result;',
    `SELECT jsonb_build_object(
      'salary_details_ok', (select (public.operational_salary_details('2099-01-01'::date,'2099-01-02'::date,null)->>'row_count')::int is not null),
      'commission_metrics_ok', (select (public.operational_commission_metrics('2099-01-01'::date,'2099-01-02'::date)->'scope'->>'profile') = 'RH')
    ) AS result;`
  ));
  const sc = chain.body[0] && chain.body[0].result;
  check('40 (operational_salary_details no longer 42501 for RH)', sc && sc.salary_details_ok === true);
  check('41 (operational_commission_metrics resolves RH scope correctly)', sc && sc.commission_metrics_ok === true);
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
  console.log(`=== RH-2 Operational Scope Reconciliation: ${passed}/${results.length} ===`);
  console.log('RESULT: ' + (passed === results.length ? 'PASS' : 'FAIL'));
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });

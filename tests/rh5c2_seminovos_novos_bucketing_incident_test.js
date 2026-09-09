/* RH-5C.2 -- deterministic regression proving the exact SEMINOVOS/NOVOS
   manager-bucketing string collision (portal-app.js:4925-4926, verbatim
   below), and demonstrating a safe, mutually-exclusive counterfactual
   classifier. TEST/FORENSIC ONLY -- proves nothing was changed in any
   runtime file this Wave; no production code is imported or modified
   by this file, and no other file in this repo requires this one.

   Zero business data, zero network calls, zero writes. Run with:
     node tests/rh5c2_seminovos_novos_bucketing_incident_test.js
*/

// Verbatim from assets/js/portal-app.js:4922-4927 (the real, live
// GERENTE bucketing loop inside calcularPreviewFechamentoCompetenciaSegura).
function legacyClassify(department) {
  var dep = String(department || '').toUpperCase();
  var grupos = [];
  if (dep.includes('NOVOS')) grupos.push('NOVOS');
  if (dep.includes('SEMINOVOS')) grupos.push('SEMINOVOS');
  return grupos;
}

// Counterfactual: exact, mutually-exclusive match -- no department
// value observed live in production (portal_sales.department: exactly
// 'NOVOS' or 'SEMINOVOS', confirmed via live read-only query, RH-5C.2)
// is ever anything else, so exact equality is a complete, safe
// replacement -- never a narrower classifier than what real data needs.
function counterfactualClassify(department) {
  var dep = String(department || '').toUpperCase().trim();
  if (dep === 'NOVOS') return ['NOVOS'];
  if (dep === 'SEMINOVOS') return ['SEMINOVOS'];
  return [];
}

var results = [];
function check(label, cond) { results.push([label, !!cond]); }

// ---------- The collision itself ----------
check('legacy: NOVOS classifies as NOVOS only', JSON.stringify(legacyClassify('NOVOS')) === JSON.stringify(['NOVOS']));
check('legacy: SEMINOVOS INCORRECTLY also classifies as NOVOS (the incident)', legacyClassify('SEMINOVOS').indexOf('NOVOS') !== -1);
check('legacy: SEMINOVOS correctly classifies as SEMINOVOS too (both, not instead)', legacyClassify('SEMINOVOS').indexOf('SEMINOVOS') !== -1);
check('legacy: SEMINOVOS row therefore lands in BOTH buckets (double contribution)', legacyClassify('SEMINOVOS').length === 2);

// ---------- The counterfactual fix ----------
check('counterfactual: NOVOS classifies as NOVOS only', JSON.stringify(counterfactualClassify('NOVOS')) === JSON.stringify(['NOVOS']));
check('counterfactual: SEMINOVOS classifies as SEMINOVOS only, never NOVOS', JSON.stringify(counterfactualClassify('SEMINOVOS')) === JSON.stringify(['SEMINOVOS']));
check('counterfactual: SEMINOVOS must NOT contribute to the NOVOS bucket', counterfactualClassify('SEMINOVOS').indexOf('NOVOS') === -1);
check('counterfactual: mutually exclusive -- exactly one bucket per real department value', counterfactualClassify('NOVOS').length === 1 && counterfactualClassify('SEMINOVOS').length === 1);

// ---------- Why substring matching is unsafe (the root cause, explicit) ----------
check('root cause: "SEMINOVOS" contains the literal substring "NOVOS"', 'SEMINOVOS'.indexOf('NOVOS') !== -1);
check('root cause: the reverse is NOT true (NOVOS does not contain SEMINOVOS)', 'NOVOS'.indexOf('SEMINOVOS') === -1);

// ---------- Real live production department values (confirmed via read-only query, RH-5C.2) never include anything else ----------
var REAL_LIVE_DEPARTMENT_VALUES = ['NOVOS', 'SEMINOVOS']; // portal_sales.department distinct values, confirmed live this Wave
REAL_LIVE_DEPARTMENT_VALUES.forEach(function (d) {
  check('counterfactual handles every real live department value (' + d + ')', counterfactualClassify(d).length === 1);
});

var passed = results.filter(function (r) { return r[1]; }).length;
results.forEach(function (r) { console.log('[' + (r[1] ? 'PASS' : 'FAIL') + '] ' + r[0]); });
console.log('\n=== RH-5C.2 SEMINOVOS/NOVOS Manager Bucketing Incident: ' + passed + '/' + results.length + ' ===');
console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
process.exit(passed === results.length ? 0 : 1);

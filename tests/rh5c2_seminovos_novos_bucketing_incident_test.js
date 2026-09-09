/* RH-5C.2/RH-5C.3 -- deterministic regression proving (a) the exact
   SEMINOVOS/NOVOS manager-bucketing string collision as it originally
   existed (forensic record, kept verbatim -- RH-5C.2), and (b) that
   the REAL, LIVE, CURRENTLY-DEPLOYED classifier in
   assets/js/portal-app.js no longer has it (RH-5C.3 -- extracted
   directly from the real file at test time via regex + eval, not a
   disconnected synthetic copy, so this test fails if the runtime ever
   regresses back to substring matching).

   TEST/FORENSIC ONLY for the RH-5C.2 portion. The RH-5C.3 portion
   reads (never modifies) assets/js/portal-app.js.

   Zero business data, zero network calls, zero writes. Run with:
     node tests/rh5c2_seminovos_novos_bucketing_incident_test.js
*/
var fs = require('fs');
var path = require('path');

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

// ---------- RH-5C.3: extract and test the ACTUAL, currently-deployed
// classifier from the real runtime file -- proves the real fix, not
// just a synthetic stand-in, and fails loudly if the file ever
// regresses back to substring matching. ----------
(function () {
  var portalAppSrc;
  try {
    portalAppSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'js', 'portal-app.js'), 'utf8');
  } catch (e) {
    check('RH-5C.3: could read assets/js/portal-app.js to extract the real classifier', false);
    return;
  }

  // Extract the exact classification block between the gerenteBuckets
  // declaration and the grupos.forEach call that consumes it -- the
  // real, live decision logic, not a paraphrase.
  var blockMatch = portalAppSrc.match(/const gerenteBuckets=\{\};\s*vendRows\.forEach\(row=>\{([\s\S]*?)grupos\.forEach\(g=>\{/);
  check('RH-5C.3: the real gerenteBuckets classification block was found in portal-app.js (extraction did not silently fail)', !!blockMatch);
  if (!blockMatch) { return; }

  var block = blockMatch[1];

  // The exact defect signature must be GONE from the real file.
  check('RH-5C.3: the real runtime no longer uses substring .includes(\'NOVOS\')/.includes(\'SEMINOVOS\') for this classification', !/\.includes\(\s*['"]NOVOS['"]\s*\)/.test(block) && !/\.includes\(\s*['"]SEMINOVOS['"]\s*\)/.test(block));

  // Build a callable function from the real extracted block and run it
  // against the same inputs as the synthetic counterfactualClassify
  // above -- proves the ACTUAL deployed logic, not a copy.
  var realClassifyFn;
  try {
    /* eslint-disable no-new-func */
    realClassifyFn = new Function('row', block + 'return grupos;'); // block itself declares `const grupos=[]`
  } catch (e) {
    check('RH-5C.3: the extracted real classification block is syntactically valid on its own', false);
    return;
  }

  check('RH-5C.3 (real runtime): NOVOS classifies as NOVOS only', JSON.stringify(realClassifyFn({ department: 'NOVOS' })) === JSON.stringify(['NOVOS']));
  check('RH-5C.3 (real runtime): SEMINOVOS classifies as SEMINOVOS only -- the incident is fixed in the actual deployed file', JSON.stringify(realClassifyFn({ department: 'SEMINOVOS' })) === JSON.stringify(['SEMINOVOS']));
  check('RH-5C.3 (real runtime): SEMINOVOS must NOT contribute to the NOVOS bucket', realClassifyFn({ department: 'SEMINOVOS' }).indexOf('NOVOS') === -1);
  check('RH-5C.3 (real runtime): combined "NOVOS/SEMINOVOS" still contributes to both (original intent preserved)', JSON.stringify(realClassifyFn({ department: 'NOVOS/SEMINOVOS' }).sort()) === JSON.stringify(['NOVOS', 'SEMINOVOS']));
  check('RH-5C.3 (real runtime): an unknown department value fails safe -- excluded, never silently becomes NOVOS', JSON.stringify(realClassifyFn({ department: 'OUTROS' })) === JSON.stringify([]));
  check('RH-5C.3 (real runtime): whitespace/case variants normalize correctly', JSON.stringify(realClassifyFn({ department: '  seminovos  ' })) === JSON.stringify(['SEMINOVOS']));
})();

var passed = results.filter(function (r) { return r[1]; }).length;
results.forEach(function (r) { console.log('[' + (r[1] ? 'PASS' : 'FAIL') + '] ' + r[0]); });
console.log('\n=== RH-5C.2 SEMINOVOS/NOVOS Manager Bucketing Incident: ' + passed + '/' + results.length + ' ===');
console.log('RESULT:', passed === results.length ? 'PASS' : 'FAIL');
process.exit(passed === results.length ? 0 : 1);

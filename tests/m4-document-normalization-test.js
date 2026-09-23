#!/usr/bin/env node
/*
 * Incidente T35918/M4 -- focused regression for client-side document
 * normalization/repair and Base03 finance-row preparation
 * (assets/js/master-gestao-bases.js). Extracts the REAL, shipped
 * function bodies verbatim (never a reimplementation).
 *
 * NOTE ON SCOPE: the actual identity matching / unique-vs-ambiguous
 * disambiguation now happens entirely server-side (SQL, inside
 * master_operational_apply_base03 -- see the migration file and
 * tests/m4-server-logic-dry-run.py for that layer, which cannot be
 * executed against a live Postgres in this environment and is instead
 * validated by a Python model of the same SQL against real data). This
 * file covers only what genuinely runs client-side.
 *
 * 0 real network calls. 0 database access. 0 credentials.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '..', 'assets', 'js', 'master-gestao-bases.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

function extractFunction(source, startMarker) {
  const startIdx = source.indexOf(startMarker);
  if (startIdx === -1) throw new Error('marker not found: ' + startMarker);
  const braceStart = source.indexOf('{', startIdx);
  let depth = 0, i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(startIdx, i);
}

const fnNames = [
  'function gbOnlyDigits(',
  'function gbNormalizeDocumentForMatch(',
  'function gbNormalize(',
  'function gbAsNumber(',
  'function gbGetCol(',
  'function gbBuildBase03FinanceRows(',
];
const fns = fnNames.map(m => extractFunction(src, m)).join('\n');

if (!src.includes('gbNormalizeDocumentForMatch') || !src.includes('gbBuildBase03FinanceRows')) {
  throw new Error('FIXTURE ERROR: M4 functions not found -- source may not contain the implementation');
}
if (src.includes('gbBuildBase03ClientIndex') && !src.match(/\/\/.*gbBuildBase03ClientIndex/)) {
  throw new Error('FIXTURE ERROR: superseded gbBuildBase03ClientIndex still present as live code, not just a comment');
}

function buildSandbox() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fns + `
    this.gbOnlyDigits = gbOnlyDigits;
    this.gbNormalizeDocumentForMatch = gbNormalizeDocumentForMatch;
    this.gbNormalize = gbNormalize;
    this.gbAsNumber = gbAsNumber;
    this.gbGetCol = gbGetCol;
    this.gbBuildBase03FinanceRows = gbBuildBase03FinanceRows;
  `, sandbox);
  return sandbox;
}

const results = [];
function check(label, cond) { results.push([label, !!cond]); }

const sb = buildSandbox();

// ---------------------------------------------------------------------
// Phase 3 / 12 (M, N, O): document normalization matrix.
// ---------------------------------------------------------------------
check('valid 11-digit CPF passes through unchanged', sb.gbNormalizeDocumentForMatch('74109570859').normalized === '74109570859');
check('valid 11-digit CPF -> shape VALID_CPF_SHAPE', sb.gbNormalizeDocumentForMatch('74109570859').shape === 'VALID_CPF_SHAPE');
check('valid 14-digit CNPJ passes through unchanged', sb.gbNormalizeDocumentForMatch('45437547000197').normalized === '45437547000197');
check('valid 14-digit CNPJ -> shape VALID_CNPJ_SHAPE', sb.gbNormalizeDocumentForMatch('45437547000197').shape === 'VALID_CNPJ_SHAPE');

// 9-digit repair (M4 Phase 3 evidence: 2 lost leading zeros)
{
  const r = sb.gbNormalizeDocumentForMatch('722255055');
  check('9-digit repairs to 11 with leading zeros', r.normalized === '00722255055' && r.normalized.length === 11);
  check('9-digit shape -> REPAIRED_CPF_SHAPE', r.shape === 'REPAIRED_CPF_SHAPE');
}
// 10-digit repair (1 lost leading zero)
{
  const r = sb.gbNormalizeDocumentForMatch('8608388898');
  check('10-digit repairs to 11 with leading zero', r.normalized === '08608388898' && r.normalized.length === 11);
  check('10-digit shape -> REPAIRED_CPF_SHAPE', r.shape === 'REPAIRED_CPF_SHAPE');
}
// 12-digit repair (CNPJ, 2 lost leading zeros)
{
  const r = sb.gbNormalizeDocumentForMatch('558004000190');
  check('12-digit repairs to 14 with leading zeros', r.normalized === '00558004000190' && r.normalized.length === 14);
  check('12-digit shape -> REPAIRED_CNPJ_SHAPE', r.shape === 'REPAIRED_CNPJ_SHAPE');
}
// 13-digit repair (CNPJ, 1 lost leading zero)
{
  const r = sb.gbNormalizeDocumentForMatch('8453767000188');
  check('13-digit repairs to 14 with leading zero', r.normalized === '08453767000188' && r.normalized.length === 14);
  check('13-digit shape -> REPAIRED_CNPJ_SHAPE', r.shape === 'REPAIRED_CNPJ_SHAPE');
}
// 8-digit REJECTION -- must never be silently padded (real anomalous examples from the audit).
{
  const r = sb.gbNormalizeDocumentForMatch('62297864');
  check('8-digit value is NEVER repaired (stays null/invalid)', r.normalized === null);
  check('8-digit shape -> INVALID_OTHER', r.shape === 'INVALID_OTHER');
}
// blank
{
  const r = sb.gbNormalizeDocumentForMatch('');
  check('blank -> normalized null', r.normalized === null);
  check('blank -> shape BLANK', r.shape === 'BLANK');
}
check('null input -> shape BLANK', sb.gbNormalizeDocumentForMatch(null).shape === 'BLANK');
// punctuation
{
  const r = sb.gbNormalizeDocumentForMatch('741.095.708-59');
  check('punctuated CPF normalizes correctly (digits only)', r.normalized === '74109570859' && r.shape === 'VALID_CPF_SHAPE');
}
// Excel numeric artifact (trailing .0) combined with a repair case
{
  const r = sb.gbNormalizeDocumentForMatch(8608388898.0);
  check('numeric Excel cell (no string coercion) still normalizes via digit extraction', r.normalized === '08608388898');
}
{
  const r = sb.gbNormalizeDocumentForMatch('8608388898.0');
  check('Excel ".0" string artifact does not corrupt the repair (digits-only strips it too)', r.normalized === '08608388898');
}
// leading-zero preservation for an already-valid, naturally-zero-leading document (string form)
{
  const r = sb.gbNormalizeDocumentForMatch('00722255055');
  check('already-11-digit value with a real leading zero is preserved exactly, not stripped', r.normalized === '00722255055' && r.shape === 'VALID_CPF_SHAPE');
}

// ---------------------------------------------------------------------
// gbBuildBase03FinanceRows: client-side prep/filter only.
// ---------------------------------------------------------------------
function b3row({ nome = 'CLIENTE TESTE', cpf = '74109570859', opCode, status, codigoIF, tc, balao = null, pmt = 0, parcelas = 0 }) {
  return {
    'Cli - Nome': nome,
    'Cli - CPF/CNPJ': cpf,
    'Op - Código': opCode,
    'Op - Situação': status,
    'Tabela - Código IF': codigoIF,
    'Tabela - TC Devolvida (R$)': tc,
    'Op Fin - Balão PMT (R$)': balao,
    'Op Fin - PMT (R$)': pmt,
    'Op Fin - Quantidade Parcelas': parcelas,
  };
}

{
  const rows = sb.gbBuildBase03FinanceRows([
    b3row({ opCode: '1', status: 'PAGA', codigoIF: '0', tc: 1 }),
    b3row({ opCode: '2', status: 'ENCERRADA', codigoIF: '999', tc: 0 }),
    b3row({ opCode: '3', status: 'CANCELADA', codigoIF: '999', tc: 0 }),
    b3row({ opCode: '4', status: 'FATURADA', codigoIF: '777', tc: 0 }),
    b3row({ opCode: '', status: 'PAGA', codigoIF: '0', tc: 1 }), // no op code -> dropped
    b3row({ cpf: '', opCode: '5', status: 'PAGA', codigoIF: '0', tc: 1 }), // no document -> dropped
  ]);
  check('only PAGA/FATURADA rows survive client-side prep', rows.length === 2 && rows.every(r => r.status === 'PAGA' || r.status === 'FATURADA'));
  check('ENCERRADA/CANCELADA rows are dropped client-side (server still re-enforces)', !rows.some(r => r.op_code === '2' || r.op_code === '3'));
  check('rows without op_code are dropped', !rows.some(r => r.op_code === ''));
  check('rows without a usable document are dropped', rows.every(r => r.client_document_normalized));
  check('surviving rows carry the raw op_code/status/signal fields, not a pre-aggregated key', rows.some(r => r.op_code === '1') && rows.some(r => r.op_code === '4'));
}

console.log();
const passed = results.filter(([, ok]) => ok).length;
for (const [label, ok] of results) console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label);
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);

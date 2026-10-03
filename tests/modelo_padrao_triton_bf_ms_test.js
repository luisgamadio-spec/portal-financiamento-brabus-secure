#!/usr/bin/env node
/*
 * modeloPadrao() — TRITON BF MS regression test.
 *
 * Root cause (confirmed via live, read-only auditing of
 * operational_model_metrics real output for setembro/2026, department
 * NOVOS): the "BF MS" special series arrives as a complete, untruncated
 * string ("TRITON BF MS 2.4 D 4X4 AT") that modeloPadrao() had no rule
 * for, falling through to the generic "INCONSISTÊNCIA TRITON" fallback.
 * Confirmed for the two real vehicles behind that card:
 *   93XHLLC2TVCT22877 (NAÇÕES/NOVOS) and 93XHLLC2TVCT23023 (EUROPA/NOVOS).
 *
 * This test extracts normalizeText()/modeloPadrao() literally from the
 * real module file (never retyped) and asserts every existing Triton
 * branch plus the new BF MS rule, so any future edit to that function
 * that breaks an existing classification fails loudly here.
 *
 * Run: node tests/modelo_padrao_triton_bf_ms_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const MODULE_PATH = path.join(__dirname, '..', 'modules', 'analise-geral-grupo-secure-original-layout.html');
const source = fs.readFileSync(MODULE_PATH, 'utf8');

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `função não encontrada no módulo real: ${signature}`);
  let depth = 0, i = src.indexOf('{', start), end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, `não foi possível fechar o corpo de: ${signature}`);
  return src.slice(start, end);
}

const normalizeTextSrc = extractFunction(source, 'function normalizeText(');
const modeloPadraoSrc = extractFunction(source, 'function modeloPadrao(');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(normalizeTextSrc + '\n' + modeloPadraoSrc, sandbox);
const modeloPadrao = sandbox.modeloPadrao;

let failures = 0;
function check(label, input, expected) {
  const actual = modeloPadrao(input);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: modeloPadrao(${JSON.stringify(input)}) -> ${JSON.stringify(actual)} (esperado ${JSON.stringify(expected)})`);
}

console.log('=== Caso novo: TRITON BF MS ===');
check('BF MS (caso obrigatório 1)', 'TRITON BF MS 2.4 D 4X4 AT', 'TRITON BF MS');
check('Chassi real 93XHLLC2TVCT22877/93XHLLC2TVCT23023', 'TRITON BF MS 2.4 D 4X4 AT', 'TRITON BF MS');

console.log('\n=== Regressão: demais séries Triton (devem permanecer inalteradas) ===');
check('Sertões (caso obrigatório 2)', 'TRITON SAVANA SERTOES', 'TRITON SAVANA');
check('Tarmac (caso obrigatório 3)', 'TRITON TARMAC 2.4', 'TRITON TARMAC');
check('HPE-S (caso obrigatório 4)', 'TRITON HPE-S', 'TRITON HPE-S');
check('HPE (caso obrigatório 5)', 'TRITON HPE', 'TRITON HPE');
check('GLS (caso obrigatório 6)', 'TRITON GLS', 'TRITON GLS');
check('GL (caso obrigatório 7)', 'TRITON GL', 'TRITON GL');
check('Katana', 'TRITON KATANA 2.4 D 4X4 AT', 'TRITON KATANA');
check('Savana (sem Sertões)', 'TRITON SAVANA 2.4 D 4X4 AT', 'TRITON SAVANA');
check('L200 Triton Sport HPE-S (completo, caso real recuperado na Fase 8)', 'L200 TRITON 2.4 16V TURBO DIESEL SPORT HPE-S TOP', 'TRITON HPE-S');

console.log('\n=== Sem classificação conhecida (caso obrigatório 8 — deve continuar caindo no fallback) ===');
check('Truncado sem BF MS/KATANA/SAVANA/TARMAC/HPE/GLS/GL', 'L200 TRITON 2.4 16V TURBO DIESEL SP', 'INCONSISTÊNCIA TRITON');
check('Sem informação suficiente (controle, sem Finance)', 'L200 4X4-AT 3.5 V-6(FLEX)', 'INCONSISTÊNCIA TRITON');

console.log('\n=== Regressão: outras famílias (não podem ser afetadas) ===');
check('Eclipse Cross HPE-S 4X4 (AWD)', 'ECLIPSE CROSS 1.5 MIVEC TURBO GASOLINA HPE-S AWD', 'ECLIPSE CROSS HPE-S 4X4');
check('Outlander HPE-S', 'OUTLANDER HPE-S', 'OUTLANDER HPE-S');
check('Outlander sem versão reconhecida', 'OUTLANDER 2.0 MIVEC GASOLINA HPE AUTOMATICO', 'OUTLANDER');

if (failures > 0) {
  console.error(`\n${failures} falha(s).`);
  process.exit(1);
}
console.log('\nTodos os casos passaram.');

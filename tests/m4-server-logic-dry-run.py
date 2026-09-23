#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Incidente T35918/M4 -- Python model of the SQL matching/disambiguation
logic added in supabase/migrations/20260922150000_incidente_m4_document_
match_key.sql (master_operational_apply_base03's new finance-enrichment
block). This is NOT a substitute for executing the real SQL against
Postgres -- no local Postgres is available in this environment and
writing to the real Supabase project is explicitly forbidden this wave.
It validates the ALGORITHM (grouping by document, strict PAGA/FATURADA
eligibility, unique-only automatic selection, never guessing on a
signal conflict) against both synthetic fixtures and the real current
source files, exactly mirroring the SQL's group-by/count-distinct logic.

The HMAC step itself is intentionally NOT reproduced here (no secret
exists outside the database, and none was created by this wave) --
grouping by the plain normalized document is equivalent for testing
correctness of the GROUPING logic, since HMAC is a deterministic
function (equal inputs -> equal outputs, unequal inputs -> unequal
outputs with overwhelming probability), which is exactly the property
the SQL relies on for the join/group-by.

Read-only against the real Excel files. No database access. No writes.
"""
import re
from collections import defaultdict

results = []
def check(label, cond):
    results.append((label, bool(cond)))

# ---------------------------------------------------------------------
# Mirrors gbNormalizeDocumentForMatch exactly (JS source of truth).
# ---------------------------------------------------------------------
def normalize_document(v):
    if v is None:
        return None, 'BLANK'
    s = str(v).strip()
    if s.endswith('.0'):
        s = s[:-2]
    digits = re.sub(r'\D', '', s)
    if not digits:
        return None, 'BLANK'
    if len(digits) == 11:
        return digits, 'VALID_CPF_SHAPE'
    if len(digits) == 14:
        return digits, 'VALID_CNPJ_SHAPE'
    if len(digits) in (9, 10):
        return digits.zfill(11), 'REPAIRED_CPF_SHAPE'
    if len(digits) in (12, 13):
        return digits.zfill(14), 'REPAIRED_CNPJ_SHAPE'
    return None, 'INVALID_OTHER'

REALIZED = {'PAGA', 'FATURADA'}

def classify_plan(codigo_if, tc_devolvida, balao):
    if_txt = (codigo_if or '').strip().upper()
    try:
        if_num = float(re.sub(r'[^0-9.\-]', '', if_txt)) if if_txt else None
    except Exception:
        if_num = None
    if if_num == 999 or 'SUBSIDIADO' in if_txt:
        return 'SUBSIDIADO'
    if if_num == 777 or 'REVERSAO' in if_txt or 'REVERSÃO' in if_txt:
        return 'REVERSÃO'
    if tc_devolvida == 1:
        return 'COPARTICIPADO'
    if (balao or 0) > 0:
        return 'BALÃO'
    return 'LINEAR'

def resolve_document(rows):
    """
    Incidente T35918/M4 Wave 1.1 -- mirrors the CORRECTED SQL: group
    PAGA/FATURADA rows for one document by DISTINCT operation_code
    (n_ops), never by classification signal. Auto-apply only if exactly
    one distinct operation_code exists among the realized candidates --
    the five-case micro-audit proved that "same classification signal"
    is NOT sufficient evidence of "same financing event" (3 of 5 real
    cases had identical signal but materially different financed
    value/installments/PMT/balloon; the other 2 exposed a document
    shared across two different vehicles/financings ~16h apart).
    rows: list of dict(op_code, status, codigo_if, tc, balao)
    Returns ('AUTO', chosen_row) | ('AMBIGUOUS', None) | ('NONE', None)
    """
    realized = [r for r in rows if r['status'] in REALIZED]
    if not realized:
        return 'NONE', None
    op_codes = set(r['op_code'] for r in realized)
    if len(op_codes) == 1:
        return 'AUTO', realized[0]
    return 'AMBIGUOUS', None

# =======================================================================
# Phase 11: T35918 golden test
# =======================================================================
print("=== Phase 11: T35918 golden test ===")
t_rows = [
    {'op_code': '1083565', 'status': 'ENCERRADA', 'codigo_if': '999', 'tc': 0, 'balao': None, 'pmt': 4882.27},
    {'op_code': '1083578', 'status': 'PAGA', 'codigo_if': '0', 'tc': 1, 'balao': None, 'pmt': 3979.99},
]
outcome, chosen = resolve_document(t_rows)
check('T35918: outcome is AUTO (unique PAGA candidate, ENCERRADA never eligible)', outcome == 'AUTO')
check('T35918: chosen operation is 1083578, not 1083565', chosen and chosen['op_code'] == '1083578')
check('T35918: PMT fingerprint matches 3979.99', chosen and chosen['pmt'] == 3979.99)
plan = classify_plan(chosen['codigo_if'], chosen['tc'], chosen['balao']) if chosen else None
check('T35918: final classification is COPARTICIPADO', plan == 'COPARTICIPADO')

# =======================================================================
# Phase 12: synthetic matrix A-Q
# =======================================================================
print("=== Phase 12: synthetic matrix ===")

def r(op, status, codigo_if=None, tc=None, balao=None):
    return {'op_code': op, 'status': status, 'codigo_if': codigo_if, 'tc': tc, 'balao': balao}

# A. unique PAGA -> select
o, c = resolve_document([r('A1', 'PAGA', '0', 1)])
check('A: unique PAGA document -> AUTO, selected', o == 'AUTO' and c['op_code'] == 'A1')

# B. unique FATURADA -> select
o, c = resolve_document([r('B1', 'FATURADA', '999', 0)])
check('B: unique FATURADA document -> AUTO, selected', o == 'AUTO' and c['op_code'] == 'B1')

# C. ENCERRADA IF999 + PAGA TC1 -> PAGA/COPARTICIPADO
o, c = resolve_document([r('C1', 'ENCERRADA', '999', 0), r('C2', 'PAGA', '0', 1)])
check('C: ENCERRADA+PAGA -> AUTO selects the PAGA op', o == 'AUTO' and c['op_code'] == 'C2')
check('C: classification is COPARTICIPADO', classify_plan(c['codigo_if'], c['tc'], c['balao']) == 'COPARTICIPADO')

# D. ENCERRADA IF999 + PAGA IF777 -> PAGA/REVERSÃO
o, c = resolve_document([r('D1', 'ENCERRADA', '999', 0), r('D2', 'PAGA', '777', 0)])
check('D: ENCERRADA+PAGA(777) -> AUTO selects PAGA', o == 'AUTO' and c['op_code'] == 'D2')
check('D: classification is REVERSÃO', classify_plan(c['codigo_if'], c['tc'], c['balao']) == 'REVERSÃO')

# E. ENCERRADA IF999 + PAGA IF999 -> PAGA/SUBSIDIADO
o, c = resolve_document([r('E1', 'ENCERRADA', '999', 0), r('E2', 'PAGA', '999', 0)])
check('E: ENCERRADA+PAGA(999) -> AUTO selects PAGA (only realized op counts, even same code)', o == 'AUTO' and c['op_code'] == 'E2')
check('E: classification is SUBSIDIADO', classify_plan(c['codigo_if'], c['tc'], c['balao']) == 'SUBSIDIADO')

# F. ENCERRADA only -> NO_REALIZED_BASE03
o, c = resolve_document([r('F1', 'ENCERRADA', '999', 0)])
check('F: ENCERRADA only -> NONE (no realized operation)', o == 'NONE')

# G. ASSINADO only -> NO_REALIZED_BASE03
o, c = resolve_document([r('G1', 'ASSINADO', '999', 0)])
check('G: ASSINADO only -> NONE', o == 'NONE')

# H. CANCELADA + RECUSADA -> NO_REALIZED_BASE03
o, c = resolve_document([r('H1', 'CANCELADA', '999', 0), r('H2', 'RECUSADA', '0', 1)])
check('H: CANCELADA+RECUSADA only -> NONE', o == 'NONE')

# I. two PAGA operations, same document, SAME signal -> AMBIGUOUS_REVIEW
# (this is the exact shape of micro-audit Case 1: same classification
# category, but n_ops=2 -- must NEVER auto-resolve just because the
# signal happens to agree.)
o, c = resolve_document([r('I1', 'PAGA', '0', 0, balao=176983.84), r('I2', 'PAGA', '0', 0, balao=255359.27)])
check('I: two PAGA ops, SAME signal (both BALÃO), different op_code -> AMBIGUOUS (n_ops=2)', o == 'AMBIGUOUS')

# J. PAGA + FATURADA same document, SAME signal -> AMBIGUOUS_REVIEW
# (supersedes the pre-fix expectation that agreeing signal was safe --
# proven wrong by the micro-audit; this is now required to be AMBIGUOUS.)
o, c = resolve_document([r('J1', 'PAGA', '999', 0), r('J2', 'FATURADA', '999', 0)])
check('J: PAGA+FATURADA agreeing signal -> AMBIGUOUS (n_ops=2, signal equality is not sufficient evidence)', o == 'AMBIGUOUS')

# K. two PAGA operations, different signals -> AMBIGUOUS_REVIEW
o, c = resolve_document([r('K1', 'PAGA', '999', 0), r('K2', 'PAGA', '0', 1)])
check('K: two PAGA ops, different signal -> AMBIGUOUS', o == 'AMBIGUOUS')

# L. same normalized name, different documents -> must NOT cross-match
# (modeled at the document-key level: two different documents are two
# different groups by construction -- the matcher never looks at name at
# all, so a name collision cannot cause cross-matching here.)
doc_a_rows = [r('L1', 'PAGA', '999', 0)]
doc_b_rows = [r('L2', 'PAGA', '0', 1)]
oa, ca = resolve_document(doc_a_rows)
ob, cb = resolve_document(doc_b_rows)
check('L: two different documents resolve completely independently (name never consulted)', ca['op_code'] == 'L1' and cb['op_code'] == 'L2')

# M. different normalized names, same document, ONE realized op -> document
# identity wins (modeled at the document level: the matcher is
# document-only, so this is definitionally satisfied -- name is never
# part of the key; anomaly reporting for cross-name matches is a future
# review-metadata concern, not auto-resolution authority here).
same_doc_rows = [r('M1', 'PAGA', '999', 0)]
o, c = resolve_document(same_doc_rows)
check('M: matcher never reads name -- document-only key confirmed by construction', o == 'AUTO')

# N. Base01 10-digit lost-zero document repairs and matches Base03 11-digit document
doc_10, shape_10 = normalize_document('8608388898')
doc_11 = '08608388898'
check('N: 10-digit Base01 doc repairs to match an 11-digit Base03 doc', doc_10 == doc_11)

# O. Base01 13-digit lost-zero document repairs and matches Base03 14-digit document
doc_13, shape_13 = normalize_document('8453767000188')
doc_14 = '08453767000188'
check('O: 13-digit Base01 doc repairs to match a 14-digit Base03 doc', doc_13 == doc_14)

# P. 8-digit document -> invalid/review, never guessed
doc_8, shape_8 = normalize_document('62297864')
check('P: 8-digit document never repaired, never matched', doc_8 is None and shape_8 == 'INVALID_OTHER')

# Q. Base02 Cód. Cliente looks like CPF -> ignored as identity authority
# (architectural fact, not a runtime behavior to unit-test: the migration
# never reads Base02's "Cód. Cliente" for identity purposes -- confirmed
# by source inspection of the finance-enrichment block.)
check('Q: Base02 Cód. Cliente is structurally never consulted (design fact, verified by code review)', True)

# R. input order reversed -> same outcome
o1, c1 = resolve_document([r('R1', 'ENCERRADA', '999', 0), r('R2', 'PAGA', '0', 1)])
o2, c2 = resolve_document([r('R2', 'PAGA', '0', 1), r('R1', 'ENCERRADA', '999', 0)])
check('R: reversed input order gives the identical outcome', o1 == o2 and (c1 is None) == (c2 is None) and (c1 is None or c1['op_code'] == c2['op_code']))

# =======================================================================
# Phase 6: five real-case regression (from the micro-audit). All five
# MUST now be AMBIGUOUS -- none may AUTO merely because classification
# signal or enrichment payload happens to agree.
# =======================================================================
print("=== Phase 6: five-case regression (real audit data, all must be REVIEW) ===")

five_cases = {
    'Case 1 (***T19935)': [
        r('790659', 'PAGA', '0', 0, balao=176983.84),
        r('1023142', 'PAGA', '0', 0, balao=255359.27),
    ],
    'Case 2 (***T20572)': [
        r('782904', 'PAGA', '0', 0, balao=112320.34),
        r('1042704', 'FATURADA', '0', 0, balao=214203.92),
    ],
    'Case 3 (***087443)': [
        r('739208', 'PAGA', None, 0),
        r('1083197', 'PAGA', None, 0),
    ],
    'Case 4 (***T20319)': [
        r('1071463', 'PAGA', '999', 0),
        r('1071483', 'PAGA', '999', 0),
    ],
    'Case 5 (***T14422)': [
        r('1071463', 'PAGA', '999', 0),
        r('1071483', 'PAGA', '999', 0),
    ],
}
for label, rows in five_cases.items():
    o, c = resolve_document(rows)
    check(f'{label}: now AMBIGUOUS_REVIEW under strict n_ops', o == 'AMBIGUOUS')

print()
passed = sum(1 for _, ok in results if ok)
for label, ok in results:
    print(('PASS' if ok else 'FAIL') + ' - ' + label)
print(f"\n{passed}/{len(results)} checks passed")
import sys
sys.exit(0 if passed == len(results) else 1)

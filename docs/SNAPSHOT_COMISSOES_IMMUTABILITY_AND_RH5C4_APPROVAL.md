# snapshot_comissoes immutability hardening + RH-5C.4 Human UAT approval

Wave RH-5D. No employee names, CPF, or payroll values are recorded in
this document — store + profile + department only, per this wave's own
privacy instruction. See individual migrations under
`supabase/migrations/` for full technical detail.

## RH-5C.4 Human UAT approval (RH5C4_HUMAN_APPROVED)

The Human visually reviewed the corrected commission-closing preview
screen (Painel Master → Fechamento de Competência) and confirmed, via a
real screenshot of the live UAT session, that:

- Separate GERENTE NOVOS and GERENTE SEMINOVOS rows are now rendered
  for the manager profile at both target stores (ANALIA FRANCO and
  BANDEIRANTES), where before the RH-5C.3 fix these were contaminated
  into a single combined bucket (the SEMINOVOS_MANAGER_BUCKETING_INCIDENT,
  see `docs/` forensic record and `tests/rh5c2_seminovos_novos_bucketing_incident_test.js`).
- The values shown for each store/profile/department combination were
  visually coherent with what the Human expected for those stores.

This is recorded as **RH5C4_HUMAN_APPROVED** and, together with the
RH-5C.3 SQL/JS fix already applied live, as
**RH5C3_EXACT_MANAGER_BUCKET_HUMAN_CONFIRMED**. This is Human evidence
and is not reinterpreted or replaced here.

## snapshot_comissoes DB-level immutability hardening (RH-5D)

**Debt closed:** `SNAPSHOT_COMISSOES_NOT_DB_IMMUTABLE`.

Live forensics (reconfirmed from scratch this wave) found the table was
already effectively unreachable for ordinary client roles
(`authenticated`/`anon` hold zero direct grants; all real access goes
through `SECURITY DEFINER` RPCs), and that the entire real writer
surface is exactly one INSERT path
(`master_close_commission_period`) — no UPDATE/DELETE/TRUNCATE existed
anywhere in the codebase or live function bodies. The remaining gap was
that RLS and grants do not bind the table owner or `service_role`
(Postgres bypasses RLS for both by design, and a `SECURITY DEFINER`
function runs with the owner's privileges), so nothing at the database
level actually prevented a privileged mutation.

Migration
`supabase/migrations/20260909120000_rh5d_snapshot_comissoes_immutability.sql`
adds a `BEFORE UPDATE / BEFORE DELETE / BEFORE TRUNCATE` trigger on
`snapshot_comissoes` that unconditionally rejects the operation
(`SNAPSHOT_COMISSOES_IMMUTABLE`, SQLSTATE `0A000`), for every role,
including the table owner. `INSERT` and `SELECT` are untouched. No RLS
policy, grant, or existing function was modified.

`master_reopen_commission_period` (Reabrir Competência) was inspected
and confirmed to never touch `snapshot_comissoes` — it only updates
`fechamentos_comissao.status/ativo` and `periodos_comissao.status`. A
subsequent re-close inserts a brand-new `fechamento_id`/`versao` with a
brand-new set of snapshot rows; the original snapshot rows are never
mutated. Reopen is fully compatible with this hardening.

Proven live, via `BEGIN...ROLLBACK`-scoped statements only (zero
persistent business-data change; see
`tests/rh5d_snapshot_comissoes_immutability_test.js`, 18/18):
UPDATE/DELETE/TRUNCATE against a real historical row are rejected even
for the privileged role that applied the migration; the canonical
closing RPC still succeeds end-to-end against the real current open
period using synthetic row data.

**Known related debt (not fixed this wave, out of RH-5D's scope):**
`snapshot_operational_detail` was found to share the identical gap
(RLS/grants only, no trigger) — it was reconfirmed, not weakened, and
left untouched per this wave's explicit table-scoping. A future wave
should apply the same trigger pattern there.

## RH-5C.4B preview row-limit — resolved (Gate 21)

The temporary UAT-only 40→500 row-limit change and its on-screen "UAT
LOCAL" marker have been resolved per Option A: the bounded 500-row
limit is kept as a permanent product correction (the prior 40-row
slice was a real bug — it silently hid GERENTE/ANALISTA/GESTOR F&I rows
whenever a period had more than 40 sellers, since VENDEDOR rows are
appended first), and the UAT-only marker/comment has been removed from
`assets/js/portal-app.js`. No silent truncation was reintroduced.

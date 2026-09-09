-- RH-5D -- SNAPSHOT_COMISSOES_NOT_DB_IMMUTABLE hardening.
--
-- Live forensics (this wave, reconfirmed from scratch -- the prior wave's
-- note of an existing "legacy UPDATE policy" did NOT hold on
-- re-inspection):
--   * RLS is enabled but NOT forced (relforcerowsecurity=false) -- the
--     table owner (postgres) and service_role bypass RLS entirely, by
--     Postgres design, regardless of any policy.
--   * Exactly 2 RLS policies exist: INSERT (MASTER-only) and SELECT
--     (owner-or-MASTER). No UPDATE or DELETE policy exists.
--   * `authenticated`/`anon` hold zero direct grants on this table --
--     all real access already flows through SECURITY DEFINER RPCs.
--   * Exactly 3 functions reference snapshot_comissoes, all SECURITY
--     DEFINER: master_close_commission_period (the ONLY writer -- a
--     single INSERT ... SELECT FROM jsonb_to_recordset, no UPDATE/
--     DELETE/TRUNCATE against this table anywhere in its body),
--     master_commission_snapshot and master_commission_snapshot_export
--     (both STABLE, SELECT-only).
--   * master_reopen_commission_period (Reabrir Competencia) does NOT
--     touch snapshot_comissoes at all -- it only flips
--     fechamentos_comissao.status/ativo and periodos_comissao.status,
--     plus an audit row. A subsequent re-close inserts a brand new
--     fechamento_id/versao and a brand new set of snapshot rows; the
--     original snapshot rows are never mutated or removed. Reopen is
--     therefore fully compatible with a strict append-only invariant --
--     no RH5D_REOPEN_SEMANTICS_CONFLICT_WITH_IMMUTABILITY.
--
-- Gap being closed: RLS/grants alone are NOT a real invariant against
-- the table owner or service_role (both bypass RLS by construction, and
-- a SECURITY DEFINER function runs with the owner's privileges). A
-- genuine database-level trigger is the smallest mechanism that holds
-- regardless of role, RLS bypass, or which code path is used to reach
-- the table. INSERT and SELECT are completely untouched by this
-- migration -- only UPDATE/DELETE/TRUNCATE are denied, unconditionally,
-- for every role including postgres/service_role.
--
-- Reversible only by a deliberate future migration that explicitly
-- drops these triggers -- never by weakening this transaction.

create or replace function public._snapshot_comissoes_immutable_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'SNAPSHOT_COMISSOES_IMMUTABLE: snapshot_comissoes e um snapshot historico append-only; UPDATE/DELETE/TRUNCATE nao sao permitidos apos a criacao da linha.'
    using errcode = '0A000';
end;
$$;

drop trigger if exists snapshot_comissoes_no_update on public.snapshot_comissoes;
create trigger snapshot_comissoes_no_update
  before update on public.snapshot_comissoes
  for each row execute function public._snapshot_comissoes_immutable_guard();

drop trigger if exists snapshot_comissoes_no_delete on public.snapshot_comissoes;
create trigger snapshot_comissoes_no_delete
  before delete on public.snapshot_comissoes
  for each row execute function public._snapshot_comissoes_immutable_guard();

drop trigger if exists snapshot_comissoes_no_truncate on public.snapshot_comissoes;
create trigger snapshot_comissoes_no_truncate
  before truncate on public.snapshot_comissoes
  for each statement execute function public._snapshot_comissoes_immutable_guard();

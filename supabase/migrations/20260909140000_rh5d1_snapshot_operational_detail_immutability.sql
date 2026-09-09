-- RH-5D.1 -- SNAPSHOT_OPERATIONAL_DETAIL_NOT_DB_IMMUTABLE parity hardening.
--
-- Live forensics (this wave, reconfirmed from scratch): snapshot_operational_detail
-- has the exact same pre-hardening shape RH-5D found (and fixed) for
-- snapshot_comissoes:
--   * relrowsecurity=true, relforcerowsecurity=false -- table owner and
--     service_role bypass RLS entirely.
--   * Exactly 2 RLS policies: sod_insert_master (INSERT, MASTER-only)
--     and sod_select_master (SELECT, MASTER-only). No UPDATE/DELETE
--     policy exists.
--   * authenticated/anon hold zero direct grants (revoked explicitly
--     at table creation, PM-6D.1) -- all real access flows through
--     SECURITY DEFINER RPCs.
--   * Exactly 2 functions reference this table, both SECURITY DEFINER:
--     master_close_commission_period (writer -- two INSERT ... SELECT
--     blocks, one per detail kind: CHASSIS and SPF, each followed only
--     by a row-count integrity check, never an UPDATE/DELETE/TRUNCATE)
--     and master_commission_operational_detail (STABLE, SELECT-only).
--   * master_reopen_commission_period (Reabrir Competencia) does not
--     reference this table at all -- confirmed by its full body (RH-5D).
--   * No UPDATE/DELETE/TRUNCATE statement against this table exists
--     anywhere in the migration history (pm6d1/pm6d2) or in any live
--     function body.
--
-- Same gap, same fix: RLS/grants do not bind the table owner/
-- service_role, and a SECURITY DEFINER function runs with the owner's
-- privileges. A genuine trigger is the smallest mechanism that holds
-- regardless of role. INSERT and SELECT are untouched.
--
-- snapshot_comissoes's own RH-5D trigger/migration is NOT modified by
-- this file.

create or replace function public._snapshot_operational_detail_immutable_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'SNAPSHOT_OPERATIONAL_DETAIL_IMMUTABLE: snapshot_operational_detail e um snapshot historico append-only; UPDATE/DELETE/TRUNCATE nao sao permitidos apos a criacao da linha.'
    using errcode = '0A000';
end;
$$;

drop trigger if exists snapshot_operational_detail_no_update on public.snapshot_operational_detail;
create trigger snapshot_operational_detail_no_update
  before update on public.snapshot_operational_detail
  for each row execute function public._snapshot_operational_detail_immutable_guard();

drop trigger if exists snapshot_operational_detail_no_delete on public.snapshot_operational_detail;
create trigger snapshot_operational_detail_no_delete
  before delete on public.snapshot_operational_detail
  for each row execute function public._snapshot_operational_detail_immutable_guard();

drop trigger if exists snapshot_operational_detail_no_truncate on public.snapshot_operational_detail;
create trigger snapshot_operational_detail_no_truncate
  before truncate on public.snapshot_operational_detail
  for each statement execute function public._snapshot_operational_detail_immutable_guard();

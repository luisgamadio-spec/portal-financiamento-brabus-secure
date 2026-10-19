-- Desfaz a FASE 2 da Base 03 (a apply_base03 nunca foi alterada).
drop function if exists public.master_operational_base03_consolidar(uuid, jsonb);

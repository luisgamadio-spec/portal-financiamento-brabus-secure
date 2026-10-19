-- Desfaz a FASE 3 (banco). Os lotes que estiverem ARQUIVADO voltam a VALIDATING antes de recolocar a regra antiga.
drop function if exists public.master_operational_list_duracoes(integer);
drop function if exists public.master_operational_registrar_duracao(jsonb);
drop table if exists public.portal_import_duracoes;
CREATE OR REPLACE FUNCTION public.master_operational_begin_import(p_source_type text, p_original_filename text, p_source_sha256 text, p_rows_read integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_batch_id uuid;
  v_source_type text := upper(trim(coalesce(p_source_type, '')));
  v_sha text := lower(trim(coalesce(p_source_sha256, '')));
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if v_source_type not in (
    'COLABORADORES', 'SALES_CURRENT', 'SALES_HISTORY',
    'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT'
  ) then
    raise exception 'Tipo de fonte inválido.' using errcode = '22023';
  end if;
  if trim(coalesce(p_original_filename, '')) = ''
     or v_sha !~ '^[a-f0-9]{64}$'
     or coalesce(p_rows_read, -1) < 0 then
    raise exception 'Metadados de lote inválidos.' using errcode = '22023';
  end if;

  select b.id
    into v_batch_id
    from public.portal_import_batches b
   where b.source_type = v_source_type
     and b.source_sha256 = v_sha
   for update;

  if v_batch_id is null then
    insert into public.portal_import_batches (
      source_type, original_filename, source_sha256, rows_read,
      status, imported_by, completed_at
    )
    values (
      v_source_type, trim(p_original_filename), v_sha, p_rows_read,
      'VALIDATING', auth.uid(), null
    )
    returning id into v_batch_id;
  else
    update public.portal_import_batches
       set original_filename = trim(p_original_filename),
           rows_read = p_rows_read,
           status = 'VALIDATING',
           completed_at = null
     where id = v_batch_id
       and imported_by = auth.uid();

    if not found then
      raise exception 'Lote existente pertence a outro responsável.'
        using errcode = '42501';
    end if;
  end if;

  return v_batch_id;
end;
$function$;
update public.portal_import_batches set status = 'VALIDATING' where status = 'ARQUIVADO';
alter table public.portal_import_batches drop column if exists ultima_atividade_em;
alter table public.portal_import_batches drop constraint portal_import_batches_status_check;
alter table public.portal_import_batches add constraint portal_import_batches_status_check
  check (status = any (array['VALIDATING', 'VALIDATED', 'IMPORTED', 'REJECTED', 'ROLLED_BACK']));

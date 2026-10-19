"""Gera a FASE 2 da Base 03 (nada é aplicado aqui): master_operational_base03_consolidar(p_spf_batch_id, p_finance_rows).
O SPF já foi gravado em partes (begin_import + import_spf, lote VALIDATING, invisível); esta função faz, numa transação só,
o enriquecimento dos financiamentos (trecho COPIADO da apply_base03 publicada), as travas e a confirmação do lote SPF.
A apply_base03 atual continua existindo, intacta (a tela atual da produção segue usando ela até a tela nova ir ao ar)."""
import os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
from rpc import sql
ap = sql("select pg_get_functiondef('public.master_operational_apply_base03'::regproc) d")[0]["d"]
# trecho do enriquecimento: da busca da Base 02 oficial até o UPDATE (inclusive), sem o ramo de dry run
ini = ap.index("  select b.id into v_finance_batch_id")
dry_ini = ap.index("  if p_dry_run then"); dry_fim = ap.index("  end if;", dry_ini) + len("  end if;")
fim = ap.index("  select count(*) into v_finance_matched from updated;") + len("  select count(*) into v_finance_matched from updated;")
enriquecimento = ap[ini:dry_ini] + ap[dry_fim:fim]
assert "p_dry_run" not in enriquecimento and "update public.portal_finance_operations f" in enriquecimento
corpo = f"""create or replace function public.master_operational_base03_consolidar(p_spf_batch_id uuid, p_finance_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
-- FASE 2 (19/10/2026): consolidação final da Base 03. O SPF já foi gravado em partes num lote VALIDATING
-- (begin_import + import_spf); aqui, numa transação só: enriquecimento dos financiamentos (mesmo código da
-- apply_base03), travas e confirmação do lote. Se algo falhar, nada muda (Base 03 e financiamentos anteriores ficam).
declare
  v_finance_batch_id uuid;
  v_finance_matched integer := 0;
  v_finance_ambiguous integer := 0;
  v_finance_rows_count integer;
  v_spf_rows_read integer;
  v_spf_accepted integer;
  v_spf_principal_accepted integer;
  v_ultima_normal integer;
  v_max_rows constant integer := 10000;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_finance_rows) <> 'array' then
    raise exception 'Payload inválido: finance_rows deve ser um array.' using errcode = '22023';
  end if;
  v_finance_rows_count := jsonb_array_length(p_finance_rows);
  if v_finance_rows_count > v_max_rows then
    raise exception 'Lote da Base 03 excede o limite de % linhas.', v_max_rows using errcode = '22023';
  end if;

  -- o lote SPF tem de ser deste usuário, estar em validação e já ter recebido as partes
  select b.rows_read into v_spf_rows_read
  from public.portal_import_batches b
  where b.id = p_spf_batch_id and b.imported_by = auth.uid() and b.source_type = 'SPF_CURRENT' and b.status = 'VALIDATING'
  for update;
  if v_spf_rows_read is null then
    raise exception 'Lote SPF inválido ou já confirmado.' using errcode = '42501';
  end if;
  select count(*), count(*) filter (where is_spf_extra = false) into v_spf_accepted, v_spf_principal_accepted
  from public.portal_spf_operations where batch_id = p_spf_batch_id;
  if v_spf_principal_accepted = 0 then
    raise exception 'Lote SPF_CURRENT rejeitado: % linha(s) recebida(s), % aceita(s), mas nenhuma é linha operacional principal (todas são SPF Extra). Isso indica que a Base 03 completa não foi enviada — apenas o subconjunto SPF Extra. Selecione o arquivo completo da Base 03 e tente novamente.',
      v_spf_rows_read, v_spf_accepted using errcode = '22023';
  end if;

{enriquecimento}

  -- Trava (incidente 07/10/2026), agora também no servidor: 0 financiamentos completados, ou menos da metade
  -- da última importação normal, desfaz tudo (mesma regra da tela).
  select substring(b.validation_message from '([0-9]+) linhas financeiras enriquecidas')::int into v_ultima_normal
  from public.portal_import_batches b
  where b.source_type = 'SPF_CURRENT' and b.status = 'VALIDATED'
    and substring(b.validation_message from '([0-9]+) linhas financeiras enriquecidas')::int > 0
  order by b.completed_at desc nulls last, b.created_at desc limit 1;
  if v_finance_matched = 0 or (v_ultima_normal is not null and v_finance_matched < v_ultima_normal * 0.5) then
    raise exception 'IMPORTAÇÃO BLOQUEADA: a Base 03 completaria % financiamento(s) (última importação normal: %). Confira se a Base 01 e a Base 02 foram atualizadas antes, com os arquivos do mesmo dia.',
      v_finance_matched, coalesce(v_ultima_normal::text, '—') using errcode = '22023';
  end if;

  perform public.master_operational_finalize_import(
    p_spf_batch_id, v_spf_accepted, v_spf_rows_read - v_spf_accepted,
    format(
      'Gestão de Bases (Base 03 atômica, identidade por documento): %s SPF aceitas (%s principais + %s SPF Extra), %s rejeitadas; %s linhas financeiras enriquecidas; %s documentos ambíguos (múltiplas operações PAGA/FATURADA) deixados de fora do enriquecimento automático.',
      v_spf_accepted, v_spf_principal_accepted, v_spf_accepted - v_spf_principal_accepted, v_spf_rows_read - v_spf_accepted, v_finance_matched, v_finance_ambiguous
    )
  );

  return jsonb_build_object(
    'dry_run', false,
    'finance_batch_id', v_finance_batch_id,
    'finance_rows_matched', v_finance_matched,
    'finance_rows_ambiguous_excluded', v_finance_ambiguous,
    'spf_batch_id', p_spf_batch_id,
    'spf_rows_received', v_spf_rows_read,
    'spf_accepted', v_spf_accepted,
    'spf_principal_accepted', v_spf_principal_accepted,
    'spf_rejected', v_spf_rows_read - v_spf_accepted
  );
end;
$function$;

revoke all on function public.master_operational_base03_consolidar(uuid, jsonb) from public, anon;
grant execute on function public.master_operational_base03_consolidar(uuid, jsonb) to authenticated;
"""
open(os.path.join(AQUI, "fase2_b03.sql"), "w", encoding="utf-8", newline="\n").write(
    "-- FASE 2 da importação (19/10/2026): Base 03 em partes + consolidação final rápida e atômica.\n-- Desfazer: drop function public.master_operational_base03_consolidar(uuid, jsonb);\n\n" + corpo)
open(os.path.join(AQUI, "fase2_b03_rollback.sql"), "w", encoding="utf-8", newline="\n").write(
    "-- Desfaz a FASE 2 da Base 03 (a apply_base03 nunca foi alterada).\ndrop function if exists public.master_operational_base03_consolidar(uuid, jsonb);\n")
print("ok", len(corpo.splitlines()), "linhas")

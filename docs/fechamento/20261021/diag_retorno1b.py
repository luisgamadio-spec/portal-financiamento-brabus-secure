"""Retorno 1,00 (cont.): como a importação grava return_value; os 15 do período têm o retorno real em outro lançamento? Só leitura."""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
LOTE = "(select id from public.portal_import_batches where source_type='FINANCE_CURRENT' and status='VALIDATED' order by completed_at desc nulls last, created_at desc limit 1)"
fs = sql("select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and pg_get_functiondef(p.oid) ~ 'insert into public.portal_finance_operations'")
for f in fs:
    d = f["d"].replace("\r", "")
    for m in re.finditer(r"return_value", d):
        t = " ".join(d[max(0, m.start() - 200):m.start() + 160].split())
        if "::" in t or "coalesce" in t or "nullif" in t: print(f["proname"], "::", t); print()
print("15 contratos do período com retorno 1,00 — o mesmo chassi tem outro lançamento com retorno real (qualquer data)?", sql(f"""
  with um as (select id, chassis, operation_date from public.portal_finance_operations where batch_id = {LOTE} and return_value = 1 and (is_real_financing or is_later_return)
     and operation_date between '2026-09-22' and '2026-10-20' and nullif(trim(chassis),'') is not null)
  select count(*) contratos,
    count(*) filter (where exists (select 1 from public.portal_finance_operations f where f.batch_id = {LOTE} and f.chassis = um.chassis and f.id <> um.id and f.return_value > 1)) com_retorno_real_em_outro_lancamento,
    count(*) filter (where exists (select 1 from public.portal_finance_operations f where f.batch_id = {LOTE} and f.chassis = um.chassis and f.id <> um.id and f.return_value > 1 and f.operation_date > um.operation_date)) posterior,
    count(*) filter (where exists (select 1 from public.portal_finance_operations f where f.batch_id = {LOTE} and f.chassis = um.chassis and f.id <> um.id and f.return_value > 1 and f.operation_date between '2026-09-22' and '2026-10-20' and (f.is_real_financing or f.is_later_return))) real_no_periodo_que_conta
  from um"""))
print("tipos de lançamento dos 'outros' com valor real:", sql(f"""
  with um as (select id, chassis from public.portal_finance_operations where batch_id = {LOTE} and return_value = 1 and (is_real_financing or is_later_return) and nullif(trim(chassis),'') is not null)
  select coalesce(f.service_description,'') servico, f.is_real_financing real, f.is_later_return tardio, f.is_spf spf, count(*) n, round(avg(f.return_value)) media
  from um join public.portal_finance_operations f on f.batch_id = {LOTE} and f.chassis = um.chassis and f.id <> um.id and f.return_value > 1 group by 1,2,3,4 order by 5 desc"""))

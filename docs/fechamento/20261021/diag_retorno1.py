"""Retorno R$ 1,00 na Base 02: retorno real do banco ou marcador da importação NBS? Só leitura, só agregados."""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
LOTE = "(select id from public.portal_import_batches where source_type='FINANCE_CURRENT' and status='VALIDATED' order by completed_at desc nulls last, created_at desc limit 1)"
print("1) faixas de retorno no lote oficial (financiamento real):")
for r in sql(f"""select case when return_value is null then 'nulo' when return_value = 0 then '0' when return_value < 1 then '0,01–0,99' when return_value = 1 then 'exatamente 1,00'
   when return_value < 10 then '1,01–9,99' when return_value < 100 then '10–99,99' when return_value < 500 then '100–499,99' else '500 ou mais' end faixa, count(*) n
   from public.portal_finance_operations where batch_id = {LOTE} and is_real_financing group by 1 order by min(coalesce(return_value, -1))"""): print("   ", r)
print("2) valores 'redondos' baixos (2, 3, 5, 10) para comparar com o 1,00:", sql(f"select return_value::text v, count(*) n from public.portal_finance_operations where batch_id = {LOTE} and return_value in (2,3,5,10) group by 1 order by 1"))
print("3) contratos com retorno 1,00: o mesmo chassi tem outro lançamento de retorno com valor real?", sql(f"""
  with um as (select chassis, operation_date from public.portal_finance_operations where batch_id = {LOTE} and return_value = 1 and is_real_financing and nullif(trim(chassis),'') is not null)
  select count(*) contratos, count(*) filter (where exists (select 1 from public.portal_finance_operations f where f.batch_id = {LOTE} and f.chassis = um.chassis and f.return_value > 1)) com_outro_retorno_real
  from um"""))
print("4) mudou entre importações? mesmo chassi+data com retorno 1,00 num lote e outro valor em lote posterior:", sql(f"""
  with lotes as (select id, created_at from public.portal_import_batches where source_type = 'FINANCE_CURRENT' and status in ('VALIDATED','ROLLED_BACK','ARQUIVADO')),
  x as (select f.chassis, f.operation_date, f.return_value, l.created_at from public.portal_finance_operations f join lotes l on l.id = f.batch_id
        where f.is_real_financing and nullif(trim(f.chassis),'') is not null)
  select count(distinct (a.chassis, a.operation_date)) eram_1_depois_outro_valor,
         count(distinct (a.chassis, a.operation_date)) filter (where b.return_value > 1) depois_valor_real
  from x a join x b on b.chassis = a.chassis and b.operation_date = a.operation_date and b.created_at > a.created_at
  where a.return_value = 1 and b.return_value <> 1"""))
print("5) o inverso (tinha valor real e passou a 1,00):", sql(f"""
  with lotes as (select id, created_at from public.portal_import_batches where source_type = 'FINANCE_CURRENT' and status in ('VALIDATED','ROLLED_BACK','ARQUIVADO')),
  x as (select f.chassis, f.operation_date, f.return_value, l.created_at from public.portal_finance_operations f join lotes l on l.id = f.batch_id
        where f.is_real_financing and nullif(trim(f.chassis),'') is not null)
  select count(distinct (a.chassis, a.operation_date)) n from x a join x b on b.chassis = a.chassis and b.operation_date = a.operation_date and b.created_at > a.created_at
  where a.return_value > 1 and b.return_value = 1"""))
print("6) retorno 1,00 por plano no lote oficial (todo o histórico):")
for r in sql(f"""select coalesce(nullif(finance_code,''),'(vazio)') plano, count(*) n, count(*) filter (where return_value = 1) com_1,
   round(100.0 * count(*) filter (where return_value = 1) / count(*), 1) pct_com_1
   from public.portal_finance_operations where batch_id = {LOTE} and is_real_financing
   and finance_code in (select distinct finance_code from public.portal_finance_operations where batch_id = {LOTE} and return_value = 1 and is_real_financing)
   group by 1 order by 3 desc"""): print("   ", r)
d = sql("select pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname = 'import_finance'")[0]["d"].replace("\r", "")
for m in re.finditer(r"return_value", d): print("\n7) import_finance ::", " ".join(d[max(0, m.start() - 220):m.start() + 120].split()))

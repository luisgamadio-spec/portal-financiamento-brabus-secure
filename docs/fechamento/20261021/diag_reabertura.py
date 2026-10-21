"""Diagnóstico (só leitura) da reabertura/refechamento de 22/09–20/10 e dos indicadores do Resumo. Só agregados."""
import io, os, sys, json
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
V1, V2 = "56c80a93-9558-4230-9ca0-d6f01e13fae3", "b22983bf-19a7-4030-a79a-8cb98dcb9514"
print("== importações entre o 1º fechamento (14:19) e o 2º (16:10), horário de Brasília")
for r in sql("""select source_type, status, (created_at at time zone 'America/Sao_Paulo')::text criado, (completed_at at time zone 'America/Sao_Paulo')::text concluido
  from public.portal_import_batches where created_at between '2026-10-21 17:00+00' and '2026-10-21 19:15+00' order by created_at"""): print("  ", r)
print("== lotes oficiais usados por cada versão")
for r in sql(f"""select versao, (select source_type||' '||(created_at at time zone 'America/Sao_Paulo')::text from public.portal_import_batches where id = f.sales_batch_id) vendas,
  (select (created_at at time zone 'America/Sao_Paulo')::text from public.portal_import_batches where id = f.finance_batch_id) financ,
  (select (created_at at time zone 'America/Sao_Paulo')::text from public.portal_import_batches where id = f.spf_batch_id) spf
  from public.fechamentos_comissao f where f.id in ('{V1}','{V2}') order by versao"""): print("  ", r)
print("== sessões/logins da conta Master do Luis hoje (horário de Brasília)")
cols = [r["column_name"] for r in sql("select column_name from information_schema.columns where table_schema='public' and table_name='usuarios' and column_name ilike '%login%'")]
print("   colunas de login em usuarios:", cols)
tabs = [r["table_name"] for r in sql("select table_name from information_schema.tables where table_schema='public' and (table_name ilike '%login%' or table_name ilike '%acesso%' or table_name ilike '%sess%' or table_name ilike '%telemetr%')")]
print("   tabelas de acesso:", tabs)
print("== Resumo: o que está gravado (observacao) x soma por perfil no snapshot")
for fid, nome in ((V1, "v1"), (V2, "v2")):
    o = json.loads(sql(f"select observacao from public.fechamentos_comissao where id = '{fid}'")[0]["observacao"])
    print(f"   {nome} gravado: vendidas {o['qtd_vendida']} | financiadas {o['qtd_financiada']} | produção {round(float(o['producao_total']), 2)} | retorno {round(float(o['retorno_total']), 2)} | SPF {round(float(o['spf_total']), 2)} | comissão {o['comissao_total']}")
    for r in sql(f"""select upper(perfil) perfil, count(*) n, sum(vendidas) vend, sum(financiadas) fin, round(sum(producao), 2) prod, round(sum(retorno), 2) ret, round(sum(spf_extra), 2) spf
      from public.snapshot_comissoes where fechamento_id = '{fid}' group by 1 order by 1"""): print("      ", r)

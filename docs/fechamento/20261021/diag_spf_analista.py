"""Analistas: a quantidade de SPF (bônus R$ 150/unidade) conta os placeholders de R$ 1,00? E o SPF de 23/09 no fechamento anterior. Só leitura, agregados."""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
print("analistas neste fechamento:", sql(f"""select count(*) analistas, sum((detalhes->>'comissao_spf')::numeric) comissao_spf, sum((detalhes->>'comissao_spf')::numeric) / 150 unidades_pagas
  from public.snapshot_comissoes where fechamento_id = '{FID}' and upper(perfil) = 'ANALISTA'"""))
print("SPF na auditoria congelada: reais (≠ R$1) x placeholders, por loja:", sql(f"""select store, count(*) filter (where spf_bruto <> 1) reais, count(*) filter (where spf_bruto = 1) r1
  from public.snapshot_operational_detail where fechamento_id = '{FID}' and kind = 'SPF' group by 1 order by 1"""))
print("analista por loja: unidades pagas:", sql(f"""select loja, round((detalhes->>'comissao_spf')::numeric / 150, 2) unidades, spf_extra from public.snapshot_comissoes
  where fechamento_id = '{FID}' and upper(perfil) = 'ANALISTA' order by loja"""))
# qual função calcula o SPF do analista e se ela exclui optional_value = 1
for r in sql("select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('operational_analyst_commission_metrics_v2','_operational_commission_metrics_core','_operational_scope_commission_rows_core','operational_analyst_coverage_metrics')"):
    d = r["d"]; print(f"\n{r['proname']}: menciona spf_extra/optional_value: {'optional_value' in d} | exclui R$1 (optional_value <> 1): {'optional_value <> 1' in d}")
ant = sql("select id, fechado_em::text fe from public.fechamentos_comissao where data_inicio = '2026-08-21' and data_fim = '2026-09-21' and ativo")
if ant:
    a = ant[0]
    print("\nfechamento 21/08–21/09 (fechado em", a["fe"], "UTC): SPF congelado com data 23/09:",
          sql(f"select count(*) n, coalesce(sum(spf_bruto),0) v from public.snapshot_operational_detail where fechamento_id = '{a['id']}' and kind = 'SPF' and operation_date = '2026-09-23'"),
          "| placeholders R$1 no total:", sql(f"select count(*) filter (where spf_bruto = 1) r1, count(*) n from public.snapshot_operational_detail where fechamento_id = '{a['id']}' and kind = 'SPF'"),
          "| analistas unidades pagas:", sql(f"select sum((detalhes->>'comissao_spf')::numeric)/150 u from public.snapshot_comissoes where fechamento_id = '{a['id']}' and upper(perfil) = 'ANALISTA'"))
print("lote SPF de 23/09 criado em:", sql("select created_at::text c, completed_at::text f from public.portal_import_batches where source_type='SPF_CURRENT' and status='VALIDATED' and created_at::date = '2026-09-23'"))

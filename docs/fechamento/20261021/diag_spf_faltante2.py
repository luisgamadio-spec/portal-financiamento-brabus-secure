"""O SPF de 23/09 (financiamento 18/09) entrou no fechamento 21/08–20/09? Quando esse fechamento foi feito? Quanto vale? Só leitura."""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
ant = sql("select id, nome_periodo, versao, ativo, status, fechado_em::text fe, (select count(*) from public.snapshot_operational_detail d where d.fechamento_id = f.id) det "
          "from public.fechamentos_comissao f where data_inicio = '2026-08-21' and data_fim = '2026-09-20' order by versao")
print("fechamentos 21/08–20/09:", ant)
for f in ant:
    print(f"  v{f['versao']} ativo={f['ativo']} fechado_em={f['fe']}: SPF congelado com data 23/09:",
          sql(f"select count(*) n, coalesce(sum(spf_bruto),0) v from public.snapshot_operational_detail where fechamento_id = '{f['id']}' and kind = 'SPF' and operation_date = '2026-09-23'"))
# quando a linha SPF entrou na base (lote que a trouxe pela 1ª vez): data de criação dos lotes SPF que contêm uma linha igual
print("lotes SPF que têm a linha (mesma chave de cliente, data 23/09, opcional R$ 1):", sql("""
  with alvo as (select client_match_key from public.portal_spf_operations s join public.portal_import_batches b on b.id = s.batch_id
     where b.source_type = 'SPF_CURRENT' and b.status = 'VALIDATED' and s.is_spf_extra and s.operation_date = '2026-09-23' and s.optional_value = 1 limit 1)
  select b.created_at::date criado, b.status, count(*) n from public.portal_spf_operations s join public.portal_import_batches b on b.id = s.batch_id, alvo
  where s.client_match_key = alvo.client_match_key and s.is_spf_extra and s.operation_date = '2026-09-23' group by 1, 2 order by 1"""))
# como o cálculo da comissão conta SPF: valor e quantidade (bônus do analista por SPF)
c = sql("select pg_get_functiondef('public._operational_metrics_core'::regproc) d")[0]["d"].replace("\r", "")
for m in re.finditer(r"spf_linked as", c): print("\nmetrics spf_linked ::", " ".join(c[m.start():m.start() + 900].split()))
for m in re.finditer(r"spf_qty|spf_count", c):
    print("\nmetrics qtd ::", " ".join(c[max(0, m.start() - 250):m.start() + 120].split())); break

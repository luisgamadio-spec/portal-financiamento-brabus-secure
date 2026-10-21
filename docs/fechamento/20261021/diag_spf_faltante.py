"""Qual SPF extra do período (base: 28) não entrou na auditoria/fechamento (27), e por quê. Só leitura.
No chat só sai o que não identifica pessoa; nomes vão para saida/spf_faltante_detalhe.txt (arquivo local)."""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
CTE = """
with lb as (select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
  where b.status = 'VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY','SPF_CURRENT')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
es as (select u.id, u.nome as name, u.loja as store, u.status from public.usuarios u where upper(trim(coalesce(u.perfil,''))) = 'VENDEDOR'
  union all select ps.id, ps.name, ps.store, ps.status from public.portal_sellers ps where ps.active and upper(trim(coalesce(ps.profile_type,''))) = 'VENDEDOR'
  and upper(trim(coalesce(ps.status,''))) not in ('REVENDA','INATIVO','MASTER') and not exists (select 1 from public.usuarios u2 where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true)),
spf as (select s.* from public.portal_spf_operations s join lb on lb.id = s.batch_id and lb.source_type = 'SPF_CURRENT'
  where s.is_spf_extra and s.operation_date between '2026-09-22' and '2026-10-20'),
fin as (select f.*, lb.source_type from public.portal_finance_operations f join lb on lb.id = f.batch_id and lb.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY'))
"""
linhas = sql(CTE + """
select s.id spf_id, s.operation_date spf_data, s.store spf_loja, s.department spf_depto, s.optional_name opcional, s.optional_value valor,
  (select count(*) from fin f where f.client_match_key = s.client_match_key) fin_mesmo_cliente,
  (select count(*) from fin f where f.client_match_key = s.client_match_key and f.operation_date between '2026-09-22' and '2026-10-20') fin_no_periodo,
  (select string_agg(f.operation_date::text || ' ' || coalesce(f.service_description,'') || ' real=' || f.is_real_financing || ' tardio=' || f.is_later_return
     || ' loja=' || coalesce(f.store,'') || ' vendedor_ok=' || (exists (select 1 from es where es.id = coalesce(f.seller_user_id, f.seller_id)))::text, ' || ' order by f.operation_date)
   from fin f where f.client_match_key = s.client_match_key) fins,
  (select string_agg(distinct coalesce(f.seller_source_name, ''), ', ') from fin f where f.client_match_key = s.client_match_key) vendedor_na_base02,
  exists (select 1 from fin f join es on es.id = coalesce(f.seller_user_id, f.seller_id) where f.client_match_key = s.client_match_key
          and f.operation_date between '2026-09-22' and '2026-10-20' and upper(trim(coalesce(f.store,''))) <> 'REVENDA') entra_na_auditoria
from spf s order by s.operation_date""")
congelado = sql(f"select count(*) n, sum(spf_bruto) bruto from public.snapshot_operational_detail where fechamento_id = '{FID}' and kind = 'SPF'")[0]
fora = [l for l in linhas if not l["entra_na_auditoria"]]
print("SPF extra com data no período (base 03):", len(linhas), "| entram pela regra da auditoria:", len(linhas) - len(fora), "| congelados no fechamento:", congelado["n"])
for l in fora:
    print(f"\nFORA: data SPF {l['spf_data']} | loja {l['spf_loja']} / {l['spf_depto']} | opcional {l['opcional']} | valor R$ {l['valor']}")
    print(f"   financiamentos do mesmo cliente na Base 02: {l['fin_mesmo_cliente']} (no período: {l['fin_no_periodo']})")
    print("   ", (l["fins"] or "nenhum").replace(" || ", "\n    "))
# o inverso: SPF da auditoria com data FORA do período (entrou pelo financiamento no período)
inv = sql(CTE + """
select count(*) n from public.portal_spf_operations s join lb on lb.id = s.batch_id and lb.source_type = 'SPF_CURRENT'
where s.is_spf_extra and coalesce(s.optional_value,0) > 0 and s.operation_date not between '2026-09-22' and '2026-10-20'
  and exists (select 1 from fin f join es on es.id = coalesce(f.seller_user_id, f.seller_id) where f.client_match_key = s.client_match_key
              and f.operation_date between '2026-09-22' and '2026-10-20' and upper(trim(coalesce(f.store,''))) <> 'REVENDA')""")
print("\nSPF com data fora do período que entraram (financiamento no período):", inv[0]["n"])
with open(os.path.join(AQUI, "saida", "spf_faltante_detalhe.txt"), "w", encoding="utf-8") as h:
    for l in fora: h.write(json.dumps(l, ensure_ascii=False, default=str, indent=1) + "\n")

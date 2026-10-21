"""Auditoria SPF congelada x SPF que entrou na comissão (snapshot). Só leitura, só agregados."""
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
print("auditoria congelada (27):", sql(f"""select count(*) n, count(*) filter (where spf_bruto = 1) placeholders_r1, sum(spf_bruto) bruto, sum(spf_bruto) filter (where spf_bruto <> 1) bruto_sem_r1
  from public.snapshot_operational_detail where fechamento_id = '{FID}' and kind = 'SPF'"""))
print("snapshot (comissão) SPF extra por perfil:", sql(f"select perfil, sum(spf_extra) spf_extra, sum(spf_liquido) spf_liq from public.snapshot_comissoes where fechamento_id = '{FID}' group by 1 order by 1"))
print("por vendedor: auditoria (sem R$1) x snapshot — vendedores com diferença:", sql(f"""
  with a as (select seller_name, sum(spf_bruto) filter (where spf_bruto <> 1) v from public.snapshot_operational_detail where fechamento_id = '{FID}' and kind = 'SPF' group by 1),
       s as (select nome, sum(spf_extra) v from public.snapshot_comissoes where fechamento_id = '{FID}' and upper(perfil) = 'VENDEDOR' group by 1)
  select count(*) filter (where coalesce(a.v,0) <> coalesce(s.v,0)) com_diferenca, count(*) comparados
  from a full join s on s.nome = a.seller_name where coalesce(a.v,0) > 0 or coalesce(s.v,0) > 0"""))
print("fechamentos que cobrem 18/09/2026:", sql("""select nome_periodo, versao, ativo, data_inicio::text, data_fim::text, fechado_em::text from public.fechamentos_comissao
  where '2026-09-18' between data_inicio and data_fim order by versao"""))

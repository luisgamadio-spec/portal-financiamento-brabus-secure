"""Totais do grupo (soma dos VENDEDORES do snapshot congelado) por fechamento — o que o Resumo deve mostrar. Só agregados."""
import io, json, os, sys, time
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
def q(s):
    for n in range(5):
        try: return sql(s)
        except RuntimeError as e:
            if "502" not in str(e) and "retryable" not in str(e): raise
            time.sleep(15 * (n + 1))
    raise RuntimeError("API indisponível")
out = {}
for r in q("select f.id, f.nome_periodo, f.versao, f.ativo from public.fechamentos_comissao f where f.data_inicio in ('2026-09-22','2026-08-21') order by f.data_inicio, f.versao"):
    t = q(f"""select sum(vendidas) v, sum(financiadas) f, round(sum(producao), 2) p, round(sum(retorno), 2) r, round(sum(spf_extra), 2) s
             from public.snapshot_comissoes where fechamento_id = '{r['id']}' and upper(perfil) = 'VENDEDOR'""")[0]
    out[r["id"]] = {"Quantidade Vendida": float(t["v"]), "Quantidade Financiada": float(t["f"]), "Produção Total": float(t["p"]), "Retorno Total": float(t["r"]), "SPF Extra": float(t["s"])}
    print(r["nome_periodo"], "v", r["versao"], "ativo" if r["ativo"] else "inativo", r["id"][:8], out[r["id"]])
json.dump(out, open(os.path.join(AQUI, "esperado_grupo.json"), "w", encoding="utf-8"), ensure_ascii=False)

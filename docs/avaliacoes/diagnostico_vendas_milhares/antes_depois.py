"""Antes x depois da Análise Geral (jan–mai/2026), com as MESMAS funções da tela (operational_model_metrics e
operational_metrics, visão do grupo, como Master). A correção roda só dentro da transação, que termina em ROLLBACK."""
import io, json, os, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, ".."))
from sq import q
corr = open(os.path.join(AQUI, "corrige.sql"), encoding="utf-8").read().replace("begin;\n", "", 1).rstrip()
assert corr.endswith("commit;"); corr = corr[:-7]
M = "(select u.auth_user_id::text from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
MESES = [("2026-01-01", "2026-01-31"), ("2026-02-01", "2026-02-28"), ("2026-03-01", "2026-03-31"), ("2026-04-01", "2026-04-30"), ("2026-05-01", "2026-05-31"), ("2026-01-01", "2026-05-31")]
def medir(rotulo):
    s = ""
    for a, b in MESES:
        s += (f"insert into _r select '{rotulo}', '{a}|{b}', public.operational_model_metrics('{a}', '{b}', true)::text, public.operational_metrics('{a}', '{b}', true)::text; ")
    return s
sql = ("begin; create temp table _r(quando text, ini text, mm text, om text) on commit drop; grant all on _r to authenticated; "
       "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + M + ", 'role','authenticated')::text, true); end $x$; "
       "set local role authenticated; " + medir("antes") + " reset role; " + corr +
       " do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + M + ", 'role','authenticated')::text, true); end $x$; "
       "set local role authenticated; " + medir("depois") + " reset role; select quando, ini, mm, om from _r; rollback;")
for i in range(5):
    try: rows = q(sql); break
    except RuntimeError as e:
        if "emp" in str(e).lower() and i < 4: time.sleep(4); continue
        raise
def linhas(js):
    j = json.loads(js)
    if isinstance(j, dict):
        for k in ("rows", "data", "metrics"):
            if isinstance(j.get(k), list): return j[k]
    return j if isinstance(j, list) else []
res = {}
for r in rows:
    mm, om = linhas(r["mm"]), linhas(r["om"])
    soma = lambda L, k: sum(float(x.get(k) or 0) for x in L)
    et, ev, n = soma(mm, "entry_total"), soma(mm, "entry_sales_value_total"), soma(mm, "valid_entry_count")
    res[(r["quando"], r["ini"])] = {"vendidos": soma(om, "sold_count"), "financiados": soma(om, "financed_count"), "retorno": soma(om, "return_total") or soma(om, "return_value"),
                                    "entradas_validas": n, "entrada_media": et / n if n else None, "pct_entrada": et / ev * 100 if ev else None,
                                    "valor_vendas": soma(om, "sales_value")}
nome = {"2026-01-01": "jan", "2026-02-01": "fev", "2026-03-01": "mar", "2026-04-01": "abr", "2026-05-01": "mai"}
print(f"{'mês':8}{'vendidos':>10}{'financ.':>9}{'entradas na conta':>20}{'Entrada média':>28}{'% Entrada':>18}")
for a, b in MESES:
    A, D = res[("antes", a + "|" + b)], res[("depois", a + "|" + b)]
    rot = "jan–mai" if (a, b) == ("2026-01-01", "2026-05-31") else nome[a]
    print(f"{rot:8}{A['vendidos']:>6.0f}→{D['vendidos']:<4.0f}{A['financiados']:>5.0f}→{D['financiados']:<4.0f}{A['entradas_validas']:>10.0f} → {D['entradas_validas']:<6.0f}"
          f"R$ {A['entrada_media']:>9,.0f} → R$ {D['entrada_media']:>9,.0f}   {A['pct_entrada']:>5.1f}% → {D['pct_entrada']:>5.1f}%".replace(",", "."))
json.dump({f"{k[0]}|{k[1]}": v for k, v in res.items()}, open(os.path.join(AQUI, "antes_depois.json"), "w", encoding="utf-8"), indent=1)
print("\nestado real depois do ensaio (linhas ainda em milhares, esperado 835):",
      q("select count(*) n from public.portal_sales where batch_id='1ab5e700-c927-41e9-a714-7f34db04fdeb' and sale_value < 1000")[0]["n"])

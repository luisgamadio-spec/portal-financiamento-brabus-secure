"""Ensaio em ROLLBACK das novas referências: aplica leitor + aval_referencias numa transação, cria avaliações
de teste como Master e mostra os dois grupos. Nada fica gravado."""
import json, os, sys, time
sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, ".."))
from sq import q
SQL = open(os.path.join(AQUI, sys.argv[1] if len(sys.argv) > 1 else "migracao.sql"), encoding="utf-8").read()
SQL = SQL.replace("begin;\n", "", 1).rstrip()
if SQL.endswith("commit;"): SQL = SQL[:-7]
CASOS = [("OUTLANDER", "3.0 HPE-S AWD AT", "GASOLINA", 2019, 2020),
         ("OUTLANDER", "2.0 HPE CVT", "GASOLINA", 2021, 2022),
         ("ECLIPSE CROSS", "HPE-S 1.5 TURBO S-AWC", "GASOLINA", 2023, 2024),
         ("L200 TRITON", "SPORT HPE-S 2.4 DIESEL 4X4", "DIESEL", 2022, 2023),
         ("PAJERO SPORT", "HPE-S 2.4 DIESEL 4X4", "DIESEL", 2024, 2025)]
M = "(select u.auth_user_id::text from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
s = ("begin; create temp table _t(n serial, nome text, valor text) on commit drop; grant all on _t to authenticated; "
     "grant all on sequence _t_n_seq to authenticated; " + SQL +
     " do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + M + ", 'role','authenticated')::text, true); end $x$; set local role authenticated; ")
for i, (mod, ver, comb, af, am) in enumerate(CASOS):
    d = json.dumps({"loja": "GASTAO", "placa": f"TST{i}A0{i}", "km": "50000", "ano_fabricacao": af, "ano_modelo": am,
                    "carroceria": "SUV", "modelo": mod, "versao": ver, "combustivel": comb})
    s += (f"do $b$ declare a jsonb; begin a := public.aval_salvar_identificacao(null, $j${d}$j$::jsonb); "
          f"insert into _t(nome, valor) values ($n${mod} {ver} {am}$n$, public.aval_referencias((a->>'id')::uuid, null)::text); end $b$; ")
s += "reset role; select nome, valor from _t order by n; rollback;"
for i in range(6):
    try: rows = q(s); break
    except RuntimeError as e:
        if "emp" in str(e).lower() and i < 5: time.sleep(4); continue
        raise
brl = lambda v: "—" if v is None else f"R$ {float(v):,.0f}".replace(",", ".")
for r in rows:
    j = json.loads(r["valor"])
    b = j["base"]
    print(f"\n### {r['nome']}  →  família {b['familia']} | motor {b['motor']} | versão {b['versao']} {b['edicao'] or ''} | {b['combustivel']} | {b['tracao']} | ano {b['ano_modelo']}")
    for k, t in (("mesma_versao_ano", "mesma versão e ano"), ("versao_ou_ano_proximo", "versão ou ano próximo")):
        g = j[k]
        print(f"   {t:24}: {g['quantidade']:3} vendas | mediana {brl(g['mediana'])} | faixa {brl(g['p25'])}–{brl(g['p75'])} | min {brl(g['minimo'])} max {brl(g['maximo'])}{' | AMOSTRA PEQUENA' if g['amostra_pequena'] else ''}")
    print(f"   ignoradas (absurdas): {j['ignoradas']}")
    for v in j["vendas"][:6]:
        print(f"      {v['grupo']:8} {'IGN ' if v['ignorada'] else '    '}{v['data']} {v['ano']} {v['modelo'][:36]:36} {brl(v['valor'])}")
print("\nestado real (avaliações de teste gravadas):", q("select count(*) n from public.aval_avaliacoes where placa like 'TST%'")[0]["n"])

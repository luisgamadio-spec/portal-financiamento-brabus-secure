"""Prova da correção do corte (em transação com ROLLBACK): sem dupla contagem; só a 1ª pergunta real deixa de contar como
estimada; permissões iguais; desfazer = texto exato de hoje. Só contagens."""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
def corpo(a):
    s = open(os.path.join(AQUI, a), encoding="utf-8", newline="").read(); return s[s.index("begin;") + 6:s.rindex("commit;")]
NOVO, VOLTA = corpo("ia_fix_corte.sql"), corpo("ia_fix_corte_rollback.sql")
M = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
AN = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='ANALISTA' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{x}]" if x != "" else ""))
def tela(novo, sub=M):
    q = ("begin; " + (NOVO if novo else "") + "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; select public.master_ia_usage_data('2026-10-01'::date, '2026-10-26'::date)::text j; rollback;")
    try: return json.loads(sql(q)[0]["j"])
    except RuntimeError as e: m = re.search(r"ERROR:\s+(\w{5})", str(e)); return m.group(1) if m else "erro"
a, d = tela(False), tela(True)
reais = sql("select count(*) n from public.bi_uso_perguntas")[0]["n"]
tot = lambda x: sum(l["perguntas"] for l in x["linhas"]); est = lambda x: sum(l["perguntas_estimadas"] for l in x["linhas"])
print(f"   hoje: total {tot(a)} (estimadas {est(a)}) | corrigido: total {tot(d)} (estimadas {est(d)}) | registros reais: {reais}")
check("corrigido: estimadas = as de antes do deploy (201) e total = 201 + reais", est(d) == 201 and tot(d) == 201 + reais, (est(d), tot(d)))
check("a diferença é só a 1ª pergunta que contava em dobro", tot(a) - tot(d) == 1 and est(a) - est(d) == 1, (tot(a) - tot(d)))
check("mesmos usuários, elegíveis e 'nunca usaram'", len(a["linhas"]) == len(d["linhas"]) and a["elegiveis"] == d["elegiveis"])
check("Analista continua sem acesso (42501)", tela(True, AN) == "42501")
EST = "select md5(pg_get_functiondef('public.master_ia_usage_data(date,date)'::regprocedure)) f, (select proacl::text from pg_proc where oid = 'public.master_ia_usage_data(date,date)'::regprocedure) acl"
h0, h1, h2 = sql("begin; " + EST + "; rollback;")[0], sql("begin; " + NOVO + "\n" + EST + "; rollback;")[0], sql("begin; " + NOVO + "\n" + VOLTA + "\n" + EST + "; rollback;")[0]
check("permissões iguais depois da correção", h1["acl"] == h0["acl"] and h1["f"] != h0["f"])
check("aplicar + desfazer = texto exato de hoje", h2 == h0)
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

"""Prova da mudança do fechamento ANTES de aplicar: cada verificação aplica fech.sql dentro de uma transação, roda como
usuário real (Master / Analista / Vendedor) e termina em ROLLBACK. Só imprime contagens, totais e sim/não.
Uso: python -I test_fech_db.py [payload_fechamento.json]"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, AQUI)
from sqlexato import sql

def corpo(arq):
    s = open(os.path.join(AQUI, arq), encoding="utf-8", newline="").read(); return s[s.index("begin;") + 6:s.rindex("commit;")]
NOVO, VOLTA = corpo("fech.sql"), corpo("fech_rollback.sql")
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)" for p in ("MASTER", "ANALISTA", "VENDEDOR")}
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:220]}]" if x != "" else ""))
def roda(perfil, consulta, novo=True, prep=""):
    q = ("begin; set local statement_timeout='120s'; " + (NOVO if novo else "") + "\n" + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q, timeout=300))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s)
        return ("erro", m.group(1) if m else "?", (m.group(2) if m else s[:300]).strip().rstrip("\\"))
def j(r): return json.loads(r[1][0]["j"]) if r[0] == "ok" else None
P = "'2026-09-22'::date, '2026-10-20'::date"

print("== analistas (closing usa operational_analyst_commission_metrics_v2)")
qa = f"select public.operational_analyst_commission_metrics_v2({P})::text j"
a, d = j(roda("MASTER", qa, novo=False)), j(roda("MASTER", qa))
ra, rd = a["rows"], d["rows"]
chave = lambda r: (r["store"], r["transfer"], r["covered_start"] or "")
ia, idd = {chave(r): r for r in ra}, {chave(r): r for r in rd}
iguais_fora_spf = all(all(ia[k][c] == idd[k][c] for c in ia[k] if c not in ("spf_count", "spf_value")) for k in ia if k in idd)
check("mesmas linhas de analista; só SPF muda", set(ia) == set(idd) and iguais_fora_spf, (len(ia), len(idd)))
dq = sum(ia[k]["spf_count"] for k in ia) - sum(idd[k]["spf_count"] for k in idd)
dv = round(sum(float(ia[k]["spf_value"]) for k in ia) - sum(float(idd[k]["spf_value"]) for k in idd), 2)
check("unidades de SPF a menos = 4 marcadores de R$ 1,00 (R$ 4,00)", dq == 4 and dv == 4.0, (dq, dv))
check("identificador do analista em todas as linhas", all(r.get("analyst_user_id") for r in rd), sum(1 for r in rd if r.get("analyst_user_id")))
print("   por loja (unidades antes → depois):", {k[0]: (ia[k]["spf_count"], idd[k]["spf_count"]) for k in ia if ia[k]["spf_count"] != idd.get(k, {}).get("spf_count")})

print("== gerentes")
qg = f"select public.operational_salary_manager_directory({P})::text j"
a, d = j(roda("MASTER", qg, novo=False)), j(roda("MASTER", qg))
check("mesmos gerentes; só ganha manager_id", [ {k: v for k, v in r.items() if k != "manager_id"} for r in d["rows"]] == a["rows"], len(a["rows"]))
check("manager_id quando há 1 gerente por loja+departamento", all((r.get("manager_id") is not None) == (" / " not in r["manager_name"]) for r in d["rows"]),
      (sum(1 for r in d["rows"] if r.get("manager_id")), sum(1 for r in d["rows"] if " / " in r["manager_name"])))

print("== auditoria SPF")
qs = f"select public.master_operational_spf_audit_period({P})::text j"
a, d = j(roda("MASTER", qs, novo=False)), j(roda("MASTER", qs))
sem = lambda r: {k: v for k, v in r.items() if k not in ("operation_code", "bank", "finance_code", "conta_na_comissao")}
check("mesmas 27 linhas e valores (fora os 3 campos e a nova coluna)", [sem(r) for r in a["rows"]] == [sem(r) for r in d["rows"]] and len(d["rows"]) == 27, len(d["rows"]))
check("totais iguais", (a["total_operations"], a["total_spf_bruto"], a["total_spf_liquido"]) == (d["total_operations"], d["total_spf_bruto"], d["total_spf_liquido"]))
pre = {c: sum(1 for r in d["rows"] if r.get(c)) for c in ("operation_code", "bank", "finance_code")}
check("código/banco/plano preenchidos (antes 0/27)", pre["operation_code"] == 27 and pre["bank"] >= 25, pre)
check("conta na comissão: 23 Sim e 4 Não (os de R$ 1,00)", sum(1 for r in d["rows"] if r["conta_na_comissao"] is True) == 23 and all((r["conta_na_comissao"] is False) == (float(r["spf_bruto"]) == 1) for r in d["rows"]))
qd = f"select public.master_commission_operational_detail('{FID}'::uuid)::text j"
a, d = j(roda("MASTER", qd, novo=False)), j(roda("MASTER", qd))
check("fechamento já gravado: detalhe igual (coluna nova vazia)", [{k: v for k, v in r.items() if k != "conta_na_comissao"} for r in d["rows"]] == a["rows"] and all(r.get("conta_na_comissao") is None for r in d["rows"]))

print("== perfis")
r = roda("ANALISTA", qa); ra2 = j(r)
check("ANALISTA vê a própria comissão (função roda)", r[0] == "ok" and ra2 is not None, r[:2] if r[0] == "erro" else "")
for p in ("ANALISTA", "VENDEDOR"):
    for fn in ("master_operational_spf_audit_period(" + P + ")", f"master_commission_operational_detail('{FID}'::uuid)"):
        r = roda(p, f"select public.{fn}::text j")
        check(f"{p} não acessa {fn.split('(')[0]}", r[0] == "erro" and r[1] == "42501", r[:2])

payload = sys.argv[1] if len(sys.argv) > 1 else None
if payload:
    print("== fechamento simulado (prévia real da tela) — antigo x novo, ambos em rollback")
    pl = json.load(open(payload, encoding="utf-8"))
    lit = lambda v: "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    chamada = f"select set_config('teste.cid', public.master_close_commission_period('{pl['p_period_id']}'::uuid, {lit(pl['p_summary'])}, {lit(pl['p_rows'])})->>'closing_id', true)"
    leitura = ("; reset role; select json_build_object("
               "'obs', (select observacao from public.fechamentos_comissao where id = current_setting('teste.cid')::uuid), "
               "'linhas', (select json_agg(json_build_object('perfil', perfil, 'loja', loja, 'comissao', comissao, 'det', detalhes, 'uid', usuario_id is not null, 'cpf', cpf is not null, 'cpf11', cpf ~ '^[0-9]{11}$')) from public.snapshot_comissoes where fechamento_id = current_setting('teste.cid')::uuid), "
               "'spf', (select json_agg(json_build_object('cod', operation_code is not null, 'conta', conta_na_comissao, 'v', spf_bruto)) from public.snapshot_operational_detail where fechamento_id = current_setting('teste.cid')::uuid and kind = 'SPF'))::text j")
    # dentro da transação: o fechamento de hoje fica inativo só para o período poder ser "fechado de novo" (rollback no fim)
    PREP = f"update public.fechamentos_comissao set ativo = false where id = '{FID}';"
    def fecha(novo):
        lt = leitura if novo else leitura.replace("usuario_id is not null", "false").replace("'conta', conta_na_comissao", "'conta', null")
        r = roda("MASTER", chamada + lt, novo=novo, prep=PREP)
        return j(r) if r[0] == "ok" else r
    a, d = fecha(False), fecha(True)
    if not isinstance(d, dict) or not isinstance(a, dict): check("fechamento simulado rodou", False, (a if not isinstance(a, dict) else "", d if not isinstance(d, dict) else ""))
    else:
        la, ld = a["linhas"], d["linhas"]
        check("mesmo número de linhas", len(la) == len(ld) == len(pl["p_rows"]), (len(la), len(ld)))
        cent = all(round(float(r["comissao"]), 2) == float(r["comissao"]) for r in ld)
        check("toda comissão gravada em centavos", cent)
        tot = round(sum(float(r["comissao"]) for r in ld), 2); oficial = json.loads(d["obs"])["comissao_total"]
        check("total oficial = soma das linhas", round(float(oficial), 2) == tot, (oficial, tot))
        dif = max(abs(float(x["comissao"]) - float(y["comissao"])) for x, y in zip(sorted(la, key=lambda r: (r["perfil"], r["loja"], float(r["comissao"]))), sorted(ld, key=lambda r: (r["perfil"], r["loja"], float(r["comissao"])))))
        check("cada pessoa difere do cálculo atual no máximo meio centavo", dif <= 0.005 + 1e-9, round(dif, 6))
        coer = all(r["perfil"] == "GERENTE" or abs(float(r["det"]["comissao_principal"]) + float(r["det"]["comissao_spf"]) - float(r["det"]["comissao_total"])) < 1e-9 for r in ld)
        check("principal + SPF = total em centavos (fora gerente)", coer)
        idn = {p: (sum(1 for r in ld if r["perfil"] == p and r["cpf"]), sum(1 for r in ld if r["perfil"] == p)) for p in sorted({r["perfil"] for r in ld})}
        check("CPF preenchido por perfil (preenchidas, total)", all(r["cpf11"] for r in ld if r["cpf"]), idn)
        sp = d["spf"] or []
        check("detalhe SPF congelado com código e 'conta na comissão'", all(s["cod"] for s in sp) and all(s["conta"] == (float(s["v"]) != 1) for s in sp), (len(sp), sum(1 for s in sp if s["cod"])))

print("== desfazer")
EST = ("select (select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in "
       "('master_close_commission_period','master_operational_spf_audit_period','master_commission_operational_detail','operational_analyst_commission_metrics','operational_analyst_coverage_metrics','operational_salary_manager_directory')) f, "
       "(select string_agg(p.proacl::text, '|' order by p.proname) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in "
       "('master_close_commission_period','master_operational_spf_audit_period','master_commission_operational_detail','operational_analyst_commission_metrics','operational_analyst_coverage_metrics','operational_salary_manager_directory')) acl, "
       "(select count(*) from information_schema.columns where table_schema='public' and column_name in ('usuario_id','conta_na_comissao') and table_name in ('snapshot_comissoes','snapshot_operational_detail')) cols")
a = sql("begin; " + EST + "; rollback;"); d = sql("begin; " + NOVO + "\n" + EST + "; rollback;"); v = sql("begin; " + NOVO + "\n" + VOLTA + "\n" + EST + "; rollback;")
check("com a mudança: funções diferentes, mesmas permissões, 2 colunas novas", d[0]["f"] != a[0]["f"] and d[0]["acl"] == a[0]["acl"] and d[0]["cols"] == 2)
check("aplicar + desfazer = estado de hoje (texto exato, permissões, sem colunas)", v == a, (a, v))
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

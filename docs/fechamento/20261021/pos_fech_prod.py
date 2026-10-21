"""Conferência em PRODUÇÃO da mudança do fechamento (21/10/2026), com Master, Analista e Vendedor reais.
--antes: grava as assinaturas de antes (só leitura) em antes_fech.json. Sem argumento: confere depois de aplicado.
Leituras em transação somente leitura; o fechamento simulado roda em transação com ROLLBACK (nada fica gravado).
Só imprime contagens, totais e sim/não.  Uso: python -I pos_fech_prod.py --antes | python -I pos_fech_prod.py"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)" for p in ("MASTER", "ANALISTA", "VENDEDOR")}
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
P = "'2026-09-22'::date, '2026-10-20'::date"
def roda(perfil, consulta, so_leitura=True, prep=""):
    q = ("begin; " + ("set transaction read only; " if so_leitura else "") + "set local statement_timeout='120s'; " + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s)
        return ("erro", m.group(1) if m else "?", (m.group(2) if m else s[:300]).strip().rstrip("\\"))
def j(r): return json.loads(r[1][0]["j"]) if r[0] == "ok" else None
# o que NÃO pode mudar: comissão dos vendedores, fechamento já gravado (sem as chaves novas), períodos
INTOCADO = {
    "vendedores": ("MASTER", f"select md5(public.operational_commission_metrics({P})::text) j"),
    "snapshot_fechado": ("MASTER", f"select md5((select jsonb_agg(e - 'usuario_id' order by e->>'id') from jsonb_array_elements(public.master_commission_snapshot_export('{FID}'::uuid)->'rows') e)::text) j"),
    "detalhe_fechado": ("MASTER", f"select md5((select jsonb_agg(e - 'conta_na_comissao' order by e::text) from jsonb_array_elements(public.master_commission_operational_detail('{FID}'::uuid)->'rows') e)::text) j"),
    "periodos_vendedor": ("VENDEDOR", "select md5(public.operational_commission_periods()::text) j"),
}
ARQ = os.path.join(AQUI, "antes_fech.json")
if "--antes" in sys.argv:
    d = {k: roda(p, q)[1] for k, (p, q) in INTOCADO.items()}
    json.dump(d, open(ARQ, "w", encoding="utf-8")); print("assinaturas de antes:", {k: (v[0]["j"][:8] if isinstance(v, list) else v) for k, v in d.items()}); sys.exit(0)

ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:200]}]" if x != "" else ""))
antes = json.load(open(ARQ, encoding="utf-8"))
print("== o que não pode mudar")
for k, (p, q) in INTOCADO.items():
    r = roda(p, q); check(f"{k} ({p}) igual a antes", r[0] == "ok" and r[1] == antes[k], r[:2] if r[0] == "erro" else "")
print("== Master")
a = j(roda("MASTER", f"select public.operational_analyst_commission_metrics_v2({P})::text j"))
check("analistas: SPF sem os marcadores de R$ 1,00 (23 unidades) e identificador em todas as linhas",
      a and sum(r["spf_count"] for r in a["rows"]) == 23 and all(r.get("analyst_user_id") for r in a["rows"]), (sum(r["spf_count"] for r in a["rows"]) if a else None))
g = j(roda("MASTER", f"select public.operational_salary_manager_directory({P})::text j"))
check("gerentes com identificador", g and all(r.get("manager_id") for r in g["rows"]), len(g["rows"]) if g else None)
s = j(roda("MASTER", f"select public.master_operational_spf_audit_period({P})::text j"))
check("auditoria SPF: 27 linhas, código/banco preenchidos, 4 'não conta'", s and len(s["rows"]) == 27 and all(r["operation_code"] and r["bank"] for r in s["rows"])
      and sum(1 for r in s["rows"] if r["conta_na_comissao"] is False) == 4, (len(s["rows"]) if s else None))
pl = json.load(open(os.path.join(AQUI, "saida", "payload_novo.json"), encoding="utf-8"))
lit = lambda v: "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
r = roda("MASTER", f"select set_config('teste.cid', public.master_close_commission_period('{pl['p_period_id']}'::uuid, {lit(pl['p_summary'])}, {lit(pl['p_rows'])})->>'closing_id', true); reset role; "
         "select json_build_object('obs', (select observacao from public.fechamentos_comissao where id = current_setting('teste.cid')::uuid), "
         "'n', (select count(*) from public.snapshot_comissoes where fechamento_id = current_setting('teste.cid')::uuid), "
         "'soma', (select sum(comissao) from public.snapshot_comissoes where fechamento_id = current_setting('teste.cid')::uuid), "
         "'cent', (select bool_and(comissao = round(comissao, 2)) from public.snapshot_comissoes where fechamento_id = current_setting('teste.cid')::uuid), "
         "'cpf', (select count(*) filter (where cpf ~ '^[0-9]{11}$' and usuario_id is not null or cpf ~ '^[0-9]{11}$') from public.snapshot_comissoes where fechamento_id = current_setting('teste.cid')::uuid), "
         "'spf_cod', (select count(*) filter (where operation_code is not null and conta_na_comissao is not null) from public.snapshot_operational_detail where fechamento_id = current_setting('teste.cid')::uuid and kind = 'SPF'))::text j",
         so_leitura=False, prep=f"update public.fechamentos_comissao set ativo = false where id = '{FID}';")
f = j(r)
check("fechamento simulado (rollback): 90 linhas em centavos, total = soma, CPF 90/90, SPF com código e 'conta'",
      f and f["n"] == 90 and f["cent"] and round(float(json.loads(f["obs"])["comissao_total"]), 2) == round(float(f["soma"]), 2) and f["cpf"] == 90 and f["spf_cod"] == 27,
      (f and {k: f[k] for k in ("n", "soma", "cent", "cpf", "spf_cod")}) or r[:3])
print("== Analista")
a = j(roda("ANALISTA", f"select public.operational_analyst_commission_metrics_v2({P})::text j"))
check("Analista vê a própria comissão (com identificador)", a is not None and all(x.get("analyst_user_id") for x in a["rows"]), len(a["rows"]) if a else None)
for fn in ("master_operational_spf_audit_period(" + P + ")", f"master_commission_snapshot_export('{FID}'::uuid)"):
    r = roda("ANALISTA", f"select public.{fn}::text j"); check(f"Analista sem acesso a {fn.split('(')[0]}", r[0] == "erro" and r[1] == "42501", r[:2])
print("== Vendedor")
for fn in ("master_operational_spf_audit_period(" + P + ")", f"master_commission_snapshot_export('{FID}'::uuid)", f"master_commission_operational_detail('{FID}'::uuid)"):
    r = roda("VENDEDOR", f"select public.{fn}::text j"); check(f"Vendedor sem acesso a {fn.split('(')[0]}", r[0] == "erro" and r[1] == "42501", r[:2])
r = roda("VENDEDOR", "select count(*) n from public.snapshot_comissoes"); check("Vendedor não lê o snapshot (com CPF) direto", r[0] == "erro" and r[1] == "42501", r[:2])
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

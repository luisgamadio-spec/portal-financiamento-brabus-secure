"""Conferência em PRODUÇÃO depois de aplicar a mudança de 20/10/2026, com Vendedor, Analista e Master reais.
Usa as funções JÁ aplicadas; cada chamada roda em transação com ROLLBACK e um analista FALSO online (nada fica gravado,
nenhum analista real é acionado). Compara com as assinaturas de antes salvas em antes_pos.json (gerado com --antes).
Uso: python -I pos_seg5_prod.py --antes   (antes de aplicar)   |   python -I pos_seg5_prod.py   (depois)"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)" for p in ("VENDEDOR", "ANALISTA", "MASTER")}
UID = {p: s.replace("u.auth_user_id from", "u.id from") for p, s in SUB.items()}
FAKE = ("insert into public.analistas_fi (nome, whatsapp, status, ativo, online, ocupado, ordem_fila) "
        "values ('Analista Teste (falso)', '5500000000000', 'ONLINE', true, true, false, -100000);")
def roda(perfil, consulta, prep="", so_leitura=False):
    q = ("begin; " + ("set transaction read only; " if so_leitura else "") + "set local statement_timeout='30s'; " + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q, timeout=180))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s); h = re.search(r"HINT:\s+([A-Z_]+)", s)
        return ("erro", m.group(1) if m else "?", h.group(1) if h else None, (m.group(2) if m else s[:160]).strip().rstrip("\\").strip())
Q_PER = ("select count(*) n, bool_or(e ? 'criado_por') tem_criado_por, md5(string_agg((e - 'criado_por')::text, '|' order by e->>'data_inicio')) h "
         "from jsonb_array_elements(public.operational_commission_periods()->'rows') e")
ASSIN = {"periodos": Q_PER, "master_ref": "select md5(public.master_admin_reference_data()::text) h", "master_seg": "select md5(public.master_admin_security_data()::text) h",
         "config": "select md5(public.operational_portal_config()::text) h"}
QUEM = {"periodos": ("VENDEDOR", "ANALISTA", "MASTER"), "master_ref": ("MASTER",), "master_seg": ("MASTER",), "config": ("VENDEDOR", "ANALISTA", "MASTER")}
ARQ = os.path.join(AQUI, "antes_pos.json")
if "--antes" in sys.argv:
    d = {f"{k}:{p}": roda(p, ASSIN[k], so_leitura=True)[1] for k in ASSIN for p in QUEM[k]}
    json.dump(d, open(ARQ, "w", encoding="utf-8"), ensure_ascii=False, indent=1); print("assinaturas de antes salvas:", len(d)); sys.exit(0)

ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:170]}]" if x != "" else ""))
antes = json.load(open(ARQ, encoding="utf-8"))
for k in ASSIN:
    for p in QUEM[k]:
        r = roda(p, ASSIN[k], so_leitura=True); a = antes[f"{k}:{p}"][0]; d = r[1][0] if r[0] == "ok" else {}
        if k == "periodos":
            check(f"{p}: períodos iguais a antes, agora sem criado_por", d.get("n") == a["n"] and d.get("h") == a["h"] and a["tem_criado_por"] is True and d.get("tem_criado_por") is False, (a["n"], d.get("n")))
        else:
            check(f"{p}: {k} idêntico a antes", d.get("h") == a["h"])
for p in ("VENDEDOR", "ANALISTA", "MASTER"):
    r = roda(p, "with c as (select * from public.chamar_analista_fi()) select (select string_agg(nome, ',') from c) nome", prep=FAKE)
    check(f"{p}: Falar com um Analista entrega o analista online", r[0] == "ok" and r[1][0]["nome"] == "Analista Teste (falso)", r[:3] if r[0] == "erro" else "")
    r = roda(p, "select 1 from public.chamar_analista_fi(); select nome from public.chamar_analista_fi()", prep=FAKE)
    check(f"{p}: 2ª chamada em seguida → 'Aguarde um instante para chamar de novo.'", r[0] == "erro" and r[2] == "AGUARDE_CHAMAR_ANALISTA" and r[3] == "Aguarde um instante para chamar de novo.", r)
r = roda("VENDEDOR", "select nome from public.chamar_analista_fi()", prep=FAKE + f" insert into public.chamar_analista_fi_controle values ({UID['VENDEDOR']}, now() - interval '61 seconds') on conflict (usuario_id) do update set ultima_chamada = excluded.ultima_chamada;")
check("VENDEDOR: depois de 61 s libera de novo", r[0] == "ok", r[:3] if r[0] == "erro" else "")
r = roda("VENDEDOR", "select nome from public.chamar_analista_fi()", prep=FAKE + " update public.permissoes_modulos set permitido = false where perfil = 'VENDEDOR' and modulo_id in ('simuladorCompleto','simuladorSeminovos');")
check("perfil sem Simulador → negado", r[0] == "erro" and r[2] == "PERFIL_SEM_SIMULADOR", r[:3])
n = sql("select count(*) n from public.chamar_analista_fi_controle")[0]["n"]
print(f"(informativo) usuários com chamada registrada na tabela de controle: {n}")
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

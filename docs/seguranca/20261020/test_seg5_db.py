"""Prova da mudança de segurança de 20/10/2026 ANTES de aplicar: cada verificação roda numa transação que aplica
seg5.sql, assume um usuário real (Vendedor / Analista / Master / Gerente) e termina em ROLLBACK — nada fica gravado.
O analista "online" usado nas chamadas é um registro FALSO criado dentro da própria transação (sem dados reais).
Só imprime contagens, códigos e sim/não. Uso: python -I test_seg5_db.py"""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql

def corpo(arq):
    s = open(os.path.join(AQUI, arq), encoding="utf-8", newline="").read()
    return s[s.index("begin;") + 6:s.rindex("commit;")]
NOVO, VOLTA = corpo("seg5.sql"), corpo("seg5_rollback.sql")
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
       for p in ("VENDEDOR", "ANALISTA", "MASTER", "GERENTE")}
UID = {p: s.replace("u.auth_user_id from", "u.id from") for p, s in SUB.items()}
FAKE = ("insert into public.analistas_fi (nome, whatsapp, status, ativo, online, ocupado, ordem_fila) "
        "values ('Analista Teste (falso)', '5500000000000', 'ONLINE', true, true, false, -100000);")
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:180]}]" if x != "" else ""))

def roda(perfil, consulta, novo=True, prep=""):
    """Devolve ('ok', linhas) ou ('erro', codigo, hint, mensagem)."""
    q = ("begin; set local statement_timeout='30s'; " + (NOVO if novo else "") + "\n" + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q, timeout=180))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n")
        m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s); h = re.search(r"HINT:\s+([A-Z_]+)", s)
        return ("erro", m.group(1) if m else "?", h.group(1) if h else None, (m.group(2) if m else s[:160]).strip().rstrip("\\").strip())

TABS = ["configuracoes", "periodos_comissao", "ausencias_analistas", "mudancas_loja_vendedores", "analistas_fi"]
print("== 1) leitura direta das tabelas (depois da mudança)")
for p in ("VENDEDOR", "ANALISTA", "MASTER"):
    res = [roda(p, f"select count(*) n from public.{t}") for t in TABS + ["chamar_analista_fi_controle"]]
    check(f"{p}: leitura direta negada nas 5 tabelas + tabela de controle", all(r[0] == "erro" and r[1] == "42501" for r in res), [r[:2] for r in res])

print("== estrutura depois (na transação)")
r = roda("MASTER", "select (select count(*) from pg_policies where schemaname='public' and tablename in ('configuracoes','periodos_comissao','ausencias_analistas','mudancas_loja_vendedores','analistas_fi')) pol, "
         "(select bool_and(relrowsecurity) from pg_class where relnamespace='public'::regnamespace and relname in ('configuracoes','periodos_comissao','ausencias_analistas','mudancas_loja_vendedores','analistas_fi','chamar_analista_fi_controle')) rls, "
         "has_table_privilege('authenticated','public.chamar_analista_fi_controle','select,insert,update,delete') ctrl_auth, has_table_privilege('anon','public.chamar_analista_fi_controle','select') ctrl_anon, "
         "has_function_privilege('anon','public.chamar_analista_fi()','execute') chamar_anon, has_function_privilege('authenticated','public.chamar_analista_fi()','execute') chamar_auth, "
         "has_function_privilege('authenticated','public.operational_commission_periods()','execute') per_auth")
l = r[1][0] if r[0] == "ok" else {}
check("0 regras nas 5 tabelas, RLS ligada nas 6", l.get("pol") == 0 and l.get("rls") is True, l)
check("tabela de controle sem acesso para anon/authenticated", l.get("ctrl_auth") is False and l.get("ctrl_anon") is False, l)
check("permissões das funções iguais (logado executa; visitante não chama analista)", l.get("chamar_auth") is True and l.get("chamar_anon") is False and l.get("per_auth") is True, l)

print("== 3) períodos de comissão")
Q_PER = ("select count(*) n, bool_or(e ? 'criado_por') tem_criado_por, md5(string_agg((e - 'criado_por')::text, '|' order by e->>'data_inicio')) assinatura "
         "from jsonb_array_elements(public.operational_commission_periods()->'rows') e")
for p in ("VENDEDOR", "ANALISTA", "MASTER"):
    a, d = roda(p, Q_PER, novo=False), roda(p, Q_PER)
    a, d = a[1][0] if a[0] == "ok" else {}, d[1][0] if d[0] == "ok" else {}
    check(f"{p}: mesmos períodos e campos, sem criado_por", a.get("n") == d.get("n") and a.get("n", 0) > 0 and a.get("assinatura") == d.get("assinatura")
          and a.get("tem_criado_por") is True and d.get("tem_criado_por") is False, (a.get("n"), a.get("tem_criado_por"), d.get("tem_criado_por")))
Q_REF = "select md5(public.master_admin_reference_data()::text) h"
a, d = roda("MASTER", Q_REF, novo=False), roda("MASTER", Q_REF)
check("MASTER: Painel Master (períodos/ausências/mudanças) idêntico, ainda com criado_por", a[0] == d[0] == "ok" and a[1][0]["h"] == d[1][0]["h"])
Q_SEG = "select md5(public.master_admin_security_data()::text) h"
a, d = roda("MASTER", Q_SEG, novo=False), roda("MASTER", Q_SEG)
check("MASTER: Configurações (security data) idêntica", a[0] == d[0] == "ok" and a[1][0]["h"] == d[1][0]["h"])
Q_CFG = "select md5(public.operational_portal_config()::text) h"
a, d = roda("VENDEDOR", Q_CFG, novo=False), roda("VENDEDOR", Q_CFG)
check("VENDEDOR: configuração do portal idêntica", a[0] == d[0] == "ok" and a[1][0]["h"] == d[1][0]["h"])

print("== 4) Falar com um Analista")
Q1 = "select nome from public.chamar_analista_fi()"
EFEITO = ("select (select count(*) from public.atendimentos_fi where nome_analista='Analista Teste (falso)') at, "
          "(select count(*) from public.historico_atendimentos_fi where nome_analista='Analista Teste (falso)') hist, "
          "(select ordem_fila > 0 from public.analistas_fi where nome='Analista Teste (falso)') fila_andou")
for p in ("VENDEDOR", "ANALISTA", "MASTER", "GERENTE"):
    r = roda(p, "with c as (select * from public.chamar_analista_fi()) select (select string_agg(nome, ',') from c) nome", prep=FAKE)
    check(f"{p}: chama e recebe o analista online", r[0] == "ok" and r[1][0]["nome"] == "Analista Teste (falso)", r[:2] if r[0] == "erro" else r[1])
a = roda("VENDEDOR", "with c as (select * from public.chamar_analista_fi()) select (select count(*) from c) n_ret", novo=False, prep=FAKE)
d = roda("VENDEDOR", "with c as (select * from public.chamar_analista_fi()) select (select count(*) from c) n_ret", prep=FAKE)
ea = roda("VENDEDOR", "select 1 x from public.chamar_analista_fi(); reset role; " + EFEITO, novo=False, prep=FAKE)
ed = roda("VENDEDOR", "select 1 x from public.chamar_analista_fi(); reset role; " + EFEITO, prep=FAKE)
check("VENDEDOR: mesmo efeito de antes (1 atendimento, 1 histórico, fila anda)", ea[0] == ed[0] == "ok" and ea[1] == ed[1] and ed[1][0] == {"at": 1, "hist": 1, "fila_andou": True}, (ea[1:], ed[1:]))
r = roda("VENDEDOR", "select 1 from public.chamar_analista_fi(); " + Q1, prep=FAKE)
check("VENDEDOR: 2ª chamada logo em seguida → 'Aguarde um instante para chamar de novo.'", r[0] == "erro" and r[2] == "AGUARDE_CHAMAR_ANALISTA" and r[3] == "Aguarde um instante para chamar de novo.", r)
for seg, deve in ((30, False), (59, False), (61, True)):
    prep = FAKE + f"\ninsert into public.chamar_analista_fi_controle values ({UID['VENDEDOR']}, now() - interval '{seg} seconds');"
    r = roda("VENDEDOR", Q1, prep=prep)
    check(f"VENDEDOR: última chamada há {seg} s → {'libera' if deve else 'pede para aguardar'}", (r[0] == "ok") == deve and (deve or r[2] == "AGUARDE_CHAMAR_ANALISTA"), r[:3] if r[0] == "erro" else "ok")
prep = FAKE + f"\ninsert into public.chamar_analista_fi_controle values ({UID['ANALISTA']}, now());"
r = roda("VENDEDOR", "with c as (select * from public.chamar_analista_fi()) select count(*) n from c", prep=prep)
check("intervalo é por usuário (Analista acabou de chamar; Vendedor chama normal)", r[0] == "ok" and r[1][0]["n"] == 1, r)
prep = "update public.analistas_fi set online = false;"
r = roda("VENDEDOR", "select 1 from public.chamar_analista_fi(); create temp table _n on commit drop as select count(*) n from public.chamar_analista_fi(); reset role; select (select n from _n) n, (select count(*) from public.chamar_analista_fi_controle) ctrl", prep=prep)
check("sem analista online: volta vazio e não conta no intervalo (2 tentativas seguidas)", r[0] == "ok" and r[1][0] == {"n": 0, "ctrl": 0}, r)
prep = FAKE + "\nupdate public.permissoes_modulos set permitido = false where perfil = 'VENDEDOR' and modulo_id in ('simuladorCompleto','simuladorSeminovos');"
r = roda("VENDEDOR", Q1, prep=prep)
check("perfil sem acesso ao Simulador → negado (42501, sem expor analista)", r[0] == "erro" and r[1] == "42501" and r[2] == "PERFIL_SEM_SIMULADOR", r[:3] if r[0] == "erro" else r)
r = roda("VENDEDOR", "with c as (select * from public.chamar_analista_fi()) select count(*) n from c", novo=False, prep=prep)
check("(referência) hoje, o mesmo perfil sem Simulador ainda conseguia chamar", r[0] == "ok" and r[1][0]["n"] == 1, r)

print("== desfazer")
EST = ("select md5(string_agg(policyname||cmd||roles::text||coalesce(qual,'')||coalesce(with_check,''), '|' order by tablename, policyname)) pol, "
       "md5(pg_get_functiondef('public.chamar_analista_fi'::regproc)) f1, md5(pg_get_functiondef('public.operational_commission_periods'::regproc)) f2, "
       "to_regclass('public.chamar_analista_fi_controle') is null sem_ctrl, (select string_agg(proacl::text, '|' order by proname) from pg_proc where pronamespace='public'::regnamespace and proname in ('chamar_analista_fi','operational_commission_periods')) acl "
       "from pg_policies where schemaname='public' and tablename in ('configuracoes','periodos_comissao','ausencias_analistas','mudancas_loja_vendedores','analistas_fi')")
a = sql("begin; " + EST + "; rollback;")
d = sql("begin; " + NOVO + "\n" + VOLTA + "\n" + EST + "; rollback;")
check("aplicar + desfazer = estado de hoje (regras, funções, permissões, sem tabela nova)", a == d, (a, d))
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

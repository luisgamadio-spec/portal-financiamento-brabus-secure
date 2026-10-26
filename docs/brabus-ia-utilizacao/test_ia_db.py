"""Prova da utilização da Brabus IA ANTES de aplicar: cada verificação aplica ia_uso.sql dentro de uma transação, roda
como usuário real (Master / Analista / Vendedor / Gerente / Diretor) ou um usuário RH FALSO criado na transação, e termina em
ROLLBACK. Só imprime contagens e sim/não.  Uso: python -I test_ia_db.py"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
def corpo(arq):
    s = open(os.path.join(AQUI, arq), encoding="utf-8", newline="").read(); return s[s.index("begin;") + 6:s.rindex("commit;")]
NOVO, VOLTA = corpo("ia_uso.sql"), corpo("ia_uso_rollback.sql")
RH_FALSO = "11111111-2222-4333-8444-555555555555"
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
       for p in ("MASTER", "ANALISTA", "VENDEDOR", "GERENTE", "DIRETOR NOVOS")}
SUB["RH"] = f"'{RH_FALSO}'::uuid"
PREP_RH = (f"insert into public.usuarios (cpf, nome, perfil, ativo, auth_user_id) values ('00000000000', 'Usuário RH de teste (falso)', 'RH', true, '{RH_FALSO}'::uuid);")
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:200]}]" if x != "" else ""))
def roda(perfil, consulta, novo=True, prep=""):
    q = ("begin; set local statement_timeout='120s'; " + (NOVO if novo else "") + "\n" + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s)
        return ("erro", m.group(1) if m else "?", (m.group(2) if m else s[:300]).strip().rstrip("\\"))
def j(r): return json.loads(r[1][0]["j"]) if r[0] == "ok" else None

print("== acesso (lista ia_perfis_liberados)")
for p in ("MASTER", "ANALISTA", "VENDEDOR", "GERENTE", "DIRETOR NOVOS"):
    r = j(roda(p, "select public.bi_acesso_liberado()::text j"))
    check(f"{p}: liberado", r and r["liberado"] is True, r)
r = j(roda("RH", "select public.bi_acesso_liberado()::text j", prep=PREP_RH))
check("RH (usuário falso): NÃO liberado", r and r["liberado"] is False and r["perfil"] == "RH", r)

print("== registro de pergunta")
REG = "select public.bi_registrar_pergunta('sessao-teste', 'texto', array['simular_financiamento','simular_financiamento','Texto livre!', repeat('a', 70), 'consultar_score'], 'ok', 4321)"
LER = ("; reset role; select (select row_to_json(x) from (select p.canal, p.ferramentas, p.status, p.duracao_ms, "
       "p.perfil_snapshot = u.perfil and coalesce(p.loja_snapshot,'') = coalesce(u.loja,'') and coalesce(p.departamento_snapshot,'') = coalesce(u.status,'') snapshot_ok, "
       "p.usuario_id = u.id dono_ok from public.bi_uso_perguntas p join public.usuarios u on u.id = p.usuario_id order by p.id desc limit 1) x)::text j")
r = j(roda("VENDEDOR", REG + LER))
check("Vendedor registra 1 pergunta: só nomes válidos de ferramenta, sem repetir, loja/perfil/departamento da época",
      r and sorted(r["ferramentas"]) == ["consultar_score", "simular_financiamento"] and r["snapshot_ok"] and r["dono_ok"] and r["canal"] == "texto" and r["duracao_ms"] == 4321, r)
r = roda("VENDEDOR", "select public.bi_registrar_pergunta('s', 'xpto', null, 'ok', 1)")
check("canal inválido recusado (22023)", r[0] == "erro" and r[1] == "22023", r[:2])
r = roda("RH", "select public.bi_registrar_pergunta('s', 'texto', null, 'ok', 1)", prep=PREP_RH)
check("RH não registra (42501)", r[0] == "erro" and r[1] == "42501", r[:2])
for p in ("VENDEDOR", "ANALISTA", "MASTER"):
    r = roda(p, "select count(*) n from public.bi_uso_perguntas")
    check(f"{p}: não lê a tabela direto (42501)", r[0] == "erro" and r[1] == "42501", r[:2])

print("== tela (master_ia_usage_data)")
Q = "select public.master_ia_usage_data('2026-10-01'::date, '2026-10-26'::date)::text j"
d = j(roda("MASTER", Q))
if d:
    L = d["linhas"]; E = d["elegiveis"]
    print(f"   usuários que usaram: {len(L)} | perguntas (estimadas): {sum(x['perguntas'] for x in L)} ({sum(x['perguntas_estimadas'] for x in L)}) | elegíveis: {len(E)} | nunca usaram: {sum(1 for e in E if not e['ja_usou'])}")
    print("   temas no total:", {t: sum(x["temas"].get(t, 0) for x in L) for t in sorted({t for x in L for t in x["temas"]})})
check("Master lê: sem registro real ainda, tudo estimado", d and d["registro_iniciado_em"] is None and all(x["perguntas"] == x["perguntas_estimadas"] for x in d["linhas"]))
cnt = sql("select count(distinct l.auth_user_id) n from public.bi_audit_log l join public.usuarios u on u.auth_user_id = l.auth_user_id where l.created_at >= '2026-10-01 03:00+00'")[0]["n"]
check("usuários que usaram = os da auditoria", d and len(d["linhas"]) == cnt, (len(d["linhas"]) if d else None, cnt))
ativos = sql("select count(*) n from public.usuarios where ativo and upper(perfil) in ('MASTER','ANALISTA','VENDEDOR','GERENTE','DIRETOR NOVOS','DIRETOR SEMINOVOS')")[0]["n"]
check("elegíveis = usuários ativos dos perfis liberados", d and len(d["elegiveis"]) == ativos, (len(d["elegiveis"]) if d else None, ativos))
dias = sql("select count(distinct (created_at at time zone 'America/Sao_Paulo')::date) n from public.bi_audit_log")[0]["n"]
check("ninguém com mais dias do que a auditoria tem", d and max(x["dias"] for x in d["linhas"]) <= dias)
d2 = j(roda("MASTER", "select set_config('t.x', '1', true); " + "select public.bi_registrar_pergunta('sessao-nova', 'voz', array[]::text[], 'ok', 1500); " + Q.replace("select public.master", "select public.master", 1),
            prep=""))
check("depois de 1 registro real: começa o registro e a pergunta sem ferramenta vira 'Conversa (sem ferramenta)'",
      d2 and d2["registro_iniciado_em"] and any(x["temas"].get("Conversa (sem ferramenta)") for x in d2["linhas"]), d2 and d2["registro_iniciado_em"])
for p in ("ANALISTA", "VENDEDOR"):
    r = roda(p, Q); check(f"{p} não acessa a tela (42501)", r[0] == "erro" and r[1] == "42501", r[:2])

print("== permissões e auditoria")
r = sql("begin; " + NOVO + """
  select (select bool_or(has_function_privilege('anon', p.oid, 'execute')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('master_ia_usage_data','bi_registrar_pergunta','bi_acesso_liberado','_bi_tema_ferramenta','_bi_perfis_liberados','_bi_perfil_normalizado')) anon_executa,
         (select bool_or(has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('_bi_tema_ferramenta','_bi_perfis_liberados','_bi_perfil_normalizado')) logado_executa_internas,
         has_table_privilege('authenticated', 'public.bi_uso_perguntas', 'select,insert,update,delete') logado_tabela,
         has_table_privilege('anon', 'public.bi_uso_perguntas', 'select') anon_tabela,
         (select relrowsecurity from pg_class where oid = 'public.bi_uso_perguntas'::regclass) rls,
         (select count(*) from public.bi_audit_log where parametros ? 'pergunta' and parametros->>'pergunta' not like '[texto removido%') textos_restantes,
         (select count(*) from public.bi_audit_log where parametros->>'pergunta' like '[texto removido%') removidos,
         (select count(*) from public.bi_audit_log where not (ferramenta = 'consultar_manual' and parametros ? 'pergunta')) resto_n,
         (select md5(string_agg(id::text || md5(coalesce(parametros::text, '')) || ferramenta || status, '|' order by id)) from public.bi_audit_log where not (ferramenta = 'consultar_manual' and parametros ? 'pergunta')) resto_h,
         (select count(*) from public.auditoria where tipo = 'BI_TEXTO_REMOVIDO') registro_remocao,
         (select count(*) from public.bi_audit_log where parametros ? 'pessoa' or parametros ? 'vendedor') nomes_mantidos; rollback;""")[0]
b = json.load(open(os.path.join(AQUI, "ia_backup_antes.json"), encoding="utf-8"))
NOMES_ANTES = sql("select count(*) n from public.bi_audit_log where parametros ? 'pessoa' or parametros ? 'vendedor'")[0]["n"]
check("nenhuma função nova executável por visitante; funções internas fora do alcance do logado", r["anon_executa"] is False and r["logado_executa_internas"] is False, r)
check("tabela sem acesso para visitante/logado e com RLS", r["logado_tabela"] is False and r["anon_tabela"] is False and r["rls"] is True)
check("texto das 2 perguntas removido (0 restantes, 2 marcados)", r["textos_restantes"] == 0 and r["removidos"] == 2, (r["textos_restantes"], r["removidos"]))
check("resto da auditoria intacto (mesmo conteúdo) e nomes de colegas mantidos", r["resto_n"] == b["bi_audit_log_resto_md5"]["n"] and r["resto_h"] == b["bi_audit_log_resto_md5"]["h"] and r["nomes_mantidos"] == NOMES_ANTES, (r["resto_n"], r["nomes_mantidos"]))
check("remoção registrada em auditoria (+1)", r["registro_remocao"] == b["auditoria_BI_TEXTO_REMOVIDO"] + 1)

print("== desfazer")
EST = ("select (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname in ('master_ia_usage_data','bi_registrar_pergunta','bi_acesso_liberado','_bi_tema_ferramenta','_bi_perfis_liberados','_bi_perfil_normalizado')) funcoes, "
       "to_regclass('public.bi_uso_perguntas') is not null tabela, (select count(*) from public.configuracoes where chave = 'ia_perfis_liberados') config")
a, dd, v = sql("begin; " + EST + "; rollback;")[0], sql("begin; " + NOVO + "\n" + EST + "; rollback;")[0], sql("begin; " + NOVO + "\n" + VOLTA + "\n" + EST + "; rollback;")[0]
check("com a mudança: 6 funções, tabela e configuração", dd == {"funcoes": 6, "tabela": True, "config": 1}, dd)
check("aplicar + desfazer = sem funções, tabela e configuração novas (o texto removido não volta, de propósito)", v == a == {"funcoes": 0, "tabela": False, "config": 0}, (a, v))
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

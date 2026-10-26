"""Conferência em PRODUÇÃO da utilização da Brabus IA (26/10/2026), depois de aplicar ia_uso.sql.
Usuários reais (Master/Analista/Vendedor/Gerente/Diretor) e um RH FALSO criado numa transação com ROLLBACK.
O registro de pergunta é testado em transação com ROLLBACK (nada fica gravado). Só contagens e sim/não."""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI); sys.path.insert(0, AQUI); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
RH_FALSO = "11111111-2222-4333-8444-555555555555"
SUB = {p: f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{p}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
       for p in ("MASTER", "ANALISTA", "VENDEDOR", "GERENTE", "DIRETOR NOVOS")}
SUB["RH"] = f"'{RH_FALSO}'::uuid"
PREP_RH = f"insert into public.usuarios (cpf, nome, perfil, ativo, auth_user_id) values ('00000000000', 'Usuário RH de teste (falso)', 'RH', true, '{RH_FALSO}'::uuid);"
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:200]}]" if x != "" else ""))
def roda(perfil, consulta, prep="", so_leitura=True):
    q = ("begin; " + ("set transaction read only; " if so_leitura and not prep else "") + "set local statement_timeout='120s'; " + prep +
         "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB[perfil] + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; " + consulta + "; rollback;")
    try: return ("ok", sql(q))
    except RuntimeError as e:
        s = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", s)
        return ("erro", m.group(1) if m else "?", (m.group(2) if m else s[:300]).strip().rstrip("\\"))
def j(r): return json.loads(r[1][0]["j"]) if r[0] == "ok" else None
cfg = sql("select valor from public.configuracoes where chave = 'ia_perfis_liberados'")
check("configuração ia_perfis_liberados gravada (todos exceto RH/DP)", cfg and cfg[0]["valor"] == "MASTER,ANALISTA,VENDEDOR,GERENTE,DIRETOR_NOVOS,DIRETOR_SEMINOVOS", cfg)
for p in ("MASTER", "ANALISTA", "VENDEDOR", "GERENTE", "DIRETOR NOVOS"):
    r = j(roda(p, "select public.bi_acesso_liberado()::text j")); check(f"{p}: liberado", r and r["liberado"] is True, r)
r = j(roda("RH", "select public.bi_acesso_liberado()::text j", prep=PREP_RH)); check("RH (falso): não liberado", r and r["liberado"] is False, r)
r = roda("VENDEDOR", "select public.bi_registrar_pergunta('teste-pos', 'texto', array['simular_financiamento'], 'ok', 1000)", so_leitura=False)
check("Vendedor registra pergunta (em rollback)", r[0] == "ok", r[:3])
r = roda("RH", "select public.bi_registrar_pergunta('teste-pos', 'texto', null, 'ok', 1)", prep=PREP_RH); check("RH não registra (42501)", r[0] == "erro" and r[1] == "42501", r[:2])
for p in ("VENDEDOR", "ANALISTA", "MASTER"):
    r = roda(p, "select count(*) n from public.bi_uso_perguntas"); check(f"{p} não lê a tabela direto", r[0] == "erro" and r[1] == "42501", r[:2])
d = j(roda("MASTER", "select public.master_ia_usage_data('2026-10-01'::date, '2026-10-26'::date)::text j"))
check("Master lê a utilização (21 usuários, 93 elegíveis, histórico estimado)", d and len(d["linhas"]) == 21 and len(d["elegiveis"]) == 93 and d["registro_iniciado_em"] is None,
      d and (len(d["linhas"]), len(d["elegiveis"]), sum(x["perguntas"] for x in d["linhas"])))
for p in ("ANALISTA", "VENDEDOR"):
    r = roda(p, "select public.master_ia_usage_data('2026-10-01'::date, '2026-10-26'::date)::text j"); check(f"{p} não acessa a utilização", r[0] == "erro" and r[1] == "42501", r[:2])
a = sql("select (select count(*) from public.bi_audit_log where parametros ? 'pergunta' and parametros->>'pergunta' not like '[texto removido%') restantes, "
        "(select count(*) from public.bi_audit_log where parametros->>'pergunta' like '[texto removido%') removidos, "
        "(select count(*) from public.auditoria where tipo = 'BI_TEXTO_REMOVIDO') registrado, "
        "(select md5(string_agg(id::text || md5(coalesce(parametros::text, '')) || ferramenta || status, '|' order by id)) from public.bi_audit_log where not (ferramenta = 'consultar_manual' and parametros ? 'pergunta')) resto_h")[0]
b = json.load(open(os.path.join(AQUI, "ia_backup_antes.json"), encoding="utf-8"))
check("auditoria: 0 textos, 2 removidos, remoção registrada, resto intacto", a["restantes"] == 0 and a["removidos"] == 2 and a["registrado"] == 1 and a["resto_h"] == b["bi_audit_log_resto_md5"]["h"], a)
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

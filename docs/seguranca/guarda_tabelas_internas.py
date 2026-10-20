"""GUARDA (item 2, 20/10/2026) — rodar depois de TODA mudança no banco e de toda publicação do portal.
Falha (código de saída 1) se alguém logado ou visitante voltar a conseguir ler/gravar direto as tabelas internas.
Só leitura: cada teste prático roda em transação READ ONLY + ROLLBACK. Não imprime dados, só sim/não e contagens.
Uso: python -I guarda_tabelas_internas.py [pasta de um clone ligado ao projeto; padrão = a pasta deste repositório]"""
import io, json, os, subprocess, sys, tempfile
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
PROJETO = "yacqlelpzchcotgngwbh"
CWD = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
TABELAS = ["configuracoes", "periodos_comissao", "ausencias_analistas", "mudancas_loja_vendedores", "analistas_fi", "chamar_analista_fi_controle"]
PAPEIS = ("anon", "authenticated")

def q(sql):
    fd, f = tempfile.mkstemp(prefix="guarda_", suffix=".sql")
    with os.fdopen(fd, "w", encoding="utf-8") as h: h.write(sql)
    try:
        r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", PROJETO, "--output-format", "json", "-f", f],
                           cwd=CWD, capture_output=True, text=True, encoding="utf-8", errors="replace", shell=(os.name == "nt"), timeout=300)
    finally: os.remove(f)
    s = r.stdout + r.stderr
    if '"rows"' not in s: return None, s
    return json.loads(s[s.index("{"):s.rindex("}") + 1])["rows"], s

ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{x}]" if x != "" else ""))

lista = ", ".join("'" + t + "'" for t in TABELAS)
linhas, bruto = q(f"""select c.relname,
  c.relrowsecurity rls,
  {" or ".join(f"has_table_privilege('{p}', c.oid, 'select,insert,update,delete,truncate,references,trigger')" for p in PAPEIS)} acesso_api,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
     and p.roles && array['anon','authenticated','public']::name[]) regras_api
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ({lista}) order by 1""")
if linhas is None: print("ERRO ao consultar o banco:", bruto[-400:]); sys.exit(2)
achadas = {l["relname"]: l for l in linhas}
for t in TABELAS:
    l = achadas.get(t)
    if l is None: check(f"{t}: existe", t == "chamar_analista_fi_controle", "ainda não criada"); continue
    check(f"{t}: sem permissão para visitante/logado, RLS ligada, nenhuma regra para eles",
          l["acesso_api"] is False and l["rls"] is True and l["regras_api"] == 0, f"acesso={l['acesso_api']} rls={l['rls']} regras={l['regras_api']}")

f, _ = q("select has_function_privilege('anon', 'public.chamar_analista_fi()', 'execute') anon_chama, "
         "has_function_privilege('authenticated', 'public.chamar_analista_fi()', 'execute') logado_chama")
check("chamar_analista_fi: visitante não chama; logado chama", f and f[0]["anon_chama"] is False and f[0]["logado_chama"] is True, f)

for perfil in ("VENDEDOR", "ANALISTA", "MASTER"):
    sub = f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{perfil}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
    negadas = 0
    for t in [x for x in TABELAS if x in achadas]:
        r, s = q("begin; set transaction read only; "
                 "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub + ", 'role','authenticated')::text, true); end $x$; "
                 f"set local role authenticated; select count(*) n from public.{t}; rollback;")
        negadas += (r is None and "42501" in s)
    check(f"{perfil} real: leitura direta negada em {negadas}/{len([x for x in TABELAS if x in achadas])} tabelas", negadas == len([x for x in TABELAS if x in achadas]))

print(f"\n{sum(ok)}/{len(ok)} verificações OK")
sys.exit(0 if all(ok) else 1)

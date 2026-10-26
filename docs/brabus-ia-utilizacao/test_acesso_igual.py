"""Acesso à Brabus IA: decisão de HOJE (segredo BI_PERFIS + perfil calculado pela função a partir de operational_current_scope)
x decisão NOVA (bi_acesso_liberado, lista do banco), para CADA usuário do cadastro e para perfis que hoje não existem
(usuários FALSOS criados na transação). Tudo em uma transação com ROLLBACK. Não imprime nomes: só perfil e contagens."""
import io, json, os, sys, collections
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
SEGREDO_HOJE = "MASTER,DIRETOR,GERENTE,ANALISTA,VENDEDOR"   # BI_PERFIS (identificado pelo digest do segredo em 26/10/2026)

def perfil_da_funcao(bruto):   # cópia fiel de carregaContexto (data/contexto.ts)
    b = str(bruto or "").upper()
    return "DIRETOR" if b.startswith("DIRETOR") else (b if b in ("MASTER", "GERENTE", "ANALISTA", "VENDEDOR", "RH") else "VENDEDOR")
def decisao_hoje(escopo_ok, bruto):   # cópia fiel da regra antiga do index.ts
    if not escopo_ok: return False    # sem cadastro/escopo: carregaContexto falha → 403 hoje
    lib = [s.strip().upper() for s in SEGREDO_HOJE.split(",")]
    return perfil_da_funcao(bruto) in lib or str(bruto or "").upper() in lib

# os 8 perfis que o cadastro aceita (usuarios_perfil_check) + 1 inativo; perfil fora disso o banco nem grava
FALSOS = [(p, True) for p in ("VENDEDOR", "GERENTE", "ANALISTA", "MASTER", "DIRETOR NOVOS", "DIRETOR SEMINOVOS", "RECURSOS HUMANOS", "RH")] + [("VENDEDOR", False)]
prep = "".join(f"insert into public.usuarios (cpf, nome, perfil, ativo, auth_user_id, loja, status) values ('0000000001{i}', 'Teste falso {i}', '{p}', {str(a).lower()}, '00000000-0000-4000-8000-0000000000{i:02d}'::uuid, 'BARRA FUNDA', 'NOVOS');"
               for i, (p, a) in enumerate(FALSOS))
q = ("begin; " + prep + """
create temp table r (uid uuid, perfil text, ativo boolean, falso boolean, escopo_ok boolean, bruto text, novo boolean) on commit drop;
do $x$ declare u record; v_esc jsonb; v_ok boolean; v_novo boolean; begin
  for u in select auth_user_id, perfil, ativo, nome like 'Teste falso %' falso from public.usuarios where auth_user_id is not null loop
    perform set_config('request.jwt.claims', json_build_object('sub', u.auth_user_id, 'role', 'authenticated')::text, true);
    begin v_esc := public.operational_current_scope(); v_ok := true; exception when others then v_esc := null; v_ok := false; end;
    v_novo := coalesce((public.bi_acesso_liberado()->>'liberado')::boolean, false);
    insert into r values (u.auth_user_id, u.perfil, u.ativo, u.falso, v_ok, v_esc->>'profile', v_novo);
  end loop; end $x$;
select json_agg(json_build_object('perfil', perfil, 'ativo', ativo, 'falso', falso, 'escopo_ok', escopo_ok, 'bruto', bruto, 'novo', novo))::text j from r; rollback;""")
linhas = json.loads(sql(q)[0]["j"])
tab = collections.Counter(); difs = []
for l in linhas:
    hoje = decisao_hoje(l["escopo_ok"], l["bruto"]); novo = bool(l["novo"])
    chave = ("FALSO " if l["falso"] else "") + f"{l['perfil']} ({'ativo' if l['ativo'] else 'inativo'})"
    tab[(chave, l["bruto"] if l["escopo_ok"] else "sem escopo", "libera" if hoje else "nega", "libera" if novo else "nega")] += 1
    if hoje != novo: difs.append((chave, l["bruto"], hoje, novo))
print(f"{'perfil no cadastro':34} {'perfil do escopo':20} {'HOJE':7} {'NOVO':7} usuários")
for (c, b, h, n), k in sorted(tab.items()): print(f"{c:34} {str(b):20} {h:7} {n:7} {k}{'   ← DIFERENTE' if h != n else ''}")
reais = [l for l in linhas if not l["falso"]]
dif_reais = [d for d in difs if not d[0].startswith("FALSO")]
print(f"\nusuários reais comparados: {len(reais)} (ativos {sum(1 for l in reais if l['ativo'])}) | com acesso diferente: {len(dif_reais)}")
print("casos hipotéticos (usuários falsos) com diferença:", [d for d in difs if d[0].startswith("FALSO")])
print("RESULTADO:", "MESMO ACESSO PARA TODOS OS USUÁRIOS REAIS" if not dif_reais else "HÁ DIFERENÇA EM USUÁRIO REAL")

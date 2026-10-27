"""Convidar e editar um Vendedor (como o Master faz na tela), em ROLLBACK: nada fica gravado.
Grava o resultado em <saida.json> para comparar antes x depois da Fase 1 das Avaliações.
Dados fictícios (CPF 00000000353, e-mail @exemplo.invalido); ids e datas são removidos da comparação."""
import json, os, sys, time
sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sq import q

M = "(select u.auth_user_id::text from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
V = "(select u.auth_user_id::text from public.usuarios u where upper(u.perfil)='VENDEDOR' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
COMO = lambda s: ("do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + s +
                  ", 'role','authenticated')::text, true); end $x$; set local role authenticated; ")
def bloco(nome, expr):
    nq = "$n$" + nome + "$n$"
    return (f"do $b$ declare r text; begin begin r := ({expr})::text; insert into _t(nome, ok, valor) values ({nq}, true, r); "
            f"exception when others then insert into _t(nome, ok, valor) values ({nq}, false, sqlstate || ' ' || sqlerrm); end; end $b$; ")
LINHA = ("(select jsonb_build_object('perfil', perfil, 'loja', loja, 'status', status, 'ativo', ativo, 'primeiro_acesso', primeiro_acesso, "
         "'nome', nome, 'cpf_normalizado', cpf_normalizado, 'email', email_auth, 'login_nbs', login_nbs) from public.usuarios where cpf_normalizado='00000000353')")
CONV = "(select jsonb_build_object('status', status, 'perfil', perfil, 'loja', loja, 'nbs', nbs) from public.convites_usuario where cpf='00000000353')"

sql = ("begin; create temp table _t(n serial, nome text, ok boolean, valor text) on commit drop; "
       "grant all on _t to authenticated; grant all on sequence _t_n_seq to authenticated; "
       "create temp table _id(id uuid) on commit drop; grant all on _id to authenticated; ")
sql += COMO(M)
sql += bloco("convidar vendedor sem departamento", "public.master_convidar_usuario('00000000353','Teste Vendedor','VENDEDOR','NACOES','teste.vendedor@exemplo.invalido')")
sql += bloco("convidar perfil inexistente", "public.master_convidar_usuario('00000000353','Teste Vendedor','XYZ','NACOES','teste.vendedor@exemplo.invalido', null, 'SEMINOVOS')")
sql += bloco("convidar vendedor loja inválida", "public.master_convidar_usuario('00000000353','Teste Vendedor','VENDEDOR','REVENDA','teste.vendedor@exemplo.invalido', null, 'SEMINOVOS')")
sql += bloco("convidar vendedor ok", "(public.master_convidar_usuario('00000000353','Teste Vendedor','VENDEDOR','NACOES','teste.vendedor@exemplo.invalido', null, 'SEMINOVOS') - 'convite_id' - 'usuario_id')")
sql += bloco("convidar de novo (CPF duplicado)", "public.master_convidar_usuario('00000000353','Teste Vendedor','VENDEDOR','NACOES','outro@exemplo.invalido', null, 'SEMINOVOS')")
sql += "reset role; insert into _id select id from public.usuarios where cpf_normalizado='00000000353'; " + COMO(M)
sql += "reset role; " + bloco("linha usuarios após convite", LINHA) + bloco("linha convite", CONV) + COMO(M)
sql += bloco("editar perfil inexistente", "public.master_atualizar_autorizacao_usuario((select id from _id), 'XYZ', 'EUROPA', 'NOVOS', true)")
sql += bloco("editar vendedor (loja, departamento, ativo)", "public.master_atualizar_autorizacao_usuario((select id from _id), 'vendedor', 'EUROPA', 'NOVOS/SEMINOVOS', true)")
sql += "reset role; " + bloco("linha usuarios após edição", LINHA) + COMO(M)
sql += bloco("editar para gerente e inativo", "public.master_atualizar_autorizacao_usuario((select id from _id), 'GERENTE', 'ABC', 'SEMINOVOS', false)")
sql += "reset role; " + bloco("linha usuarios após 2ª edição", LINHA)
sql += bloco("auditoria gerada (tipos)", "(select jsonb_agg(tipo order by id) from public.auditoria where cpf in ('00000000353') or vendedor = 'Teste Vendedor')")
sql += COMO(V) + bloco("vendedor real: módulos liberados", "public.portal_modulos_permitidos()") + \
       bloco("vendedor real: convidar (deve negar)", "public.master_convidar_usuario('00000000353','X','VENDEDOR','NACOES','x@exemplo.invalido', null, 'SEMINOVOS')")
sql += " reset role; select nome, ok, valor from _t order by n; rollback;"

for i in range(6):
    try: rows = q(sql); break
    except RuntimeError as e:
        if "emp" in str(e).lower() and i < 5: time.sleep(4); continue
        raise
json.dump(rows, open(sys.argv[1], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for r in rows: print(("OK  " if r["ok"] else "ERR ") + r["nome"] + " -> " + str(r["valor"])[:200])
if len(sys.argv) > 2:
    antes = json.load(open(sys.argv[2], encoding="utf-8"))
    dif = [(a["nome"], a["valor"], b["valor"]) for a, b in zip(antes, rows) if (a["ok"], a["valor"]) != (b["ok"], b["valor"])]
    print("\nCOMPARAÇÃO com", os.path.basename(sys.argv[2]) + ":", "IGUAL em todas as", len(rows), "verificações" if not dif and len(antes) == len(rows) else f"{len(dif)} diferença(s)")
    for d in dif: print("  DIFERENTE:", d)
print("estado real: usuários de teste =", q("select count(*) n from public.usuarios where cpf_normalizado='00000000353'")[0]["n"])

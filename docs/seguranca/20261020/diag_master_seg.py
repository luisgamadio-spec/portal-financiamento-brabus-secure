"""master_admin_security_data: agora (mudança aplicada) x estado anterior recriado pelo desfazer, no MESMO instante, numa transação com ROLLBACK."""
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql
s = open(os.path.join(AQUI, "seg5_rollback.sql"), encoding="utf-8", newline="").read(); VOLTA = s[s.index("begin;") + 6:s.rindex("commit;")]
MASTER = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
AS = ("\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + MASTER + ", 'role','authenticated')::text, true); end $x$; set local role authenticated; ")
POR_CHAVE = "select k, md5(v::text) h, jsonb_typeof(v) t, case when jsonb_typeof(v)='array' then jsonb_array_length(v) end n from jsonb_each(public.master_admin_security_data()) e(k, v) order by k"
agora = sql("begin; set transaction read only; " + AS + POR_CHAVE + "; rollback;")
antes = sql("begin; " + VOLTA + AS + POR_CHAVE + "; rollback;")
A = {r["k"]: r for r in antes}; N = {r["k"]: r for r in agora}
print("chaves:", len(N), "| diferentes agora x estado anterior (mesmo instante):", [k for k in N if N[k] != A.get(k)] or "nenhuma")
mud = sql("begin; set transaction read only; " + AS + "select k, jsonb_typeof(v) t, case when jsonb_typeof(v)='array' then jsonb_array_length(v) end n from jsonb_each(public.master_admin_security_data()) e(k, v) order by k; rollback;")
print("formato (sem dados):", [(r["k"], r["t"], r["n"]) for r in mud])

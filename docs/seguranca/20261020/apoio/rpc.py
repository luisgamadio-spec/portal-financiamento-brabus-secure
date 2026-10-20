"""Chama RPCs do Portal como MASTER, em transação SOMENTE LEITURA + rollback. Salva o jsonb bruto no scratchpad (nunca em repo)."""
import subprocess, json, sys, os

REPO = r"C:\Projetos\portal-financiamento-brabus-secure"
OUT = os.path.dirname(os.path.abspath(__file__))

def sql(q, timeout=300, tentativas=6):
    import time as _t
    for n in range(tentativas):
        r = subprocess.run(["supabase", "db", "query", "--linked", "--output-format", "json", q], cwd=REPO,
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
        s = r.stdout + r.stderr
        # a CLI recria um papel temporário de login; duas execuções simultâneas colidem -> repetir
        if "LegacyDbConfigConnectTempRole" not in s:
            break
        _t.sleep(4 + 3 * n)
    i = s.find("{")
    if i < 0:
        raise RuntimeError(s[:800])
    obj, _ = json.JSONDecoder().raw_decode(s[i:])
    if "rows" not in obj:
        raise RuntimeError(s[:800])
    return obj["rows"]

MASTER = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"

def rpc(fn, ini, fim, group_view=True):
    q = ("begin; set transaction read only; set local statement_timeout='120s'; "
         "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + MASTER + ", 'role','authenticated')::text, true); end $x$; "
         "set local role authenticated; "
         f"select public.{fn}('{ini}'::date, '{fim}'::date, {str(group_view).lower()}) as r; rollback;")
    rows = sql(q)
    r = rows[0]["r"]
    return json.loads(r) if isinstance(r, str) else r

if __name__ == "__main__":
    fn, ini, fim, nome = sys.argv[1:5]
    data = rpc(fn, ini, fim)
    json.dump(data, open(os.path.join(OUT, nome), "w", encoding="utf-8"), ensure_ascii=False)
    def shape(o, d=0):
        if isinstance(o, dict):
            return {k: shape(v, d + 1) if d < 2 else type(v).__name__ for k, v in o.items()}
        if isinstance(o, list):
            return [f"list[{len(o)}]", shape(o[0], d + 1) if o else None]
        return type(o).__name__
    print(json.dumps(shape(data), ensure_ascii=False)[:3000])

"""Harness de teste do V2 (somente leitura):
- serve uma pasta local COMO SE fosse o site publicado (hostname real do homolog -> config/ambiente reais);
- login e Turnstile simulados (perfil MASTER; nenhuma credencial real);
- toda RPC de leitura é respondida com o resultado REAL do banco, como MASTER, em transação somente leitura (cache por chamada)."""
import base64, json, os, sys, time, itertools, mimetypes, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rpc import sql, MASTER

REAL = "https://yacqlelpzchcotgngwbh.supabase.co"
HOMOLOG = os.environ.get("NX_BASE", "https://luisgamadio-spec.github.io/portal-fi-v2-homolog/")
D = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(D, "rpc_cache"); os.makedirs(CACHE, exist_ok=True)
BLOQUEADAS = ("master_", "gestor_salvar", "gestor_alterar", "gestor_encerrar", "atualizar_", "chamar_", "_commit", "_import", "_begin", "_finalize", "_close", "_reopen", "_resolver", "_ignorar", "_excluir", "_criar", "_revogar", "_convidar", "_reenviar", "_gerar", "_manage", "_update")
LEITURA_MASTER_OK = ("master_admin_reference_data", "master_admin_security_data", "master_listar_", "master_cadastro_alertas_listar", "master_cadastro_excecoes_listar", "master_simulador_listar_bases", "master_simulator_usage_data", "master_commission_closings", "master_operational_list_")

def b64(d): return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
_ret = {}
def retset(fn):
    if fn not in _ret:
        r = sql(f"select p.proretset rs, format_type(p.prorettype, null) t from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='{fn}' limit 1")
        _ret[fn] = (r[0]["rs"], r[0]["t"]) if r else (None, None)
    return _ret[fn]
def lit(v):
    if v is None: return "null"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, (dict, list)): return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"
def rpc_real(fn, body, sub=None):
    """sub: auth_user_id (uuid em texto SQL) do usuário a assumir, só leitura; padrão = MASTER."""
    sub = sub or MASTER
    chave = hashlib.md5((fn + json.dumps(body, sort_keys=True) + ("" if sub == MASTER else sub)).encode()).hexdigest()
    arq = os.path.join(CACHE, chave + ".json")
    if os.path.exists(arq): return json.load(open(arq, encoding="utf-8"))
    rs, tipo = retset(fn)
    if rs is None: return {"status": 404, "body": {"message": f"function {fn} not found"}}
    args = ", ".join(f"{k} => {lit(v)}" for k, v in body.items())
    sim = os.environ.get("NX_SIM_SQL")  # arquivo com DDL proposta: roda na MESMA transação e faz ROLLBACK (nada fica gravado)
    if sim and fn in os.environ.get("NX_SIM_FNS", "").split(","):
        corpo = open(sim, encoding="utf-8").read(); corpo = corpo[corpo.index("begin;") + 6:corpo.rindex("commit;")]
        rs, tipo = retset(fn) if retset(fn)[0] is not None else (False, "jsonb")
        args = ", ".join(f"{k} => {lit(v)}" for k, v in body.items())
        q = ("begin; set local statement_timeout='60s'; " + corpo +
             "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub + ", 'role','authenticated')::text, true); end $x$; "
             f"set local role authenticated; select coalesce(public.{fn}({args})::text, 'null') j; rollback;")
        sys.path.insert(0, os.path.join(os.path.dirname(D), "hpe_v3")); from sq import q as sql_f
        try: return {"status": 200, "body": json.loads(sql_f(q)[0]["j"])}
        except Exception as e:
            import re as _re; m = _re.search(r"ERROR:\s+(\w{5}):\s*([^\\\n]+)", str(e))
            return {"status": 400, "body": {"code": m.group(1) if m else "XX000", "message": (m.group(2) if m else str(e)[:200])}}
    pre = ("begin; set transaction read only; set local statement_timeout='8s'; "
           "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub + ", 'role','authenticated')::text, true); end $x$; "
           "set local role authenticated; ")
    if rs: q = f"select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text j from public.{fn}({args}) t"
    elif tipo in ("jsonb", "json"): q = f"select coalesce(public.{fn}({args})::text, 'null') j"
    else: q = f"select to_jsonb(public.{fn}({args}))::text j"
    try:
        r = {"status": 200, "body": json.loads(sql(pre + q + "; rollback;", timeout=120)[0]["j"])}
    except Exception as e:
        msg = str(e); import re as _re
        m = _re.search(r"ERROR:\s+(\w{5}):\s*([^\\\n]+)", msg)
        r = {"status": 400, "body": {"code": m.group(1) if m else "XX000", "message": (m.group(2) if m else msg[:200])}}
    if r["status"] == 200:  # erro (ex.: colisão do CLI) nunca fica em cache
        json.dump(r, open(arq, "w", encoding="utf-8"), ensure_ascii=False)
    return r

class Fake:
    def __init__(self, perfil="MASTER", modulos=None, sub=None, loja=""):
        self.n = itertools.count(1); self.perfil = perfil; self.modulos = modulos or []; self.chamadas = []; self.bloqueadas = []
        self.sub = sub; self.loja = loja  # sub: assume esse usuário real nas RPCs (só leitura)
    def handle(self, route):
        req = route.request; url = req.url
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*"}
        if req.method == "OPTIONS": return route.fulfill(status=200, headers=cors)
        def resp(st, js): route.fulfill(status=st, content_type="application/json", headers=cors, body=json.dumps(js))
        corpo = {}
        try: corpo = json.loads(req.post_data or "{}")
        except Exception: pass
        if "/auth/v1/token" in url:
            agora = int(time.time()); n = next(self.n)
            at = b64({"alg": "HS256", "typ": "JWT"}) + "." + b64({"sub": "u-1", "session_id": "s1", "exp": agora + 3600, "role": "authenticated", "aud": "authenticated", "n": n}) + ".sig"
            return resp(200, {"access_token": at, "token_type": "bearer", "expires_in": 3600, "expires_at": agora + 3600, "refresh_token": f"rt-{n}",
                              "user": {"id": "u-1", "aud": "authenticated", "role": "authenticated", "email": "teste@exemplo.com", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}})
        if "/auth/v1/logout" in url: return route.fulfill(status=204, headers=cors, body="")
        if "/auth/v1/user" in url: return resp(200, {"id": "u-1", "email": "teste@exemplo.com", "aud": "authenticated"})
        if "/rest/v1/rpc/usuario_logado_fi" in url:
            return resp(200, [{"usuario_id": 1, "auth_user_id": "u-1", "nome": "Usuário de Teste", "perfil": self.perfil, "loja": self.loja, "status": "ATIVO", "ativo": True}])
        if "/rest/v1/rpc/portal_modulos_permitidos" in url: return resp(200, self.modulos)
        if "/rest/v1/rpc/registrar_meu_login" in url: return resp(200, None)  # escrita: no-op no teste
        if "/rest/v1/rpc/" in url:
            fn = url.split("/rest/v1/rpc/")[1].split("?")[0]
            if any(b in fn for b in BLOQUEADAS) and not any(fn.startswith(o) for o in LEITURA_MASTER_OK):
                self.bloqueadas.append(fn); return resp(403, {"code": "42501", "message": "bloqueado no teste (escrita)"})
            t = time.time(); r = rpc_real(fn, corpo, self.sub); self.chamadas.append((fn, round(time.time() - t, 2), r["status"]))
            return resp(r["status"], r["body"])
        if "/functions/v1/" in url: return resp(200, {"liberado": True} if corpo.get("verificar_acesso") else {"resposta": "Resposta de teste.", "blocos": []})
        return resp(200, [])

def contexto(br, pasta, fake, largura=1366, altura=900, fonte=None):
    ctx = br.new_context(viewport={"width": largura, "height": altura})
    ini = "try { localStorage.setItem('nxLaunchExperienceSeenV1', '1'); } catch (e) {}"
    if fonte: ini += f" try {{ localStorage.setItem('nxFonte', '{fonte}'); }} catch (e) {{}}"
    ctx.add_init_script(ini)
    def local(route):
        rel = route.request.url[len(HOMOLOG):].split("?")[0].split("#")[0] or "index.html"
        p = os.path.join(pasta, rel.replace("/", os.sep))
        if not os.path.isfile(p): return route.fulfill(status=404, body="")
        ct = mimetypes.guess_type(p)[0] or "application/octet-stream"
        if p.endswith(".js"): ct = "application/javascript"
        route.fulfill(status=200, content_type=ct, body=open(p, "rb").read())
    if pasta: ctx.route(HOMOLOG + "**", local)
    ctx.route(REAL + "/**", fake.handle)
    ctx.route("https://challenges.cloudflare.com/**", lambda r: r.fulfill(status=200, content_type="application/javascript", body=
        "window.turnstile = { render: function (el, o) { this._o = o; return 'w1'; }, execute: function () { var o = this._o; setTimeout(function () { o.callback('tok-teste'); }, 10); }, reset: function () {}, remove: function () {} };"))
    return ctx

def entra(pg, base=HOMOLOG):
    pg.goto(base + "index.html#/landing")
    pg.wait_for_function("() => window.NX_AUTH_CORE && ['SIGNED_OUT','AUTHORIZED'].includes(window.NX_AUTH_CORE.getState())", timeout=30000)
    if pg.evaluate("() => window.NX_AUTH_CORE.getState()") != "AUTHORIZED":
        pg.wait_for_selector("#loginEmail", state="visible", timeout=20000)
        pg.fill("#loginEmail", "teste@exemplo.com"); pg.fill("#loginPassword", "senha-certa"); pg.click("#loginSubmit")
        pg.wait_for_function("() => ['AUTHORIZED','INVALID_CREDENTIALS','RPC_ERROR','NETWORK_ERROR'].includes(window.NX_AUTH_CORE.getState())", timeout=30000)
    return pg.evaluate("() => window.NX_AUTH_CORE.getState()")

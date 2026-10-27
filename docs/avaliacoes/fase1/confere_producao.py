"""Conferência da PRODUÇÃO (brabus.blistiq.com.br) depois da Fase 1 das Avaliações, como Master.
O site real é aberto no navegador com uma sessão de Master SIMULADA e TODAS as chamadas ao Supabase são
interceptadas no próprio navegador (nada chega ao banco, nada é gravado). Roda duas vezes:
  ANTES  = lista de módulos do Master sem 'avaliacoes' (como era até 16:09)
  DEPOIS = lista real de hoje (com 'avaliacoes', capturada do banco em ROLLBACK)
e compara o menu lateral, a Landing e o Painel Master > Acessos aos Módulos. Tem que sair igual e sem "Avalia" em lugar nenhum."""
import copy, io, json, os, sys
from playwright.sync_api import sync_playwright
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
AQUI = os.path.dirname(os.path.abspath(__file__))
URL = sys.argv[1] if len(sys.argv) > 1 else "https://brabus.blistiq.com.br/"
real = json.load(open(os.path.join(AQUI, "real_master.json"), encoding="utf-8"))
depois = real
antes = copy.deepcopy(real)
antes["modulos"] = [m for m in antes["modulos"] if m != "avaliacoes"]
antes["acessos"]["modulos"] = [m for m in antes["acessos"]["modulos"] if m.get("id") != "avaliacoes"]
antes["acessos"]["permissoes"] = [p for p in antes["acessos"]["permissoes"] if p.get("modulo_id") != "avaliacoes"]

INIT = """
(() => {
  const MODS = %s;
  const USER = { userId: '00000000-0000-0000-0000-000000000001', authUserId: '00000000-0000-0000-0000-000000000002',
                 nome: 'MASTER SIMULADO', perfil: 'MASTER', loja: '', status: 'MASTER', ativo: true };
  const SESSION = { access_token: 'simulado', user: { id: USER.authUserId } };
  let real;
  Object.defineProperty(window, 'NX_AUTH', { configurable: true,
    get() { return real; },
    set(v) {
      real = Object.assign({}, v, {
        getSession: () => Promise.resolve(SESSION),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        resolveAuthorizedProfile: () => Promise.resolve(USER),
        resolveAllowedModules: () => Promise.resolve(MODS.slice()),
        registerLogin: () => Promise.resolve({ primeiroAcesso: false }),
        getAccessToken: () => Promise.resolve('simulado')
      });
    } });
})();
"""

def roda(b, variante, dados):
    pg = b.new_page(viewport={"width": 1366, "height": 900})
    chamadas, erros = [], []
    pg.on("pageerror", lambda e: erros.append(str(e)))
    def supa(route):
        u = route.request.url
        chamadas.append(u.split(".co", 1)[-1][:80])
        if "/rpc/master_listar_permissoes_modulos" in u:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(dados["acessos"]))
        return route.fulfill(status=200, content_type="application/json", body="[]")
    pg.route("**/*.supabase.co/**", supa)
    pg.add_init_script(INIT % json.dumps(dados["modulos"]))
    pg.goto(URL + "#/landing")
    pg.wait_for_selector(".fNavItem", timeout=20000)
    pg.wait_for_timeout(1500)
    pg.evaluate("document.getElementById('nxLaunchXpRoot') && document.getElementById('nxLaunchXpRoot').remove()")
    landing = pg.inner_text("body")
    nav = pg.evaluate("[...document.querySelectorAll('.pGlobalNav a, .pGlobalNav button')].map(e => e.innerText.trim()).filter(Boolean)")
    itens = pg.evaluate("[...document.querySelectorAll('.fNavItem')].map(e => e.innerText.replace(/\\s+/g,' ').trim())")
    pg.screenshot(path=os.path.join(AQUI, f"{variante}_landing.png"))
    pg.goto(URL + "#/avaliacoes"); pg.wait_for_timeout(1500)
    rota = pg.evaluate("location.hash")
    pg.goto(URL + "#/shell-admin"); pg.wait_for_timeout(3000); pg.screenshot(path=os.path.join(AQUI, f"{variante}_admin.png"))
    pg.evaluate("document.getElementById('nxLaunchXpRoot') && document.getElementById('nxLaunchXpRoot').remove()")
    pg.get_by_text("Acessos aos Módulos", exact=False).first.click(); pg.wait_for_timeout(2500)
    acessos = pg.inner_text("body")
    pg.screenshot(path=os.path.join(AQUI, f"{variante}_acessos.png"), full_page=True)
    html = pg.content()
    pg.close()
    return {"nav": nav, "itens": itens, "landing": landing, "acessos": acessos, "rota_avaliacoes": rota,
            "tem_avalia": ("avalia" in (landing + acessos).lower()) or ("avaliacoes" in html.lower()),
            "chamadas": sorted(set(chamadas)), "erros": erros}

with sync_playwright() as p:
    b = p.chromium.launch()
    A = roda(b, "antes", antes)
    D = roda(b, "depois", depois)
    b.close()

ok = True
def confere(c, nome, det=""):
    global ok
    ok &= bool(c); print(("OK    " if c else "FALHA ") + nome + (f"  [{det}]" if det and not c else ""))
print("módulos simulados ANTES :", antes["modulos"]); print("módulos simulados DEPOIS:", depois["modulos"])
confere(A["nav"] == D["nav"], "menu lateral igual", (A["nav"], D["nav"]))
confere(A["itens"] == D["itens"], f"Landing: mesmos {len(D['itens'])} itens", (A["itens"], D["itens"]))
confere(A["landing"] == D["landing"], "Landing: texto da página idêntico")
confere(A["acessos"] == D["acessos"], "Painel Master > Acessos aos Módulos: texto idêntico")
confere(not D["tem_avalia"] and not A["tem_avalia"], "nenhum 'Avaliações' em nenhuma tela")
confere(D["rota_avaliacoes"] != "#/avaliacoes" or "Avalia" not in D["landing"], "endereço #/avaliacoes não abre módulo", D["rota_avaliacoes"])
confere(not A["erros"] and not D["erros"], "sem erros de JavaScript", (A["erros"], D["erros"]))
print("itens da Landing:", D["itens"])
print("chamadas ao Supabase (todas interceptadas, nenhuma chegou ao banco):", D["chamadas"])
print("\n" + ("PRODUÇÃO IGUAL" if ok else "DIFERENÇA ENCONTRADA"))
sys.exit(0 if ok else 1)

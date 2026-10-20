"""Botão "Falar com um Analista" na tela, logado como Vendedor real, contra a VERSÃO NOVA de chamar_analista_fi:
cada clique roda seg5.sql + um analista FALSO online numa transação com ROLLBACK (nada fica gravado; WhatsApp não abre de verdade).
Uso: python -I test_seg5_tela.py <pasta do clone | "" para o site publicado>"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
from rpc import sql

s = open(os.path.join(AQUI, "seg5.sql"), encoding="utf-8", newline="").read(); NOVO = s[s.index("begin;") + 6:s.rindex("commit;")]
VEND = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='VENDEDOR' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
VEND_ID = VEND.replace("u.auth_user_id from", "u.id from")
FAKE = ("insert into public.analistas_fi (nome, whatsapp, status, ativo, online, ocupado, ordem_fila) "
        "values ('Analista Teste (falso)', '5500000000000', 'ONLINE', true, true, false, -100000);")
PREP = {"livre": FAKE, "recente": FAKE + f" insert into public.chamar_analista_fi_controle values ({VEND_ID}, now() - interval '20 seconds');",
        "vazio": "update public.analistas_fi set online = false;",
        "sem_perfil": FAKE + " update public.permissoes_modulos set permitido = false where perfil = 'VENDEDOR' and modulo_id in ('simuladorCompleto','simuladorSeminovos');"}

class FakeChamar(Fake):
    cenario = "livre"
    def handle(self, route):
        if "/rest/v1/rpc/chamar_analista_fi" not in route.request.url: return super().handle(route)
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*"}
        q = ("begin; set local statement_timeout='30s'; " + NOVO + "\n" + PREP[self.cenario] +
             "\ndo $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + VEND + ", 'role','authenticated')::text, true); end $x$; "
             "set local role authenticated; select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text j from public.chamar_analista_fi() t; rollback;")
        try: st, body = 200, json.loads(sql(q, timeout=180)[0]["j"])
        except RuntimeError as e:
            t = str(e).replace("\\n", "\n"); m = re.search(r"ERROR:\s+(\w{5}):\s*([^\n]+)", t); h = re.search(r"HINT:\s+([A-Z_]+)", t)
            code = m.group(1) if m else "XX000"
            st, body = (403 if code == "42501" else 400), {"code": code, "hint": h.group(1) if h else None, "message": (m.group(2) if m else "erro").rstrip("\\").strip()}
        self.chamadas.append(("chamar_analista_fi", self.cenario, st))
        route.fulfill(status=st, content_type="application/json", headers=cors, body=json.dumps(body))

ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:200]}]" if x != "" else ""))
pasta = sys.argv[1] if len(sys.argv) > 1 else ""
with sync_playwright() as p:
    br = p.chromium.launch()
    fake = FakeChamar(perfil="VENDEDOR", modulos=["simuladorCompleto", "simuladorSeminovos"], sub=VEND)
    ctx = harness.contexto(br, pasta or None, fake); ctx.add_init_script("window.open = function (u) { (window._abertos = window._abertos || []).push(u); return null; };")
    pg = ctx.new_page(); erros = []; pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    harness.entra(pg)

    def clica(sel, cenario):
        fake.cenario = cenario; pg.evaluate("() => { window._abertos = []; const b = document.getElementById('statusAnalistaFI'); if (b) b.textContent = ''; }")
        pg.click(sel)
        pg.wait_for_function("() => { const b = document.getElementById('statusAnalistaFI'); return b && b.textContent && !b.textContent.startsWith('Procurando'); }", timeout=120000)
        pg.wait_for_timeout(1200)
        return pg.inner_text("#statusAnalistaFI"), pg.evaluate("() => window._abertos")

    pg.evaluate("() => { location.hash = '#/simulador-novos'; }"); pg.wait_for_selector("#smAnalystCtaBtn", timeout=60000)
    msg, ab = clica("#smAnalystCtaBtn", "livre")
    check("Simulador Novos: encontra o analista e abre o WhatsApp", "Analista encontrado: Analista Teste (falso)" in msg and ab and ab[0].startswith("https://wa.me/5500000000000"), (msg, ab))
    msg, ab = clica("#smAnalystCtaBtn", "recente")
    check("Simulador Novos: clicar de novo antes de 1 minuto → 'Aguarde um instante para chamar de novo.'", msg == "Aguarde um instante para chamar de novo." and not ab, (msg, ab))
    msg, ab = clica("#smAnalystCtaBtn", "vazio")
    check("Simulador Novos: sem analista online → mensagem de sempre", msg == "Nenhum analista disponível no momento." and not ab, msg)
    msg, ab = clica("#smAnalystCtaBtn", "sem_perfil")
    check("perfil sem Simulador → mensagem clara, sem WhatsApp", "não tem acesso" in msg and not ab, msg)

    pg.evaluate("() => { location.hash = '#/simulador-seminovos'; }"); pg.wait_for_selector("#smAnalystCtaBtn", timeout=60000)
    msg, ab = clica("#smAnalystCtaBtn", "livre")
    check("Simulador Seminovos: encontra o analista e abre o WhatsApp", "Analista encontrado" in msg and ab and "wa.me/5500000000000" in ab[0], (msg, ab))
    pg.evaluate("() => { location.hash = '#/landing'; }"); pg.wait_for_selector("#landingAnalystCtaBtn", timeout=60000)
    msg, ab = clica("#landingAnalystCtaBtn", "livre")
    check("Início do portal: botão encontra o analista e abre o WhatsApp", "Analista encontrado" in msg and ab and "wa.me/5500000000000" in ab[0], (msg, ab))
    check("sem erros de JS", not erros, erros[:2])
    print("chamadas:", fake.chamadas)
    br.close()
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

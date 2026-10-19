"""Tela da Gestão de Bases (Fase 3) no homolog local, com os arquivos reais de hoje.
Homolog = gravações simuladas pela própria tela; só a prévia da Base 03 consulta o banco (dry run, só leitura).
Uso: python -I test_gb_fase3.py <pasta-do-clone ou "">"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
ARQ = os.path.join(AQUI, "arquivos")
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:220]}]" if x != "" else ""))

sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3"))
from sq import q as _q
from rpc import MASTER as _MASTER
def prévia_rollback(corpo):
    """A prévia cria tabelas temporárias: roda numa transação comum com ROLLBACK (o harness padrão é só leitura).
    Mesmo papel (authenticated, Master) e mesmo limite de 8 s do navegador."""
    lit = lambda v: "null" if v is None else ("'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb" if isinstance(v, (list, dict)) else ("true" if v is True else ("false" if v is False else "'" + str(v).replace("'", "''") + "'")))
    sql = ("begin; set local statement_timeout = '8s'; "
           "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + _MASTER + ", 'role','authenticated')::text, true); end $x$; "
           "set local role authenticated; select public.master_operational_apply_base03(" + ", ".join(lit(corpo.get(k)) for k in ("p_original_filename", "p_source_sha256", "p_finance_rows", "p_spf_rows", "p_dry_run")) + ")::text j; rollback;")
    try: return {"status": 200, "body": json.loads(_q(sql)[0]["j"])}
    except Exception as e: return {"status": 400, "body": {"message": str(e)[-200:]}}

class FakeB03(Fake):
    """Libera só a prévia (dry run) da Base 03 e a leitura das durações; qualquer gravação real continua bloqueada."""
    def __init__(self, *a, **k): super().__init__(*a, **k); self.corpos = []
    def handle(self, route):
        u = route.request.url
        if "/rest/v1/rpc/master_operational_apply_base03" in u:
            corpo = json.loads(route.request.post_data or "{}"); self.corpos.append(corpo)
            if corpo.get("p_dry_run") is not True: self.bloqueadas.append("apply_base03 GRAVAÇÃO"); return route.fulfill(status=403, body="{}")
            r = prévia_rollback(corpo); self.chamadas.append(("master_operational_apply_base03", 0, r["status"]))
            return route.fulfill(status=r["status"], content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(r["body"]))
        return super().handle(route)

OBS = """() => { window._textos = []; const ob = new MutationObserver(() => { const t = document.getElementById('gbProgressText'); if (t && window._textos[window._textos.length - 1] !== t.textContent) window._textos.push(t.textContent); });
  ob.observe(document.body, { subtree: true, childList: true, characterData: true }); }"""
with sync_playwright() as p:
    br = p.chromium.launch(); fake = FakeB03(perfil="MASTER", modulos=["painelMaster"])
    ctx = harness.contexto(br, sys.argv[1] or None, fake); pg = ctx.new_page(); erros = []
    pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
    pg.wait_for_selector(".maSectionItemLink[data-section=gestaoBases]", timeout=60000); pg.click(".maSectionItemLink[data-section=gestaoBases]")
    pg.wait_for_selector(".gbUpdateBtn[data-source-type=SALES_CURRENT]", timeout=60000); pg.evaluate(OBS)

    def envia(tipo, arquivo):
        with pg.expect_file_chooser() as fc: pg.click(f".gbUpdateBtn[data-source-type={tipo}]")
        fc.value.set_files(os.path.join(ARQ, arquivo))

    # ---- Base 01: barra por parte, diagnóstico, confirmação simulada
    envia("SALES_CURRENT", "Base 01.xlsx"); pg.wait_for_selector("#gbConfirmarBtn", timeout=120000)
    textos = pg.evaluate("() => window._textos")
    check("Base 01: barra 'Enviando parte X de 5'", any("Enviando parte 1 de 5" in t for t in textos) and any("Enviando parte 5 de 5" in t for t in textos), textos[:3])
    pg.click("#gbConfirmarBtn"); pg.wait_for_selector("#gbSuccessCloseBtn", timeout=60000)
    check("Base 01: sucesso (simulado no homolog)", "SIMULAÇÃO CONCLUÍDA" in pg.inner_text("#nxModalRoot") and "2.096" in pg.inner_text("#nxModalRoot"))
    pg.click("#gbSuccessCloseBtn"); pg.wait_for_selector(".gbUpdateBtn[data-source-type=FINANCE_CURRENT]", timeout=60000); pg.wait_for_timeout(800)

    # ---- Base 02 com falha simulada na parte 2 (estouro de tempo) + tentativa de segundo envio no meio
    pg.evaluate("""() => { const P = window.NX_MASTER_GESTAO_BASES_PROVIDER; const orig = P.importFinance; let n = 0;
      P.importFinance = function (b, rows) { n++; window._tentouSegundo = (function () { let abriu = false; const i = document.getElementById('gbFileInput');
        const c = i.click; i.click = function () { abriu = true; }; window.gbOnAtualizarClick('SPF_CURRENT'); i.click = c; return abriu; })();
        if (n === 2) return new Promise((_, rej) => setTimeout(() => rej({ state: 'RPC_ERROR', codigo: '57014', message: 'canceling statement due to statement timeout' }), 50));
        return orig.apply(this, arguments); }; }""")
    envia("FINANCE_CURRENT", "Base 02.xlsx"); pg.wait_for_selector("#gbErrorCloseBtn", timeout=120000)
    msg = pg.inner_text("#nxModalRoot")
    check("Base 02: falha explicada (parte 2 de 6, base preservada, seguro tentar de novo)",
          "O banco demorou demais para responder (parte 2 de 6)" in msg and "base oficial anterior continua valendo" in msg and "É seguro tentar de novo" in msg, msg.replace("\n", " ")[:200])
    check("Base 02: segundo envio bloqueado durante a importação", pg.evaluate("() => window._tentouSegundo") is False)
    pg.click("#gbErrorCloseBtn"); pg.wait_for_timeout(500)
    check("depois do erro, a tela libera um novo envio", pg.evaluate("() => !document.querySelector('.gbUpdateBtn[data-source-type=SPF_CURRENT]').disabled"))
    pg.evaluate("() => { window.location.hash = '#/shell-admin'; }")

    # ---- Base 03: prévia real sem SPF; gravação em partes + consolidação (simuladas)
    pg.reload(); harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
    pg.wait_for_selector(".maSectionItemLink[data-section=gestaoBases]", timeout=60000); pg.click(".maSectionItemLink[data-section=gestaoBases]")
    pg.wait_for_selector(".gbUpdateBtn[data-source-type=SPF_CURRENT]", timeout=60000); pg.evaluate(OBS)
    envia("SPF_CURRENT", "Base 03.xlsx")
    try: pg.wait_for_selector("#gbConfirmarBtn", timeout=120000)
    except Exception:
        print("MODAL:", pg.inner_text("#nxModalRoot")[:400].replace(chr(10), " ")); print("CHAMADAS:", fake.chamadas[-5:]); raise
    diag = pg.inner_text("#nxModalRoot")
    check("Base 03: prévia real com o enriquecimento", "1.618" in diag and "PRONTO PARA ATUALIZAÇÃO" in diag, diag.replace("\n", " ")[:160])
    check("Base 03: prévia sem mandar as linhas de SPF", fake.corpos and all(c.get("p_dry_run") is True and c.get("p_spf_rows") == [] for c in fake.corpos), [len(c.get("p_spf_rows", [])) for c in fake.corpos])
    pg.click("#gbConfirmarBtn"); pg.wait_for_selector("#gbSuccessCloseBtn", timeout=120000)
    textos = pg.evaluate("() => window._textos")
    check("Base 03: barra 'Enviando parte X de 11' e 'Consolidando'", any("Enviando parte 1 de 11" in t for t in textos) and any("Enviando parte 11 de 11" in t for t in textos) and any("Consolidando" in t for t in textos), textos[-3:])
    fim = pg.inner_text("#nxModalRoot")
    check("Base 03: sucesso com os números da prévia (simulado)", "1.618 financiamento(s)" in fim and "SIMULAÇÃO CONCLUÍDA" in fim, fim.replace("\n", " ")[:160])
    check("nenhuma gravação de chamada única nem gravação real", not fake.bloqueadas and all(c.get("p_dry_run") is True for c in fake.corpos), fake.bloqueadas)
    check("sem erros de JS", not erros, erros[:2])
    pg.set_viewport_size({"width": 390, "height": 844}); pg.wait_for_timeout(400)
    check("celular: sem rolagem lateral", pg.evaluate("() => document.documentElement.scrollWidth") <= 392)
    br.close()
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

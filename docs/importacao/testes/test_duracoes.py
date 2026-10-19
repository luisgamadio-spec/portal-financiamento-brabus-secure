import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
LINHAS = [{"source_type": "SPF_CURRENT", "arquivo": "Base 03.xlsx", "linhas": 5427, "partes": 11, "total_ms": 4200, "maior_chamada_ms": 2600, "resultado": "SUCESSO", "erro": None, "alerta": False, "criado_em": "2026-10-19T15:00:00Z"},
          {"source_type": "FINANCE_CURRENT", "arquivo": "Base 02.xlsx", "linhas": 2897, "partes": 6, "total_ms": 26000, "maior_chamada_ms": 8100, "resultado": "FALHA", "erro": "timeout", "alerta": True, "criado_em": "2026-10-19T13:36:00Z"}]
class F(Fake):
    def handle(self, route):
        if "/rest/v1/rpc/master_operational_list_duracoes" in route.request.url:
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(LINHAS))
        return super().handle(route)
with sync_playwright() as p:
    br = p.chromium.launch(); ctx = harness.contexto(br, sys.argv[1], F(perfil="MASTER", modulos=["painelMaster"])); pg = ctx.new_page()
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin"); pg.wait_for_selector(".maSectionItemLink[data-section=gestaoBases]", timeout=60000)
    pg.click(".maSectionItemLink[data-section=gestaoBases]"); pg.wait_for_selector(".gbDurTabela", timeout=60000)
    t = pg.inner_text(".gbDurTabela")
    print("tabela:", t.replace("\n", " | ")[:300])
    print("linha de alerta marcada:", pg.evaluate("() => document.querySelectorAll('.gbDurTabela tr.gbDurAlerta').length"))
    pg.set_viewport_size({"width": 390, "height": 844}); pg.wait_for_timeout(300)
    print("celular sem rolagem lateral:", pg.evaluate("() => document.documentElement.scrollWidth") <= 392)
    pg.screenshot(path=os.path.join(AQUI, "gb_duracoes.png"), full_page=True); br.close()

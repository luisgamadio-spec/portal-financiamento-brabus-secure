"""Gera o "Exportar RH/DP" da competência 22/09 à 20/10 pela TELA do homolog (clone local ou site publicado),
logado como Master (login simulado), com as leituras reais do banco em transação somente leitura.
Salva o .xlsx em saida/<rótulo>.xlsx e o texto de "Fechado em" mostrado na tela. Uso: python -I gera_rhdp.py <pasta|""> <rótulo>"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
import tempfile
harness.CACHE = tempfile.mkdtemp(prefix="rpc_cache_rhdp_")  # sempre leitura nova do banco
harness.LEITURA_MASTER_OK = harness.LEITURA_MASTER_OK + ("master_commission_snapshot_export", "master_commission_operational_detail", "master_commission_snapshot")
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
pasta, rot = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(AQUI, "saida"), exist_ok=True)
with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = harness.contexto(br, pasta or None, Fake(perfil="MASTER", modulos=["painelMaster"]))
    pg = ctx.new_page(); erros = []; pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
    pg.wait_for_selector(".maSectionItemLink[data-section=historicoCompetencias]", timeout=60000)
    pg.click(".maSectionItemLink[data-section=historicoCompetencias]")
    pg.wait_for_selector(f".hcRow[data-id='{FID}']", timeout=120000)
    linha = pg.inner_text(f".hcRow[data-id='{FID}']").replace("\n", " | ")
    with pg.expect_download(timeout=240000) as dl:
        pg.click(f".hcRow[data-id='{FID}'] .hcRhdpBtn")
    arq = os.path.join(AQUI, "saida", rot + ".xlsx"); dl.value.save_as(arq)
    json.dump({"linha_tela": linha, "erros_js": erros}, open(os.path.join(AQUI, "saida", rot + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
    print("tela:", linha[:220]); print("arquivo:", arq, os.path.getsize(arq), "bytes; erros JS:", erros)
    br.close()

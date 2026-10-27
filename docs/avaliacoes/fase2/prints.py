"""Prints do protótipo da vistoria 3D no tamanho de celular e medição do que é baixado."""
import io, os, sys
from playwright.sync_api import sync_playwright
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
URL, OUT = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=False)
    baixado = {}
    pg.on("response", lambda r: baixado.__setitem__(r.url, r.headers.get("content-length")))
    erros = []
    pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.goto(URL); pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{OUT}/1_suv_3d.png")
    caixa = pg.locator("#palco canvas").bounding_box()
    cx, cy = caixa["x"] + caixa["width"] / 2, caixa["y"] + caixa["height"] / 2
    # toque na lateral (porta) e marca
    pg.mouse.click(cx - 10, cy + 10); pg.wait_for_timeout(500)
    print("peça tocada 1:", pg.inner_text("#fPeca"), "|", pg.inner_text("#fLado"))
    pg.click("#fGrav button:has-text('Média')"); pg.click("#fTipo button:has-text('Amassado')"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/2_folha_avaria.png")
    pg.click("#fSalvar"); pg.wait_for_timeout(400)
    # vista de frente e toque no centro (capô/para-choque)
    pg.click("#vistas button:has-text('Frente')"); pg.wait_for_timeout(900)
    pg.mouse.click(cx, cy + 40); pg.wait_for_timeout(400)
    print("peça tocada 2:", pg.inner_text("#fPeca"))
    pg.click("#fSalvar"); pg.wait_for_timeout(400)
    pg.click("#vistas button:has-text('Teto')"); pg.wait_for_timeout(900)
    pg.mouse.click(cx, cy); pg.wait_for_timeout(400)
    print("peça tocada 3:", pg.inner_text("#fPeca"))
    pg.click("#fCancelar"); pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/3_teto.png")
    pg.click("#vistas button:has-text('Lat. esq.')"); pg.wait_for_timeout(900)
    pg.screenshot(path=f"{OUT}/4_lateral.png", full_page=True)
    for k in ["HATCH", "SEDAN", "PICKUP"]:
        pg.click(f"#carrs [data-k='{k}']"); pg.click("#vistas button:has-text('3D')"); pg.wait_for_timeout(900)
        pg.locator("#palco").screenshot(path=f"{OUT}/5_{k.lower()}.png")
    print("avarias:", pg.evaluate("window.__proto.avarias().map(a => a.peca + ' ' + a.g + ' ' + a.custo)"))
    print("erros:", erros)
    for u, n in baixado.items():
        if "three" in u: print("baixou:", u, n, "bytes")
    b.close()
print("tamanho do protótipo (código próprio):", os.path.getsize(os.path.join(os.path.dirname(os.path.abspath(__file__)), "prototipo.html")), "bytes")

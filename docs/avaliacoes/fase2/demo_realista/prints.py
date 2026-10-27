import sys
from playwright.sync_api import sync_playwright
OUT = sys.argv[1]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1.5)
    erros = []; pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.goto("http://127.0.0.1:8791/aval_3d/demo/realista.html"); pg.wait_for_function("window.__pronto === true", timeout=120000); pg.wait_for_timeout(1500)
    print("peças reconhecidas:", pg.evaluate("window.__demo.pecas()"))
    pg.evaluate("window.__demo.girar(-0.8, 1.18)"); pg.wait_for_timeout(4000); pg.screenshot(path=f"{OUT}/real_1_3d.png")
    pg.evaluate("window.__demo.tocar('Porta dianteira esquerda')"); pg.wait_for_timeout(4000); pg.screenshot(path=f"{OUT}/real_2_toque_porta.png")
    pg.evaluate("window.__demo.tocar(null); window.__demo.marcar('Porta dianteira esquerda', 'Média'); window.__demo.marcar('Capô', 'Grave'); window.__demo.marcar('Retrovisor esquerdo', 'Leve')")
    for i, (t, f) in enumerate([(-0.75, 1.2), (-1.57, 1.45), (0.0, 1.3), (-2.4, 1.15)]):
        pg.evaluate(f"window.__demo.girar({t}, {f})"); pg.wait_for_timeout(4000); pg.screenshot(path=f"{OUT}/real_3_marcado_{i}.png")
    print("erros:", erros)
    b.close()

"""Prints do protótipo v2 (4 carrocerias, vistas, toque, cores por gravidade, checklist, tela pequena) e dos modelos prontos."""
import io, os, sys
from playwright.sync_api import sync_playwright
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE, OUT = sys.argv[1], sys.argv[2]
ok = True
def confere(c, n):
    global ok; ok &= bool(c); print(("OK    " if c else "FALHA ") + n)
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    erros = []; pg.on("pageerror", lambda e: erros.append(str(e))); pg.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + "/aval_3d/prototipo2.html"); pg.wait_for_timeout(3000)
    for k in ["HATCH", "SEDAN", "SUV", "PICKUP"]:
        pg.click(f"#carrs [data-k='{k}']"); pg.click("#vistas button:has-text('3D')"); pg.wait_for_timeout(1200)
        pg.locator("#palco").screenshot(path=f"{OUT}/v2_{k.lower()}_3d.png")
        pg.click("#vistas button:has-text('Lat. esq.')"); pg.wait_for_timeout(1200)
        pg.locator("#palco").screenshot(path=f"{OUT}/v2_{k.lower()}_lateral.png")
    pg.click("#carrs [data-k='SUV']"); 
    for v in ["Frente", "Traseira"]:
        pg.click(f"#vistas button:has-text('{v}')"); pg.wait_for_timeout(1200); pg.locator("#palco").screenshot(path=f"{OUT}/v2_suv_{v.lower()}.png")
    pg.click("#vistas button:has-text('3D')"); pg.wait_for_timeout(1200)
    # toque real na porta dianteira esquerda
    pt = pg.evaluate("window.__proto.onde('Porta dianteira esquerda')"); pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(500)
    confere(pg.inner_text("#fPeca") == "Porta dianteira esquerda", "toque na porta abre 'Porta dianteira esquerda'")
    confere(pg.locator("#fTipo button").all_inner_texts() == ["Risco", "Amassado", "Pintura danificada", "Repintura", "Ferrugem"], "lataria: tipos de lataria")
    pg.screenshot(path=f"{OUT}/v2_toque_porta.png")
    pg.click("#fTipo button:has-text('Amassado')"); pg.click("#fGrav button:has-text('Média')"); pg.click("#fSalvar"); pg.wait_for_timeout(300)
    for nome, tipo, grav, vista in [("Para-brisa", "Trinca/quebra", "Grave", "Frente"), ("Farol esquerdo", "Opaco/amarelado", "Leve", "Frente"), ("Pneu dianteiro esquerdo", "Desgaste", "Leve", "Lat. esq.")]:
        pg.click(f"#vistas button:has-text('{vista}')"); pg.wait_for_timeout(1300)
        pt = pg.evaluate(f"window.__proto.onde('{nome}')")
        dy = -18 if nome.startswith("Pneu") else 0   # no pneu, toca na borracha (o centro é a roda)
        pg.mouse.click(pt["x"], pt["y"] + dy); pg.wait_for_timeout(400)
        print("   tocado:", pg.inner_text("#fPeca"), "| tipos:", pg.locator("#fTipo button").all_inner_texts())
        if nome == "Para-brisa": confere(pg.locator("#fTipo button").all_inner_texts() == ["Risco", "Trinca/quebra"], "vidro: só risco e trinca/quebra (sem 'amassado')")
        if nome.startswith("Pneu"): confere("Desgaste" in pg.locator("#fTipo button").all_inner_texts(), "pneu: tipos de pneu")
        pg.click(f"#fTipo button:has-text('{tipo}')"); pg.click(f"#fGrav button:has-text('{grav}')"); pg.click("#fSalvar"); pg.wait_for_timeout(300)
    pg.click("#vistas button:has-text('3D')"); pg.wait_for_timeout(1300); pg.screenshot(path=f"{OUT}/v2_cores_gravidade.png", full_page=True)
    confere(len(pg.evaluate("window.__proto.avarias()")) == 4, "4 avarias marcadas")
    pg.click("#btnChecklist"); pg.wait_for_timeout(700)
    pg.click("#checklist .chk:nth-child(1) button:has-text('Bom')"); pg.click("#checklist .chk:nth-child(3) button:has-text('Gela')")
    pg.locator("#checklist").screenshot(path=f"{OUT}/v2_checklist.png")
    confere(not erros, f"sem erros no console {erros[:2]}")
    pg.close()
    # tela pequena: a folha não pode cortar o botão
    pg = b.new_page(viewport={"width": 360, "height": 640}, device_scale_factor=2)
    pg.goto(BASE + "/aval_3d/prototipo2.html"); pg.wait_for_timeout(2500)
    pt = pg.evaluate("window.__proto.onde('Porta traseira direita') || window.__proto.onde('Capô')"); pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(500)
    bx = pg.locator("#fSalvar").bounding_box()
    confere(bx and bx["y"] + bx["height"] <= 640, f"tela 360×640: botão 'Marcar avaria' visível (base em {bx and round(bx['y'] + bx['height'])} px)")
    pg.screenshot(path=f"{OUT}/v2_tela_pequena_folha.png")
    pg.close()
    # modelos prontos
    pg = b.new_page(viewport={"width": 390, "height": 600}, device_scale_factor=2)
    baixado = {}; pg.on("response", lambda r: baixado.__setitem__(r.url.split('/')[-1], r))
    pg.goto(BASE + "/aval_3d/modelos.html"); pg.wait_for_function("window.__prontos === 4", timeout=30000); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{OUT}/prontos_kenney.png", full_page=True)
    b.close()
print("\n" + ("TUDO OK" if ok else "HÁ FALHAS"))

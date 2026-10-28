"""Prints da vistoria 2D no celular: as 4 carrocerias com as 5 vistas, uma vista ampliada, toque e cores por gravidade.
Confere que cada peça tem área clicável e que a mesma peça acende em todas as vistas onde aparece."""
import sys, io, collections
from playwright.sync_api import sync_playwright
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
URL, OUT = sys.argv[1], sys.argv[2]
ok = True
def confere(c, n):
    global ok; ok &= bool(c); print(("OK    " if c else "FALHA ") + n)
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=3)
    erros = []; pg.on("pageerror", lambda e: erros.append(str(e))); pg.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
    pg.goto(URL); pg.wait_for_timeout(500)
    for k in ["HATCH", "SEDAN", "SUV", "PICKUP"]:
        pg.click(f"#carrs [data-k='{k}']"); pg.wait_for_timeout(200)
        pecas = pg.evaluate("window.__v2d.pecas()")
        cont = collections.Counter(pecas)
        print(f"{k}: {len(set(pecas))} peças clicáveis ({len(pecas)} áreas nas 5 vistas)")
        semArea = pg.evaluate("Array.from(document.querySelectorAll('#desenho .peca')).filter(e => { const r = e.getBoundingClientRect(); return r.width < 1 || r.height < 1; }).map(e => e.dataset.chave)")
        confere(not semArea, f"{k}: toda área tem tamanho na tela {semArea[:5]}")
        pg.locator(".painel").screenshot(path=f"{OUT}/{k.lower()}_5_vistas.png")
    # uma vista ampliada
    pg.click("#carrs [data-k='SUV']"); pg.click("#vistas [data-v='LE']"); pg.wait_for_timeout(200)
    pg.locator(".painel").screenshot(path=f"{OUT}/suv_lateral_ampliada.png")
    pg.click("#vistas [data-v='TODAS']"); pg.wait_for_timeout(200)
    # toque real numa porta: acende na lateral E em cima
    pg.locator("#desenho path[data-chave='Porta dianteira esquerda']").first.click(); pg.wait_for_timeout(200)
    acesas = pg.evaluate("document.querySelectorAll('#desenho .peca.toque').length")
    confere(acesas >= 2, f"porta dianteira esquerda acende em {acesas} vistas (lateral e cima)")
    confere(pg.locator("#fTipo button").all_inner_texts() == ["Risco", "Amassado", "Pintura danificada", "Repintura", "Ferrugem"], "lataria: tipos de lataria")
    pg.screenshot(path=f"{OUT}/suv_toque_porta.png")
    pg.click("#fTipo button:has-text('Amassado')"); pg.click("#fGrav button:has-text('Média')"); pg.click("#fSalvar"); pg.wait_for_timeout(200)
    for chave, t, g in [("Para-brisa", "Trinca/quebra", "Grave"), ("Farol esquerdo", "Opaco/amarelado", "Leve"), ("Pneu dianteiro esquerdo", "Desgaste", "Leve"), ("Para-choque traseiro", "Trinca/quebra", "Grave")]:
        loc = pg.locator(f"#desenho path[data-chave='{chave}']").first
        if chave.startswith("Pneu"):   # toca na borracha (o centro é a roda)
            bb = loc.bounding_box(); loc.click(position={"x": bb["width"] / 2, "y": 2})
        else: loc.click()
        pg.wait_for_timeout(150)
        tipos = pg.locator("#fTipo button").all_inner_texts()
        if chave == "Para-brisa": confere(tipos == ["Risco", "Trinca/quebra"], "vidro: só risco e trinca/quebra")
        pg.click(f"#fTipo button:has-text('{t}')"); pg.click(f"#fGrav button:has-text('{g}')"); pg.click("#fSalvar"); pg.wait_for_timeout(150)
    cores = pg.evaluate("({g1: document.querySelectorAll('#desenho .g1').length, g2: document.querySelectorAll('#desenho .g2').length, g3: document.querySelectorAll('#desenho .g3').length})")
    confere(cores["g1"] > 0 and cores["g2"] > 0 and cores["g3"] > 0, f"cores por gravidade em todas as vistas {cores}")
    pg.locator(".painel").screenshot(path=f"{OUT}/suv_cores_gravidade.png")
    pg.click("#btnEstepe"); pg.wait_for_timeout(150)
    confere(pg.inner_text("#fPeca") == "Pneu estepe", "botão do estepe abre a folha do pneu estepe")
    pg.click("#fCancelar")
    confere(not erros, f"sem erros no console {erros[:2]}")
    b.close()
print("\n" + ("TUDO OK" if ok else "HÁ FALHAS"))
# vista de cima: o lado esquerdo do carro tem de ficar EMBAIXO do desenho (frente à esquerda)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 390, "height": 844})
    pg.goto(URL); pg.click("#vistas [data-v='CIMA']"); pg.wait_for_timeout(200)
    y = lambda ch: pg.locator(f"#desenho path[data-chave='{ch}']").first.bounding_box()["y"]
    confere(y("Porta dianteira esquerda") > y("Porta dianteira direita"), "cima: porta esquerda embaixo, direita em cima")
    confere(y("Retrovisor esquerdo") > y("Retrovisor direito"), "cima: retrovisor esquerdo embaixo")
    pg.click("#vistas [data-v='FRENTE']"); pg.wait_for_timeout(200)
    x = lambda ch: pg.locator(f"#desenho path[data-chave='{ch}']").first.bounding_box()["x"]
    confere(x("Farol esquerdo") > x("Farol direito"), "frente: farol esquerdo à direita do desenho (de frente para o carro)")
    pg.click("#vistas [data-v='TRAS']"); pg.wait_for_timeout(200)
    confere(x("Lanterna traseira esquerda") < x("Lanterna traseira direita"), "traseira: lanterna esquerda à esquerda do desenho")
    b.close()
print("\n" + ("TUDO OK" if ok else "HÁ FALHAS"))

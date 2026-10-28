"""Prints e testes do protótipo v3 (3D por código, arredondado): 4 carrocerias em 3D e lateral, toque, cores por gravidade,
tipos por peça, lado certo, estepe, checklist, folha sem cortar em tela pequena e peso para carregar no celular."""
import gzip, io, sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFont
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE, OUT = sys.argv[1], sys.argv[2]
URL = BASE + "/aval_3d/prototipo3.html"
ok = True
def confere(c, n):
    global ok; ok &= bool(c); print(("OK    " if c else "FALHA ") + n)
def vista(pg, v): pg.click(f"#vistas button:has-text('{v}')"); pg.wait_for_timeout(3500)
def toca(pg, nome, dy=0):
    pt = pg.evaluate(f"window.__proto.onde('{nome}')")
    if not pt: return None
    pg.mouse.click(pt["x"], pt["y"] + dy); pg.wait_for_timeout(500); return pg.inner_text("#fPeca")
NOMES = {"HATCH": "Hatch", "SEDAN": "Sedan", "SUV": "SUV", "PICKUP": "Pickup"}
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    pg = b.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    erros = []; pg.on("pageerror", lambda e: erros.append(str(e))); pg.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
    corpos = {}; pg.on("response", lambda r: corpos.__setitem__(r.url, r) if "jsdelivr" in r.url else None)
    pg.goto(URL); pg.wait_for_timeout(4000)
    # peso: three.js + complementos (o desenho dos carros é código, 0 KB de modelo)
    total = sum(len(r.body()) for r in corpos.values()); comp = sum(len(gzip.compress(r.body(), 9)) for r in corpos.values())
    pagina = len(open(sys.argv[3], "rb").read()) if len(sys.argv) > 3 else 0
    print(f"peso: bibliotecas {total/1024:.0f} KB ({comp/1024:.0f} KB comprimido, {len(corpos)} arquivos) + página {pagina/1024:.0f} KB; modelos 3D: 0 KB")
    req = {"Capô", "Teto", "Para-brisa", "Vidro traseiro", "Grade", "Para-choque dianteiro", "Para-choque traseiro", "Farol esquerdo", "Farol direito",
           "Lanterna traseira esquerda", "Lanterna traseira direita", "Retrovisor esquerdo", "Retrovisor direito", "Porta dianteira esquerda", "Porta traseira direita",
           "Para-lama dianteiro esquerdo", "Para-lama dianteiro direito", "Pneu dianteiro esquerdo", "Roda traseira direita", "Vidro da porta dianteira esquerda"}
    for k in NOMES:
        pg.click(f"#carrs [data-k='{k}']"); pg.wait_for_timeout(600)
        pecas = set(pg.evaluate("window.__proto.partes()"))
        extra = {"HATCH": {"Tampa traseira", "Lateral traseira esquerda"}, "SEDAN": {"Tampa do porta-malas", "Lateral traseira direita"},
                 "SUV": {"Tampa traseira", "Lateral traseira esquerda"}, "PICKUP": {"Tampa da caçamba", "Caçamba (assoalho)", "Caçamba (lateral) esquerda"}}[k]
        falta = (req | extra) - pecas
        confere(not falta, f"{NOMES[k]}: {len(pecas)} peças clicáveis separadas {('— faltam ' + str(falta)) if falta else ''}")
        for v, arq in [("3D", "3d"), ("Lat. esq.", "lateral")]:
            vista(pg, v); pg.locator("#palco").screenshot(path=f"{OUT}/v3_{k.lower()}_{arq}.png")
    # SUV: frente, traseira e teto
    pg.click("#carrs [data-k='SUV']"); pg.wait_for_timeout(600)
    for v, arq in [("Frente", "frente"), ("Traseira", "traseira"), ("Teto", "teto")]:
        vista(pg, v); pg.locator("#palco").screenshot(path=f"{OUT}/v3_suv_{arq}.png")
    # lado certo: na lateral esquerda, tocar na porta abre a porta ESQUERDA
    vista(pg, "Lat. esq.")
    confere(toca(pg, "Porta dianteira esquerda") == "Porta dianteira esquerda", "lateral esquerda: toque abre 'Porta dianteira esquerda'")
    pg.click("#fCancelar"); pg.wait_for_timeout(300)
    vista(pg, "Lat. dir.")
    confere(toca(pg, "Porta traseira direita") == "Porta traseira direita", "lateral direita: toque abre 'Porta traseira direita'")
    pg.click("#fCancelar"); pg.wait_for_timeout(300)
    # toque real na porta em 3D: acende e abre a folha com tipos de lataria
    vista(pg, "3D")
    confere(toca(pg, "Porta dianteira esquerda") == "Porta dianteira esquerda", "3D: toque na porta abre 'Porta dianteira esquerda'")
    confere(pg.locator("#fTipo button").all_inner_texts() == ["Risco", "Amassado", "Pintura danificada", "Repintura", "Ferrugem"], "lataria: tipos de lataria")
    pg.wait_for_timeout(400); pg.locator("#palco").screenshot(path=f"{OUT}/v3_toque_porta_palco.png"); pg.screenshot(path=f"{OUT}/v3_toque_porta.png")
    pg.click("#fTipo button:has-text('Amassado')"); pg.click("#fGrav button:has-text('Média')"); pg.click("#fSalvar"); pg.wait_for_timeout(300)
    marcar = [("Para-brisa", "Trinca/quebra", "Grave", "Frente", 0), ("Farol esquerdo", "Opaco/amarelado", "Leve", "Frente", 0),
              ("Para-lama dianteiro esquerdo", "Risco", "Leve", "Lat. esq.", 0), ("Pneu dianteiro esquerdo", "Desgaste", "Leve", "Lat. esq.", 0),
              ("Lanterna traseira direita", "Trinca/quebra", "Média", "Traseira", 0)]
    for nome, tipo, grav, v, dy in marcar:
        vista(pg, v); tocado = toca(pg, nome, dy)
        confere(tocado == nome, f"toque em '{nome}' ({v}) → '{tocado}' | tipos: {pg.locator('#fTipo button').all_inner_texts()}")
        if nome == "Para-brisa": confere(pg.locator("#fTipo button").all_inner_texts() == ["Risco", "Trinca/quebra"], "vidro: só risco e trinca/quebra")
        if nome.startswith("Pneu"): confere("Desgaste" in pg.locator("#fTipo button").all_inner_texts(), "pneu: tipos de pneu")
        if nome.startswith("Farol"): confere("Opaco/amarelado" in pg.locator("#fTipo button").all_inner_texts(), "farol: tipos de farol")
        if tocado != nome: pg.click("#fCancelar"); continue
        pg.click(f"#fTipo button:has-text('{tipo}')"); pg.click(f"#fGrav button:has-text('{grav}')"); pg.click("#fSalvar"); pg.wait_for_timeout(300)
    vista(pg, "3D"); pg.locator("#palco").screenshot(path=f"{OUT}/v3_cores_3d.png")
    vista(pg, "Lat. esq."); pg.locator("#palco").screenshot(path=f"{OUT}/v3_cores_lateral.png")
    pg.screenshot(path=f"{OUT}/v3_cores_tela.png", full_page=True)
    confere(len(pg.evaluate("window.__proto.avarias()")) == 6, "6 avarias marcadas e coloridas")
    pg.click("#btnEstepe"); pg.wait_for_timeout(400)
    confere(pg.inner_text("#fPeca") == "Pneu estepe" and "Desgaste" in pg.locator("#fTipo button").all_inner_texts(), "botão estepe abre 'Pneu estepe' com tipos de pneu")
    pg.click("#fCancelar"); pg.wait_for_timeout(300)
    pg.click("#btnChecklist"); pg.wait_for_timeout(700)
    pg.click("#checklist .chk:nth-child(1) button:has-text('Bom')"); pg.click("#checklist .chk:nth-child(3) button:has-text('Gela')")
    confere(pg.locator("#checklist .chk").count() == 6, "checklist com 6 itens")
    confere(not erros, f"sem erros no console {erros[:2]}")
    pg.close()
    # tela pequena: a folha não pode cortar o botão
    pg = b.new_page(viewport={"width": 360, "height": 640}, device_scale_factor=2)
    pg.goto(URL); pg.wait_for_timeout(3500)
    toca(pg, "Porta traseira esquerda")
    bx = pg.locator("#fSalvar").bounding_box()
    confere(bx and bx["y"] + bx["height"] <= 640, f"tela 360×640: botão 'Marcar avaria' visível (base em {bx and round(bx['y'] + bx['height'])} px)")
    pg.screenshot(path=f"{OUT}/v3_tela_pequena_folha.png")
    b.close()

# folha única: 4 carrocerias, 3D e lateral
ims = [[Image.open(f"{OUT}/v3_{k.lower()}_{v}.png") for v in ("3d", "lateral")] for k in NOMES]
w, h = ims[0][0].size; cab = 70
folha = Image.new("RGB", (w * 2, (h + cab) * 4), (11, 11, 12)); d = ImageDraw.Draw(folha)
try: fonte = ImageFont.truetype("segoeui.ttf", 40)
except OSError: fonte = ImageFont.load_default()
for i, k in enumerate(NOMES):
    d.text((24, i * (h + cab) + 14), f"{NOMES[k]} — 3D e lateral esquerda", fill=(242, 242, 243), font=fonte)
    for j in range(2): folha.paste(ims[i][j], (j * w, i * (h + cab) + cab))
folha.save(f"{OUT}/v3_4_carrocerias.png")
print("\n" + ("TUDO OK" if ok else "HÁ FALHAS"))

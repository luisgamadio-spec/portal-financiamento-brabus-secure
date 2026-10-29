"""Teste local da vistoria (Fase 2) na tela real do módulo, com banco simulado no navegador (harness_f2.html).
Celular 390×844: cria a avaliação, abre a vistoria, toca em peças reais do carro 3D, foto comprimida e enviada,
foto obrigatória em média/grave, checklist, conclusão, rascunho sem sinal (inclusive reabrindo sem sinal),
tabela de reparos do Master refletindo no custo, tela pequena 360×640, sem rolagem lateral nem erro no console."""
import io, os, sys
from playwright.sync_api import sync_playwright
from PIL import Image
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
BASE, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
FOTO = os.path.join(OUT, "_foto_teste.jpg")
Image.new("RGB", (4000, 3000), (120, 130, 140)).save(FOTO, quality=95)   # foto "de celular" grande
falhas = []
def confere(c, n):
    print(("OK    " if c else "FALHA ") + n)
    if not c: falhas.append(n)

def nova_avaliacao(pg, carroceria="SUV"):
    pg.click("text=+ Nova avaliação"); pg.fill("#avBusca", "abc1d23"); pg.click("button:has-text('Consultar')"); pg.wait_for_selector(".avVersao")
    pg.click(".avVersao >> nth=1"); pg.click("button:has-text('Continuar')"); pg.wait_for_selector("#avF_km")
    pg.fill("#avF_km", "45000"); pg.click(f".avCarr[data-v='{carroceria}']")
    if pg.locator("#avF_loja").count(): pg.select_option("#avF_loja", "GASTAO")
    pg.click("button:has-text('Salvar rascunho')"); pg.wait_for_selector("text=Vistoria")

def abrir_vistoria(pg):
    pg.click("[data-acao=abrirVistoria]"); pg.wait_for_selector(".avVisCanvas", timeout=30000)
    pg.wait_for_function("window.NX_AVALIACOES_PAGE.getState().vis && window.NX_AVALIACOES_PAGE.getState().vis.ctrl", timeout=30000)
    pg.wait_for_timeout(1500)

def vista(pg, v): pg.click(f".avVisVistas [data-v='{v}']"); pg.wait_for_timeout(3500)
def toca(pg, nome):
    pt = pg.evaluate(f"window.NX_AVALIACOES_PAGE.getState().vis.ctrl.onde({nome!r})")
    if not pt: return None
    pg.mouse.click(pt["x"], pt["y"]); pg.wait_for_timeout(500)
    return pg.inner_text(".avVisFolha h3") if pg.locator(".avVisFolha").count() else None
def tipos(pg): return pg.locator(".avVisFolha .avChips >> nth=0").locator("button").all_inner_texts()
def sem_rolagem(pg): return pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg = ctx.new_page()
    erros = []; pg.on("pageerror", lambda e: erros.append(str(e))); pg.on("console", lambda m: erros.append(m.text) if m.type == "error" else None)
    pg.goto(BASE + "?perfil=MASTER"); pg.wait_for_selector("text=+ Nova avaliação")
    nova_avaliacao(pg)
    pg.wait_for_selector("text=Não iniciada")
    confere(pg.locator("[data-acao=abrirVistoria]").inner_text() == "Fazer vistoria", "detalhe: cartão 'Vistoria · Não iniciada' com botão 'Fazer vistoria'")
    pg.screenshot(path=f"{OUT}/f2_1_detalhe.png", full_page=True)
    abrir_vistoria(pg)
    pg.locator(".avVisPalco").screenshot(path=f"{OUT}/f2_2_suv_3d.png")
    confere(len(pg.evaluate("window.NX_AVALIACOES_PAGE.getState().vis.ctrl.partes()")) == 42, "SUV: 42 peças clicáveis no carro 3D")
    # porta dianteira esquerda: média, com foto
    confere(toca(pg, "Porta dianteira esquerda") == "Porta dianteira esquerda", "toque real na porta abre 'Porta dianteira esquerda'")
    confere(tipos(pg) == ["Risco", "Amassado", "Pintura danificada", "Repintura", "Ferrugem"], "porta: tipos de lataria")
    pg.locator(".avVisPalco").screenshot(path=f"{OUT}/f2_3_toque_porta.png"); pg.screenshot(path=f"{OUT}/f2_3_folha.png")
    bx = pg.locator("[data-acao=visFolhaSalvar]").bounding_box()
    confere(bx and bx["y"] + bx["height"] <= 844, "folha da avaria: botão 'Marcar avaria' visível sem cortar")
    pg.click(".avVisFolha [data-v='Amassado']"); pg.click(".avVisFolha [data-v='MEDIA']")
    pg.set_input_files(".avVisFolha input[data-foto=folha]", FOTO); pg.wait_for_selector(".avVisFolha .avVisFoto img")
    pg.click("[data-acao=visFolhaSalvar]"); pg.wait_for_function("(window.__fotosEnviadas || []).length >= 1", timeout=15000)
    env = pg.evaluate("window.__fotosEnviadas[0]")
    confere(env["tipo"] == "image/jpeg" and env["bytes"] < 700000, f"foto de 4000×3000 comprimida no celular antes de enviar ({env['bytes'] // 1024} KB, JPEG)")
    pg.wait_for_selector("text=Tudo salvo.")
    # para-brisa grave sem foto
    vista(pg, "Frente")
    confere(toca(pg, "Para-brisa") == "Para-brisa" and tipos(pg) == ["Risco", "Trinca/quebra"], "frente: para-brisa só com risco e trinca/quebra")
    pg.click(".avVisFolha [data-v='Trinca/quebra']"); pg.click(".avVisFolha [data-v='GRAVE']"); pg.click("[data-acao=visFolhaSalvar]")
    confere(toca(pg, "Farol esquerdo") == "Farol esquerdo" and "Opaco/amarelado" in tipos(pg), "frente: farol esquerdo com tipos de farol")
    pg.click(".avVisFolha [data-v='Opaco/amarelado']"); pg.click("[data-acao=visFolhaSalvar]")
    # coluna B (estrutura) e pneu
    vista(pg, "Lat. esq.")
    confere(toca(pg, "Coluna B esquerda") == "Coluna B esquerda" and tipos(pg) == ["Amassado", "Trinca/solda", "Repintura"], "lateral: Coluna B esquerda é estrutura (amassado, trinca/solda, repintura)")
    pg.click("[data-acao=visFolhaCancelar]")
    confere(toca(pg, "Pneu dianteiro esquerdo") == "Pneu dianteiro esquerdo" and "Desgaste" in tipos(pg), "lateral: pneu com tipos de pneu")
    pg.click(".avVisFolha [data-v='Desgaste']"); pg.click("[data-acao=visFolhaSalvar]")
    pg.click("[data-acao=visEstepe]"); pg.wait_for_timeout(300)
    confere(pg.inner_text(".avVisFolha h3") == "Pneu estepe", "botão estepe abre 'Pneu estepe'")
    pg.click("[data-acao=visFolhaCancelar]")
    vista(pg, "3D"); pg.wait_for_selector("text=Tudo salvo.")
    pg.locator(".avVisPalco").screenshot(path=f"{OUT}/f2_4_cores_3d.png")
    confere(pg.locator(".avVisItem").count() == 4, "lista com 4 avarias")
    confere(pg.locator("text=Falta foto (obrigatória em média e grave).").count() == 1, "para-brisa grave sem foto avisa 'Falta foto'")
    # checklist e conclusão
    for q, v in [("interior", "BOM"), ("luzes_painel", "NENHUMA"), ("ar_condicionado", "GELA"), ("chave_reserva", "TEM"), ("manual", "NAO_TEM"), ("revisoes", "PARCIAIS")]:
        pg.click(f"[data-acao=visCheck][data-q={q}][data-v={v}]")
    pg.wait_for_selector("text=Tudo salvo.")
    pg.click("[data-acao=visConcluir]"); pg.wait_for_selector(".avMsg.err")
    confere("Falta foto em 1" in pg.inner_text(".avMsg.err"), "concluir sem a foto do para-brisa: recusado com o motivo")
    item = pg.locator(".avVisItem", has_text="Para-brisa")
    item.locator("input[data-foto]").set_input_files(FOTO); pg.wait_for_function("(window.__fotosEnviadas || []).length >= 2", timeout=15000)
    pg.wait_for_selector("text=Tudo salvo."); pg.wait_for_timeout(400)
    pg.click("[data-acao=visConcluir]"); pg.wait_for_selector("text=Vistoria concluída.")
    confere(True, "com checklist completo e fotos, a vistoria conclui")
    confere(sem_rolagem(pg), "vistoria sem rolagem lateral")
    pg.screenshot(path=f"{OUT}/f2_5_vistoria_tela.png", full_page=True)
    # sem sinal: marca uma avaria, sai, volta ainda sem sinal (vem do rascunho do celular), sinal volta e envia
    pg.evaluate("window.__offline = true")
    vista(pg, "3D")
    toca(pg, "Capô"); pg.click(".avVisFolha [data-v='Risco']"); pg.click("[data-acao=visFolhaSalvar]"); pg.wait_for_timeout(1800)
    confere("Sem sinal: rascunho salvo neste celular" in pg.inner_text(".avVisStatus"), "sem sinal: avisa que o rascunho está salvo no celular")
    pg.click("[data-acao=visVoltar]"); pg.wait_for_timeout(800)
    pg.click("[data-acao=abrirVistoria]"); pg.wait_for_selector(".avVisItem"); pg.wait_for_timeout(800)
    confere(pg.locator(".avVisItem", has_text="Capô").count() == 1, "reabrindo sem sinal: a avaria do capô vem do rascunho do celular")
    antes = pg.evaluate("window.__salvamentos")
    pg.evaluate("window.__offline = false; window.dispatchEvent(new Event('online'))")
    pg.wait_for_selector("text=Tudo salvo.", timeout=15000)
    confere(pg.evaluate("window.__salvamentos") > antes, "sinal voltou: o rascunho foi enviado sozinho")
    pg.screenshot(path=f"{OUT}/f2_6_depois_do_sinal.png", full_page=True)
    # tabela de reparos (Master) -> custo na vistoria
    pg.click("[data-acao=visVoltar]"); pg.wait_for_timeout(500); pg.click("text=‹ Voltar"); pg.wait_for_selector("text=Regras de margem")
    pg.click("text=Regras de margem"); pg.wait_for_selector("#avTR_0_MEDIA")
    confere(pg.get_attribute("#avTR_0_MEDIA", "placeholder") == "a definir" and pg.input_value("#avTR_0_MEDIA") == "", "tabela de reparos começa 'a definir'")
    pg.fill("#avTR_0_MEDIA", "900"); pg.on("dialog", lambda d: d.accept())
    pg.click("[data-acao=salvarReparos]"); pg.wait_for_selector("text=Versão 2 da tabela de reparos criada.")
    pg.screenshot(path=f"{OUT}/f2_7_tabela_reparos.png", full_page=True)
    confere(sem_rolagem(pg), "regras + tabela de reparos sem rolagem lateral")
    pg.click("text=‹ Voltar"); pg.wait_for_selector(".avItem"); pg.click(".avItem"); pg.wait_for_selector("[data-acao=abrirVistoria]")
    abrir_vistoria(pg)
    porta = pg.locator(".avVisItem", has_text="Porta dianteira esquerda").inner_text()
    confere("R$ 900" in porta.replace("\xa0", " "), "porta média passa a mostrar R$ 900 da tabela; as outras 'a definir'")
    confere(not erros, f"sem erros no console {erros[:3]}")
    ctx.close()
    # tela pequena
    ctx = b.new_context(viewport={"width": 360, "height": 640}, device_scale_factor=2); pg = ctx.new_page()
    pg.goto(BASE + "?perfil=AVALIADOR"); pg.wait_for_selector("text=+ Nova avaliação")
    nova_avaliacao(pg, "HATCH"); abrir_vistoria(pg)
    toca(pg, "Porta traseira esquerda") or toca(pg, "Capô")
    bx = pg.locator("[data-acao=visFolhaSalvar]").bounding_box()
    confere(bx and bx["y"] + bx["height"] <= 640, f"tela 360×640: botão 'Marcar avaria' visível (base em {bx and round(bx['y'] + bx['height'])} px)")
    pg.screenshot(path=f"{OUT}/f2_8_tela_pequena.png")
    pg.click("[data-acao=visFolhaCancelar]"); pg.locator(".avVisPalco").screenshot(path=f"{OUT}/f2_9_hatch_avaliador.png")
    confere(sem_rolagem(pg), "tela pequena sem rolagem lateral")
    b.close()
print("\n" + ("TUDO OK" if not falhas else f"{len(falhas)} FALHA(S)"))

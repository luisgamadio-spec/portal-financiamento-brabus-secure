"""Aba "Brabus IA" da Utilização (Painel Master), no clone local ou no site publicado. Login simulado; dados reais do banco
em transação somente leitura (master_ia_usage_data). Não imprime nomes: só contagens.  Uso: python -I test_ia_tela.py <pasta|"">"""
import io, json, os, sys, tempfile
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "fechamento", "20261021", "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake, rpc_real
harness.CACHE = tempfile.mkdtemp(prefix="rpc_cache_ia_")
harness.LEITURA_MASTER_OK = harness.LEITURA_MASTER_OK + ("master_ia_usage_data", "master_admin_security_data")
ANALISTA = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='ANALISTA' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{str(x)[:200]}]" if x != "" else ""))
pasta = sys.argv[1] if len(sys.argv) > 1 else ""
with sync_playwright() as p:
    br = p.chromium.launch(); fake = Fake(perfil="MASTER", modulos=["painelMaster"])
    ctx = harness.contexto(br, pasta or None, fake); pg = ctx.new_page(); erros = []; pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    baixados = []; pg.on("download", lambda d: baixados.append(d.suggested_filename))
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
    pg.wait_for_selector(".maSectionItemLink[data-section=utilizacaoSimuladores]", timeout=60000)
    check("menu: 'Utilização (Simuladores e Brabus IA)'", "Brabus IA" in pg.inner_text(".maSectionItemLink[data-section=utilizacaoSimuladores]"))
    pg.click(".maSectionItemLink[data-section=utilizacaoSimuladores]")
    pg.wait_for_selector(".suAbaBtn[data-aba=ia]", timeout=60000)
    pg.wait_for_selector(".suKpiCards", timeout=120000)
    check("aba Simuladores abre como antes (cartões e lista)", pg.locator(".suPresetBtn").count() == 6 and pg.locator("#suExportBtn").count() == 1)
    pg.click(".suAbaBtn[data-aba=ia]"); pg.wait_for_selector("#iaKpiUsuarios", timeout=120000)
    d = rpc_real("master_ia_usage_data", {"p_start": pg.input_value("#iaDtIni"), "p_end": pg.input_value("#iaDtFim")})["body"]
    u, q, n = (int(pg.inner_text(s)) for s in ("#iaKpiUsuarios", "#iaKpiPerguntas", "#iaKpiNunca"))
    check("cartões batem com o banco (usuários, perguntas, nunca usaram)", (u, q, n) == (len(d["linhas"]), sum(x["perguntas"] for x in d["linhas"]), sum(1 for e in d["elegiveis"] if not e["ja_usou"])), (u, q, n))
    check("aviso: só utilização, nunca o texto; período estimado explicado", "nunca é guardado" in pg.inner_text(".suBanner") and "estimadas" in pg.inner_text(".suBanner"))
    check("lista tem 1 linha por usuário que usou", pg.locator(".iaRow").count() == u, pg.locator(".iaRow").count())
    temas = pg.locator(".iaTemas .udsCompareCard").count(); check("temas exibidos", temas >= 3, temas)
    pg.click("#iaToggleNuncaBtn"); pg.wait_for_timeout(300)
    check("'Nunca utilizaram' lista os elegíveis sem uso", pg.locator(".udsNuncaRow").count() == n, pg.locator(".udsNuncaRow").count())
    pg.select_option("#iaPerfil", "VENDEDOR"); pg.wait_for_timeout(400)
    vend = sum(1 for x in d["linhas"] if (x["perfil"] or "").upper() == "VENDEDOR")
    check("filtro de perfil (Vendedor)", int(pg.inner_text("#iaKpiUsuarios")) == vend and pg.locator(".iaRow").count() == vend, vend)
    pg.select_option("#iaPerfil", ""); pg.wait_for_timeout(300)
    pg.click(".iaDetailBtn >> nth=0"); pg.wait_for_selector("#nxModalRoot :text('Temas')", timeout=10000)
    check("detalhe do usuário abre (perguntas, dias, temas), sem texto de pergunta", "Perguntas" in pg.inner_text("#nxModalRoot") and "Dias com uso" in pg.inner_text("#nxModalRoot"))
    pg.click("#maudModalCloseBtn"); pg.wait_for_timeout(300)
    check("detalhe fecha no ×", pg.locator("#maudModalDialog").count() == 0)
    pg.click(".iaPresetBtn[data-preset=desdeInicio]"); pg.wait_for_selector("#iaKpiUsuarios", timeout=120000); pg.wait_for_timeout(500)
    check("'Desde o início' começa em 02/10/2026", pg.input_value("#iaDtIni") == "2026-10-02", pg.input_value("#iaDtIni"))
    with pg.expect_download(timeout=30000) as dl: pg.click("#iaExportBtn")
    check("Exportar XLSX", dl.value.suggested_filename.startswith("utilizacao_brabus_ia_"), dl.value.suggested_filename)
    pg.click(".suAbaBtn[data-aba=simuladores]"); pg.wait_for_selector("#suExportBtn", timeout=60000)
    check("volta para a aba Simuladores", pg.locator(".suKpiCards").count() == 1 and pg.locator("#iaKpiUsuarios").count() == 0)
    pg.set_viewport_size({"width": 390, "height": 844}); pg.click(".suAbaBtn[data-aba=ia]"); pg.wait_for_selector("#iaKpiUsuarios", timeout=60000); pg.wait_for_timeout(400)
    check("celular: sem rolagem lateral", pg.evaluate("() => document.documentElement.scrollWidth") <= 392, pg.evaluate("() => document.documentElement.scrollWidth"))
    check("sem erros de JS", not erros, erros[:2])
    br.close()
    # mesmo caminho com um ANALISTA real no lugar do Master: o servidor recusa e a tela mostra o erro
    br = p.chromium.launch(); fake2 = Fake(perfil="MASTER", modulos=["painelMaster"], sub=ANALISTA)
    ctx = harness.contexto(br, pasta or None, fake2); pg = ctx.new_page(); harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
    pg.wait_for_selector(".maSectionItemLink[data-section=utilizacaoSimuladores]", timeout=60000); pg.click(".maSectionItemLink[data-section=utilizacaoSimuladores]")
    pg.wait_for_selector(".suAbaBtn[data-aba=ia]", timeout=60000); pg.click(".suAbaBtn[data-aba=ia]"); pg.wait_for_selector("#iaRetryBtn", timeout=120000)
    check("Analista (servidor): recusado, sem dados na tela", pg.locator("#iaKpiUsuarios").count() == 0 and any(c[0] == "master_ia_usage_data" and c[2] == 400 for c in fake2.chamadas), [c for c in fake2.chamadas if c[0] == "master_ia_usage_data"])
    br.close()
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

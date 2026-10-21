"""Monta o pedido de fechamento (p_period_id, p_summary, p_rows) da competência 22/09–20/10 com o código da TELA
(mesmo caminho de closingGeneratePreview + confirmação), sem chamar o fechamento. Leituras reais em transação com
ROLLBACK; analistas e gerentes respondidos pela VERSÃO NOVA (fech.sql aplicado na transação). Nada é gravado.
Uso: python -I captura_payload.py <pasta do clone | ""> <saida.json>"""
import io, json, os, sys, tempfile
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
os.environ["NX_SIM_SQL"] = os.path.join(AQUI, "fech.sql")
os.environ["NX_SIM_FNS"] = "operational_analyst_commission_metrics_v2,operational_salary_manager_directory"
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
harness.CACHE = tempfile.mkdtemp(prefix="rpc_cache_fech_")  # sem cache: nunca reaproveita resposta antiga
from rpc import sql
per = sql("select p.id, p.nome_periodo, p.data_inicio::text data_inicio, p.data_fim::text data_fim from public.periodos_comissao p join public.fechamentos_comissao f on f.periodo_id = p.id where f.id = '56c80a93-9558-4230-9ca0-d6f01e13fae3'")[0]
JS = """async (periodo) => {
  const P = window.NX_MASTER_COMPETENCE_CLOSING_PROVIDER, E = window.NX_MASTER_COMPETENCE_CLOSING_ENGINE, VM = window.NX_MASTER_COMPETENCE_CLOSING_VM;
  const w = (nome, pr) => pr.catch(e => { throw { onde: nome, erro: JSON.stringify(e).slice(0, 400) }; });
  let vendData, analystRows, managerRows, gestorIdentity;
  try { [vendData, analystRows, managerRows, gestorIdentity] = await Promise.all([
    w('vendedores', P.loadCommissionMetrics(periodo.data_inicio, periodo.data_fim, {})), w('analistas', P.loadAnalystCommissionMetrics(periodo.data_inicio, periodo.data_fim, {})),
    w('gerentes', P.loadManagerDirectory(periodo.data_inicio, periodo.data_fim, {})), w('gestor', P.loadGestorIdentity({}))]); } catch (e) { return { falha: e }; }
  const preview = E.buildPreviewLines({ vendRows: vendData.rows, analystRows, managerRows, gestorTotals: vendData.totals, gestorIdentity, cfg: VM.DEFAULT_PORTAL_CONFIG });
  const summary = E.buildSummaryPayload({ periodo, executivo: { vendidas: preview.vendidas, financiadas: preview.financiadas, producao: preview.producao, retorno: preview.retorno, spf: preview.spf },
    linhasCount: preview.linhas.length, comissaoPrevista: preview.comissaoPrevista, fechadoPorCpf: '', fechadoPorNome: '' });
  return { p_period_id: periodo.id, p_summary: summary, p_rows: E.buildSnapshotRowsPayload(preview, periodo, null), sem_id: preview.linhas.filter(l => !l.usuario_id).length };
}"""
pasta, saida = sys.argv[1], sys.argv[2]
# Respostas da versão nova calculadas antes (mesma transação com rollback do harness) e servidas na hora:
# a tela desiste de uma leitura depois de ~10 s, e aplicar o SQL inteiro a cada chamada passa disso.
corpo = {"p_start": per["data_inicio"], "p_end": per["data_fim"]}
PRONTO = {fn: harness.rpc_real(fn, corpo) for fn in os.environ["NX_SIM_FNS"].split(",")}
for fn, r in PRONTO.items(): print("versão nova", fn, "→", r["status"])
class FakePronto(Fake):
    def handle(self, route):
        u = route.request.url
        for fn, r in PRONTO.items():
            if "/rest/v1/rpc/" + fn in u:
                self.chamadas.append((fn, "versão nova", r["status"]))
                return route.fulfill(status=r["status"], content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(r["body"]))
        return super().handle(route)
with sync_playwright() as p:
    br = p.chromium.launch(); fake = FakePronto(perfil="MASTER", modulos=["painelMaster"])
    harness.LEITURA_MASTER_OK = harness.LEITURA_MASTER_OK + ("master_admin_security_data",)
    ctx = harness.contexto(br, pasta or None, fake); pg = ctx.new_page(); erros = []; pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin"); pg.wait_for_function("() => window.NX_MASTER_COMPETENCE_CLOSING_ENGINE && window.NX_MASTER_COMPETENCE_CLOSING_PROVIDER", timeout=60000)
    r = pg.evaluate(JS, per); br.close()
if r.get("falha"): print("FALHA:", r["falha"]); print("chamadas:", fake.chamadas); sys.exit(1)
json.dump(r, open(saida, "w", encoding="utf-8"), ensure_ascii=False)
print("linhas:", len(r["p_rows"]), "| sem identificador:", r.get("sem_id"), "| comissão prevista:", r["p_summary"]["comissao_total"], "| bloqueadas:", fake.bloqueadas, "| erros JS:", erros)

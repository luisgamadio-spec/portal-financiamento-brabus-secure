"""Exportar RH/DP de um fechamento SIMULADO com a versão nova (fech.sql + fechamento em transação com ROLLBACK).
A tela (clone local) recebe o snapshot e o detalhe desse fechamento simulado no lugar dos da competência 22/09–20/10.
O .xlsx e o JSON intermediário têm CPF de verdade: ficam só no scratchpad e são APAGADOS no fim. Nada é impresso além de contagens."""
import io, json, os, re, sys, tempfile
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import openpyxl
from playwright.sync_api import sync_playwright
from sqlexato import sql
import harness
from harness import Fake
harness.CACHE = tempfile.mkdtemp(prefix="rpc_cache_sim_")
harness.LEITURA_MASTER_OK = harness.LEITURA_MASTER_OK + ("master_commission_snapshot_export", "master_commission_operational_detail", "master_commission_snapshot")
FID = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
s = open(os.path.join(AQUI, "fech.sql"), encoding="utf-8", newline="").read(); NOVO = s[s.index("begin;") + 6:s.rindex("commit;")]
pl = json.load(open(os.path.join(AQUI, "saida", "payload_novo.json"), encoding="utf-8"))
lit = lambda v: "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
SUB = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
q = ("begin; " + NOVO + f"\nupdate public.fechamentos_comissao set ativo = false where id = '{FID}';"
     "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + SUB + ", 'role','authenticated')::text, true); end $x$; set local role authenticated; "
     f"select set_config('teste.cid', public.master_close_commission_period('{pl['p_period_id']}'::uuid, {lit(pl['p_summary'])}, {lit(pl['p_rows'])})->>'closing_id', true); "
     "reset role; select json_build_object('snap', public.master_commission_snapshot_export(current_setting('teste.cid')::uuid), 'det', public.master_commission_operational_detail(current_setting('teste.cid')::uuid), "
     "'obs', (select observacao from public.fechamentos_comissao where id = current_setting('teste.cid')::uuid))::text j; rollback;")
sim = json.loads(sql(q)[0]["j"])
oficial = json.loads(sim["obs"])["comissao_total"]
class FakeSim(Fake):
    def handle(self, route):
        u = route.request.url
        body = json.loads(route.request.post_data or "{}") if route.request.method == "POST" else {}
        if body.get("p_closing_id") == FID and "/rest/v1/rpc/master_commission_snapshot_export" in u:
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(sim["snap"]))
        if body.get("p_closing_id") == FID and "/rest/v1/rpc/master_commission_operational_detail" in u:
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(sim["det"]))
        if "/rest/v1/rpc/master_commission_closings" in u:
            r = harness.rpc_real("master_commission_closings", body)
            rows = r["body"].get("rows") if isinstance(r["body"], dict) else r["body"]
            for c in rows or []:
                if c.get("id") == FID: c["observacao"] = sim["obs"]
            return route.fulfill(status=r["status"], content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(r["body"]))
        return super().handle(route)
arq = os.path.join(AQUI, "saida", "_sim_cpf_APAGAR.xlsx")
ok = []
def check(n, c, x=""): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + (f"  [{x}]" if x != "" else ""))
try:
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = harness.contexto(br, os.path.join(AQUI, "homolog"), FakeSim(perfil="MASTER", modulos=["painelMaster"]))
        pg = ctx.new_page(); erros = []; pg.on("pageerror", lambda e: erros.append(str(e)[:200]))
        harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin")
        pg.wait_for_selector(".maSectionItemLink[data-section=historicoCompetencias]", timeout=60000); pg.click(".maSectionItemLink[data-section=historicoCompetencias]")
        pg.wait_for_selector(f".hcRow[data-id='{FID}']", timeout=120000)
        with pg.expect_download(timeout=240000) as dl: pg.click(f".hcRow[data-id='{FID}'] .hcRhdpBtn")
        dl.value.save_as(arq); br.close()
    wb = openpyxl.load_workbook(arq)
    cpf_ok = re.compile(r"^\d{3}\.\d{3}\.\d{3}-\d{2}$")
    for aba in ("2_VENDEDORES", "3_ANALISTAS_GESTOR", "4_GERENTES"):
        ws = wb[aba]; cab = [c.value for c in ws[1]]; i = cab.index("CPF") + 1
        v = [ws.cell(r, i).value for r in range(2, ws.max_row + 1)]
        check(f"{aba}: CPF preenchido e no formato 000.000.000-00", all(x and cpf_ok.match(x) for x in v), f"{sum(1 for x in v if x and cpf_ok.match(x))}/{len(v)}")
    ws = wb["7_AUDITORIA_SPF"]; cab = [c.value for c in ws[1]]
    conta = [ws.cell(r, cab.index("Conta na comissão") + 1).value for r in range(2, ws.max_row + 1)]
    bruto = [ws.cell(r, cab.index("Valor SPF Bruto") + 1).value for r in range(2, ws.max_row + 1)]
    cod = [ws.cell(r, cab.index("Código da Operação") + 1).value for r in range(2, ws.max_row + 1)]
    check("Auditoria SPF: 'Conta na comissão' = Não só nos de R$ 1,00", all((c == "Não") == (b == 1) and c in ("Sim", "Não") for c, b in zip(conta, bruto)), f"Sim={conta.count('Sim')} Não={conta.count('Não')}")
    check("Auditoria SPF: código da operação preenchido", all(cod), f"{sum(1 for c in cod if c)}/{len(cod)}")
    r1 = {str(r[0].value): r[1].value for r in wb["1_RESUMO_PRINCIPAL"].iter_rows() if r[0].value and len(r) > 1}
    w8 = wb["8_MEMORIA_DE_CALCULO"]; c8 = [c.value for c in w8[1]]
    soma = round(sum(w8.cell(r, c8.index("Comissão Total") + 1).value for r in range(2, w8.max_row + 1)), 2)
    check("Resumo = total oficial = soma das linhas (centavos)", round(r1["Comissão Total"], 2) == round(float(oficial), 2) == soma, (r1["Comissão Total"], oficial, soma))
    check("sem erros de JS", not erros, erros[:2])
finally:
    if os.path.exists(arq): os.remove(arq)
    print("arquivo com CPF apagado:", not os.path.exists(arq))
print(f"\n{sum(ok)}/{len(ok)} verificações OK")

"""Monta os envios EXATOS que o navegador mandaria para as Bases 01/02/03 de hoje, com o próprio código da tela
(NX_MASTER_GESTAO_BASES_VM), e grava em imp/payloads/*.json. Os arquivos têm dados reais: ficam só no scratchpad.
Uso: python -I gera_payloads.py <pasta-do-clone>"""
import base64, io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from playwright.sync_api import sync_playwright
import harness
from harness import Fake
ARQ = os.path.join(AQUI, "arquivos"); OUT = os.path.join(AQUI, "payloads"); os.makedirs(OUT, exist_ok=True)
JS = """async ([nome, b64, tipo]) => {
  const VM = window.NX_MASTER_GESTAO_BASES_VM, P = window.NX_MASTER_GESTAO_BASES_PROVIDER;
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const file = new File([bytes], nome);
  const sheet = await VM.gbReadSheet(file, VM.HEADER_ANCHORS[tipo]);
  const sha256 = await VM.gbSha256Hex(sheet.buf);
  const sellers = await P.listSellers({}); const byNbs = {};
  (sellers || []).forEach(s => { const n = VM.gbNormalize(s.nbs); if (n) byNbs[n] = s; });
  const limpa = r => { const c = {}; Object.keys(r).forEach(k => { if (k !== '_diagOk') c[k] = r[k]; }); return c; };
  if (tipo === 'SALES_CURRENT') { const rows = sheet.rows.map((r, i) => limpa(VM.gbBuildBase01Row(r, i + 1, byNbs))); return { sha256, rows, guard: VM.gbBase01DocumentGuard(rows) }; }
  if (tipo === 'FINANCE_CURRENT') { const rows = sheet.rows.map((r, i) => limpa(VM.gbBuildBase02Row(r, i + 1, byNbs))); return { sha256, rows }; }
  const cls = VM.gbClassifyBase03Rows(sheet.rows, sheet.date1904);
  return { sha256, finance_rows: VM.gbBuildBase03FinanceRows(sheet.rows), spf_rows: cls.allRows, principais: cls.principalRows.length, spf_extra: cls.spfRows.length };
}"""
with sync_playwright() as p:
    br = p.chromium.launch(); fake = Fake(perfil="MASTER", modulos=["painelMaster"])
    ctx = harness.contexto(br, sys.argv[1], fake); pg = ctx.new_page()
    harness.entra(pg); pg.goto(harness.HOMOLOG + "index.html#/shell-admin"); pg.wait_for_function("() => window.NX_MASTER_GESTAO_BASES_VM && window.NX_MASTER_GESTAO_BASES_PROVIDER", timeout=60000)
    for nome, tipo in (("Base 01.xlsx", "SALES_CURRENT"), ("Base 02.xlsx", "FINANCE_CURRENT"), ("Base 03.xlsx", "SPF_CURRENT")):
        b64 = base64.b64encode(open(os.path.join(ARQ, nome), "rb").read()).decode()
        r = pg.evaluate(JS, [nome, b64, tipo])
        json.dump(r, open(os.path.join(OUT, tipo + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
        resumo = {k: (len(v) if isinstance(v, list) else v) for k, v in r.items() if k != "sha256"}
        print(nome, tipo, json.dumps(resumo, ensure_ascii=False)[:200])
    br.close()

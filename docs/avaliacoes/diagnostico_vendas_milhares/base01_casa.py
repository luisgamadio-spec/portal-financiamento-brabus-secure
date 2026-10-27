import openpyxl, sys, io, datetime, json, collections
import openpyxl.reader.excel as _rx
_rx.apply_stylesheet = lambda archive, wb: None
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, '.')
from sq import q
ws = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True).worksheets[0]
rows = ws.iter_rows(values_only=True)
for r in rows:
    if r and sum(isinstance(c, str) for c in r) >= 5: head = [str(c).strip() if c else "" for c in r]; break
iv = head.index("Valor Venda"); ic = head.index("Chassi Completo") if "Chassi Completo" in head else head.index("Chassi")
idt = next(i for i, h in enumerate(head) if h.lower().startswith("data venda"))
arq = collections.defaultdict(list)
for r in rows:
    if not r or not r[ic]: continue
    d = r[idt]
    if isinstance(d, str): d = datetime.datetime.strptime(d.strip()[:10], "%d/%m/%Y")
    arq[(str(r[ic]).strip().upper(), d.date().isoformat())].append(float(r[iv]))
ruins = q("select s.chassis, s.sale_date::text d, s.sale_value::float v from public.portal_sales s where s.batch_id='1ab5e700-c927-41e9-a714-7f34db04fdeb' and s.sale_value < 1000")
res = collections.Counter()
for x in ruins:
    vs = arq.get((x["chassis"], x["d"]))
    if not vs: res["não achada no arquivo"] += 1
    elif any(abs(v - x["v"] * 1000) < 0.5 for v in vs): res["arquivo = valor × 1.000"] += 1
    else: res["arquivo com outro valor"] += 1
print(len(ruins), "vendas em milhares:", dict(res))
ex = []
for x in ruins:
    vs = arq.get((x["chassis"], x["d"]))
    if vs and not any(abs(v - x["v"] * 1000) < 0.5 for v in vs): ex.append((x["d"], x["v"], vs))
for e in ex[:8]: print("banco", e[1], "| arquivo", e[2], "| data", e[0])
print("datas dos 53:", collections.Counter(e[0][:7] for e in ex))

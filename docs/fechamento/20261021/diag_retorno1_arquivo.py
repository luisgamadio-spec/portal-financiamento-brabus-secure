"""No arquivo original da Base 02 (19/10, mesmo que foi importado), o que vem na coluna de retorno das linhas com 1,00?
Só leitura do arquivo local; só imprime contagens e nomes de colunas (sem cliente/vendedor/chassi)."""
import io, os, sys, collections
import openpyxl
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ARQ = sys.argv[1]
wb = openpyxl.load_workbook(ARQ, read_only=True, data_only=True); ws = wb.worksheets[0]
linhas = ws.iter_rows(values_only=True); cab = None
for row in linhas:
    if row and any(isinstance(c, str) and "Retorno" in c for c in row): cab = [str(c or "").strip() for c in row]; break
print("colunas de retorno/valor:", [c for c in cab if any(k in c for k in ("Retorno", "Valor", "Taxa", "TC", "Plano", "Servi"))])
ir = [i for i, c in enumerate(cab) if c in ("Retorno Liquido", "Retorno  Liquido", "Retorno Bruto", "Retorno")]
iplan = next((i for i, c in enumerate(cab) if "Plano" in c), None); iserv = next((i for i, c in enumerate(cab) if "Servi" in c), None)
outras = [i for i, c in enumerate(cab) if any(k in c for k in ("Retorno", "TC", "Taxa", "Valor Financiado", "Valor"))]
print("colunas de retorno lidas pela tela (ordem de preferência):", [cab[i] for i in ir])
cont = collections.Counter(); exemplos = collections.Counter(); tipos = collections.Counter()
for row in linhas:
    if not row: continue
    v = row[ir[0]] if ir else None
    if v in (1, 1.0, "1", "1,00", "1.00"):
        cont["retorno=1"] += 1; tipos[type(v).__name__] += 1
        exemplos[(str(row[iplan])[:30] if iplan is not None else "", str(row[iserv])[:30] if iserv is not None else "")] += 1
        for i in outras:
            if i != ir[0]: cont[f"{cab[i]} preenchido"] += row[i] not in (None, "", 0)
print("linhas com retorno exatamente 1 no arquivo:", cont["retorno=1"], "| tipo da célula:", dict(tipos))
print("nessas linhas, outras colunas de valor preenchidas:", {k: v for k, v in cont.items() if k != "retorno=1"})
print("plano / serviço mais comuns nessas linhas:", exemplos.most_common(6))

"""Antes x depois da correção dos indicadores: abas 2–8 idênticas; no Resumo só mudam os 5 indicadores do grupo.
Imprime os indicadores (totais do grupo, não identificam pessoa). Uso: python -I compara_resumo.py antes.xlsx depois.xlsx [esperado.json]"""
import io, sys, json, datetime
import openpyxl
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
A, D = openpyxl.load_workbook(sys.argv[1]), openpyxl.load_workbook(sys.argv[2])
dif = 0
for wa, wd in zip(A.worksheets[1:], D.worksheets[1:]):
    for ra, rd in zip(wa.iter_rows(values_only=True), wd.iter_rows(values_only=True)):
        for x, y in zip(ra, rd):
            if isinstance(x, float) or isinstance(y, float): dif += abs((x or 0) - (y or 0)) > 1e-9
            elif x != y: dif += 1
print("abas 2–8: células diferentes =", dif)
ra = {str(r[0].value): r[1].value for r in A.worksheets[0].iter_rows() if r[0].value}
rd = {str(r[0].value): r[1].value for r in D.worksheets[0].iter_rows() if r[0].value}
mudou = sorted(k for k in set(ra) | set(rd) if ra.get(k) != rd.get(k) and k != "Gerado em")
print("Resumo — linhas que mudaram:", mudou)
for k in ("Quantidade Vendida", "Quantidade Financiada", "Produção Total", "Retorno Total", "SPF Extra", "Comissão Total"):
    print(f"   {k:22} antes {ra.get(k)!s:>14} → depois {rd.get(k)!s:>14}")
if len(sys.argv) > 3:
    esp = json.loads(sys.argv[3]); ok = all(abs(float(rd[k]) - float(v)) < 0.005 for k, v in esp.items())
    print("RESULTADO:", "IGUAL AOS TOTAIS DO GRUPO" if ok and dif == 0 else "DIFERENTE DO ESPERADO")

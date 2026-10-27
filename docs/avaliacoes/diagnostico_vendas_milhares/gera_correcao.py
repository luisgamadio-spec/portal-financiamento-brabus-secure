"""Gera a correção das vendas lançadas em milhares (carga SALES_CURRENT 1ab5e700 de 07/08/2026), a partir do ARQUIVO ORIGINAL.
Casa cada linha errada do banco com o arquivo por chassi + data da venda e pega o valor do arquivo que está a no máximo
R$ 5 do valor do banco × 1.000 (o importador da época arredondou 79.915 para 79,92). Exige exatamente 1 candidato por linha.
Saída: corrige.sql, desfazer.sql, backup.csv (id, valor_antigo, valor_novo). Só lê o banco."""
import csv, datetime, hashlib, io, os, sys, collections
import openpyxl
import openpyxl.reader.excel as _rx
_rx.apply_stylesheet = lambda archive, wb: None
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, ".."))
from sq import q

ARQ = r"C:\Projetos\Completo GIT\data\Base 01.xlsx"
LOTE = "1ab5e700-c927-41e9-a714-7f34db04fdeb"
SHA = "c2ee1c3ca1145c9881477cbc6869983b7714fac40f423eabd19344a210ad0584"
assert hashlib.sha256(open(ARQ, "rb").read()).hexdigest() == SHA, "arquivo não é o da carga"

ws = openpyxl.load_workbook(ARQ, read_only=True, data_only=True).worksheets[0]
linhas = ws.iter_rows(values_only=True)
for r in linhas:
    if r and sum(isinstance(c, str) for c in r) >= 5:
        cab = [str(c).strip() if c else "" for c in r]; break
iv, ic = cab.index("Valor Venda"), cab.index("Chassi Completo")
idt = next(i for i, h in enumerate(cab) if h.lower().startswith("data venda"))
arq = collections.defaultdict(list)
for r in linhas:
    if not r or not r[ic]: continue
    d = r[idt]
    if isinstance(d, str): d = datetime.datetime.strptime(d.strip()[:10], "%d/%m/%Y")
    arq[(str(r[ic]).strip().upper(), d.date().isoformat())].append(float(r[iv]))

ruins = q(f"select id::text id, chassis, sale_date::text d, sale_value::text v from public.portal_sales where batch_id = '{LOTE}' and sale_value < 1000 order by id")
saida, problemas = [], []
for x in ruins:
    v = float(x["v"])
    cands = sorted({c for c in arq.get((x["chassis"], x["d"]), []) if abs(c - v * 1000) <= 5})
    if len(cands) != 1: problemas.append((x["id"], x["d"], v, arq.get((x["chassis"], x["d"]))))
    else: saida.append((x["id"], x["v"], f"{cands[0]:.2f}"))
print("linhas erradas no banco:", len(ruins), "| casadas com 1 valor do arquivo:", len(saida), "| problemas:", len(problemas))
for pr in problemas[:10]: print("  PROBLEMA:", pr)
assert not problemas and len(saida) == 835
exatas = sum(1 for _, a, n in saida if abs(float(a) * 1000 - float(n)) < 0.01)
print("valor do arquivo = banco × 1.000 exato:", exatas, "| diferença de arredondamento (até R$ 5):", len(saida) - exatas)

with open(os.path.join(AQUI, "backup.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["id", "valor_antigo", "valor_novo"]); w.writerows(saida)
valores = ",\n".join(f"  ({i}, {a}, {n})" for i, a, n in saida)
N = len(saida)
corr = f"""-- Corrige o valor de venda de {N} linhas da carga SALES_CURRENT de 07/08/2026 ({LOTE}, arquivo "Base 01.xlsx",
-- SHA-256 {SHA}), lidas na época com o ponto de milhar como vírgula decimal (179.990 -> 179,99).
-- Valor novo = o do arquivo original, casado por chassi + data da venda. Só a coluna sale_value muda.
-- Backup: backup.csv (id, valor_antigo, valor_novo) | Desfazer: desfazer.sql
begin;

create temp table _corr(id bigint primary key, antigo numeric, novo numeric) on commit drop;
insert into _corr(id, antigo, novo) values
{valores};

do $t$ begin
  if (select count(*) from public.portal_sales s join _corr c on c.id = s.id
       where s.sale_value = c.antigo and s.batch_id = '{LOTE}') <> {N} then
    raise exception 'TRAVA: as {N} linhas não estão mais com o valor antigo -- nada foi alterado';
  end if;
end $t$;

update public.portal_sales s set sale_value = c.novo from _corr c where c.id = s.id and s.sale_value = c.antigo;

do $t$ begin
  if (select count(*) from public.portal_sales s join _corr c on c.id = s.id where s.sale_value = c.novo) <> {N} then
    raise exception 'TRAVA: a correção não ficou completa -- desfeita';
  end if;
end $t$;

insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
values ('AJUSTE_BASE', 'Valor de venda corrigido em {N} linhas da carga de 07/08/2026 (Base 01.xlsx): lidas em milhares por erro de leitura; valor do arquivo original casado por chassi e data',
        'SQL manual aprovado pelo responsável', 'Ajuste manual', '', null, true);

commit;
"""
desf = f"""-- Desfaz corrige.sql: volta as {N} linhas ao valor antigo (backup.csv).
begin;
create temp table _corr(id bigint primary key, antigo numeric, novo numeric) on commit drop;
insert into _corr(id, antigo, novo) values
{valores};
do $t$ begin
  if (select count(*) from public.portal_sales s join _corr c on c.id = s.id where s.sale_value = c.novo) <> {N} then
    raise exception 'TRAVA: as {N} linhas não estão com o valor corrigido -- nada a desfazer';
  end if;
end $t$;
update public.portal_sales s set sale_value = c.antigo from _corr c where c.id = s.id and s.sale_value = c.novo;
insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
values ('AJUSTE_BASE', 'Desfeita a correção do valor de venda das {N} linhas da carga de 07/08/2026', 'SQL manual aprovado pelo responsável', 'Ajuste manual', '', null, true);
commit;
"""
open(os.path.join(AQUI, "corrige.sql"), "w", encoding="utf-8", newline="\n").write(corr)
open(os.path.join(AQUI, "desfazer.sql"), "w", encoding="utf-8", newline="\n").write(desf)
print("gerados: corrige.sql, desfazer.sql, backup.csv")

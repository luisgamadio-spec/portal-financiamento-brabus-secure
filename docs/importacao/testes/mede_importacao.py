"""FASE 0 — mede cada etapa das Bases 01, 02 e 03 com os envios reais de hoje, pelo caminho do navegador
(Master, papel authenticated, partes de 500), numa ÚNICA transação com ROLLBACK (nada fica gravado).
Uso: python -I mede_importacao.py [fator]   (fator 1.5 = 50% a mais de linhas, duplicando linhas com novos números)"""
import io, json, os, sys, time
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
FATOR = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
P = lambda n: json.load(open(os.path.join(AQUI, "payloads", n + ".json"), encoding="utf-8"))
sales, fin, b03 = P("SALES_CURRENT"), P("FINANCE_CURRENT"), P("SPF_CURRENT")

def amplia(rows, campo="source_row_number"):
    if FATOR <= 1: return rows
    extra = rows[: int(len(rows) * (FATOR - 1))]
    base = max(r.get(campo) or 0 for r in rows) if campo else 0
    out = list(rows)
    for k, r in enumerate(extra):
        c = dict(r)
        if campo: c[campo] = base + k + 1
        out.append(c)
    return out
S, F = amplia(sales["rows"]), amplia(fin["rows"])
B3F, B3S = amplia(b03["finance_rows"], None), amplia(b03["spf_rows"], "source_row_number" if "source_row_number" in (b03["spf_rows"][0] or {}) else None)
def lit(rows):
    ks = sorted({k for r in rows for k in r})
    comp = {"k": ks, "v": [[r.get(k) for k in ks] for r in rows]}
    s = json.dumps(comp, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
    return ("(select coalesce(jsonb_agg((select jsonb_object_agg(k, a -> (i::int - 1)) from jsonb_array_elements_text(c->'k') with ordinality u(k, i)) order by o), '[]'::jsonb) "
            f"from (select '{s}'::jsonb c) z, jsonb_array_elements(z.c->'v') with ordinality w(a, o))")
BASE = sys.argv[2] if len(sys.argv) > 2 else "todas"

sql = [f"""begin;
set local statement_timeout = '600s';
create temp table _t(ordem serial, base text, etapa text, ms numeric, linhas int, retorno text) on commit drop;
grant all on _t to public; grant usage on sequence _t_ordem_seq to public;
create temp table _p(nome text primary key, j jsonb) on commit drop; grant all on _p to public;
{"insert into _p values ('sales', " + lit(S) + ");" if BASE in ('01',) else ""}
{"insert into _p values ('fin', " + lit(F) + ");" if BASE in ('02',) else ""}
{"insert into _p values ('b3f', " + lit(B3F) + "), ('b3s', " + lit(B3S) + ");" if BASE in ('03p', '03g') else ""}
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', {MASTER}, 'role','authenticated')::text, true); end $x$;
set local role authenticated;
do $m$
declare t0 timestamptz; b uuid; n int; tot int; parte jsonb; i int; r jsonb;
  -- uma "chamada do navegador" = uma instrução; medimos cada uma isoladamente
begin
  -- BASE 01
  if exists (select 1 from _p where nome = 'sales') then
  select jsonb_array_length(j) into tot from _p where nome = 'sales';
  t0 := clock_timestamp(); b := public.master_operational_begin_import('SALES_CURRENT', 'Base 01.xlsx', repeat('a', 64), tot);
  insert into _t(base, etapa, ms, linhas) values ('01', 'abrir lote', extract(epoch from clock_timestamp() - t0) * 1000, tot);
  i := 0;
  while i < tot loop
    select jsonb_agg(e order by o) into parte from _p, jsonb_array_elements(_p.j) with ordinality as x(e, o) where _p.nome = 'sales' and o > i and o <= i + 500;
    t0 := clock_timestamp(); n := public.master_operational_import_sales(b, parte);
    insert into _t(base, etapa, ms, linhas, retorno) values ('01', 'gravar parte ' || (i / 500 + 1), extract(epoch from clock_timestamp() - t0) * 1000, jsonb_array_length(parte), n::text);
    i := i + 500;
  end loop;
  t0 := clock_timestamp(); perform public.master_operational_finalize_import(b, tot, 0, 'medição');
  insert into _t(base, etapa, ms) values ('01', 'confirmar (finalize)', extract(epoch from clock_timestamp() - t0) * 1000);
  end if;
  -- BASE 02
  if exists (select 1 from _p where nome = 'fin') then
  select jsonb_array_length(j) into tot from _p where nome = 'fin';
  t0 := clock_timestamp(); b := public.master_operational_begin_import('FINANCE_CURRENT', 'Base 02.xlsx', repeat('b', 64), tot);
  insert into _t(base, etapa, ms, linhas) values ('02', 'abrir lote', extract(epoch from clock_timestamp() - t0) * 1000, tot);
  i := 0;
  while i < tot loop
    select jsonb_agg(e order by o) into parte from _p, jsonb_array_elements(_p.j) with ordinality as x(e, o) where _p.nome = 'fin' and o > i and o <= i + 500;
    t0 := clock_timestamp(); n := public.master_operational_import_finance(b, parte);
    insert into _t(base, etapa, ms, linhas, retorno) values ('02', 'gravar parte ' || (i / 500 + 1), extract(epoch from clock_timestamp() - t0) * 1000, jsonb_array_length(parte), n::text);
    i := i + 500;
  end loop;
  t0 := clock_timestamp(); perform public.master_operational_finalize_import(b, tot, 0, 'medição');
  insert into _t(base, etapa, ms) values ('02', 'confirmar (finalize)', extract(epoch from clock_timestamp() - t0) * 1000);
  end if;
  -- BASE 03 (prévia e gravação: cada uma é UMA chamada com o arquivo inteiro)
  if exists (select 1 from _p where nome = 'b3f') then
  if {'true' if BASE == '03p' else 'false'} then
  t0 := clock_timestamp(); r := public.master_operational_apply_base03('Base 03.xlsx', repeat('c', 64), (select j from _p where nome = 'b3f'), (select j from _p where nome = 'b3s'), true);
  insert into _t(base, etapa, ms, retorno) values ('03', 'prévia (dry run)', extract(epoch from clock_timestamp() - t0) * 1000, 'enriqueceria=' || (r->>'finance_rows_matched'));
  else
  t0 := clock_timestamp(); r := public.master_operational_apply_base03('Base 03.xlsx', repeat('c', 64), (select j from _p where nome = 'b3f'), (select j from _p where nome = 'b3s'), false);
  insert into _t(base, etapa, ms, retorno) values ('03', 'gravação (SPF + enriquecimento)', extract(epoch from clock_timestamp() - t0) * 1000,
    format('enriquecidas=%s spf=%s principais=%s', r->>'finance_rows_matched', r->>'spf_accepted', r->>'spf_principal_accepted'));
  end if;
  end if;
end $m$;
reset role;
select base, etapa, round(ms)::int ms, linhas, retorno from _t order by ordem;
rollback;"""]
t = time.time(); rows = q("\n".join(sql)); dt = time.time() - t
print(f"Base {BASE} | fator {FATOR}: vendas {len(S)}, financiamentos {len(F)}, Base 03 {len(B3F)} financeiras / {len(B3S)} SPF — tudo desfeito (rollback); {dt:.0f}s no total")
for r in rows:
    flag = "  << PASSARIA DE 8 s" if r["ms"] > 8000 else ("  < perto do limite" if r["ms"] > 5000 else "")
    print(f"Base {r['base']}  {r['etapa']:<34} {r['ms']:>7} ms  {r['linhas'] or '':>5}  {r['retorno'] or ''}{flag}")

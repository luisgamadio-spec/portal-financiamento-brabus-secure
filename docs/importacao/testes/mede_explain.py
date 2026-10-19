"""EXPLAIN ANALYZE das instruções REAIS de master_operational_import_finance (texto copiado da função publicada),
com a parte 1 da Base 02 de hoje, como Master, em ROLLBACK. Mostra onde o tempo vai dentro de uma parte."""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
fn = open(os.path.join(AQUI, "master_operational_import_finance.sql"), encoding="utf-8").read()
ini = fn.index("  create temp table tmp_reconciliacao_vendedor_finance on commit drop as"); fim = fn.index("  with upserted as (")
criar = fn[ini:fim].strip().rstrip(";")
ini2 = fn.index("  with upserted as ("); fim2 = fn.index("  perform public.registrar_alertas_reconciliacao_lote(")
upsert = fn[ini2:fim2].strip().replace("select count(*) into v_count from upserted;", "select count(*) from upserted").rstrip(";")
parte = int(sys.argv[1]) if len(sys.argv) > 1 else 1
rows = json.load(open(os.path.join(AQUI, "payloads", "FINANCE_CURRENT.json"), encoding="utf-8"))["rows"][(parte - 1) * 500: parte * 500]
ks = sorted({k for r in rows for k in r}); comp = json.dumps({"k": ks, "v": [[r.get(k) for k in ks] for r in rows]}, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
payload = ("(select jsonb_agg((select jsonb_object_agg(k, a -> (i::int - 1)) from jsonb_array_elements_text(c->'k') with ordinality u(k, i)) order by o) "
           f"from (select '{comp}'::jsonb c) z, jsonb_array_elements(z.c->'v') with ordinality w(a, o))")
sql = f"""begin;
set local statement_timeout = '300s';
create temp table _in as select {payload} as j;
create temp table _plan(linha text);
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', {MASTER}, 'role','authenticated')::text, true); end $x$;
do $d$
declare b uuid; l text; t0 timestamptz;
begin
  b := public.master_operational_begin_import('FINANCE_CURRENT', 'medição', repeat('e', 64), 500);
  insert into _plan values ('=== CRIAR tabela de reconciliação (classificação + herança do vendedor) ===');
  for l in execute 'explain (analyze, buffers, timing) ' || replace($q${criar}$q$, 'p_rows', '(select j from _in)') loop insert into _plan values (l); end loop;
  drop table if exists tmp_reconciliacao_vendedor_finance;
  execute replace($q${criar}$q$, 'p_rows', '(select j from _in)');
  insert into _plan values ('=== GRAVAR (upsert em portal_finance_operations) ===');
  for l in execute 'explain (analyze, buffers, timing) ' || replace($q${upsert}$q$, 'p_batch_id', quote_literal(b) || '::uuid') loop insert into _plan values (l); end loop;
  t0 := clock_timestamp();
  perform public.portal_fechar_alertas_cadastro_resolvidos();
  insert into _plan values ('=== encerramento de pendências: ' || round(extract(epoch from clock_timestamp() - t0) * 1000) || ' ms');
end $d$;
select linha from _plan;
rollback;"""
for r in q(sql):
    l = r["linha"]
    if "GRAVAR" in l: break
    if "Buffers" not in l: print(l[:200])

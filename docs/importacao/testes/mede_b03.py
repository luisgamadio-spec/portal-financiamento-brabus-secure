"""FASE 2 — onde vai o tempo da gravação da Base 03 (ROLLBACK): enriquecimento dos financiamentos × SPF parte a parte.
Uso: python -I mede_b03.py <fator>"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
FATOR = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
b3 = json.load(open(os.path.join(AQUI, "payloads", "SPF_CURRENT.json"), encoding="utf-8"))
fr, sr = b3["finance_rows"], b3["spf_rows"]
if FATOR > 1:
    fr = fr + [dict(r) for r in fr[: int(len(fr) * (FATOR - 1))]]
    mx = max(r["source_row_number"] for r in sr); extra = []
    for k, r in enumerate(sr[: int(len(sr) * (FATOR - 1))]):
        c = dict(r); c["source_row_number"] = mx + k + 1; extra.append(c)
    sr = sr + extra
def lit(rows):
    ks = sorted({k for r in rows for k in r}); comp = json.dumps({"k": ks, "v": [[r.get(k) for k in ks] for r in rows]}, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
    return ("(select coalesce(jsonb_agg((select jsonb_object_agg(k, a -> (i::int - 1)) from jsonb_array_elements_text(c->'k') with ordinality u(k, i)) order by o), '[]'::jsonb) "
            f"from (select '{comp}'::jsonb c) z, jsonb_array_elements(z.c->'v') with ordinality w(a, o))")
sql = f"""begin;
set local statement_timeout = '600s';
create temp table _p(f jsonb, s jsonb) on commit drop; insert into _p select {lit(fr)}, {lit(sr)};
create temp table _t(ordem serial, etapa text, ms numeric, retorno text) on commit drop;
grant all on _p, _t to public; grant usage on sequence _t_ordem_seq to public;
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', {MASTER}, 'role','authenticated')::text, true); end $x$;
set local role authenticated;
do $m$
declare t0 timestamptz; r jsonb; b uuid; tot int; i int := 0; parte jsonb; n int; ac int := 0; sha text := md5(random()::text) || md5(random()::text);
begin
  t0 := clock_timestamp();
  r := public.master_operational_apply_base03('Base 03.xlsx', sha, (select f from _p), '[]'::jsonb, false);
  insert into _t(etapa, ms, retorno) values ('enriquecimento dos financiamentos (só ele)', extract(epoch from clock_timestamp() - t0) * 1000, 'enriquecidas=' || (r->>'finance_rows_matched'));
  select jsonb_array_length(s) into tot from _p;
  t0 := clock_timestamp(); b := public.master_operational_begin_import('SPF_CURRENT', 'Base 03.xlsx', sha, tot);
  insert into _t(etapa, ms) values ('abrir lote SPF', extract(epoch from clock_timestamp() - t0) * 1000);
  while i < tot loop
    select jsonb_agg(e order by o) into parte from _p, jsonb_array_elements(_p.s) with ordinality x(e, o) where o > i and o <= i + 500;
    t0 := clock_timestamp(); n := public.master_operational_import_spf(b, parte); ac := ac + n;
    insert into _t(etapa, ms, retorno) values ('SPF parte ' || (i / 500 + 1), extract(epoch from clock_timestamp() - t0) * 1000, n::text);
    i := i + 500;
  end loop;
  t0 := clock_timestamp(); perform public.master_operational_finalize_import(b, ac, tot - ac, 'medição');
  insert into _t(etapa, ms) values ('confirmar lote SPF', extract(epoch from clock_timestamp() - t0) * 1000);
end $m$;
reset role;
select etapa, round(ms)::int ms, retorno from _t order by ordem;
rollback;"""
r = q(sql)
spf = [x for x in r if x["etapa"].startswith("SPF parte")]
print(f"fator {FATOR}: {len(fr)} financeiras, {len(sr)} SPF")
for x in r:
    if not x["etapa"].startswith("SPF parte"): print(f"  {x['etapa']:<45} {x['ms']:>6} ms  {x['retorno'] or ''}")
print(f"  SPF em {len(spf)} partes: maior {max(x['ms'] for x in spf)} ms, soma {sum(x['ms'] for x in spf)} ms, aceitas {sum(int(x['retorno']) for x in spf)}")

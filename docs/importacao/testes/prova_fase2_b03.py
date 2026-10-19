"""Prova da FASE 2 da Base 03 (ROLLBACK, nada fica gravado).
Uso: python -I prova_fase2_b03.py <atual|fase2|travas> <fator>
 atual  = apply_base03 numa chamada (como hoje)
 fase2  = begin_import + import_spf em partes + base03_consolidar (função criada dentro da transação)
 travas = fase2 com: sem financeiras (bloqueia), só SPF Extra (bloqueia), consolidar 2× (recusa)"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
MODO, FATOR = sys.argv[1], float(sys.argv[2])
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
f2 = open(os.path.join(AQUI, "fase2_b03.sql"), encoding="utf-8").read() if MODO in ("fase2", "travas") else ""
SPF_COLS = "source_row_number, operation_date, client_match_key, store, department, modality, operation_code, status, bank, financed_value, installments, installment_value, balloon_value, is_spf_extra, optional_name, optional_value"
FIN_COLS = "id, vehicle_model, installments, installment_value, balloon_value, tc_devolvida, plan_codigo_if"
fluxo_fase2 = """
  t0 := clock_timestamp(); b := public.master_operational_begin_import('SPF_CURRENT', 'Base 03.xlsx', sha, (select jsonb_array_length(s) from _p));
  insert into _t(etapa, ms) values ('abrir lote SPF', extract(epoch from clock_timestamp() - t0) * 1000);
  select jsonb_array_length(s) into tot from _p;
  while i < tot loop
    select jsonb_agg(e order by o) into parte from _p, jsonb_array_elements(_p.s) with ordinality x(e, o) where o > i and o <= i + 500;
    t0 := clock_timestamp(); perform public.master_operational_import_spf(b, parte);
    insert into _t(etapa, ms) values ('SPF parte ' || (i / 500 + 1), extract(epoch from clock_timestamp() - t0) * 1000);
    i := i + 500;
  end loop;"""
if MODO == "atual":
    corpo = """  t0 := clock_timestamp(); r := public.master_operational_apply_base03('Base 03.xlsx', sha, (select f from _p), (select s from _p), false);
  insert into _t(etapa, ms, retorno) values ('apply_base03 (uma chamada)', extract(epoch from clock_timestamp() - t0) * 1000, r::text);
  b := (r->>'spf_batch_id')::uuid;"""
elif MODO == "fase2":
    corpo = fluxo_fase2 + """
  t0 := clock_timestamp(); r := public.master_operational_base03_consolidar(b, (select f from _p));
  insert into _t(etapa, ms, retorno) values ('consolidar (enriquecimento + travas + confirmar)', extract(epoch from clock_timestamp() - t0) * 1000, r::text);"""
else:
    corpo = fluxo_fase2 + """
  begin r := public.master_operational_base03_consolidar(b, '[]'::jsonb); insert into _t(etapa, retorno) values ('trava: sem financeiras', 'NÃO BLOQUEOU');
  exception when others then insert into _t(etapa, retorno) values ('trava: sem financeiras', 'bloqueou: ' || left(sqlerrm, 90)); end;
  begin execute 'reset role'; update public.portal_spf_operations set is_spf_extra = true where batch_id = b; execute 'set local role authenticated';
    r := public.master_operational_base03_consolidar(b, (select f from _p)); insert into _t(etapa, retorno) values ('trava: só SPF Extra', 'NÃO BLOQUEOU');
  exception when others then insert into _t(etapa, retorno) values ('trava: só SPF Extra', 'bloqueou: ' || left(sqlerrm, 90)); end;
  execute 'reset role'; update public.portal_spf_operations o set is_spf_extra = (e->>'is_spf_extra')::boolean from _p, jsonb_array_elements(_p.s) e where o.batch_id = b and o.source_row_number = (e->>'source_row_number')::int; execute 'set local role authenticated';
  r := public.master_operational_base03_consolidar(b, (select f from _p)); insert into _t(etapa, retorno) values ('consolidar 1ª vez', 'ok: enriquecidas=' || (r->>'finance_rows_matched'));
  begin r := public.master_operational_base03_consolidar(b, (select f from _p)); insert into _t(etapa, retorno) values ('consolidar 2ª vez', 'NÃO RECUSOU');
  exception when others then insert into _t(etapa, retorno) values ('consolidar 2ª vez', 'recusou: ' || left(sqlerrm, 60)); end;"""
sql = f"""begin;
set local statement_timeout = '600s';
{f2}
create temp table _p(f jsonb, s jsonb) on commit drop; insert into _p select {lit(fr)}, {lit(sr)};
create temp table _t(ordem serial, etapa text, ms numeric, retorno text) on commit drop;
create temp table _b(id uuid) on commit drop;
grant all on _p, _t, _b to public; grant usage on sequence _t_ordem_seq to public;
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', {MASTER}, 'role','authenticated')::text, true); end $x$;
set local role authenticated;
do $m$
declare t0 timestamptz; r jsonb; b uuid; tot int; i int := 0; parte jsonb; sha text := md5(random()::text) || md5(random()::text);
begin
{corpo}
  insert into _b values (b);
end $m$;
reset role;
insert into _t(etapa, retorno) select 'digital SPF gravado', md5(string_agg(row({SPF_COLS})::text, '|' order by source_row_number)) || ' (' || count(*) || ' linhas)'
  from public.portal_spf_operations where batch_id = (select id from _b);
insert into _t(etapa, retorno) select 'digital do enriquecimento (Base 02 oficial)', md5(string_agg(row({FIN_COLS})::text, '|' order by id))
  from public.portal_finance_operations where batch_id = (select id from public.portal_import_batches where source_type='FINANCE_CURRENT' and status='VALIDATED' order by completed_at desc nulls last, created_at desc, id desc limit 1);
insert into _t(etapa, retorno) select 'lote SPF', status || ' | ' || validation_message from public.portal_import_batches where id = (select id from _b);
select etapa, round(ms)::int ms, retorno from _t order by ordem;
rollback;"""
r = q(sql)
spf = [x for x in r if x["etapa"].startswith("SPF parte")]
print(f"Base 03 | {MODO} | fator {FATOR}: {len(fr)} financeiras, {len(sr)} SPF")
if spf: print(f"  SPF em {len(spf)} partes: maior {max(x['ms'] for x in spf)} ms, soma {sum(x['ms'] for x in spf)} ms")
for x in r:
    if x["etapa"].startswith("SPF parte"): continue
    ret = x["retorno"] or ""
    if ret.startswith("{"):
        j = json.loads(ret); ret = f"enriquecidas={j.get('finance_rows_matched')} spf={j.get('spf_accepted')} principais={j.get('spf_principal_accepted')} ambíguos={j.get('finance_rows_ambiguous_excluded')}"
    print(f"  {x['etapa']:<50} {('' if x['ms'] is None else str(x['ms']) + ' ms'):>9}  {ret[:230]}")

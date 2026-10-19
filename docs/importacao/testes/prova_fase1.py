"""Prova da FASE 1 (ROLLBACK, nada fica gravado): mesma importação com o código ATUAL e com o da FASE 1.
Compara o tempo de cada parte e uma impressão digital (md5) das linhas gravadas e das pendências geradas.
Uso: python -I prova_fase1.py <atual|fase1> <fator> <01|02>"""
import io, json, os, sys, time
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
MODO, FATOR, BASE = sys.argv[1], float(sys.argv[2]), sys.argv[3]
nome = {"01": "SALES_CURRENT", "02": "FINANCE_CURRENT"}[BASE]
rows = json.load(open(os.path.join(AQUI, "payloads", nome + ".json"), encoding="utf-8"))["rows"]
if FATOR > 1:
    mx = max(r["source_row_number"] for r in rows); extra = []
    for k, r in enumerate(rows[: int(len(rows) * (FATOR - 1))]):
        c = dict(r); c["source_row_number"] = mx + k + 1; extra.append(c)
    rows = rows + extra
ks = sorted({k for r in rows for k in r}); comp = json.dumps({"k": ks, "v": [[r.get(k) for k in ks] for r in rows]}, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
payload = ("(select jsonb_agg((select jsonb_object_agg(k, a -> (i::int - 1)) from jsonb_array_elements_text(c->'k') with ordinality u(k, i)) order by o) "
           f"from (select '{comp}'::jsonb c) z, jsonb_array_elements(z.c->'v') with ordinality w(a, o))")
fase1 = open(os.path.join(AQUI, "fase1.sql"), encoding="utf-8").read() if MODO == "fase1" else ""
fn = "master_operational_import_sales" if BASE == "01" else "master_operational_import_finance"
tab = "portal_sales" if BASE == "01" else "portal_finance_operations"
cols = ("source_row_number, sale_date, chassis, seller_id, seller_user_id, seller_cpf_normalizado, seller_nbs, store, department, client_document_match_key"
        if BASE == "01" else
        "source_row_number, operation_date, chassis, seller_id, seller_user_id, seller_cpf_normalizado, seller_nbs, store, service_description, is_real_financing, is_spf, return_value, financed_or_service_value, client_match_key, finance_code")
sql = f"""begin;
set local statement_timeout = '600s';
{fase1}
create temp table _p(j jsonb) on commit drop; insert into _p select {payload};
create temp table _t(ordem serial, etapa text, ms numeric, retorno text) on commit drop;
grant all on _p, _t to public; grant usage on sequence _t_ordem_seq to public;
create temp table _a0 on commit drop as select id, tipo, identificador_tipo, identificador_valor, status, quantidade_ocorrencias from public.portal_cadastro_alertas;
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', {MASTER}, 'role','authenticated')::text, true); end $x$;
set local role authenticated;
do $m$
declare t0 timestamptz; b uuid; n int; tot int; parte jsonb; i int := 0;
begin
  select jsonb_array_length(j) into tot from _p;
  b := public.master_operational_begin_import('{nome}', 'prova', repeat('f', 64), tot);
  insert into _t(etapa, retorno) values ('lote', b::text);
  while i < tot loop
    select jsonb_agg(e order by o) into parte from _p, jsonb_array_elements(_p.j) with ordinality x(e, o) where o > i and o <= i + 500;
    t0 := clock_timestamp(); n := public.{fn}(b, parte);
    insert into _t(etapa, ms, retorno) values ('parte ' || (i / 500 + 1), extract(epoch from clock_timestamp() - t0) * 1000, n::text);
    i := i + 500;
  end loop;
end $m$;
reset role;
insert into _t(etapa, retorno) select 'digital das linhas', md5(string_agg(row({cols})::text, '|' order by source_row_number)) from public.{tab} where batch_id = (select retorno::uuid from _t where etapa = 'lote');
insert into _t(etapa, retorno) select 'digital das pendências', md5(coalesce(string_agg(row(a.tipo, a.identificador_tipo, a.identificador_valor, a.status, a.quantidade_ocorrencias, a.usuario_candidato_id, a.severidade)::text, '|' order by row(a.tipo, a.identificador_tipo, a.identificador_valor, a.status, a.quantidade_ocorrencias, a.usuario_candidato_id, a.severidade)::text), ''))
  from public.portal_cadastro_alertas a;
insert into _t(etapa, retorno) select 'pendências novas ou alteradas', count(*)::text from public.portal_cadastro_alertas a
  where not exists (select 1 from _a0 o where o.id = a.id and o.status = a.status and o.quantidade_ocorrencias = a.quantidade_ocorrencias);
insert into _t(etapa, retorno) select 'pend ' || md5(a.tipo || a.identificador_tipo || a.identificador_valor || a.status),
  json_build_object('qtd', a.quantidade_ocorrencias, 'cand', left(md5(coalesce(a.usuario_candidato_id::text, '-')), 6), 'sev', a.severidade, 'nome', left(md5(coalesce(a.nome_encontrado, '-')), 6),
    'nbs', left(md5(coalesce(a.login_nbs_encontrado, '-')), 6), 'loja', a.loja_encontrada)::text
  from public.portal_cadastro_alertas a where not exists (select 1 from _a0 o where o.id = a.id and o.status = a.status and o.quantidade_ocorrencias = a.quantidade_ocorrencias);
select etapa, round(ms)::int ms, retorno from _t where etapa <> 'lote' order by ordem;
rollback;"""
r = q(sql)
partes = [x for x in r if x["etapa"].startswith("parte")]
print(f"Base {BASE} | {MODO} | fator {FATOR} | {len(rows)} linhas | maior parte {max(x['ms'] for x in partes)} ms | soma {sum(x['ms'] for x in partes)} ms")
print("  partes (ms):", " ".join(str(x["ms"]) for x in partes), "| aceitas:", sum(int(x["retorno"]) for x in partes))
for x in r:
    if not x["etapa"].startswith("parte"): print(f"  {x['etapa']}: {x['retorno']}")

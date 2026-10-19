"""FASE 0 — quanto pesa cada causa, numa parte de 500 linhas da Base 02 e da Base 01 de hoje (só leitura + ROLLBACK)."""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
fin = json.load(open(os.path.join(AQUI, "payloads", "FINANCE_CURRENT.json"), encoding="utf-8"))["rows"][:500]
sal = json.load(open(os.path.join(AQUI, "payloads", "SALES_CURRENT.json"), encoding="utf-8"))["rows"][:500]
def lit(rows):
    ks = sorted({k for r in rows for k in r}); comp = {"k": ks, "v": [[r.get(k) for k in ks] for r in rows]}
    s = json.dumps(comp, ensure_ascii=False, separators=(",", ":")).replace("'", "''")
    return ("(select jsonb_agg((select jsonb_object_agg(k, a -> (i::int - 1)) from jsonb_array_elements_text(c->'k') with ordinality u(k, i)) order by o) "
            f"from (select '{s}'::jsonb c) z, jsonb_array_elements(z.c->'v') with ordinality w(a, o))")
TEMPO = "(select ms from _m order by id desc limit 1)"
sql = f"""begin;
set local statement_timeout = '300s';
create temp table _m(id serial, causa text, ms numeric) on commit drop;
create temp table _in(j jsonb, js jsonb) on commit drop;
insert into _in values ({lit(fin)}, {lit(sal)});
do $d$
declare t0 timestamptz; n int;
begin
  -- 1) Herança do vendedor: previous_resolution sobre TODO o histórico validado (Base 02)
  t0 := clock_timestamp();
  select count(*) into n from (
    select distinct on (f.chassis, f.service_description) f.chassis
    from public.portal_finance_operations f join public.portal_import_batches b on b.id = f.batch_id
    where b.status = 'VALIDATED' and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY') and f.seller_user_id is not null and f.chassis is not null
    order by f.chassis, f.service_description, b.completed_at desc nulls last, b.created_at desc, f.id desc) x;
  insert into _m(causa, ms) values ('B02 herança do vendedor (histórico inteiro: ' || n || ' chaves)', extract(epoch from clock_timestamp() - t0) * 1000);
  -- 1b) mesma herança limitada aos chassis da parte (o que de fato é usado)
  t0 := clock_timestamp();
  select count(*) into n from (
    select distinct on (f.chassis, f.service_description) f.chassis
    from public.portal_finance_operations f join public.portal_import_batches b on b.id = f.batch_id
    where b.status = 'VALIDATED' and b.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY') and f.seller_user_id is not null
      and f.chassis in (select upper(regexp_replace(e->>'chassis', '[^A-Za-z0-9]', '', 'g')) from _in, jsonb_array_elements(_in.j) e)
    order by f.chassis, f.service_description, b.completed_at desc nulls last, b.created_at desc, f.id desc) x;
  insert into _m(causa, ms) values ('B02 herança só dos chassis da parte (sem índice de chassi)', extract(epoch from clock_timestamp() - t0) * 1000);
  -- 2) Busca de usuários por linha com portal_normaliza_nbs (Login NBS, 13/10)
  t0 := clock_timestamp();
  select count(*) into n from (
    select (select count(*) from public.usuarios u where public.portal_normaliza_nbs(u.login_nbs) = public.portal_normaliza_nbs(e->>'seller_nbs') and u.ativo) a,
           (select u.id from public.usuarios u where public.portal_normaliza_nbs(u.login_nbs) = public.portal_normaliza_nbs(e->>'seller_nbs') and u.ativo limit 1) b
    from _in, jsonb_array_elements(_in.j) e) x;
  insert into _m(causa, ms) values ('B02 busca de usuário por Login NBS normalizado (500 linhas × 2)', extract(epoch from clock_timestamp() - t0) * 1000);
  t0 := clock_timestamp();
  select count(*) into n from (
    select (select count(*) from public.usuarios u where u.cpf_normalizado = regexp_replace(coalesce(e->>'seller_cpf', ''), '\\D', '', 'g') and u.ativo) a
    from _in, jsonb_array_elements(_in.j) e) x;
  insert into _m(causa, ms) values ('B02 busca de usuário por CPF (com índice)', extract(epoch from clock_timestamp() - t0) * 1000);
  -- 3) Herança na Base 01 (portal_sales, histórico inteiro)
  t0 := clock_timestamp();
  select count(*) into n from (
    select distinct on (s.chassis) s.chassis from public.portal_sales s join public.portal_import_batches b on b.id = s.batch_id
    where b.status = 'VALIDATED' and s.seller_user_id is not null and s.chassis is not null
    order by s.chassis, b.completed_at desc nulls last, b.created_at desc, s.id desc) x;
  insert into _m(causa, ms) values ('B01 herança do vendedor (histórico inteiro: ' || n || ' chassis)', extract(epoch from clock_timestamp() - t0) * 1000);
  -- 4) Encerramento automático de pendências (roda 2× por parte na B02 e na B01)
  t0 := clock_timestamp(); n := public.portal_fechar_alertas_cadastro_resolvidos();
  insert into _m(causa, ms) values ('encerramento automático de pendências (1 chamada; ' || n || ' fechadas)', extract(epoch from clock_timestamp() - t0) * 1000);
end $d$;
select causa, round(ms)::int ms from _m order by id;
rollback;"""
for r in q(sql): print(f"{r['ms']:>7} ms  {r['causa']}")

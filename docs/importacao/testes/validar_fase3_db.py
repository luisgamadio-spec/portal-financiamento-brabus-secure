"""Valida fase3_db.sql numa transação com ROLLBACK (nada fica gravado). Saída OK/FALHA."""
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(AQUI, "..", "hpe_v3")); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q
from rpc import MASTER
F3 = open(os.path.join(AQUI, "fase3_db.sql"), encoding="utf-8").read()
RB = open(os.path.join(AQUI, "fase3_db_rollback.sql"), encoding="utf-8").read()
VEND = "(select u.auth_user_id from public.usuarios u where upper(u.perfil)='VENDEDOR' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
def como(sub, nome, expr):
    return f"""do $v$ declare v text; begin
  perform set_config('request.jwt.claims', json_build_object('sub', {sub}, 'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute $q${expr}$q$ into v; insert into _v values ('{nome}', coalesce(v, 'null'));
  exception when others then insert into _v values ('{nome}', 'ERRO:' || sqlstate || ' ' || left(sqlerrm, 120)); end;
  execute 'reset role';
end $v$;"""
oficial = "(select source_sha256 from public.portal_import_batches where source_type='FINANCE_CURRENT' and status='VALIDATED' order by completed_at desc limit 1)"
sql = f"""begin;
set local statement_timeout = '120s';
create temp table _v(nome text, valor text) on commit drop; grant all on _v to public;
{F3}
-- cenário: um lote em validação abandonado há 7 h e outro de 1 h atrás (inseridos só nesta transação)
insert into public.portal_import_batches (source_type, original_filename, source_sha256, rows_read, status, imported_by, created_at, ultima_atividade_em)
values ('SALES_CURRENT', 'teste-7h', repeat('7', 64), 10, 'VALIDATING', {MASTER}, now() - interval '7 hours', now() - interval '7 hours'),
       ('SALES_CURRENT', 'teste-1h', repeat('1', 64), 10, 'VALIDATING', {MASTER}, now() - interval '1 hour', now() - interval '1 hour');
{como(MASTER, 'abrir lote novo', "select public.master_operational_begin_import('FINANCE_CURRENT', 'teste', md5(random()::text) || md5(random()::text), 5)::text")}
insert into _v select 'lote de 7 h', status || ' | ' || coalesce(validation_message, '') from public.portal_import_batches where source_sha256 = repeat('7', 64);
insert into _v select 'lote de 1 h', status from public.portal_import_batches where source_sha256 = repeat('1', 64);
create temp table _x on commit drop as select (select id from public.portal_import_batches where source_sha256 = repeat('1', 64)) id1h, {oficial} sha_oficial;
grant all on _x to public;
{como(MASTER, 'reabrir lote em validação (1 h)', "select (public.master_operational_begin_import('SALES_CURRENT', 'teste-1h', repeat('1', 64), 10) = (select id1h from _x))::text")}
{como(MASTER, 'reabrir lote CONFIRMADO (Base 02 oficial)', "select public.master_operational_begin_import('FINANCE_CURRENT', 'Base 02.xlsx', (select sha_oficial from _x), 2897)::text")}
insert into _v select 'Base 02 oficial continua confirmada', status from public.portal_import_batches where source_sha256 = {oficial.replace("status='VALIDATED' and ", "")} ;
{como(MASTER, 'duração normal (sem aviso)', "select public.master_operational_registrar_duracao(jsonb_build_object('source_type','FINANCE_CURRENT','arquivo','Base 02.xlsx','linhas',2897,'partes',6,'total_ms',2400,'maior_chamada_ms',610,'resultado','SUCESSO'))::text")}
{como(MASTER, 'duração lenta (com aviso)', "select public.master_operational_registrar_duracao(jsonb_build_object('source_type','SALES_CURRENT','arquivo','Base 01.xlsx','linhas',2096,'partes',5,'total_ms',26000,'maior_chamada_ms',7900,'resultado','SUCESSO'))::text")}
{como(MASTER, 'falha (com aviso)', "select public.master_operational_registrar_duracao(jsonb_build_object('source_type','SPF_CURRENT','arquivo','Base 03.xlsx','total_ms',9000,'maior_chamada_ms',8000,'resultado','FALHA','erro','canceling statement due to statement timeout'))::text")}
{como(VEND, 'vendedor registrando duração', "select public.master_operational_registrar_duracao(jsonb_build_object('source_type','SPF_CURRENT','total_ms',1,'maior_chamada_ms',1,'resultado','SUCESSO'))::text")}
{como(VEND, 'vendedor lendo durações', "select public.master_operational_list_duracoes(5)::text")}
{como(MASTER, 'Master lendo durações', "select jsonb_array_length(public.master_operational_list_duracoes(5))::text")}
insert into _v select 'avisos na Auditoria', string_agg(tipo || ': ' || left(descricao, 110), ' || ' order by tipo) from public.auditoria where criado_em >= now() and base_origem = 'Gestão de Bases';
{como(VEND, 'vendedor lendo a tabela direto', "select count(*)::text from public.portal_import_duracoes")}
{RB}
insert into _v select 'rollback remove tudo', (to_regclass('public.portal_import_duracoes') is null and to_regprocedure('public.master_operational_registrar_duracao(jsonb)') is null
  and not exists (select 1 from information_schema.columns where table_name = 'portal_import_batches' and column_name = 'ultima_atividade_em'))::text;
select nome, valor from _v;
rollback;"""
r = {x["nome"]: x["valor"] for x in q(sql)}
ok = []
def check(n, c): ok.append(bool(c)); print(("OK    " if c else "FALHA ") + n + f"  [{r.get(n, '')[:200]}]")
check("abrir lote novo", len(r.get("abrir lote novo", "")) == 36)
check("lote de 7 h", r.get("lote de 7 h", "").startswith("ARQUIVADO | Arquivado automaticamente: envio iniciado em"))
check("lote de 1 h", r.get("lote de 1 h") == "VALIDATING")
check("reabrir lote em validação (1 h)", r.get("reabrir lote em validação (1 h)") == "true")
check("reabrir lote CONFIRMADO (Base 02 oficial)", "Este arquivo já foi importado e confirmado em" in r.get("reabrir lote CONFIRMADO (Base 02 oficial)", ""))
check("Base 02 oficial continua confirmada", r.get("Base 02 oficial continua confirmada") == "VALIDATED")
check("duração normal (sem aviso)", '"alerta": false' in r.get("duração normal (sem aviso)", ""))
check("duração lenta (com aviso)", '"alerta": true' in r.get("duração lenta (com aviso)", ""))
check("falha (com aviso)", '"alerta": true' in r.get("falha (com aviso)", ""))
check("vendedor registrando duração", r.get("vendedor registrando duração", "").startswith("ERRO:42501"))
check("vendedor lendo durações", r.get("vendedor lendo durações", "").startswith("ERRO:42501"))
check("Master lendo durações", r.get("Master lendo durações") == "3")
check("avisos na Auditoria", "IMPORTACAO_FALHOU" in r.get("avisos na Auditoria", "") and "IMPORTACAO_LENTA" in r.get("avisos na Auditoria", "") and r.get("avisos na Auditoria", "").count("||") == 1)
check("vendedor lendo a tabela direto", r.get("vendedor lendo a tabela direto", "").startswith("ERRO:42501"))
check("rollback remove tudo", r.get("rollback remove tudo") == "true")
print(f"\n{sum(ok)}/{len(ok)} verificações OK (transação desfeita: nada gravado)")

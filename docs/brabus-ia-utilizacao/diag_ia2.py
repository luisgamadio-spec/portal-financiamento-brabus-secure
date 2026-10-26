"""Diagnóstico 2 (só leitura): perfis existentes, snapshot da telemetria dos simuladores, intervalos entre ferramentas."""
import io, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
print("perfis no cadastro:", sql("select perfil, ativo, count(*) n from public.usuarios group by 1, 2 order by 1, 2"))
d = sql("select pg_get_functiondef('public.portal_telemetry_start_session'::regproc) d")[0]["d"].replace("\r", "")
i = d.find("insert into"); print("\nsnapshot da telemetria ::", " ".join(d[max(0, i - 1500):i + 700].split())[:2600])
print("\nintervalo entre ferramentas consecutivas na mesma sessão (segundos):")
print(sql("""with x as (select sessao_id, created_at, extract(epoch from created_at - lag(created_at) over (partition by auth_user_id, sessao_id order by created_at)) g from public.bi_audit_log)
  select width_bucket(g, array[0,5,10,15,20,30,45,60,90,120,300]) faixa, min(g)::int de, max(g)::int ate, count(*) n from x where g is not null group by 1 order by 1"""))
print("registros de consultar_manual com 'pergunta':", sql("select count(*) n, min(created_at)::text de, max(created_at)::text ate from public.bi_audit_log where parametros ? 'pergunta'"))
print("ferramentas com 'pergunta' nos parâmetros:", sql("select ferramenta, count(*) n from public.bi_audit_log where parametros ? 'pergunta' group by 1"))
print("chaves com texto livre possível (todas):", sql("select k, count(*) n from public.bi_audit_log, jsonb_object_keys(case when jsonb_typeof(parametros)='object' then parametros else '{}'::jsonb end) k where k in ('pergunta','texto','mensagem','titulo','descricao','consulta','termo') group by 1"))
print("auditoria (colunas):", [r["column_name"] for r in sql("select column_name from information_schema.columns where table_schema='public' and table_name='auditoria' order by ordinal_position")])

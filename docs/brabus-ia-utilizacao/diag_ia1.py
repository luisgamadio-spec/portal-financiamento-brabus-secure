"""Diagnóstico (só leitura, só agregados) do que existe hoje sobre o uso da Brabus IA."""
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
B = "(created_at at time zone 'America/Sao_Paulo')"
print("== bi_audit_log (1 linha por ferramenta usada)")
print(sql(f"select count(*) linhas, count(distinct auth_user_id) usuarios, count(distinct sessao_id) sessoes, min({B})::text primeira, max({B})::text ultima, count(distinct {B}::date) dias from public.bi_audit_log"))
print("por perfil gravado:", sql("select perfil, count(*) n, count(distinct auth_user_id) usuarios from public.bi_audit_log group by 1 order by 2 desc"))
print("por canal / status:", sql("select canal, status, count(*) n from public.bi_audit_log group by 1, 2 order by 3 desc"))
print("por mês:", sql(f"select to_char({B}, 'YYYY-MM') mes, count(*) n, count(distinct auth_user_id) usuarios, count(distinct sessao_id) sessoes from public.bi_audit_log group by 1 order by 1"))
print("ferramentas (top 30):")
for r in sql("select ferramenta, count(*) n, count(distinct auth_user_id) usuarios from public.bi_audit_log group by 1 order by 2 desc limit 30"): print("   ", r)
print("chaves usadas em parametros (só nomes):", sql("select k, count(*) n from public.bi_audit_log, jsonb_object_keys(case when jsonb_typeof(parametros) = 'object' then parametros else '{}'::jsonb end) k group by 1 order by 2 desc limit 40"))
print("usuários do log que existem no cadastro (por auth_user_id):", sql("select count(distinct l.auth_user_id) total, count(distinct l.auth_user_id) filter (where u.id is not null) no_cadastro from public.bi_audit_log l left join public.usuarios u on u.auth_user_id = l.auth_user_id"))
print("bi_simulacoes:", sql(f"select count(*) n, min({B})::text de, max({B})::text ate from public.bi_simulacoes"))
print("\n== telemetria dos simuladores (para comparar)")
for t in ("portal_module_sessions", "sessoes_portal"):
    print(t, [r["column_name"] for r in sql(f"select column_name from information_schema.columns where table_schema='public' and table_name='{t}' order by ordinal_position")])
print("módulos na telemetria:", sql("select module_id, count(*) n, min((started_at at time zone 'America/Sao_Paulo'))::text de from public.portal_module_sessions group by 1 order by 2 desc") if sql("select count(*) n from information_schema.columns where table_name='portal_module_sessions' and column_name in ('module_id','started_at')")[0]["n"] == 2 else "colunas diferentes")
print("funções de telemetria/uso:", [r["proname"] for r in sql("select proname from pg_proc where pronamespace='public'::regnamespace and (proname ilike '%telemetr%' or proname ilike '%usage%' or proname ilike 'bi\\_%' or proname ilike '%utiliza%') order by 1")])
print("BI_PERFIS (quem pode usar a IA) não está no banco — é segredo da função; configuração ia_texto_habilitada:", sql("select chave, valor from public.configuracoes where chave in ('ia_texto_habilitada','ia_voz_habilitada','telemetria_simuladores_ativa','telemetria_simuladores_started_at')"))

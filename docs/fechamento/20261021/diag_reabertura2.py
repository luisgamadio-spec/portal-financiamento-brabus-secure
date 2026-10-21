"""Quem importou/reabriu/fechou de novo e por qual caminho (só leitura; só horários, perfis e contagens)."""
import io, os, sys, json
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
V1 = "56c80a93-9558-4230-9ca0-d6f01e13fae3"
bc = [r["column_name"] for r in sql("select column_name from information_schema.columns where table_schema='public' and table_name='portal_import_batches' order by ordinal_position")]
quem = [c for c in bc if any(k in c for k in ("by", "por", "user", "usuario", "actor"))]
print("colunas de autoria nos lotes:", quem)
if quem:
    sel = ", ".join(f"{c}::text {c}" for c in quem)
    for r in sql(f"select source_type, (created_at at time zone 'America/Sao_Paulo')::text criado, {sel} from public.portal_import_batches where created_at between '2026-10-21 17:55+00' and '2026-10-21 18:05+00' order by created_at"):
        ids = {c: r[c] for c in quem}
        perfis = {c: (sql(f"select perfil, nome = 'LUIS GUSTAVO DE MELO AMADIO' eh_luis from public.usuarios where id::text = '{v}' or auth_user_id::text = '{v}'") if v and len(v) == 36 else v) for c, v in ids.items()}
        print("  ", r["source_type"], r["criado"], perfis)
print("durações registradas (tela nova da Gestão de Bases):", sql("select count(*) n, min((criado_em at time zone 'America/Sao_Paulo')::text) de, max((criado_em at time zone 'America/Sao_Paulo')::text) ate from public.portal_import_duracoes where criado_em between '2026-10-21 17:55+00' and '2026-10-21 18:05+00'") if sql("select to_regclass('public.portal_import_duracoes') is not null e")[0]["e"] else "-")
for t in ("logs_acesso", "sessoes_portal"):
    cs = [r["column_name"] for r in sql(f"select column_name from information_schema.columns where table_schema='public' and table_name='{t}' order by ordinal_position")]
    print(f"\n{t} colunas:", cs)
tc = next((c for c in ("criado_em", "created_at", "data_hora", "iniciado_em", "inicio") if c in [r["column_name"] for r in sql("select column_name from information_schema.columns where table_schema='public' and table_name='sessoes_portal'")]), None)
uc = next((c for c in ("usuario_id", "user_id") if c in [r["column_name"] for r in sql("select column_name from information_schema.columns where table_schema='public' and table_name='sessoes_portal'")]), None)
if tc and uc:
    print("sessões da conta Master do Luis entre 14:30 e 16:30 (Brasília):", sql(f"""select count(*) n, min(({tc} at time zone 'America/Sao_Paulo')::text) primeira, max(({tc} at time zone 'America/Sao_Paulo')::text) ultima
      from public.sessoes_portal s join public.usuarios u on u.id = s.{uc} where u.nome = 'LUIS GUSTAVO DE MELO AMADIO' and s.{tc} between '2026-10-21 17:30+00' and '2026-10-21 19:30+00'"""))
print("último login da conta (Brasília):", sql("select (ultimo_login at time zone 'America/Sao_Paulo')::text u from public.usuarios where nome = 'LUIS GUSTAVO DE MELO AMADIO' and upper(perfil) = 'MASTER'"))
print("\nv1 intacto? linhas e soma da comissão do snapshot v1:", sql(f"select count(*) n, sum(comissao) soma, count(cpf) cpf, max(criado_em)::text ultima_gravacao from public.snapshot_comissoes where fechamento_id = '{V1}'"))

"""Correção do corte estimado/real em master_ia_usage_data (26/10/2026): o período estimado termina no INÍCIO da 1ª pergunta
registrada (fim − duração), não no fim — senão as ferramentas da própria 1ª pergunta (auditadas segundos antes do registro)
entram também como "estimada". Gera ia_fix_corte.sql, ia_fix_corte_rollback.sql (texto exato de hoje) e o backup. Só lê o banco."""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
r = sql("select pg_get_functiondef('public.master_ia_usage_data(date,date)'::regprocedure) d, (select proacl::text from pg_proc where oid = 'public.master_ia_usage_data(date,date)'::regprocedure) acl")[0]
bruto = r["d"].rstrip()
json.dump({"capturado_em": "2026-10-26", "funcao": bruto, "acl": r["acl"]}, open(os.path.join(AQUI, "ia_fix_corte_backup.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
velho = "  select min(created_at) into v_inicio from public.bi_uso_perguntas;"
novo = ("  -- 26/10/2026: o período estimado termina no INÍCIO da 1ª pergunta registrada (fim − duração); as ferramentas\n"
        "  -- dessa pergunta são auditadas segundos antes do registro e não podem contar de novo como \"estimada\".\n"
        "  select min(created_at - coalesce(duracao_ms, 0) * interval '1 millisecond') into v_inicio from public.bi_uso_perguntas;")
t = bruto.replace("\r\n", "\n"); assert t.count(velho) == 1
open(os.path.join(AQUI, "ia_fix_corte.sql"), "w", encoding="utf-8", newline="\n").write(
    "-- Correção do corte estimado/real da utilização da Brabus IA (26/10/2026)\nbegin;\n\n" + t.replace(velho, novo) + ";\n\ncommit;\n")
open(os.path.join(AQUI, "ia_fix_corte_rollback.sql"), "w", encoding="utf-8", newline="").write(
    "-- DESFAZER a correção do corte (volta o texto exato de antes)\nbegin;\n\n" + bruto + ";\n\ncommit;\n")
print("ok | acl:", r["acl"], "| CRLF no original:", "\r\n" in bruto)

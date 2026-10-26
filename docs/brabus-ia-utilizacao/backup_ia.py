"""Backup do estado ANTES da utilização da Brabus IA (só leitura). NÃO guarda o texto das perguntas: só ids e md5.
Saída: ia_backup_antes.json.  Uso: python -I backup_ia.py"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, AQUI)
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sqlexato import sql
NOVOS = ["master_ia_usage_data", "bi_registrar_pergunta", "bi_acesso_liberado", "_bi_tema_ferramenta", "_bi_perfis_liberados", "_bi_perfil_normalizado"]
b = {
    "capturado_em": "2026-10-26",
    "objetos_novos_ja_existem": sql("select proname from pg_proc where pronamespace='public'::regnamespace and proname in (" + ",".join(f"'{n}'" for n in NOVOS) + ")")
                               + sql("select relname proname from pg_class where relnamespace='public'::regnamespace and relname = 'bi_uso_perguntas'"),
    "config_ia_perfis_liberados": sql("select valor from public.configuracoes where chave = 'ia_perfis_liberados'"),
    "auditoria_ia_textos": sql("select id, created_at::text, md5(parametros::text) md5_parametros, (select array_agg(k order by k) from jsonb_object_keys(parametros) k) chaves from public.bi_audit_log where ferramenta = 'consultar_manual' and parametros ? 'pergunta' order by id"),
    "bi_audit_log_resto_md5": sql("select count(*) n, md5(string_agg(id::text || md5(coalesce(parametros::text, '')) || ferramenta || status, '|' order by id)) h from public.bi_audit_log where not (ferramenta = 'consultar_manual' and parametros ? 'pergunta')")[0],
    "auditoria_BI_TEXTO_REMOVIDO": sql("select count(*) n from public.auditoria where tipo = 'BI_TEXTO_REMOVIDO'")[0]["n"],
    "gatilhos_bi_audit_log": sql("select tgname from pg_trigger where tgrelid = 'public.bi_audit_log'::regclass and not tgisinternal"),
}
assert not b["objetos_novos_ja_existem"] and not b["config_ia_perfis_liberados"], b
json.dump(b, open(os.path.join(AQUI, "ia_backup_antes.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps({k: v for k, v in b.items() if k != "auditoria_ia_textos"}, ensure_ascii=False), "| registros com texto:", [(r["id"], r["chaves"]) for r in b["auditoria_ia_textos"]])

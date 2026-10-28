"""Gera a migração da Fase 2 das Avaliações (vistoria), o backup e o desfazer.
A Fase 2 só CRIA objetos (novos_f2.sql); nenhum objeto existente é alterado.
Trava: a migração não aplica nada se
  - alguma função de que a Fase 2 depende mudou desde a conferência (md5 de pg_get_functiondef) — inclusive
    por outra sessão mexendo no banco (ex.: correção da loja NACOES UNIDAS);
  - algum objeto da Fase 2 já existir (tabelas, funções ou o bucket).
O backup registra essas impressões digitais (não há definição antiga para guardar: tudo é novo)."""
import os
AQUI = os.path.dirname(os.path.abspath(__file__))

# conferidas no banco em 28/10/2026 (consulta só de leitura, aval_f2/estado.sql)
DEPENDE = {
    "public._aval_contexto()": "6b54a9b8e39f28a7b6f0ac9be2f1b478",
    "public._aval_carregar(uuid,jsonb)": "54419227f050155e385c8ecb30433793",
    "public.portal_modulos_permitidos()": "59abb8b9f5298478c8fb7334edd66c78",
    "public.aval_contexto()": "bda1697da36d46cf36827a09e23e943c",
    "public.aval_obter(uuid)": "06b5f8340c634bc6f5105d8fc64fa19b",
    "public.aval_salvar_identificacao(uuid,jsonb)": "2dc807a3a969f5f065004b5b2b792e18",
}
TABELAS = ["aval_tabela_reparos", "aval_vistorias", "aval_avarias", "aval_fotos"]
FUNCOES = ["_aval_peca_info(text)", "_aval_tipos_avaria(text)", "_aval_checklist_opcoes()", "_aval_tabela_vigente()",
           "_aval_pode_editar(public.aval_avaliacoes, jsonb)", "_aval_vistoria_json(public.aval_avaliacoes, jsonb)",
           "aval_vistoria_obter(uuid)", "aval_vistoria_salvar(uuid, jsonb)", "aval_vistoria_concluir(uuid)",
           "aval_foto_preparar(uuid, uuid, uuid, integer)", "aval_foto_registrar(uuid, integer)", "aval_fotos_listar(uuid)",
           "aval_foto_remover(uuid)", "aval_reparos_listar()", "aval_master_salvar_reparos(jsonb, text)"]
NOMES_F = sorted({f.split("(")[0] for f in FUNCOES})

trava = ["do $trava$\nbegin"]
for f, m in DEPENDE.items():
    trava.append(f"  if md5(pg_get_functiondef('{f}'::regprocedure)) <> '{m}' then\n"
                 f"    raise exception 'TRAVA: {f} mudou desde a conferência -- conferir a mudança e regenerar a migração';\n  end if;")
trava.append("  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname in ("
             + ", ".join(f"'{t}'" for t in TABELAS) + "))\n"
             "     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ("
             + ", ".join(f"'{n}'" for n in NOMES_F) + "))\n"
             "     or exists (select 1 from storage.buckets where id = 'avaliacoes-fotos') then\n"
             "    raise exception 'TRAVA: objetos da Fase 2 já existem';\n  end if;")
trava.append("end $trava$;")

novos = open(os.path.join(AQUI, "novos_f2.sql"), encoding="utf-8").read()
migracao = ("-- Avaliações de Seminovos — Fase 2: vistoria (28/10/2026)\n"
            "-- Só objetos NOVOS (novos_f2.sql). Nenhuma função ou tabela existente muda.\n"
            "-- Backup: avaliacoes_fase2_backup_antes.sql | Desfazer: avaliacoes_fase2_desfazer.sql\n"
            "begin;\n\n" + "\n".join(trava) + "\n\n" + novos.rstrip() + "\n\ncommit;\n")

backup = ("-- Backup da Fase 2 das Avaliações (28/10/2026).\n"
          "-- A Fase 2 não altera nenhum objeto existente: não há definição antiga a guardar.\n"
          "-- Impressões digitais (md5 de pg_get_functiondef) das funções de que ela depende, conferidas antes de aplicar:\n"
          + "".join(f"--   {f}  {m}\n" for f, m in DEPENDE.items())
          + "-- Objetos que a Fase 2 cria (e o desfazer remove):\n"
          + "".join(f"--   tabela public.{t}\n" for t in TABELAS)
          + "".join(f"--   função public.{f}\n" for f in FUNCOES)
          + "--   bucket privado storage.buckets 'avaliacoes-fotos'\n")

desfazer = ("-- Desfaz a Fase 2 das Avaliações: remove as funções, as tabelas e o bucket da vistoria.\n"
            "-- ATENÇÃO: apaga avarias, checklist, registros de fotos e a tabela de reparos (exportar antes, se houver uso real).\n"
            "-- Trava: o bucket precisa estar vazio (o Supabase não deixa apagar arquivos por SQL; esvaziar pelo painel do Storage).\n"
            "-- Não mexe em nada da Fase 1.\n"
            "begin;\n\n"
            "do $t$ begin\n  if exists (select 1 from storage.objects where bucket_id = 'avaliacoes-fotos') then\n"
            "    raise exception 'TRAVA: o bucket avaliacoes-fotos tem arquivos -- esvaziar pelo painel do Storage antes de desfazer';\n"
            "  end if;\nend $t$;\n\n"
            "drop function if exists " + ",\n  ".join(f"public.{f}" for f in FUNCOES) + ";\n"
            "drop table if exists public.aval_fotos, public.aval_avarias, public.aval_vistorias, public.aval_tabela_reparos;\n"
            "delete from storage.buckets where id = 'avaliacoes-fotos';\n"
            "delete from public.aval_eventos where tipo in ('VISTORIA_INICIADA', 'VISTORIA_REABERTA', 'VISTORIA_CONCLUIDA');\n\n"
            "commit;\n")

for nome, txt in [("20261028150000_avaliacoes_fase2_vistoria.sql", migracao), ("avaliacoes_fase2_backup_antes.sql", backup),
                  ("avaliacoes_fase2_desfazer.sql", desfazer)]:
    open(os.path.join(AQUI, nome), "w", encoding="utf-8", newline="\n").write(txt)
    print(nome, len(txt))

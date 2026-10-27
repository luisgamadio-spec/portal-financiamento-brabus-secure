"""Gera a migração da Fase 1 das Avaliações, o backup e o desfazer.
Objetos EXISTENTES que mudam (só para aceitar o perfil AVALIADOR), a partir da definição atual de produção
(aval_defs/*.sql, lida com pg_get_functiondef); cada troca é de texto exato e conferida 1 vez:
  usuarios_perfil_check, master_convidar_usuario, master_atualizar_autorizacao_usuario,
  master_provisionar_usuario, portal_modulos_permitidos.
A migração tem trava: se alguma dessas 4 funções mudou desde o backup (md5), nada é aplicado."""
import hashlib, os
AQUI = os.path.dirname(os.path.abspath(__file__))
DEFS = os.path.join(AQUI, "aval_defs")
SAIDA = os.path.join(AQUI, "saida")
os.makedirs(SAIDA, exist_ok=True)

def ler(n):
    return open(os.path.join(DEFS, n + ".sql"), encoding="utf-8").read()

def troca(txt, a, b):
    assert txt.count(a) == 1, (a[:80], txt.count(a))
    return txt.replace(a, b)

CONSTRAINT_ANTES = ("CHECK ((perfil = ANY (ARRAY['VENDEDOR'::text, 'GERENTE'::text, 'ANALISTA'::text, 'MASTER'::text, "
                    "'DIRETOR NOVOS'::text, 'DIRETOR SEMINOVOS'::text, 'RECURSOS HUMANOS'::text, 'RH'::text])))")
CONSTRAINT_DEPOIS = ("CHECK ((perfil = ANY (ARRAY['VENDEDOR'::text, 'GERENTE'::text, 'ANALISTA'::text, 'MASTER'::text, "
                     "'DIRETOR NOVOS'::text, 'DIRETOR SEMINOVOS'::text, 'RECURSOS HUMANOS'::text, 'RH'::text, 'AVALIADOR'::text])))")

antes = {n: ler(n) for n in ["master_convidar_usuario", "master_atualizar_autorizacao_usuario",
                             "master_provisionar_usuario", "portal_modulos_permitidos"]}
depois = {}
depois["master_convidar_usuario"] = troca(troca(antes["master_convidar_usuario"],
    "v_perfis_validos constant text[] := array['MASTER','DIRETOR NOVOS','DIRETOR SEMINOVOS','ANALISTA','GERENTE','VENDEDOR','RECURSOS HUMANOS','RH'];",
    "v_perfis_validos constant text[] := array['MASTER','DIRETOR NOVOS','DIRETOR SEMINOVOS','ANALISTA','GERENTE','VENDEDOR','RECURSOS HUMANOS','RH','AVALIADOR'];"),
    "  elsif v_perfil = 'MASTER' then\n    v_status := 'MASTER';",
    "  elsif v_perfil = 'AVALIADOR' then\n"
    "    -- Avaliações de Seminovos (27/10/2026): avaliador é sempre de uma loja e do departamento Seminovos\n"
    "    if v_loja is null then\n"
    "      raise exception 'Selecione a loja do avaliador.' using errcode = '22023';\n"
    "    end if;\n"
    "    v_status := 'SEMINOVOS';\n"
    "  elsif v_perfil = 'MASTER' then\n    v_status := 'MASTER';")
for n in ["master_atualizar_autorizacao_usuario", "master_provisionar_usuario"]:
    depois[n] = troca(antes[n], "'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH'\n  ) then",
                      "'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH', 'AVALIADOR'\n  ) then")
depois["portal_modulos_permitidos"] = troca(antes["portal_modulos_permitidos"],
    "  else\n    -- Perfil desconhecido/não mapeado: default deny.",
    "  elsif v_profile = 'AVALIADOR' then\n"
    "    -- Avaliações de Seminovos (27/10/2026): matriz AVALIADOR/SEMINOVOS\n"
    "    v_departments := array['SEMINOVOS'];\n"
    "  else\n    -- Perfil desconhecido/não mapeado: default deny.")

def md5(t): return hashlib.md5(t.encode("utf-8")).hexdigest()

trava = ["do $trava$\nbegin"]
for n, t in antes.items():
    trava.append(f"  if (select md5(pg_get_functiondef('public.{n}'::regproc)) ) <> '{md5(t)}' then\n"
                 f"    raise exception 'TRAVA: public.{n} mudou desde o backup -- regenerar a migração';\n  end if;")
trava.append("  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'usuarios_perfil_check' "
             "and conrelid = 'public.usuarios'::regclass) <> $c$" + CONSTRAINT_ANTES + "$c$ then\n"
             "    raise exception 'TRAVA: usuarios_perfil_check mudou desde o backup';\n  end if;")
trava.append("  if exists (select 1 from pg_class where relname in ('aval_avaliacoes','aval_regras_margem','aval_consultas_veiculo','aval_eventos','fipe_precos') "
             "and relnamespace = 'public'::regnamespace) or exists (select 1 from public.modulos_portal where id = 'avaliacoes') then\n"
             "    raise exception 'TRAVA: objetos das Avaliações já existem';\n  end if;")
trava.append("end $trava$;")

def bloco_funcoes(d):
    return "\n\n".join(t.rstrip() + ";" for t in d.values())

novos = open(os.path.join(AQUI, "novos.sql"), encoding="utf-8").read()

cab = ("-- Avaliações de Seminovos — Fase 1 (27/10/2026)\n"
       "-- 1) perfil AVALIADOR: constraint + 4 funções existentes (só a lista de perfis / o mapeamento do perfil)\n"
       "-- 2) objetos novos do módulo (novos.sql)\n"
       "-- Backup: avaliacoes_fase1_backup_antes.sql | Desfazer: avaliacoes_fase1_desfazer.sql\n")
migracao = (cab + "begin;\n\n" + "\n".join(trava) + "\n\n"
            "alter table public.usuarios drop constraint usuarios_perfil_check;\n"
            "alter table public.usuarios add constraint usuarios_perfil_check " + CONSTRAINT_DEPOIS + ";\n\n"
            + bloco_funcoes(depois) + "\n\n" + novos + "\n\ncommit;\n")

backup = ("-- Backup (27/10/2026) dos objetos existentes alterados pela Fase 1 das Avaliações, como estão em produção.\n"
          "-- usuarios_perfil_check: " + CONSTRAINT_ANTES + "\n\n" + bloco_funcoes(antes) + "\n")

desfazer = ("-- Desfaz a Fase 1 das Avaliações: remove os objetos novos e devolve as 4 funções e a constraint ao backup.\n"
            "-- Trava: não roda se já existir usuário com perfil AVALIADOR (a constraint antiga o recusaria) --\n"
            "-- nesse caso, primeiro trocar o perfil dessas pessoas no Painel Master.\n"
            "-- ATENÇÃO: apaga as avaliações e consultas gravadas (exportar antes, se houver uso real).\n"
            "begin;\n\n"
            "do $t$ begin\n  if exists (select 1 from public.usuarios where upper(perfil) = 'AVALIADOR') then\n"
            "    raise exception 'TRAVA: há usuários com perfil AVALIADOR -- trocar o perfil antes de desfazer';\n  end if;\nend $t$;\n\n"
            "drop function if exists public.aval_contexto(), public.aval_listar(text, integer), public.aval_obter(uuid),\n"
            "  public.aval_salvar_identificacao(uuid, jsonb), public.aval_descartar(uuid, text), public.aval_referencias(uuid, text),\n"
            "  public.aval_consulta_preparar(text, text), public.aval_consulta_registrar(uuid, text, text, text, text, boolean, jsonb, numeric),\n"
            "  public.aval_regras_listar(), public.aval_master_salvar_regra(jsonb, text), public.aval_previa_calculo(numeric, numeric, numeric, jsonb),\n"
            "  public._aval_carregar(uuid, jsonb), public._aval_regra_vigente(), public._aval_calcular(jsonb, numeric, numeric, numeric),\n"
            "  public._aval_contexto(), public._aval_normaliza_placa(text), public._aval_normaliza_chassi(text);\n"
            "drop table if exists public.aval_eventos, public.aval_avaliacoes, public.aval_consultas_veiculo, public.aval_regras_margem, public.fipe_precos;\n"
            "delete from public.permissoes_modulos where modulo_id = 'avaliacoes';\n"
            "delete from public.modulos_portal where id = 'avaliacoes';\n\n"
            + bloco_funcoes(antes) + "\n\n"
            "alter table public.usuarios drop constraint usuarios_perfil_check;\n"
            "alter table public.usuarios add constraint usuarios_perfil_check " + CONSTRAINT_ANTES + ";\n\n"
            "commit;\n")

for nome, txt in [("20261027190000_avaliacoes_fase1.sql", migracao), ("avaliacoes_fase1_backup_antes.sql", backup),
                  ("avaliacoes_fase1_desfazer.sql", desfazer)]:
    open(os.path.join(SAIDA, nome), "w", encoding="utf-8", newline="\n").write(txt)
    print(nome, len(txt))
print({n: md5(t) for n, t in antes.items()})

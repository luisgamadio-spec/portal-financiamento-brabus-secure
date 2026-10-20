"""Gera a mudança de segurança de 20/10/2026 (itens 1, 3 e 4), o backup e o desfazer, a partir do que está em produção agora.
Só lê o banco. Saídas nesta pasta: seg5.sql, seg5_rollback.sql, backup_antes.json.  Uso: python -I gera_seg5.py"""
import io, json, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from sq import q

TABELAS = ["configuracoes", "periodos_comissao", "ausencias_analistas", "mudancas_loja_vendedores", "analistas_fi"]
LISTA = ", ".join("'" + t + "'" for t in TABELAS)
FUNCS = ["chamar_analista_fi", "operational_commission_periods"]

pol = q(f"select tablename, policyname, permissive, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='public' and tablename in ({LISTA}) order by 1, 2")
bruto = {r["proname"]: r["d"].rstrip() for r in q("select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('chamar_analista_fi','operational_commission_periods')")}
acl_f = q("select p.proname, p.proacl::text acl from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('chamar_analista_fi','operational_commission_periods')")
acl_t = q(f"select c.relname, c.relacl::text acl, c.relrowsecurity rls from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ({LISTA}) order by 1")
existe = q("select to_regclass('public.chamar_analista_fi_controle') is not null e")[0]["e"]
assert len(pol) == 13, len(pol)
assert set(bruto) == set(FUNCS)
fns = {k: v.replace("\r\n", "\n") for k, v in bruto.items()}  # versão nova parte do texto com LF; o desfazer usa o texto EXATO (bruto, com CRLF)
assert not existe, "tabela de controle já existe"
json.dump({"capturado_em": "2026-10-20", "politicas": pol, "funcoes": bruto, "acl_funcoes": acl_f, "acl_tabelas": acl_t},
          open(os.path.join(AQUI, "backup_antes.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

drop = "\n".join(f'drop policy if exists "{p["policyname"]}" on public.{p["tablename"]};' for p in pol)

def recria(p):
    roles = p["roles"].strip("{}").split(",")
    s = f'create policy "{p["policyname"]}" on public.{p["tablename"]} as {p["permissive"].lower()} for {p["cmd"].lower()} to {", ".join(roles)}'
    if p["qual"] is not None: s += f' using ({p["qual"]})'
    if p["with_check"] is not None: s += f' with check ({p["with_check"]})'
    return s + ";"

periodos_novo = fns["operational_commission_periods"].replace("jsonb_agg(to_jsonb(p) order by p.data_inicio desc)",
                                                             "jsonb_agg(to_jsonb(p) - 'criado_por' order by p.data_inicio desc)")
assert periodos_novo != fns["operational_commission_periods"]

antigo = fns["chamar_analista_fi"]
CORPO_INI = """declare
  v_analista public.analistas_fi%rowtype;
begin
"""
assert CORPO_INI in antigo
chamar_novo = antigo.replace(CORPO_INI, """declare
  v_analista public.analistas_fi%rowtype;
  v_usuario_id uuid;
  v_liberado boolean;
begin
  -- 20/10/2026: só quem pode abrir um Simulador chama analista (mesma regra do menu do portal:
  -- portal_modulos_permitidos, que já cobre Master e a matriz de permissões por perfil/departamento).
  if not (coalesce(public.portal_modulos_permitidos(), '[]'::jsonb) ?| array['simuladorCompleto', 'simuladorSeminovos']) then
    raise exception 'Seu perfil não tem acesso ao atendimento do Simulador.'
      using errcode = '42501', hint = 'PERFIL_SEM_SIMULADOR';
  end if;

  select u.id into v_usuario_id
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;

""", 1)
ANTES_INSERT = """  if not found then
    return;
  end if;
"""
assert antigo.count(ANTES_INSERT) == 1
chamar_novo = chamar_novo.replace(ANTES_INSERT, ANTES_INSERT + """
  -- 20/10/2026: intervalo mínimo de 1 minuto entre chamadas atendidas do mesmo usuário.
  -- Só conta quando um analista foi entregue (sem analista disponível, pode tentar de novo na hora).
  -- O INSERT ... ON CONFLICT trava a linha do usuário: dois cliques simultâneos não passam juntos.
  insert into public.chamar_analista_fi_controle as c (usuario_id, ultima_chamada)
  values (v_usuario_id, now())
  on conflict (usuario_id) do update set ultima_chamada = excluded.ultima_chamada
    where c.ultima_chamada <= now() - interval '1 minute'
  returning true into v_liberado;

  if v_liberado is null then
    raise exception 'Aguarde um instante para chamar de novo.'
      using errcode = 'P0001', hint = 'AGUARDE_CHAMAR_ANALISTA';
  end if;
""", 1)

SQL = f"""-- Segurança das tabelas internas e do "Falar com um Analista" — 20/10/2026 (aprovado pelo Luis: itens 1, 3 e 4)
-- 1) Remove as 13 regras de RLS sem efeito (as 5 tabelas não têm permissão para anon/authenticated; se a permissão
--    voltasse por engano, a regra "qualquer logado lê tudo" passaria a valer). RLS continua LIGADA, sem regra = ninguém
--    além do dono (postgres, usado pelas funções do portal) e da service_role.
-- 3) operational_commission_periods deixa de devolver criado_por (CPF de quem criou o período).
-- 4) chamar_analista_fi: só perfis com acesso ao Simulador + 1 minuto entre chamadas do mesmo usuário.
begin;

{drop}
revoke all on table {", ".join("public." + t for t in TABELAS)} from anon, authenticated;

{periodos_novo};

create table public.chamar_analista_fi_controle (
  usuario_id uuid primary key references public.usuarios(id) on delete cascade,
  ultima_chamada timestamptz not null
);
comment on table public.chamar_analista_fi_controle is 'Última chamada atendida de "Falar com um Analista" por usuário (intervalo mínimo de 1 minuto). Só a função chamar_analista_fi grava.';
alter table public.chamar_analista_fi_controle enable row level security;
revoke all on table public.chamar_analista_fi_controle from anon, authenticated;

{chamar_novo};

commit;
"""
ROLLBACK = f"""-- DESFAZER a mudança de segurança de 20/10/2026 (volta exatamente ao estado capturado em backup_antes.json)
begin;

{chr(10).join(recria(p) for p in pol)}

{bruto["operational_commission_periods"]};

{bruto["chamar_analista_fi"]};

drop table if exists public.chamar_analista_fi_controle;

commit;
"""
open(os.path.join(AQUI, "seg5.sql"), "w", encoding="utf-8", newline="\n").write(SQL)
open(os.path.join(AQUI, "seg5_rollback.sql"), "w", encoding="utf-8", newline="").write(ROLLBACK)
print("ok:", len(pol), "regras;", len(SQL), "bytes de SQL;", len(ROLLBACK), "bytes de rollback")

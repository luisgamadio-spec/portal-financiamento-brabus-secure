"""Gera a migração da FASE 1 a partir das definições PUBLICADAS agora (nada é aplicado aqui):
  1) usuarios.login_nbs_normalizado = portal_normaliza_nbs(login_nbs) (coluna gerada pelo banco) + índice (ativos);
  2) importações (Base 01/02) e encerramento de pendências usam a coluna em vez de normalizar todos os usuários a cada linha;
  3) herança do vendedor limitada aos chassis da própria parte (+ índice por chassi/serviço na Base 02).
Saída: fase1.sql e fase1_rollback.sql (definições atuais, para desfazer)."""
import os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
from rpc import sql
FNS = ["master_operational_import_finance", "master_operational_import_sales", "portal_fechar_alertas_cadastro_resolvidos"]
atual = {f: sql(f"select pg_get_functiondef('public.{f}'::regproc) d")[0]["d"] for f in FNS}

def troca(txt, a, b, n):
    c = txt.count(a); assert c == n, (a[:70], c, n); return txt.replace(a, b)

novo = {}
t = atual["master_operational_import_finance"]
t = troca(t, "where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true", "where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true", 2)
t = troca(t, "and coalesce(public.portal_normaliza_nbs(u.login_nbs), '') <> f.nbs_norm", "and coalesce(u.login_nbs_normalizado, '') <> f.nbs_norm", 1)
t = troca(t, """      and f.seller_user_id is not null
      and f.chassis is not null
    order by f.chassis, f.service_description, b.completed_at desc nulls last, b.created_at desc, f.id desc""",
"""      and f.seller_user_id is not null
      and f.chassis is not null
      -- Fase 1 (19/10/2026): só os chassis desta parte — o resultado do join abaixo é o mesmo, sem ler o histórico inteiro.
      and f.chassis in (select upper(regexp_replace(p.chassis, '[^A-Za-z0-9]', '', 'g')) from prepared p where trim(coalesce(p.chassis, '')) <> '')
    order by f.chassis, f.service_description, b.completed_at desc nulls last, b.created_at desc, f.id desc""", 1)
novo["master_operational_import_finance"] = t

t = atual["master_operational_import_sales"]
t = troca(t, "where public.portal_normaliza_nbs(u.login_nbs) = p.nbs_norm and u.ativo = true", "where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true", 2)
t = troca(t, """      and s.seller_user_id is not null
    order by s.chassis, b.completed_at desc nulls last, b.created_at desc, s.id desc""",
"""      and s.seller_user_id is not null
      -- Fase 1 (19/10/2026): só os chassis desta parte — o resultado do join abaixo é o mesmo, sem ler o histórico inteiro.
      and s.chassis in (select upper(regexp_replace(p.chassis, '[^A-Za-z0-9]', '', 'g')) from prepared p)
    order by s.chassis, b.completed_at desc nulls last, b.created_at desc, s.id desc""", 1)
novo["master_operational_import_sales"] = t

t = atual["portal_fechar_alertas_cadastro_resolvidos"]
t = troca(t, "public.portal_normaliza_nbs(u.login_nbs)", "u.login_nbs_normalizado", 2)
novo["portal_fechar_alertas_cadastro_resolvidos"] = t

cabeca = """-- FASE 1 da importação de bases (19/10/2026): Login NBS normalizado guardado no cadastro + herança do vendedor por parte.
-- Regras de negócio inalteradas: mesma classificação, mesma herança (só os chassis que a parte usa), mesmos alertas.
-- Desfazer: fase1_rollback.sql.

-- 1) Login NBS já normalizado, calculado pelo próprio banco com a MESMA função (nunca fica desatualizado).
alter table public.usuarios
  add column if not exists login_nbs_normalizado text generated always as (public.portal_normaliza_nbs(login_nbs)) stored;
create index if not exists idx_usuarios_login_nbs_normalizado_ativo
  on public.usuarios (login_nbs_normalizado) where ativo and login_nbs_normalizado is not null;

-- 2) Herança do vendedor da Base 02 por (chassi, serviço): índice para buscar só os chassis da parte.
create index if not exists idx_finance_ops_heranca_chassi_servico
  on public.portal_finance_operations (chassis, service_description) where seller_user_id is not null and chassis is not null;

"""
corpo = "\n\n".join(novo[f].rstrip() + ";" for f in FNS)
open(os.path.join(AQUI, "fase1.sql"), "w", encoding="utf-8", newline="\n").write(cabeca + corpo + "\n")
rb = "-- Desfaz a FASE 1: volta as 3 funções às definições de 19/10/2026 (antes da Fase 1) e remove índices e coluna.\n\n" + \
     "\n\n".join(atual[f].rstrip() + ";" for f in FNS) + """

drop index if exists public.idx_finance_ops_heranca_chassi_servico;
drop index if exists public.idx_usuarios_login_nbs_normalizado_ativo;
alter table public.usuarios drop column if exists login_nbs_normalizado;
"""
open(os.path.join(AQUI, "fase1_rollback.sql"), "w", encoding="utf-8", newline="\n").write(rb)
print("ok: fase1.sql e fase1_rollback.sql")

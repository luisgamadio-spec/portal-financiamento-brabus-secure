-- Brabus Intelligence — fundação (construída do zero, sem objetos da IA antiga).
-- Cria só duas tabelas próprias. Todos os dados de negócio continuam vindo das
-- RPCs operational_* e simulador_* existentes, chamadas com o JWT do usuário.
-- Seguro para rodar mais de uma vez.

-- 1) Simulações feitas pela IA (para reaproveitar por simulacao_id) --------------
create table if not exists public.bi_simulacoes (
  id           uuid primary key,
  auth_user_id uuid not null default auth.uid(),
  sessao_id    text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '4 hours'
);
create index if not exists bi_simulacoes_user_idx on public.bi_simulacoes (auth_user_id, created_at desc);

alter table public.bi_simulacoes enable row level security;

drop policy if exists bi_simulacoes_insert_own on public.bi_simulacoes;
create policy bi_simulacoes_insert_own on public.bi_simulacoes
  for insert to authenticated
  with check (auth_user_id = auth.uid());

-- Cada usuário só enxerga as próprias simulações (id de outro usuário = "não encontrada").
drop policy if exists bi_simulacoes_select_own on public.bi_simulacoes;
create policy bi_simulacoes_select_own on public.bi_simulacoes
  for select to authenticated
  using (auth_user_id = auth.uid());

revoke all on public.bi_simulacoes from anon;
grant select, insert on public.bi_simulacoes to authenticated;

-- O usuário não escolhe datas: created_at/expires_at são sempre do servidor.
create or replace function public.bi_simulacoes_datas_servidor()
returns trigger language plpgsql as $$
begin
  new.created_at := now();
  new.expires_at := now() + interval '4 hours';
  new.auth_user_id := auth.uid();
  return new;
end $$;
drop trigger if exists bi_simulacoes_datas_servidor on public.bi_simulacoes;
create trigger bi_simulacoes_datas_servidor before insert on public.bi_simulacoes
  for each row execute function public.bi_simulacoes_datas_servidor();

-- 2) Log de auditoria (LGPD): quem consultou o quê. Sem valores de salário/cliente. ---
create table if not exists public.bi_audit_log (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  auth_user_id uuid not null default auth.uid(),
  sessao_id    text not null,
  perfil       text not null,
  canal        text not null,
  ferramenta   text not null,
  parametros   jsonb,
  status       text not null check (status in ('ok', 'erro', 'negado')),
  detalhe      text
);
create index if not exists bi_audit_log_created_idx on public.bi_audit_log (created_at desc);

alter table public.bi_audit_log enable row level security;

-- Ninguém escreve nem lê direto da tabela (sem policies + sem grants).
-- A gravação passa por bi_auditar(), que pega usuário e perfil do servidor.
drop policy if exists bi_audit_log_insert_own on public.bi_audit_log;
revoke all on public.bi_audit_log from anon, authenticated;

create or replace function public.bi_auditar(
  p_sessao text, p_canal text, p_ferramenta text, p_parametros jsonb, p_status text, p_detalhe text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_scope jsonb;
begin
  if auth.uid() is null then raise exception 'Sem sessão.' using errcode = '42501'; end if;
  v_scope := public.operational_current_scope();
  insert into public.bi_audit_log (auth_user_id, sessao_id, perfil, canal, ferramenta, parametros, status, detalhe)
  values (auth.uid(), left(coalesce(p_sessao, ''), 80), coalesce(v_scope->>'profile', '?'), left(coalesce(p_canal, ''), 20),
          left(coalesce(p_ferramenta, ''), 60), p_parametros, p_status, left(p_detalhe, 500));
end $$;
revoke all on function public.bi_auditar(text, text, text, jsonb, text, text) from public, anon;
grant execute on function public.bi_auditar(text, text, text, jsonb, text, text) to authenticated;

-- Leitura do log: só MASTER, via RPC (mesmo gate das demais master_*).
create or replace function public.bi_audit_consultar(p_start date, p_end date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_scope jsonb;
begin
  v_scope := public.operational_current_scope();
  if coalesce((v_scope->>'is_master')::boolean, false) is not true then
    raise exception 'Apenas MASTER pode consultar o log da Brabus Intelligence.' using errcode = '42501';
  end if;
  if p_end - p_start > 366 then
    raise exception 'Período máximo de 1 ano.' using errcode = '22023';
  end if;
  return jsonb_build_object('rows', coalesce((
    select jsonb_agg(to_jsonb(l) - 'auth_user_id' || jsonb_build_object('usuario', u.nome, 'loja', u.loja) order by l.created_at desc)
    from public.bi_audit_log l
    left join public.usuarios u on u.auth_user_id = l.auth_user_id
    where l.created_at >= (p_start::timestamp at time zone 'America/Sao_Paulo')
      and l.created_at <  ((p_end + 1)::timestamp at time zone 'America/Sao_Paulo')
  ), '[]'::jsonb));
end $$;

revoke all on function public.bi_audit_consultar(date, date) from public, anon;
grant execute on function public.bi_audit_consultar(date, date) to authenticated;

-- 3) Limpeza de simulações expiradas (rodar por pg_cron diariamente, se disponível) --
create or replace function public.bi_simulacoes_limpar()
returns integer language sql security definer set search_path = public as $$
  with d as (delete from public.bi_simulacoes where expires_at < now() - interval '1 day' returning 1)
  select count(*)::int from d;
$$;
revoke all on function public.bi_simulacoes_limpar() from public, anon, authenticated;

-- Agenda a limpeza diária se o pg_cron estiver habilitado no projeto (senão, ignora).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'bi_simulacoes_limpar';
    perform cron.schedule('bi_simulacoes_limpar', '17 6 * * *', 'select public.bi_simulacoes_limpar()');
  end if;
end $$;

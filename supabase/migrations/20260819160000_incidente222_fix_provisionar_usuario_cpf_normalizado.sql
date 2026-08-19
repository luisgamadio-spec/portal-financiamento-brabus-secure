-- Incidente 22.2 -- corrige master_provisionar_usuario(), que tentava
-- inserir explicitamente em usuarios.cpf_normalizado, coluna
-- GENERATED ALWAYS AS (normalizar_cpf(cpf)) -- erro 428C9 em qualquer
-- chamada, sempre, desde que essa constraint existe. Bug pre-existente,
-- encontrado (nao introduzido) no Incidente 22.1B durante teste
-- sintetico da melhoria de auditoria ator/alvo daquela fase.
--
-- Investigacao fresh (Incidente 22.2, Partes D/E/G) antes de corrigir:
--   - Zero callers em todo o repositorio (frontend/Edge Functions/outras
--     RPCs/scripts) -- so aparece na propria migration que a criou.
--   - Zero linha de auditoria 'Provisionamento de usuario' desde o
--     inicio do log (2026-06-18) -- nunca executou com sucesso.
--   - Busca sistemica em toda public. por INSERT/UPDATE em usuarios
--     mencionando cpf_normalizado: so master_provisionar_usuario grava
--     nela (bug real); master_convidar_usuario e
--     master_corrigir_revisao_cadastral so LEEM cpf_normalizado (em
--     comparacoes), nunca escrevem -- nenhum outro caso do mesmo bug.
-- Conclusao: RPC orfa (provavelmente reservada para provisionamento em
-- lote do legado BLISTIQ, nunca conectada a nenhum fluxo), quebrada
-- desde sempre, sem nenhum caller ativo -- corrigir aqui tem risco
-- estrutural zero para qualquer fluxo hoje em producao.
--
-- Correcao MINIMA (Parte H/I): remove "cpf_normalizado" e seu valor
-- (v_cpf duplicado) da lista explicita do INSERT -- o Postgres computa
-- sozinho a partir de "cpf" (Parte C, generation_expression =
-- normalizar_cpf(cpf)). Nenhuma outra linha alterada: mesmas validacoes,
-- mesmo ON CONFLICT, mesma auditoria ator/alvo do Incidente 22.1, mesmo
-- retorno.

create or replace function public.master_provisionar_usuario(
  p_email_auth text, p_cpf text, p_nome text, p_perfil text,
  p_loja text default null::text, p_status text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_id uuid;
  v_perfil text := upper(trim(coalesce(p_perfil, '')));
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_actor_nome text;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if trim(coalesce(p_email_auth, '')) = ''
     or trim(coalesce(p_nome, '')) = ''
     or v_cpf = '' then
    raise exception 'E-mail, CPF e nome são obrigatórios.'
      using errcode = '22023';
  end if;

  if v_perfil not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH'
  ) then
    raise exception 'Perfil inválido.' using errcode = '22023';
  end if;

  -- cpf_normalizado NUNCA entra na lista explicita -- e coluna GERADA
  -- (normalizar_cpf(cpf)), o Postgres computa sozinho a partir de "cpf".
  insert into public.usuarios (
    cpf, email_auth, nome, perfil, loja, status,
    ativo, primeiro_acesso, tentativas_login
  )
  values (
    v_cpf, lower(trim(p_email_auth)), trim(p_nome), v_perfil,
    nullif(trim(coalesce(p_loja, '')), ''),
    nullif(trim(coalesce(p_status, '')), ''),
    true, true, 0
  )
  on conflict (cpf) do update
  set
    email_auth = excluded.email_auth,
    nome = excluded.nome,
    perfil = excluded.perfil,
    loja = excluded.loja,
    status = excluded.status,
    ativo = true
  returning id into v_id;

  select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();

  insert into public.auditoria (
    tipo, descricao, base_origem, vendedor, cpf, resolvido
  )
  select
    'ADMIN_USUARIO',
    format('Provisionamento de usuário por %s', coalesce(v_actor_nome, '—')),
    'RPC master_provisionar_usuario',
    trim(p_nome), v_cpf, false;

  return v_id;
end;
$function$;

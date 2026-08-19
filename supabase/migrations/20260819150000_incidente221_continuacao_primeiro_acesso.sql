-- Incidente 22.1 -- Recuperacao segura do primeiro acesso moderno
-- interrompido (Auth confirmado + senha definida + usuarios.ativo=false +
-- primeiro_acesso=true), caso sentinela: Herbert Martins Nascimento.
--
-- Causa raiz provada no Incidente 22.0: "Reenviar convite" e "Gerar link
-- de ativacao" chamam generateLink(type='invite'), que o GoTrue recusa
-- para uma identidade ja confirmada ("A user with this email address has
-- already been registered"). Nao ha, hoje, nenhum caminho para levar
-- esse usuario ao mesmo estado final que concluir_convite_usuario()
-- produziria.
--
-- Modelo escolhido (Parte H/I do prompt): B -- link de continuacao curto,
-- de uso unico, concluido pelo proprio usuario -- nunca "forcar
-- ativo=true" direto via UPDATE administrativo. Mesmo padrao tecnico ja
-- usado pelo fluxo legado BLISTIQ (ativacoes_acesso_usuario.continuacao_*,
-- Fase 4.2/Incidente 19.2), mas em tabela propria do fluxo moderno
-- (convites_usuario) -- conceitos distintos, nunca misturados (Parte N).
--
-- Hash do token: seguindo o MESMO padrao ja usado por
-- confirm-access-activation (Fase 4.1/4.2) -- o token bruto e gerado e
-- hasheado (SHA-256) na Edge Function/frontend (Web Crypto), NUNCA em
-- SQL. As RPCs abaixo recebem e guardam somente o hash, nunca o token.
--
-- Contrato replicado (Parte C, comparado contra usuarios reais que
-- concluiram o fluxo moderno normalmente -- Diego Kreicher Pena, Sarah
-- Candido Severo, Aline Melo da Silva, Rodrigo Carriel de Oliveira, Bruno
-- Henrique da Silva Santos, todos com convites_usuario.status='ACEITO'):
--   usuarios.ativo:            false -> true
--   usuarios.primeiro_acesso:  true  -> false
--   usuarios.senha_alterada_em: -> now()
--   (usuarios.atualizado_em NAO e tocado por concluir_convite_usuario() --
--    confirmado empiricamente nos 5 usuarios de referencia acima, que
--    mostram atualizado_em == criado_em mesmo apos concluir o convite --
--    por isso esta migration tambem NAO toca esse campo, para nao
--    divergir do contrato real já em producao.)
--   convites_usuario.status:   ENVIADO -> ACEITO
--   convites_usuario.aceito_em: -> now()
--   convites_usuario.atualizado_em: -> now()
--   auditoria: 1 linha nova.
--
-- Divergencia deliberada: em vez de reaproveitar o tipo CONVITE_ACEITO
-- (que sugeriria que o fluxo normal terminou sozinho), esta migration usa
-- tipos proprios (CONTINUACAO_PRIMEIRO_ACESSO_*) para nunca disfarçar que
-- houve uma recuperacao assistida -- honestidade da trilha de auditoria
-- (Parte AM), sem alterar o CONTRATO de estado (Parte AO: convites_usuario
-- ainda vira ACEITO com aceito_em, exatamente como o fluxo normal).

-- =========================================================================
-- PARTE M -- extensao minima de convites_usuario (token de continuacao)
-- =========================================================================

alter table public.convites_usuario
  add column if not exists continuacao_token_hash text,
  add column if not exists continuacao_gerada_em timestamptz,
  add column if not exists continuacao_expira_em timestamptz,
  add column if not exists continuacao_consumida_em timestamptz;

create index if not exists convites_usuario_continuacao_hash_idx
  on public.convites_usuario (continuacao_token_hash)
  where continuacao_token_hash is not null;

-- =========================================================================
-- PARTE J/K/L/W/X/Y/Z/AA -- RPC: gerar link de continuacao (MASTER-only)
-- =========================================================================
-- Chamada direta via supabaseClient.rpc() (sem Edge Function -- esta RPC
-- nunca fala com o GoTrue, so cria um token proprio da aplicacao; grants
-- authenticated+service_role, nunca anon, MASTER-only verificado dentro
-- do corpo -- mesmo padrao de todas as outras RPCs master_* do sistema).
-- Recebe o hash ja calculado pelo chamador (Web Crypto no navegador),
-- nunca o token bruto -- nunca persistido em texto puro, nunca logado.

create or replace function public.master_gerar_continuacao_primeiro_acesso(
  p_usuario_id uuid,
  p_token_hash text,
  p_expira_em timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_alvo public.usuarios%rowtype;
  v_auth_email text;
  v_auth_confirmado boolean;
  v_convite public.convites_usuario%rowtype;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if p_token_hash is null or length(trim(p_token_hash)) < 32 then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_HASH_INVALIDO');
  end if;
  if p_expira_em is null or p_expira_em <= now() or p_expira_em > now() + interval '30 minutes' then
    return jsonb_build_object('ok', false, 'codigo', 'EXPIRACAO_INVALIDA');
  end if;

  -- Parte Z -- reler tudo fresh, nunca confiar no que a UI mandou.
  select * into v_alvo from public.usuarios where id = p_usuario_id;
  if v_alvo.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;
  if v_alvo.ativo then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_JA_ATIVO');
  end if;
  if not v_alvo.primeiro_acesso then
    return jsonb_build_object('ok', false, 'codigo', 'PRIMEIRO_ACESSO_NAO_PENDENTE');
  end if;
  if v_alvo.auth_user_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'SEM_CONTA_AUTH');
  end if;
  -- Parte N/AA -- legado BLISTIQ usa fluxo proprio (migracao), nunca
  -- continuacao moderna -- mesmo criterio de dominio ja usado no frontend
  -- (ehEmailAcessoLegado).
  if lower(coalesce(v_alvo.email_auth, '')) like '%@portalfi.brabus'
     or lower(coalesce(v_alvo.email_auth, '')) like '%@brabus-fi.local' then
    return jsonb_build_object('ok', false, 'codigo', 'CONTA_LEGADA_USE_MIGRACAO');
  end if;

  select au.email, (au.email_confirmed_at is not null)
    into v_auth_email, v_auth_confirmado
  from auth.users au where au.id = v_alvo.auth_user_id;
  if v_auth_email is null then
    return jsonb_build_object('ok', false, 'codigo', 'CONTA_AUTH_NAO_LOCALIZADA');
  end if;
  if lower(v_auth_email) <> lower(coalesce(v_alvo.email_auth, '')) then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_DIVERGENTE');
  end if;
  if not coalesce(v_auth_confirmado, false) then
    -- Este NAO e o estado que esta RPC atende -- usuario deve continuar
    -- usando Reenviar Convite / Gerar Link de Ativacao normais.
    return jsonb_build_object('ok', false, 'codigo', 'AUTH_NAO_CONFIRMADO');
  end if;

  select * into v_convite from public.convites_usuario
  where usuario_id = v_alvo.id order by convidado_em desc limit 1;
  if v_convite.id is null or v_convite.status not in ('PENDENTE', 'ENVIADO') then
    return jsonb_build_object('ok', false, 'codigo', 'CONVITE_INCOMPATIVEL');
  end if;

  -- Parte W -- rate limit server-side, 5 minutos (mesmo padrao ja usado
  -- em admin-generate-user-access-link / admin-resend-user-invite).
  if v_convite.continuacao_gerada_em is not null
     and now() - v_convite.continuacao_gerada_em < interval '5 minutes' then
    return jsonb_build_object(
      'ok', false, 'codigo', 'RATE_LIMIT',
      'aguardar_segundos',
      extract(epoch from (interval '5 minutes' - (now() - v_convite.continuacao_gerada_em)))::integer
    );
  end if;

  -- Parte V -- gerar um novo token invalida qualquer anterior nao
  -- utilizado (mesma linha, mesma coluna, sobrescrita).
  update public.convites_usuario
  set continuacao_token_hash = p_token_hash,
      continuacao_gerada_em = now(),
      continuacao_expira_em = p_expira_em,
      continuacao_consumida_em = null,
      atualizado_em = now()
  where id = v_convite.id;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values (
    'CONTINUACAO_PRIMEIRO_ACESSO_GERADA',
    format('Master %s gerou link de continuacao de primeiro acesso para %s', v_actor.nome, v_alvo.nome),
    'Painel Master', v_alvo.nome, v_alvo.cpf, v_alvo.loja, false
  );

  return jsonb_build_object('ok', true, 'codigo', 'GERADO');
end;
$function$;

revoke all on function public.master_gerar_continuacao_primeiro_acesso(uuid, text, timestamptz) from public, anon;
grant execute on function public.master_gerar_continuacao_primeiro_acesso(uuid, text, timestamptz) to authenticated, service_role;

-- =========================================================================
-- PARTE Q/T/U/AJ/AK -- RPC: concluir continuacao (service_role ONLY)
-- =========================================================================
-- NUNCA anon/authenticated -- mesmo padrao das RPCs anonimas do fluxo
-- legado (activation_lookup_by_cpf/activation_create_request/
-- activation_confirm_email/activation_finalize), todas com anon_exec=false
-- e so alcancaveis via Edge Function com service_role (confirmado no
-- Incidente 22.1 Parte antes desta migration). Isso e deliberado: mesmo
-- sendo a propria posse do token o unico "segredo" de quem chama, este
-- projeto nunca expoe essas RPCs diretamente a anon -- defesa em
-- profundidade contra descoberta do schema/objeto pelo PostgREST.
--
-- Nao depende de auth.uid()/sessao Supabase (Parte AK) -- o alvo e
-- resolvido inteiramente pelo hash do token, nunca por quem esta logado
-- (ou nao) no navegador que abriu o link.

create or replace function public.concluir_continuacao_primeiro_acesso(
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_convite public.convites_usuario%rowtype;
  v_usuario public.usuarios%rowtype;
  v_updated integer;
begin
  if p_token_hash is null or trim(p_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;

  select * into v_convite from public.convites_usuario
  where continuacao_token_hash = p_token_hash;
  if v_convite.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;

  select * into v_usuario from public.usuarios where id = v_convite.usuario_id;

  -- Parte T/U -- uso unico / idempotencia: token ja consumido antes.
  if v_convite.continuacao_consumida_em is not null then
    if v_usuario.id is not null and v_usuario.ativo and not v_usuario.primeiro_acesso then
      return jsonb_build_object('ok', false, 'codigo', 'JA_CONCLUIDO');
    end if;
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_JA_UTILIZADO');
  end if;

  if v_convite.continuacao_expira_em is null or v_convite.continuacao_expira_em < now() then
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
    select 'CONTINUACAO_PRIMEIRO_ACESSO_FALHA',
      format('Link de continuacao expirado para %s', v_usuario.nome),
      'RPC concluir_continuacao_primeiro_acesso', v_usuario.nome, v_usuario.cpf, v_usuario.loja, false
    where v_usuario.id is not null;
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_EXPIRADO');
  end if;

  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  -- Estado ja mudou por outro caminho entre a geracao e o uso do link
  -- (ex.: concluiu pelo fluxo normal enquanto isso) -- idempotente, nao
  -- e erro, so nao ha nada a fazer.
  if v_usuario.ativo or not v_usuario.primeiro_acesso then
    update public.convites_usuario
    set continuacao_consumida_em = now()
    where id = v_convite.id and continuacao_consumida_em is null;
    return jsonb_build_object('ok', false, 'codigo', 'JA_CONCLUIDO');
  end if;

  -- Mesmo efeito exato de concluir_convite_usuario() (Parte C), so que
  -- pela chave do convite/usuario em vez de auth.uid().
  update public.usuarios
  set ativo = true, primeiro_acesso = false, senha_alterada_em = now()
  where id = v_usuario.id and ativo = false and primeiro_acesso = true
  returning * into v_usuario;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  update public.convites_usuario
  set status = 'ACEITO', aceito_em = now(), atualizado_em = now(), continuacao_consumida_em = now()
  where id = v_convite.id;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_em)
  values (
    'CONTINUACAO_PRIMEIRO_ACESSO_CONCLUIDA',
    format('Primeiro acesso concluido via link de continuacao por %s', v_usuario.nome),
    'Portal F&I', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'CONCLUIDO', 'nome', v_usuario.nome, 'perfil', v_usuario.perfil);
end;
$function$;

revoke all on function public.concluir_continuacao_primeiro_acesso(text) from public, anon, authenticated;
grant execute on function public.concluir_continuacao_primeiro_acesso(text) to service_role;

-- =========================================================================
-- PARTE AP -- auditoria do ALVO em master_atualizar_autorizacao_usuario
-- e master_provisionar_usuario (achado do Incidente 22.0: so registravam
-- o ATOR, nunca o alvo -- impossivel reconstruir quem foi afetado).
-- Parte AQ -- nenhuma mudanca de semantica funcional: mesmas validacoes,
-- mesmo UPDATE/INSERT, mesmo retorno. So os campos vendedor/cpf/loja da
-- auditoria passam a identificar o ALVO (nunca alterado antes), e a
-- descricao passa a citar o ator pelo nome.
-- =========================================================================

create or replace function public.master_atualizar_autorizacao_usuario(
  p_usuario_id uuid, p_perfil text, p_loja text, p_status text, p_ativo boolean
)
returns boolean
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_perfil text := upper(trim(coalesce(p_perfil, '')));
  v_actor_nome text;
  v_alvo public.usuarios%rowtype;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_perfil not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH'
  ) then
    raise exception 'Perfil inválido.' using errcode = '22023';
  end if;

  update public.usuarios
  set
    perfil = v_perfil,
    loja = nullif(trim(coalesce(p_loja, '')), ''),
    status = nullif(trim(coalesce(p_status, '')), ''),
    ativo = coalesce(p_ativo, false)
  where id = p_usuario_id
  returning * into v_alvo;

  if v_alvo.id is null then
    raise exception 'Usuário não encontrado.' using errcode = 'P0002';
  end if;

  select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();

  insert into public.auditoria (
    tipo, descricao, base_origem, vendedor, cpf, loja, resolvido
  )
  values (
    'ADMIN_USUARIO',
    format('Autorização de usuário atualizada por %s (perfil=%s, ativo=%s)',
      coalesce(v_actor_nome, '—'), v_alvo.perfil, v_alvo.ativo),
    'RPC master_atualizar_autorizacao_usuario',
    v_alvo.nome, v_alvo.cpf, v_alvo.loja, false
  );

  return true;
end;
$function$;

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

  insert into public.usuarios (
    cpf, cpf_normalizado, email_auth, nome, perfil, loja, status,
    ativo, primeiro_acesso, tentativas_login
  )
  values (
    v_cpf, v_cpf, lower(trim(p_email_auth)), trim(p_nome), v_perfil,
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

-- =========================================================================
-- PARTE AC/AD/AE -- master_admin_security_data(): expor estado_acesso
-- via UM booleano novo (auth_confirmado), reaproveitando a MESMA junccao
-- com auth.users que ja existe para email_divergente -- nenhuma nova
-- consulta, nenhuma duplicacao. O ESTADO final continua derivado no
-- frontend (acessoBlistiqInfo + a nova checagem ativo/primeiro_acesso/
-- auth_confirmado), que ja tinha 100% da logica legado correta -- so
-- faltava este UNICO fato sobre o moderno. Nunca expõe email_confirmed_at
-- bruto nem qualquer outro campo interno do Auth (Parte AD).
-- =========================================================================

create or replace function public.master_admin_security_data()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'cpf', u.cpf,
          'cpf_normalizado', u.cpf_normalizado,
          'nome', u.nome,
          'perfil', u.perfil,
          'loja', u.loja,
          'status', u.status,
          'ativo', u.ativo,
          'primeiro_acesso', u.primeiro_acesso,
          'ultimo_login', u.ultimo_login,
          'email_auth', u.email_auth,
          'tem_auth', (u.auth_user_id is not null),
          'email_divergente', (
            u.auth_user_id is not null
            and exists (
              select 1 from auth.users au
              where au.id = u.auth_user_id
                and lower(au.email) is distinct from lower(u.email_auth)
            )
          ),
          'auth_confirmado', (
            u.auth_user_id is not null
            and exists (
              select 1 from auth.users au
              where au.id = u.auth_user_id
                and au.email_confirmed_at is not null
            )
          ),
          'ativacao_legado', (
            select jsonb_build_object(
              'status', a.status,
              'email_novo', a.email_novo,
              'criado_em', a.criado_em,
              'ultimo_envio_em', a.ultimo_envio_em,
              'expira_em', a.expira_em,
              'verificado_em', a.verificado_em,
              'concluido_em', a.concluido_em
            )
            from public.ativacoes_acesso_usuario a
            where a.usuario_id = u.id
            order by a.criado_em desc
            limit 1
          )
        )
        order by u.nome
      )
      from public.usuarios u
    ), '[]'::jsonb),
    'configurations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'chave', c.chave,
          'valor', c.valor,
          'descricao', c.descricao,
          'atualizado_em', c.atualizado_em
        )
        order by c.chave
      )
      from public.configuracoes c
      where c.chave = any (array[
        'share_minimo',
        'spf_liquido_percentual',
        'bonus_spf_analista',
        'limite_retorno_novos',
        'limite_retorno_seminovos',
        'vendedor_faixa_baixo_share_baixo',
        'vendedor_faixa_baixo_share_alto',
        'vendedor_faixa_alto_share_baixo',
        'vendedor_faixa_alto_share_alto',
        'gerente_faixa_share_baixo',
        'gerente_faixa_share_alto',
        'analista_faixa_share_baixo',
        'analista_faixa_share_alto'
      ])
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.criado_em desc)
      from (
        select id, tipo, descricao, base_origem, loja, vendedor, cpf,
               resolvido, resolvido_por, resolvido_em, criado_em
        from public.auditoria
        order by criado_em desc
        limit 100
      ) a
    ), '[]'::jsonb)
  );
end;
$function$;

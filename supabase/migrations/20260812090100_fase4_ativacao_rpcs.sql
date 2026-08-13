-- Fase 4 — RPCs do fluxo de Primeiro Acesso / Ativação por CPF (Fases 4.1–4.3).
-- Versionamento retroativo (Fase 4.5). Corpo das funções idêntico ao que foi
-- implantado originalmente, ANTES do enforcement de feature flag da Fase 4.5
-- (ver 20260813010000_fase45_feature_flag.sql, que faz CREATE OR REPLACE em
-- activation_lookup_by_cpf e activation_create_request por cima desta base).

create or replace function public.mascarar_nome(p_nome text)
 returns text
 language plpgsql
 immutable
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_palavras text[];
  v_resultado text[] := array[]::text[];
  v_palavra text;
begin
  if p_nome is null or trim(p_nome) = '' then
    return '';
  end if;
  v_palavras := regexp_split_to_array(trim(p_nome), '\s+');
  foreach v_palavra in array v_palavras loop
    if length(v_palavra) <= 1 then
      v_resultado := array_append(v_resultado, v_palavra);
    else
      v_resultado := array_append(v_resultado, left(v_palavra,1) || repeat('*', length(v_palavra)-1));
    end if;
  end loop;
  return array_to_string(v_resultado, ' ');
end;
$function$;

-- Original Fase 4.1 (sem enforcement de feature flag — adicionado na 4.5).
create or replace function public.activation_lookup_by_cpf(p_cpf text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_usuario public.usuarios%rowtype;
  v_auth_email text;
  v_elegivel boolean := false;
  v_nome_mascarado text := '';
begin
  if length(v_cpf) <> 11 then
    return jsonb_build_object('elegivel', false, 'nome_mascarado', '');
  end if;

  select u.* into v_usuario
  from public.usuarios u
  where u.cpf_normalizado = v_cpf
  limit 1;

  if v_usuario.id is not null then
    select a.email into v_auth_email
    from auth.users a
    where a.id = v_usuario.auth_user_id;
  end if;

  v_elegivel :=
    v_usuario.id is not null
    and v_usuario.ativo is true
    and v_usuario.auth_user_id is not null
    and v_auth_email is not null
    and lower(coalesce(v_usuario.email_auth, '')) = lower(v_auth_email)
    and (
      lower(coalesce(v_usuario.email_auth, '')) like '%@portalfi.brabus'
      or lower(coalesce(v_usuario.email_auth, '')) like '%@brabus-fi.local'
    )
    and not exists (
      select 1
      from public.ativacoes_acesso_usuario aa
      where aa.usuario_id = v_usuario.id
        and aa.status = any (array[
          'PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO'
        ])
    );

  if v_elegivel then
    v_nome_mascarado := public.mascarar_nome(v_usuario.nome);
  end if;

  return jsonb_build_object(
    'elegivel', v_elegivel,
    'nome_mascarado', v_nome_mascarado
  );
end;
$function$;

-- Original Fase 4.1 (sem enforcement de feature flag — adicionado na 4.5).
create or replace function public.activation_create_request(p_cpf text, p_email_novo text, p_celular_novo text, p_loja_informada text, p_nbs_informado text, p_token_hash text, p_expira_em timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_email text := lower(trim(coalesce(p_email_novo,'')));
  v_celular text := regexp_replace(coalesce(p_celular_novo,''), '\D', '', 'g');
  v_loja text := nullif(upper(trim(coalesce(p_loja_informada,''))), '');
  v_nbs text := nullif(upper(trim(coalesce(p_nbs_informado,''))), '');
  v_usuario public.usuarios%rowtype;
  v_auth_email text;
  v_existente public.ativacoes_acesso_usuario%rowtype;
  v_lojas_validas constant text[] := array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'];
  v_id uuid;
begin
  if length(v_cpf) <> 11 then
    return jsonb_build_object('ok', false, 'codigo', 'CPF_INVALIDO');
  end if;

  select u.* into v_usuario from public.usuarios u where u.cpf_normalizado = v_cpf limit 1;
  if v_usuario.id is not null then
    select a.email into v_auth_email from auth.users a where a.id = v_usuario.auth_user_id;
  end if;

  if v_usuario.id is null
     or v_usuario.ativo is not true
     or v_usuario.auth_user_id is null
     or v_auth_email is null
     or lower(coalesce(v_usuario.email_auth,'')) <> lower(v_auth_email)
     or not (
       lower(coalesce(v_usuario.email_auth,'')) like '%@portalfi.brabus'
       or lower(coalesce(v_usuario.email_auth,'')) like '%@brabus-fi.local'
     )
  then
    return jsonb_build_object('ok', false, 'codigo', 'NAO_ELEGIVEL');
  end if;

  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_INVALIDO');
  end if;
  if v_email like '%@portalfi.brabus' or v_email like '%@brabus-fi.local' then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_FICTICIO_NAO_PERMITIDO');
  end if;
  if v_celular <> '' and length(v_celular) not in (10,11) then
    return jsonb_build_object('ok', false, 'codigo', 'CELULAR_INVALIDO');
  end if;
  if v_loja is not null and not (v_loja = any(v_lojas_validas)) then
    return jsonb_build_object('ok', false, 'codigo', 'LOJA_INVALIDA');
  end if;
  if v_nbs is not null and length(v_nbs) > 40 then
    return jsonb_build_object('ok', false, 'codigo', 'NBS_INVALIDO');
  end if;

  if exists (select 1 from auth.users a where lower(a.email) = v_email and a.id <> v_usuario.auth_user_id) then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
  end if;
  if exists (select 1 from public.usuarios u2 where lower(coalesce(u2.email_auth,'')) = v_email and u2.id <> v_usuario.id) then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
  end if;

  select * into v_existente
  from public.ativacoes_acesso_usuario aa
  where aa.usuario_id = v_usuario.id
    and aa.status = any(array['PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO'])
  limit 1;

  if v_existente.id is not null then
    if v_existente.status not in ('PENDENTE_EMAIL','EMAIL_ENVIADO') then
      return jsonb_build_object('ok', false, 'codigo', 'ATIVACAO_EM_ESTADO_NAO_EDITAVEL');
    end if;
    if v_existente.ultimo_envio_em is not null and v_existente.ultimo_envio_em > now() - interval '60 seconds' then
      return jsonb_build_object('ok', false, 'codigo', 'AGUARDE_COOLDOWN');
    end if;
    if v_email <> lower(v_existente.email_novo) and exists (
      select 1 from public.ativacoes_acesso_usuario aa2
      where lower(aa2.email_novo) = v_email
        and aa2.usuario_id <> v_usuario.id
        and aa2.status = any(array['PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO'])
    ) then
      return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
    end if;

    update public.ativacoes_acesso_usuario
    set email_novo = v_email,
        celular_novo = nullif(v_celular,''),
        loja_informada = v_loja,
        nbs_informado = v_nbs,
        status = 'EMAIL_ENVIADO',
        token_hash = p_token_hash,
        expira_em = p_expira_em,
        tentativas_envio = tentativas_envio + 1,
        ultimo_envio_em = now(),
        verificado_em = null,
        erro_codigo = null,
        erro_mensagem = null,
        atualizado_em = now()
    where id = v_existente.id
    returning id into v_id;
  else
    if exists (
      select 1 from public.ativacoes_acesso_usuario aa2
      where lower(aa2.email_novo) = v_email
        and aa2.status = any(array['PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA','ATIVANDO'])
    ) then
      return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
    end if;

    insert into public.ativacoes_acesso_usuario (
      usuario_id, email_novo, celular_novo, loja_informada, nbs_informado,
      status, token_hash, expira_em, tentativas_envio, ultimo_envio_em
    ) values (
      v_usuario.id, v_email, nullif(v_celular,''), v_loja, v_nbs,
      'EMAIL_ENVIADO', p_token_hash, p_expira_em, 1, now()
    )
    returning id into v_id;
  end if;

  return jsonb_build_object('ok', true, 'codigo', 'OK', 'ativacao_id', v_id);
end;
$function$;

create or replace function public.activation_mark_send_error(p_ativacao_id uuid, p_erro_codigo text, p_erro_mensagem text)
 returns void
 language sql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  update public.ativacoes_acesso_usuario
  set status = 'PENDENTE_EMAIL',
      erro_codigo = p_erro_codigo,
      erro_mensagem = p_erro_mensagem,
      atualizado_em = now()
  where id = p_ativacao_id
    and status = 'EMAIL_ENVIADO';
$function$;

create or replace function public.ativacao_rate_limit_check(p_ip text, p_endpoint text, p_max_tentativas integer, p_janela_minutos integer)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_permitido boolean;
begin
  insert into public.ativacao_rate_limit (ip, endpoint, janela_inicio, tentativas)
  values (coalesce(nullif(trim(p_ip), ''), 'desconhecido'), p_endpoint, now(), 1)
  on conflict (ip, endpoint) do update
  set
    tentativas = case
      when public.ativacao_rate_limit.janela_inicio < now() - make_interval(mins => p_janela_minutos)
        then 1
      else public.ativacao_rate_limit.tentativas + 1
    end,
    janela_inicio = case
      when public.ativacao_rate_limit.janela_inicio < now() - make_interval(mins => p_janela_minutos)
        then now()
      else public.ativacao_rate_limit.janela_inicio
    end
  returning (tentativas <= p_max_tentativas) into v_permitido;

  return coalesce(v_permitido, true);
end;
$function$;

create or replace function public.activation_cancel(p_ativacao_id uuid, p_motivo text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_status_anterior text;
  v_updated integer;
begin
  select status into v_status_anterior from public.ativacoes_acesso_usuario where id = p_ativacao_id;
  if v_status_anterior is null then
    return jsonb_build_object('ok', false, 'codigo', 'NAO_ENCONTRADA');
  end if;
  if v_status_anterior not in ('PENDENTE_EMAIL','EMAIL_ENVIADO','EMAIL_VERIFICADO','PENDENTE_SENHA') then
    return jsonb_build_object('ok', false, 'codigo', 'ESTADO_NAO_CANCELAVEL', 'status_atual', v_status_anterior);
  end if;

  update public.ativacoes_acesso_usuario
  set status = 'CANCELADO',
      cancelado_em = now(),
      erro_codigo = 'CANCELADO_MANUALMENTE',
      erro_mensagem = p_motivo,
      atualizado_em = now()
  where id = p_ativacao_id
    and status = v_status_anterior;
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENTE');
  end if;

  return jsonb_build_object('ok', true, 'codigo', 'OK', 'status_anterior', v_status_anterior, 'status_novo', 'CANCELADO');
end;
$function$;

create or replace function public.activation_prepare_complete(p_continuacao_token_hash text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_row public.ativacoes_acesso_usuario%rowtype;
  v_usuario public.usuarios%rowtype;
  v_auth_email text;
  v_updated_rows integer;
begin
  if p_continuacao_token_hash is null or trim(p_continuacao_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;

  select * into v_row
  from public.ativacoes_acesso_usuario
  where continuacao_token_hash = p_continuacao_token_hash
  limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;

  if v_row.status = 'CONCLUIDO' then
    return jsonb_build_object('ok', false, 'codigo', 'JA_CONCLUIDA');
  end if;
  if v_row.status = 'ATIVANDO' then
    return jsonb_build_object('ok', false, 'codigo', 'EM_PROCESSAMENTO');
  end if;
  if v_row.status = 'AUTH_OK_USUARIOS_PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'AGUARDANDO_FINALIZACAO', 'ativacao_id', v_row.id);
  end if;
  if v_row.status <> 'EMAIL_VERIFICADO' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;
  if v_row.continuacao_consumida_em is not null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_JA_USADO');
  end if;
  if v_row.continuacao_expira_em is null or v_row.continuacao_expira_em < now() then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_EXPIRADO');
  end if;

  select * into v_usuario from public.usuarios u where u.id = v_row.usuario_id;
  if v_usuario.id is null or v_usuario.ativo is not true then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ELEGIVEL');
  end if;
  if v_usuario.auth_user_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ELEGIVEL');
  end if;

  select a.email into v_auth_email from auth.users a where a.id = v_usuario.auth_user_id;
  if v_auth_email is null or lower(v_auth_email) <> lower(coalesce(v_usuario.email_auth,'')) then
    return jsonb_build_object('ok', false, 'codigo', 'IDENTIDADE_INCONSISTENTE');
  end if;

  if exists (
    select 1 from auth.users a
    where lower(a.email) = lower(v_row.email_novo) and a.id <> v_usuario.auth_user_id
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
  end if;
  if exists (
    select 1 from public.usuarios u2
    where lower(coalesce(u2.email_auth,'')) = lower(v_row.email_novo) and u2.id <> v_usuario.id
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
  end if;

  update public.ativacoes_acesso_usuario
  set status = 'ATIVANDO',
      continuacao_consumida_em = now(),
      atualizado_em = now()
  where id = v_row.id
    and status = 'EMAIL_VERIFICADO'
    and continuacao_consumida_em is null;
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'EM_PROCESSAMENTO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'codigo', 'OK',
    'ativacao_id', v_row.id,
    'usuario_id', v_usuario.id,
    'auth_user_id', v_usuario.auth_user_id,
    'email_novo', v_row.email_novo,
    'celular_novo', v_row.celular_novo,
    'loja_informada', v_row.loja_informada,
    'nbs_informado', v_row.nbs_informado,
    'loja_anterior', v_usuario.loja,
    'login_nbs_anterior', v_usuario.login_nbs
  );
end;
$function$;

create or replace function public.activation_mark_auth_ok(p_ativacao_id uuid)
 returns jsonb
 language sql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  update public.ativacoes_acesso_usuario
  set status = 'AUTH_OK_USUARIOS_PENDENTE', atualizado_em = now()
  where id = p_ativacao_id and status = 'ATIVANDO'
  returning jsonb_build_object('ok', true, 'codigo', 'OK');
$function$;

create or replace function public.activation_revert_after_auth_failure(p_ativacao_id uuid, p_erro_codigo text, p_erro_mensagem text)
 returns jsonb
 language sql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  update public.ativacoes_acesso_usuario
  set status = 'EMAIL_VERIFICADO',
      continuacao_consumida_em = null,
      erro_codigo = p_erro_codigo,
      erro_mensagem = p_erro_mensagem,
      atualizado_em = now()
  where id = p_ativacao_id and status = 'ATIVANDO'
  returning jsonb_build_object('ok', true, 'codigo', 'OK');
$function$;

create or replace function public.activation_finalize(p_ativacao_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_row public.ativacoes_acesso_usuario%rowtype;
  v_usuario public.usuarios%rowtype;
  v_loja_anterior text;
  v_nbs_anterior text;
  v_criou_revisao_loja boolean := false;
  v_criou_revisao_nbs boolean := false;
begin
  select * into v_row from public.ativacoes_acesso_usuario where id = p_ativacao_id;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ATIVACAO_NAO_ENCONTRADA');
  end if;

  if v_row.status = 'CONCLUIDO' then
    return jsonb_build_object('ok', true, 'codigo', 'OK', 'ja_concluida', true, 'revisao_criada', false);
  end if;
  if v_row.status <> 'AUTH_OK_USUARIOS_PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'ESTADO_INVALIDO');
  end if;

  select * into v_usuario from public.usuarios where id = v_row.usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  v_loja_anterior := v_usuario.loja;
  v_nbs_anterior := v_usuario.login_nbs;

  update public.usuarios
  set email_auth = v_row.email_novo,
      celular = nullif(trim(coalesce(v_row.celular_novo, '')), ''),
      login_nbs = coalesce(nullif(trim(coalesce(v_row.nbs_informado, '')), ''), login_nbs),
      loja = coalesce(nullif(trim(coalesce(v_row.loja_informada, '')), ''), loja),
      primeiro_acesso = false,
      atualizado_em = now()
  where id = v_usuario.id;

  if v_row.loja_informada is not null
     and trim(v_row.loja_informada) <> ''
     and upper(trim(coalesce(v_loja_anterior,''))) <> upper(trim(v_row.loja_informada))
  then
    insert into public.revisoes_cadastrais (usuario_id, campo, valor_anterior, valor_novo, origem, status)
    values (v_usuario.id, 'LOJA', v_loja_anterior, v_row.loja_informada, 'PRIMEIRO_ACESSO', 'PENDENTE');
    v_criou_revisao_loja := true;
  end if;

  if v_row.nbs_informado is not null
     and trim(v_row.nbs_informado) <> ''
     and upper(trim(coalesce(v_nbs_anterior,''))) <> upper(trim(v_row.nbs_informado))
  then
    insert into public.revisoes_cadastrais (usuario_id, campo, valor_anterior, valor_novo, origem, status)
    values (v_usuario.id, 'LOGIN_NBS', v_nbs_anterior, v_row.nbs_informado, 'PRIMEIRO_ACESSO', 'PENDENTE');
    v_criou_revisao_nbs := true;
  end if;

  update public.ativacoes_acesso_usuario
  set status = 'CONCLUIDO', concluido_em = now(), atualizado_em = now()
  where id = v_row.id and status = 'AUTH_OK_USUARIOS_PENDENTE';

  return jsonb_build_object(
    'ok', true, 'codigo', 'OK', 'ja_concluida', false,
    'revisao_criada', (v_criou_revisao_loja or v_criou_revisao_nbs),
    'revisao_loja', v_criou_revisao_loja,
    'revisao_nbs', v_criou_revisao_nbs,
    'usuario_nome', v_usuario.nome,
    'loja_anterior', v_loja_anterior,
    'loja_nova', v_row.loja_informada,
    'nbs_anterior', v_nbs_anterior,
    'nbs_novo', v_row.nbs_informado
  );
end;
$function$;

create or replace function public.activation_confirm_email(p_token_hash text, p_continuacao_token_hash text, p_continuacao_expira_em timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_row public.ativacoes_acesso_usuario%rowtype;
  v_auth_user_id uuid;
begin
  if p_token_hash is null or trim(p_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;
  if p_continuacao_token_hash is null or trim(p_continuacao_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'ERRO_INTERNO');
  end if;

  select * into v_row
  from public.ativacoes_acesso_usuario
  where token_hash = p_token_hash
  limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;
  if v_row.status <> 'EMAIL_ENVIADO' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_JA_USADO_OU_INVALIDO');
  end if;
  if v_row.expira_em is null or v_row.expira_em < now() then
    update public.ativacoes_acesso_usuario
    set status = 'ERRO', erro_codigo = 'TOKEN_EXPIRADO', atualizado_em = now()
    where id = v_row.id;
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_EXPIRADO');
  end if;

  select auth_user_id into v_auth_user_id from public.usuarios where id = v_row.usuario_id;

  if exists (
    select 1 from auth.users a
    where lower(a.email) = lower(v_row.email_novo) and a.id <> v_auth_user_id
  ) then
    update public.ativacoes_acesso_usuario
    set status = 'ERRO',
        erro_codigo = 'EMAIL_TOMADO_APOS_ENVIO',
        erro_mensagem = 'E-mail passou a pertencer a outra conta antes da confirmação.',
        atualizado_em = now()
    where id = v_row.id;
    return jsonb_build_object('ok', false, 'codigo', 'EMAIL_JA_EM_USO');
  end if;

  update public.ativacoes_acesso_usuario
  set status = 'EMAIL_VERIFICADO',
      verificado_em = now(),
      continuacao_token_hash = p_continuacao_token_hash,
      continuacao_expira_em = p_continuacao_expira_em,
      continuacao_consumida_em = null,
      atualizado_em = now()
  where id = v_row.id;

  return jsonb_build_object('ok', true, 'codigo', 'OK');
end;
$function$;

create or replace function public.master_list_revisoes_cadastrais(p_status text default 'PENDENTE'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_status text := upper(trim(coalesce(p_status, 'PENDENTE')));
  v_rows jsonb;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil,''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_status not in ('PENDENTE','APROVADO','CORRIGIDO','TODAS') then
    v_status := 'PENDENTE';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'revisao_id', r.id,
      'usuario_nome', u.nome,
      'campo', r.campo,
      'valor_anterior', r.valor_anterior,
      'valor_novo', r.valor_novo,
      'criado_em', r.criado_em,
      'status', r.status,
      'revisado_em', r.revisado_em
    )
    order by r.criado_em desc
  ), '[]'::jsonb)
  into v_rows
  from public.revisoes_cadastrais r
  join public.usuarios u on u.id = r.usuario_id
  where (v_status = 'TODAS' or r.status = v_status);

  return jsonb_build_object(
    'rows', v_rows,
    'total_pendentes', (select count(*) from public.revisoes_cadastrais where status='PENDENTE')
  );
end;
$function$;

create or replace function public.master_aprovar_revisao_cadastral(p_revisao_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_revisao public.revisoes_cadastrais%rowtype;
  v_usuario public.usuarios%rowtype;
  v_updated integer;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil,''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  select * into v_revisao from public.revisoes_cadastrais where id = p_revisao_id;
  if v_revisao.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'NAO_ENCONTRADA');
  end if;
  if v_revisao.status <> 'PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'JA_PROCESSADA', 'mensagem', 'Esta revisão já foi processada.');
  end if;

  select * into v_usuario from public.usuarios where id = v_revisao.usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  update public.revisoes_cadastrais
  set status = 'APROVADO', revisado_por = v_actor.id, revisado_em = now()
  where id = p_revisao_id and status = 'PENDENTE';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'JA_PROCESSADA', 'mensagem', 'Esta revisão já foi processada.');
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_por, resolvido_em)
  values (
    'REVISAO_CADASTRAL_APROVADA',
    format('Master %s aprovou a revisão de %s (%s -> %s) para %s', v_actor.nome, v_revisao.campo, coalesce(v_revisao.valor_anterior,'(vazio)'), v_revisao.valor_novo, v_usuario.nome),
    'Painel Master', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'OK');
end;
$function$;

create or replace function public.master_corrigir_revisao_cadastral(p_revisao_id uuid, p_valor_correto text, p_observacao text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_revisao public.revisoes_cadastrais%rowtype;
  v_usuario public.usuarios%rowtype;
  v_valor text := trim(coalesce(p_valor_correto, ''));
  v_lojas_validas constant text[] := array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'];
  v_seller public.portal_sellers%rowtype;
  v_updated integer;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil,''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_valor = '' then
    return jsonb_build_object('ok', false, 'codigo', 'VALOR_OBRIGATORIO');
  end if;

  select * into v_revisao from public.revisoes_cadastrais where id = p_revisao_id;
  if v_revisao.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'NAO_ENCONTRADA');
  end if;
  if v_revisao.status <> 'PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'JA_PROCESSADA', 'mensagem', 'Esta revisão já foi processada.');
  end if;

  select * into v_usuario from public.usuarios where id = v_revisao.usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  if v_revisao.campo = 'LOJA' then
    v_valor := upper(v_valor);
    if not (v_valor = any(v_lojas_validas) or v_valor = upper(trim(coalesce(v_revisao.valor_anterior,'')))) then
      return jsonb_build_object('ok', false, 'codigo', 'LOJA_INVALIDA');
    end if;
    update public.usuarios set loja = v_valor, atualizado_em = now() where id = v_usuario.id;

  elsif v_revisao.campo = 'LOGIN_NBS' then
    v_valor := upper(v_valor);
    select * into v_seller from public.portal_sellers where upper(trim(nbs)) = v_valor and active limit 1;
    if v_seller.id is null then
      return jsonb_build_object('ok', false, 'codigo', 'NBS_NAO_ENCONTRADO');
    end if;
    if v_seller.portal_user_id is not null and v_seller.portal_user_id <> v_usuario.id then
      return jsonb_build_object('ok', false, 'codigo', 'NBS_VINCULADO_OUTRO_USUARIO');
    end if;
    if v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_usuario.cpf_normalizado then
      return jsonb_build_object('ok', false, 'codigo', 'NBS_CPF_DIVERGENTE');
    end if;
    -- Fase 4.3: só grava usuarios.login_nbs. NÃO vincula
    -- portal_sellers.portal_user_id — decisão operacional separada.
    update public.usuarios set login_nbs = v_valor, atualizado_em = now() where id = v_usuario.id;

  else
    return jsonb_build_object('ok', false, 'codigo', 'CAMPO_NAO_SUPORTADO');
  end if;

  update public.revisoes_cadastrais
  set status = 'CORRIGIDO',
      revisado_por = v_actor.id,
      revisado_em = now(),
      observacao = nullif(trim(coalesce(p_observacao, '')), '')
  where id = p_revisao_id and status = 'PENDENTE';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'JA_PROCESSADA', 'mensagem', 'Esta revisão já foi processada.');
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_por, resolvido_em)
  values (
    'REVISAO_CADASTRAL_CORRIGIDA',
    format('Master %s corrigiu %s de %s para %s (informado: %s) para %s', v_actor.nome, v_revisao.campo, coalesce(v_revisao.valor_anterior,'(vazio)'), v_valor, v_revisao.valor_novo, v_usuario.nome),
    'Painel Master', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'OK', 'valor_aplicado', v_valor);
end;
$function$;

-- ==========================================================
-- Grants — mesma lição da Fase 4.1: o GRANT default do Supabase para
-- anon/authenticated na criação da função é implícito e separado de
-- REVOKE ALL FROM PUBLIC. Sempre revogar explicitamente.
-- ==========================================================

-- Fluxo de Ativação: só chamável via Edge Function com service_role.
revoke all on function public.mascarar_nome(text) from public;
revoke execute on function public.mascarar_nome(text) from anon, authenticated;

revoke all on function public.activation_lookup_by_cpf(text) from public;
revoke execute on function public.activation_lookup_by_cpf(text) from anon, authenticated;
grant execute on function public.activation_lookup_by_cpf(text) to service_role;

revoke all on function public.activation_create_request(text,text,text,text,text,text,timestamptz) from public;
revoke execute on function public.activation_create_request(text,text,text,text,text,text,timestamptz) from anon, authenticated;
grant execute on function public.activation_create_request(text,text,text,text,text,text,timestamptz) to service_role;

revoke all on function public.activation_mark_send_error(uuid,text,text) from public;
revoke execute on function public.activation_mark_send_error(uuid,text,text) from anon, authenticated;
grant execute on function public.activation_mark_send_error(uuid,text,text) to service_role;

revoke all on function public.ativacao_rate_limit_check(text,text,integer,integer) from public;
revoke execute on function public.ativacao_rate_limit_check(text,text,integer,integer) from anon, authenticated;
grant execute on function public.ativacao_rate_limit_check(text,text,integer,integer) to service_role;

revoke all on function public.activation_cancel(uuid,text) from public;
revoke execute on function public.activation_cancel(uuid,text) from anon, authenticated;
grant execute on function public.activation_cancel(uuid,text) to service_role;

revoke all on function public.activation_prepare_complete(text) from public;
revoke execute on function public.activation_prepare_complete(text) from anon, authenticated;
grant execute on function public.activation_prepare_complete(text) to service_role;

revoke all on function public.activation_mark_auth_ok(uuid) from public;
revoke execute on function public.activation_mark_auth_ok(uuid) from anon, authenticated;
grant execute on function public.activation_mark_auth_ok(uuid) to service_role;

revoke all on function public.activation_revert_after_auth_failure(uuid,text,text) from public;
revoke execute on function public.activation_revert_after_auth_failure(uuid,text,text) from anon, authenticated;
grant execute on function public.activation_revert_after_auth_failure(uuid,text,text) to service_role;

revoke all on function public.activation_finalize(uuid) from public;
revoke execute on function public.activation_finalize(uuid) from anon, authenticated;
grant execute on function public.activation_finalize(uuid) to service_role;

revoke all on function public.activation_confirm_email(text,text,timestamptz) from public;
revoke execute on function public.activation_confirm_email(text,text,timestamptz) from anon, authenticated;
grant execute on function public.activation_confirm_email(text,text,timestamptz) to service_role;

-- Painel Master: chamável pela própria sessão do usuário autenticado; a
-- autorização de fato é a checagem de perfil=MASTER dentro do corpo.
revoke all on function public.master_list_revisoes_cadastrais(text) from public;
grant execute on function public.master_list_revisoes_cadastrais(text) to authenticated, service_role;

revoke all on function public.master_aprovar_revisao_cadastral(uuid) from public;
grant execute on function public.master_aprovar_revisao_cadastral(uuid) to authenticated, service_role;

revoke all on function public.master_corrigir_revisao_cadastral(uuid,text,text) from public;
grant execute on function public.master_corrigir_revisao_cadastral(uuid,text,text) to authenticated, service_role;

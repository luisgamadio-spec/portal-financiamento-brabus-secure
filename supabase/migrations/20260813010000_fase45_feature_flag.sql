-- Fase 4.5 — feature flag server-side para o rollout do Primeiro Acesso.
--
-- Contexto: a auditoria da Fase 4.4 encontrou que a visibilidade do botão
-- "Ativar Meu Acesso" era controlada só no frontend (?ativacao=1), sem
-- nenhum controle real no backend — qualquer um dos 79 usuários legado
-- (ou qualquer CPF elegível) poderia se auto-ativar assim que o frontend
-- fosse publicado, sem decisão explícita do Master. Esta migration fecha
-- esse gap com um controle server-side real.
--
-- Estado inicial obrigatório: FALSE.

insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'ativacao_acesso_global',
  'false',
  'Liga/desliga globalmente o novo fluxo de Primeiro Acesso (Ativar Meu Acesso) por CPF para usuarios reais. Contas em contas_sinteticas_excluidas sempre passam, independente deste valor. FALSE = apenas homologacao controlada.',
  now()
)
on conflict (chave) do nothing;

-- Helper: true se o usuário pode iniciar/prosseguir o fluxo de Ativação,
-- considerando o flag global E a exceção explícita por ID (nunca por
-- heurística de nome/e-mail) para contas sintéticas de homologação.
create or replace function public.ativacao_global_habilitada(p_usuario_id uuid)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_flag text;
begin
  if p_usuario_id is not null and exists (
    select 1 from public.contas_sinteticas_excluidas c where c.usuario_id = p_usuario_id
  ) then
    return true;
  end if;

  select valor into v_flag from public.configuracoes where chave = 'ativacao_acesso_global';
  return coalesce(lower(trim(v_flag)) = 'true', false);
end;
$function$;

revoke all on function public.ativacao_global_habilitada(uuid) from public;
revoke execute on function public.ativacao_global_habilitada(uuid) from anon, authenticated;

-- ==========================================================
-- Enforcement em activation_lookup_by_cpf: quando o flag está desligado
-- (e o usuário não é uma conta sintética permitida), retorna a MESMA
-- resposta genérica usada para "não elegível" (elegivel=false,
-- nome_mascarado=''), com um campo adicional `disponivel=false` só para
-- uso futuro do frontend — nunca revela nada específico do CPF.
-- ==========================================================
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

  if not public.ativacao_global_habilitada(v_usuario.id) then
    return jsonb_build_object('elegivel', false, 'nome_mascarado', '', 'disponivel', false);
  end if;

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

-- ==========================================================
-- Enforcement em activation_create_request: checado logo após resolver
-- v_usuario, ANTES de qualquer avaliação de elegibilidade — para que
-- "flag desligado" e "não elegível" nunca sejam distinguíveis por
-- caminhos de código diferentes.
-- ==========================================================
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

  if not public.ativacao_global_habilitada(v_usuario.id) then
    return jsonb_build_object('ok', false, 'codigo', 'ATIVACAO_INDISPONIVEL');
  end if;

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

revoke all on function public.activation_lookup_by_cpf(text) from public;
revoke execute on function public.activation_lookup_by_cpf(text) from anon, authenticated;
grant execute on function public.activation_lookup_by_cpf(text) to service_role;

revoke all on function public.activation_create_request(text,text,text,text,text,text,timestamptz) from public;
revoke execute on function public.activation_create_request(text,text,text,text,text,text,timestamptz) from anon, authenticated;
grant execute on function public.activation_create_request(text,text,text,text,text,text,timestamptz) to service_role;

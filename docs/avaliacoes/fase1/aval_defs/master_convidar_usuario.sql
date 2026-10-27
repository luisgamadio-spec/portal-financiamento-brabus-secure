CREATE OR REPLACE FUNCTION public.master_convidar_usuario(p_cpf text, p_nome text, p_perfil text, p_loja text, p_email text, p_nbs text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios;
  v_cpf text := public.normalizar_cpf(p_cpf);
  v_perfil text := upper(trim(coalesce(p_perfil, '')));
  v_loja text := nullif(upper(trim(coalesce(p_loja, ''))), '');
  v_email text := lower(trim(coalesce(p_email, '')));
  v_nome text := trim(coalesce(p_nome, ''));
  v_nbs text := nullif(upper(trim(coalesce(p_nbs, ''))), '');
  v_status text := nullif(upper(trim(coalesce(p_status, ''))), '');
  v_seller public.portal_sellers;
  v_usuario_id uuid;
  v_convite_id uuid;
  v_lojas_validas constant text[] := array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'];
  v_perfis_validos constant text[] := array['MASTER','DIRETOR NOVOS','DIRETOR SEMINOVOS','ANALISTA','GERENTE','VENDEDOR','RECURSOS HUMANOS','RH'];
  v_status_validos constant text[] := array['NOVOS','SEMINOVOS','NOVOS/SEMINOVOS'];
  v_perfis_status_obrigatorio constant text[] := array['VENDEDOR','GERENTE','ANALISTA'];
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true and upper(trim(coalesce(u.perfil,''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if regexp_replace(coalesce(p_cpf,''), '[^0-9]', '', 'g') = '' or length(regexp_replace(coalesce(p_cpf,''), '[^0-9]', '', 'g')) > 11 then
    raise exception 'CPF inválido.' using errcode = '22023';
  end if;
  if v_nome = '' then
    raise exception 'Nome é obrigatório.' using errcode = '22023';
  end if;
  if v_perfil = '' or not (v_perfil = any(v_perfis_validos)) then
    raise exception 'Perfil inválido. Utilize um dos perfis já autorizados pelo sistema.' using errcode = '22023';
  end if;
  if v_loja is not null and not (v_loja = any(v_lojas_validas)) then
    raise exception 'Loja inválida. Utilize uma loja oficial cadastrada.' using errcode = '22023';
  end if;
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;
  if v_email like '%@portalfi.brabus' or v_email like '%@brabus-fi.local' then
    raise exception 'Use o e-mail real do colaborador — não um e-mail interno/fictício.' using errcode = '22023';
  end if;

  if v_perfil = any(v_perfis_status_obrigatorio) then
    if v_status is null or not (v_status = any(v_status_validos)) then
      raise exception 'Selecione o departamento (Novos, Seminovos ou Novos/Seminovos) para este perfil.' using errcode = '22023';
    end if;
  elsif v_perfil = 'DIRETOR NOVOS' then
    v_status := 'NOVOS';
  elsif v_perfil = 'DIRETOR SEMINOVOS' then
    v_status := 'SEMINOVOS';
  elsif v_perfil = 'MASTER' then
    v_status := 'MASTER';
  else
    v_status := null;
  end if;

  if exists (select 1 from public.usuarios where cpf_normalizado = v_cpf) then
    raise exception 'Já existe um usuário cadastrado com este CPF.' using errcode = '23505';
  end if;
  if exists (select 1 from public.usuarios where lower(coalesce(email_auth,'')) = v_email) then
    raise exception 'Já existe um usuário cadastrado com este e-mail.' using errcode = '23505';
  end if;

  if v_nbs is not null then
    if exists (
      select 1 from public.usuarios u2
      where upper(trim(coalesce(u2.login_nbs, ''))) = v_nbs and u2.ativo = true
    ) then
      raise exception 'Este login NBS já está em uso por outro usuário ativo.' using errcode = '23505';
    end if;
    select * into v_seller from public.portal_sellers where nbs = v_nbs and active limit 1;
    if v_seller.id is not null then
      if v_seller.portal_user_id is not null then
        raise exception 'Este login NBS já está vinculado a outro usuário do portal.' using errcode = '23505';
      end if;
      if v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_cpf then
        raise exception 'O CPF informado não corresponde ao cadastro deste login NBS.' using errcode = '22023';
      end if;
    end if;
  end if;

  insert into public.usuarios (cpf, nome, perfil, loja, status, email_auth, login_nbs, ativo, primeiro_acesso)
  values (p_cpf, v_nome, v_perfil, v_loja, v_status, v_email, v_nbs, false, true)
  returning id into v_usuario_id;

  if v_nbs is not null and v_seller.id is not null then
    update public.portal_sellers
       set portal_user_id = v_usuario_id, updated_at = now()
     where id = v_seller.id;
  end if;

  -- Fase 21.6B (Parte Y/Z) -- fecha o ciclo agora mesmo: qualquer fato ja
  -- importado com este CPF/NBS (SEM_MATCH anterior) e vinculado
  -- imediatamente, sem depender de ativacao/primeiro acesso.
  perform public.portal_reconcile_user_facts(v_usuario_id);

  insert into public.convites_usuario (usuario_id, cpf, nome, perfil, loja, email, nbs, status, convidado_por)
  values (v_usuario_id, v_cpf, v_nome, v_perfil, v_loja, v_email, v_nbs, 'PENDENTE', v_actor.id)
  returning id into v_convite_id;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('CONVITE_USUARIO',
    format('Convite criado por %s para %s (%s), perfil %s, departamento %s', v_actor.nome, v_nome, v_email, v_perfil, coalesce(v_status,'—')),
    'Painel Master', v_nome, v_cpf, v_loja, false);

  return jsonb_build_object('convite_id', v_convite_id, 'usuario_id', v_usuario_id, 'email', v_email, 'status', 'PENDENTE', 'departamento', v_status);
end;
$function$

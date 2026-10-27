CREATE OR REPLACE FUNCTION public.master_atualizar_autorizacao_usuario(p_usuario_id uuid, p_perfil text, p_loja text, p_status text, p_ativo boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$

CREATE OR REPLACE FUNCTION public.portal_modulos_permitidos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_profile text;
  v_status text;
  v_departments text[] := array[]::text[];
  v_result jsonb;
begin
  select *
    into v_user
  from public.usuarios
  where auth_user_id = auth.uid()
    and ativo = true
  limit 1;

  -- Default deny: identidade não resolvida = nenhum módulo.
  if v_user.id is null then
    return '[]'::jsonb;
  end if;

  v_profile := upper(trim(coalesce(v_user.perfil, '')));

  -- MASTER: acesso estrutural fixo a todos os módulos de negócio
  -- configuráveis. Nunca consulta a matriz — não pode se auto-bloquear.
  if v_profile = 'MASTER' then
    return coalesce((
      select jsonb_agg(m.id order by m.ordem)
      from public.modulos_portal m
      where m.configuravel = true and m.ativo = true
    ), '[]'::jsonb);
  end if;

  v_status := upper(trim(coalesce(v_user.status, '')));

  -- Mesma resolução de perfil/departamento de operational_current_scope()
  -- (não reimplementada por regex nova: mesmas regras, replicadas aqui
  -- porque essa função é somente leitura de escopo operacional de dados
  -- e não deve ser acoplada à camada de permissão de módulos).
  if v_profile in ('DIRETOR NOVOS', 'DIRETOR DE NOVOS') then
    v_profile := 'DIRETOR_NOVOS';
  elsif v_profile in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then
    v_profile := 'DIRETOR_SEMINOVOS';
  elsif v_profile in ('RECURSOS HUMANOS', 'RH') then
    v_profile := 'RH';
  end if;

  if v_profile in ('ANALISTA', 'RH') then
    v_departments := array['TODOS'];
  elsif v_profile in ('DIRETOR_NOVOS', 'DIRETOR_SEMINOVOS') then
    v_departments := array['TODOS'];
  elsif v_profile in ('GERENTE', 'VENDEDOR') then
    -- "SEMINOVOS" contém a substring "NOVOS"; remove antes de testar.
    if replace(v_status, 'SEMINOVOS', '') like '%NOVOS%' then
      v_departments := array_append(v_departments, 'NOVOS');
    end if;
    if v_status like '%SEMINOVOS%' then
      v_departments := array_append(v_departments, 'SEMINOVOS');
    end if;
  else
    -- Perfil desconhecido/não mapeado: default deny.
    return '[]'::jsonb;
  end if;

  if array_length(v_departments, 1) is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(distinct pm.modulo_id), '[]'::jsonb)
    into v_result
  from public.permissoes_modulos pm
  join public.modulos_portal m on m.id = pm.modulo_id
  where pm.perfil = v_profile
    and pm.departamento = any(v_departments)
    and pm.permitido = true
    and m.configuravel = true
    and m.ativo = true;

  return v_result;
end;
$function$

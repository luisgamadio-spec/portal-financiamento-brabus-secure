-- Desfaz a Fase 1 das Avaliações: remove os objetos novos e devolve as 4 funções e a constraint ao backup.
-- Trava: não roda se já existir usuário com perfil AVALIADOR (a constraint antiga o recusaria) --
-- nesse caso, primeiro trocar o perfil dessas pessoas no Painel Master.
-- ATENÇÃO: apaga as avaliações e consultas gravadas (exportar antes, se houver uso real).
begin;

do $t$ begin
  if exists (select 1 from public.usuarios where upper(perfil) = 'AVALIADOR') then
    raise exception 'TRAVA: há usuários com perfil AVALIADOR -- trocar o perfil antes de desfazer';
  end if;
end $t$;

drop function if exists public.aval_contexto(), public.aval_listar(text, integer), public.aval_obter(uuid),
  public.aval_salvar_identificacao(uuid, jsonb), public.aval_descartar(uuid, text), public.aval_referencias(uuid, text),
  public.aval_consulta_preparar(text, text), public.aval_consulta_registrar(uuid, text, text, text, text, boolean, jsonb, numeric),
  public.aval_regras_listar(), public.aval_master_salvar_regra(jsonb, text), public.aval_previa_calculo(numeric, numeric, numeric, jsonb),
  public._aval_carregar(uuid, jsonb), public._aval_regra_vigente(), public._aval_calcular(jsonb, numeric, numeric, numeric),
  public._aval_contexto(), public._aval_normaliza_placa(text), public._aval_normaliza_chassi(text);
drop table if exists public.aval_eventos, public.aval_avaliacoes, public.aval_consultas_veiculo, public.aval_regras_margem, public.fipe_precos;
delete from public.permissoes_modulos where modulo_id = 'avaliacoes';
delete from public.modulos_portal where id = 'avaliacoes';

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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.master_provisionar_usuario(p_email_auth text, p_cpf text, p_nome text, p_perfil text, p_loja text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Incidente Integridade-Cadastral-2.0: ON CONFLICT (cpf) so protege
  -- contra o MESMO texto bruto repetido -- se este CPF ja existir em
  -- usuarios sob formatacao BRUTA diferente (ex.: convite gravou
  -- "123.456.789-00" e aqui chega "12345678900"), o ON CONFLICT nao
  -- dispara (valores de texto diferentes) e o INSERT so e barrado pelo
  -- UNIQUE INDEX sobre cpf_normalizado (usuarios_cpf_normalizado_unique_idx).
  -- Sem tratamento, isso vazaria um erro SQL bruto (unique_violation) para
  -- quem chamou a RPC. O banco continua sendo a autoridade final -- nao ha
  -- pre-check aqui, so a captura da excecao que o proprio INSERT atomico
  -- ja gera (sem janela de race condition). So traduz especificamente a
  -- violacao do indice de CPF normalizado; qualquer outra unique_violation
  -- (ex.: email_auth, auth_user_id) propaga inalterada.
  begin
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
  exception when unique_violation then
    declare
      v_constraint text;
    begin
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'usuarios_cpf_normalizado_unique_idx' then
        raise exception 'Já existe um usuário cadastrado com este CPF.' using errcode = '23505';
      else
        raise;
      end if;
    end;
  end;

  -- Incidente Identidade-Operacional-2.0, Patch B: fecha o gap de
  -- provisionamento manual -- mesma classe de causa raiz de Fabio/Herbert.
  perform public.portal_reconcile_user_facts_core(v_id);

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
$function$;

alter table public.usuarios drop constraint usuarios_perfil_check;
alter table public.usuarios add constraint usuarios_perfil_check CHECK ((perfil = ANY (ARRAY['VENDEDOR'::text, 'GERENTE'::text, 'ANALISTA'::text, 'MASTER'::text, 'DIRETOR NOVOS'::text, 'DIRETOR SEMINOVOS'::text, 'RECURSOS HUMANOS'::text, 'RH'::text])));

commit;

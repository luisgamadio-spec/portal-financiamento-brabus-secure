-- Fase 22.5A-UX (Problema 1) -- IGNORAR + "não alertar novamente" (ou criar
-- uma exceção manualmente) deixava as demais ocorrências PENDENTE do MESMO
-- identificador intocadas, obrigando o Master a repetir a mesma decisão
-- alerta por alerta (caso real: um vendedor aparecendo em 7 alertas
-- distintos, um por combinação tipo/origem_base, todos com o mesmo CPF).
--
-- Propagação por identificador_tipo + identificador_valor NORMALIZADO
-- apenas (nunca por nome) -- CPF via normalizar_cpf(), NBS via
-- upper(trim()), mesma normalização já usada para localizar/criar a
-- exceção. Só PENDENTE -> IGNORADO (nunca RESOLVIDO: não houve correção
-- cadastral, foi decisão administrativa). IGNORADO/RESOLVIDO/EXCLUIDO
-- nunca são tocados pela propagação. Idempotente pela própria cláusula
-- WHERE status='PENDENTE' -- repetir a chamada não re-propaga nem duplica
-- auditoria. Um único evento de auditoria agregado (ALERTA_IGNORADO_PROPAGADO,
-- com quantidade_afetada) por lote, nunca um evento por alerta afetado.
--
-- Testado em transação com ROLLBACK antes de aplicar: 7 alertas mesmo CPF
-- sintético -> 6 propagados; 7 alertas mesmo NBS sintético -> 6 propagados;
-- grupo de controle com mesmo nome mas CPF diferente -> 0 afetados;
-- repetição da mesma chamada -> JA_IGNORADO, sem nova exceção/propagação;
-- caminho de exceção manual (master_cadastro_excecao_criar) -> mesma
-- propagação, 4/4 alertas de fixture ignorados, chamada repetida ->
-- EXCECAO_JA_ATIVA sem duplicar.

CREATE OR REPLACE FUNCTION public.master_cadastro_alerta_ignorar(p_alerta_id uuid, p_motivo text, p_observacao text DEFAULT NULL::text, p_criar_excecao boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios%rowtype;
  v_alerta public.portal_cadastro_alertas%rowtype;
  v_motivos_validos constant text[] := array[
    'FROTA', 'REVENDA', 'ATACADO', 'COLABORADOR_DESLIGADO',
    'FORA_DO_ESCOPO', 'TESTE', 'OUTRO'
  ];
  v_updated integer;
  v_excecao_id uuid;
  v_propagados integer := 0;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if p_motivo is null or not (upper(trim(p_motivo)) = any(v_motivos_validos)) then
    return jsonb_build_object('ok', false, 'codigo', 'MOTIVO_INVALIDO');
  end if;

  select * into v_alerta from public.portal_cadastro_alertas where id = p_alerta_id;
  if v_alerta.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ALERTA_NAO_ENCONTRADO');
  end if;

  -- Idempotencia (Parte Z): ja IGNORADO -> ok, sem no-op silencioso enganoso.
  if v_alerta.status = 'IGNORADO' then
    return jsonb_build_object('ok', true, 'codigo', 'JA_IGNORADO', 'alerta_id', v_alerta.id);
  end if;
  -- Maquina de estados (Parte AB): so PENDENTE -> IGNORADO e valido nesta
  -- fase. RESOLVIDO e EXCLUIDO sao terminais aqui -- reabertura fica para
  -- fase futura, nao implementada ainda (regra explicita da Parte AB/AC).
  if v_alerta.status <> 'PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'STATUS_INCOMPATIVEL', 'status_atual', v_alerta.status);
  end if;

  update public.portal_cadastro_alertas
  set status = 'IGNORADO',
      ignorado_por = v_actor.id,
      ignorado_em = now(),
      motivo_acao = upper(trim(p_motivo)) || coalesce(': ' || nullif(trim(p_observacao), ''), ''),
      atualizado_em = now()
  where id = p_alerta_id and status = v_alerta.status;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  if p_criar_excecao then
    if v_alerta.identificador_tipo is null or v_alerta.identificador_valor is null
       or v_alerta.identificador_tipo not in ('CPF', 'NBS') then
      return jsonb_build_object(
        'ok', true, 'codigo', 'IGNORADO_SEM_EXCECAO',
        'alerta_id', v_alerta.id,
        'excecao_erro', 'IDENTIFICADOR_NAO_ELEGIVEL_PARA_EXCECAO'
      );
    end if;

    insert into public.portal_cadastro_excecoes (
      identificador_tipo, identificador_valor, motivo, observacao, criado_por
    ) values (
      v_alerta.identificador_tipo,
      case when v_alerta.identificador_tipo = 'CPF'
        then public.normalizar_cpf(v_alerta.identificador_valor)
        else upper(trim(v_alerta.identificador_valor))
      end,
      upper(trim(p_motivo)),
      nullif(trim(p_observacao), ''),
      v_actor.id
    )
    on conflict do nothing
    returning id into v_excecao_id;

    if v_excecao_id is null then
      select id into v_excecao_id from public.portal_cadastro_excecoes
      where identificador_tipo = v_alerta.identificador_tipo
        and identificador_valor = case when v_alerta.identificador_tipo = 'CPF'
          then public.normalizar_cpf(v_alerta.identificador_valor)
          else upper(trim(v_alerta.identificador_valor))
        end
        and ativo = true
      limit 1;
    end if;

    insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
    values (
      'EXCECAO_CADASTRAL_CRIADA',
      format('Master %s criou excecao %s para identificador %s (motivo: %s) a partir do alerta %s',
        v_actor.nome, v_alerta.identificador_tipo, public.mascarar_identificador_cadastro(v_alerta.identificador_valor),
        upper(trim(p_motivo)), v_alerta.id),
      'Painel Master', true, v_actor.id, now()
    );

    -- Fase 22.5A-UX (Parte C) -- uma excecao ativa nao pode deixar outros
    -- alertas PENDENTE do MESMO identificador sem tratar so porque nao foram
    -- o alerta clicado. Propagacao e por identificador_tipo+valor NORMALIZADO
    -- apenas (nunca por nome -- Parte A), e so PENDENTE->IGNORADO (nunca
    -- RESOLVIDO: nao houve correcao cadastral, so decisao administrativa).
    with propagados as (
      update public.portal_cadastro_alertas
      set status = 'IGNORADO',
          ignorado_por = v_actor.id,
          ignorado_em = now(),
          motivo_acao = upper(trim(p_motivo)) || coalesce(': ' || nullif(trim(p_observacao), ''), ''),
          atualizado_em = now()
      where status = 'PENDENTE'
        and id <> v_alerta.id
        and identificador_tipo = v_alerta.identificador_tipo
        and (case when v_alerta.identificador_tipo = 'CPF'
              then public.normalizar_cpf(identificador_valor)
              else upper(trim(identificador_valor)) end)
            = (case when v_alerta.identificador_tipo = 'CPF'
              then public.normalizar_cpf(v_alerta.identificador_valor)
              else upper(trim(v_alerta.identificador_valor)) end)
      returning id
    )
    select count(*) into v_propagados from propagados;

    if v_propagados > 0 then
      insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
      values (
        'ALERTA_IGNORADO_PROPAGADO',
        format('Master %s ignorou mais %s alerta(s) pendente(s) do identificador %s %s ao criar a excecao %s (motivo: %s)',
          v_actor.nome, v_propagados, v_alerta.identificador_tipo,
          public.mascarar_identificador_cadastro(v_alerta.identificador_valor), v_excecao_id, upper(trim(p_motivo))),
        'Painel Master', true, v_actor.id, now()
      );
    end if;

    return jsonb_build_object(
      'ok', true, 'codigo', 'IGNORADO_COM_EXCECAO',
      'alerta_id', v_alerta.id, 'excecao_id', v_excecao_id, 'propagados', v_propagados
    );
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'ALERTA_IGNORADO',
    format('Master %s ignorou alerta %s (tipo: %s, motivo: %s)',
      v_actor.nome, v_alerta.id, v_alerta.tipo, upper(trim(p_motivo))),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'IGNORADO', 'alerta_id', v_alerta.id);
end;
$function$;

CREATE OR REPLACE FUNCTION public.master_cadastro_excecao_criar(p_identificador_tipo text, p_identificador_valor text, p_motivo text, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios%rowtype;
  v_tipo text := upper(trim(coalesce(p_identificador_tipo, '')));
  v_valor text;
  v_motivos_validos constant text[] := array[
    'FROTA', 'REVENDA', 'ATACADO', 'COLABORADOR_DESLIGADO',
    'FORA_DO_ESCOPO', 'TESTE', 'OUTRO'
  ];
  v_excecao_id uuid;
  v_propagados integer := 0;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_tipo not in ('CPF', 'NBS') then
    return jsonb_build_object('ok', false, 'codigo', 'IDENTIFICADOR_TIPO_INVALIDO');
  end if;
  if p_motivo is null or not (upper(trim(p_motivo)) = any(v_motivos_validos)) then
    return jsonb_build_object('ok', false, 'codigo', 'MOTIVO_INVALIDO');
  end if;

  v_valor := case
    when v_tipo = 'CPF' then public.normalizar_cpf(p_identificador_valor)
    else upper(trim(coalesce(p_identificador_valor, '')))
  end;
  if v_valor is null or v_valor = '' or (v_tipo = 'CPF' and v_valor = '00000000000') then
    return jsonb_build_object('ok', false, 'codigo', 'IDENTIFICADOR_VALOR_INVALIDO');
  end if;

  if exists (
    select 1 from public.portal_cadastro_excecoes
    where identificador_tipo = v_tipo and identificador_valor = v_valor and ativo = true
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'EXCECAO_JA_ATIVA');
  end if;

  insert into public.portal_cadastro_excecoes (
    identificador_tipo, identificador_valor, motivo, observacao, criado_por
  ) values (
    v_tipo, v_valor, upper(trim(p_motivo)), nullif(trim(p_observacao), ''), v_actor.id
  )
  returning id into v_excecao_id;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'EXCECAO_CADASTRAL_CRIADA',
    format('Master %s criou excecao manual %s para identificador %s (motivo: %s)',
      v_actor.nome, v_tipo, public.mascarar_identificador_cadastro(v_valor), upper(trim(p_motivo))),
    'Painel Master', true, v_actor.id, now()
  );

  -- Fase 22.5A-UX (Parte C) -- mesma propagacao de master_cadastro_alerta_ignorar,
  -- para que criar a excecao manualmente (sem passar por "ignorar") tambem
  -- limpe alertas PENDENTE ja existentes para o mesmo identificador.
  with propagados as (
    update public.portal_cadastro_alertas
    set status = 'IGNORADO',
        ignorado_por = v_actor.id,
        ignorado_em = now(),
        motivo_acao = upper(trim(p_motivo)) || coalesce(': ' || nullif(trim(p_observacao), ''), ''),
        atualizado_em = now()
    where status = 'PENDENTE'
      and identificador_tipo = v_tipo
      and (case when v_tipo = 'CPF'
            then public.normalizar_cpf(identificador_valor)
            else upper(trim(identificador_valor)) end) = v_valor
    returning id
  )
  select count(*) into v_propagados from propagados;

  if v_propagados > 0 then
    insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
    values (
      'ALERTA_IGNORADO_PROPAGADO',
      format('Master %s ignorou %s alerta(s) pendente(s) do identificador %s %s ao criar a excecao manual %s (motivo: %s)',
        v_actor.nome, v_propagados, v_tipo, public.mascarar_identificador_cadastro(v_valor), v_excecao_id, upper(trim(p_motivo))),
      'Painel Master', true, v_actor.id, now()
    );
  end if;

  return jsonb_build_object('ok', true, 'codigo', 'CRIADA', 'excecao_id', v_excecao_id, 'propagados', v_propagados);
end;
$function$;

-- Fase 22.5A.1 -- correcao do fluxo "Resolver problema" em Pendencias
-- Cadastrais: ate aqui, a unica acao disponivel era marcar o alerta
-- RESOLVIDO sem corrigir o cadastro (caso sentinela: NBS_DIVERGENTE --
-- clicar "Resolver" nao alterava usuarios.login_nbs, entao a causa
-- continuava existindo e o alerta podia reaparecer na proxima importacao).
--
-- Esta RPC e a correcao REAL para NBS_DIVERGENTE: altera usuarios.login_nbs
-- de forma MASTER-only, com as MESMAS validacoes ja provadas em producao
-- por master_corrigir_revisao_cadastral (Fase 4.3) -- unicidade entre
-- usuarios ATIVOS e consistencia best-effort contra portal_sellers -- e so
-- marca o alerta como RESOLVIDO depois de revalidar que a condicao
-- especifica daquele alerta (login_nbs_encontrado) realmente passou a
-- bater com o valor aplicado (prova de resolucao, nunca so porque o UPDATE
-- "deu certo"). Resolve em lote outros alertas NBS_DIVERGENTE do MESMO
-- usuario cuja condicao tambem foi provada -- mas NUNCA usa
-- portal_reconcile_user_facts aqui: essa funcao resolve TODOS os alertas
-- PENDENTE do mesmo identificador (CPF/NBS), de QUALQUER tipo, e uma
-- auditoria fresh encontrou 2 identificadores reais com mais de um tipo de
-- alerta pendente simultaneamente -- reutiliza-la teria resolvido alertas
-- (ex.: LOJA_DIVERGENTE) sem nenhuma prova de que a causa deles tambem
-- desapareceu. Testado em transacao com ROLLBACK: caminho de sucesso (com
-- resolucao em lote de 2 alertas NBS_DIVERGENTE do mesmo usuario, e um
-- terceiro alerta LOJA_DIVERGENTE do MESMO usuario corretamente preservado
-- PENDENTE) e caminho de conflito (NBS ja vinculado a outro usuario ativo
-- -- cadastro original e alerta permanecem inalterados).

CREATE OR REPLACE FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(
  p_alerta_id uuid,
  p_novo_login_nbs text,
  p_observacao text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_actor public.usuarios%rowtype;
  v_alerta public.portal_cadastro_alertas%rowtype;
  v_usuario public.usuarios%rowtype;
  v_seller public.portal_sellers%rowtype;
  v_novo text := upper(trim(coalesce(p_novo_login_nbs, '')));
  v_resolvidos integer := 0;
  v_alerta_atual_resolvido boolean := false;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_novo = '' then
    return jsonb_build_object('ok', false, 'codigo', 'VALOR_OBRIGATORIO');
  end if;

  select * into v_alerta from public.portal_cadastro_alertas where id = p_alerta_id;
  if v_alerta.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ALERTA_NAO_ENCONTRADO');
  end if;
  if v_alerta.tipo <> 'NBS_DIVERGENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'TIPO_INCOMPATIVEL');
  end if;
  -- Idempotencia: ja RESOLVIDO -> ok, sem no-op silencioso enganoso.
  if v_alerta.status = 'RESOLVIDO' then
    return jsonb_build_object('ok', true, 'codigo', 'JA_RESOLVIDO', 'alerta_id', v_alerta.id);
  end if;
  if v_alerta.status <> 'PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'STATUS_INCOMPATIVEL', 'status_atual', v_alerta.status);
  end if;
  if v_alerta.usuario_candidato_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'SEM_CANDIDATO');
  end if;

  select * into v_usuario from public.usuarios where id = v_alerta.usuario_candidato_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  -- Mesma validacao ja provada em producao por master_corrigir_revisao_cadastral
  -- (Fase 4.3): unicidade entre usuarios ATIVOS e consistencia best-effort
  -- contra portal_sellers quando ja existir linha legada com o mesmo NBS.
  if exists (
    select 1 from public.usuarios u2
    where upper(trim(coalesce(u2.login_nbs, ''))) = v_novo and u2.ativo = true and u2.id <> v_usuario.id
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'NBS_VINCULADO_OUTRO_USUARIO');
  end if;
  select * into v_seller from public.portal_sellers where upper(trim(nbs)) = v_novo and active limit 1;
  if v_seller.id is not null and v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_usuario.cpf_normalizado then
    return jsonb_build_object('ok', false, 'codigo', 'NBS_CPF_DIVERGENTE');
  end if;

  update public.usuarios set login_nbs = v_novo, atualizado_em = now() where id = v_usuario.id;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_por, resolvido_em)
  values (
    'CADASTRO_CORRIGIDO',
    format('Master %s corrigiu Login NBS de %s (era %s, agora %s) a partir do alerta %s%s',
      v_actor.nome, v_usuario.nome, coalesce(nullif(trim(coalesce(v_usuario.login_nbs, '')), ''), '(vazio)'), v_novo, v_alerta.id,
      case when nullif(trim(coalesce(p_observacao, '')), '') is not null then ' -- ' || trim(p_observacao) else '' end),
    'Painel Master', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, v_actor.id, now()
  );

  -- Parte N -- prova de resolucao: so marca ESTE alerta como RESOLVIDO se
  -- o valor que ele proprio apontava como "encontrado na base" bate com o
  -- valor recem-aplicado. Nunca marca resolvido so porque o UPDATE deu certo.
  if upper(trim(coalesce(v_alerta.login_nbs_encontrado, ''))) = v_novo then
    update public.portal_cadastro_alertas
    set status = 'RESOLVIDO', resolvido_por = v_actor.id, resolvido_em = now(),
        motivo_acao = 'Login NBS corrigido automaticamente para ' || v_novo, atualizado_em = now()
    where id = v_alerta.id and status = 'PENDENTE';
    get diagnostics v_resolvidos = row_count;
    v_alerta_atual_resolvido := v_resolvidos > 0;
  end if;

  -- Parte O -- resolve em lote SOMENTE outros alertas PENDENTE, mesmo tipo
  -- NBS_DIVERGENTE, mesmo usuario_candidato_id, cuja condicao especifica
  -- (o proprio login_nbs_encontrado daquele alerta) tambem passa a bater
  -- com o valor corrigido -- nunca alertas de outro tipo (LOJA/DEPARTAMENTO
  -- etc.), mesmo que sejam do mesmo identificador (achado real: existem
  -- identificadores com mais de um tipo de alerta pendente ao mesmo tempo).
  with resolvidos_lote as (
    update public.portal_cadastro_alertas
    set status = 'RESOLVIDO', resolvido_por = v_actor.id, resolvido_em = now(),
        motivo_acao = 'Login NBS corrigido automaticamente para ' || v_novo, atualizado_em = now()
    where status = 'PENDENTE'
      and tipo = 'NBS_DIVERGENTE'
      and id <> v_alerta.id
      and usuario_candidato_id = v_usuario.id
      and upper(trim(coalesce(login_nbs_encontrado, ''))) = v_novo
    returning id
  )
  select count(*) into v_resolvidos from resolvidos_lote;

  if v_resolvidos > 0 then
    insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
    values (
      'ALERTA_RESOLVIDO_AUTOMATICAMENTE',
      format('Master %s: %s alerta(s) NBS_DIVERGENTE adicionais de %s resolvidos automaticamente apos corrigir o Login NBS',
        v_actor.nome, v_resolvidos, v_usuario.nome),
      'Painel Master', true, v_actor.id, now()
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'codigo', 'CORRIGIDO',
    'usuario_id', v_usuario.id, 'novo_login_nbs', v_novo,
    'alertas_resolvidos', v_resolvidos + (case when v_alerta_atual_resolvido then 1 else 0 end)
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(uuid, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(uuid, text, text) TO postgres;

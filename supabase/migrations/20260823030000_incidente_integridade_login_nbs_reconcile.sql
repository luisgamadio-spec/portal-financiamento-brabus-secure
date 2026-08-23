-- Incidente: Integridade Cadastral 1.0 -- Alteracao de login_nbs x Reconciliacao de Fatos
--
-- Problema comprovado (fixture ROLLBACK, ver scratchpad da investigacao):
-- quando um usuario JA ATIVO tem seu usuarios.login_nbs alterado por uma das
-- 3 rotinas abaixo, nenhuma delas disparava portal_reconcile_user_facts_core.
-- Vendas/financiamentos orfaos (seller_user_id null, seller_cpf_normalizado
-- null) que so poderiam ser resolvidos pelo NBS-fallback dessa reconciliacao
-- ficavam permanentemente sem vendedor vinculado ate uma reconciliacao manual
-- ou uma nova importacao "por sorte" cobrir o mesmo registro.
--
-- Busca sistemica cobriu TODAS as funcoes de public (nao so as duas
-- previamente suspeitas) e nao apenas via regex estrito de "set login_nbs =";
-- encontrou uma terceira rotina nao reportada anteriormente
-- (activation_finalize, fluxo de reativacao/migracao de acesso que exige
-- usuario ja ativo) com o mesmo problema.
--
-- Busca em dados reais (usuarios ativos x fatos orfaos resolviveis por NBS)
-- encontrou 0 casos atualmente afetados -- o gap e estrutural/preventivo,
-- nao ha vazamento observavel na base hoje. Confirmado por fixture sintetica
-- em transacao ROLLBACK que o bug existe nas 3 funcoes e que o patch abaixo
-- o elimina nas 3, sem regressao em conflito (fato com CPF de outra pessoa
-- nunca e roubado), duplicidade (bloqueio de unicidade de NBS continua
-- ocorrendo ANTES de qualquer reconciliacao) nem idempotencia (reenviar o
-- mesmo valor de login_nbs nao dispara reconciliacao nem auditoria extra).
--
-- Nao modifica portal_reconcile_user_facts_core (ja homologada no Incidente
-- P1 -- Identidade Operacional 2.0) nem os importadores de Sales/Finance.
-- Reconciliacao roda na MESMA transacao de cada correcao de cadastro: se
-- falhar, a excecao propaga e desfaz tambem a mudanca de login_nbs -- nunca
-- fica um cadastro corrigido com fatos inconsistentes por baixo. So executa
-- quando o valor normalizado de login_nbs realmente muda.

CREATE OR REPLACE FUNCTION public.master_cadastro_alerta_corrigir_login_nbs(p_alerta_id uuid, p_novo_login_nbs text, p_observacao text DEFAULT NULL::text)
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

  -- Incidente Integridade-Cadastral-1.0: login_nbs mudou de fato sobre um
  -- usuario JA ATIVO -- fatos (vendas/financiamentos) que dependiam desse
  -- NBS para resolver via fallback podem ter ficado orfaos ate agora.
  -- Reconcilia na MESMA transacao: se a reconciliacao falhar, a excecao
  -- propaga e desfaz tambem a mudanca de login_nbs. So executa quando o
  -- valor normalizado realmente mudou, evitando trabalho/auditoria
  -- desnecessaria em correcoes que na pratica repetem o mesmo valor.
  if v_novo <> coalesce(upper(trim(v_usuario.login_nbs)), '') then
    perform public.portal_reconcile_user_facts_core(v_usuario.id);
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_por, resolvido_em)
  values (
    'CADASTRO_CORRIGIDO',
    format('Master %s corrigiu Login NBS de %s (era %s, agora %s) a partir do alerta %s%s',
      v_actor.nome, v_usuario.nome, coalesce(nullif(trim(coalesce(v_usuario.login_nbs, '')), ''), '(vazio)'), v_novo, v_alerta.id,
      case when nullif(trim(coalesce(p_observacao, '')), '') is not null then ' -- ' || trim(p_observacao) else '' end),
    'Painel Master', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, v_actor.id, now()
  );

  if upper(trim(coalesce(v_alerta.login_nbs_encontrado, ''))) = v_novo then
    update public.portal_cadastro_alertas
    set status = 'RESOLVIDO', resolvido_por = v_actor.id, resolvido_em = now(),
        motivo_acao = 'Login NBS corrigido automaticamente para ' || v_novo, atualizado_em = now()
    where id = v_alerta.id and status = 'PENDENTE';
    get diagnostics v_resolvidos = row_count;
    v_alerta_atual_resolvido := v_resolvidos > 0;
  end if;

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
$function$
;

CREATE OR REPLACE FUNCTION public.master_corrigir_revisao_cadastral(p_revisao_id uuid, p_valor_correto text, p_observacao text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
    if exists (
      select 1 from public.usuarios u2
      where upper(trim(coalesce(u2.login_nbs, ''))) = v_valor and u2.ativo = true and u2.id <> v_usuario.id
    ) then
      return jsonb_build_object('ok', false, 'codigo', 'NBS_VINCULADO_OUTRO_USUARIO');
    end if;
    select * into v_seller from public.portal_sellers where upper(trim(nbs)) = v_valor and active limit 1;
    if v_seller.id is not null and v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_usuario.cpf_normalizado then
      return jsonb_build_object('ok', false, 'codigo', 'NBS_CPF_DIVERGENTE');
    end if;
    update public.usuarios set login_nbs = v_valor, atualizado_em = now() where id = v_usuario.id;

    -- Incidente Integridade-Cadastral-1.0: mesmo raciocinio de
    -- master_cadastro_alerta_corrigir_login_nbs -- login_nbs mudou sobre
    -- usuario ja ativo, reconcilia fatos na mesma transacao (falha aqui
    -- desfaz tambem a correcao de cadastro), so quando o valor realmente
    -- mudou. Exclusivo do ramo LOGIN_NBS -- LOJA nao tem relacao com
    -- resolucao de identidade de fatos.
    if v_valor <> coalesce(upper(trim(v_usuario.login_nbs)), '') then
      perform public.portal_reconcile_user_facts_core(v_usuario.id);
    end if;

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
$function$
;

CREATE OR REPLACE FUNCTION public.activation_finalize(p_ativacao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Incidente Integridade-Cadastral-1.0: esta funcao roda sobre um usuario
  -- QUE JA ESTAVA ativo (ver USUARIO_NAO_ELEGIVEL em
  -- activation_prepare_complete -- exige ativo=true antes de sequer
  -- comecar) -- o login_nbs informado aqui, mesmo pendente de revisao
  -- MASTER em revisoes_cadastrais, ja passa a ser usado imediatamente por
  -- qualquer nova importacao (master_operational_import_sales/finance
  -- casam contra usuarios.login_nbs sem gate de revisao); tratar como
  -- "nao confiavel o bastante para reconciliar" seria inconsistente com
  -- esse comportamento ja existente. Reconciliacao usa as mesmas
  -- salvaguardas de sempre (CPF sempre vence, nunca sobrescreve fato ja
  -- vinculado, nunca reconcilia em CONFLITO). Nao publica -- caller e o
  -- proprio usuario se ativando, nao Master -- por isso _core direto,
  -- mesmo padrao de concluir_convite_usuario/concluir_continuacao_
  -- primeiro_acesso (Incidente P1 Fase 2.0). Mesma transacao (falha aqui
  -- desfaz a finalizacao inteira) e so quando o valor realmente mudou.
  if nullif(upper(trim(coalesce(v_row.nbs_informado, ''))), '') is not null
     and upper(trim(coalesce(v_row.nbs_informado, ''))) <> coalesce(upper(trim(v_nbs_anterior)), '')
  then
    perform public.portal_reconcile_user_facts_core(v_usuario.id);
  end if;

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
$function$
;

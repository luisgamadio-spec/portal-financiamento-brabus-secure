-- Incidente Herbert -- alerta USUARIO_INATIVO_COM_PRODUCAO fica PENDENTE
-- (stale) depois que o usuario conclui o primeiro acesso e passa para
-- ativo=true.
--
-- RAIZ COMPROVADA: portal_reconcile_user_facts() ja resolve alertas
-- PENDENTES vinculados ao CPF/NBS do usuario, mas so e chamada dentro de
-- master_convidar_usuario() -- ou seja, no momento da criacao do convite,
-- nunca no momento em que o usuario efetivamente conclui o primeiro acesso
-- (evento que faz ativo passar para true). Existem DOIS fluxos live que
-- fazem essa transicao e nenhum deles reavaliava alertas cadastrais:
--   - concluir_continuacao_primeiro_acesso(p_token_hash) -- link de
--     continuacao de uso unico (Incidente 22.1).
--   - concluir_convite_usuario() -- fluxo padrao via auth.uid().
--
-- Caso real (sentinela Herbert Martins Nascimento, CPF ...49803->821):
-- convite criado 15/08 (usuarios.ativo=false); alerta URGENTE
-- USUARIO_INATIVO_COM_PRODUCAO nasceu corretamente em 19/08 14:47 (fato de
-- venda com CPF_INATIVO, 74 ocorrencias de um unico lote SALES_CURRENT);
-- primeiro acesso concluido as 19/08 16:04 (ativo->true); nenhuma
-- reconciliacao rodou depois disso -- alerta ficou PENDENTE por 2+ dias
-- mesmo com a condicao ja falsa.
--
-- FIX MINIMO: NAO reaproveita portal_reconcile_user_facts (exige
-- is_master() -- nao disponivel em nenhum dos dois fluxos de ativacao; e
-- resolveria QUALQUER tipo de alerta PENDENTE do mesmo CPF/NBS, incluindo
-- NBS_DIVERGENTE/LOJA_DIVERGENTE/DEPARTAMENTO_DIVERGENTE, que a conclusao
-- do primeiro acesso nao comprova). Em vez disso, cada funcao passa a
-- resolver, na mesma transacao logo apos confirmar ativo=true, SOMENTE
-- alertas PENDENTES do tipo USUARIO_INATIVO_COM_PRODUCAO cujo
-- identificador_tipo='CPF' bate com o CPF do usuario recem-ativado.
-- Nenhum outro tipo de alerta e tocado.
--
-- TESTE (transacao com ROLLBACK, nunca persistido):
--   1) Herbert real: usuarios temporariamente revertido para
--      ativo=false/primeiro_acesso=true, fixture de alerta LOJA_DIVERGENTE
--      nao relacionado inserida para o mesmo CPF, impersonation do
--      auth_user_id real dele, chamada real a concluir_convite_usuario().
--      Resultado: ativo->true; alerta USUARIO_INATIVO_COM_PRODUCAO
--      (id 1c5ecd10-...) -> RESOLVIDO; alerta NBS_DIVERGENTE ja resolvido
--      anteriormente por humano permaneceu RESOLVIDO com o mesmo
--      resolvido_por (nao foi re-tocado); fixture LOJA_DIVERGENTE
--      permaneceu PENDENTE.
--   2) Fixture sintetica (CPF 000.000.001-91, nunca existiu de verdade):
--      usuario inativo + alerta USUARIO_INATIVO_COM_PRODUCAO + alerta
--      DEPARTAMENTO_DIVERGENTE nao relacionado + convite com token de
--      continuacao, exercendo concluir_continuacao_primeiro_acesso().
--      Resultado: ativo->true; alerta alvo -> RESOLVIDO; alerta nao
--      relacionado permaneceu PENDENTE.
-- ROLLBACK confirmado (bodies e grants voltaram ao estado anterior antes
-- da promocao real).
--
-- POS-PROMOCAO: grants e search_path idempotes (CREATE OR REPLACE
-- preserva ambos -- confirmado via information_schema.routine_privileges
-- antes/depois). Revalidacao live: PENDENTES de USUARIO_INATIVO_COM_
-- PRODUCAO no sistema inteiro caiu de 3 para 2 (Cristina Jane dos Santos e
-- Fabio Donizete de Oliveira Franca, ambos com ativo=false confirmado --
-- controles negativos corretos, alertas semanticamente verdadeiros e
-- preservados). O alerta stale pre-existente do Herbert (id 1c5ecd10-...)
-- foi tratado separadamente, uma unica vez, com a mesma semantica da nova
-- regra (nao e coberto retroativamente pela correcao estrutural, que so
-- atua em novas transicoes ativo=false->true).
--
-- Corpo abaixo e o LIVE atual, ja promovido e revalidado -- pg_get_functiondef()
-- confirmado identico ao candidato testado.

CREATE OR REPLACE FUNCTION public.concluir_continuacao_primeiro_acesso(p_token_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_convite public.convites_usuario%rowtype;
  v_usuario public.usuarios%rowtype;
  v_updated integer;
  v_alertas_resolvidos integer := 0;
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

  -- Incidente pos-Herbert -- a condicao de USUARIO_INATIVO_COM_PRODUCAO
  -- acabou de deixar de ser verdadeira (usuarios.ativo agora e true).
  -- Escopo deliberadamente estreito: NAO reaproveita portal_reconcile_
  -- user_facts (essa exige is_master() e resolveria qualquer tipo de
  -- alerta PENDENTE do mesmo CPF/NBS, incluindo NBS_DIVERGENTE, LOJA_
  -- DIVERGENTE etc., que a conclusao do primeiro acesso nao comprova).
  update public.portal_cadastro_alertas a
  set status = 'RESOLVIDO', resolvido_por = v_usuario.id, resolvido_em = now(), atualizado_em = now(),
      motivo_acao = 'Reconciliado automaticamente: usuário concluiu primeiro acesso (ativo=true).'
  where a.status = 'PENDENTE'
    and a.tipo = 'USUARIO_INATIVO_COM_PRODUCAO'
    and a.identificador_tipo = 'CPF'
    and a.identificador_valor = v_usuario.cpf_normalizado;
  get diagnostics v_alertas_resolvidos = row_count;
  if v_alertas_resolvidos > 0 then
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_em)
    values (
      'ALERTA_RESOLVIDO_AUTOMATICO',
      format('%s alerta(s) USUARIO_INATIVO_COM_PRODUCAO resolvido(s) automaticamente: %s concluiu primeiro acesso.', v_alertas_resolvidos, v_usuario.nome),
      'RPC concluir_continuacao_primeiro_acesso', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, now()
    );
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

CREATE OR REPLACE FUNCTION public.concluir_convite_usuario()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_usuario public.usuarios;
  v_alertas_resolvidos integer := 0;
begin
  update public.usuarios
     set ativo = true,
         primeiro_acesso = false,
         senha_alterada_em = now()
   where auth_user_id = auth.uid()
  returning * into v_usuario;

  if v_usuario.id is null then
    raise exception 'Convite não localizado para este usuário.' using errcode = '42501';
  end if;

  -- Incidente pos-Herbert -- mesmo patch aplicado em
  -- concluir_continuacao_primeiro_acesso: a condicao de USUARIO_INATIVO_
  -- COM_PRODUCAO acabou de deixar de ser verdadeira. Escopo estreito de
  -- proposito (ver comentario irmao no outro fluxo de conclusao).
  update public.portal_cadastro_alertas a
  set status = 'RESOLVIDO', resolvido_por = v_usuario.id, resolvido_em = now(), atualizado_em = now(),
      motivo_acao = 'Reconciliado automaticamente: usuário concluiu primeiro acesso (ativo=true).'
  where a.status = 'PENDENTE'
    and a.tipo = 'USUARIO_INATIVO_COM_PRODUCAO'
    and a.identificador_tipo = 'CPF'
    and a.identificador_valor = v_usuario.cpf_normalizado;
  get diagnostics v_alertas_resolvidos = row_count;
  if v_alertas_resolvidos > 0 then
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido, resolvido_em)
    values (
      'ALERTA_RESOLVIDO_AUTOMATICO',
      format('%s alerta(s) USUARIO_INATIVO_COM_PRODUCAO resolvido(s) automaticamente: %s concluiu primeiro acesso.', v_alertas_resolvidos, v_usuario.nome),
      'RPC concluir_convite_usuario', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true, now()
    );
  end if;

  update public.convites_usuario
     set status = 'ACEITO', aceito_em = now(), atualizado_em = now()
   where usuario_id = v_usuario.id and status in ('PENDENTE', 'ENVIADO');

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('CONVITE_ACEITO', format('Primeiro acesso concluído por %s', v_usuario.nome),
    'Portal F&I', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true);

  return jsonb_build_object('ok', true, 'nome', v_usuario.nome, 'perfil', v_usuario.perfil);
end;
$function$;

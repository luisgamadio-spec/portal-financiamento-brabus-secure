-- Incidente 19.2 — nova RPC: renovação segura do token de continuação para
-- ativações já em EMAIL_VERIFICADO.
--
-- CAUSA RAIZ: o fluxo de continuação (confirmar e-mail → definir senha)
-- nunca foi desenhado para virar um link independente — o token de
-- continuação nasce e é consumido na MESMA navegação (verificar-acesso.html
-- → index.html#continuar=...), expirando em 30 minutos. Quando o usuário
-- confirma o e-mail mas não conclui a troca de senha na mesma sessão
-- (aba fechada, interrupção, etc.), a ativação fica presa em
-- EMAIL_VERIFICADO com o token de continuação expirado e SEM NENHUM
-- caminho de recuperação: activation_create_request recusa reabrir
-- (por desenho — nunca "esquece" que o e-mail já foi verificado) e
-- activation_prepare_complete exige um token de continuação ainda válido.
--
-- Esta função preenche exatamente essa lacuna: gera um NOVO token de
-- continuação para a MESMA ativação, sem tocar em status, verificado_em,
-- token_hash/expira_em (do e-mail) ou email_novo — a máquina de estados
-- continua refletindo exatamente o que já aconteceu (e-mail já verificado,
-- nunca reaberto). Default deny: só age se a ativação mais recente do CPF
-- estiver, agora mesmo, em EMAIL_VERIFICADO com continuação não consumida.

create or replace function public.activation_renew_continuation(p_cpf text, p_continuacao_token_hash text, p_continuacao_expira_em timestamp with time zone)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf,''), '\D', '', 'g');
  v_usuario public.usuarios%rowtype;
  v_existente public.ativacoes_acesso_usuario%rowtype;
  v_updated integer;
begin
  if length(v_cpf) <> 11 then
    return jsonb_build_object('ok', false, 'codigo', 'CPF_INVALIDO');
  end if;
  if p_continuacao_token_hash is null or trim(p_continuacao_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'ERRO_INTERNO');
  end if;
  if p_continuacao_expira_em is null then
    return jsonb_build_object('ok', false, 'codigo', 'ERRO_INTERNO');
  end if;

  select u.* into v_usuario from public.usuarios u where u.cpf_normalizado = v_cpf limit 1;
  if v_usuario.id is null or v_usuario.ativo is not true then
    return jsonb_build_object('ok', false, 'codigo', 'NAO_ELEGIVEL');
  end if;

  -- Mesma regra de "ativação atual" das demais funções do fluxo: sempre a
  -- mais recente do usuário, nunca uma linha antiga/histórica.
  select * into v_existente
  from public.ativacoes_acesso_usuario aa
  where aa.usuario_id = v_usuario.id
  order by aa.criado_em desc
  limit 1;

  if v_existente.id is null or v_existente.status <> 'EMAIL_VERIFICADO' then
    return jsonb_build_object('ok', false, 'codigo', 'ATIVACAO_EM_ESTADO_NAO_EDITAVEL');
  end if;
  if v_existente.continuacao_consumida_em is not null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_JA_USADO');
  end if;

  update public.ativacoes_acesso_usuario
  set continuacao_token_hash = p_continuacao_token_hash,
      continuacao_expira_em = p_continuacao_expira_em,
      atualizado_em = now()
  where id = v_existente.id
    and status = 'EMAIL_VERIFICADO'
    and continuacao_consumida_em is null;
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENTE');
  end if;

  return jsonb_build_object('ok', true, 'codigo', 'OK', 'ativacao_id', v_existente.id, 'email_novo', v_existente.email_novo);
end;
$function$;

-- Reversão de 20261007210000_activation_finalize_sem_revisoes.sql: texto exato antes da mudança (07/10/2026).
CREATE OR REPLACE FUNCTION public.activation_finalize(p_continuacao_token_hash text)
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
  -- Incidente Seguranca-de-Ativacao-1.0: a versao anterior recebia
  -- p_ativacao_id (um UUID opaco, sem relacao com prova de posse do
  -- token) -- IDOR comprovado: sessao A conseguia finalizar a ativacao de
  -- B só por saber/adivinhar o id de B, porque status='AUTH_OK_USUARIOS_
  -- PENDENTE' e uma condicao necessaria mas NAO suficiente (nada
  -- amarrava CHAMADOR a QUAL ativacao ele de fato conduziu pelo prepare).
  -- UUID nao e autorizacao.
  --
  -- Agora a funcao so aceita o proprio continuacao_token_hash -- a MESMA
  -- prova de posse do token que activation_prepare_complete ja exige para
  -- destravar a ativacao (EMAIL_VERIFICADO -> ATIVANDO). Esse hash tem
  -- UNIQUE INDEX (ativacoes_acesso_usuario_continuacao_token_hash_uk,
  -- WHERE NOT NULL) e nunca e limpo/alterado depois de
  -- activation_confirm_email gerar o valor (activation_renew_continuation
  -- so pode rotacionar enquanto ainda esta em EMAIL_VERIFICADO e nao
  -- consumido) -- ou seja, no momento em que finalize e chamavel
  -- (status=AUTH_OK_USUARIOS_PENDENTE), o hash da linha e estavel e e
  -- exatamente o mesmo valor que o chamador legitimo (que tem o
  -- continuationToken original) recalcula deterministicamente (SHA-256)
  -- a cada tentativa/retomada -- inclusive no fluxo AGUARDANDO_
  -- FINALIZACAO, sem exigir nenhuma mudanca no contrato do cliente
  -- (continuationToken + senha continuam sendo os unicos dados que o
  -- Portal envia). Mesmo padrao ja usado pela funcao irma
  -- concluir_continuacao_primeiro_acesso, que sempre buscou pela propria
  -- hash, nunca por um id repassado a parte.
  --
  -- Nao usa auth.uid() (fluxo e pre-autenticacao por desenho -- nao ha
  -- sessao Supabase ainda neste ponto) e nao adiciona nenhuma superfice
  -- publica nova: grants continuam exclusivos de postgres/service_role.
  if p_continuacao_token_hash is null or trim(p_continuacao_token_hash) = '' then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
  end if;

  select * into v_row from public.ativacoes_acesso_usuario
  where continuacao_token_hash = p_continuacao_token_hash
  limit 1;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'TOKEN_INVALIDO');
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

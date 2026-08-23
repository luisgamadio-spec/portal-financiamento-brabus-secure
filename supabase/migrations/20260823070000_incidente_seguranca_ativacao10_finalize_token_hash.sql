-- Incidente: Seguranca de Ativacao 1.0 -- activation_finalize, defesa em
-- profundidade contra IDOR.
--
-- Achado (Incidente Integridade Cadastral 1.0, gate de seguranca): a
-- versao anterior de activation_finalize(p_ativacao_id uuid) aceitava
-- qualquer UUID de ativacao sem nenhuma prova de que o chamador de fato
-- conduziu AQUELA ativacao pelo fluxo de prepare correspondente. Provado
-- em fixture: sessao A conseguia chamar activation_finalize(id de B) e
-- alterar loja/login_nbs/email_auth de B. Nao explorável hoje por
-- anon/authenticated (grants ja restritos a postgres/service_role, e o
-- unico caller real -- Edge Function activation-complete -- nunca
-- repassa um id vindo do cliente), mas sem defesa em profundidade: um
-- erro de sequenciamento no proprio caller privilegiado, ou um novo
-- caller futuro descuidado, exporia o mesmo id-swap.
--
-- Correcao: muda a assinatura para (p_continuacao_token_hash text). O
-- hash da ativacao (ativacoes_acesso_usuario.continuacao_token_hash) ja
-- e a MESMA prova de posse do token que activation_prepare_complete
-- exige para destravar a ativacao (EMAIL_VERIFICADO -> ATIVANDO), tem
-- UNIQUE INDEX (ativacoes_acesso_usuario_continuacao_token_hash_uk,
-- WHERE NOT NULL) e permanece estavel depois de gravado (nunca zerado;
-- so pode ser rotacionado por activation_renew_continuation enquanto a
-- ativacao ainda esta em EMAIL_VERIFICADO e nao consumida) -- ou seja,
-- exatamente estavel durante toda a janela em que finalize pode ser
-- chamada (status=AUTH_OK_USUARIOS_PENDENTE). O chamador legitimo
-- recalcula esse hash deterministicamente (SHA-256) a partir do MESMO
-- continuationToken que o cliente ja envia -- nenhuma mudanca de
-- contrato com o Portal, nenhum auth.uid() em fluxo pre-autenticacao,
-- nenhuma superficie publica nova. Mesmo padrao ja usado pela funcao
-- irma concluir_continuacao_primeiro_acesso, que sempre buscou pela
-- propria hash, nunca por um id repassado a parte.
--
-- Propriedade de seguranca provada em ROLLBACK (10 cenarios, incluindo 3
-- ativacoes simultaneas de usuarios distintos): uma autorizacao para A
-- nunca pode ser usada para finalizar B, replay e idempotente-seguro
-- (sem duplicar revisao/auditoria), token vazio/invalido/inexistente
-- falha com seguranca, e o fluxo legitimo A->A continua funcionando
-- identico (mesma reconciliacao de login_nbs, mesmas revisoes
-- cadastrais).
--
-- CREATE OR REPLACE nao troca assinatura de funcao -- precisa DROP
-- explicito da versao antiga primeiro. Grants NAO sao herdados por uma
-- funcao com assinatura diferente (nem do Postgres, que concede EXECUTE
-- a PUBLIC por padrao em funcao nova, nem dos default privileges deste
-- projeto Supabase no schema public, que concedem a anon/authenticated
-- diretamente -- mesmo padrao ja corrigido antes em
-- portal_reconcile_user_facts_core, commit 2da53b2) -- por isso os
-- REVOKEs explicitos abaixo, confirmados empiricamente necessarios antes
-- de aplicar.
--
-- Nao altera portal_reconcile_user_facts_core, os importadores
-- Sales/Finance, o indice UNIQUE de cpf_normalizado, nem
-- activation_prepare_complete/activation_mark_auth_ok/activation_revert_
-- after_auth_failure (fora de escopo deste incidente -- mesma classe
-- teorica de id-sem-hash, registrada como observacao separada, nao
-- corrigida aqui).

-- Muda a assinatura de (p_ativacao_id uuid) para (p_continuacao_token_hash
-- text) -- CREATE OR REPLACE nao troca assinatura, precisa DROP explicito
-- da funcao antiga primeiro. Grants nao sao herdados por uma funcao com
-- assinatura diferente -- precisam ser reconcedidos explicitamente abaixo.
DROP FUNCTION IF EXISTS public.activation_finalize(uuid);

CREATE FUNCTION public.activation_finalize(p_continuacao_token_hash text)
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

-- CRITICO: tanto o padrao do Postgres (EXECUTE a PUBLIC em toda funcao
-- nova) quanto os default privileges deste projeto Supabase no schema
-- public (que concedem EXECUTE a anon/authenticated diretamente, nao so
-- via PUBLIC -- mesmo padrao ja corrigido antes em
-- portal_reconcile_user_facts_core, commit 2da53b2) se aplicam de novo
-- porque o DROP+CREATE cria uma funcao NOVA (assinatura diferente), que
-- nao herda os grants customizados da funcao antiga. Confirmado
-- empiricamente: sem os REVOKEs abaixo, anon e authenticated apareciam
-- com EXECUTE mesmo depois do REVOKE ALL FROM PUBLIC isolado -- exatamente
-- a superficie que este incidente existe para fechar.
REVOKE ALL ON FUNCTION public.activation_finalize(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activation_finalize(text) FROM anon;
REVOKE ALL ON FUNCTION public.activation_finalize(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.activation_finalize(text) TO postgres;
GRANT EXECUTE ON FUNCTION public.activation_finalize(text) TO service_role;

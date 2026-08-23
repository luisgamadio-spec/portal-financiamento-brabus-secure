-- Incidente: Integridade Cadastral 2.0 -- CPF Normalizado Duplicado (Patch B1)
-- Complemento ao Patch B (20260823050000, indice UNIQUE em cpf_normalizado).
-- Migration separada e sequenciada DEPOIS de Patch B de proposito: este
-- tratamento so faz sentido com o indice ja existente (a constraint que
-- ele detecta especificamente por nome so existe apos o Patch B rodar).
--
-- Achado ao validar o Patch B contra o caminho real de provisionamento
-- manual: master_provisionar_usuario normaliza o CPF recebido para
-- so-digitos ANTES de gravar/conflitar (ON CONFLICT (cpf), sobre o texto
-- BRUTO). Isso o protege contra chamadas repetidas de si mesmo com
-- formatacao diferente (sempre grava so-digitos). Mas se o usuario ja
-- existir por um caminho que PRESERVA a formatacao original com pontuacao
-- (como master_convidar_usuario, que grava p_cpf tal como foi digitado),
-- o ON CONFLICT (cpf) nao encontra a linha (textos brutos diferentes) e o
-- INSERT tenta prosseguir -- sendo barrado pelo indice UNIQUE do Patch B,
-- mas com um erro SQL tecnico bruto (23505, nome da constraint) exposto
-- diretamente ao operador Master.
--
-- Este patch NAO enfraquece nem contorna o indice -- ele continua sendo a
-- autoridade final de integridade (nao ha pre-check, apenas a captura da
-- excecao que o proprio INSERT atomico ja gera, sem janela de race
-- condition). So traduz especificamente a violacao do indice de CPF
-- normalizado (usuarios_cpf_normalizado_unique_idx, verificado por nome
-- via GET STACKED DIAGNOSTICS) para a mesma mensagem amigavel que
-- master_convidar_usuario ja usa para o mesmo cenario ("Já existe um
-- usuário cadastrado com este CPF."). Qualquer outra unique_violation
-- (email_auth, etc.) propaga inalterada -- nunca traduzida
-- indiscriminadamente.
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
$function$
;

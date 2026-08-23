-- Incidente Identidade-Operacional-2.0, Patch B (onboarding).
--
-- Achado: portal_reconcile_user_facts(p_usuario_id) exige is_master() --
-- correto para o botao manual do Painel Master, mas isso significa que
-- NENHUM fluxo self-service (o proprio usuario concluindo primeiro acesso)
-- pode chama-la diretamente: o auth.uid() dentro da chamada aninhada
-- continua sendo o usuario comum, nao um Master, e a checagem falharia.
-- E exatamente por isso que o fix "pos-Herbert" em concluir_convite_usuario
-- e concluir_continuacao_primeiro_acesso implementou um bloco estreito
-- (so resolve o alerta USUARIO_INATIVO_COM_PRODUCAO) em vez de reconciliar
-- os FATOS (portal_sales/portal_finance_operations) -- o autor evitou
-- deliberadamente a rota que checa is_master().
--
-- Correcao: extrair a logica de portal_reconcile_user_facts para uma
-- funcao interna SEM o gate de is_master() (portal_reconcile_user_facts_core),
-- e transformar a RPC publica em um wrapper fino que so adiciona a
-- checagem de autorizacao. Isso preserva 100% do comportamento/assinatura/
-- auditoria da RPC publica (usada pelo botao manual do Master e pela
-- reconciliacao controlada ja executada no Incidente P1 Fase 1) e permite
-- que os fluxos self-service chamem o core diretamente -- eles ja tem seu
-- proprio limite de autorizacao (o proprio convite/token so alcanca o
-- usuario a que pertence, nunca um usuario arbitrario).
--
-- Efeito colateral esperado (e correto): como o core resolve QUALQUER
-- alerta PENDENTE cujo identificador bate deterministicamente (nao so
-- USUARIO_INATIVO_COM_PRODUCAO), concluir_convite_usuario/concluir_
-- continuacao_primeiro_acesso passam a resolver tambem, por exemplo,
-- NBS_DIVERGENTE do mesmo CPF -- testado e confirmado que alertas de
-- OUTRO identificador permanecem PENDENTE (nao ha resolucao cega em lote).
--
-- master_provisionar_usuario (unico fluxo puramente Master-driven que
-- ativava sem reconciliar nada, inclusive na reativacao via ON CONFLICT)
-- chama o core diretamente, sem nova checagem de is_master() (o caller ja
-- e Master, verificado no topo da propria funcao).
--
-- Testado em ROLLBACK (nenhum dado de producao alterado): fixture Fabio-
-- class (fato orfao + alerta NOVO_CADASTRO_NECESSARIO resolvidos no
-- provisionamento), fixture Herbert-class (fluxo self-service via convite,
-- fato antes so tinha o alerta USUARIO_INATIVO_COM_PRODUCAO resolvido, agora
-- o FATO tambem e vinculado), preservacao de alerta de outro identificador,
-- idempotencia (segunda chamada e no-op, sem duplicar auditoria).
--
-- Achado adjacente (fora de escopo -- este patch cobre apenas transicoes
-- ativo=false->true; apenas reportado no RELATORIO FINAL):
-- master_corrigir_revisao_cadastral e master_cadastro_alerta_corrigir_
-- login_nbs alteram login_nbs de um usuario JA ATIVO sem re-executar
-- reconciliacao -- um fato antes SEM_MATCH pode passar a ser elegivel a
-- NBS_FALLBACK apos a correcao e ficar orfao ate um clique manual no botao
-- do Painel Master.

CREATE OR REPLACE FUNCTION public.portal_reconcile_user_facts_core(p_usuario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_usuario public.usuarios%rowtype;
  v_cpf text;
  v_nbs text;
  v_sales_cpf integer := 0;
  v_finance_cpf integer := 0;
  v_sales_nbs integer := 0;
  v_finance_nbs integer := 0;
  v_actor_nome text;
begin
  -- Rele tudo fresh do banco -- nunca confia em CPF/NBS passados por fora.
  select * into v_usuario from public.usuarios where id = p_usuario_id;
  if v_usuario.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_ENCONTRADO');
  end if;

  v_cpf := v_usuario.cpf_normalizado;
  v_nbs := nullif(upper(trim(coalesce(v_usuario.login_nbs, ''))), '');

  with alvo as (
    select s.id from public.portal_sales s
    where s.seller_user_id is null
      and s.seller_cpf_normalizado = v_cpf
      and not exists (
        select 1 from public.portal_cadastro_excecoes e
        where e.ativo = true and e.identificador_tipo = 'CPF' and e.identificador_valor = v_cpf
      )
  )
  update public.portal_sales s set seller_user_id = p_usuario_id
  from alvo where s.id = alvo.id;
  get diagnostics v_sales_cpf = row_count;

  with alvo as (
    select f.id from public.portal_finance_operations f
    where f.seller_user_id is null
      and f.seller_cpf_normalizado = v_cpf
      and not exists (
        select 1 from public.portal_cadastro_excecoes e
        where e.ativo = true and e.identificador_tipo = 'CPF' and e.identificador_valor = v_cpf
      )
  )
  update public.portal_finance_operations f set seller_user_id = p_usuario_id
  from alvo where f.id = alvo.id;
  get diagnostics v_finance_cpf = row_count;

  if v_nbs is not null then
    with alvo as (
      select s.id from public.portal_sales s
      where s.seller_user_id is null
        and s.seller_cpf_normalizado is null
        and upper(trim(coalesce(s.seller_nbs, ''))) = v_nbs
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'NBS' and e.identificador_valor = v_nbs
        )
    )
    update public.portal_sales s set seller_user_id = p_usuario_id
    from alvo where s.id = alvo.id;
    get diagnostics v_sales_nbs = row_count;

    with alvo as (
      select f.id from public.portal_finance_operations f
      where f.seller_user_id is null
        and f.seller_cpf_normalizado is null
        and upper(trim(coalesce(f.seller_nbs, ''))) = v_nbs
        and not exists (
          select 1 from public.portal_cadastro_excecoes e
          where e.ativo = true and e.identificador_tipo = 'NBS' and e.identificador_valor = v_nbs
        )
    )
    update public.portal_finance_operations f set seller_user_id = p_usuario_id
    from alvo where f.id = alvo.id;
    get diagnostics v_finance_nbs = row_count;
  end if;

  update public.portal_cadastro_alertas a
  set status = 'RESOLVIDO', resolvido_por = v_usuario.id, resolvido_em = now(), atualizado_em = now(),
      motivo_acao = 'Reconciliado automaticamente após cadastro do usuário correspondente.'
  where a.status = 'PENDENTE'
    and (
      (a.identificador_tipo = 'CPF' and a.identificador_valor = v_cpf)
      or (v_nbs is not null and a.identificador_tipo = 'NBS' and a.identificador_valor = v_nbs)
    );

  if (v_sales_cpf + v_finance_cpf + v_sales_nbs + v_finance_nbs) > 0 then
    select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();
    insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
    values (
      'FATOS_RECONCILIADOS_USUARIO',
      format('%s venda(s) e %s financiamento(s) vinculados a %s ao ser cadastrado (CPF: %s+%s, NBS fallback: %s+%s) — disparado por %s',
        v_sales_cpf, v_finance_cpf, v_usuario.nome, v_sales_cpf, v_finance_cpf, v_sales_nbs, v_finance_nbs,
        coalesce(v_actor_nome, '—')),
      'RPC portal_reconcile_user_facts_core', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'codigo', 'RECONCILIADO',
    'sales_cpf', v_sales_cpf, 'finance_cpf', v_finance_cpf,
    'sales_nbs', v_sales_nbs, 'finance_nbs', v_finance_nbs
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.portal_reconcile_user_facts_core(uuid) FROM PUBLIC, anon;

-- portal_reconcile_user_facts (publica, botao Master) vira wrapper fino:
-- mesma assinatura, mesmo comportamento observavel, unica mudanca e que a
-- logica agora vive no core compartilhado.
CREATE OR REPLACE FUNCTION public.portal_reconcile_user_facts(p_usuario_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;
  return public.portal_reconcile_user_facts_core(p_usuario_id);
end;
$function$;

REVOKE ALL ON FUNCTION public.portal_reconcile_user_facts(uuid) FROM PUBLIC, anon;

-- concluir_convite_usuario: ativa o usuario e agora reconcilia FATOS (nao
-- so o alerta USUARIO_INATIVO_COM_PRODUCAO) -- fecha a mesma classe de gap
-- de Fabio/Herbert para quem completa o primeiro acesso via convite direto.
CREATE OR REPLACE FUNCTION public.concluir_convite_usuario()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_usuario public.usuarios;
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

  -- Incidente Identidade-Operacional-2.0, Patch B: substitui o bloco
  -- estreito "pos-Herbert" (que so resolvia o alerta) pela reconciliacao
  -- completa de fatos -- o proprio portal_reconcile_user_facts_core ja
  -- resolve, deterministicamente, qualquer alerta PENDENTE cujo
  -- identificador (CPF ou NBS) bate com este cadastro, incluindo
  -- USUARIO_INATIVO_COM_PRODUCAO.
  perform public.portal_reconcile_user_facts_core(v_usuario.id);

  update public.convites_usuario
     set status = 'ACEITO', aceito_em = now(), atualizado_em = now()
   where usuario_id = v_usuario.id and status in ('PENDENTE', 'ENVIADO');

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('CONVITE_ACEITO', format('Primeiro acesso concluído por %s', v_usuario.nome),
    'Portal F&I', v_usuario.nome, v_usuario.cpf, v_usuario.loja, true);

  return jsonb_build_object('ok', true, 'nome', v_usuario.nome, 'perfil', v_usuario.perfil);
end;
$function$;

-- concluir_continuacao_primeiro_acesso: mesmo fix, mesma justificativa,
-- mesmo efeito espelhado documentado no comentario original da funcao.
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

  if v_usuario.ativo or not v_usuario.primeiro_acesso then
    update public.convites_usuario
    set continuacao_consumida_em = now()
    where id = v_convite.id and continuacao_consumida_em is null;
    return jsonb_build_object('ok', false, 'codigo', 'JA_CONCLUIDO');
  end if;

  update public.usuarios
  set ativo = true, primeiro_acesso = false, senha_alterada_em = now()
  where id = v_usuario.id and ativo = false and primeiro_acesso = true
  returning * into v_usuario;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  -- Incidente Identidade-Operacional-2.0, Patch B: mesmo fix do irmao
  -- concluir_convite_usuario -- reconcilia fatos, nao so o alerta.
  perform public.portal_reconcile_user_facts_core(v_usuario.id);

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

-- master_provisionar_usuario: unico caminho que ativava (criacao OU
-- reativacao via ON CONFLICT) sem qualquer reconciliacao. O caller ja e
-- Master (checado no topo da propria funcao), entao chama o core
-- diretamente -- sem necessidade de checar is_master() de novo.
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

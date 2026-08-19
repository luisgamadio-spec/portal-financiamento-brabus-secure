-- Fase 21.6 -- aposentadoria operacional da Base COLABORADORES/portal_sellers
-- como requisito para novos vendedores. usuarios.login_nbs passa a ser a
-- fonte de verdade para Login NBS -- exatamente o que a Fase 21.3 JA usa
-- para resolver seller_user_id (confirmado fresh nesta fase: o join de
-- reconciliacao e "upper(trim(u.login_nbs)) = nbs_do_fato and u.ativo=true",
-- ZERO referencia a portal_sellers nesse match). Prova estrutural real:
-- Erica Caetano Cenzi, Jose Carlos Amancio Filho, Renan Guedes de Paiva e
-- Richard Wagner ja tem vendas/financiamentos resolvidos via seller_user_id
-- HOJE, sem nenhuma linha portal_sellers vinculada (portal_user_id nunca
-- setado para eles) -- a arquitetura alvo desta fase ja funciona em
-- producao para 4 pessoas reais, so a RPC de convite/correcao ainda nao
-- foi alinhada a ela.
--
-- Causa raiz encontrada (Parte D fresh): master_convidar_usuario() so
-- aceita um Login NBS se ele JA existir em portal_sellers -- "Login NBS
-- nao encontrado no cadastro de vendedores" (P0002) -- e mesmo quando
-- aceita, NUNCA grava usuarios.login_nbs (so vincula portal_sellers.
-- portal_user_id de volta). Um vendedor genuinamente novo, sem nenhuma
-- linha portal_sellers previa, nao conseguia ter seu NBS aceito de jeito
-- nenhum -- exatamente o "Exemplo de Aceite" que este incidente pede para
-- corrigir. Mesmo padrao (Parte J) encontrado em
-- master_corrigir_revisao_cadastral() para o campo LOGIN_NBS.
--
-- Escopo desta migration (Parte AF: parte critica -- persistencia de CPF
-- bruto nos fatos para reconciliacao pos-cadastro via CPF -- NAO esta
-- incluida aqui; portal_sales/portal_finance_operations nao tem coluna
-- de CPF hoje, so seller_nbs/seller_source_name; isso exige alterar os
-- importadores ja homologados da Fase 21.3, tratado separadamente na
-- Fase 21.6B para nao misturar risco). Aqui: SOMENTE o caminho de
-- cadastro/correcao de NBS deixa de depender de portal_sellers.
--
-- portal_sellers permanece intocado como historico/enriquecimento
-- best-effort (Parte B/C do prompt original) -- nenhuma linha
-- apagada/alterada por esta migration, e o vinculo portal_user_id
-- continua sendo preenchido quando uma linha correspondente ja existir,
-- so deixa de ser OBRIGATORIO.

-- =========================================================================
-- PARTE H -- unicidade de Login NBS entre usuarios ativos (auditoria
-- previa confirmou populacao limpa: 27 preenchidos, 0 duplicados apos
-- normalizacao upper(trim(...)) -- seguro criar indice agora).
-- =========================================================================

create unique index if not exists usuarios_login_nbs_ativo_uk
  on public.usuarios (upper(trim(login_nbs)))
  where ativo = true and login_nbs is not null and trim(login_nbs) <> '';

-- =========================================================================
-- PARTE D/E/F/G/K -- master_convidar_usuario(): usuarios.login_nbs passa a
-- ser gravado diretamente e validado por unicidade entre usuarios ativos.
-- portal_sellers deixa de ser requisito -- so recebe o vinculo
-- portal_user_id quando uma linha com o mesmo NBS ja existir (enriquecimento
-- best-effort, nunca bloqueio). Mudanca minima: nenhuma outra validacao
-- (CPF/e-mail/perfil/loja/departamento), nenhum outro campo do INSERT,
-- nenhuma linha de convites_usuario/auditoria alterada.
-- =========================================================================

create or replace function public.master_convidar_usuario(
  p_cpf text, p_nome text, p_perfil text, p_loja text, p_email text,
  p_nbs text default null::text, p_status text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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

  -- Fase 21.6 -- usuarios.login_nbs e a autoridade (mesmo campo que a
  -- reconciliacao da Fase 21.3 ja usa). portal_sellers passa a ser
  -- consultado só para enriquecimento best-effort: uma linha
  -- correspondente, se existir, e vinculada de volta (mesmo comportamento
  -- de antes); se NAO existir, o cadastro segue normalmente -- nunca mais
  -- bloqueia um vendedor genuinamente novo.
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

  -- cpf_normalizado é coluna GERADA (normalizar_cpf(cpf)) — nunca inserir
  -- valor nela diretamente, o Postgres calcula sozinho a partir de "cpf".
  insert into public.usuarios (cpf, nome, perfil, loja, status, email_auth, login_nbs, ativo, primeiro_acesso)
  values (p_cpf, v_nome, v_perfil, v_loja, v_status, v_email, v_nbs, false, true)
  returning id into v_usuario_id;

  -- Enriquecimento best-effort (Parte C) -- so roda quando ja existir uma
  -- linha legada com o mesmo NBS; nunca é pré-condição da criação acima.
  if v_nbs is not null and v_seller.id is not null then
    update public.portal_sellers
       set portal_user_id = v_usuario_id, updated_at = now()
     where id = v_seller.id;
  end if;

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

-- Nenhum GRANT explicito aqui de proposito: CREATE OR REPLACE preserva o
-- ACL existente (confirmado repetidamente ao longo deste projeto). O
-- grant original desta funcao (incidente121) incluia PUBLIC/anon, mas a
-- Fase 20.1 (hardening) ja revogou isso -- reemitir aquele grant antigo
-- reabriria exatamente o buraco que a 20.1 fechou. anon_exec=false e
-- authenticated_exec=true confirmados fresh antes desta migration.

-- =========================================================================
-- PARTE J/K -- master_corrigir_revisao_cadastral(): mesmo alinhamento para
-- o campo LOGIN_NBS (fluxo de Revisoes Cadastrais). Mudanca minima:
-- somente o ramo "elsif v_revisao.campo = 'LOGIN_NBS'" muda; ramo LOJA e
-- todo o resto da funcao ficam byte-identicos.
-- =========================================================================

create or replace function public.master_corrigir_revisao_cadastral(
  p_revisao_id uuid, p_valor_correto text, p_observacao text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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
    -- Fase 21.6 -- usuarios.login_nbs é a autoridade de unicidade (mesmo
    -- campo usado pela reconciliação da Fase 21.3); portal_sellers só
    -- entra como checagem de consistência best-effort quando já existir
    -- linha legada com o mesmo NBS -- nunca mais exige que a linha exista.
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
    -- Fase 4.3: só grava usuarios.login_nbs. NÃO vincula
    -- portal_sellers.portal_user_id — decisão operacional separada
    -- (Checkpoint 14, preservada).
    update public.usuarios set login_nbs = v_valor, atualizado_em = now() where id = v_usuario.id;

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
$function$;

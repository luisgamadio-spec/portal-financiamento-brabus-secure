-- Incidente 12.1 (Parte A) — adiciona classificação de departamento
-- (NOVOS/SEMINOVOS/NOVOS+SEMINOVOS) ao fluxo de convite de usuário.
--
-- Achado do Incidente 12.0: master_convidar_usuario() nunca preenchia
-- usuarios.status. Para VENDEDOR/GERENTE/ANALISTA, operational_current_scope()
-- deriva departamento de status por pattern-matching de texto — sem
-- status, o array de departamentos resolve vazio, quebrando
-- silenciosamente o acesso operacional de qualquer novo usuário
-- desses perfis. Só não apareceu antes porque o único caso real até
-- agora (Rodrigo, Incidente 11.0-11.2) é DIRETOR NOVOS, perfil cujo
-- departamento é derivado do próprio literal do perfil, não do status.
--
-- Valores canônicos usados (Checkpoint A2, extraídos dos dados reais
-- já existentes, não inventados): 'NOVOS', 'SEMINOVOS',
-- 'NOVOS/SEMINOVOS'. MASTER usa status='MASTER' (padrão real já
-- existente nas 3 linhas de MASTER em produção).
--
-- Testado exaustivamente antes de promover: candidata separada
-- (master_convidar_usuario_candidate_1210), 10 casos de contrato via
-- transação com ROLLBACK (VENDEDOR/GERENTE/ANALISTA com os 3
-- departamentos válidos + rejeição quando NULL; DIRETOR NOVOS/SEMINOVOS
-- com departamento correto e com tentativa de valor divergente —
-- confirmado que o servidor NORMALIZA para o valor correto do perfil,
-- nunca aceita o que o cliente mandar) + 7 casos de
-- operational_current_scope()/portal_modulos_permitidos() via UUID
-- sintético em transação com ROLLBACK, provando que o departamento
-- persistido é corretamente resolvido pelas RPCs operacionais e pela
-- matriz dinâmica. Zero linha real persistida nos testes.
--
-- A assinatura da função muda (novo parâmetro p_status ao final, com
-- default null) — por isso não é um simples CREATE OR REPLACE: a
-- versão antiga (6 argumentos) precisa ser removida explicitamente
-- para não conviver como uma segunda sobrecarga que ignoraria a nova
-- validação. Grants reemitidos idênticos aos que a função já tinha
-- (PUBLIC, anon, authenticated, postgres, service_role — enforcement
-- de MASTER-only continua sendo feito dentro do corpo da função,
-- padrão pré-existente, não alterado por esta migration).
--
-- portal_sellers NÃO é tocado por esta mudança — continua recebendo
-- somente o vínculo portal_user_id já existente, via Login NBS.

drop function public.master_convidar_usuario(text,text,text,text,text,text);

create function public.master_convidar_usuario(
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

  -- Checkpoint A3/A10 — departamento obrigatório e validado server-side
  -- para VENDEDOR/GERENTE/ANALISTA; nunca confiar apenas no frontend.
  if v_perfil = any(v_perfis_status_obrigatorio) then
    if v_status is null or not (v_status = any(v_status_validos)) then
      raise exception 'Selecione o departamento (Novos, Seminovos ou Novos/Seminovos) para este perfil.' using errcode = '22023';
    end if;
  -- Checkpoint A4/A10 — Diretor: departamento resolvido pelo próprio
  -- perfil, sempre normalizado no servidor (o que vier do cliente é
  -- ignorado/substituído, nunca rejeitado — o campo nem é editável
  -- no frontend, mas o backend não pode depender disso).
  elsif v_perfil = 'DIRETOR NOVOS' then
    v_status := 'NOVOS';
  elsif v_perfil = 'DIRETOR SEMINOVOS' then
    v_status := 'SEMINOVOS';
  -- Checkpoint A5 — MASTER: padrão real já existente na tabela é
  -- status='MASTER' (confirmado nas 3 linhas reais), não NULL nem
  -- 'NOVOS/SEMINOVOS'. Segue o padrão já em produção.
  elsif v_perfil = 'MASTER' then
    v_status := 'MASTER';
  -- Checkpoint A6 — RH/RECURSOS HUMANOS: sem departamento operacional
  -- aplicável hoje (nenhuma RPC auditada depende disso para RH); não
  -- inventa valor, mantém NULL.
  else
    v_status := null;
  end if;

  if exists (select 1 from public.usuarios where cpf_normalizado = v_cpf) then
    raise exception 'Já existe um usuário cadastrado com este CPF.' using errcode = '23505';
  end if;
  if exists (select 1 from public.usuarios where lower(coalesce(email_auth,'')) = v_email) then
    raise exception 'Já existe um usuário cadastrado com este e-mail.' using errcode = '23505';
  end if;

  if v_nbs is not null then
    select * into v_seller from public.portal_sellers where nbs = v_nbs and active limit 1;
    if v_seller.id is null then
      raise exception 'Login NBS não encontrado no cadastro de vendedores.' using errcode = 'P0002';
    end if;
    if v_seller.portal_user_id is not null then
      raise exception 'Este login NBS já está vinculado a outro usuário do portal.' using errcode = '23505';
    end if;
    if v_seller.cpf_normalizado is not null and v_seller.cpf_normalizado <> '' and v_seller.cpf_normalizado <> v_cpf then
      raise exception 'O CPF informado não corresponde ao cadastro deste login NBS.' using errcode = '22023';
    end if;
  end if;

  -- cpf_normalizado é coluna GERADA (normalizar_cpf(cpf)) — nunca inserir
  -- valor nela diretamente, o Postgres calcula sozinho a partir de "cpf".
  -- Checkpoint A11/A12 — só usuarios.status passa a ser gravado; NENHUMA
  -- outra coluna nova, e portal_sellers.status NÃO é tocado (permanece
  -- fonte operacional importada, intocada).
  insert into public.usuarios (cpf, nome, perfil, loja, status, email_auth, ativo, primeiro_acesso)
  values (p_cpf, v_nome, v_perfil, v_loja, v_status, v_email, false, true)
  returning id into v_usuario_id;

  if v_nbs is not null then
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

grant execute on function public.master_convidar_usuario(text,text,text,text,text,text,text) to PUBLIC, anon, authenticated, postgres, service_role;

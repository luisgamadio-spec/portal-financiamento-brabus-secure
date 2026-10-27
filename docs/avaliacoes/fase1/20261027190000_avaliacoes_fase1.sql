-- Avaliações de Seminovos — Fase 1 (27/10/2026)
-- 1) perfil AVALIADOR: constraint + 4 funções existentes (só a lista de perfis / o mapeamento do perfil)
-- 2) objetos novos do módulo (novos.sql)
-- Backup: avaliacoes_fase1_backup_antes.sql | Desfazer: avaliacoes_fase1_desfazer.sql
begin;

do $trava$
begin
  if (select md5(pg_get_functiondef('public.master_convidar_usuario'::regproc)) ) <> '8d3c3b54c5489868f6da10ce1a4a84f6' then
    raise exception 'TRAVA: public.master_convidar_usuario mudou desde o backup -- regenerar a migração';
  end if;
  if (select md5(pg_get_functiondef('public.master_atualizar_autorizacao_usuario'::regproc)) ) <> '5968550b4af15ec960a82a886fa789e4' then
    raise exception 'TRAVA: public.master_atualizar_autorizacao_usuario mudou desde o backup -- regenerar a migração';
  end if;
  if (select md5(pg_get_functiondef('public.master_provisionar_usuario'::regproc)) ) <> '7d217dadadcd84988205b4cdcbc6d5e8' then
    raise exception 'TRAVA: public.master_provisionar_usuario mudou desde o backup -- regenerar a migração';
  end if;
  if (select md5(pg_get_functiondef('public.portal_modulos_permitidos'::regproc)) ) <> '4bb6b133c2bcb568f52db1264be7846a' then
    raise exception 'TRAVA: public.portal_modulos_permitidos mudou desde o backup -- regenerar a migração';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint where conname = 'usuarios_perfil_check' and conrelid = 'public.usuarios'::regclass) <> $c$CHECK ((perfil = ANY (ARRAY['VENDEDOR'::text, 'GERENTE'::text, 'ANALISTA'::text, 'MASTER'::text, 'DIRETOR NOVOS'::text, 'DIRETOR SEMINOVOS'::text, 'RECURSOS HUMANOS'::text, 'RH'::text])))$c$ then
    raise exception 'TRAVA: usuarios_perfil_check mudou desde o backup';
  end if;
  if exists (select 1 from pg_class where relname in ('aval_avaliacoes','aval_regras_margem','aval_consultas_veiculo','aval_eventos','fipe_precos') and relnamespace = 'public'::regnamespace) or exists (select 1 from public.modulos_portal where id = 'avaliacoes') then
    raise exception 'TRAVA: objetos das Avaliações já existem';
  end if;
end $trava$;

alter table public.usuarios drop constraint usuarios_perfil_check;
alter table public.usuarios add constraint usuarios_perfil_check CHECK ((perfil = ANY (ARRAY['VENDEDOR'::text, 'GERENTE'::text, 'ANALISTA'::text, 'MASTER'::text, 'DIRETOR NOVOS'::text, 'DIRETOR SEMINOVOS'::text, 'RECURSOS HUMANOS'::text, 'RH'::text, 'AVALIADOR'::text])));

CREATE OR REPLACE FUNCTION public.master_convidar_usuario(p_cpf text, p_nome text, p_perfil text, p_loja text, p_email text, p_nbs text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  v_perfis_validos constant text[] := array['MASTER','DIRETOR NOVOS','DIRETOR SEMINOVOS','ANALISTA','GERENTE','VENDEDOR','RECURSOS HUMANOS','RH','AVALIADOR'];
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
  elsif v_perfil = 'AVALIADOR' then
    -- Avaliações de Seminovos (27/10/2026): avaliador é sempre de uma loja e do departamento Seminovos
    if v_loja is null then
      raise exception 'Selecione a loja do avaliador.' using errcode = '22023';
    end if;
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

  insert into public.usuarios (cpf, nome, perfil, loja, status, email_auth, login_nbs, ativo, primeiro_acesso)
  values (p_cpf, v_nome, v_perfil, v_loja, v_status, v_email, v_nbs, false, true)
  returning id into v_usuario_id;

  if v_nbs is not null and v_seller.id is not null then
    update public.portal_sellers
       set portal_user_id = v_usuario_id, updated_at = now()
     where id = v_seller.id;
  end if;

  -- Fase 21.6B (Parte Y/Z) -- fecha o ciclo agora mesmo: qualquer fato ja
  -- importado com este CPF/NBS (SEM_MATCH anterior) e vinculado
  -- imediatamente, sem depender de ativacao/primeiro acesso.
  perform public.portal_reconcile_user_facts(v_usuario_id);

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

CREATE OR REPLACE FUNCTION public.master_atualizar_autorizacao_usuario(p_usuario_id uuid, p_perfil text, p_loja text, p_status text, p_ativo boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_perfil text := upper(trim(coalesce(p_perfil, '')));
  v_actor_nome text;
  v_alvo public.usuarios%rowtype;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if v_perfil not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH', 'AVALIADOR'
  ) then
    raise exception 'Perfil inválido.' using errcode = '22023';
  end if;

  update public.usuarios
  set
    perfil = v_perfil,
    loja = nullif(trim(coalesce(p_loja, '')), ''),
    status = nullif(trim(coalesce(p_status, '')), ''),
    ativo = coalesce(p_ativo, false)
  where id = p_usuario_id
  returning * into v_alvo;

  if v_alvo.id is null then
    raise exception 'Usuário não encontrado.' using errcode = 'P0002';
  end if;

  select nome into v_actor_nome from public.usuarios where auth_user_id = auth.uid();

  insert into public.auditoria (
    tipo, descricao, base_origem, vendedor, cpf, loja, resolvido
  )
  values (
    'ADMIN_USUARIO',
    format('Autorização de usuário atualizada por %s (perfil=%s, ativo=%s)',
      coalesce(v_actor_nome, '—'), v_alvo.perfil, v_alvo.ativo),
    'RPC master_atualizar_autorizacao_usuario',
    v_alvo.nome, v_alvo.cpf, v_alvo.loja, false
  );

  return true;
end;
$function$;

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
    'ANALISTA', 'GERENTE', 'VENDEDOR', 'RECURSOS HUMANOS', 'RH', 'AVALIADOR'
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
$function$;

CREATE OR REPLACE FUNCTION public.portal_modulos_permitidos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_profile text;
  v_status text;
  v_departments text[] := array[]::text[];
  v_result jsonb;
begin
  select *
    into v_user
  from public.usuarios
  where auth_user_id = auth.uid()
    and ativo = true
  limit 1;

  -- Default deny: identidade não resolvida = nenhum módulo.
  if v_user.id is null then
    return '[]'::jsonb;
  end if;

  v_profile := upper(trim(coalesce(v_user.perfil, '')));

  -- MASTER: acesso estrutural fixo a todos os módulos de negócio
  -- configuráveis. Nunca consulta a matriz — não pode se auto-bloquear.
  if v_profile = 'MASTER' then
    return coalesce((
      select jsonb_agg(m.id order by m.ordem)
      from public.modulos_portal m
      where m.configuravel = true and m.ativo = true
    ), '[]'::jsonb);
  end if;

  v_status := upper(trim(coalesce(v_user.status, '')));

  -- Mesma resolução de perfil/departamento de operational_current_scope()
  -- (não reimplementada por regex nova: mesmas regras, replicadas aqui
  -- porque essa função é somente leitura de escopo operacional de dados
  -- e não deve ser acoplada à camada de permissão de módulos).
  if v_profile in ('DIRETOR NOVOS', 'DIRETOR DE NOVOS') then
    v_profile := 'DIRETOR_NOVOS';
  elsif v_profile in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then
    v_profile := 'DIRETOR_SEMINOVOS';
  elsif v_profile in ('RECURSOS HUMANOS', 'RH') then
    v_profile := 'RH';
  end if;

  if v_profile in ('ANALISTA', 'RH') then
    v_departments := array['TODOS'];
  elsif v_profile in ('DIRETOR_NOVOS', 'DIRETOR_SEMINOVOS') then
    v_departments := array['TODOS'];
  elsif v_profile in ('GERENTE', 'VENDEDOR') then
    -- "SEMINOVOS" contém a substring "NOVOS"; remove antes de testar.
    if replace(v_status, 'SEMINOVOS', '') like '%NOVOS%' then
      v_departments := array_append(v_departments, 'NOVOS');
    end if;
    if v_status like '%SEMINOVOS%' then
      v_departments := array_append(v_departments, 'SEMINOVOS');
    end if;
  elsif v_profile = 'AVALIADOR' then
    -- Avaliações de Seminovos (27/10/2026): matriz AVALIADOR/SEMINOVOS
    v_departments := array['SEMINOVOS'];
  else
    -- Perfil desconhecido/não mapeado: default deny.
    return '[]'::jsonb;
  end if;

  if array_length(v_departments, 1) is null then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(distinct pm.modulo_id), '[]'::jsonb)
    into v_result
  from public.permissoes_modulos pm
  join public.modulos_portal m on m.id = pm.modulo_id
  where pm.perfil = v_profile
    and pm.departamento = any(v_departments)
    and pm.permitido = true
    and m.configuravel = true
    and m.ativo = true;

  return v_result;
end;
$function$;

-- ============================================================================
-- Avaliações de Seminovos — Fase 1 (objetos NOVOS)
-- Tabelas internas (sem acesso direto pela API: RLS ligada, nenhuma regra, sem
-- privilégio para anon/authenticated) e funções SECURITY DEFINER que conferem
-- perfil, loja e a permissão do módulo 'avaliacoes' em toda chamada.
-- Nenhum dado de proprietário é gravado: a consulta de placa guarda só os campos
-- do veículo (lista fechada aplicada na Edge Function avaliacao-consulta-placa).
-- ============================================================================

-- ---------- tabelas ----------------------------------------------------------

create table public.aval_regras_margem (
  id uuid primary key default gen_random_uuid(),
  versao integer not null unique check (versao > 0),
  parametros jsonb not null,
  observacao text,
  vigente_desde timestamptz not null default now(),
  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now()
);
comment on table public.aval_regras_margem is
  'Regras de margem das Avaliações, em versões. Vigente = maior versão. Cada avaliação calculada guarda a versão usada.';

create table public.aval_consultas_veiculo (
  id uuid primary key default gen_random_uuid(),
  placa text,
  chassi text,
  fornecedor text not null,
  simulado boolean not null,
  resultado jsonb not null,
  custo numeric(10,2) not null default 0,
  usuario_id uuid not null references public.usuarios(id),
  loja text,
  criado_em timestamptz not null default now(),
  check (placa is not null or chassi is not null)
);
create index aval_consultas_placa_idx on public.aval_consultas_veiculo (placa, criado_em desc);
create index aval_consultas_chassi_idx on public.aval_consultas_veiculo (chassi, criado_em desc);
create index aval_consultas_usuario_idx on public.aval_consultas_veiculo (usuario_id, criado_em desc);
comment on table public.aval_consultas_veiculo is
  'Consultas de placa/chassi (cache de 30 dias e controle de custo). Só dados do veículo; nunca dados do proprietário.';

create table public.aval_avaliacoes (
  id uuid primary key default gen_random_uuid(),
  codigo bigint generated always as identity unique,
  loja text not null,
  avaliador_id uuid not null references public.usuarios(id),
  status text not null default 'RASCUNHO' check (status in
    ('RASCUNHO','ENVIADA','DEVOLVIDA','APROVADA','REPROVADA','COMPRADA','DESCARTADA','EXPIRADA')),
  placa text,
  chassi text,
  consulta_id uuid references public.aval_consultas_veiculo(id),
  marca text,
  modelo text,
  versao text,
  fipe_codigo text,
  fipe_valor numeric(12,2),
  fipe_mes_ref text,
  fipe_simulado boolean not null default false,
  ano_fabricacao integer check (ano_fabricacao between 1950 and 2100),
  ano_modelo integer check (ano_modelo between 1950 and 2101),
  km integer check (km >= 0 and km <= 2000000),
  cor text,
  combustivel text,
  carroceria text check (carroceria in ('HATCH','SEDAN','SUV','PICKUP')),
  restricao_gravame boolean,
  restricao_leilao boolean,
  restricao_sinistro boolean,
  termo_referencia text,
  observacao text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (placa is not null or chassi is not null)
);
create index aval_avaliacoes_loja_idx on public.aval_avaliacoes (loja, criado_em desc);
create index aval_avaliacoes_chassi_idx on public.aval_avaliacoes (chassi);
create index aval_avaliacoes_placa_idx on public.aval_avaliacoes (placa);

create table public.aval_eventos (
  id bigint generated always as identity primary key,
  avaliacao_id uuid not null references public.aval_avaliacoes(id),
  usuario_id uuid references public.usuarios(id),
  tipo text not null,
  detalhe jsonb,
  criado_em timestamptz not null default now()
);
create index aval_eventos_avaliacao_idx on public.aval_eventos (avaliacao_id, criado_em);

create table public.fipe_precos (
  codigo_fipe text not null,
  ano_modelo integer not null,
  combustivel text not null default '',
  mes_ref text not null check (mes_ref ~ '^[0-9]{4}-[0-9]{2}$'),
  valor numeric(12,2) not null check (valor > 0),
  marca text,
  modelo text,
  fonte text not null,
  atualizado_em timestamptz not null default now(),
  primary key (codigo_fipe, ano_modelo, combustivel, mes_ref)
);
comment on table public.fipe_precos is
  'Tabela FIPE por mês (cache das consultas reais e, depois, da carga mensal). Valores do fornecedor simulado NUNCA entram aqui.';

-- fechadas para a API (o padrão do schema public dá acesso total a objetos novos)
do $$
declare t text;
begin
  foreach t in array array['aval_regras_margem','aval_consultas_veiculo','aval_avaliacoes','aval_eventos','fipe_precos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.aval_avaliacoes_codigo_seq from public, anon, authenticated;
revoke all on sequence public.aval_eventos_id_seq from public, anon, authenticated;

-- regra inicial (v1): Loja definida pelo Luis em 27/10/2026; Repasse, descontos e
-- preparação padrão ficam em branco até o Master preencher (o cálculo devolve
-- "regra incompleta" para esses valores, nunca um número inventado).
insert into public.aval_regras_margem (versao, parametros, observacao) values (1, jsonb_build_object(
  'impostos_pct', 4,
  'margem_loja_pct', 12,
  'margem_loja_min', 10000,
  'preparacao_padrao', null,
  'margem_repasse_pct', null,
  'margem_repasse_min', null,
  'desconto_restricao_pct', null,
  'desconto_reprovado_pct', null
), 'Versão inicial: Loja = venda provável − 4% impostos − maior entre 12% e R$ 10.000 − preparação − reparos. Repasse e descontos a definir pelo Master.');

-- ---------- módulo e permissões ---------------------------------------------
-- Fica liberado só para MASTER (automático) e AVALIADOR. Gerente e Diretor de
-- Seminovos entram desligados; o Master liga na tela de Acessos quando quiser.
insert into public.modulos_portal (id, nome, grupo, ativo, ordem, configuravel)
values ('avaliacoes', 'Avaliações de Seminovos', 'Seminovos', true, 13, true);
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('avaliacoes', 'AVALIADOR', 'SEMINOVOS', true),
  ('avaliacoes', 'GERENTE', 'SEMINOVOS', false),
  ('avaliacoes', 'DIRETOR_SEMINOVOS', 'TODOS', false);

-- ---------- funções internas -------------------------------------------------

create or replace function public._aval_normaliza_placa(p text)
returns text language sql immutable set search_path = pg_catalog, public as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

create or replace function public._aval_normaliza_chassi(p text)
returns text language sql immutable set search_path = pg_catalog, public as $$
  select nullif(regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g'), '')
$$;

-- Contexto de quem chama. Fail-closed: sem usuário ativo, sem o módulo liberado
-- na matriz ou com perfil fora da lista = 42501.
create or replace function public._aval_contexto()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_user public.usuarios%rowtype;
  v_perfil text;
  v_status text;
  v_loja text;
begin
  select * into v_user from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.' using errcode = '42501';
  end if;
  if not (public.portal_modulos_permitidos() ? 'avaliacoes') then
    raise exception 'Módulo Avaliações não liberado para este perfil.' using errcode = '42501';
  end if;
  v_perfil := upper(trim(coalesce(v_user.perfil, '')));
  v_status := upper(trim(coalesce(v_user.status, '')));
  v_loja := nullif(upper(trim(coalesce(v_user.loja, ''))), '');

  if v_perfil = 'MASTER' then
    return jsonb_build_object('usuario_id', v_user.id, 'nome', v_user.nome, 'perfil', 'MASTER', 'loja', v_loja,
                              'escopo', 'GRUPO', 'pode_criar', true, 'pode_regras', true);
  elsif v_perfil in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then
    return jsonb_build_object('usuario_id', v_user.id, 'nome', v_user.nome, 'perfil', 'DIRETOR SEMINOVOS', 'loja', v_loja,
                              'escopo', 'GRUPO', 'pode_criar', false, 'pode_regras', false);
  elsif v_perfil in ('AVALIADOR', 'GERENTE') then
    if v_perfil = 'GERENTE' and v_status not like '%SEMINOVOS%' then
      raise exception 'Módulo Avaliações é do departamento de Seminovos.' using errcode = '42501';
    end if;
    if v_loja is null then
      raise exception 'Cadastro sem loja: fale com o Master.' using errcode = '42501';
    end if;
    return jsonb_build_object('usuario_id', v_user.id, 'nome', v_user.nome, 'perfil', v_perfil, 'loja', v_loja,
                              'escopo', 'LOJA', 'pode_criar', true, 'pode_regras', false);
  end if;
  raise exception 'Perfil sem acesso às Avaliações.' using errcode = '42501';
end $$;

-- Cálculo fixo dos 4 valores (usado na Fase 3 e na prévia do Master).
-- Loja    = V − impostos% · V − maior(margem_loja% · V, margem_loja_min) − preparação − reparos
-- Repasse = V − impostos% · V − maior(margem_repasse% · V, margem_repasse_min) − preparação − reparos
-- Repasse com restrição = Repasse · (1 − desconto_restricao%)
-- Repasse reprovado     = Repasse · (1 − desconto_reprovado%)
-- Parâmetro em branco = valor correspondente sai nulo, com o motivo em "pendencias".
create or replace function public._aval_calcular(p_regra jsonb, p_venda numeric, p_preparacao numeric, p_reparos numeric)
returns jsonb
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  v_imp_pct numeric := (p_regra->>'impostos_pct')::numeric;
  v_ml_pct numeric := (p_regra->>'margem_loja_pct')::numeric;
  v_ml_min numeric := (p_regra->>'margem_loja_min')::numeric;
  v_mr_pct numeric := (p_regra->>'margem_repasse_pct')::numeric;
  v_mr_min numeric := (p_regra->>'margem_repasse_min')::numeric;
  v_dr_pct numeric := (p_regra->>'desconto_restricao_pct')::numeric;
  v_dp_pct numeric := (p_regra->>'desconto_reprovado_pct')::numeric;
  v_prep numeric := coalesce(p_preparacao, (p_regra->>'preparacao_padrao')::numeric);
  v_rep numeric := coalesce(p_reparos, 0);
  v_imp numeric; v_marg_loja numeric; v_marg_rep numeric;
  v_loja numeric; v_repasse numeric; v_restr numeric; v_reprov numeric;
  v_pend text[] := array[]::text[];
begin
  if p_venda is null or p_venda <= 0 then
    raise exception 'Informe a venda provável.' using errcode = '22023';
  end if;
  if v_imp_pct is null then v_pend := array_append(v_pend, 'impostos_pct'); end if;
  if v_prep is null then v_pend := array_append(v_pend, 'preparacao'); end if;
  if v_ml_pct is null or v_ml_min is null then v_pend := array_append(v_pend, 'margem_loja'); end if;
  if v_mr_pct is null or v_mr_min is null then v_pend := array_append(v_pend, 'margem_repasse'); end if;
  if v_dr_pct is null then v_pend := array_append(v_pend, 'desconto_restricao_pct'); end if;
  if v_dp_pct is null then v_pend := array_append(v_pend, 'desconto_reprovado_pct'); end if;

  v_imp := round(p_venda * v_imp_pct / 100, 2);
  -- greatest() ignora nulos: parâmetro em branco tem que dar margem nula, não o outro valor
  v_marg_loja := case when v_ml_pct is null or v_ml_min is null then null else round(greatest(p_venda * v_ml_pct / 100, v_ml_min), 2) end;
  v_marg_rep := case when v_mr_pct is null or v_mr_min is null then null else round(greatest(p_venda * v_mr_pct / 100, v_mr_min), 2) end;
  v_loja := round(p_venda - v_imp - v_marg_loja - v_prep - v_rep, 2);
  v_repasse := round(p_venda - v_imp - v_marg_rep - v_prep - v_rep, 2);
  v_restr := round(v_repasse * (1 - v_dr_pct / 100), 2);
  v_reprov := round(v_repasse * (1 - v_dp_pct / 100), 2);

  return jsonb_build_object(
    'venda_provavel', p_venda, 'impostos', v_imp, 'preparacao', v_prep, 'reparos', v_rep,
    'margem_loja', v_marg_loja, 'margem_repasse', v_marg_rep,
    'loja', v_loja, 'repasse', v_repasse, 'repasse_restricao', v_restr, 'repasse_reprovado', v_reprov,
    'pendencias', to_jsonb(v_pend));
end $$;

create or replace function public._aval_regra_vigente()
returns public.aval_regras_margem
language sql stable security definer
set search_path = pg_catalog, public
as $$ select * from public.aval_regras_margem order by versao desc limit 1 $$;

-- Confere o acesso a uma avaliação (escopo LOJA só vê a própria loja).
create or replace function public._aval_carregar(p_id uuid, p_ctx jsonb)
returns public.aval_avaliacoes
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v public.aval_avaliacoes%rowtype;
begin
  select * into v from public.aval_avaliacoes where id = p_id;
  if v.id is null or (p_ctx->>'escopo' = 'LOJA' and v.loja <> p_ctx->>'loja') then
    raise exception 'Avaliação não encontrada.' using errcode = 'P0002';
  end if;
  return v;
end $$;

-- ---------- funções da tela --------------------------------------------------

create or replace function public.aval_contexto()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_ctx jsonb := public._aval_contexto();
begin
  return v_ctx - 'usuario_id' || jsonb_build_object(
    'lojas', case when v_ctx->>'escopo' = 'GRUPO'
                  then to_jsonb(array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'])
                  else jsonb_build_array(v_ctx->>'loja') end);
end $$;

create or replace function public.aval_listar(p_status text default null, p_limite integer default 50)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_status text := nullif(upper(trim(coalesce(p_status, ''))), '');
begin
  return coalesce((
    select jsonb_agg(x order by x.criado_em desc) from (
      select a.id, a.codigo, a.loja, a.status, a.placa, a.chassi, a.marca, a.modelo, a.versao,
             a.ano_fabricacao, a.ano_modelo, a.km, a.fipe_valor, a.fipe_simulado, a.criado_em, a.atualizado_em,
             u.nome avaliador
        from public.aval_avaliacoes a
        join public.usuarios u on u.id = a.avaliador_id
       where (v_ctx->>'escopo' = 'GRUPO' or a.loja = v_ctx->>'loja')
         and (v_status is null or a.status = v_status)
         and (v_status is not null or a.status <> 'DESCARTADA')
       order by a.criado_em desc
       limit least(greatest(coalesce(p_limite, 50), 1), 200)
    ) x), '[]'::jsonb);
end $$;

create or replace function public.aval_obter(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
begin
  return to_jsonb(v) || jsonb_build_object(
    'avaliador', (select nome from public.usuarios where id = v.avaliador_id),
    'versoes_consulta', (select c.resultado->'versoes' from public.aval_consultas_veiculo c where c.id = v.consulta_id),
    'eventos', coalesce((select jsonb_agg(jsonb_build_object('tipo', e.tipo, 'criado_em', e.criado_em, 'usuario', u.nome) order by e.criado_em)
                           from public.aval_eventos e left join public.usuarios u on u.id = e.usuario_id
                          where e.avaliacao_id = v.id), '[]'::jsonb));
end $$;

-- Cria (p_id nulo) ou atualiza um RASCUNHO com a identificação do veículo.
create or replace function public.aval_salvar_identificacao(p_id uuid, p_dados jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_uid uuid := (v_ctx->>'usuario_id')::uuid;
  v public.aval_avaliacoes%rowtype;
  v_loja text;
  v_placa text := public._aval_normaliza_placa(p_dados->>'placa');
  v_chassi text := public._aval_normaliza_chassi(p_dados->>'chassi');
  v_consulta public.aval_consultas_veiculo%rowtype;
  v_versao jsonb;
  v_carroceria text := nullif(upper(trim(coalesce(p_dados->>'carroceria', ''))), '');
  v_km integer;
  v_ano_fab integer;
  v_ano_mod integer;
begin
  if not coalesce((v_ctx->>'pode_criar')::boolean, false) then
    raise exception 'Seu perfil pode consultar, mas não criar avaliações.' using errcode = '42501';
  end if;
  if v_placa is not null and v_placa !~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' then
    raise exception 'Placa inválida.' using errcode = '22023';
  end if;
  if v_chassi is not null and v_chassi !~ '^[A-HJ-NPR-Z0-9]{17}$' then
    raise exception 'Chassi inválido (17 caracteres, sem I, O ou Q).' using errcode = '22023';
  end if;
  if v_placa is null and v_chassi is null then
    raise exception 'Informe a placa ou o chassi.' using errcode = '22023';
  end if;
  begin
    v_km := nullif(regexp_replace(coalesce(p_dados->>'km', ''), '[^0-9]', '', 'g'), '')::integer;
    v_ano_fab := nullif(p_dados->>'ano_fabricacao', '')::integer;
    v_ano_mod := nullif(p_dados->>'ano_modelo', '')::integer;
  exception when others then
    raise exception 'Ano ou km inválido.' using errcode = '22023';
  end;
  if v_km is null then
    raise exception 'Informe a quilometragem.' using errcode = '22023';
  end if;
  if v_ano_fab is null or v_ano_mod is null or v_ano_mod < v_ano_fab or v_ano_mod > v_ano_fab + 1
     or v_ano_fab > extract(year from now())::int + 1 then
    raise exception 'Ano de fabricação/modelo inválido.' using errcode = '22023';
  end if;
  if v_carroceria is null or v_carroceria not in ('HATCH','SEDAN','SUV','PICKUP') then
    raise exception 'Escolha a carroceria (hatch, sedan, SUV ou pickup).' using errcode = '22023';
  end if;

  -- a versão escolhida precisa ser uma das versões da consulta (quando houver consulta)
  if nullif(p_dados->>'consulta_id', '') is not null then
    select * into v_consulta from public.aval_consultas_veiculo where id = (p_dados->>'consulta_id')::uuid;
    if v_consulta.id is null then
      raise exception 'Consulta de placa não encontrada.' using errcode = '22023';
    end if;
    select x.value into v_versao from jsonb_array_elements(v_consulta.resultado->'versoes') x
     where x.value->>'fipe_codigo' = p_dados->>'fipe_codigo'
       and coalesce(x.value->>'ano_modelo', '') = coalesce(p_dados->>'ano_modelo_fipe', x.value->>'ano_modelo', '')
     limit 1;
    if v_versao is null then
      raise exception 'Escolha uma das versões da consulta.' using errcode = '22023';
    end if;
  elsif nullif(trim(coalesce(p_dados->>'modelo', '')), '') is null then
    raise exception 'Sem consulta de placa: informe ao menos o modelo.' using errcode = '22023';
  end if;

  if p_id is null then
    v_loja := case when v_ctx->>'escopo' = 'LOJA' then v_ctx->>'loja'
                   else nullif(upper(trim(coalesce(p_dados->>'loja', ''))), '') end;
    if v_loja is null or not (v_loja = any(array['ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES'])) then
      raise exception 'Escolha a loja da avaliação.' using errcode = '22023';
    end if;
    insert into public.aval_avaliacoes (loja, avaliador_id, placa, chassi) values (v_loja, v_uid, v_placa, v_chassi)
    returning * into v;
    insert into public.aval_eventos (avaliacao_id, usuario_id, tipo) values (v.id, v_uid, 'CRIADA');
  else
    v := public._aval_carregar(p_id, v_ctx);
    if v.status not in ('RASCUNHO', 'DEVOLVIDA') then
      raise exception 'Só é possível alterar avaliações em rascunho ou devolvidas.' using errcode = '22023';
    end if;
    insert into public.aval_eventos (avaliacao_id, usuario_id, tipo) values (v.id, v_uid, 'IDENTIFICACAO_ALTERADA');
  end if;

  update public.aval_avaliacoes set
    placa = v_placa,
    chassi = coalesce(v_chassi, nullif(public._aval_normaliza_chassi(v_versao->>'chassi'), '')),
    consulta_id = v_consulta.id,
    marca = coalesce(v_versao->>'marca', nullif(trim(p_dados->>'marca'), '')),
    modelo = coalesce(v_versao->>'modelo', nullif(trim(p_dados->>'modelo'), '')),
    versao = coalesce(v_versao->>'versao', nullif(trim(p_dados->>'versao'), '')),
    fipe_codigo = v_versao->>'fipe_codigo',
    fipe_valor = (v_versao->>'fipe_valor')::numeric,
    fipe_mes_ref = v_versao->>'fipe_mes_ref',
    fipe_simulado = coalesce(v_consulta.simulado, false),
    ano_fabricacao = v_ano_fab,
    ano_modelo = v_ano_mod,
    km = v_km,
    cor = nullif(upper(trim(coalesce(p_dados->>'cor', ''))), ''),
    combustivel = coalesce(nullif(upper(trim(coalesce(p_dados->>'combustivel', ''))), ''), upper(v_versao->>'combustivel')),
    carroceria = v_carroceria,
    restricao_gravame = (v_consulta.resultado->'restricoes'->>'gravame')::boolean,
    restricao_leilao = (v_consulta.resultado->'restricoes'->>'leilao')::boolean,
    restricao_sinistro = (v_consulta.resultado->'restricoes'->>'sinistro')::boolean,
    observacao = nullif(trim(coalesce(p_dados->>'observacao', '')), ''),
    atualizado_em = now()
  where id = v.id
  returning * into v;

  return jsonb_build_object('id', v.id, 'codigo', v.codigo, 'status', v.status);
end $$;

create or replace function public.aval_descartar(p_id uuid, p_motivo text)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
begin
  if not coalesce((v_ctx->>'pode_criar')::boolean, false) then
    raise exception 'Seu perfil não pode descartar avaliações.' using errcode = '42501';
  end if;
  if v.status not in ('RASCUNHO', 'DEVOLVIDA') then
    raise exception 'Só rascunhos e devolvidas podem ser descartadas.' using errcode = '22023';
  end if;
  update public.aval_avaliacoes set status = 'DESCARTADA', atualizado_em = now() where id = v.id;
  insert into public.aval_eventos (avaliacao_id, usuario_id, tipo, detalhe)
  values (v.id, (v_ctx->>'usuario_id')::uuid, 'DESCARTADA', jsonb_build_object('motivo', left(coalesce(p_motivo, ''), 300)));
  return jsonb_build_object('id', v.id, 'status', 'DESCARTADA');
end $$;

-- Referências: FIPE da avaliação + vendas reais de seminovos do grupo (Base 01)
-- para o mesmo modelo nos últimos 12 meses. A Base 01 não tem ano nem km: o
-- recorte é pelo texto do modelo do NBS (o avaliador pode ajustar o termo).
-- Uma linha por venda (chassi + data, último lote); vendas abaixo de R$ 5.000
-- ficam de fora (lançamentos inválidos, ex.: R$ 10). Sem vendedor nem cliente.
create or replace function public.aval_referencias(p_id uuid, p_termo text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
  v_termo text;
  v_vendas jsonb;
  v_resumo jsonb;
begin
  v_termo := upper(trim(regexp_replace(coalesce(nullif(trim(p_termo), ''), v.termo_referencia, v.modelo, ''), '\s+', ' ', 'g')));
  if length(v_termo) < 3 then
    raise exception 'Informe ao menos 3 letras do modelo para buscar as vendas do grupo.' using errcode = '22023';
  end if;
  if p_termo is not null and v_termo is distinct from v.termo_referencia then
    update public.aval_avaliacoes set termo_referencia = v_termo, atualizado_em = now() where id = v.id;
  end if;

  with vendas as (
    select distinct on (s.chassis, s.sale_date) s.sale_date, s.store, s.vehicle_model, s.sale_value
      from public.portal_sales s
     where s.department = 'SEMINOVOS'
       and s.sale_date >= (current_date - interval '12 months')
       and s.sale_value >= 5000
       and upper(s.vehicle_model) like replace(replace(v_termo, '%', ''), '_', '\_') || '%'
     order by s.chassis, s.sale_date, s.created_at desc, s.id desc
  )
  select
    jsonb_build_object(
      'quantidade', count(*),
      'mediana', percentile_cont(0.5) within group (order by sale_value),
      'p25', percentile_cont(0.25) within group (order by sale_value),
      'p75', percentile_cont(0.75) within group (order by sale_value),
      'minimo', min(sale_value), 'maximo', max(sale_value),
      'ultima_venda', max(sale_date)),
    coalesce((select jsonb_agg(jsonb_build_object('data', w.sale_date, 'loja', w.store, 'modelo', w.vehicle_model, 'valor', w.sale_value)
                               order by w.sale_date desc)
                from (select * from vendas order by sale_date desc limit 15) w), '[]'::jsonb)
    into v_resumo, v_vendas
  from vendas;

  return jsonb_build_object(
    'termo', v_termo,
    'fipe', jsonb_build_object('codigo', v.fipe_codigo, 'valor', v.fipe_valor, 'mes_ref', v.fipe_mes_ref, 'simulado', v.fipe_simulado),
    'vendas_grupo', v_resumo,
    'ultimas_vendas', v_vendas,
    'observacao', 'Vendas da Base 01 (últimos 12 meses), sem ano e km: a Base 01 não traz esses campos.');
end $$;

-- ---------- consulta de placa (chamadas pela Edge Function) ------------------

-- 1º passo, com o JWT do usuário: confere acesso, limite diário e cache de 30 dias.
create or replace function public.aval_consulta_preparar(p_placa text, p_chassi text)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_uid uuid := (v_ctx->>'usuario_id')::uuid;
  v_placa text := public._aval_normaliza_placa(p_placa);
  v_chassi text := public._aval_normaliza_chassi(p_chassi);
  v_hoje integer;
  v_cache public.aval_consultas_veiculo%rowtype;
  c_limite_dia constant integer := 40;
begin
  if not coalesce((v_ctx->>'pode_criar')::boolean, false) then
    raise exception 'Seu perfil não faz consultas de placa.' using errcode = '42501';
  end if;
  if v_placa is null and v_chassi is null then
    raise exception 'Informe a placa ou o chassi.' using errcode = '22023';
  end if;
  if v_placa is not null and v_placa !~ '^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$' then
    raise exception 'Placa inválida.' using errcode = '22023';
  end if;
  if v_chassi is not null and v_chassi !~ '^[A-HJ-NPR-Z0-9]{17}$' then
    raise exception 'Chassi inválido (17 caracteres, sem I, O ou Q).' using errcode = '22023';
  end if;

  select * into v_cache from public.aval_consultas_veiculo
   where ((v_placa is not null and placa = v_placa) or (v_chassi is not null and chassi = v_chassi))
     and criado_em >= now() - interval '30 days'
   order by criado_em desc limit 1;
  if v_cache.id is not null then
    return jsonb_build_object('cache', true, 'consulta_id', v_cache.id, 'fornecedor', v_cache.fornecedor,
                              'simulado', v_cache.simulado, 'resultado', v_cache.resultado, 'consultado_em', v_cache.criado_em);
  end if;

  select count(*) into v_hoje from public.aval_consultas_veiculo
   where usuario_id = v_uid and criado_em >= date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo';
  if v_hoje >= c_limite_dia then
    raise exception 'Limite de % consultas por dia atingido.', c_limite_dia using errcode = '54000';
  end if;

  return jsonb_build_object('cache', false, 'usuario_id', v_uid, 'placa', v_placa, 'chassi', v_chassi,
                            'loja', case when v_ctx->>'escopo' = 'LOJA' then v_ctx->>'loja' end);
end $$;

-- 2º passo, só com a chave de serviço da Edge Function: grava o retorno JÁ FILTRADO.
create or replace function public.aval_consulta_registrar(p_usuario_id uuid, p_loja text, p_placa text, p_chassi text,
                                                          p_fornecedor text, p_simulado boolean, p_resultado jsonb, p_custo numeric)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
  v_ver jsonb;
begin
  if jsonb_typeof(p_resultado->'versoes') is distinct from 'array' then
    raise exception 'Retorno sem lista de versões.' using errcode = '22023';
  end if;
  insert into public.aval_consultas_veiculo (placa, chassi, fornecedor, simulado, resultado, custo, usuario_id, loja)
  values (public._aval_normaliza_placa(p_placa), public._aval_normaliza_chassi(p_chassi), p_fornecedor,
          coalesce(p_simulado, true), p_resultado, coalesce(p_custo, 0), p_usuario_id, p_loja)
  returning id into v_id;

  if not coalesce(p_simulado, true) then
    for v_ver in select * from jsonb_array_elements(p_resultado->'versoes') loop
      if v_ver->>'fipe_codigo' is not null and (v_ver->>'fipe_valor')::numeric > 0
         and v_ver->>'fipe_mes_ref' ~ '^[0-9]{4}-[0-9]{2}$' and (v_ver->>'ano_modelo') ~ '^[0-9]{4}$' then
        insert into public.fipe_precos (codigo_fipe, ano_modelo, combustivel, mes_ref, valor, marca, modelo, fonte)
        values (v_ver->>'fipe_codigo', (v_ver->>'ano_modelo')::int, upper(coalesce(v_ver->>'combustivel', '')),
                v_ver->>'fipe_mes_ref', (v_ver->>'fipe_valor')::numeric, v_ver->>'marca', v_ver->>'modelo', p_fornecedor)
        on conflict (codigo_fipe, ano_modelo, combustivel, mes_ref)
        do update set valor = excluded.valor, fonte = excluded.fonte, atualizado_em = now();
      end if;
    end loop;
  end if;
  return jsonb_build_object('consulta_id', v_id);
end $$;

-- ---------- regras de margem (Master) ----------------------------------------

create or replace function public.aval_regras_listar()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_ctx jsonb := public._aval_contexto();
begin
  if not coalesce((v_ctx->>'pode_regras')::boolean, false) then
    raise exception 'Regras de margem: acesso exclusivo do Master.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('versao', r.versao, 'parametros', r.parametros, 'observacao', r.observacao,
                                                       'vigente_desde', r.vigente_desde, 'criado_por', u.nome) order by r.versao desc)
                     from public.aval_regras_margem r left join public.usuarios u on u.id = r.criado_por), '[]'::jsonb);
end $$;

create or replace function public.aval_master_salvar_regra(p_parametros jsonb, p_observacao text)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  c_chaves constant text[] := array['impostos_pct','margem_loja_pct','margem_loja_min','preparacao_padrao',
                                    'margem_repasse_pct','margem_repasse_min','desconto_restricao_pct','desconto_reprovado_pct'];
  v_k text;
  v_val numeric;
  v_par jsonb := '{}'::jsonb;
  v_versao integer;
begin
  if not coalesce((v_ctx->>'pode_regras')::boolean, false) then
    raise exception 'Regras de margem: acesso exclusivo do Master.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_parametros) is distinct from 'object' then
    raise exception 'Parâmetros inválidos.' using errcode = '22023';
  end if;
  foreach v_k in array c_chaves loop
    if p_parametros->>v_k is null or trim(p_parametros->>v_k) = '' then
      v_par := v_par || jsonb_build_object(v_k, null);
      continue;
    end if;
    begin
      v_val := (p_parametros->>v_k)::numeric;
    exception when others then
      raise exception 'Valor inválido em %.', v_k using errcode = '22023';
    end;
    if v_val < 0 or (v_k like '%\_pct' and v_val >= 100) then
      raise exception 'Valor fora da faixa em %.', v_k using errcode = '22023';
    end if;
    v_par := v_par || jsonb_build_object(v_k, v_val);
  end loop;
  if (v_par->>'impostos_pct') is null or (v_par->>'margem_loja_pct') is null or (v_par->>'margem_loja_min') is null then
    raise exception 'Impostos e margem da Loja são obrigatórios.' using errcode = '22023';
  end if;
  -- "Repasse com margem maior que Loja"
  if (v_par->>'margem_repasse_pct') is not null and (v_par->>'margem_repasse_min') is not null then
    if (v_par->>'margem_repasse_pct')::numeric < (v_par->>'margem_loja_pct')::numeric
       or (v_par->>'margem_repasse_min')::numeric < (v_par->>'margem_loja_min')::numeric
       or ((v_par->>'margem_repasse_pct')::numeric = (v_par->>'margem_loja_pct')::numeric
           and (v_par->>'margem_repasse_min')::numeric = (v_par->>'margem_loja_min')::numeric) then
      raise exception 'A margem do Repasse precisa ser maior que a da Loja.' using errcode = '22023';
    end if;
  end if;

  select coalesce(max(versao), 0) + 1 into v_versao from public.aval_regras_margem;
  insert into public.aval_regras_margem (versao, parametros, observacao, criado_por)
  values (v_versao, v_par, nullif(trim(coalesce(p_observacao, '')), ''), (v_ctx->>'usuario_id')::uuid);

  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('AVAL_REGRA_MARGEM', format('Regras de margem das Avaliações: versão %s criada por %s', v_versao, v_ctx->>'nome'),
          'Avaliações de Seminovos', v_ctx->>'nome', '', null, true);
  return jsonb_build_object('versao', v_versao, 'parametros', v_par);
end $$;

-- Prévia do cálculo (Master): com a regra vigente ou com parâmetros em edição.
create or replace function public.aval_previa_calculo(p_venda numeric, p_preparacao numeric default null,
                                                      p_reparos numeric default 0, p_parametros jsonb default null)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_regra public.aval_regras_margem := public._aval_regra_vigente();
begin
  if not coalesce((v_ctx->>'pode_regras')::boolean, false) then
    raise exception 'Prévia do cálculo: acesso exclusivo do Master.' using errcode = '42501';
  end if;
  return public._aval_calcular(coalesce(p_parametros, v_regra.parametros), p_venda, p_preparacao, p_reparos)
         || jsonb_build_object('versao', case when p_parametros is null then v_regra.versao end);
end $$;

-- ---------- quem executa o quê ----------------------------------------------
do $$
declare f text;
begin
  -- internas: ninguém de fora chama
  foreach f in array array[
    'public._aval_normaliza_placa(text)', 'public._aval_normaliza_chassi(text)', 'public._aval_contexto()',
    'public._aval_calcular(jsonb, numeric, numeric, numeric)', 'public._aval_regra_vigente()',
    'public._aval_carregar(uuid, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  -- tela: só usuário logado (cada função confere perfil/loja/módulo)
  foreach f in array array[
    'public.aval_contexto()', 'public.aval_listar(text, integer)', 'public.aval_obter(uuid)',
    'public.aval_salvar_identificacao(uuid, jsonb)', 'public.aval_descartar(uuid, text)',
    'public.aval_referencias(uuid, text)', 'public.aval_consulta_preparar(text, text)',
    'public.aval_regras_listar()', 'public.aval_master_salvar_regra(jsonb, text)',
    'public.aval_previa_calculo(numeric, numeric, numeric, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- gravação do retorno da consulta: só a chave de serviço (Edge Function)
  revoke all on function public.aval_consulta_registrar(uuid, text, text, text, text, boolean, jsonb, numeric) from public, anon, authenticated;
  grant execute on function public.aval_consulta_registrar(uuid, text, text, text, text, boolean, jsonb, numeric) to service_role;
end $$;


commit;

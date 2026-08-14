-- Fase 9.3 (A2) — Schema + seed das permissões dinâmicas de módulos.
--
-- IMPORTANTE: esta migration NÃO liga o motor dinâmico. A flag
-- permissoes_modulos_dinamicas nasce FALSE e o Portal continua usando
-- 100% o motor hardcoded (portalAllowedModules em index.html) até uma
-- fase futura decidir ligá-la. Nenhum frontend foi alterado.
--
-- Decisão de produto (Fase 9.2): Análise F&I do Grupo (gestao) NÃO é
-- liberável para VENDEDOR nesta etapa — operational_fandi_dashboard lê
-- portal_spf_operations, que não tem seller_id/portal_user_id/NBS, logo
-- não há hoje granularidade confiável para restringir a "somente os
-- próprios dados" de um vendedor. Registrado como FALSE explícito no
-- seed, não como ausência de linha.

-- ==========================================================
-- 1. Catálogo de módulos
-- ==========================================================
create table public.modulos_portal (
  id text primary key,
  nome text not null,
  grupo text,
  ativo boolean not null default true,
  ordem integer not null default 0,
  configuravel boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.modulos_portal is
  'Catálogo dos módulos do Portal F&I. configuravel=false marca módulos '
  'MASTER-only/estruturais (Painel Master, Central de Atendimento, '
  'Gestão de Bases/Simuladores) mantidos aqui só para documentação — '
  'nunca entram na matriz editável pelo Painel Master.';

insert into public.modulos_portal (id, nome, grupo, ordem, configuravel) values
  ('simuladorCompleto',        'Simulador de Novos',          'Simuladores',            1, true),
  ('simuladorSeminovos',       'Simulador de Seminovos',      'Simuladores',            2, true),
  ('dashbi',                   'Análise Geral do Grupo',      'Gestão',                 3, true),
  ('gestao',                   'Análise F&I do Grupo',        'Gestão',                 4, true),
  ('coparticipadoPortal',      'Coparticipados',              'Gestão de Incentivos',   5, true),
  ('analiseScoreVendedores',   'Análise de Score',            'Gestão de Incentivos',   6, true),
  ('comissoes',                'Acompanhamento de Salário',   null,                     7, true),
  -- Documentação apenas — nunca editáveis pela matriz (Checkpoint 3):
  ('painelAnalistaFi',         'Painel do Analista',          null,                     8, false),
  ('centralAtendimentoFi',     'Central de Atendimento F&I',  'Atendimento F&I',        9, false),
  ('painelMaster',             'Painel Master',                null,                    10, false),
  ('gestaoBases',              'Gestão de Bases (interno)',    null,                    11, false),
  ('gestaoSimuladores',        'Gestão de Simuladores (interno)', null,                 12, false);

-- ==========================================================
-- 2. Matriz de permissões
-- ==========================================================
-- departamento é sempre preenchido (nunca NULL) para garantir unicidade
-- real na PK: 'TODOS' (perfil sem distinção NOVOS/SEMINOVOS), 'NOVOS' ou
-- 'SEMINOVOS'. MASTER não tem linhas aqui — é tratado estruturalmente
-- na RPC de leitura (Checkpoint 16), nunca consulta esta tabela.
create table public.permissoes_modulos (
  modulo_id text not null references public.modulos_portal(id),
  perfil text not null,
  departamento text not null default 'TODOS'
    check (departamento in ('TODOS', 'NOVOS', 'SEMINOVOS')),
  permitido boolean not null default false,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.usuarios(id),
  primary key (modulo_id, perfil, departamento)
);

comment on table public.permissoes_modulos is
  'Matriz módulo × perfil × departamento. MASTER nunca aparece aqui — '
  'acesso total fixo, resolvido estruturalmente por portal_modulos_permitidos().';

create index idx_permissoes_modulos_perfil on public.permissoes_modulos(perfil, departamento);

-- ==========================================================
-- 3. Auditoria dedicada
-- ==========================================================
-- Avaliada a tabela public.auditoria (já existente, usada por
-- master_admin_security_data) para reaproveito — descartada por
-- incompatibilidade semântica: suas colunas (loja, vendedor, cpf,
-- resolvido/resolvido_por/resolvido_em) modelam "achados de dados a
-- resolver" (ex.: vendedor não cadastrado), não "mudança de
-- configuração já efetivada". Forçar isso nela deixaria colunas
-- obrigatórias-de-fato sempre vazias e o conceito de "resolvido"
-- sem sentido para um evento que já É a própria resolução.
create table public.permissoes_modulos_auditoria (
  id bigint generated always as identity primary key,
  modulo_id text not null,
  perfil text not null,
  departamento text not null,
  valor_anterior boolean,
  valor_novo boolean not null,
  alterado_por uuid references public.usuarios(id),
  alterado_em timestamptz not null default now()
);

comment on table public.permissoes_modulos_auditoria is
  'Histórico imutável de alterações na matriz de permissões de módulos. '
  'Um INSERT por célula alterada em cada chamada de master_salvar_permissoes_modulos().';

-- ==========================================================
-- 4. RLS — sem policies amplas; acesso só via RPC SECURITY DEFINER
-- ==========================================================
alter table public.modulos_portal enable row level security;
alter table public.permissoes_modulos enable row level security;
alter table public.permissoes_modulos_auditoria enable row level security;

revoke all on public.modulos_portal from public, anon, authenticated;
revoke all on public.permissoes_modulos from public, anon, authenticated;
revoke all on public.permissoes_modulos_auditoria from public, anon, authenticated;
grant all on public.modulos_portal to service_role;
grant all on public.permissoes_modulos to service_role;
grant all on public.permissoes_modulos_auditoria to service_role;
-- Nenhuma policy criada: sem policy + RLS habilitada = acesso direto
-- nega tudo para anon/authenticated, mesmo que um GRANT futuro seja
-- adicionado por engano. service_role (usado dentro das funções
-- SECURITY DEFINER) contorna RLS por definição do Postgres/Supabase.

-- ==========================================================
-- 5. Seed — reproduz o comportamento FUNCIONAL OBSERVÁVEL atual
-- ==========================================================
-- Fonte: matriz auditada na Fase 9.0 (frontend, 4 camadas de
-- portalAllowedModules em index.html) INTERSECTADA com as restrições
-- reais de backend confirmadas na Fase 9.1 (operational_fandi_dashboard
-- bloqueia VENDEDOR com 42501). Onde frontend e backend divergem
-- (ex.: DIRETOR permitido no backend da RPC mas sem o card hoje), o
-- seed reflete o que é OBSERVÁVEL hoje pelo usuário, não o que a RPC
-- teoricamente aceitaria se o card existisse.

-- ANALISTA (sem distinção de departamento)
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'ANALISTA', 'TODOS', true),
  ('simuladorSeminovos',     'ANALISTA', 'TODOS', true),
  ('dashbi',                 'ANALISTA', 'TODOS', true),
  ('gestao',                 'ANALISTA', 'TODOS', true),
  ('coparticipadoPortal',    'ANALISTA', 'TODOS', true),
  ('analiseScoreVendedores', 'ANALISTA', 'TODOS', true),
  ('comissoes',              'ANALISTA', 'TODOS', true);

-- RH
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'RH', 'TODOS', false),
  ('simuladorSeminovos',     'RH', 'TODOS', false),
  ('dashbi',                 'RH', 'TODOS', false),
  ('gestao',                 'RH', 'TODOS', false),
  ('coparticipadoPortal',    'RH', 'TODOS', false),
  ('analiseScoreVendedores', 'RH', 'TODOS', false),
  ('comissoes',              'RH', 'TODOS', true);

-- GERENTE + NOVOS
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'GERENTE', 'NOVOS', true),
  ('simuladorSeminovos',     'GERENTE', 'NOVOS', false),
  ('dashbi',                 'GERENTE', 'NOVOS', false),
  ('gestao',                 'GERENTE', 'NOVOS', true),
  ('coparticipadoPortal',    'GERENTE', 'NOVOS', true),
  ('analiseScoreVendedores', 'GERENTE', 'NOVOS', true),
  ('comissoes',              'GERENTE', 'NOVOS', true);

-- GERENTE + SEMINOVOS
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'GERENTE', 'SEMINOVOS', false),
  ('simuladorSeminovos',     'GERENTE', 'SEMINOVOS', true),
  ('dashbi',                 'GERENTE', 'SEMINOVOS', false),
  ('gestao',                 'GERENTE', 'SEMINOVOS', true),
  ('coparticipadoPortal',    'GERENTE', 'SEMINOVOS', true),
  ('analiseScoreVendedores', 'GERENTE', 'SEMINOVOS', true),
  ('comissoes',              'GERENTE', 'SEMINOVOS', true);

-- VENDEDOR + NOVOS (gestao=FALSE — exceção documentada, Fase 9.2)
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'VENDEDOR', 'NOVOS', true),
  ('simuladorSeminovos',     'VENDEDOR', 'NOVOS', false),
  ('dashbi',                 'VENDEDOR', 'NOVOS', false),
  ('gestao',                 'VENDEDOR', 'NOVOS', false),
  ('coparticipadoPortal',    'VENDEDOR', 'NOVOS', false),
  ('analiseScoreVendedores', 'VENDEDOR', 'NOVOS', false),
  ('comissoes',              'VENDEDOR', 'NOVOS', true);

-- VENDEDOR + SEMINOVOS (gestao=FALSE — exceção documentada, Fase 9.2)
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'VENDEDOR', 'SEMINOVOS', false),
  ('simuladorSeminovos',     'VENDEDOR', 'SEMINOVOS', true),
  ('dashbi',                 'VENDEDOR', 'SEMINOVOS', false),
  ('gestao',                 'VENDEDOR', 'SEMINOVOS', false),
  ('coparticipadoPortal',    'VENDEDOR', 'SEMINOVOS', false),
  ('analiseScoreVendedores', 'VENDEDOR', 'SEMINOVOS', false),
  ('comissoes',              'VENDEDOR', 'SEMINOVOS', true);

-- DIRETOR_NOVOS (departamento já implícito no nome do perfil -> TODOS)
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'DIRETOR_NOVOS', 'TODOS', true),
  ('simuladorSeminovos',     'DIRETOR_NOVOS', 'TODOS', true),
  ('dashbi',                 'DIRETOR_NOVOS', 'TODOS', true),
  ('gestao',                 'DIRETOR_NOVOS', 'TODOS', false),
  ('coparticipadoPortal',    'DIRETOR_NOVOS', 'TODOS', true),
  ('analiseScoreVendedores', 'DIRETOR_NOVOS', 'TODOS', true),
  ('comissoes',              'DIRETOR_NOVOS', 'TODOS', true);

-- DIRETOR_SEMINOVOS (assimetria conhecida vs DIRETOR_NOVOS, preservada
-- de propósito — Coparticipado/Score = false, não corrigido nesta fase)
insert into public.permissoes_modulos (modulo_id, perfil, departamento, permitido) values
  ('simuladorCompleto',      'DIRETOR_SEMINOVOS', 'TODOS', true),
  ('simuladorSeminovos',     'DIRETOR_SEMINOVOS', 'TODOS', true),
  ('dashbi',                 'DIRETOR_SEMINOVOS', 'TODOS', true),
  ('gestao',                 'DIRETOR_SEMINOVOS', 'TODOS', false),
  ('coparticipadoPortal',    'DIRETOR_SEMINOVOS', 'TODOS', false),
  ('analiseScoreVendedores', 'DIRETOR_SEMINOVOS', 'TODOS', false),
  ('comissoes',              'DIRETOR_SEMINOVOS', 'TODOS', true);

-- ==========================================================
-- 6. Feature flag — nasce FALSE (motor hardcoded continua ativo)
-- ==========================================================
insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'permissoes_modulos_dinamicas',
  'false',
  'Liga/desliga o motor dinâmico de permissões de módulos (Fase 9.x). '
  'FALSE = Portal usa 100% o motor hardcoded (portalAllowedModules em '
  'index.html), a tabela permissoes_modulos existe mas não é consultada '
  'pelo frontend. TRUE = liberação futura via portal_modulos_permitidos().',
  now()
)
on conflict (chave) do nothing;

-- ==========================================================
-- 7. RPC de leitura — usada pelo usuário logado (via frontend, quando a
--    flag for TRUE numa fase futura). Não recebe nenhum parâmetro de
--    identidade: tudo resolvido a partir de auth.uid().
-- ==========================================================
create or replace function public.portal_modulos_permitidos()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
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

revoke all on function public.portal_modulos_permitidos() from public;
revoke execute on function public.portal_modulos_permitidos() from anon;
grant execute on function public.portal_modulos_permitidos() to authenticated, service_role;

-- ==========================================================
-- 8. RPC MASTER — listagem completa da matriz para a futura UI
-- ==========================================================
create or replace function public.master_listar_permissoes_modulos()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'modulos', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.ordem)
      from public.modulos_portal m
    ), '[]'::jsonb),
    'permissoes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'modulo_id', pm.modulo_id,
        'perfil', pm.perfil,
        'departamento', pm.departamento,
        'permitido', pm.permitido,
        'atualizado_em', pm.atualizado_em
      ) order by pm.modulo_id, pm.perfil, pm.departamento)
      from public.permissoes_modulos pm
    ), '[]'::jsonb),
    'flag_dinamica', coalesce((
      select (lower(trim(c.valor)) = 'true')
      from public.configuracoes c
      where c.chave = 'permissoes_modulos_dinamicas'
    ), false)
  );
end;
$function$;

revoke all on function public.master_listar_permissoes_modulos() from public;
revoke execute on function public.master_listar_permissoes_modulos() from anon;
grant execute on function public.master_listar_permissoes_modulos() to authenticated, service_role;

-- ==========================================================
-- 9. RPC MASTER — escrita em lote, atômica, com controle otimista e
--    auditoria. p_mudancas: array de objetos
--    {modulo_id, perfil, departamento, permitido, atualizado_em_esperado}
--    atualizado_em_esperado (nullable) implementa o controle de
--    concorrência: se a linha mudou desde que a UI carregou, a mudança
--    daquela célula é rejeitada e reportada, sem tocar nas demais.
-- ==========================================================
create or replace function public.master_salvar_permissoes_modulos(p_mudancas jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_master public.usuarios%rowtype;
  v_item jsonb;
  v_modulo_id text;
  v_perfil text;
  v_departamento text;
  v_permitido boolean;
  v_esperado timestamptz;
  v_atual public.permissoes_modulos%rowtype;
  v_configuravel boolean;
  v_aplicadas jsonb := '[]'::jsonb;
  v_conflitos jsonb := '[]'::jsonb;
begin
  select *
    into v_master
  from public.usuarios
  where auth_user_id = auth.uid()
    and ativo = true
    and upper(trim(coalesce(perfil, ''))) = 'MASTER'
  limit 1;

  if v_master.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if p_mudancas is null or jsonb_typeof(p_mudancas) <> 'array' then
    raise exception 'Formato inválido: esperado array de mudanças.'
      using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_mudancas)
  loop
    v_modulo_id := v_item->>'modulo_id';
    v_perfil := upper(trim(coalesce(v_item->>'perfil', '')));
    v_departamento := upper(trim(coalesce(v_item->>'departamento', '')));
    v_permitido := (v_item->>'permitido')::boolean;
    v_esperado := nullif(v_item->>'atualizado_em_esperado', '')::timestamptz;

    if v_perfil = 'MASTER' then
      raise exception 'MASTER não é configurável pela matriz.'
        using errcode = '42501';
    end if;

    select configuravel into v_configuravel
    from public.modulos_portal
    where id = v_modulo_id;

    if v_configuravel is null then
      raise exception 'Módulo inexistente: %', v_modulo_id
        using errcode = '22023';
    end if;
    if v_configuravel = false then
      raise exception 'Módulo % não é configurável pela matriz.', v_modulo_id
        using errcode = '42501';
    end if;

    if v_departamento not in ('TODOS', 'NOVOS', 'SEMINOVOS') then
      raise exception 'Departamento inválido: %', v_departamento
        using errcode = '22023';
    end if;

    select * into v_atual
    from public.permissoes_modulos
    where modulo_id = v_modulo_id and perfil = v_perfil and departamento = v_departamento
    for update;

    if v_atual.modulo_id is null then
      raise exception 'Combinação módulo/perfil/departamento inexistente: %/%/%',
        v_modulo_id, v_perfil, v_departamento
        using errcode = '22023';
    end if;

    -- Controle de concorrência otimista: se o chamador informou o
    -- timestamp que viu ao carregar a UI e ele não bate com o atual,
    -- outro MASTER alterou essa célula entretanto — registra o
    -- conflito e pula, sem tocar nas demais mudanças do lote.
    if v_esperado is not null and v_atual.atualizado_em <> v_esperado then
      v_conflitos := v_conflitos || jsonb_build_object(
        'modulo_id', v_modulo_id, 'perfil', v_perfil, 'departamento', v_departamento,
        'motivo', 'CONFLITO_CONCORRENCIA'
      );
      continue;
    end if;

    if v_atual.permitido is distinct from v_permitido then
      insert into public.permissoes_modulos_auditoria
        (modulo_id, perfil, departamento, valor_anterior, valor_novo, alterado_por)
      values
        (v_modulo_id, v_perfil, v_departamento, v_atual.permitido, v_permitido, v_master.id);

      update public.permissoes_modulos
      set permitido = v_permitido,
          atualizado_em = now(),
          atualizado_por = v_master.id
      where modulo_id = v_modulo_id and perfil = v_perfil and departamento = v_departamento;

      v_aplicadas := v_aplicadas || jsonb_build_object(
        'modulo_id', v_modulo_id, 'perfil', v_perfil, 'departamento', v_departamento,
        'valor_anterior', v_atual.permitido, 'valor_novo', v_permitido
      );
    end if;
  end loop;

  return jsonb_build_object('aplicadas', v_aplicadas, 'conflitos', v_conflitos);
end;
$function$;

revoke all on function public.master_salvar_permissoes_modulos(jsonb) from public;
revoke execute on function public.master_salvar_permissoes_modulos(jsonb) from anon;
grant execute on function public.master_salvar_permissoes_modulos(jsonb) to authenticated, service_role;

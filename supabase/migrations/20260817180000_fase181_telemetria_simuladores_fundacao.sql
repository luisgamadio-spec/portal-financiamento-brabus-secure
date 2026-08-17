-- Fase 18.1 — fundação backend da telemetria de utilização dos
-- simuladores (Novos/Seminovos). SOMENTE infraestrutura: schema, RLS,
-- RPCs. Nenhum frontend chama isso ainda (Fase 18.2/18.3). Flag
-- 'telemetria_simuladores_ativa' nasce FALSE — todas as RPCs de escrita
-- são no-op seguro (nunca erro) enquanto ela estiver desligada.
--
-- Identidade sempre resolvida por auth.uid() dentro de cada RPC — nunca
-- por parâmetro do cliente. Nenhum dado de simulação (valores, CPF de
-- cliente, chassi, taxa, parcela etc.) é armazenado; só metadados de
-- utilização (quem, qual módulo, quando, tempo ativo aproximado,
-- contagem de simulações).

create table public.portal_module_sessions (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios(id) on delete restrict,
  module_id text not null,
  loja_snapshot text,
  perfil_snapshot text,
  departamento_snapshot text,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  ended_at timestamptz null,
  close_reason text null,
  active_seconds integer not null default 0,
  simulation_count integer not null default 0,
  criado_em timestamptz not null default now(),
  -- module_id como CHECK (não ENUM) — fácil de ampliar em fase futura
  -- (Fase 18.0, Parte AV) sem ALTER TYPE. Hoje só os dois simuladores
  -- reais existem; a Fase 18.0 mapeou explicitamente os módulos-alvo.
  constraint portal_module_sessions_module_id_check
    check (module_id in ('simuladorCompleto','simuladorSeminovos')),
  constraint portal_module_sessions_close_reason_check
    check (close_reason is null or close_reason in ('back','switch_module','logout','pagehide','timeout','other')),
  constraint portal_module_sessions_active_seconds_check
    check (active_seconds >= 0),
  constraint portal_module_sessions_simulation_count_check
    check (simulation_count >= 0)
);

create index portal_module_sessions_usuario_id_idx on public.portal_module_sessions(usuario_id);
create index portal_module_sessions_module_id_idx on public.portal_module_sessions(module_id);
create index portal_module_sessions_started_at_idx on public.portal_module_sessions(started_at);
create index portal_module_sessions_module_started_idx on public.portal_module_sessions(module_id, started_at);
create index portal_module_sessions_usuario_started_idx on public.portal_module_sessions(usuario_id, started_at);

-- RLS habilitada, ZERO policies — mesmo padrão de ativacoes_acesso_usuario
-- (Fase 4.2): nenhum SELECT/INSERT/UPDATE/DELETE direto de anon/authenticated.
-- Toda escrita/leitura passa exclusivamente pelas RPCs SECURITY DEFINER
-- abaixo. Reforçado com REVOKE explícito (Parte M) por defesa em profundidade.
alter table public.portal_module_sessions enable row level security;
revoke all on public.portal_module_sessions from anon, authenticated;

-- Feature flag (Parte AN) — mesmo padrão de 'ativacao_acesso_global'
-- (tabela configuracoes chave/valor já existente, não uma tabela nova).
-- Nasce FALSE: infraestrutura presente, coleta real = zero até 18.2/18.3
-- ligarem explicitamente (e mesmo depois, serve de kill-switch instantâneo).
insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'telemetria_simuladores_ativa', 'false',
  'Liga/desliga a coleta de telemetria de utilização dos Simuladores de Novos/Seminovos (Fase 18.x). Quando false, as RPCs portal_telemetry_* retornam {ok:true, enabled:false} sem gravar nada.',
  now()
)
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------
-- portal_telemetry_start_session — chamada pelo Portal pai no momento
-- exato de showPortalIframeModule(id) (Fase 18.0, Parte C). Resolve
-- identidade/loja/perfil/departamento SEMPRE a partir de auth.uid(),
-- nunca de HOMOLOGATION_USER/currentPortalUser() (que só existem no
-- frontend) e reaproveita portal_modulos_permitidos() (Parte O) — não
-- reimplementa a lógica de permissão.
-- ---------------------------------------------------------------------
create or replace function public.portal_telemetry_start_session(p_module_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_flag text;
  v_user public.usuarios%rowtype;
  v_permitidos jsonb;
  v_session_id uuid;
begin
  select valor into v_flag from public.configuracoes where chave = 'telemetria_simuladores_ativa';
  if coalesce(lower(trim(v_flag)), 'false') <> 'true' then
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;

  if p_module_id is null or p_module_id not in ('simuladorCompleto','simuladorSeminovos') then
    return jsonb_build_object('ok', false, 'codigo', 'MODULO_INVALIDO');
  end if;

  select * into v_user from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_AUTORIZADO');
  end if;

  -- Não basta estar autenticado: precisa ter o módulo realmente permitido
  -- (Fase 18.1, Parte O) — nunca confiar que o card só aparece para quem
  -- já tem acesso.
  v_permitidos := public.portal_modulos_permitidos();
  if not (v_permitidos ? p_module_id) then
    return jsonb_build_object('ok', false, 'codigo', 'MODULO_NAO_PERMITIDO');
  end if;

  insert into public.portal_module_sessions (
    usuario_id, module_id, loja_snapshot, perfil_snapshot, departamento_snapshot
  ) values (
    v_user.id, p_module_id, v_user.loja, v_user.perfil, v_user.status
  )
  returning id into v_session_id;

  return jsonb_build_object('ok', true, 'enabled', true, 'session_id', v_session_id, 'started_at', now());
end;
$function$;

-- ---------------------------------------------------------------------
-- portal_telemetry_heartbeat — chamada pela ponte do iframe (mesmo
-- padrão de simuladorGetBase) a cada ~60s enquanto o simulador está
-- aberto e o cliente considera o usuário ativo. O incremento de
-- active_seconds é 100% calculado no servidor a partir do intervalo real
-- entre heartbeats (Parte G/R) — o cliente nunca informa quantos segundos
-- ficou ativo. Gaps maiores que o timeout de inatividade homologado na
-- Fase 18.0 (5 min) não somam tempo ativo (tratados como ociosidade).
-- Sessões além do teto lógico de 8h (Parte J) são encerradas aqui mesmo,
-- sem depender de cron.
-- ---------------------------------------------------------------------
create or replace function public.portal_telemetry_heartbeat(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_flag text;
  v_user_id uuid;
  v_row public.portal_module_sessions%rowtype;
  v_delta integer;
  v_now timestamptz := now();
begin
  select valor into v_flag from public.configuracoes where chave = 'telemetria_simuladores_ativa';
  if coalesce(lower(trim(v_flag)), 'false') <> 'true' then
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;

  select id into v_user_id from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_AUTORIZADO');
  end if;

  select * into v_row from public.portal_module_sessions where id = p_session_id for update;
  if v_row.id is null or v_row.usuario_id <> v_user_id then
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_INVALIDA');
  end if;
  if v_row.ended_at is not null then
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_ENCERRADA');
  end if;

  if v_row.started_at < v_now - interval '8 hours' then
    update public.portal_module_sessions
      set ended_at = v_row.last_heartbeat_at, close_reason = 'timeout'
      where id = p_session_id;
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_EXPIRADA');
  end if;

  v_delta := greatest(0, least(60, floor(extract(epoch from (v_now - v_row.last_heartbeat_at)))::integer));
  if v_now - v_row.last_heartbeat_at > interval '5 minutes' then
    v_delta := 0;
  end if;

  update public.portal_module_sessions
    set last_heartbeat_at = v_now,
        active_seconds = active_seconds + v_delta
    where id = p_session_id;

  return jsonb_build_object('ok', true, 'enabled', true, 'active_seconds_delta', v_delta);
end;
$function$;

-- ---------------------------------------------------------------------
-- portal_telemetry_simulation — chamada pela ponte do iframe exatamente
-- quando o próprio simulador confirma "simulação calculada com sucesso"
-- (Fase 18.0, Parte K/L/M/N: calc*(true), nunca calc*(false)/recálculo
-- automático). Cliente não envia quantidade — só sinaliza "+1"; a RPC
-- não aceita nenhum outro valor (Parte U/AJ).
-- ---------------------------------------------------------------------
create or replace function public.portal_telemetry_simulation(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_flag text;
  v_user_id uuid;
  v_row public.portal_module_sessions%rowtype;
begin
  select valor into v_flag from public.configuracoes where chave = 'telemetria_simuladores_ativa';
  if coalesce(lower(trim(v_flag)), 'false') <> 'true' then
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;

  select id into v_user_id from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_AUTORIZADO');
  end if;

  select * into v_row from public.portal_module_sessions where id = p_session_id for update;
  if v_row.id is null or v_row.usuario_id <> v_user_id then
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_INVALIDA');
  end if;
  if v_row.ended_at is not null then
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_ENCERRADA');
  end if;

  update public.portal_module_sessions
    set simulation_count = simulation_count + 1,
        last_heartbeat_at = now()
    where id = p_session_id;

  return jsonb_build_object('ok', true, 'enabled', true);
end;
$function$;

-- ---------------------------------------------------------------------
-- portal_telemetry_end_session — encerramento explícito (voltar ao
-- Portal, trocar de módulo, logout). Fase 18.0/18.1 avaliaram e optaram
-- por criar esta 4ª RPC em vez de inferir só por heartbeat expirado:
-- "clareza e dados corretos > economia artificial de uma RPC" (regra
-- explícita desta fase). Idempotente — chamar duas vezes não sobrescreve
-- ended_at/close_reason já gravados.
-- ---------------------------------------------------------------------
create or replace function public.portal_telemetry_end_session(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_flag text;
  v_user_id uuid;
  v_row public.portal_module_sessions%rowtype;
  v_reason text;
begin
  select valor into v_flag from public.configuracoes where chave = 'telemetria_simuladores_ativa';
  if coalesce(lower(trim(v_flag)), 'false') <> 'true' then
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;

  v_reason := lower(trim(coalesce(p_reason, '')));
  if v_reason not in ('back','switch_module','logout','pagehide','timeout','other') then
    v_reason := 'other';
  end if;

  select id into v_user_id from public.usuarios where auth_user_id = auth.uid() and ativo = true limit 1;
  if v_user_id is null then
    return jsonb_build_object('ok', false, 'codigo', 'USUARIO_NAO_AUTORIZADO');
  end if;

  select * into v_row from public.portal_module_sessions where id = p_session_id for update;
  if v_row.id is null or v_row.usuario_id <> v_user_id then
    return jsonb_build_object('ok', false, 'codigo', 'SESSAO_INVALIDA');
  end if;
  if v_row.ended_at is not null then
    return jsonb_build_object('ok', true, 'enabled', true, 'ja_encerrada', true);
  end if;

  update public.portal_module_sessions
    set ended_at = now(), close_reason = v_reason
    where id = p_session_id and ended_at is null;

  return jsonb_build_object('ok', true, 'enabled', true);
end;
$function$;

-- ---------------------------------------------------------------------
-- master_simulator_usage_data — leitura agregada MASTER-only, para a
-- futura aba "Utilização dos Simuladores" (Fase 18.4). Nunca despeja
-- sessão bruta por padrão — sempre agregado por usuário+módulo. Default
-- de período (90 dias) evita histórico ilimitado acidental (Parte AA).
-- "Usuários que nunca utilizaram" (Parte AC) fica deliberadamente FORA
-- desta função — exigiria resolver permissões de TODOS os usuários do
-- sistema (não só do chamador), o que portal_modulos_permitidos() não
-- suporta hoje; documentado como limitação, fica para a Fase 18.4.
-- ---------------------------------------------------------------------
create or replace function public.master_simulator_usage_data(
  p_start_date timestamptz default null,
  p_end_date timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_master public.usuarios%rowtype;
  v_start timestamptz := coalesce(p_start_date, now() - interval '90 days');
  v_end timestamptz := coalesce(p_end_date, now());
begin
  select * into v_master from public.usuarios
  where auth_user_id = auth.uid() and ativo = true and upper(trim(coalesce(perfil,''))) = 'MASTER'
  limit 1;
  if v_master.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'periodo_inicio', v_start,
    'periodo_fim', v_end,
    'limitacao', 'Não inclui usuários sem nenhuma sessão registrada (ver Fase 18.4).',
    'linhas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'usuario_id', agg.usuario_id,
        'nome', u.nome,
        'module_id', agg.module_id,
        'loja_relatorio', agg.loja_relatorio,
        'perfil_relatorio', agg.perfil_relatorio,
        'departamento_relatorio', agg.departamento_relatorio,
        'sessions', agg.sessions,
        'simulation_count', agg.simulation_count,
        'active_seconds', agg.active_seconds,
        'active_days', agg.active_days,
        'first_use', agg.first_use,
        'last_use', agg.last_use
      ) order by agg.last_use desc)
      from (
        select
          s.usuario_id, s.module_id,
          count(*) as sessions,
          sum(s.simulation_count) as simulation_count,
          sum(s.active_seconds) as active_seconds,
          count(distinct ((s.started_at at time zone 'America/Sao_Paulo')::date)) as active_days,
          min(s.started_at) as first_use,
          max(s.started_at) as last_use,
          (array_agg(s.loja_snapshot order by s.started_at desc))[1] as loja_relatorio,
          (array_agg(s.perfil_snapshot order by s.started_at desc))[1] as perfil_relatorio,
          (array_agg(s.departamento_snapshot order by s.started_at desc))[1] as departamento_relatorio
        from public.portal_module_sessions s
        where s.started_at >= v_start and s.started_at <= v_end
        group by s.usuario_id, s.module_id
      ) agg
      join public.usuarios u on u.id = agg.usuario_id
    ), '[]'::jsonb)
  );
end;
$function$;

-- Grants mínimos: authenticated pode EXECUTAR as RPCs de escrita/uso
-- (elas mesmas fazem todo o controle de identidade/permissão via
-- auth.uid() por dentro — nunca confiar em GRANT como única barreira,
-- mas também não bloquear usuário legítimo de chamar a função).
-- master_simulator_usage_data também é EXECUTE-able por authenticated —
-- a própria função nega com exceção 42501 quem não for MASTER ativo.
grant execute on function public.portal_telemetry_start_session(text) to authenticated;
grant execute on function public.portal_telemetry_heartbeat(uuid) to authenticated;
grant execute on function public.portal_telemetry_simulation(uuid) to authenticated;
grant execute on function public.portal_telemetry_end_session(uuid, text) to authenticated;
grant execute on function public.master_simulator_usage_data(timestamptz, timestamptz) to authenticated;

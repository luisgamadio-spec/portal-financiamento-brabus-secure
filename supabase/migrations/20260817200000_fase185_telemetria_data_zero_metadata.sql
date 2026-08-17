-- Fase 18.5 — Parte 1/2: suporte a "data zero" da telemetria dos
-- simuladores. SOMENTE metadata — telemetria_simuladores_ativa permanece
-- FALSE, nenhuma sessão é gerada, nenhum comportamento de coleta muda.
--
-- Cria a chave de configuração que vai guardar o timestamp oficial da
-- virada (preenchida separadamente, na Parte 2/2, de forma atômica com a
-- própria flag) e estende master_simulator_usage_data() para devolver
-- telemetry_enabled/telemetry_started_at junto com os dados agregados —
-- o Painel Master deixa de inferir "coleta não iniciada" pela ausência de
-- linhas (Fase 18.4) e passa a conhecer o estado oficial diretamente.

insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'telemetria_simuladores_started_at', '',
  'Timestamp UTC oficial (ISO 8601) do início real da coleta de telemetria de utilização dos Simuladores (Fase 18.5). Vazio enquanto a coleta nunca foi iniciada oficialmente. Gravado atomicamente junto com telemetria_simuladores_ativa=true — nunca sobrescrito depois de definido.',
  now()
)
on conflict (chave) do nothing;

create or replace function public.master_simulator_usage_data(p_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_master public.usuarios%rowtype;
  v_start timestamptz := coalesce(p_start_date, now() - interval '90 days');
  v_end timestamptz := coalesce(p_end_date, now());
  v_flag text;
  v_started_at_raw text;
  v_started_at timestamptz;
begin
  select * into v_master from public.usuarios
  where auth_user_id = auth.uid() and ativo = true and upper(trim(coalesce(perfil,''))) = 'MASTER'
  limit 1;
  if v_master.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  select valor into v_flag from public.configuracoes where chave = 'telemetria_simuladores_ativa';
  select valor into v_started_at_raw from public.configuracoes where chave = 'telemetria_simuladores_started_at';
  begin
    v_started_at := nullif(trim(coalesce(v_started_at_raw, '')), '')::timestamptz;
  exception when others then
    v_started_at := null;
  end;

  return jsonb_build_object(
    'periodo_inicio', v_start,
    'periodo_fim', v_end,
    'limitacao', 'Não inclui usuários sem nenhuma sessão registrada (ver Fase 18.4).',
    'telemetry_enabled', coalesce(lower(trim(v_flag)), 'false') = 'true',
    'telemetry_started_at', v_started_at,
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

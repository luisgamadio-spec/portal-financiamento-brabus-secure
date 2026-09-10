-- ============================================================
-- [RANKING] PERF-5C -- FECHAMENTO / REABERTURA GOVERNADOS
-- ============================================================
--
-- master_performance_criar_periodo   -- cria o mes calendario (OPEN)
-- master_performance_fechar_periodo  -- fecha atomicamente, materializa
--                                       snapshot versionado
-- master_performance_reabrir_periodo -- H9: somente MASTER, com motivo,
--                                       preserva o snapshot original
--
-- AUTORIDADE: MASTER apenas, nas tres. Nenhuma permissao e inferida de
-- papel de Salario/RH.
--
-- ATOMICIDADE: o fechamento e uma unica transacao. Qualquer falha derruba
-- tudo -- nao existe mes meio-fechado.
--
-- PONTUACAO: rank() sobre o valor decrescente = competition ranking, que e
-- exatamente FULL_POINTS_COMPETITION_RANKING: empatados na 1a posicao
-- recebem TODOS 35; o proximo cai para a posicao 3 e nao pontua.
-- Metrica <= 0 nao entra no ranking.
--
-- G6: quando a categoria SPF nao e aplicavel, und_spf/rank/pontos ficam
-- NULL (NAO APLICAVEL) e max_score = 85. Gravar 0 significaria "disputou
-- e perdeu", que e falso.

create or replace function public.master_performance_criar_periodo(
  p_mes date
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ator public.usuarios;
  v_inicio date := date_trunc('month', p_mes)::date;
  v_fim date := (date_trunc('month', p_mes) + interval '1 month - 1 day')::date;
  v_regra uuid;
  v_id uuid;
begin
  select u.* into v_ator from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil,''))) = 'MASTER' limit 1;
  if v_ator.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  select id into v_regra from public.performance_regra_versao
   order by criado_em desc limit 1;
  if v_regra is null then
    raise exception 'Nenhuma versao de regra do Ranking cadastrada.' using errcode = '22023';
  end if;

  select id into v_id from public.performance_periodo
   where tipo = 'MONTH' and data_inicio = v_inicio;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'periodo_id', v_id, 'ja_existia', true);
  end if;

  insert into public.performance_periodo (tipo, data_inicio, data_fim, status, regra_versao_id)
  values ('MONTH', v_inicio, v_fim, 'OPEN', v_regra)
  returning id into v_id;

  insert into public.performance_auditoria (evento, periodo_id, ator_usuario_id, motivo, metadados)
  values ('PERIOD_CREATED', v_id, v_ator.id, 'Criacao de periodo mensal de Performance.',
    jsonb_build_object('inicio', v_inicio, 'fim', v_fim));

  return jsonb_build_object('ok', true, 'periodo_id', v_id, 'ja_existia', false);
end;
$function$;

-- ------------------------------------------------------------
create or replace function public.master_performance_fechar_periodo(
  p_periodo_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ator public.usuarios;
  v_p public.performance_periodo;
  v_r public.performance_regra_versao;
  v_spf_ok boolean;
  v_max int;
  v_versao int;
  v_snap uuid;
  v_ops int; v_ret numeric; v_nao int;
  v_procs text[];
begin
  select u.* into v_ator from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil,''))) = 'MASTER' limit 1;
  if v_ator.id is null then
    insert into public.performance_auditoria (evento, periodo_id, motivo)
    values ('CLOSE_DENIED', p_periodo_id, 'Chamador nao e MASTER.');
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  -- trava a linha do periodo: dois fechamentos concorrentes serializam
  select * into v_p from public.performance_periodo where id = p_periodo_id for update;
  if v_p.id is null then
    raise exception 'Periodo de Performance inexistente.' using errcode = '22023';
  end if;

  -- idempotencia explicita: fechar de novo sem reabrir e recusado
  if v_p.status = 'CLOSED' then
    insert into public.performance_auditoria (evento, periodo_id, ator_usuario_id, motivo)
    values ('CLOSE_DENIED', v_p.id, v_ator.id, 'Periodo ja esta FECHADO; reabra antes de refechar.');
    raise exception 'Periodo ja esta FECHADO. Reabra antes de fechar novamente.' using errcode = '22023';
  end if;

  select * into v_r from public.performance_regra_versao where id = v_p.regra_versao_id;

  -- G6/H8: aplicabilidade da categoria SPF pela data de inicio do programa
  v_spf_ok := v_p.data_fim >= v_r.spf_programa_inicio;
  v_max := case when v_spf_ok then 100 else 85 end;

  select coalesce(max(snapshot_versao), 0) + 1 into v_versao
  from public.performance_snapshot where periodo_id = v_p.id;

  -- reentrante: dois fechamentos na mesma transacao/sessao nao colidem
  drop table if exists _calc;
  drop table if exists _m;
  create temp table _calc on commit drop as
  select * from public.performance_calcular_periodo(v_p.data_inicio, v_p.data_fim);

  select count(*)::int, coalesce(sum(retorno),0),
         coalesce(sum(operacoes) filter (where analista_usuario_id is null),0)::int
    into v_ops, v_ret, v_nao from _calc;
  select coalesce(sum(operacoes),0)::int into v_ops from _calc;

  select coalesce(array_agg(distinct responsabilidade_procedencia), array[]::text[])
    into v_procs from _calc where analista_usuario_id is not null;

  insert into public.performance_snapshot (
    periodo_id, snapshot_versao, regra_versao_id, responsabilidade_procedencias,
    resolver_g4, spf_aplicavel, max_score, fonte_fingerprint,
    operacoes_consideradas, retorno_total, operacoes_nao_atribuidas, criado_por)
  values (v_p.id, v_versao, v_r.id, v_procs, v_r.resolver_g4, v_spf_ok, v_max,
    md5(v_p.data_inicio::text || '|' || v_p.data_fim::text || '|' || v_r.versao || '|'
        || v_ops::text || '|' || v_ret::text),
    v_ops, v_ret, v_nao, v_ator.id)
  returning id into v_snap;

  -- metricas por analista
  create temp table _m on commit drop as
  select analista_usuario_id an,
    coalesce(sum(retorno) filter (where departamento = 'NOVOS'), 0)
      + coalesce(sum(spf_valor) filter (where departamento = 'NOVOS'), 0) * v_r.spf_percentual_bruto / 100 as novos,
    coalesce(sum(retorno) filter (where departamento = 'SEMINOVOS'), 0)
      + coalesce(sum(spf_valor) filter (where departamento = 'SEMINOVOS'), 0) * v_r.spf_percentual_bruto / 100 as semi,
    coalesce(sum(operacoes), 0)::int as und_fin,
    coalesce(sum(spf_unidades), 0)::int as und_spf
  from _calc where analista_usuario_id is not null group by 1;

  insert into public.performance_snapshot_resultado (
    snapshot_id, analista_usuario_id, retorno_novos, retorno_seminovos,
    und_financiado, und_spf,
    rank_retorno_novos, pontos_retorno_novos,
    rank_retorno_seminovos, pontos_retorno_seminovos,
    rank_und_financiado, pontos_und_financiado,
    rank_und_spf, pontos_und_spf, pontos_total, max_score)
  select v_snap, m.an, m.novos, m.semi, m.und_fin,
    case when v_spf_ok then m.und_spf else null end,
    rn.r, coalesce(case rn.r when 1 then v_r.pontos_retorno_novos_1
                             when 2 then v_r.pontos_retorno_novos_2 else 0 end, 0),
    rs.r, coalesce(case rs.r when 1 then v_r.pontos_retorno_seminovos_1
                             when 2 then v_r.pontos_retorno_seminovos_2 else 0 end, 0),
    rf.r, coalesce(case rf.r when 1 then v_r.pontos_und_financiado_1
                             when 2 then v_r.pontos_und_financiado_2 else 0 end, 0),
    case when v_spf_ok then rp.r else null end,
    case when v_spf_ok then coalesce(case rp.r when 1 then v_r.pontos_und_spf_1
                                               when 2 then v_r.pontos_und_spf_2 else 0 end, 0)
         else null end,
    coalesce(case rn.r when 1 then v_r.pontos_retorno_novos_1
                       when 2 then v_r.pontos_retorno_novos_2 else 0 end, 0)
    + coalesce(case rs.r when 1 then v_r.pontos_retorno_seminovos_1
                         when 2 then v_r.pontos_retorno_seminovos_2 else 0 end, 0)
    + coalesce(case rf.r when 1 then v_r.pontos_und_financiado_1
                         when 2 then v_r.pontos_und_financiado_2 else 0 end, 0)
    + case when v_spf_ok then coalesce(case rp.r when 1 then v_r.pontos_und_spf_1
                                                 when 2 then v_r.pontos_und_spf_2 else 0 end, 0)
           else 0 end,
    v_max
  from _m m
  left join (select an, rank() over (order by novos desc) r from _m where novos > 0) rn on rn.an = m.an
  left join (select an, rank() over (order by semi desc) r from _m where semi > 0) rs on rs.an = m.an
  left join (select an, rank() over (order by und_fin desc) r from _m where und_fin > 0) rf on rf.an = m.an
  left join (select an, rank() over (order by und_spf desc) r from _m where und_spf > 0) rp on rp.an = m.an;

  insert into public.performance_snapshot_detalhe (
    snapshot_id, analista_usuario_id, loja, departamento, operacoes, retorno,
    spf_unidades, responsabilidade_procedencia, loja_normalizada_de)
  select v_snap, c.analista_usuario_id, c.loja, c.departamento, c.operacoes,
    c.retorno, c.spf_unidades, c.responsabilidade_procedencia, c.loja_origem_codigo
  from _calc c where c.analista_usuario_id is not null;

  update public.performance_periodo
     set status = 'CLOSED', closed_at = now(), closed_by = v_ator.id,
         current_snapshot_id = v_snap
   where id = v_p.id;

  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo, metadados)
  values ('SNAPSHOT_CREATED', v_p.id, v_snap, v_ator.id, coalesce(p_motivo, 'Fechamento de periodo.'),
    jsonb_build_object('versao', v_versao, 'spf_aplicavel', v_spf_ok, 'max_score', v_max));
  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo)
  values ('PERIOD_CLOSED', v_p.id, v_snap, v_ator.id, coalesce(p_motivo, 'Fechamento de periodo.'));

  return jsonb_build_object('ok', true, 'periodo_id', v_p.id, 'snapshot_id', v_snap,
    'versao', v_versao, 'spf_aplicavel', v_spf_ok, 'max_score', v_max,
    'operacoes', v_ops, 'nao_atribuidas', v_nao);
end;
$function$;

-- ------------------------------------------------------------
-- H9: reabertura -- MASTER, motivo obrigatorio, snapshot preservado
create or replace function public.master_performance_reabrir_periodo(
  p_periodo_id uuid,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_ator public.usuarios;
  v_p public.performance_periodo;
  v_snap uuid;
begin
  select u.* into v_ator from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil,''))) = 'MASTER' limit 1;
  if v_ator.id is null then
    insert into public.performance_auditoria (evento, periodo_id, motivo)
    values ('REOPEN_DENIED', p_periodo_id, 'Chamador nao e MASTER.');
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if p_motivo is null or btrim(p_motivo) = '' then
    insert into public.performance_auditoria (evento, periodo_id, ator_usuario_id, motivo)
    values ('REOPEN_DENIED', p_periodo_id, v_ator.id, 'Motivo ausente.');
    raise exception 'Reabertura exige motivo explicito.' using errcode = '22023';
  end if;

  select * into v_p from public.performance_periodo where id = p_periodo_id for update;
  if v_p.id is null then
    raise exception 'Periodo de Performance inexistente.' using errcode = '22023';
  end if;
  if v_p.status <> 'CLOSED' then
    insert into public.performance_auditoria (evento, periodo_id, ator_usuario_id, motivo)
    values ('REOPEN_DENIED', v_p.id, v_ator.id, 'Periodo nao esta FECHADO.');
    raise exception 'Somente periodo FECHADO pode ser reaberto.' using errcode = '22023';
  end if;

  v_snap := v_p.current_snapshot_id;

  -- marca supersession NO CABECALHO, sem apagar nada. A trava de
  -- imutabilidade so libera esta escrita dentro desta RPC.
  perform set_config('performance.supersession', 'on', true);
  update public.performance_snapshot
     set superseded_at = now(), superseded_by = v_ator.id, supersession_motivo = p_motivo
   where id = v_snap;
  perform set_config('performance.supersession', 'off', true);

  update public.performance_periodo
     set status = 'OPEN', closed_at = null, closed_by = null, current_snapshot_id = null
   where id = v_p.id;

  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo)
  values ('SNAPSHOT_SUPERSEDED', v_p.id, v_snap, v_ator.id, p_motivo);
  insert into public.performance_auditoria (evento, periodo_id, snapshot_id, ator_usuario_id, motivo)
  values ('PERIOD_REOPENED', v_p.id, v_snap, v_ator.id, p_motivo);

  return jsonb_build_object('ok', true, 'periodo_id', v_p.id,
    'snapshot_preservado', v_snap, 'status', 'OPEN');
end;
$function$;

-- ------------------------------------------------------------
-- Leitura: MASTER, RH/DP e ANALISTA veem todos os resultados.
create or replace function public.performance_ranking_periodo(
  p_periodo_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_perfil text;
  v_p public.performance_periodo;
  v_rows jsonb;
begin
  select upper(trim(coalesce(u.perfil,''))) into v_perfil from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true limit 1;
  if v_perfil is null or v_perfil not in ('MASTER','RH','DP','ANALISTA') then
    raise exception 'Ranking visivel apenas para MASTER, RH/DP e ANALISTA.' using errcode = '42501';
  end if;

  select * into v_p from public.performance_periodo where id = p_periodo_id;
  if v_p.id is null then
    raise exception 'Periodo de Performance inexistente.' using errcode = '22023';
  end if;

  if v_p.status = 'CLOSED' then
    select coalesce(jsonb_agg(jsonb_build_object(
        'analista_usuario_id', r.analista_usuario_id,
        'retorno_novos', r.retorno_novos, 'retorno_seminovos', r.retorno_seminovos,
        'und_financiado', r.und_financiado, 'und_spf', r.und_spf,
        'pontos_total', r.pontos_total, 'max_score', r.max_score)
      order by r.pontos_total desc), '[]'::jsonb) into v_rows
    from public.performance_snapshot_resultado r where r.snapshot_id = v_p.current_snapshot_id;
    return jsonb_build_object('periodo_id', v_p.id, 'status', 'CLOSED',
      'imutavel', true, 'snapshot_id', v_p.current_snapshot_id, 'rows', v_rows);
  end if;

  return jsonb_build_object('periodo_id', v_p.id, 'status', 'OPEN',
    'imutavel', false, 'snapshot_id', null,
    'aviso', 'Periodo ABERTO: resultado e provisorio e muda com a origem.');
end;
$function$;

revoke all on function public.master_performance_criar_periodo(date) from public, anon, authenticated;
revoke all on function public.master_performance_fechar_periodo(uuid, text) from public, anon, authenticated;
revoke all on function public.master_performance_reabrir_periodo(uuid, text) from public, anon, authenticated;
revoke all on function public.performance_ranking_periodo(uuid) from public, anon;

grant execute on function public.master_performance_criar_periodo(date) to authenticated, service_role;
grant execute on function public.master_performance_fechar_periodo(uuid, text) to authenticated, service_role;
grant execute on function public.master_performance_reabrir_periodo(uuid, text) to authenticated, service_role;
grant execute on function public.performance_ranking_periodo(uuid) to authenticated, service_role;

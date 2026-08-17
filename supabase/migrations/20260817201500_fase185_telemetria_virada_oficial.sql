-- Fase 18.5 — Parte 2/2: virada oficial FALSE → TRUE.
--
-- Este é o instante em que a coleta real de utilização dos simuladores
-- passa a valer oficialmente. As duas gravações (started_at e a própria
-- flag) acontecem na MESMA transação — não existe um estado intermediário
-- onde uma já mudou e a outra não.
--
-- Idempotente por desenho (Parte E): se telemetria_simuladores_started_at
-- já tiver um valor não vazio E telemetria_simuladores_ativa já for
-- 'true', esta migration não faz nada — a data zero oficial nunca é
-- sobrescrita por uma reexecução acidental.

do $$
declare
  v_ja_ativo boolean;
  v_started_at_atual text;
begin
  select coalesce(lower(trim(valor)), 'false') = 'true'
  into v_ja_ativo
  from public.configuracoes where chave = 'telemetria_simuladores_ativa';

  select valor into v_started_at_atual
  from public.configuracoes where chave = 'telemetria_simuladores_started_at';

  if v_ja_ativo and nullif(trim(coalesce(v_started_at_atual, '')), '') is not null then
    raise notice 'Virada já executada anteriormente (started_at=%). Nada a fazer.', v_started_at_atual;
    return;
  end if;

  update public.configuracoes
  set valor = to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      atualizado_em = now()
  where chave = 'telemetria_simuladores_started_at'
    and nullif(trim(coalesce(valor, '')), '') is null;

  update public.configuracoes
  set valor = 'true',
      atualizado_em = now()
  where chave = 'telemetria_simuladores_ativa';
end $$;

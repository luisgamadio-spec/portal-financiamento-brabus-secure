-- ============================================================
-- [RANKING] PERF-5A.2 -- RESOLUCAO HUMANA DA POSSE CONCORRENTE (G18)
-- ============================================================
--
-- CONTEXTO
-- PERF-5A.1 provou, a nivel de UUID, que duas Analistas detinham duas
-- lojas simultaneamente em 2026 -- nao por defeito do PERF-5, mas porque
-- ABC e BARRA FUNDA tinham evidencia historica propria apontando para as
-- mesmas pessoas de H3/H4. Nenhuma das duas lojas tinha titular
-- alternativo deterministico, entao NADA foi escrito e a decisao subiu
-- para o Humano.
--
-- DECISAO HUMANA (nomes completos exatos, fornecidos pelo Humano)
--   H5: ABC          -> DAIANE BRAZIL PONTES PEIXOTO
--   H6: BARRA FUNDA  -> GIOVANNA CRISTINA RIVERA
--
-- ESCOPO TEMPORAL EXATO (so os intervalos que G18 levantou)
--   H5: [2026-01-01, 2026-08-21)   -- 01/01 a 20/08
--   H6: [2026-01-01, 2026-07-22)   -- 01/01 a 21/07
--
-- O QUE ESTA MIGRACAO **NAO** FAZ
--   - nao toca a vigencia ABERTA de ABC (21/08 em diante);
--   - nao toca a autoridade posterior de BARRA FUNDA (22/07 em diante);
--   - nao toca H3 (ANALIA FRANCO -> Denise Rodrigues);
--   - nao toca H4 (BANDEIRANTES -> Willian Inacio);
--   - NAO TOCA SALARIO: nenhuma funcao, fechamento ou snapshot de
--     comissao e lido como autoridade nem escrito.
--
-- SUBSTITUI, NAO EMPILHA: as 4 linhas historicas anteriores passam a
-- status='SUPERSEDED' (mecanismo nativo da tabela -- o EXCLUDE de
-- sobreposicao so considera ACTIVE) e permanecem inspecionaveis. Nenhuma
-- linha de auditoria e apagada; cada efeito gera um novo evento.
--
-- IDENTIDADE: resolvida por nome completo EXATO, normalizando apenas
-- caixa e espacos. Sem fuzzy, sem substring, sem fonetica, sem ordem
-- alfabetica, sem usar a loja atual como identidade. Ambiguidade ou
-- ausencia ABORTA a migracao.
--
-- IDEMPOTENTE: se a correcao ja estiver aplicada, nao faz nada.

do $perf5a2$
declare
  v_daiane   uuid;
  v_giovanna uuid;
  v_n        int;
  v_ja       int;
  v_abc      int;
  v_bf       int;
  v_id       uuid;
  v_row      record;
begin
  -- ----------------------------------------------------------
  -- 0. IDEMPOTENCIA
  -- ----------------------------------------------------------
  select count(*) into v_ja
  from public.analista_responsavel_loja
  where status = 'ACTIVE'
    and procedencia = 'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
    and loja_normalizada in ('ABC', 'BARRA FUNDA');

  if v_ja = 2 then
    raise notice 'PERF-5A.2 ja aplicada -- nada a fazer.';
    return;
  end if;

  -- ----------------------------------------------------------
  -- 1. IDENTIDADE EXATA -- H5
  -- ----------------------------------------------------------
  select count(*) into v_n
  from public.usuarios
  where upper(btrim(regexp_replace(coalesce(nome, ''), '[[:space:]]+', ' ', 'g')))
        = 'DAIANE BRAZIL PONTES PEIXOTO'
    and upper(trim(coalesce(perfil, ''))) = 'ANALISTA';

  if v_n = 0 then
    raise exception 'PERF5A2_HUMAN_ANALYST_IDENTITY_UNRESOLVED: NOT_FOUND para H5.'
      using errcode = '22023';
  elsif v_n > 1 then
    raise exception 'PERF5A2_HUMAN_ANALYST_IDENTITY_UNRESOLVED: AMBIGUOUS para H5 (% correspondencias).', v_n
      using errcode = '22023';
  end if;

  select id into v_daiane
  from public.usuarios
  where upper(btrim(regexp_replace(coalesce(nome, ''), '[[:space:]]+', ' ', 'g')))
        = 'DAIANE BRAZIL PONTES PEIXOTO'
    and upper(trim(coalesce(perfil, ''))) = 'ANALISTA';

  -- ----------------------------------------------------------
  -- 2. IDENTIDADE EXATA -- H6
  -- ----------------------------------------------------------
  select count(*) into v_n
  from public.usuarios
  where upper(btrim(regexp_replace(coalesce(nome, ''), '[[:space:]]+', ' ', 'g')))
        = 'GIOVANNA CRISTINA RIVERA'
    and upper(trim(coalesce(perfil, ''))) = 'ANALISTA';

  if v_n = 0 then
    raise exception 'PERF5A2_HUMAN_ANALYST_IDENTITY_UNRESOLVED: NOT_FOUND para H6.'
      using errcode = '22023';
  elsif v_n > 1 then
    raise exception 'PERF5A2_HUMAN_ANALYST_IDENTITY_UNRESOLVED: AMBIGUOUS para H6 (% correspondencias).', v_n
      using errcode = '22023';
  end if;

  select id into v_giovanna
  from public.usuarios
  where upper(btrim(regexp_replace(coalesce(nome, ''), '[[:space:]]+', ' ', 'g')))
        = 'GIOVANNA CRISTINA RIVERA'
    and upper(trim(coalesce(perfil, ''))) = 'ANALISTA';

  -- ----------------------------------------------------------
  -- 3. BASELINE ESPERADO (PERF-5A.1). Diferenca => aborta.
  -- ----------------------------------------------------------
  select count(*) into v_abc
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE' and r.loja_normalizada = 'ABC'
    and r.valid_to is not null
    and r.valid_from >= date '2026-01-01' and r.valid_to <= date '2026-08-21';

  select count(*) into v_bf
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE' and r.loja_normalizada = 'BARRA FUNDA'
    and r.valid_to is not null
    and r.valid_from >= date '2026-01-01' and r.valid_to <= date '2026-07-22';

  if v_abc <> 2 or v_bf <> 2 then
    raise exception 'PERF5A2_BASELINE_DRIFT: esperado 2 intervalos historicos em ABC e 2 em BARRA FUNDA; encontrado % e %.', v_abc, v_bf
      using errcode = '22023';
  end if;

  -- ----------------------------------------------------------
  -- 4. SUPERSEDE das 4 linhas historicas anteriores
  -- ----------------------------------------------------------
  for v_row in
    select * from public.analista_responsavel_loja
    where status = 'ACTIVE'
      and ((loja_normalizada = 'ABC'
            and valid_to is not null
            and valid_from >= date '2026-01-01' and valid_to <= date '2026-08-21')
        or (loja_normalizada = 'BARRA FUNDA'
            and valid_to is not null
            and valid_from >= date '2026-01-01' and valid_to <= date '2026-07-22'))
  loop
    update public.analista_responsavel_loja
       set status = 'SUPERSEDED'
     where id = v_row.id;

    insert into public.analista_responsavel_loja_auditoria (
      responsabilidade_id, loja, analista_anterior, analista_novo,
      valid_from, valid_to, acao, motivo, procedencia
    ) values (
      v_row.id, v_row.loja_normalizada, v_row.analista_usuario_id,
      case when v_row.loja_normalizada = 'ABC' then v_daiane else v_giovanna end,
      v_row.valid_from, v_row.valid_to, 'SUPERSEDED',
      'PERF-5A.2: reconstrucao historica substituida por autoridade humana explicita. '
      || case when v_row.loja_normalizada = 'ABC'
              then 'O Humano designou DAIANE BRAZIL PONTES PEIXOTO como responsavel do Ranking por ABC no intervalo historico de G18-A.'
              else 'O Humano designou GIOVANNA CRISTINA RIVERA como responsavel do Ranking por BARRA FUNDA no intervalo historico de G18-B.' end,
      v_row.procedencia
    );
  end loop;

  -- ----------------------------------------------------------
  -- 5. H5 -- ABC [2026-01-01, 2026-08-21)
  -- ----------------------------------------------------------
  insert into public.analista_responsavel_loja (
    loja, analista_usuario_id, valid_from, valid_to, motivo, procedencia
  ) values (
    'ABC', v_daiane, date '2026-01-01', date '2026-08-21',
    'PERF-5A.2 / H5: o Humano designou explicitamente DAIANE BRAZIL PONTES PEIXOTO '
    || 'como responsavel do Ranking por ABC de 01/01/2026 a 20/08/2026.',
    'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
  ) returning id into v_id;

  insert into public.analista_responsavel_loja_auditoria (
    responsabilidade_id, loja, analista_anterior, analista_novo,
    valid_from, valid_to, acao, motivo, procedencia
  ) values (
    v_id, 'ABC', null, v_daiane, date '2026-01-01', date '2026-08-21',
    'BACKFILL_HISTORICO',
    'PERF-5A.2 / H5: autoridade humana explicita para ABC no intervalo historico de G18-A.',
    'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
  );

  -- ----------------------------------------------------------
  -- 6. H6 -- BARRA FUNDA [2026-01-01, 2026-07-22)
  -- ----------------------------------------------------------
  insert into public.analista_responsavel_loja (
    loja, analista_usuario_id, valid_from, valid_to, motivo, procedencia
  ) values (
    'BARRA FUNDA', v_giovanna, date '2026-01-01', date '2026-07-22',
    'PERF-5A.2 / H6: o Humano designou explicitamente GIOVANNA CRISTINA RIVERA '
    || 'como responsavel do Ranking por BARRA FUNDA de 01/01/2026 a 21/07/2026.',
    'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
  ) returning id into v_id;

  insert into public.analista_responsavel_loja_auditoria (
    responsabilidade_id, loja, analista_anterior, analista_novo,
    valid_from, valid_to, acao, motivo, procedencia
  ) values (
    v_id, 'BARRA FUNDA', null, v_giovanna, date '2026-01-01', date '2026-07-22',
    'BACKFILL_HISTORICO',
    'PERF-5A.2 / H6: autoridade humana explicita para BARRA FUNDA no intervalo historico de G18-B.',
    'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
  );

  -- ----------------------------------------------------------
  -- 7. POSCONDICOES -- falham a transacao inteira se violadas
  -- ----------------------------------------------------------
  -- 7.1 zero sobreposicoes entre vigencias ACTIVE
  select count(*) into v_n
  from public.analista_responsavel_loja a
  join public.analista_responsavel_loja b
    on b.loja_normalizada = a.loja_normalizada and b.id <> a.id
   and a.status = 'ACTIVE' and b.status = 'ACTIVE'
   and daterange(a.valid_from, a.valid_to, '[)') && daterange(b.valid_from, b.valid_to, '[)');
  if v_n <> 0 then
    raise exception 'PERF-5A.2: % sobreposicao(oes) apos a correcao.', v_n using errcode = '23P01';
  end if;

  -- 7.2 ABC e BARRA FUNDA sem buracos entre 01/01 e 31/08
  select count(*) into v_n
  from generate_series(date '2026-01-01', date '2026-08-31', interval '1 day') d(dia)
  cross join (values ('ABC'), ('BARRA FUNDA')) l(loja)
  where not exists (
    select 1 from public.analista_responsavel_loja r
    where r.status = 'ACTIVE' and r.loja_normalizada = l.loja
      and d.dia::date >= r.valid_from
      and (r.valid_to is null or d.dia::date < r.valid_to));
  if v_n <> 0 then
    raise exception 'PERF-5A.2: % dia(s) sem dono em ABC/BARRA FUNDA apos a correcao.', v_n
      using errcode = '22023';
  end if;

  -- 7.3 as pessoas de H3/H4 nao respondem mais pelas lojas corrigidas
  select count(*) into v_n
  from public.analista_responsavel_loja r
  join public.usuarios u on u.id = r.analista_usuario_id
  where r.status = 'ACTIVE'
    and ((r.loja_normalizada = 'ABC' and upper(btrim(coalesce(u.nome,''))) like 'DENISE%RODRIGUES%')
      or (r.loja_normalizada = 'BARRA FUNDA' and upper(btrim(coalesce(u.nome,''))) like 'WILLIAN%INACIO%'));
  if v_n <> 0 then
    raise exception 'PERF-5A.2: atribuicao antiga sobreviveu em % linha(s).', v_n using errcode = '22023';
  end if;

  -- 7.4 H3 e H4 intactos
  select count(*) into v_n
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.procedencia = 'HUMAN_APPROVED_2026_STORE_RESPONSIBILITY'
    and r.loja_normalizada in ('ANALIA FRANCO', 'BANDEIRANTES')
    and r.valid_from = date '2026-01-01' and r.valid_to = date '2026-08-21';
  if v_n <> 2 then
    raise exception 'PERF-5A.2: H3/H4 alterados (esperado 2 intervalos, encontrado %).', v_n
      using errcode = '22023';
  end if;

  -- 7.5 vigencias abertas continuam sendo 9
  select count(*) into v_n
  from public.analista_responsavel_loja
  where status = 'ACTIVE' and valid_to is null;
  if v_n <> 9 then
    raise exception 'PERF-5A.2: vigencias abertas mudaram (esperado 9, encontrado %).', v_n
      using errcode = '22023';
  end if;

  raise notice 'PERF-5A.2 aplicada: G18-A e G18-B resolvidos por autoridade humana.';
end
$perf5a2$;

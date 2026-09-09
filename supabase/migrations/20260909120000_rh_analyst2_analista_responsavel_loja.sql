-- RH-ANALYST-2 -- Autoridade governada de RESPONSABILIDADE OFICIAL do
-- Analista de F&I por loja, com vigência temporal.
--
-- *** DRAFTED ONLY. NOT APPLIED. ***
-- Este arquivo foi escrito na fase de design/forense da RH-ANALYST-2 e
-- está versionado em disco para revisão, mas deliberadamente NÃO foi
-- executado contra o banco live (nenhum `supabase db push`, nenhum
-- apply). Ele foi, porém, VALIDADO ao vivo dentro de uma transação com
-- ROLLBACK (ver tests/rh_analyst2_responsabilidade_test.js), então o
-- comportamento abaixo está provado contra o Postgres real sem deixar
-- qualquer resíduo.
--
-- Segue o mesmo precedente já estabelecido neste repositório em
-- 20260909100000_rh5c_gestor_fi_governed_authority.sql: lógica que
-- afeta pagamento real merece um "vai" humano explícito antes de tocar
-- produção, mesmo quando o brief da própria Wave pré-autoriza a escrita.
--
-- ============================================================
-- DECISÃO DE NEGÓCIO (Humano, RH-ANALYST-2): OPÇÃO C
-- ============================================================
-- Para efeito de COMISSÃO, uma loja tem no máximo UM analista de F&I
-- oficialmente responsável a cada instante. Dois usuários ANALISTA
-- simultaneamente ativos na mesma loja NÃO significam divisão,
-- duplicação nem atribuição operação-a-operação -- o segundo pode ser
-- treinamento, substituição, transição ou handover.
--
-- Esta migration NÃO atribui responsabilidade a ninguém. Ela cria a
-- autoridade vazia. Quem é o responsável oficial de cada loja é uma
-- decisão de negócio explícita, tomada depois, via
-- master_definir_analista_responsavel().
--
-- ============================================================
-- O QUE ESTA MIGRATION *NÃO* FAZ
-- ============================================================
--   * não altera operational_analyst_commission_metrics (nem _v2);
--   * não remove a regra `order by u.nome limit 1` (Fase 4, depois);
--   * não atribui responsável para BARRA FUNDA nem para nenhuma loja;
--   * não desativa, move nem altera nenhum usuário;
--   * não recalcula comissão, não toca snapshot, não fecha competência;
--   * não altera ausencias_analistas (cobertura continua intacta).
-- Nenhum objeto existente é modificado. Enquanto ninguém consultar as
-- funções criadas aqui, o comportamento do Portal é byte-a-byte o atual.

-- ============================================================
-- 1. Extensão necessária para a invariante temporal
-- ============================================================
-- btree_gist permite combinar igualdade em escalar (loja) com
-- sobreposição de range (&&) numa mesma constraint EXCLUDE. Confirmado
-- disponível neste projeto (pg_available_extensions) e ainda não
-- instalado. É aditivo e não altera nenhum objeto existente.
create extension if not exists btree_gist;

-- ============================================================
-- 2. Tabela de responsabilidade oficial
-- ============================================================
-- Semântica temporal: intervalo SEMIABERTO [valid_from, valid_to).
--   valid_from  -> INCLUSIVO  (primeiro dia de responsabilidade)
--   valid_to    -> EXCLUSIVO  (primeiro dia em que já NÃO responde)
--   valid_to NULL -> vigência aberta (responsável atual, sem fim previsto)
-- Escolha deliberada: com fim exclusivo, um handover em D vira
-- A=[.., D) e B=[D, ..) sem sobreposição de um dia e sem buraco de um
-- dia -- o erro clássico de fim inclusivo. Nota: ausencias_analistas usa
-- fim INCLUSIVO (data_fim); a conversão fica isolada na função de
-- janelas (seção 5) e está coberta por teste.
create table if not exists public.analista_responsavel_loja (
  id uuid primary key default gen_random_uuid(),
  loja text not null,
  -- Coluna gerada: normaliza a loja uma única vez, para a invariante e o
  -- resolver nunca dependerem de grafia ("NACOES" vs "NACOES UNIDAS" já
  -- causou quebra de cruzamento antes, ver gbBuildBase01Row).
  loja_normalizada text generated always as (upper(btrim(loja))) stored,
  -- IDENTIDADE CANÔNICA = usuarios.id. Nunca nome, nunca CPF, nunca
  -- e-mail. Nome é apresentação; CPF em linha de folha já se provou
  -- inútil (227 de 235 linhas ANALISTA de snapshot_comissoes sem CPF).
  analista_usuario_id uuid not null references public.usuarios(id),
  valid_from date not null,
  valid_to date,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'SUPERSEDED')),
  motivo text,
  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now(),
  constraint analista_responsavel_loja_intervalo_valido
    check (valid_to is null or valid_to > valid_from)
);

comment on table public.analista_responsavel_loja is
  'RH-ANALYST-2: quem é o analista de F&I OFICIALMENTE responsável por '
  'cada loja, com vigência [valid_from, valid_to). Substitui a regra '
  'arbitraria "order by u.nome limit 1" de operational_analyst_'
  'commission_metrics. Ter usuario ANALISTA ativo numa loja NAO implica '
  'ser o responsavel pela comissao -- isso vem exclusivamente daqui.';

comment on column public.analista_responsavel_loja.valid_to is
  'EXCLUSIVO: primeiro dia em que este analista ja NAO responde pela '
  'loja. NULL = vigencia aberta.';

-- ============================================================
-- 3. INVARIANTE TEMPORAL (garantida pelo banco, não pelo frontend)
-- ============================================================
-- No máximo UM responsável ACTIVE por loja em qualquer instante.
-- Constraint declarativa (não trigger): é resistente a corrida por
-- construção, sem necessidade de lock explícito.
alter table public.analista_responsavel_loja
  drop constraint if exists analista_responsavel_loja_sem_sobreposicao;

alter table public.analista_responsavel_loja
  add constraint analista_responsavel_loja_sem_sobreposicao
  exclude using gist (
    loja_normalizada with =,
    daterange(valid_from, valid_to, '[)') with &&
  ) where (status = 'ACTIVE');

create index if not exists idx_analista_responsavel_loja_lookup
  on public.analista_responsavel_loja (loja_normalizada, valid_from)
  where status = 'ACTIVE';

-- ============================================================
-- 4. Auditoria append-only
-- ============================================================
create table if not exists public.analista_responsavel_loja_auditoria (
  id bigint generated always as identity primary key,
  responsabilidade_id uuid,
  loja text not null,
  analista_anterior uuid,
  analista_novo uuid,
  valid_from date,
  valid_to date,
  acao text not null check (acao in ('CREATED', 'HANDOVER_CLOSED', 'SUPERSEDED')),
  motivo text,
  alterado_por uuid,
  alterado_em timestamptz not null default now()
);

comment on table public.analista_responsavel_loja_auditoria is
  'RH-ANALYST-2: historico imutavel de mudancas de responsabilidade. '
  'Um INSERT por efeito; nenhuma responsabilidade e sobrescrita em '
  'silencio -- handover FECHA a vigencia anterior e registra ambos.';

-- ============================================================
-- 5. Resolvers (canônicos -- não duplicar esta lógica em RPCs)
-- ============================================================
-- 5.1 Responsável numa data. NULL = não configurado.
-- Fail-closed é responsabilidade do CHAMADOR: NULL nunca pode virar
-- "pega o primeiro analista ativo da loja". Esse era exatamente o bug.
create or replace function public.resolve_analista_responsavel(
  p_loja text,
  p_data date
)
returns uuid
language sql
stable
set search_path to 'pg_catalog', 'public'
as $function$
  select r.analista_usuario_id
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.loja_normalizada = upper(btrim(coalesce(p_loja, '')))
    and p_data >= r.valid_from
    and (r.valid_to is null or p_data < r.valid_to)
  limit 1;
$function$;

-- 5.2 Janelas de responsabilidade que intersectam um período.
-- ESTA é a função que a comissão deve consumir, não a 5.1: um período de
-- competência pode conter um handover no meio, e resolver o analista
-- apenas na data final atribuiria o período inteiro à pessoa errada.
-- Devolve datas INCLUSIVAS (janela_fim), no mesmo formato que o CTE
-- `windows` de operational_analyst_commission_metrics já usa para
-- ausências -- por isso o `- 1` ao converter o fim exclusivo.
create or replace function public.analista_responsabilidade_janelas(
  p_loja text,
  p_start date,
  p_end date
)
returns table (
  analista_usuario_id uuid,
  janela_inicio date,
  janela_fim date
)
language sql
stable
set search_path to 'pg_catalog', 'public'
as $function$
  select
    r.analista_usuario_id,
    greatest(r.valid_from, p_start) as janela_inicio,
    least(coalesce(r.valid_to - 1, p_end), p_end) as janela_fim
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.loja_normalizada = upper(btrim(coalesce(p_loja, '')))
    and r.valid_from <= p_end
    and (r.valid_to is null or r.valid_to > p_start)
  order by r.valid_from;
$function$;

-- 5.3 Diagnóstico de cobertura (Fase 3): quais lojas com atividade ainda
-- não têm responsável configurado. Somente leitura, sem PII, MASTER/RH.
-- Existe para que a virada da Fase 4 só aconteça com cobertura provada.
create or replace function public.analista_responsabilidade_cobertura(
  p_start date,
  p_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_perfil text;
  v_rows jsonb;
begin
  select upper(trim(coalesce(u.perfil, ''))) into v_perfil
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;

  if v_perfil is null
     or v_perfil not in ('MASTER', 'RH', 'RECURSOS HUMANOS') then
    raise exception 'Acesso restrito a MASTER e RH.' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'loja', t.loja,
           'analistas_ativos', t.analistas_ativos,
           'janelas_configuradas', t.janelas,
           'coberta', t.janelas > 0
         ) order by t.loja), '[]'::jsonb)
  into v_rows
  from (
    -- A contagem de janelas fica FORA do GROUP BY (subconsulta sobre o
    -- derivado já agregado) -- referenciar u.loja de dentro do agregado
    -- é "ungrouped column" e não compila.
    select l.loja,
           l.analistas_ativos,
           (select count(*)
              from public.analista_responsabilidade_janelas(l.loja, p_start, p_end)) as janelas
    from (
      select upper(btrim(coalesce(u.loja, ''))) as loja,
             count(*) as analistas_ativos
      from public.usuarios u
      where u.ativo = true
        and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
      group by 1
    ) l
  ) t;

  return jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'rows', v_rows
  );
end;
$function$;

-- ============================================================
-- 6. Escrita governada -- MASTER apenas
-- ============================================================
-- Faz o handover de forma atômica e auditada: fecha a vigência aberta
-- anterior EM p_valid_from (fim exclusivo => sem sobreposição e sem
-- buraco) e abre a nova. Mesmo gate de master_update_portal_config().
create or replace function public.master_definir_analista_responsavel(
  p_loja text,
  p_analista_usuario_id uuid,
  p_valid_from date,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_loja text := upper(btrim(coalesce(p_loja, '')));
  v_alvo public.usuarios;
  v_anterior public.analista_responsavel_loja;
  v_novo_id uuid;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_loja = '' or p_valid_from is null then
    raise exception 'Loja e data de vigência são obrigatórias.' using errcode = '22023';
  end if;

  select u.* into v_alvo
  from public.usuarios u
  where u.id = p_analista_usuario_id
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
  limit 1;

  if v_alvo.id is null then
    raise exception 'Usuário informado não é um ANALISTA ativo.' using errcode = '22023';
  end if;

  -- Vigência aberta anterior desta loja, se houver.
  select r.* into v_anterior
  from public.analista_responsavel_loja r
  where r.status = 'ACTIVE'
    and r.loja_normalizada = v_loja
    and r.valid_to is null
  limit 1;

  if v_anterior.id is not null then
    if v_anterior.analista_usuario_id = p_analista_usuario_id then
      raise exception 'Este analista já é o responsável vigente desta loja.'
        using errcode = '22023';
    end if;
    if p_valid_from <= v_anterior.valid_from then
      raise exception 'A nova vigência deve começar depois do início da vigência atual.'
        using errcode = '22023';
    end if;

    update public.analista_responsavel_loja
       set valid_to = p_valid_from
     where id = v_anterior.id;

    insert into public.analista_responsavel_loja_auditoria (
      responsabilidade_id, loja, analista_anterior, analista_novo,
      valid_from, valid_to, acao, motivo, alterado_por
    ) values (
      v_anterior.id, v_loja, v_anterior.analista_usuario_id, p_analista_usuario_id,
      v_anterior.valid_from, p_valid_from, 'HANDOVER_CLOSED', p_motivo, v_actor.id
    );
  end if;

  insert into public.analista_responsavel_loja (
    loja, analista_usuario_id, valid_from, motivo, criado_por
  ) values (
    v_loja, p_analista_usuario_id, p_valid_from, p_motivo, v_actor.id
  )
  returning id into v_novo_id;

  insert into public.analista_responsavel_loja_auditoria (
    responsabilidade_id, loja, analista_anterior, analista_novo,
    valid_from, valid_to, acao, motivo, alterado_por
  ) values (
    v_novo_id, v_loja, v_anterior.analista_usuario_id, p_analista_usuario_id,
    p_valid_from, null, 'CREATED', p_motivo, v_actor.id
  );

  return jsonb_build_object(
    'ok', true,
    'responsabilidade_id', v_novo_id,
    'loja', v_loja,
    'valid_from', p_valid_from,
    'handover_de_vigencia_anterior', v_anterior.id is not null
  );
end;
$function$;

-- ============================================================
-- 7. RLS / grants -- mesmo padrão de permissoes_modulos
-- ============================================================
-- RLS habilitada SEM policies: acesso direto nega tudo para anon/
-- authenticated mesmo que um GRANT futuro entre por engano. Todo acesso
-- passa pelas funções SECURITY DEFINER acima.
alter table public.analista_responsavel_loja enable row level security;
alter table public.analista_responsavel_loja_auditoria enable row level security;

revoke all on public.analista_responsavel_loja from public, anon, authenticated;
revoke all on public.analista_responsavel_loja_auditoria from public, anon, authenticated;
grant all on public.analista_responsavel_loja to service_role;
grant all on public.analista_responsavel_loja_auditoria to service_role;

revoke all on function public.resolve_analista_responsavel(text, date) from public, anon;
revoke all on function public.analista_responsabilidade_janelas(text, date, date) from public, anon;
revoke all on function public.analista_responsabilidade_cobertura(date, date) from public, anon;
revoke all on function public.master_definir_analista_responsavel(text, uuid, date, text) from public, anon;

grant execute on function public.resolve_analista_responsavel(text, date) to authenticated, service_role;
grant execute on function public.analista_responsabilidade_janelas(text, date, date) to authenticated, service_role;
grant execute on function public.analista_responsabilidade_cobertura(date, date) to authenticated, service_role;
grant execute on function public.master_definir_analista_responsavel(text, uuid, date, text) to authenticated, service_role;

-- ============================================================
-- 8. FASES SEGUINTES (não executadas aqui)
-- ============================================================
-- Fase 2: atribuir responsabilidade por decisão de negócio explícita
--         (8 lojas de analista único são inequívocas; BARRA FUNDA exige
--         decisão humana -- ver a matriz de bootstrap no relatório).
-- Fase 3: provar 100% de cobertura via analista_responsabilidade_cobertura().
-- Fase 4: trocar official_rows de `order by u.nome limit 1` para janelas
--         de analista_responsabilidade_janelas(), fail-closed quando
--         não houver responsável configurado.
-- Fase 5: remover a seleção alfabética de vez.

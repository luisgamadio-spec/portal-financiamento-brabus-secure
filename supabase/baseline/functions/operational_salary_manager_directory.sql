-- =========================================================
-- SNAPSHOT DE LEITURA — NÃO É MIGRATION — NÃO REAPLICAR
-- =========================================================
-- Capturado via Supabase CLI `db query --linked` (Management API),
-- 100% read-only, uma única SELECT (pg_get_functiondef), como parte da
-- auditoria SEC-1B. Ver supabase/baseline/README.md para a regra de
-- uso, e operational_current_scope.sql (mesma pasta) para o padrão de
-- captura já estabelecido.
--
-- Função:        public.operational_salary_manager_directory(p_start date, p_end date)
-- security:      DEFINER
-- volatility:    STABLE
-- search_path:   pg_catalog, public  (pinado)
--
-- CLASSIFICAÇÃO DE ACHADO (SEC-1A -> SEC-1B): SEC-1A havia marcado
-- esta função como `SALARY_MANAGER_DIRECTORY_RPC_SOURCE_UNAVAILABLE`
-- (fonte SQL não encontrada em nenhum dos dois repositórios -- nem
-- migration, nem captura baseline). Esta captura RESOLVE esse achado:
--
--   1. Chama public.operational_current_scope() internamente -- o
--      MESMO resolvedor canônico de autoridade já auditado (ver
--      operational_current_scope.sql, mesma pasta), nunca uma consulta
--      solta desacoplada da identidade real do chamador.
--   2. Apesar do nome ("salary manager directory"), esta função NÃO
--      retorna nenhum valor monetário de salário/comissão -- devolve
--      apenas (store, department, manager_name): o(s) nome(s) do(s)
--      GERENTE(s) responsável(is) por cada loja/departamento. Nenhum
--      campo de valor, faixa, ou remuneração existe no shape de
--      retorno.
--   3. Escopo é REALMENTE reforçado dentro do SQL, não apenas
--      confiado ao caller: a CTE `authorized` só inclui uma linha
--      quando v_is_master é true, OU (o departamento pedido está em
--      v_departments do PRÓPRIO chamador E (o chamador é diretor,
--      que vê todas as lojas do seu departamento, OU a loja da linha
--      é exatamente a loja do chamador)). Um ANALISTA/GERENTE/
--      VENDEDOR não-diretor nunca vê linhas de loja/departamento fora
--      da sua própria autoridade, mesmo que esta RPC seja chamada
--      diretamente.
--   4. Autodocumenta seu próprio posicionamento de privacidade no
--      retorno: `contains_client_identity: false,
--      contains_personal_documents: false,
--      contains_operational_identifiers: false` -- não apenas
--      inferido por este código, mas declarado explicitamente pela
--      própria função.
--
-- CONCLUSÃO: esta RPC específica NÃO é um caminho de vazamento de
-- salário/comissão -- é um diretório de nomes de gestor, corretamente
-- escopado pela mesma autoridade canônica já confiável. O achado
-- SALARY_MANAGER_DIRECTORY_RPC_SOURCE_UNAVAILABLE está fechado por
-- esta captura; consultar_comissoes (a tool real que EXPÕE valores de
-- salário/comissão) permanece MASTER+RH-only nesta Wave,
-- independentemente desta descoberta -- ver tool-policy.ts, inalterado.
--
-- Capturado em: 2026-09-13 (SEC-1B)
-- =========================================================

CREATE OR REPLACE FUNCTION public.operational_salary_manager_directory(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_is_master boolean;
  v_is_director boolean;
  v_rows jsonb;
  v_ambiguous integer;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Periodo maximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(
    select upper(trim(jsonb_array_elements_text(v_scope->'departments')))
  );
  v_is_master := coalesce((v_scope->>'is_master')::boolean, false);
  v_is_director := coalesce((v_scope->>'is_director')::boolean, false);

  with manager_departments as (
    select
      u.id,
      trim(u.nome) as manager_name,
      upper(trim(coalesce(u.loja, ''))) as store,
      upper(trim(department.value)) as department
    from public.usuarios u
    cross join lateral regexp_split_to_table(
      regexp_replace(
        upper(trim(coalesce(u.status, ''))),
        '^GERENTE[[:space:]]+',
        ''
      ),
      '[[:space:]]*/[[:space:]]*'
    ) as department(value)
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'GERENTE'
  ),
  authorized as (
    select md.*
    from manager_departments md
    where md.department in ('NOVOS', 'SEMINOVOS')
      and (
        v_is_master
        or (
          md.department = any(v_departments)
          and (
            v_is_director
            or md.store = upper(trim(coalesce(v_store, '')))
          )
        )
      )
  ),
  selected as (
    select
      a.store,
      a.department,
      string_agg(
        distinct a.manager_name,
        ' / ' order by a.manager_name
      ) as manager_name
    from authorized a
    group by a.store, a.department
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'store', s.store,
        'department', s.department,
        'manager_name', s.manager_name
      ) order by s.store, s.department
    ),
    '[]'::jsonb
  )
  into v_rows
  from selected s;

  with manager_departments as (
    select
      upper(trim(coalesce(u.loja, ''))) as store,
      upper(trim(department.value)) as department
    from public.usuarios u
    cross join lateral regexp_split_to_table(
      regexp_replace(
        upper(trim(coalesce(u.status, ''))),
        '^GERENTE[[:space:]]+',
        ''
      ),
      '[[:space:]]*/[[:space:]]*'
    ) as department(value)
    where u.ativo = true
      and upper(trim(coalesce(u.perfil, ''))) = 'GERENTE'
  )
  select count(*)::integer
  into v_ambiguous
  from (
    select md.store, md.department
    from manager_departments md
    where md.department in ('NOVOS', 'SEMINOVOS')
    group by md.store, md.department
    having count(*) > 1
  ) duplicates;

  return jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'assignment_source', 'ACTIVE_PORTAL_PROFILE',
    'rows', v_rows,
    'ambiguous_assignments', coalesce(v_ambiguous, 0),
    'contains_client_identity', false,
    'contains_personal_documents', false,
    'contains_operational_identifiers', false
  );
end;
$function$

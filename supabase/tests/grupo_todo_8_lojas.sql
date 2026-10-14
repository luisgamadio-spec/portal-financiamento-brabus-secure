-- REGRA (14/10/2026, Luis): "Análise F&I do Grupo" e "Análise Geral do Grupo" = GRUPO TODO para TODOS os perfis.
-- NÃO restringir por loja. (Problema recorrente: já foi corrigido e voltou em 08/10 com a migração
-- 20261008200000_retorno_so_perfis_autorizados, que tirou o p_group_view.) Decisões do Luis em 14/10:
--   - todos os departamentos nas duas telas;
--   - Análise F&I liberada para Master, Diretor, Gerente, Analista e Vendedor (RH sem);
--   - ANALISTA e GERENTE: retorno por vendedor só da própria loja; das outras lojas só o total por loja;
--   - vendedor e RH nunca recebem retorno.
--
-- TESTE (somente leitura, termina em ROLLBACK): para um usuário ativo de CADA perfil, chama as mesmas funções das duas
-- telas, como esse usuário, e FALHA (raise) se alguma regra acima não for cumprida. Rodar depois de QUALQUER migração
-- que mexa nessas funções:   supabase db query --linked -f supabase/tests/grupo_todo_8_lojas.sql
begin read only;
do $teste$
declare
  v_lojas constant text[] := array['ABC', 'ALPHAVILLE', 'ANALIA FRANCO', 'BANDEIRANTES', 'BARRA FUNDA', 'EUROPA', 'GASTAO', 'NACOES'];
  v_deps constant text[] := array['NOVOS', 'SEMINOVOS'];
  v_ini date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_fim date := current_date;
  r record;
  v_j jsonb;
  v_master jsonb;
  v_achadas text[];
  v_loja text;
  v_falhas text[] := array[]::text[];
  v_testados int := 0;
begin
  -- referência: o que o Master vê (totais por loja/departamento)
  perform set_config('request.jwt.claims', json_build_object('sub', (select auth_user_id::text from public.usuarios
    where ativo and auth_user_id is not null and upper(trim(perfil)) = 'MASTER' order by id limit 1), 'role', 'authenticated')::text, true);
  select jsonb_object_agg(k, v) into v_master from (
    select upper(x->>'store') || '|' || upper(x->>'department') k,
           jsonb_build_array(sum((x->>'sold_count')::numeric), sum((x->>'financed_count')::numeric),
                             round(sum(coalesce((x->>'return_value')::numeric, 0)), 2), round(sum(coalesce((x->>'production_value')::numeric, 0)), 2)) v
    from jsonb_array_elements(public.operational_metrics(v_ini, v_fim, true)->'rows') x group by 1) m;

  for r in
    select distinct on (grupo) grupo, sub from (
      select case when upper(trim(u.perfil)) like 'DIRETOR%' then 'DIRETOR' else upper(trim(u.perfil)) end grupo,
             u.auth_user_id::text sub, u.loja, u.id
      from public.usuarios u
      where u.ativo and u.auth_user_id is not null
        and (upper(trim(u.perfil)) in ('MASTER', 'GERENTE', 'ANALISTA', 'VENDEDOR') or upper(trim(u.perfil)) like 'DIRETOR%')
    ) x order by grupo, (loja is null), id
  loop
    v_testados := v_testados + 1;
    perform set_config('request.jwt.claims', json_build_object('sub', r.sub, 'role', 'authenticated')::text, true);
    v_loja := nullif(upper(trim(coalesce(public.operational_current_scope()->>'store', ''))), '');

    if not (public.portal_modulos_permitidos() ? 'dashbi') or not (public.portal_modulos_permitidos() ? 'gestao') then
      v_falhas := v_falhas || format('%s: sem acesso a uma das telas (dashbi/gestao)', r.grupo);
    end if;

    -- Análise Geral (métricas)
    v_j := public.operational_metrics(v_ini, v_fim, true);
    select array_agg(distinct upper(x->>'store')) into v_achadas from jsonb_array_elements(v_j->'rows') x;
    if not (v_lojas <@ coalesce(v_achadas, array[]::text[])) then
      v_falhas := v_falhas || format('%s: Análise Geral (métricas) sem as 8 lojas: %s', r.grupo, v_achadas);
    end if;
    select array_agg(distinct upper(x->>'department')) into v_achadas from jsonb_array_elements(v_j->'rows') x;
    if not (v_deps <@ coalesce(v_achadas, array[]::text[])) then
      v_falhas := v_falhas || format('%s: Análise Geral sem os 2 departamentos: %s', r.grupo, v_achadas);
    end if;
    if r.grupo = 'VENDEDOR' and exists (select 1 from jsonb_array_elements(v_j->'rows') x
                                         where coalesce((x->>'return_value')::numeric, 0) <> 0 or coalesce((x->>'profitability_value')::numeric, 0) <> 0) then
      v_falhas := v_falhas || format('%s: recebeu retorno/rentabilidade na Análise Geral', r.grupo);
    end if;
    if r.grupo in ('ANALISTA', 'GERENTE') then
      if exists (select 1 from jsonb_array_elements(v_j->'rows') x
                 where x->>'seller_id' is not null and upper(trim(coalesce(x->>'store', ''))) is distinct from v_loja) then
        v_falhas := v_falhas || format('%s: recebeu linha POR VENDEDOR de outra loja (só pode o total por loja)', r.grupo);
      end if;
      if exists (
        select 1 from (
          select upper(x->>'store') || '|' || upper(x->>'department') k,
                 jsonb_build_array(sum((x->>'sold_count')::numeric), sum((x->>'financed_count')::numeric),
                                   round(sum(coalesce((x->>'return_value')::numeric, 0)), 2), round(sum(coalesce((x->>'production_value')::numeric, 0)), 2)) v
          from jsonb_array_elements(v_j->'rows') x group by 1) t
        where v_master->t.k is distinct from t.v) then
        v_falhas := v_falhas || format('%s: totais por loja diferentes dos do Master', r.grupo);
      end if;
    end if;

    -- Análise Geral (modelos)
    v_j := public.operational_model_metrics(v_ini, v_fim, true);
    select array_agg(distinct upper(x->>'store')) into v_achadas from jsonb_array_elements(v_j->'rows') x;
    if not (v_lojas <@ coalesce(v_achadas, array[]::text[])) then
      v_falhas := v_falhas || format('%s: Análise Geral (modelos) sem as 8 lojas: %s', r.grupo, v_achadas);
    end if;

    -- Análise F&I
    begin
      v_j := public.operational_fandi_dashboard(v_ini, v_fim, null, null);
      select array_agg(distinct upper(x->>'store')) into v_achadas from jsonb_array_elements(v_j->'stores') x;
      if not (v_lojas <@ coalesce(v_achadas, array[]::text[])) then
        v_falhas := v_falhas || format('%s: Análise F&I sem as 8 lojas: %s', r.grupo, v_achadas);
      end if;
      select array_agg(distinct upper(x->>'department')) into v_achadas from jsonb_array_elements(v_j->'plans_by_store_department') x;
      if not (v_deps <@ coalesce(v_achadas, array[]::text[])) then
        v_falhas := v_falhas || format('%s: Análise F&I sem os 2 departamentos: %s', r.grupo, v_achadas);
      end if;
    exception when others then
      v_falhas := v_falhas || format('%s: Análise F&I com erro: %s', r.grupo, sqlerrm);
    end;
  end loop;

  if v_testados < 5 then
    v_falhas := v_falhas || format('só %s perfil(is) com usuário ativo para testar (esperado 5)', v_testados);
  end if;
  if exists (select 1 from public.permissoes_modulos where modulo_id = 'gestao' and upper(trim(perfil)) = 'RH' and permitido) then
    v_falhas := v_falhas || 'RH com acesso à Análise F&I (decisão: RH só Salários)'::text;
  end if;
  if array_length(v_falhas, 1) > 0 then
    raise exception 'FALHOU grupo_todo_8_lojas: %', array_to_string(v_falhas, ' | ');
  end if;
  raise notice 'OK grupo_todo_8_lojas: % perfis com as 8 lojas e os 2 departamentos nas duas telas', v_testados;
end $teste$;
select 'OK grupo_todo_8_lojas' as resultado;
rollback;

-- Incidente P1: Group View Authorization Escalation (operational_metrics / p_group_view)
--
-- Causa raiz (booleano de cliente tratado como prova de autorizacao):
-- operational_metrics e operational_model_metrics_without_spf aceitam um
-- parametro p_group_view boolean. Quando true e o chamador resolvido
-- server-side (auth.uid()) e VENDEDOR ou ANALISTA, a funcao force ava
-- v_is_master := true incondicionalmente -- sem nenhuma verificacao de
-- quem realmente pode requisitar essa visao. Confirmado chamando a RPC
-- diretamente (sem depender do frontend) com a sessao real de RODRIGO
-- CORADI (VENDEDOR): operational_metrics(..., true) devolveu vendedores
-- nomeados das 8 lojas do Grupo. operational_model_metrics herda o
-- mesmo problema (delega p_group_view para operational_model_metrics_
-- without_spf sem verificacao propria).
--
-- Nuance importante achada durante a investigacao: a tabela
-- permissoes_modulos ja concede o modulo dashbi (Analise Geral do Grupo)
-- de forma ampla -- VENDEDOR/NOVOS, VENDEDOR/SEMINOVOS, ANALISTA/TODOS,
-- GERENTE/NOVOS, GERENTE/SEMINOVOS e DIRETOR/TODOS todos com
-- permitido=true (somente RH e negado). Ou seja, hoje, a maioria dos
-- vendedores/analistas JA esta autorizada a este modulo pela politica
-- real configurada -- a falha nao e "todo vendedor deveria ser negado",
-- e sim que a RPC nunca verificava essa politica: ela confiava cegamente
-- no parametro do cliente, o que teria permitido bypass total caso a
-- politica fosse restrita amanha (ou para qualquer perfil/departamento
-- que a politica ja nega, como RH).
--
-- Correcao (Parte H/I do incidente): reusa a mesma capacidade server-side
-- ja usada para liberar a navegacao ate o modulo dashbi no Portal --
-- portal_modulos_permitidos(), resolvida inteiramente via auth.uid(),
-- nunca por parametro do cliente. p_group_view continua expressando a
-- INTENCAO do chamador ("quero visao de grupo"), mas so e honrado se
-- a capacidade dashbi estiver de fato concedida ao perfil/departamento
-- do chamador na tabela permissoes_modulos. Nenhuma RPC nova, nenhuma
-- Edge Function nova -- reaproveita infraestrutura ja auditada.
--
-- Nao altera nenhuma formula de vendas/financiamento/producao/retorno/
-- SPF/planos. Nao amplia acesso de nenhum perfil alem do que a politica
-- permissoes_modulos ja concede hoje. Testado em transacao com ROLLBACK
-- contra 6 personas reais (Rodrigo/Camile/Wesley/Francis/Diretor Novos/
-- Master), incluindo um teste que reduz temporariamente (dentro da
-- mesma transacao, revertido) a permissao de VENDEDOR/SEMINOVOS para
-- provar que o mecanismo nega corretamente quando a politica nega --
-- ver relatorio do incidente. Nao promovida ao banco live nesta fase.

CREATE OR REPLACE FUNCTION public.operational_metrics(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_profile text;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_spf_net_percent numeric := 70;
  v_rows jsonb;
  v_group_view_perfil text;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_profile := v_scope->>'profile';
  v_store := v_scope->>'store';
  v_departments := array(
    select jsonb_array_elements_text(v_scope->'departments')
  );
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  -- Fase UX-Grupo-3.0, Item 2: escopo GLOBAL (todas as lojas) exclusivo do
  -- modulo "Analise Geral do Grupo", nunca de operational_current_scope()
  -- em si (que continua intocada e usada normalmente por todas as outras
  -- chamadas desta mesma funcao, com p_group_view=false por omissao).
  -- Regra "so amplia, nunca reduz nem expande alem do combinado":
  --   ANALISTA/VENDEDOR -> v_is_master forcado true (visao de grupo completa).
  --   MASTER             -> ja e true, no-op.
  --   Qualquer outro perfil (DIRETOR, GERENTE, ...) -> no-op, preserva
  --   integralmente o escopo que operational_current_scope() ja calculou
  --   (DIRETOR ja enxerga todas as lojas do seu departamento via
  --   v_is_director; nao ampliar para outros departamentos aqui).
  if p_group_view then
    select upper(trim(coalesce(u.perfil, ''))) into v_group_view_perfil
    from public.usuarios u
    where u.auth_user_id = auth.uid() and u.ativo = true
    limit 1;
    -- Incidente P1 Group-View Authorization Escalation -- p_group_view era
    -- um booleano confiavel do cliente: qualquer VENDEDOR/ANALISTA podia
    -- chamar esta RPC diretamente (sem depender do frontend/modulo) e
    -- forcar v_is_master=true, recebendo dados nomeados de TODAS as lojas
    -- do Grupo. Corrigido reusando a mesma capacidade server-side ja usada
    -- para liberar o modulo Analise Geral do Grupo (dashbi) na navegacao
    -- do Portal -- portal_modulos_permitidos(), resolvida via auth.uid(),
    -- nunca por parametro do cliente. Um booleano do cliente pode
    -- EXPRESSAR intencao, mas nunca AUTORIZAR sozinho.
    if v_group_view_perfil in ('ANALISTA', 'VENDEDOR')
       and (public.portal_modulos_permitidos() ? 'dashbi') then
      v_is_master := true;
      v_scope := jsonb_set(v_scope, '{is_master}', 'true'::jsonb);
    end if;
  end if;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  select coalesce(
    case
      when replace(c.valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$'
        then replace(c.valor, ',', '.')::numeric
      else null
    end,
    70
  )
  into v_spf_net_percent
  from public.configuracoes c
  where c.chave = 'spf_liquido_percentual'
  limit 1;

  v_spf_net_percent := coalesce(v_spf_net_percent, 70);

  with latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY', 'SPF_CURRENT',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  -- Fase 21.4: usuarios passa a ser a fonte primaria de elegibilidade
  -- (identidade atual). portal_sellers permanece como fallback LEGADO,
  -- incluido apenas para pessoas que NAO tem correspondencia ativa em
  -- usuarios (o "not exists" evita listar a mesma pessoa duas vezes quando
  -- ela ja possui cadastro atual). O match com os fatos passa a ser por
  -- coalesce(seller_user_id, seller_id) -- prioridade ao vinculo moderno,
  -- fallback ao legado (Parte AK). Mantidos os mesmos nomes de coluna
  -- (id/name/store/status) para preservar o resto do corpo da funcao
  -- inalterado.
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status,
      true as is_current_user
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(u.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(u.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (v_is_seller and u.id = v_user_id)
            or (
              not v_is_seller
              and upper(trim(coalesce(u.loja, ''))) = v_store
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status,
      false as is_current_user
    from public.portal_sellers ps
    where ps.active
      and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(ps.status, ''))) not in (
        'REVENDA', 'INATIVO', 'MASTER'
      )
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(ps.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(ps.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (
              not v_is_seller
              and upper(coalesce(ps.store, '')) = v_store
            )
          )
        )
      )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.seller_id,
      s.seller_user_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.department,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    where s.sale_date between p_start and p_end
      -- Incidente IA-1A: para DIRETOR, a autorizacao departamental vale sobre o
      -- departamento EFETIVO (temporal) do fato, nao sobre o status atual da
      -- pessoa (ja aplicado em eligible_sellers). Sem isto, um vendedor
      -- realocado de SEMINOVOS para NOVOS carrega para o DIRETOR NOVOS as
      -- vendas que fez quando ainda estava em SEMINOVOS (e vice-versa).
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, s.sale_date, null), es.status, s.department, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  sales_metrics as (
    select
      es.id as seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA') as store,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, vs.sale_date, null), es.status, vs.department, 'SEM DEPARTAMENTO'))) as department,
      es.name as seller_name,
      count(*)::integer as sold_count,
      coalesce(sum(vs.sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales vs
    join eligible_sellers es on es.id = coalesce(vs.seller_user_id, vs.seller_id)
    group by
      es.id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA'),
      upper(trim(coalesce(public.resolve_department_temporal(es.id, vs.sale_date, null), es.status, vs.department, 'SEM DEPARTAMENTO'))),
      es.name
  ),
  visible_finance as (
    select
      f.*,
      es.id as effective_seller_id,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      -- Incidente IA-1A: mesmo gate departamental de visible_sales, agora sobre
      -- o departamento efetivo (temporal) da operacao de financiamento -- fecha
      -- finance/SPF/plan_breakdown, que derivam todos de visible_finance.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  principal_finance as (
    select *
    from visible_finance
    where is_real_financing
  ),
  later_return as (
    select distinct on (
      effective_seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from visible_finance
    where is_later_return
    order by
      effective_seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance as (
    select * from principal_finance
    union all
    select lr.*
    from later_return lr
    where not exists (
      select 1 from principal_finance pf where pf.id = lr.id
    )
  ),
  -- Classificação do plano por operação, mesma prioridade oficial da função
  -- planTypeFromFields() do frontend: SUBSIDIADO > REVERSÃO > COPARTICIPADO > BALÃO > LINEAR.
  effective_finance_classified as (
    select ef.*,
      case
        when ef.plan_codigo_if is not null
         and (upper(trim(ef.plan_codigo_if)) = '999'
              or upper(ef.plan_codigo_if) like '%SUBSIDIADO%')
          then 'SUBSIDIADO'
        when ef.plan_codigo_if is not null
         and (upper(trim(ef.plan_codigo_if)) = '777'
              or upper(ef.plan_codigo_if) like '%REVERSAO%'
              or upper(ef.plan_codigo_if) like '%REVERSÃO%')
          then 'REVERSÃO'
        when ef.tc_devolvida = 1 then 'COPARTICIPADO'
        when coalesce(ef.balloon_value, 0) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from effective_finance ef
  ),
  finance_metrics as (
    select
      effective_seller_id as seller_id,
      effective_store as store,
      department,
      seller_name,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance_classified
    group by effective_seller_id, effective_store, department, seller_name
  ),
  plan_metrics as (
    select
      effective_seller_id as seller_id,
      effective_store as store,
      department,
      seller_name,
      plan_type,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
        as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
      -- Incidente UX-Grupo-3.1: mesmo fix de operational_model_metrics_
      -- without_spf -- "Valor Médio Balão" carecia do valor real de
      -- Op Fin - Balão PMT (R$) no plan_breakdown por vendedor/loja.
      avg(balloon_value) filter (where balloon_value > 0)
        as average_balloon_value
    from effective_finance_classified
    group by effective_seller_id, effective_store, department, seller_name, plan_type
  ),
  plan_breakdown_agg as (
    select
      seller_id, store, department, seller_name,
      jsonb_agg(
        jsonb_build_object(
          'plan_type', plan_type,
          'financed_count', financed_count,
          'production_value', production_value,
          'return_value', return_value,
          'average_balloon_value', round(coalesce(average_balloon_value, 0), 2)
        )
        order by plan_type
      ) as plan_breakdown
    from plan_metrics
    group by seller_id, store, department, seller_name
  ),
  spf_linked as (
    select distinct
      vf.effective_seller_id as seller_id,
      vf.effective_store as store,
      vf.department,
      vf.seller_name,
      spf.id,
      spf.optional_value
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics as (
    select
      seller_id,
      store,
      department,
      seller_name,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_linked
    group by seller_id, store, department, seller_name
  ),
  metrics as (
    select
      sm.seller_id,
      sm.store,
      sm.department,
      sm.seller_name,
      sm.sold_count,
      sm.sales_value,
      coalesce(fm.financed_count, 0) as financed_count,
      coalesce(fm.production_value, 0)::numeric(18,2) as production_value,
      coalesce(fm.return_value, 0)::numeric(18,2) as return_value,
      coalesce(spm.spf_count, 0) as spf_count,
      coalesce(spm.spf_value, 0)::numeric(18,2) as spf_value,
      coalesce(pba.plan_breakdown, '[]'::jsonb) as plan_breakdown
    from sales_metrics sm
    left join finance_metrics fm
      on fm.seller_id = sm.seller_id
     and fm.store = sm.store
     and fm.department = sm.department
    left join spf_metrics spm
      on spm.seller_id = sm.seller_id
     and spm.store = sm.store
     and spm.department = sm.department
    left join plan_breakdown_agg pba
      on pba.seller_id = sm.seller_id
     and pba.store = sm.store
     and pba.department = sm.department
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'seller_id', seller_id,
        'seller_name', seller_name,
        'store', store,
        'department', department,
        'sold_count', sold_count,
        'sales_value', sales_value,
        'financed_count', financed_count,
        'share_percent',
          case
            when sold_count > 0
              then round(
                (financed_count::numeric / sold_count::numeric) * 100,
                4
              )
            else 0
          end,
        'production_value', production_value,
        'return_value', return_value,
        'spf_count', spf_count,
        'spf_value', spf_value,
        'spf_net_value',
          round(spf_value * (v_spf_net_percent / 100), 2),
        'profitability_value',
          round(
            return_value + (spf_value * (v_spf_net_percent / 100)),
            2
          ),
        'plan_breakdown', plan_breakdown
      )
      order by store, department, seller_name
    ),
    '[]'::jsonb
  )
  into v_rows
  from metrics;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'spf_net_percent', v_spf_net_percent,
    'eligibility_rule', 'ACTIVE_VENDEDOR_ONLY',
    'plan_priority_rule', 'SUBSIDIADO_REVERSAO_COPARTICIPADO_BALAO_LINEAR',
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'rows', v_rows
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_model_metrics_without_spf(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_scope jsonb;
  v_store text;
  v_departments text[];
  v_user_id uuid;
  v_caller_cpf text;
  v_is_master boolean;
  v_is_director boolean;
  v_is_seller boolean;
  v_rows jsonb;
  v_group_view_perfil text;
begin
  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Período inválido.' using errcode = '22023';
  end if;
  if p_end - p_start > 731 then
    raise exception 'Período máximo permitido: 732 dias.'
      using errcode = '22023';
  end if;

  v_scope := public.operational_current_scope();
  v_store := v_scope->>'store';
  v_departments := array(
    select jsonb_array_elements_text(v_scope->'departments')
  );
  v_is_master := (v_scope->>'is_master')::boolean;
  v_is_director := (v_scope->>'is_director')::boolean;
  v_is_seller := (v_scope->>'is_seller')::boolean;

  -- Fase UX-Grupo-3.0, Item 2: mesma regra de operational_metrics -- ver
  -- comentario la para o raciocinio completo. So amplia para ANALISTA/
  -- VENDEDOR; qualquer outro perfil preserva o escopo ja calculado por
  -- operational_current_scope() sem alteracao.
  if p_group_view then
    select upper(trim(coalesce(u.perfil, ''))) into v_group_view_perfil
    from public.usuarios u
    where u.auth_user_id = auth.uid() and u.ativo = true
    limit 1;
    -- Incidente P1 Group-View Authorization Escalation -- p_group_view era
    -- um booleano confiavel do cliente: qualquer VENDEDOR/ANALISTA podia
    -- chamar esta RPC diretamente (sem depender do frontend/modulo) e
    -- forcar v_is_master=true, recebendo dados nomeados de TODAS as lojas
    -- do Grupo. Corrigido reusando a mesma capacidade server-side ja usada
    -- para liberar o modulo Analise Geral do Grupo (dashbi) na navegacao
    -- do Portal -- portal_modulos_permitidos(), resolvida via auth.uid(),
    -- nunca por parametro do cliente. Um booleano do cliente pode
    -- EXPRESSAR intencao, mas nunca AUTORIZAR sozinho.
    if v_group_view_perfil in ('ANALISTA', 'VENDEDOR')
       and (public.portal_modulos_permitidos() ? 'dashbi') then
      v_is_master := true;
      v_scope := jsonb_set(v_scope, '{is_master}', 'true'::jsonb);
    end if;
  end if;

  select u.id, regexp_replace(coalesce(u.cpf_normalizado, u.cpf, ''), '\D', '', 'g')
  into v_user_id, v_caller_cpf
  from public.usuarios u
   where u.auth_user_id = auth.uid()
     and u.ativo = true
   limit 1;

  with latest_validated_batches as (
    select distinct on (b.source_type)
      b.id,
      b.source_type
    from public.portal_import_batches b
    where b.status = 'VALIDATED'
      and b.source_type in (
        'FINANCE_CURRENT', 'FINANCE_HISTORY',
        'SALES_CURRENT', 'SALES_HISTORY'
      )
    order by
      b.source_type,
      b.completed_at desc nulls last,
      b.created_at desc,
      b.id desc
  ),
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and (
        v_is_master
        or (
          (
            upper(trim(coalesce(u.status, ''))) = any(v_departments)
            or (
              upper(trim(coalesce(u.status, ''))) = 'NOVOS/SEMINOVOS'
              and (
                'NOVOS' = any(v_departments)
                or 'SEMINOVOS' = any(v_departments)
              )
            )
          )
          and (
            v_is_director
            or (v_is_seller and u.id = v_user_id)
            or (
              not v_is_seller
              and upper(trim(coalesce(u.loja, ''))) = v_store
            )
          )
        )
      )
    union all
    select ps.id, ps.name, ps.store, ps.status
      from public.portal_sellers ps
     where ps.active
       and upper(trim(coalesce(ps.profile_type, ''))) = 'VENDEDOR'
       and upper(trim(coalesce(ps.status, ''))) not in (
         'REVENDA', 'INATIVO', 'MASTER'
       )
       and not exists (
         select 1 from public.usuarios u2
         where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
       )
       and (
         v_is_master
         or (
           (
             upper(trim(coalesce(ps.status, ''))) = any(v_departments)
             or (
               upper(trim(coalesce(ps.status, ''))) = 'NOVOS/SEMINOVOS'
               and (
                 'NOVOS' = any(v_departments)
                 or 'SEMINOVOS' = any(v_departments)
               )
             )
           )
           and (
             v_is_director
             or (
               not v_is_seller
               and upper(coalesce(ps.store, '')) = v_store
             )
           )
         )
       )
  ),
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id, s.sale_date, s.chassis, s.seller_id, s.seller_user_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), es.store, 'SEM LOJA') as store,
      s.department,
      es.status as seller_status,
      coalesce(nullif(s.vehicle_model, ''), 'NÃO INFORMADO') as model,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    join eligible_sellers es on es.id = coalesce(s.seller_user_id, s.seller_id)
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select *
    from sales_global_latest
    where sale_date between p_start and p_end
      -- Incidente IA-1B: gate de AUTORIZACAO (nao de classificacao) -- para
      -- DIRETOR, exige que o departamento EFETIVO (temporal, com fallback
      -- para o status ATUAL da pessoa, mesma cadeia de operational_metrics)
      -- esteja no escopo. NAO usa o campo "department" bruto como fallback
      -- (usa-lo bloquearia indevidamente vendas legitimas de vendedores que
      -- nunca mudaram de departamento mas tem o campo de origem taggeado de
      -- forma inconsistente -- department bruto so aparece no OUTPUT, para
      -- classificacao/exibicao por modelo, que permanece inalterada).
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(coalesce(seller_user_id, seller_id), sale_date, null), seller_status, 'SEM DEPARTAMENTO'))) = any(v_departments)
      )
  ),
  sales_metrics as (
    select store, department, model,
           count(*)::integer as sold_count,
           coalesce(sum(sale_value), 0)::numeric(18,2) as sales_value
    from visible_sales
    group by store, department, model
  ),
  principal_finance as (
    select f.*,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and f.is_real_financing
      -- Incidente IA-1B: finance nao deriva de visible_sales (join por
      -- chassis em finance_linked e LEFT JOIN -- preserva finance orfa de
      -- venda), entao precisa do proprio gate de autorizacao. operation_date
      -- ja e a ancora temporal desta CTE (usada por resolve_store_temporal
      -- acima) -- mesma ancora aqui, nada arbitrario.
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
  ),
  -- Incidente Model-Metrics-Later-Return: mesma regra ja usada por
  -- operational_metrics (effective_finance) -- um chassi tambem conta como
  -- financiado quando so existe um registro de retorno tardio
  -- (is_later_return), nunca quando ja existe financiamento principal
  -- para o mesmo chassi (Parte 17/18 do incidente: never contar 2).
  later_return_finance as (
    select distinct on (f.chassis) f.*,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
      and f.is_later_return
      and (
        not v_is_director
        or upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status))) = any(v_departments)
      )
    order by f.chassis, f.return_value desc, f.id desc
  ),
  effective_finance as (
    select * from principal_finance
    union all
    select lrf.* from later_return_finance lrf
    where not exists (
      select 1 from principal_finance pf where pf.chassis = lrf.chassis
    )
  ),
  finance_linked as (
    select f.*,
      coalesce(nullif(f.vehicle_model, ''), s.model, 'NÃO INFORMADO') as model,
      s.department,
      s.sale_value,
      case
        when s.sale_value > 0
         and f.financed_or_service_value > 0
         and f.financed_or_service_value <= s.sale_value * 1.15
        then greatest(s.sale_value - f.financed_or_service_value, 0)
      end as entry_value
    from effective_finance f
    left join visible_sales s on s.chassis = f.chassis
  ),
  -- Classificação do plano por operação, mesma prioridade oficial da função
  -- planTypeFromFields() do frontend: SUBSIDIADO > REVERSÃO > COPARTICIPADO > BALÃO > LINEAR.
  finance_linked_classified as (
    select fl.*,
      case
        when fl.plan_codigo_if is not null
         and (upper(trim(fl.plan_codigo_if)) = '999'
              or upper(fl.plan_codigo_if) like '%SUBSIDIADO%')
          then 'SUBSIDIADO'
        when fl.plan_codigo_if is not null
         and (upper(trim(fl.plan_codigo_if)) = '777'
              or upper(fl.plan_codigo_if) like '%REVERSAO%'
              or upper(fl.plan_codigo_if) like '%REVERSÃO%')
          then 'REVERSÃO'
        when fl.tc_devolvida = 1 then 'COPARTICIPADO'
        when coalesce(fl.balloon_value, 0) > 0 then 'BALÃO'
        else 'LINEAR'
      end as plan_type
    from finance_linked fl
  ),
  finance_metrics as (
    select effective_store as store,
           coalesce(department, 'NOVOS') as department,
           model,
           count(distinct chassis)::integer as financed_count,
           coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
             as production_value,
           coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
           avg(installments) filter (where installments > 0)
             as average_installments,
           avg(installment_value) filter (where installment_value > 0)
             as average_installment_value,
           count(entry_value)::integer as valid_entry_count,
           coalesce(sum(entry_value), 0)::numeric(18,2) as entry_total,
           coalesce(sum(sale_value) filter (where entry_value is not null), 0)
             ::numeric(18,2) as entry_sales_value_total
    from finance_linked_classified
    group by effective_store, coalesce(department, 'NOVOS'), model
  ),
  plan_metrics as (
    select effective_store as store,
           coalesce(department, 'NOVOS') as department,
           model,
           plan_type,
           count(distinct chassis)::integer as financed_count,
           coalesce(sum(financed_or_service_value), 0)::numeric(18,2)
             as production_value,
           coalesce(sum(return_value), 0)::numeric(18,2) as return_value,
           -- Incidente UX-Grupo-3.1: "Valor Médio Balão" sempre mostrava
           -- R$0 (modo seguro) -- plan_breakdown nunca carregou o valor
           -- real de Op Fin - Balão PMT (R$), só financed_count/production/
           -- return. Mesmo padrão já usado para average_installment_value
           -- em finance_metrics -- média simples sobre as linhas com
           -- balloon_value>0 dentro de CADA grupo de plano (então só tem
           -- efeito real quando plan_type='BALÃO', que é a única
           -- classificação onde balloon_value>0 é o próprio critério).
           avg(balloon_value) filter (where balloon_value > 0)
             as average_balloon_value
    from finance_linked_classified
    group by effective_store, coalesce(department, 'NOVOS'), model, plan_type
  ),
  plan_breakdown_agg as (
    select store, department, model,
      jsonb_agg(
        jsonb_build_object(
          'plan_type', plan_type,
          'financed_count', financed_count,
          'production_value', production_value,
          'return_value', return_value,
          'average_balloon_value', round(coalesce(average_balloon_value, 0), 2)
        )
        order by plan_type
      ) as plan_breakdown
    from plan_metrics
    group by store, department, model
  ),
  keys as (
    select store, department, model from sales_metrics
    union
    select store, department, model from finance_metrics
  ),
  metrics as (
    select k.store, k.department, k.model,
      coalesce(sm.sold_count, 0) as sold_count,
      coalesce(sm.sales_value, 0) as sales_value,
      coalesce(fm.financed_count, 0) as financed_count,
      coalesce(fm.production_value, 0) as production_value,
      coalesce(fm.return_value, 0) as return_value,
      coalesce(fm.average_installments, 0) as average_installments,
      coalesce(fm.average_installment_value, 0)
        as average_installment_value,
      coalesce(fm.valid_entry_count, 0) as valid_entry_count,
      coalesce(fm.entry_total, 0) as entry_total,
      coalesce(fm.entry_sales_value_total, 0) as entry_sales_value_total,
      coalesce(pba.plan_breakdown, '[]'::jsonb) as plan_breakdown
    from keys k
    left join sales_metrics sm using (store, department, model)
    left join finance_metrics fm using (store, department, model)
    left join plan_breakdown_agg pba using (store, department, model)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'store', store,
    'department', department,
    'model', model,
    'sold_count', sold_count,
    'sales_value', sales_value,
    'financed_count', financed_count,
    'penetration_percent',
      case when sold_count > 0
        then round(financed_count::numeric / sold_count * 100, 4)
        else 0 end,
    'production_value', production_value,
    'return_value', return_value,
    'average_return_percent',
      case when production_value > 0
        then round(return_value / production_value * 100, 6)
        else 0 end,
    'average_installments', round(average_installments, 2),
    'average_installment_value', round(average_installment_value, 2),
    'valid_entry_count', valid_entry_count,
    'entry_total', entry_total,
    'entry_sales_value_total', entry_sales_value_total,
    'average_entry_value',
      case when valid_entry_count > 0
        then round(entry_total / valid_entry_count, 2)
        else 0 end,
    'weighted_entry_percent',
      case when entry_sales_value_total > 0
        then round(entry_total / entry_sales_value_total * 100, 6)
        else 0 end,
    'plan_breakdown', plan_breakdown
  ) order by store, department, model), '[]'::jsonb)
  into v_rows
  from metrics;

  return jsonb_build_object(
    'scope', v_scope,
    'period_start', p_start,
    'period_end', p_end,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'entry_rule', 'SUM_ENTRY_DIV_VALID_OPERATIONS',
    'entry_percent_rule', 'SUM_ENTRY_DIV_SUM_SALE_VALUE',
    'plan_priority_rule', 'SUBSIDIADO_REVERSAO_COPARTICIPADO_BALAO_LINEAR',
    'rows', v_rows
  );
end;
$function$;

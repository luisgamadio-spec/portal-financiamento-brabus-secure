-- Fase Cobertura-Details 1.0 -- detalhamento de vendas/financiamentos
-- durante cobertura de analista (Acompanhamento de Salario).
--
-- CONTEXTO: quando uma ANALISTA cobre outra loja durante ferias/ausencia
-- (ausencias_analistas), o "Acompanhamento de Salario" ja mostra o valor
-- agregado da cobertura, mas a substituta nao tinha como conferir a
-- composicao (quais vendedores, quais vendas, quais financiamentos).
--
-- IMPLEMENTACAO: RPC nova e isolada, public.operational_analyst_
-- coverage_details(p_coverage_id uuid). NAO altera operational_
-- salary_details, operational_metrics, nem nenhuma formula de comissao --
-- confirmado por diff bit-a-bit contra o corpo LIVE anterior a promocao.
--
-- PARAMETRO UNICO DE AUTORIDADE: p_coverage_id. Loja, periodo, CPF, nome
-- ou seller_id NUNCA sao aceitos como parametro -- tudo e resolvido
-- internamente a partir de ausencias_analistas.id = p_coverage_id.
--
-- AUTORIZACAO (backend, nunca frontend):
--   - MASTER: pode abrir qualquer coverage_id ativo.
--   - ANALISTA: exige perfil='ANALISTA' E cpf_normalizado do chamador
--     bater com ausencias_analistas.cpf_analista_substituto (nunca por
--     nome). O titular/ausente (cpf_analista_ausente) NAO autoriza nesta
--     versao, mesmo que o CPF do chamador bata com ele.
--   - VENDEDOR/GERENTE/DIRETOR: sem nova permissao (bloqueados pelo mesmo
--     gate de perfil).
--
-- SEMANTICA DE ativo AUDITADA FRESH: unico caminho de escrita de
-- ausencias_analistas e master_admin_manage (acoes CREATE/ARCHIVE/
-- SET_ACTIVE) -- ativo NUNCA e desligado automaticamente pela passagem de
-- data_fim, so por acao administrativa explicita (arquivamento). Por isso
-- o gate e ativo=true (nao current_date<=data_fim): a substituta continua
-- acessando o historico de uma cobertura ja encerrada cronologicamente,
-- contanto que o registro nao tenha sido invalidado.
--
-- POPULACAO: reaproveita literalmente as mesmas CTEs de
-- operational_analyst_coverage_metrics (latest_validated_batches,
-- eligible_sellers, sales_global_latest, visible_finance,
-- principal_finance/later_return/effective_finance, spf dedup por
-- seller_id+spf.id) -- herda os fixes 22.7/22.8/22.9, resolve_store_
-- temporal e o dedup canonico por chassi sem reinterpretar nenhuma regra.
-- Escopo de departamento elegivel usa o cadastro da PROPRIA substituta
-- (nao do chamador), garantindo que MASTER vendo o mesmo coverage_id
-- enxergue exatamente a mesma populacao que a substituta veria.
--
-- PERIODO: sempre o periodo INTEGRAL da cobertura (data_inicio->data_fim
-- de ausencias_analistas), nunca um subperiodo de tela. Nao ha parametro
-- de data no contrato -- decisao deliberada para nao reabrir superficie
-- de manipulacao de periodo e para permitir auditoria historica completa
-- independente de qual competencia estava sendo visualizada.
--
-- PRIVACIDADE: sem CPF/nome/telefone/e-mail de cliente (portal_sales e
-- portal_finance_operations nao tem essas colunas -- nada a vazar por
-- design). Chassi mascarado (ultimos 6 caracteres). client_match_key
-- usado apenas internamente para o vinculo de SPF, nunca retornado.
--
-- TESTADO em transacao com ROLLBACK: cobertura real (Jacenir ausente em
-- GASTAO, Giovanna substituta, 01/08-23/08) -- reconciliacao 1:1 com
-- operational_analyst_coverage_metrics(data_inicio,data_fim,loja_coberta)
-- (sold_count=28, financed_count=11, production=R$1.089.268,40,
-- return=R$49.030,83, spf=0, diferenca R$0,00); MASTER abrindo o mesmo
-- coverage_id obteve summary identico; IDOR (Giovanna->coverage da
-- Denise) negado; titular (Jacenir tentando a propria ausencia) negado;
-- cobertura arquivada negada; cobertura historica ja encerrada mas ativa
-- permitida; coverage_id inexistente negado; VENDEDOR/GERENTE/DIRETOR
-- diretos negados; auth.uid() orfao negado; usuario ANALISTA legitimo
-- porem inativo negado. Promovido e revalidado live com os mesmos
-- resultados. Zero alteracao em funcao pre-existente (diff bit-a-bit
-- confirmado em operational_analyst_coverage_metrics,
-- operational_analyst_commission_metrics e _v2).

CREATE OR REPLACE FUNCTION public.operational_analyst_coverage_details(p_coverage_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_ausencia public.ausencias_analistas%rowtype;
  v_user public.usuarios%rowtype;
  v_sub public.usuarios%rowtype;
  v_is_master boolean;
  v_caller_cpf text;
  v_result jsonb;
begin
  -- Fase Cobertura-Details 1.0 -- identidade do chamador.
  select *
  into v_user
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.' using errcode = '42501';
  end if;

  v_is_master := public.is_master();
  v_caller_cpf := regexp_replace(coalesce(v_user.cpf_normalizado, v_user.cpf, ''), '\D', '', 'g');

  -- Parametro unico de autoridade: p_coverage_id. Loja/periodo/CPF nunca
  -- sao aceitos como parametro -- tudo vem do registro em ausencias_analistas.
  select * into v_ausencia from public.ausencias_analistas a where a.id = p_coverage_id;

  -- Mensagem identica para "nao existe" e "existe mas nao pertence ao
  -- chamador" -- nunca revelar qual dos dois casos ocorreu (Parte 10).
  if v_ausencia.id is null then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  -- ativo=false = registro arquivado/cancelado pelo MASTER via
  -- master_admin_manage (acao ARCHIVE/SET_ACTIVE) -- NUNCA e setado
  -- automaticamente pela passagem de data_fim (auditado fresh: unico
  -- caminho de escrita da tabela e master_admin_manage, e so altera ativo
  -- em resposta a uma acao administrativa explicita). Por isso o gate
  -- correto e ativo=true, e NAO current_date <= data_fim -- a substituta
  -- deve continuar acessando o historico de uma cobertura ja encerrada
  -- cronologicamente, contanto que o registro nao tenha sido invalidado.
  if not v_ausencia.ativo then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  if not v_is_master then
    if upper(trim(coalesce(v_user.perfil, ''))) <> 'ANALISTA' then
      raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
    end if;
    -- Identidade por CPF normalizado -- mesmo contrato comprovado de
    -- ausencias_analistas.cpf_analista_substituto. Nunca por nome.
    -- Titular/ausente (cpf_analista_ausente) explicitamente NAO autoriza
    -- nesta versao, mesmo que o CPF do chamador bata com ele.
    if regexp_replace(coalesce(v_ausencia.cpf_analista_substituto, ''), '\D', '', 'g') <> v_caller_cpf then
      raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
    end if;
  end if;

  -- Escopo de departamento elegivel usa o cadastro da PROPRIA substituta
  -- (nunca do chamador) -- garante que MASTER abrindo o mesmo coverage_id
  -- ve exatamente a mesma populacao que a substituta veria, preservando a
  -- semantica ja usada em operational_analyst_coverage_metrics sem
  -- reinventar regra nova.
  select *
  into v_sub
  from public.usuarios u
  where u.cpf_normalizado = regexp_replace(coalesce(v_ausencia.cpf_analista_substituto, ''), '\D', '', 'g')
    and u.ativo = true
  limit 1;

  if v_sub.id is null then
    raise exception 'Cobertura não encontrada ou não autorizada.' using errcode = '42501';
  end if;

  with
  -- Mesmo bloco de latest_validated_batches de operational_analyst_coverage_metrics.
  latest_validated_batches as (
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
  -- Mesmo bloco de eligible_sellers de operational_analyst_coverage_metrics,
  -- trocando v_user por v_ausencia.loja_coberta / v_sub.status (a mesma
  -- entrada que a funcao original usaria se a propria substituta chamasse).
  eligible_sellers as (
    select u.id, u.nome as name, u.loja as store, u.status as status
    from public.usuarios u
    where upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR'
      and upper(trim(coalesce(u.loja, ''))) = upper(trim(v_ausencia.loja_coberta))
      and (
        (
          upper(trim(coalesce(u.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_sub.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(u.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_sub.status, '')) like '%SEMINOVOS%'
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
      and upper(trim(coalesce(ps.store, ''))) = upper(trim(v_ausencia.loja_coberta))
      and not exists (
        select 1 from public.usuarios u2
        where u2.cpf_normalizado = ps.cpf_normalizado and u2.ativo = true
      )
      and (
        (
          upper(trim(coalesce(ps.status, ''))) in ('NOVOS', 'NOVOS/SEMINOVOS')
          and replace(upper(coalesce(v_sub.status, '')), 'SEMINOVOS', '')
              like '%NOVOS%'
        )
        or (
          upper(trim(coalesce(ps.status, ''))) in (
            'SEMINOVOS', 'NOVOS/SEMINOVOS'
          )
          and upper(coalesce(v_sub.status, '')) like '%SEMINOVOS%'
        )
      )
  ),
  -- Mesmo bloco de sales_global_latest, com model/chassi adicionados para o
  -- detalhamento (nao existiam no agregado por nao serem necessarios la).
  sales_global_latest as (
    select distinct on (s.chassis)
      s.id,
      s.sale_date,
      s.chassis,
      s.vehicle_model,
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales as (
    select s.*, es.name as seller_name, es.status as seller_department
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between v_ausencia.data_inicio and v_ausencia.data_fim
      and upper(trim(coalesce(s.store, ''))) = upper(trim(v_ausencia.loja_coberta))
  ),
  -- Mesmo bloco de visible_finance de operational_analyst_coverage_metrics.
  visible_finance as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if,
      es.name as seller_name, es.status as seller_department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between v_ausencia.data_inicio and v_ausencia.data_fim
      and upper(trim(coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, ''))) =
          upper(trim(v_ausencia.loja_coberta))
  ),
  principal_finance as (
    select * from visible_finance where is_real_financing
  ),
  later_return as (
    select distinct on (
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from visible_finance
    where is_later_return
    order by
      seller_id,
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
  -- Mesmo dedup de spf_linked/spf_metrics de operational_analyst_coverage_metrics
  -- (distinct por seller_id+spf.id) -- autoridade do summary.spf_count/spf_value,
  -- garante reconciliacao 1:1 com o agregado existente.
  spf_dedup_by_seller as (
    select distinct vf.seller_id, spf.id, spf.optional_value
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  -- So para marcar, na linha de financiamento exibida, se ha SPF vinculado
  -- ao mesmo cliente -- flag booleana, nunca valor por linha, para nao
  -- arriscar dupla-contagem visual quando 1 cliente casa com >1 operacao.
  spf_present_by_finance as (
    select distinct vf.id as finance_id
    from visible_finance vf
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  sales_rows as (
    select jsonb_agg(
      jsonb_build_object(
        'sale_id', vs.id,
        'sale_date', vs.sale_date,
        'seller_id', vs.seller_id,
        'seller_name', vs.seller_name,
        'store', vs.store,
        'department', vs.seller_department,
        'model', vs.vehicle_model,
        'chassis_masked', case
          when vs.chassis is null or length(vs.chassis) <= 6 then vs.chassis
          else repeat('*', length(vs.chassis) - 6) || right(vs.chassis, 6)
        end,
        'sale_value', vs.sale_value
      )
      order by vs.sale_date, vs.seller_name, vs.id
    ) as rows
    from visible_sales vs
  ),
  finance_rows as (
    select jsonb_agg(
      jsonb_build_object(
        'finance_id', ef.id,
        'operation_date', ef.operation_date,
        'seller_id', ef.seller_id,
        'seller_name', ef.seller_name,
        'store', v_ausencia.loja_coberta,
        'department', ef.seller_department,
        'model', ef.vehicle_model,
        'chassis_masked', case
          when ef.chassis is null or length(ef.chassis) <= 6 then ef.chassis
          else repeat('*', length(ef.chassis) - 6) || right(ef.chassis, 6)
        end,
        'is_real_financing', ef.is_real_financing,
        'is_later_return', ef.is_later_return,
        'finance_code', ef.finance_code,
        'plan_codigo_if', ef.plan_codigo_if,
        'financed_or_service_value', ef.financed_or_service_value,
        'return_value', ef.return_value,
        'has_spf_linked', exists (select 1 from spf_present_by_finance sp where sp.finance_id = ef.id)
      )
      order by ef.operation_date, ef.seller_name, ef.id
    ) as rows
    from effective_finance ef
  ),
  summary as (
    select
      (select count(*) from visible_sales)::integer as sold_count,
      (select count(distinct chassis) from effective_finance)::integer as financed_count,
      (select coalesce(sum(financed_or_service_value), 0) from effective_finance)::numeric(18,2) as production_value,
      (select coalesce(sum(return_value), 0) from effective_finance)::numeric(18,2) as return_value,
      (select count(*) from spf_dedup_by_seller)::integer as spf_count,
      (select coalesce(sum(optional_value), 0) from spf_dedup_by_seller)::numeric(18,2) as spf_value
  )
  select jsonb_build_object(
    'coverage_id', v_ausencia.id,
    'store', v_ausencia.loja_coberta,
    'covered_start', v_ausencia.data_inicio,
    'covered_end', v_ausencia.data_fim,
    'substitute_analyst_name', v_ausencia.nome_analista_substituto,
    'absent_analyst_name', v_ausencia.nome_analista_ausente,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', true,
    'chassis_masking', 'last6',
    'summary', jsonb_build_object(
      'sold_count', s.sold_count,
      'financed_count', s.financed_count,
      'production_value', s.production_value,
      'return_value', s.return_value,
      'spf_count', s.spf_count,
      'spf_value', s.spf_value
    ),
    'sales', coalesce(sr.rows, '[]'::jsonb),
    'finance', coalesce(fr.rows, '[]'::jsonb)
  )
  into v_result
  from summary s, sales_rows sr, finance_rows fr;

  return v_result;
end;
$function$;

revoke all on function public.operational_analyst_coverage_details(uuid) from public, anon;
grant execute on function public.operational_analyst_coverage_details(uuid) to authenticated, service_role;

-- =========================================================================
-- Plumbing minimo (Fase Cobertura-Details 1.0): expor coverage_id
-- (ausencias_analistas.id) nas linhas de cobertura ja existentes, para o
-- frontend saber qual RPC nova chamar no botao "VER DETALHES".
--
-- Sem essa exposicao a funcionalidade e inviavel (nao ha outro campo no
-- contrato atual que identifique unicamente a cobertura). Nenhuma formula,
-- nenhum valor numerico ou logica de elegibilidade foi alterada -- apenas
-- 1 campo adicional em jsonb_build_object (v1) e 1 merge aditivo por linha
-- via jsonb concat (v2). Testado em transacao com ROLLBACK: capturado o
-- resultado de operational_analyst_commission_metrics_v2 ANTES do patch
-- (funcao ainda original na mesma transacao) e DEPOIS do patch, para
-- MASTER (13 linhas) e para Giovanna (5 linhas) no mesmo periodo real
-- (21/07-20/08); apos remover a chave 'coverage_id' de cada linha, os
-- dois conjuntos ficaram byte-a-byte identicos nos dois casos. Promovido e
-- revalidado live com o mesmo resultado.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.operational_analyst_commission_metrics(p_start date, p_end date)
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
  v_result jsonb;
begin
  if exists (
    select 1
    from public.ausencias_analistas a
    join public.ausencias_analistas b
      on b.id <> a.id
     and upper(trim(b.loja_coberta)) = upper(trim(a.loja_coberta))
     and b.ativo = true
     and a.ativo = true
     and daterange(b.data_inicio, b.data_fim, '[]')
         && daterange(a.data_inicio, a.data_fim, '[]')
    where a.data_inicio <= p_end
      and a.data_fim >= p_start
  ) then
    raise exception
      'Existem ausencias sobrepostas para a mesma loja no periodo.'
      using errcode = '22023';
  end if;

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

  with
  windows as (
    select 'BASE'::text as window_id, p_start as w_start, p_end as w_end
    union all
    select a.id::text, greatest(a.data_inicio, p_start), least(a.data_fim, p_end)
    from public.ausencias_analistas a
    where a.ativo = true
      and a.data_inicio <= p_end
      and a.data_fim >= p_start
  ),
  latest_validated_batches as (
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
      and upper(trim(coalesce(ps.status, ''))) not in ('REVENDA', 'INATIVO', 'MASTER')
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
      coalesce(s.seller_user_id, s.seller_id) as seller_id,
      coalesce(public.resolve_store_temporal(coalesce(s.seller_user_id, s.seller_id), s.sale_date, nullif(s.store, '')), ps.store, 'SEM LOJA') as store,
      s.sale_value
    from public.portal_sales s
    join latest_validated_batches lb on lb.id = s.batch_id
      and lb.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    left join public.portal_sellers ps on ps.id = s.seller_id
    order by s.chassis, s.sale_date desc, s.id desc
  ),
  visible_sales_env as (
    select s.*
    from sales_global_latest s
    join eligible_sellers es on es.id = s.seller_id
    where s.sale_date between p_start and p_end
  ),
  visible_finance_env as (
    select
      f.id, f.batch_id, f.source_row_number, f.operation_date, f.chassis, f.chassis_short,
      coalesce(f.seller_user_id, f.seller_id) as seller_id,
      f.seller_source_name, f.seller_nbs, f.store, f.service_description,
      f.is_real_financing, f.is_later_return, f.is_spf, f.return_value,
      f.financed_or_service_value, f.client_match_key, f.source_kind, f.created_at,
      f.vehicle_model, f.installments, f.installment_value, f.balloon_value,
      f.finance_code, f.tc_devolvida, f.plan_codigo_if,
      coalesce(public.resolve_store_temporal(es.id, f.operation_date, nullif(f.store, '')), es.store, 'SEM LOJA') as effective_store,
      es.name as seller_name,
      upper(trim(coalesce(public.resolve_department_temporal(es.id, f.operation_date, null), es.status, 'SEM DEPARTAMENTO'))) as department
    from public.portal_finance_operations f
    join latest_validated_batches lb
      on lb.id = f.batch_id
     and lb.source_type in ('FINANCE_CURRENT', 'FINANCE_HISTORY')
    join eligible_sellers es on es.id = coalesce(f.seller_user_id, f.seller_id)
    where f.operation_date between p_start and p_end
  ),
  sales_by_window as (
    select
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA') as store,
      count(*)::integer as sold_count
    from windows w
    join visible_sales_env vs
      on vs.sale_date between w.w_start and w.w_end
    join eligible_sellers es on es.id = vs.seller_id
    group by
      w.window_id,
      vs.seller_id,
      coalesce(nullif(vs.store, ''), es.store, 'SEM LOJA')
  ),
  finance_by_window as (
    select
      w.window_id,
      vf.*
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
  ),
  principal_finance_bw as (
    select *
    from finance_by_window
    where is_real_financing
  ),
  later_return_bw as (
    select distinct on (
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, ''))
    ) *
    from finance_by_window
    where is_later_return
    order by
      window_id,
      seller_id,
      coalesce(nullif(chassis, ''), 'CLIENT:' || coalesce(client_match_key, '')),
      return_value desc,
      id desc
  ),
  effective_finance_bw as (
    select * from principal_finance_bw
    union all
    select lr.*
    from later_return_bw lr
    where not exists (
      select 1
      from principal_finance_bw pf
      where pf.id = lr.id
        and pf.window_id = lr.window_id
    )
  ),
  finance_metrics_bw as (
    select
      window_id,
      seller_id,
      effective_store as store,
      count(distinct chassis)::integer as financed_count,
      coalesce(sum(financed_or_service_value), 0)::numeric(18,2) as production_value,
      coalesce(sum(return_value), 0)::numeric(18,2) as return_value
    from effective_finance_bw
    group by window_id, seller_id, effective_store
  ),
  spf_by_window as (
    select distinct
      w.window_id,
      vf.seller_id,
      vf.effective_store as store,
      spf.id,
      spf.optional_value
    from windows w
    join visible_finance_env vf
      on vf.operation_date between w.w_start and w.w_end
    join public.portal_spf_operations spf
      on spf.client_match_key = vf.client_match_key
     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
    join latest_validated_batches lb
      on lb.id = spf.batch_id
     and lb.source_type = 'SPF_CURRENT'
  ),
  spf_metrics_bw as (
    select
      window_id,
      seller_id,
      store,
      count(*)::integer as spf_count,
      coalesce(sum(optional_value), 0)::numeric(18,2) as spf_value
    from spf_by_window
    group by window_id, seller_id, store
  ),
  window_store_totals as (
    select
      sw.window_id,
      sw.store,
      sum(sw.sold_count)::integer as sold_count,
      sum(coalesce(fm.financed_count, 0))::integer as financed_count,
      sum(coalesce(fm.production_value, 0))::numeric(18,2) as production_value,
      sum(coalesce(fm.return_value, 0))::numeric(18,2) as return_value,
      sum(coalesce(spm.spf_count, 0))::integer as spf_count,
      sum(coalesce(spm.spf_value, 0))::numeric(18,2) as spf_value
    from sales_by_window sw
    left join finance_metrics_bw fm
      on fm.window_id = sw.window_id
     and fm.seller_id = sw.seller_id
     and fm.store = sw.store
    left join spf_metrics_bw spm
      on spm.window_id = sw.window_id
     and spm.seller_id = sw.seller_id
     and spm.store = sw.store
    group by sw.window_id, sw.store
  ),
  base_store_totals as (
    select store, sold_count, financed_count, production_value, return_value, spf_count, spf_value
    from window_store_totals
    where window_id = 'BASE'
  ),
  eligible_absence_windows as (
    select
      w.window_id as absence_id,
      w.w_start as covered_start,
      w.w_end as covered_end,
      a.nome_analista_substituto as analyst_name,
      bst.store
    from windows w
    join public.ausencias_analistas a on a.id::text = w.window_id
    join base_store_totals bst
      on upper(trim(bst.store)) = upper(trim(a.loja_coberta))
    where w.window_id <> 'BASE'
  ),
  absence_metrics as (
    select
      eaw.absence_id as id,
      eaw.store,
      eaw.analyst_name,
      eaw.covered_start,
      eaw.covered_end,
      coalesce(wst.sold_count, 0)::integer as sold_count,
      coalesce(wst.financed_count, 0)::integer as financed_count,
      coalesce(wst.production_value, 0)::numeric(18,2) as production_value,
      coalesce(wst.return_value, 0)::numeric(18,2) as return_value,
      coalesce(wst.spf_count, 0)::integer as spf_count,
      coalesce(wst.spf_value, 0)::numeric(18,2) as spf_value
    from eligible_absence_windows eaw
    left join window_store_totals wst
      on wst.window_id = eaw.absence_id
     and upper(trim(wst.store)) = upper(trim(eaw.store))
  ),
  absence_sums as (
    select
      store,
      sum(sold_count)::integer as sold_count,
      sum(financed_count)::integer as financed_count,
      sum(production_value)::numeric(18,2) as production_value,
      sum(return_value)::numeric(18,2) as return_value,
      sum(spf_count)::integer as spf_count,
      sum(spf_value)::numeric(18,2) as spf_value
    from absence_metrics
    group by store
  ),
  official_rows as (
    select
      coalesce(
        (
          select u.nome
          from public.usuarios u
          where u.ativo = true
            and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
            and upper(trim(coalesce(u.loja, ''))) =
                upper(trim(coalesce(st.store, '')))
          order by u.nome
          limit 1
        ),
        'ANALISTA NAO LOCALIZADO'
      ) as analyst_name,
      st.store,
      greatest(st.sold_count - coalesce(a.sold_count, 0), 0)::integer
        as sold_count,
      greatest(st.financed_count - coalesce(a.financed_count, 0), 0)::integer
        as financed_count,
      greatest(st.production_value - coalesce(a.production_value, 0), 0)
        ::numeric(18,2) as production_value,
      greatest(st.return_value - coalesce(a.return_value, 0), 0)
        ::numeric(18,2) as return_value,
      greatest(st.spf_count - coalesce(a.spf_count, 0), 0)::integer
        as spf_count,
      greatest(st.spf_value - coalesce(a.spf_value, 0), 0)
        ::numeric(18,2) as spf_value,
      false as transfer,
      null::date as covered_start,
      null::date as covered_end,
      null::text as coverage_id
    from base_store_totals st
    left join absence_sums a on a.store = st.store
  ),
  combined_rows as (
    select * from official_rows
    union all
    select
      analyst_name,
      store,
      sold_count,
      financed_count,
      production_value,
      return_value,
      spf_count,
      spf_value,
      true as transfer,
      covered_start,
      covered_end,
      id as coverage_id
    from absence_metrics
  )
  select jsonb_build_object(
    'period_start', p_start,
    'period_end', p_end,
    'absence_aware', true,
    'contains_personal_documents', false,
    'contains_client_identity', false,
    'contains_chassis', false,
    'rows',
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'analyst_name', analyst_name,
            'store', store,
            'sold_count', sold_count,
            'financed_count', financed_count,
            'production_value', production_value,
            'return_value', return_value,
            'spf_count', spf_count,
            'spf_value', spf_value,
            'transfer', transfer,
            'covered_start', covered_start,
            'covered_end', covered_end,
            'coverage_id', coverage_id
          )
          order by store, transfer, covered_start, analyst_name
        ),
        '[]'::jsonb
      )
  )
  into v_result
  from combined_rows
  where sold_count > 0
     or financed_count > 0
     or return_value > 0
     or spf_value > 0;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.operational_analyst_commission_metrics_v2(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_base jsonb;
  v_rows jsonb;
  v_coverage jsonb := '[]'::jsonb;
  v_absence record;
begin
  select *
  into v_user
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.'
      using errcode = '42501';
  end if;

  v_base := public.operational_analyst_commission_metrics(p_start, p_end);
  v_rows := coalesce(v_base->'rows', '[]'::jsonb);

  if upper(trim(coalesce(v_user.perfil, ''))) = 'ANALISTA' then
    for v_absence in
      select
        a.id as coverage_id,
        a.loja_coberta,
        greatest(a.data_inicio, p_start) as covered_start,
        least(a.data_fim, p_end) as covered_end
      from public.ausencias_analistas a
      where a.ativo = true
        and regexp_replace(
              coalesce(a.cpf_analista_substituto, ''),
              '\D',
              '',
              'g'
            ) = regexp_replace(
              coalesce(v_user.cpf_normalizado, v_user.cpf, ''),
              '\D',
              '',
              'g'
            )
        and a.data_inicio <= p_end
        and a.data_fim >= p_start
        and upper(trim(a.loja_coberta)) <>
            upper(trim(coalesce(v_user.loja, '')))
    loop
      -- Fase Cobertura-Details 1.0 -- injeta coverage_id (ausencias_analistas.id)
      -- em cada linha, so pra permitir o botao "VER DETALHES" no frontend
      -- chamar a nova RPC isolada. Nao altera nenhum valor numerico/formula.
      v_coverage := v_coverage ||
        coalesce(
          (
            select jsonb_agg(elem || jsonb_build_object('coverage_id', v_absence.coverage_id))
            from jsonb_array_elements(
              public.operational_analyst_coverage_metrics(
                v_absence.covered_start,
                v_absence.covered_end,
                v_absence.loja_coberta
              )
            ) elem
          ),
          '[]'::jsonb
        );
    end loop;
  end if;

  return jsonb_set(
    v_base,
    '{rows}',
    v_rows || v_coverage,
    true
  );
end;
$function$;

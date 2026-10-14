-- Aplicado em produção em 14/10/2026 (OK do Luis). Análise Geral do Grupo: ANALISTA/GERENTE veem os vendedores de
-- todas as lojas (vendas e financiados), com retorno em R$ por vendedor só da própria loja; das outras lojas o retorno
-- vem só como total da loja ('RETORNO DA LOJA'). Totais por loja/departamento idênticos aos do Master.
-- Teste obrigatório depois de qualquer migração nestas funções: supabase/tests/grupo_todo_8_lojas.sql

-- ANALISTA/GERENTE veem os VENDEDORES das outras lojas (vendas, financiados, produção, SPF), sem o retorno em R$ deles
-- (aprovada e aplicada em 14/10/2026). Desfazer: R_desfazer.sql
-- Na visão de grupo (p_group_view) da Análise Geral do Grupo:
--   - própria loja: linhas por vendedor completas (com retorno), como hoje;
--   - outras lojas: linhas por vendedor SEM as chaves de retorno (mesma lista de _operational_ocultar_retorno_vendedor)
--     e com retorno_oculto = true;
--   - + uma linha 'RETORNO DA LOJA' por loja/departamento (somente_retorno = true, agregado_loja = true, sem vendas nem
--     financiamentos) com o retorno total da loja por tipo de plano -- os totais por loja/departamento/grupo continuam
--     exatos (o front distribui esse total só entre os financiamentos daquela loja/departamento/plano, sem mostrar
--     retorno por vendedor).
-- Vendedor/RH (sem retorno nenhum), Master e diretoria: sem mudança.
begin;

CREATE OR REPLACE FUNCTION public._operational_grupo_retorno_por_loja(p jsonb, p_group_view boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_perfil text;
  v_loja text;
  v_proprias jsonb;
  v_vendedores jsonb;
  v_retorno jsonb;
  v_chaves_retorno constant text[] := array['return_value', 'return_gross', 'return_considered', 'average_return_percent',
    'profitability_value', 'operation_profitability', 'rent_total', 'comissao_principal', 'retorno', 'retorno_medio',
    'retorno_total', 'retorno_pct', 'retorno_medio_pct', 'retorno_pct_producao', 'rentabilidade'];
begin
  -- REGRA (14/10/2026, Luis): na Análise Geral do Grupo (p_group_view), ANALISTA e GERENTE veem os vendedores de TODAS as
  -- lojas, com vendas e financiados, mas o retorno em R$ POR VENDEDOR só da própria loja. Das outras lojas, o retorno vem
  -- só como total da loja (linha 'RETORNO DA LOJA', sem vendedor). Demais perfis: sem mudança.
  if p is null or not coalesce(p_group_view, false) then
    return p;
  end if;
  select upper(trim(coalesce(u.perfil, ''))) into v_perfil
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;
  if v_perfil is null or v_perfil not in ('ANALISTA', 'GERENTE') then
    return p;
  end if;
  v_loja := nullif(upper(trim(coalesce(public.operational_current_scope() ->> 'store', ''))), '');

  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_proprias
  from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
  where v_loja is not null and upper(trim(coalesce(x ->> 'store', ''))) = v_loja;

  -- outras lojas: o vendedor continua, sem nenhuma chave de retorno (inclusive dentro de plan_breakdown)
  select coalesce(jsonb_agg(public._jsonb_sem_chaves(x, v_chaves_retorno) || jsonb_build_object('retorno_oculto', true)), '[]'::jsonb)
  into v_vendedores
  from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
  where v_loja is null or upper(trim(coalesce(x ->> 'store', ''))) is distinct from v_loja;

  -- outras lojas: o retorno só como total da loja/departamento, por tipo de plano
  with outras as (
    select x from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) x
    where v_loja is null or upper(trim(coalesce(x ->> 'store', ''))) is distinct from v_loja
  ),
  tot as (
    select x ->> 'store' as store, x ->> 'department' as department,
      sum(coalesce((x ->> 'return_value')::numeric, 0)) as ret,
      sum(coalesce((x ->> 'profitability_value')::numeric, 0)) as rent
    from outras group by 1, 2
  ),
  pb as (
    select o.x ->> 'store' as store, o.x ->> 'department' as department, b ->> 'plan_type' as plan_type,
      sum(coalesce((b ->> 'return_value')::numeric, 0)) as rv
    from outras o, jsonb_array_elements(coalesce(o.x -> 'plan_breakdown', '[]'::jsonb)) b
    group by 1, 2, 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'seller_id', null, 'seller_name', 'RETORNO DA LOJA', 'agregado_loja', true, 'somente_retorno', true,
      'store', t.store, 'department', t.department,
      'sold_count', 0, 'sales_value', 0, 'financed_count', 0, 'share_percent', 0, 'production_value', 0,
      'spf_count', 0, 'spf_value', 0, 'spf_net_value', 0,
      'return_value', round(t.ret, 2), 'profitability_value', round(t.rent, 2),
      'plan_breakdown', coalesce((
        select jsonb_agg(jsonb_build_object('plan_type', b.plan_type, 'financed_count', 0, 'production_value', 0,
          'return_value', round(b.rv, 2), 'average_balloon_value', 0) order by b.plan_type)
        from pb b where b.store is not distinct from t.store and b.department is not distinct from t.department and b.rv <> 0), '[]'::jsonb)
    ) order by t.store, t.department), '[]'::jsonb)
  into v_retorno
  from tot t
  where t.ret <> 0 or t.rent <> 0;

  return jsonb_set(p, '{rows}', v_proprias || v_vendedores || v_retorno, true)
    || jsonb_build_object('retorno_outras_lojas', 'TOTAL_POR_LOJA');
end;
$function$;
revoke all on function public._operational_grupo_retorno_por_loja(jsonb, boolean) from public, anon, authenticated;

commit;

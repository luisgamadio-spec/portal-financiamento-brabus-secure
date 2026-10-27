-- Desfaz as referências por versão: volta aval_referencias ao backup e remove as funções internas novas.
begin;

CREATE OR REPLACE FUNCTION public.aval_referencias(p_id uuid, p_termo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
  v_termo text;
  v_vendas jsonb;
  v_resumo jsonb;
begin
  v_termo := upper(trim(regexp_replace(coalesce(nullif(trim(p_termo), ''), v.termo_referencia, v.modelo, ''), '\s+', ' ', 'g')));
  if length(v_termo) < 3 then
    raise exception 'Informe ao menos 3 letras do modelo para buscar as vendas do grupo.' using errcode = '22023';
  end if;
  if p_termo is not null and v_termo is distinct from v.termo_referencia then
    update public.aval_avaliacoes set termo_referencia = v_termo, atualizado_em = now() where id = v.id;
  end if;

  with vendas as (
    select distinct on (s.chassis, s.sale_date) s.sale_date, s.store, s.vehicle_model, s.sale_value
      from public.portal_sales s
     where s.department = 'SEMINOVOS'
       and s.sale_date >= (current_date - interval '12 months')
       and s.sale_value >= 5000
       and upper(s.vehicle_model) like replace(replace(v_termo, '%', ''), '_', '\_') || '%'
     order by s.chassis, s.sale_date, s.created_at desc, s.id desc
  )
  select
    jsonb_build_object(
      'quantidade', count(*),
      'mediana', percentile_cont(0.5) within group (order by sale_value),
      'p25', percentile_cont(0.25) within group (order by sale_value),
      'p75', percentile_cont(0.75) within group (order by sale_value),
      'minimo', min(sale_value), 'maximo', max(sale_value),
      'ultima_venda', max(sale_date)),
    coalesce((select jsonb_agg(jsonb_build_object('data', w.sale_date, 'loja', w.store, 'modelo', w.vehicle_model, 'valor', w.sale_value)
                               order by w.sale_date desc)
                from (select * from vendas order by sale_date desc limit 15) w), '[]'::jsonb)
    into v_resumo, v_vendas
  from vendas;

  return jsonb_build_object(
    'termo', v_termo,
    'fipe', jsonb_build_object('codigo', v.fipe_codigo, 'valor', v.fipe_valor, 'mes_ref', v.fipe_mes_ref, 'simulado', v.fipe_simulado),
    'vendas_grupo', v_resumo,
    'ultimas_vendas', v_vendas,
    'observacao', 'Vendas da Base 01 (últimos 12 meses), sem ano e km: a Base 01 não traz esses campos.');
end $function$;

revoke all on function public.aval_referencias(uuid, text) from public, anon;
grant execute on function public.aval_referencias(uuid, text) to authenticated;
drop function if exists public._aval_caracteristicas(text, text), public._aval_ano_chassi(text), public._aval_familias();

commit;

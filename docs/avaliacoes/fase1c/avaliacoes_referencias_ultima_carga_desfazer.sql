-- Desfaz: volta aval_referencias à versão anterior.
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
  v_base jsonb;
  v_ano integer := v.ano_modelo;
  v_letras text[];
  v_padrao text;
  v_res jsonb;
  c_pequena constant integer := 5;
begin
  v_termo := upper(trim(regexp_replace(coalesce(nullif(trim(p_termo), ''), v.termo_referencia,
                                                 concat_ws(' ', v.modelo, v.versao), ''), '\s+', ' ', 'g')));
  if length(v_termo) < 3 then
    raise exception 'Informe o modelo e a versão para buscar as vendas do grupo.' using errcode = '22023';
  end if;
  if p_termo is not null and v_termo is distinct from v.termo_referencia then
    update public.aval_avaliacoes set termo_referencia = v_termo, atualizado_em = now() where id = v.id;
  end if;
  -- o combustível da avaliação só vale quando a busca parte da própria versão confirmada
  v_base := public._aval_caracteristicas(v_termo, case when nullif(trim(p_termo), '') is null then v.combustivel end);
  if v_ano is null then
    raise exception 'A avaliação não tem ano-modelo.' using errcode = '22023';
  end if;

  -- filtro barato antes de ler o texto: letra de ano do chassi (ano ±1) e padrão da família
  v_letras := array(select substr('ABCDEFGHJKLMNPRSTVWXY123456789', ((a - 1980) % 30) + 1, 1)
                      from generate_series(v_ano - 1, v_ano + 1) a);
  v_padrao := coalesce((select f.padrao from public._aval_familias() f where f.nome = v_base->>'familia'),
                       ' ' || regexp_replace(coalesce(v_base->>'familia', ''), '([^A-Z0-9 ])', '\\1', 'g') || ' ');

  with brutas as (
    select distinct on (s.chassis, s.sale_date) s.chassis, s.sale_date, s.store, s.vehicle_model, s.sale_value
      from public.portal_sales s
     where s.department = 'SEMINOVOS'
       and s.sale_date >= (current_date - interval '12 months')
       and upper(substr(s.chassis, 10, 1)) = any(v_letras)
       and (' ' || regexp_replace(upper(s.vehicle_model), '[^A-Z0-9.\- ]', ' ', 'g') || ' ') ~ v_padrao
     order by s.chassis, s.sale_date, s.created_at desc, s.id desc
  ),
  vendas as (
    select b.sale_date, b.store, b.vehicle_model, b.sale_value,
           public._aval_ano_chassi(b.chassis) ano, public._aval_caracteristicas(b.vehicle_model) c
      from brutas b
  ),
  candidatas as (
    select *,
      (v_base->>'versao' is not null and c->>'versao' is not null and c->>'versao' = v_base->>'versao'
       and c->'edicao' = v_base->'edicao' and ano = v_ano) mesma
    from vendas
    where c->>'familia' = v_base->>'familia'
      and ano between v_ano - 1 and v_ano + 1
      and (v_base->>'motor' is null or c->>'motor' is null or c->>'motor' = v_base->>'motor')
      and (v_base->>'versao' is null or c->>'versao' is null or c->>'versao' = v_base->>'versao')
      and (v_base->>'combustivel' is null or c->>'combustivel' is null or c->>'combustivel' = v_base->>'combustivel')
      and (v_base->>'tracao' is null or c->>'tracao' is null or c->>'tracao' = v_base->>'tracao')
  ),
  cercas as (
    select percentile_cont(0.25) within group (order by sale_value) q1,
           percentile_cont(0.75) within group (order by sale_value) q3,
           count(*) filter (where sale_value >= 5000) n
      from candidatas where sale_value >= 5000
  ),
  marcadas as (
    select k.*, (k.sale_value < 5000 or (x.n >= 4 and (k.sale_value < x.q1 - 1.5 * (x.q3 - x.q1)
                                                       or k.sale_value > x.q3 + 1.5 * (x.q3 - x.q1)))) ignorada
      from candidatas k cross join cercas x
  ),
  resumo as (
    select g.grupo,
           jsonb_build_object('quantidade', count(m.*),
             'mediana', percentile_cont(0.5) within group (order by m.sale_value),
             'p25', percentile_cont(0.25) within group (order by m.sale_value),
             'p75', percentile_cont(0.75) within group (order by m.sale_value),
             'minimo', min(m.sale_value), 'maximo', max(m.sale_value),
             'amostra_pequena', count(m.*) < c_pequena) r
      from (values ('mesma'), ('proxima')) g(grupo)
      left join marcadas m on not m.ignorada and (case when m.mesma then 'mesma' else 'proxima' end) = g.grupo
     group by g.grupo
  )
  select jsonb_build_object(
    'mesma_versao_ano', (select r from resumo where grupo = 'mesma'),
    'versao_ou_ano_proximo', (select r from resumo where grupo = 'proxima'),
    'ignoradas', (select count(*) from marcadas where ignorada),
    'ignoradas_milhares', (select count(*) from marcadas where sale_value < 5000),
    'ignoradas_fora_da_faixa', (select count(*) from marcadas where ignorada and sale_value >= 5000),
    'vendas', coalesce((select jsonb_agg(jsonb_build_object('data', w.sale_date, 'loja', w.store, 'modelo', w.vehicle_model,
                                                          'ano', w.ano, 'valor', w.sale_value,
                                                          'grupo', case when w.mesma then 'mesma' else 'proxima' end,
                                                          'ignorada', w.ignorada)
                                       order by w.mesma desc, w.ignorada, w.sale_date desc)
                          from (select * from marcadas order by mesma desc, ignorada, sale_date desc limit 40) w), '[]'::jsonb))
  into v_res;

  return jsonb_build_object(
    'termo', v_termo,
    'base', v_base || jsonb_build_object('ano_modelo', v_ano),
    'fipe', jsonb_build_object('codigo', v.fipe_codigo, 'valor', v.fipe_valor, 'mes_ref', v.fipe_mes_ref, 'simulado', v.fipe_simulado),
    'amostra_pequena_abaixo_de', c_pequena)
    || v_res
    || jsonb_build_object('observacao',
         'Vendas de seminovos do grupo nos últimos 12 meses (Base 01). Ano-modelo pelo chassi; versão, motor, combustível e tração lidos do texto do NBS — quando o texto não traz o dado, a venda fica em "próximo".');
end $function$;

revoke all on function public.aval_referencias(uuid, text) from public, anon;
grant execute on function public.aval_referencias(uuid, text) to authenticated;

commit;

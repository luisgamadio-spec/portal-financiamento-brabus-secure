-- Avaliações — referências a partir da versão confirmada (27/10/2026).
-- Novas funções internas: _aval_familias, _aval_caracteristicas, _aval_ano_chassi. Troca: aval_referencias.
-- Backup: aval_referencias_antes.sql | Desfazer: avaliacoes_referencias_desfazer.sql
begin;

do $t$ begin
  if md5(pg_get_functiondef('public.aval_referencias(uuid,text)'::regprocedure)) <> 'dd0a3095459324a3c5b2733a604d3853' then
    raise exception 'TRAVA: aval_referencias mudou desde o backup';
  end if;
end $t$;

-- Famílias conhecidas (a mais específica primeiro) e o padrão que as reconhece no texto.
create or replace function public._aval_familias()
returns table(ordem integer, nome text, padrao text)
language sql immutable
set search_path = pg_catalog, public
as $$
  select * from (values
      (1, 'ECLIPSE CROSS', ' ECLIPSE '),  -- no grupo, ECLIPSE é sempre o Eclipse Cross
      (2, 'OUTLANDER SPORT', ' OUTLANDER SPORT '),
      (3, 'OUTLANDER', ' OUTLANDER '),
      (4, 'PAJERO SPORT', ' PAJERO (SPORT|[0-9.]+ SPORT) '),
      (5, 'PAJERO TR4', ' PAJERO TR4 '),
      (6, 'PAJERO DAKAR', ' PAJERO DAKAR '),
      (7, 'PAJERO FULL', ' PAJERO FULL '),
      (8, 'TRITON', ' (L200|TRITON) '),
      (9, 'COROLLA CROSS', ' COROLLA CROSS '),
      (10, 'YARIS CROSS', ' YARIS CROSS '),
      (11, 'ONIX PLUS', ' ONIX PLUS '),
      (12, 'GRAND SIENA', ' GRAND SIENA '),
      (13, 'SANTA FE', ' SANTA FE '),
      (14, 'RANGE ROVER EVOQUE', ' RANGE ROVER EVOQUE '),
      (15, 'RANGE ROVER', ' RANGE ROVER ')
  ) x(ordem, nome, padrao)
$$;

-- Leitor de características do texto do modelo (NBS ou fornecedor de placa).
-- Devolve família, motor, versão (nível de acabamento), edição, combustível e tração.
-- Campo que o texto não traz = nulo ("quando der": a comparação só usa o que os dois lados têm).
create or replace function public._aval_caracteristicas(p_texto text, p_combustivel text default null)
returns jsonb
language plpgsql immutable
set search_path = pg_catalog, public
as $$
declare
  t text := ' ' || regexp_replace(upper(translate(coalesce(p_texto, ''), 'ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç', 'AAAAEEIOOOUCaaaaeeiooouc')), '[^A-Z0-9.\- ]', ' ', 'g') || ' ';
  v_familia text;
  v_resto text;
  v_motor text;
  v_versao text;
  v_edicao text[] := array[]::text[];
  v_comb text;
  v_tracao text;
  f record;
  e text;
begin
  t := regexp_replace(t, '\s+', ' ', 'g');
  -- família: lista em ordem (a mais específica primeiro); senão, a 1ª palavra
  for f in select * from public._aval_familias() order by ordem loop
    if t ~ f.padrao then v_familia := f.nome; exit; end if;
  end loop;
  if v_familia is null then
    v_familia := nullif(split_part(trim(t), ' ', 1), '');
  end if;
  -- o resto do texto (sem as palavras da família) é que define versão/edição
  v_resto := ' ' || regexp_replace(t, ' (ECLIPSE|CROSS|CR|OUTLANDER|PAJERO|L200|TRITON|COROLLA|' || replace(coalesce(v_familia, ''), ' ', '|') || ') ', ' ', 'g') || ' ';
  v_resto := regexp_replace(v_resto, ' (ECLIPSE|CROSS|CR|OUTLANDER|PAJERO|L200|TRITON|COROLLA) ', ' ', 'g');
  -- na L200 Triton toda a linha é "Sport": não é versão
  if v_familia in ('PAJERO SPORT', 'OUTLANDER SPORT', 'TRITON') then
    v_resto := regexp_replace(v_resto, ' SPORT ', ' ', 'g');
  end if;

  -- motor: primeira cilindrada 0.0 (aceita 1.5T, 2.2D, 3.0L)
  v_motor := substring(t from ' ([0-9]\.[0-9])(T|D|L|G)? ');
  if v_motor is null then v_motor := substring(t from '([0-9]\.[0-9])'); end if;

  -- versão (nível): a primeira que aparecer na ordem de prioridade
  v_versao := case
    when v_resto ~ ' (HPE-S|HPES|HPE S) ' then 'HPE-S'
    when v_resto ~ ' HPE ' then 'HPE'
    when v_resto ~ ' PHEV ' then 'PHEV'
    when v_resto ~ ' GLS ' then 'GLS'
    when v_resto ~ ' GLX ' then 'GLX'
    when v_resto ~ ' HLS ' then 'HLS'
    when v_resto ~ ' GLI ' then 'GLI'
    when v_resto ~ ' GL ' then 'GL'
    when v_resto ~ ' GT ' then 'GT'
    when v_resto ~ ' COMFORT ' then 'COMFORT'
    when v_resto ~ ' (LIMITED) ' then 'LIMITED'
    when v_resto ~ ' (LONGITUDE|LONGITU) ' then 'LONGITUDE'
    when v_resto ~ ' (TRAILHAWK|TRAI) ' then 'TRAILHAWK'
    when v_resto ~ ' (XRX) ' then 'XRX'
    when v_resto ~ ' (XRE) ' then 'XRE'
    when v_resto ~ ' (XRS) ' then 'XRS'
    when v_resto ~ ' (XR) ' then 'XR'
    when v_resto ~ ' (XEI) ' then 'XEI'
    when v_resto ~ ' (GR-S|GR SP|GR-SP) ' then 'GR-S'
    when v_resto ~ ' ALTIS ' then 'ALTIS'
    when v_resto ~ ' (EXL) ' then 'EXL'
    when v_resto ~ ' (EX) ' then 'EX'
    when v_resto ~ ' (LX) ' then 'LX'
    when v_resto ~ ' (HIGHLINE) ' then 'HIGHLINE'
    when v_resto ~ ' (COMFORTLINE) ' then 'COMFORTLINE'
    when v_resto ~ ' (LTZ) ' then 'LTZ'
    when v_resto ~ ' (LT) ' then 'LT'
    when v_resto ~ ' (PREMIER) ' then 'PREMIER'
    when v_resto ~ ' (SPORT) ' then 'SPORT'
    when v_resto ~ ' (S) ' and v_familia = 'COMPASS' then 'S'
    else null end;

  -- edição/série (diferencia, por exemplo, HPE de HPE BLACK)
  foreach e in array array['BLACK','LEGEND','KATANA','SAVANA','OUTDOOR','TERRA','URBAN','TARMAC','RUSH','SIGNATURE','TOP','DAKAR'] loop
    if v_resto ~ (' ' || e || ' ') then v_edicao := v_edicao || e; end if;
  end loop;

  -- edições que são a própria versão (sem nível HPE/GLS no texto)
  if v_versao is null then
    foreach e in array array['KATANA','LEGEND','SAVANA','TARMAC','RUSH'] loop
      if e = any(v_edicao) then v_versao := e; v_edicao := array_remove(v_edicao, e); exit; end if;
    end loop;
  end if;

  -- combustível: o informado vence; senão, o texto
  v_comb := nullif(upper(trim(coalesce(p_combustivel, ''))), '');
  if v_comb is null then
    v_comb := case
      when t ~ ' PHEV ' then 'PHEV'
      when t ~ ' (HYBRID|HIBRIDO) ' then 'HIBRIDO'
      when t ~ ' (ELETRICO|EV) ' then 'ELETRICO'
      when t ~ ' FLEX ' then 'FLEX'
      when t ~ ' (DIESEL|DI-D|DI|TD350|[0-9]\.[0-9]D|D) ' then 'DIESEL'
      when t ~ ' (GASOLINA|GASOLIN|GASOL|GASO|G) ' then 'GASOLINA'
      else null end;
  elsif v_comb ~ 'GASOL' then v_comb := 'GASOLINA';
  elsif v_comb ~ 'HIBRID|HYBRID' then v_comb := 'HIBRIDO';
  end if;

  v_tracao := case
    when t ~ ' (4X4|AWD|4WD|S-AWC|AWC|4X4X|AWD-CVT|4X4-AT|4WD-AT) ' then '4X4'
    when t ~ ' (4X2|2WD) ' then '4X2'
    else null end;

  return jsonb_build_object('familia', v_familia, 'motor', v_motor, 'versao', v_versao,
                            'edicao', to_jsonb(v_edicao), 'combustivel', v_comb, 'tracao', v_tracao);
end $$;

-- Ano-modelo pelo 10º caractere do chassi (VIN). O código se repete a cada 30 anos:
-- fica o ano mais recente que não passe de (ano atual + 1).
create or replace function public._aval_ano_chassi(p_chassi text)
returns integer
language sql stable
set search_path = pg_catalog, public
as $$
  with c as (select upper(substr(coalesce(p_chassi, ''), 10, 1)) k),
       b as (select position(k in 'ABCDEFGHJKLMNPRSTVWXY123456789') i from c)
  select case when length(coalesce(p_chassi, '')) <> 17 or i = 0 then null
              else (select max(a) from (values (1980 + i - 1), (2010 + i - 1), (2040 + i - 1)) v(a)
                     where a <= extract(year from now())::int + 1) end
    from b
$$;
-- Referências do grupo a partir da VERSÃO confirmada na avaliação (pedido do Luis, 27/10/2026).
-- Só entram vendas de seminovos (Base 01, últimos 12 meses) da mesma família, com ano-modelo ±1
-- (10º caractere do chassi) e sem conflito de motor, versão, combustível ou tração. Quando um dos
-- lados não traz o campo (texto do NBS cortado, por exemplo), ele não é usado para excluir.
--   "mesma versão e ano": mesmo ano, mesma versão e mesma edição, ambas conhecidas;
--   "versão ou ano próximo": o resto que passou (ano ±1, versão indeterminada no texto, outra edição).
-- Valores absurdos: abaixo de R$ 5.000 (a carga histórica de jan–mai/2026 tem vendas lançadas em milhares,
-- ex.: 141,00 = R$ 141 mil), ou fora das cercas de Tukey (Q1 − 1,5·IQR, Q3 + 1,5·IQR)
-- do conjunto encontrado, quando houver 4 vendas ou mais; aparecem na lista marcados como ignorados.
-- p_termo (opcional): "buscar como" — texto da versão a usar no lugar da versão da avaliação.
create or replace function public.aval_referencias(p_id uuid, p_termo text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
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
end $$;

revoke all on function public._aval_caracteristicas(text, text) from public, anon, authenticated;
revoke all on function public._aval_ano_chassi(text) from public, anon, authenticated;
revoke all on function public.aval_referencias(uuid, text) from public, anon;
grant execute on function public.aval_referencias(uuid, text) to authenticated;
revoke all on function public._aval_familias() from public, anon, authenticated;

commit;

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

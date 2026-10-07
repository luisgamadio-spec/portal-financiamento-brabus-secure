-- Reversão de 20261007190000_apply_base03_dryrun_count_distinct.sql: texto exato da função antes da mudança (07/10/2026).
CREATE OR REPLACE FUNCTION public.master_operational_apply_base03(p_original_filename text, p_source_sha256 text, p_finance_rows jsonb, p_spf_rows jsonb, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'extensions'
AS $function$
declare
  v_finance_batch_id uuid;
  v_finance_matched integer := 0;
  v_finance_ambiguous integer := 0;
  v_finance_rows_count integer;
  v_sha text := lower(trim(coalesce(p_source_sha256, '')));
  v_spf_batch_id uuid;
  v_spf_rows_count integer;
  v_spf_accepted integer := 0;
  v_spf_rejected integer := 0;
  v_spf_principal_accepted integer := 0;
  v_chunk jsonb;
  v_i integer;
  v_chunk_size constant integer := 500;
  v_max_rows constant integer := 10000;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;

  if jsonb_typeof(p_finance_rows) <> 'array' or jsonb_typeof(p_spf_rows) <> 'array' then
    raise exception 'Payload inválido: finance_rows e spf_rows devem ser arrays.' using errcode = '22023';
  end if;
  v_finance_rows_count := jsonb_array_length(p_finance_rows);
  v_spf_rows_count := jsonb_array_length(p_spf_rows);
  if v_finance_rows_count > v_max_rows or v_spf_rows_count > v_max_rows then
    raise exception 'Lote da Base 03 excede o limite de % linhas.', v_max_rows using errcode = '22023';
  end if;

  if not p_dry_run then
    if trim(coalesce(p_original_filename, '')) = '' or v_sha !~ '^[a-f0-9]{64}$' then
      raise exception 'Metadados de arquivo inválidos.' using errcode = '22023';
    end if;
  end if;

  select b.id into v_finance_batch_id
  from public.portal_import_batches b
  where b.source_type = 'FINANCE_CURRENT' and b.status = 'VALIDATED'
  order by b.completed_at desc nulls last, b.created_at desc, b.id desc
  limit 1;

  if v_finance_batch_id is null then
    raise exception 'Nenhuma Base 02 (FINANCE_CURRENT) validada foi encontrada. Atualize a Base 02 antes da Base 03.'
      using errcode = 'P0002';
  end if;

  -- Incidente T35918/M4 -- só operações realizadas (PAGA/FATURADA)
  -- participam da identificação da operação elegível; reforçado aqui no
  -- servidor mesmo que o navegador já filtre, para nunca depender só do
  -- filtro do cliente. Agrupa por chave de documento (nunca por nome),
  -- calculada aqui dentro (o navegador nunca vê nem calcula a chave) a
  -- partir do documento normalizado enviado por linha.
  create temp table tmp_m4_keyed on commit drop as
  select
    public.portal_document_match_key(x.client_document_normalized) as match_key,
    x.op_code, x.plan_codigo_if, x.tc_devolvida, x.balloon_value,
    x.installments, x.installment_value, x.vehicle_model
  from jsonb_to_recordset(p_finance_rows) as x(
    client_document_normalized text, op_code text, status text,
    plan_codigo_if text, tc_devolvida numeric, balloon_value numeric,
    installments integer, installment_value numeric, vehicle_model text
  )
  where upper(trim(coalesce(x.status, ''))) in ('PAGA', 'FATURADA');

  -- Incidente T35918/M4 Wave 1.1 -- a auditoria de 5 casos reais provou que
  -- agrupar só por SINAL de classificação (n_signals = count(distinct
  -- (Código IF, TC Devolvida))) é inseguro: 3 dos 5 casos reais encontrados
  -- eram operações GENUINAMENTE DIFERENTES (financiado/parcelas/PMT/balão
  -- todos divergentes, datas de contrato meses apart) que só coincidiam na
  -- CATEGORIA de plano (ex.: ambas BALÃO) -- mesma classificação final, mas
  -- enriquecimento (PMT/parcelas/balão) diferente e potencialmente errado
  -- se a operação errada fosse escolhida. Um segundo achado (casos 4/5):
  -- mesmo par de operações Base03 casando com DOIS chassis/financiamentos
  -- diferentes do mesmo cliente (~16h de intervalo) -- documento identifica
  -- o CLIENTE, não necessariamente o EVENTO de financiamento; nenhuma
  -- contagem de sinal ajuda aqui, só uma seleção verdadeiramente única
  -- resolve com segurança. Corrigido: autoridade de seleção passa a ser
  -- SOMENTE n_ops = count(distinct operation_code) -- nunca o sinal de
  -- classificação, nunca payload, nunca proximidade de valor/data (essas
  -- continuam fora de escopo como autoridade de produto nesta wave).
  create temp table tmp_m4_grouped on commit drop as
  select
    match_key,
    count(distinct op_code) as n_ops,
    (array_agg(plan_codigo_if order by op_code))[1] as any_plan_codigo_if,
    (array_agg(tc_devolvida order by op_code))[1] as any_tc_devolvida,
    (array_agg(balloon_value order by op_code))[1] as any_balloon_value,
    (array_agg(installments order by op_code))[1] as any_installments,
    (array_agg(installment_value order by op_code))[1] as any_installment_value,
    (array_agg(vehicle_model order by op_code))[1] as any_vehicle_model
  from tmp_m4_keyed
  where match_key is not null
  group by match_key;

  select count(*) into v_finance_ambiguous from tmp_m4_grouped where n_ops > 1;

  if p_dry_run then
    select count(*) into v_finance_matched
    from public.portal_finance_operations f
    join public.portal_sales s on s.chassis = f.chassis
    join tmp_m4_grouped g on g.match_key = s.client_document_match_key and g.n_ops = 1
    where f.batch_id = v_finance_batch_id;

    return jsonb_build_object(
      'dry_run', true,
      'finance_batch_id', v_finance_batch_id,
      'finance_rows_received', v_finance_rows_count,
      'finance_rows_matched', v_finance_matched,
      'finance_rows_ambiguous_excluded', v_finance_ambiguous,
      'spf_rows_received', v_spf_rows_count
    );
  end if;

  -- Enriquecimento: só aplica quando existe EXATAMENTE UMA operation_code
  -- PAGA/FATURADA distinta (n_ops = 1) para o documento casado por chassi.
  -- Múltiplas operações distintas (n_ops > 1) NUNCA são resolvidas
  -- automaticamente -- nem por sinal de classificação igual, nem por
  -- payload igual, nem por proximidade de valor/data, nem por ordem --
  -- ficam de fora do UPDATE, o registro permanece como estava.
  with updated as (
    update public.portal_finance_operations f
       set vehicle_model = coalesce(nullif(upper(trim(g.any_vehicle_model)), ''), f.vehicle_model),
           installments = case when g.any_installments > 0 then g.any_installments else f.installments end,
           installment_value =
             case when g.any_installment_value > 0 then g.any_installment_value else f.installment_value end,
           balloon_value =
             case when g.any_balloon_value > 0 then g.any_balloon_value else f.balloon_value end,
           tc_devolvida = g.any_tc_devolvida,
           plan_codigo_if = nullif(upper(trim(g.any_plan_codigo_if)), '')
      from public.portal_sales s
      join tmp_m4_grouped g on g.match_key = s.client_document_match_key and g.n_ops = 1
     where f.batch_id = v_finance_batch_id
       and f.chassis = s.chassis
    returning 1
  )
  select count(*) into v_finance_matched from updated;

  if v_spf_rows_count > 0 then
    v_spf_batch_id := public.master_operational_begin_import(
      'SPF_CURRENT', p_original_filename, v_sha, v_spf_rows_count
    );

    v_i := 0;
    while v_i < v_spf_rows_count loop
      select jsonb_agg(elem) into v_chunk
      from jsonb_array_elements(p_spf_rows) with ordinality as t(elem, ord)
      where ord > v_i and ord <= v_i + v_chunk_size;

      v_spf_accepted := v_spf_accepted
        + public.master_operational_import_spf(v_spf_batch_id, v_chunk);
      v_i := v_i + v_chunk_size;
    end loop;
    v_spf_rejected := v_spf_rows_count - v_spf_accepted;

    select count(*) into v_spf_principal_accepted
    from public.portal_spf_operations
    where batch_id = v_spf_batch_id and is_spf_extra = false;

    if v_spf_principal_accepted = 0 then
      raise exception 'Lote SPF_CURRENT rejeitado: % linha(s) recebida(s), % aceita(s), mas nenhuma é linha operacional principal (todas são SPF Extra). Isso indica que a Base 03 completa não foi enviada — apenas o subconjunto SPF Extra. Selecione o arquivo completo da Base 03 e tente novamente.',
        v_spf_rows_count, v_spf_accepted
        using errcode = '22023';
    end if;

    perform public.master_operational_finalize_import(
      v_spf_batch_id, v_spf_accepted, v_spf_rejected,
      format(
        'Gestão de Bases (Base 03 atômica, identidade por documento): %s SPF aceitas (%s principais + %s SPF Extra), %s rejeitadas; %s linhas financeiras enriquecidas; %s documentos ambíguos (múltiplas operações PAGA/FATURADA) deixados de fora do enriquecimento automático.',
        v_spf_accepted, v_spf_principal_accepted, v_spf_accepted - v_spf_principal_accepted, v_spf_rejected, v_finance_matched, v_finance_ambiguous
      )
    );
  end if;

  return jsonb_build_object(
    'dry_run', false,
    'finance_batch_id', v_finance_batch_id,
    'finance_rows_matched', v_finance_matched,
    'finance_rows_ambiguous_excluded', v_finance_ambiguous,
    'spf_batch_id', v_spf_batch_id,
    'spf_rows_received', v_spf_rows_count,
    'spf_accepted', v_spf_accepted,
    'spf_principal_accepted', v_spf_principal_accepted,
    'spf_rejected', v_spf_rejected
  );
end;
$function$
;

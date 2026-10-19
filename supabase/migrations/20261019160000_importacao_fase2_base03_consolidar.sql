-- FASE 2 da importação (19/10/2026): Base 03 em partes + consolidação final rápida e atômica.
-- Desfazer: drop function public.master_operational_base03_consolidar(uuid, jsonb);

create or replace function public.master_operational_base03_consolidar(p_spf_batch_id uuid, p_finance_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public', 'extensions'
as $function$
-- FASE 2 (19/10/2026): consolidação final da Base 03. O SPF já foi gravado em partes num lote VALIDATING
-- (begin_import + import_spf); aqui, numa transação só: enriquecimento dos financiamentos (mesmo código da
-- apply_base03), travas e confirmação do lote. Se algo falhar, nada muda (Base 03 e financiamentos anteriores ficam).
declare
  v_finance_batch_id uuid;
  v_finance_matched integer := 0;
  v_finance_ambiguous integer := 0;
  v_finance_rows_count integer;
  v_spf_rows_read integer;
  v_spf_accepted integer;
  v_spf_principal_accepted integer;
  v_ultima_normal integer;
  v_max_rows constant integer := 10000;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_finance_rows) <> 'array' then
    raise exception 'Payload inválido: finance_rows deve ser um array.' using errcode = '22023';
  end if;
  v_finance_rows_count := jsonb_array_length(p_finance_rows);
  if v_finance_rows_count > v_max_rows then
    raise exception 'Lote da Base 03 excede o limite de % linhas.', v_max_rows using errcode = '22023';
  end if;

  -- o lote SPF tem de ser deste usuário, estar em validação e já ter recebido as partes
  select b.rows_read into v_spf_rows_read
  from public.portal_import_batches b
  where b.id = p_spf_batch_id and b.imported_by = auth.uid() and b.source_type = 'SPF_CURRENT' and b.status = 'VALIDATING'
  for update;
  if v_spf_rows_read is null then
    raise exception 'Lote SPF inválido ou já confirmado.' using errcode = '42501';
  end if;
  select count(*), count(*) filter (where is_spf_extra = false) into v_spf_accepted, v_spf_principal_accepted
  from public.portal_spf_operations where batch_id = p_spf_batch_id;
  if v_spf_principal_accepted = 0 then
    raise exception 'Lote SPF_CURRENT rejeitado: % linha(s) recebida(s), % aceita(s), mas nenhuma é linha operacional principal (todas são SPF Extra). Isso indica que a Base 03 completa não foi enviada — apenas o subconjunto SPF Extra. Selecione o arquivo completo da Base 03 e tente novamente.',
      v_spf_rows_read, v_spf_accepted using errcode = '22023';
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

  -- Trava (incidente 07/10/2026), agora também no servidor: 0 financiamentos completados, ou menos da metade
  -- da última importação normal, desfaz tudo (mesma regra da tela).
  select substring(b.validation_message from '([0-9]+) linhas financeiras enriquecidas')::int into v_ultima_normal
  from public.portal_import_batches b
  where b.source_type = 'SPF_CURRENT' and b.status = 'VALIDATED'
    and substring(b.validation_message from '([0-9]+) linhas financeiras enriquecidas')::int > 0
  order by b.completed_at desc nulls last, b.created_at desc limit 1;
  if v_finance_matched = 0 or (v_ultima_normal is not null and v_finance_matched < v_ultima_normal * 0.5) then
    raise exception 'IMPORTAÇÃO BLOQUEADA: a Base 03 completaria % financiamento(s) (última importação normal: %). Confira se a Base 01 e a Base 02 foram atualizadas antes, com os arquivos do mesmo dia.',
      v_finance_matched, coalesce(v_ultima_normal::text, '—') using errcode = '22023';
  end if;

  perform public.master_operational_finalize_import(
    p_spf_batch_id, v_spf_accepted, v_spf_rows_read - v_spf_accepted,
    format(
      'Gestão de Bases (Base 03 atômica, identidade por documento): %s SPF aceitas (%s principais + %s SPF Extra), %s rejeitadas; %s linhas financeiras enriquecidas; %s documentos ambíguos (múltiplas operações PAGA/FATURADA) deixados de fora do enriquecimento automático.',
      v_spf_accepted, v_spf_principal_accepted, v_spf_accepted - v_spf_principal_accepted, v_spf_rows_read - v_spf_accepted, v_finance_matched, v_finance_ambiguous
    )
  );

  return jsonb_build_object(
    'dry_run', false,
    'finance_batch_id', v_finance_batch_id,
    'finance_rows_matched', v_finance_matched,
    'finance_rows_ambiguous_excluded', v_finance_ambiguous,
    'spf_batch_id', p_spf_batch_id,
    'spf_rows_received', v_spf_rows_read,
    'spf_accepted', v_spf_accepted,
    'spf_principal_accepted', v_spf_principal_accepted,
    'spf_rejected', v_spf_rows_read - v_spf_accepted
  );
end;
$function$;

revoke all on function public.master_operational_base03_consolidar(uuid, jsonb) from public, anon;
grant execute on function public.master_operational_base03_consolidar(uuid, jsonb) to authenticated;

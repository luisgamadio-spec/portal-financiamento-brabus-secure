-- Aplicada em produção em 09/10/2026 (validada antes com ROLLBACK: 38/38). PASSO 3: operational_score_coparticipated_data passa por _operational_ocultar_retorno_vendedor -- só MASTER, DIRETOR, GERENTE e ANALISTA recebem o retorno por contrato; notas do Score inalteradas. Rollback: docs/rollback/score_passo3_antes.sql
begin;
CREATE OR REPLACE FUNCTION public.operational_score_coparticipated_data(p_start date, p_end date, p_group_view boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  return public._operational_ocultar_retorno_vendedor(public._operational_score_coparticipated_data_core(p_start, p_end, p_group_view));
end;
$function$;
commit;

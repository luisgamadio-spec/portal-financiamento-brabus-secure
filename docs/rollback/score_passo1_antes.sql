-- ROLLBACK do PASSO 1.
begin;
DROP FUNCTION IF EXISTS public.operational_score_vendedores(date, date);
DROP FUNCTION IF EXISTS public._operational_score_coparticipated_data_core(date, date, boolean);
NOTIFY pgrst, 'reload schema';
commit;

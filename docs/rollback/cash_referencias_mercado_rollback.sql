-- Desfaz 20261013200000_cash_referencias_mercado.sql (as linhas de auditoria já gravadas ficam).
drop function if exists public.master_salvar_cash_referencias_mercado(jsonb);
drop function if exists public.cash_referencias_mercado();
drop function if exists public._cash_referencias_valida(jsonb);
drop table if exists public.cash_referencias_mercado;

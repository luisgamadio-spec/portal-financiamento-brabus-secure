-- =========================================================
-- SNAPSHOT DE LEITURA — NÃO É MIGRATION — NÃO REAPLICAR
-- =========================================================
-- Capturado via Supabase Management API (SELECT / pg_get_functiondef()),
-- 100% read-only. Ver supabase/baseline/README.md para a regra de uso.
--
-- Função:        public.operational_current_scope()
-- oid (captura): 19105
-- owner:         postgres
-- security:      DEFINER
-- volatility:    STABLE
-- search_path:   pg_catalog, public  (pinado — protegido contra search_path hijacking)
-- grants:        authenticated, postgres, service_role  (NÃO anon)
--
-- Papel no sistema: resolvedor central de escopo/perfil, chamado como
-- primeiro passo por toda função analítica `operational_*` (operational_metrics,
-- operational_salary_details, operational_fandi_dashboard, etc.). Prioridade
-- máxima da Fase IA-1 — é a peça da qual toda tool de IA herdará autorização.
--
-- Status Git ANTES desta captura: NÃO REPRESENTADA em nenhuma migration
-- (confirmado por grep case-insensitive em todo supabase/migrations/,
-- 2026-08-21). Existia apenas em produção.
--
-- Testado cross-perfil nesta fase (impersonação via request.jwt.claims,
-- SELECT-only, nenhuma escrita): MASTER, DIRETOR NOVOS, GERENTE, ANALISTA,
-- VENDEDOR devolveram profile/store/departments/is_master/is_director/
-- is_seller consistentes com a regra de negócio documentada. RH/RECURSOS
-- HUMANOS e DIRETOR SEMINOVOS não têm usuário ativo provisionado hoje —
-- validados apenas por leitura do corpo (perfil fora da lista permitida
-- levanta 42501, "Perfil sem acesso aos dados operacionais").
--
-- Capturado em: 2026-08-21 17:5x UTC · HEAD do repo na captura: 5562b0f
-- =========================================================

CREATE OR REPLACE FUNCTION public.operational_current_scope()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_profile text;
  v_status text;
  v_departments text[] := array[]::text[];
begin
  select *
    into v_user
  from public.usuarios
  where auth_user_id = auth.uid()
    and ativo = true
  limit 1;

  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.'
      using errcode = '42501';
  end if;

  v_profile := upper(trim(coalesce(v_user.perfil, '')));
  v_status := upper(trim(coalesce(v_user.status, '')));

  if v_profile = 'MASTER' then
    v_departments := array['NOVOS', 'SEMINOVOS'];
  elsif v_profile in ('DIRETOR NOVOS', 'DIRETOR DE NOVOS') then
    v_departments := array['NOVOS'];
  elsif v_profile in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then
    v_departments := array['SEMINOVOS'];
  else
    -- "SEMINOVOS" contains the text "NOVOS"; remove it before testing NOVOS.
    if replace(v_status, 'SEMINOVOS', '') like '%NOVOS%' then
      v_departments := array_append(v_departments, 'NOVOS');
    end if;
    if v_status like '%SEMINOVOS%' then
      v_departments := array_append(v_departments, 'SEMINOVOS');
    end if;
  end if;

  if v_profile not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR DE NOVOS',
    'DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS',
    'ANALISTA', 'GERENTE', 'VENDEDOR'
  ) then
    raise exception 'Perfil sem acesso aos dados operacionais.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'profile', v_profile,
    'store', nullif(upper(trim(coalesce(v_user.loja, ''))), ''),
    'departments', to_jsonb(v_departments),
    'is_master', v_profile = 'MASTER',
    'is_director', v_profile like 'DIRETOR%',
    'is_seller', v_profile = 'VENDEDOR'
  );
end;
$function$

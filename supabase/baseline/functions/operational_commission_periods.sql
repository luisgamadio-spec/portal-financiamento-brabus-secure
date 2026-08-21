-- =========================================================
-- SNAPSHOT DE LEITURA — NÃO É MIGRATION — NÃO REAPLICAR
-- =========================================================
-- Capturado via Supabase Management API (SELECT / pg_get_functiondef()),
-- 100% read-only. Ver supabase/baseline/README.md para a regra de uso.
--
-- Função:        public.operational_commission_periods()
-- oid (captura): 19270
-- owner:         postgres
-- security:      DEFINER
-- volatility:    STABLE
-- search_path:   pg_catalog, public  (pinado)
-- grants:        authenticated, postgres, service_role  (NÃO anon)
--
-- Papel no sistema: lista os períodos de comissão ativos (public.periodos_comissao)
-- para usuário não-MASTER (MASTER usa master_admin_reference_data().periods).
-- Auditada nesta fase por estar listada explicitamente na Parte G do escopo
-- (junto de operational_metrics/operational_current_scope/operational_portal_config).
-- Único gate de acesso é `auth.uid() is not null` — não depende de
-- operational_current_scope() e não filtra por perfil/loja: qualquer usuário
-- autenticado ativo vê a mesma lista de períodos (dado não sensível — nomes e
-- datas de competência, sem valores).
--
-- Status Git ANTES desta captura: NÃO REPRESENTADA em nenhuma migration
-- (confirmado por grep case-insensitive em todo supabase/migrations/,
-- 2026-08-21). Existia apenas em produção.
--
-- Capturado em: 2026-08-21 17:5x UTC · HEAD do repo na captura: 5562b0f
-- =========================================================

CREATE OR REPLACE FUNCTION public.operational_commission_periods()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_build_object(
    'rows',
    coalesce(
      jsonb_agg(to_jsonb(p) order by p.data_inicio desc)
        filter (where p.id is not null),
      '[]'::jsonb
    )
  )
  from public.periodos_comissao p
  where auth.uid() is not null
    and p.ativo is true;
$function$

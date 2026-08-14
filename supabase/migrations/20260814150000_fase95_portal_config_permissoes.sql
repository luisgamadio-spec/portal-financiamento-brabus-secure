-- Fase 9.5 (C0) — expõe permissoes_modulos_dinamicas via
-- operational_portal_config(), a interface segura já oficial para
-- configurações lidas pelo frontend (auditada no Checkpoint 2: único
-- consumidor é carregarParametrosPortal() em portal-app.js, chamado
-- para qualquer usuário autenticado logo após o login; filtra por
-- hasOwnProperty contra DEFAULT_PORTAL_CONFIG, então uma chave nova
-- não numérica é silenciosamente ignorada por esse consumidor — zero
-- risco de regressão nos 13 parâmetros de comissão já expostos).
--
-- Único ponto alterado: o array allowlist. SECURITY DEFINER, owner,
-- search_path e grants (authenticated EXECUTE, sem anon) preservados
-- automaticamente pelo CREATE OR REPLACE — nenhum GRANT reemitido.
-- NÃO concede SELECT direto em public.configuracoes.
--
-- Esta migration é independente de
-- 20260814090000_fase93_permissoes_modulos_schema.sql, que continua
-- representando exatamente o que foi promovido na Fase 9.3 e não foi
-- alterada por esta fase.

CREATE OR REPLACE FUNCTION public.operational_portal_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select case
    when auth.uid() is null then
      jsonb_build_object('rows', '[]'::jsonb)
    else
      jsonb_build_object(
        'rows',
        coalesce(
          jsonb_agg(
            jsonb_build_object('chave', c.chave, 'valor', c.valor)
            order by c.chave
          ),
          '[]'::jsonb
        )
      )
  end
  from public.configuracoes c
  where c.chave = any (array[
    'share_minimo',
    'spf_liquido_percentual',
    'bonus_spf_analista',
    'limite_retorno_novos',
    'limite_retorno_seminovos',
    'vendedor_faixa_baixo_share_baixo',
    'vendedor_faixa_baixo_share_alto',
    'vendedor_faixa_alto_share_baixo',
    'vendedor_faixa_alto_share_alto',
    'gerente_faixa_share_baixo',
    'gerente_faixa_share_alto',
    'analista_faixa_share_baixo',
    'analista_faixa_share_alto',
    'permissoes_modulos_dinamicas'
  ]);
$function$;

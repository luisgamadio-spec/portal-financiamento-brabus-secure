-- IA-V2-3B — server-authoritative kill switch para o TEXT de Brabus
-- F&I Intelligence.
--
-- Contexto: IA-V2-2 homologou o TEXT localmente (mock Supabase); antes
-- de Real Homologation contra o projeto Supabase real (mesmo projeto
-- de produção, decisão Option A de IA-V2-3A), a Intelligence precisa
-- de uma forma de ser desligada rapidamente sem deploy de código —
-- hoje não existe nenhuma (module-registry.json já registrava isso
-- como blocker pendente).
--
-- Reaproveita a MESMA infraestrutura já usada por
-- ativacao_acesso_global (Fase 4.5) e permissoes_modulos_dinamicas
-- (Fase 9.3/9.5): uma linha em public.configuracoes, exposta pela
-- interface já oficial operational_portal_config() (Fase 9.5) — nunca
-- SELECT direto na tabela, nenhum novo endpoint/RPC criado.
--
-- Estado inicial obrigatório: FALSE (mesma disciplina de
-- ativacao_acesso_global — nasce desligado, precisa de decisão
-- explícita para ligar).
--
-- Nome da chave: "ia_texto_habilitada" — escopado a TEXT
-- especificamente (não "ia_habilitada" genérico), porque Voice e
-- Realtime já têm suas próprias Edge Functions homolog separadas
-- (portal-voice-homolog, portal-realtime-homolog) e podem no futuro
-- precisar de kill switches independentes, sem depender de uma única
-- flag compartilhada entre canais.

insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'ia_texto_habilitada',
  'false',
  'Liga/desliga globalmente o TEXT de Brabus F&I Intelligence (portal-ai-homolog). Verificado server-side, após a validação de MASTER e antes de qualquer chamada à OpenAI/tool. FALSE = Intelligence indisponível (503), mesmo para MASTER. Ausência da linha ou valor diferente de ''true'' também é tratado como desabilitado (fail-closed).',
  now()
)
on conflict (chave) do nothing;

-- Único ponto alterado: o array allowlist de operational_portal_config
-- ganha 'ia_texto_habilitada'. SECURITY DEFINER, owner, search_path e
-- grants (authenticated EXECUTE, sem anon) preservados automaticamente
-- pelo CREATE OR REPLACE — nenhum GRANT reemitido, nenhum SELECT
-- direto concedido em public.configuracoes.
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
    'permissoes_modulos_dinamicas',
    'ia_texto_habilitada'
  ]);
$function$;
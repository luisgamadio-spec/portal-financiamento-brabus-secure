-- IA-3B — server-authoritative kill switch para VOICE de Brabus F&I
-- Intelligence (portal-voice-homolog + portal-realtime-homolog).
--
-- Contexto: 20260902100000_ia_texto_kill_switch.sql adicionou
-- ia_texto_habilitada, escopado deliberadamente a TEXT apenas -- seu
-- próprio comentário já previa que "Voice e Realtime já têm suas
-- próprias Edge Functions homolog separadas... e podem no futuro
-- precisar de kill switches independentes, sem depender de uma única
-- flag compartilhada entre canais." Esta migration implementa
-- exatamente isso: uma segunda chave independente, mesma
-- infraestrutura, mesma disciplina fail-closed.
--
-- ia_voz_habilitada é uma flag ÚNICA que gate as DUAS Edge Functions
-- de voz (portal-voice-homolog e portal-realtime-homolog) -- Voice-01
-- (push-to-talk) e Realtime (conversa contínua) sempre ligam/desligam
-- juntas nesta fase; um controle por-modo mais granular não existe
-- ainda e não é necessário até haver evidência de uso real
-- distinguindo os dois.
--
-- Reaproveita a MESMA infraestrutura de ia_texto_habilitada: uma linha
-- em public.configuracoes, exposta apenas por
-- operational_portal_config() -- nenhum novo endpoint/RPC, nenhum
-- SELECT direto liberado na tabela.
--
-- Estado inicial obrigatório: FALSE (mesma disciplina de
-- ia_texto_habilitada/ativacao_acesso_global -- nasce desligado,
-- precisa de decisão explícita para ligar). TEXT permanecer
-- desligado (ia_texto_habilitada ainda FALSE, migration anterior) não
-- é alterado por esta migration -- as duas flags são independentes.
--
-- NÃO APLICADA a nenhum projeto Supabase real por esta migration em
-- si -- IA-3B é reconciliação de código apenas (ver IA-3B, Gate 18).
-- A aplicação real (supabase db push / dashboard) é uma decisão
-- posterior, explicitamente autorizada em outra fase.

insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'ia_voz_habilitada',
  'false',
  'Liga/desliga globalmente o VOICE de Brabus F&I Intelligence (portal-voice-homolog + portal-realtime-homolog, ambas as funções, mesma flag). Verificado server-side, após a validação de MASTER e antes de qualquer chamada de STT/TTS ou mint de credencial efêmera da Realtime API. FALSE = Voice indisponível (503), mesmo para MASTER. Ausência da linha ou valor diferente de ''true'' também é tratado como desabilitado (fail-closed). Independente de ia_texto_habilitada -- TEXT pode estar ligado com Voice desligado, e vice-versa.',
  now()
)
on conflict (chave) do nothing;

-- Único ponto alterado: o array allowlist de operational_portal_config
-- ganha 'ia_voz_habilitada', ao lado de 'ia_texto_habilitada' já
-- presente. SECURITY DEFINER, owner, search_path e grants
-- (authenticated EXECUTE, sem anon) preservados automaticamente pelo
-- CREATE OR REPLACE -- nenhum GRANT reemitido, nenhum SELECT direto
-- concedido em public.configuracoes.
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
    'ia_texto_habilitada',
    'ia_voz_habilitada'
  ]);
$function$;

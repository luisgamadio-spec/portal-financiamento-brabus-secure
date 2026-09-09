# Edge Functions — manifesto

Estado reconciliado Git × produção após as Fases 22.3, 22.4B e 22.5. Nenhum
segredo, token ou URL confidencial listado aqui — apenas slug, propósito,
gate de autorização e chamador.

`admin-reset-password` **não** está nesta lista: removida em definitivo
(código local, deploy live e os dois botões que a chamavam) na Fase 22.4B,
por permitir redefinir a senha de qualquer usuário para um valor fixo e
compartilhado ("123456") sem necessidade funcional comprovada — todo
estado de usuário já tinha alternativa segura baseada em token. Seu
histórico de auditoria (`RESET_SENHA`, eventos até 2026-07-18) permanece
intacto no banco.

## CORS (Fase 22.5)

Todas as 12 funções restringem `Access-Control-Allow-Origin` a uma
allowlist exata (nunca reflexo cego do header `Origin`, nunca wildcard),
com `Vary: Origin`. Uma origem fora da lista recebe `200` no preflight
(o método/rota em si não é bloqueado) mas **sem** o header
`Access-Control-Allow-Origin` — o navegador do lado do chamador é quem
recusa expor a resposta ao JS; chamadas server-to-server (sem header
`Origin`) não são afetadas, pois CORS é imposto pelo navegador, não pelo
servidor.

Política única em uso — **BLISTIQ_BROWSER**:
```
https://brabus.blistiq.com.br   (produção, domínio customizado)
https://luisgamadio-spec.github.io   (produção, domínio padrão do GitHub Pages, ainda ativo em paralelo)
http://localhost:8080           (QA local — o frontend aponta para o projeto Supabase de PRODUÇÃO mesmo local)
http://127.0.0.1:8080
```
CORS é defesa em profundidade, nunca substitui autorização: todas as
funções MASTER-only continuam revalidando o perfil server-side; as
públicas continuam exigindo o token/hash próprio do fluxo.

| Slug | Source | verify_jwt | Chamador | CORS | Finalidade |
|---|---|---|---|---|---|
| `activation-lookup` | `activation-lookup/index.ts` | `false` | `verificar-acesso.html` | BLISTIQ_BROWSER | Consulta pública o estado de uma ativação por token (hash), antes de decidir a etapa seguinte. |
| `activation-request` | `activation-request/index.ts` | `false` | `verificar-acesso.html`, `admin-generate-legacy-migration-link` (via RPC HTTP) | BLISTIQ_BROWSER | Cria/renova uma solicitação de ativação (token de confirmação de e-mail) e dispara o e-mail via Postmark. |
| `confirm-access-activation` | `confirm-access-activation/index.ts` | `false` | `verificar-acesso.html` | BLISTIQ_BROWSER | Confirma o e-mail de uma ativação e emite o token de continuação (definir senha). |
| `activation-complete` | `activation-complete/index.ts` | `false` | `verificar-acesso.html` | BLISTIQ_BROWSER | Etapa final: define a senha real do usuário e conclui a ativação. |
| `confirm-modern-onboarding-continuation` | `confirm-modern-onboarding-continuation/index.ts` | `false` | `concluir-acesso.html` | BLISTIQ_BROWSER | Conclui o primeiro acesso moderno interrompido via token de continuação (Incidente 22.1). |
| `request-email-migration` | `request-email-migration/index.ts` | `true` | Portal (usuário autenticado) | BLISTIQ_BROWSER | Usuário logado solicita migração do próprio e-mail de acesso; dispara e-mail via Postmark. |
| `confirm-email-migration` | `confirm-email-migration/index.ts` | `false` | Link enviado por e-mail | BLISTIQ_BROWSER | Confirma a migração de e-mail por token (Fase 3.5), pode ser aberta em outro dispositivo. |
| `reconcile-email-migration` | `reconcile-email-migration/index.ts` | `true` | Painel Master (sem UI própria hoje — uso operacional direto por quem administra) | BLISTIQ_BROWSER | MASTER-only; reconcilia migrações de e-mail travadas no estado `AUTH_OK_USUARIOS_PENDENTE`, sem reenviar e-mail nem gerar token novo. |
| `admin-invite-user` | `admin-invite-user/index.ts` | `true` | Painel Master — cadastro de vendedor | BLISTIQ_BROWSER | MASTER-only; cria a conta Auth de um novo usuário e envia o convite inicial. |
| `admin-resend-user-invite` | `admin-resend-user-invite/index.ts` | `true` | Painel Master — ficha do usuário | BLISTIQ_BROWSER | MASTER-only; reenvia um convite pendente ainda não aceito. |
| `admin-generate-user-access-link` | `admin-generate-user-access-link/index.ts` | `true` | Painel Master — ficha do usuário | BLISTIQ_BROWSER | MASTER-only; gera link seguro de ativação/recuperação para entrega manual (WhatsApp, SMS, etc.), sem depender de e-mail. |
| `admin-generate-legacy-migration-link` | `admin-generate-legacy-migration-link/index.ts` | `true` | Painel Master — ficha do usuário (contas legado) | BLISTIQ_BROWSER | MASTER-only; gera link de migração legado → BLISTIQ para contas `@portalfi.brabus`/`@brabus-fi.local` (Fase 16.5, Incidente 19.2). |
| `portal-ai` | `portal-ai/index.ts` | `unproven*` | Nenhum ainda — sem botão/chat de produção apontando para esta função (o drawer de produção, `portal-ai-ui.js`, aponta para `portal-ai-homolog`) | BLISTIQ_BROWSER | MASTER-only; única porta do frontend originalmente prevista para a Brabus F&I Intelligence — recebe `{message, conversation}`, resolve identidade pelo JWT, chama a OpenAI (Responses API, `gpt-5.6-luna`) com 3 tools registradas (`consultar_resultado`, `comparar_resultado`, `consultar_ranking`), todas lendo `operational_metrics`/`operational_commission_periods` via `userClient` (nunca service role) — sem tool de SQL livre. Ver `portal-ai/EVAL.md` para a suíte de avaliação original (IA-2A, 3 tools apenas — não cobre o que veio depois). **IA-3B correction**: esta linha dizia "não deployada ainda" — prova direta (IA-3A.1, sondas HTTP não-autenticadas read-only contra o projeto real: 404 de controle vs. 401 real) mostrou que a função **está live-deployed** (401 em POST sem sessão, consistente com o próprio gate MASTER do código). `portal-ai-homolog` (linha abaixo) é a autoridade funcional atual — este arquivo permanece congelado por decisão (IA-3B, Gate 9/11), não sincronizado com `portal-ai-homolog`. |
| `portal-ai-homolog` | `portal-ai-homolog/index.ts` | `unproven*` | `portal-ai-ui.js` (drawer de produção, gate `aiAssistantEnabled`) | BLISTIQ_BROWSER + `luisgamadio-spec.github.io` + `brabus.blistiq.com.br` | MASTER-only; **autoridade funcional atual** da Brabus F&I Intelligence (TEXT) — superset de `portal-ai`, 12 tools registradas (`consultar_resultado`, `comparar_resultado`, `consultar_ranking`, `consultar_operacoes_especiais`, `consultar_score_vendedores`, `consultar_comissoes`, `simular_financiamento`, `simular_antecipacao`, `simular_cash_conversion`, `calcular_taxa_financiamento`, `analisar_historico_financiamento`, `iniciar_novo_cliente`), todas lendo via `userClient` (nunca service role para os dados de negócio — service role usado apenas para resolver `usuarios.perfil` do chamador). Kill switch server-authoritative (`ia_texto_habilitada` via `operational_portal_config()`, fail-closed, `FALSE` por padrão). **Está live-deployed** (prova em IA-3A.1: 401 em POST sem sessão). Reconciliada nesta fase (IA-3B) a partir de `ia-reconciliation-v2-local` — ver `docs/IA-RECONCILIATION-V2.md`. |
| `portal-voice-homolog` | `portal-voice-homolog/index.ts` | `unproven*` | `portal-ai-voice.js` (push-to-talk) | BLISTIQ_BROWSER + `luisgamadio-spec.github.io` + `brabus.blistiq.com.br` | MASTER-only; proxy de voz puro (STT `gpt-4o-transcribe` / TTS `gpt-4o-mini-tts`), 0 tools, 0 lógica de negócio — texto transcrito volta ao browser, que o envia para `portal-ai-homolog` pelo mesmo caminho do texto digitado. Nada persistido (áudio e texto só em memória da requisição). **Está live-deployed** (prova em IA-3A.1: 400 em POST sem `action` válido, antes mesmo do gate de auth — comportamento consistente com o código real). **IA-3B**: adiciona kill switch `ia_voz_habilitada` (mesma infraestrutura de `ia_texto_habilitada`), fail-closed, `FALSE` por padrão — presente neste commit, ainda **não aplicado** a nenhum projeto Supabase real (migration não executada, ver Gate 18). |
| `portal-realtime-homolog` | `portal-realtime-homolog/index.ts` | `unproven*` | `portal-ai-realtime.js` (conversa contínua) + Voice Studio lab mode | BLISTIQ_BROWSER + `luisgamadio-spec.github.io` + `brabus.blistiq.com.br` | MASTER-only; bootstrap de sessão Realtime — mint de `client_secret` efêmero (600s) via `POST /v1/realtime/client_secrets`, a chave real nunca sai do servidor. Registra exatamente 1 tool (`consultar_portal_intelligence`) que encaminha para `portal-ai-homolog` — "voz não ganha um segundo cérebro". Modo Voice Studio (`overrides.mode==="studio"`) é LAB ONLY, 0 tools, nunca vê pergunta financeira real. **Está live-deployed** (prova em IA-3A.1: 401 em POST sem sessão). **IA-3B**: adiciona o mesmo kill switch `ia_voz_habilitada` (flag única, gate as duas funções de voz juntas), checado ANTES de `overrides`/modo Studio sequer serem lidos — Studio não pode contornar a flag. Ainda **não aplicado** a nenhum projeto Supabase real. |

Todas MASTER-only revalidam o perfil server-side contra `usuarios.perfil='MASTER' AND ativo=true` — nunca confiam no payload do cliente. Nenhuma lê `SUPABASE_SERVICE_ROLE_KEY`/`POSTMARK_SERVER_TOKEN` fora de `Deno.env.get(...)`.

`*unproven` (as 4 linhas de Intelligence, IA-3B): nenhum `supabase/config.toml` existe neste repositório para declarar o `verify_jwt` por função na plataforma, e este ambiente não tem acesso a Supabase Management API/CLI autenticado para consultar o valor real configurado no projeto. Isto é distinto de — e não contradiz — a validação de sessão que cada uma das 4 funções já faz no próprio código (`userClient.auth.getUser()`, antes de qualquer ação sensível): essa validação **de aplicação** está provada diretamente no código-fonte; a configuração **de plataforma** (`verify_jwt`) permanece `VERIFY_JWT_DEPLOYMENT_POSTURE_UNPROVEN` até que um humano com acesso ao painel Supabase confirme o valor real de cada função.

Deploy de código de Edge Function é feito **exclusivamente** via Supabase
CLI (`supabase functions deploy <slug> --project-ref ...`), nunca via
Management API crua — essa via não bundla corretamente dependências
remotas (`deno.land/std`, `esm.sh/@supabase/supabase-js`) e já causou uma
indisponibilidade real (`admin-generate-user-access-link`, ago/2026).

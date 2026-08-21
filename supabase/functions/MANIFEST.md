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
| `portal-ai` | `portal-ai/index.ts` | `true` | Nenhum ainda — sem botão/chat de produção (Fase IA-2A é só backend; UI vem na IA-2B) | BLISTIQ_BROWSER | MASTER-only (rollout inicial da Fase IA-2A); única porta do frontend para a Brabus F&I Intelligence — recebe `{message, conversation}`, resolve identidade pelo JWT, chama a OpenAI (Responses API, `gpt-5.6-luna`) com 3 tools registradas (`consultar_resultado`, `comparar_resultado`, `consultar_ranking`), todas lendo `operational_metrics`/`operational_commission_periods` via `userClient` (nunca service role) — sem tool de SQL livre. Ver `portal-ai/EVAL.md` para a suíte de avaliação. **Não deployada ainda** — `OPENAI_API_KEY` não está configurado como secret do projeto (ver relatório da Fase IA-2A). |

Todas MASTER-only revalidam o perfil server-side contra `usuarios.perfil='MASTER' AND ativo=true` — nunca confiam no payload do cliente. Nenhuma lê `SUPABASE_SERVICE_ROLE_KEY`/`POSTMARK_SERVER_TOKEN` fora de `Deno.env.get(...)`.

Deploy de código de Edge Function é feito **exclusivamente** via Supabase
CLI (`supabase functions deploy <slug> --project-ref ...`), nunca via
Management API crua — essa via não bundla corretamente dependências
remotas (`deno.land/std`, `esm.sh/@supabase/supabase-js`) e já causou uma
indisponibilidade real (`admin-generate-user-access-link`, ago/2026).

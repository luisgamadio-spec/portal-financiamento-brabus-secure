# Edge Functions — manifesto

Estado reconciliado Git × produção após as Fases 22.3 e 22.4B. Nenhum
segredo, token ou URL confidencial listado aqui — apenas slug, propósito,
gate de autorização e chamador.

`admin-reset-password` **não** está nesta lista: removida em definitivo
(código local, deploy live e os dois botões que a chamavam) na Fase 22.4B,
por permitir redefinir a senha de qualquer usuário para um valor fixo e
compartilhado ("123456") sem necessidade funcional comprovada — todo
estado de usuário já tinha alternativa segura baseada em token. Seu
histórico de auditoria (`RESET_SENHA`, eventos até 2026-07-18) permanece
intacto no banco.

| Slug | Source | verify_jwt | Chamador | Finalidade |
|---|---|---|---|---|
| `activation-lookup` | `activation-lookup/index.ts` | `false` | `verificar-acesso.html` | Consulta pública o estado de uma ativação por token (hash), antes de decidir a etapa seguinte. |
| `activation-request` | `activation-request/index.ts` | `false` | `verificar-acesso.html`, `admin-generate-legacy-migration-link` (via RPC HTTP) | Cria/renova uma solicitação de ativação (token de confirmação de e-mail) e dispara o e-mail via Postmark. |
| `confirm-access-activation` | `confirm-access-activation/index.ts` | `false` | `verificar-acesso.html` | Confirma o e-mail de uma ativação e emite o token de continuação (definir senha). |
| `activation-complete` | `activation-complete/index.ts` | `false` | `verificar-acesso.html` | Etapa final: define a senha real do usuário e conclui a ativação. |
| `confirm-modern-onboarding-continuation` | `confirm-modern-onboarding-continuation/index.ts` | `false` | `concluir-acesso.html` | Conclui o primeiro acesso moderno interrompido via token de continuação (Incidente 22.1). |
| `request-email-migration` | `request-email-migration/index.ts` | `true` | Portal (usuário autenticado) | Usuário logado solicita migração do próprio e-mail de acesso; dispara e-mail via Postmark. |
| `confirm-email-migration` | `confirm-email-migration/index.ts` | `false` | Link enviado por e-mail | Confirma a migração de e-mail por token (Fase 3.5), pode ser aberta em outro dispositivo. |
| `reconcile-email-migration` | `reconcile-email-migration/index.ts` | `true` | Painel Master | MASTER-only; reconcilia migrações de e-mail travadas no estado `AUTH_OK_USUARIOS_PENDENTE`, sem reenviar e-mail nem gerar token novo. |
| `admin-invite-user` | `admin-invite-user/index.ts` | `true` | Painel Master — cadastro de vendedor | MASTER-only; cria a conta Auth de um novo usuário e envia o convite inicial. |
| `admin-resend-user-invite` | `admin-resend-user-invite/index.ts` | `true` | Painel Master — ficha do usuário | MASTER-only; reenvia um convite pendente ainda não aceito. |
| `admin-generate-user-access-link` | `admin-generate-user-access-link/index.ts` | `true` | Painel Master — ficha do usuário | MASTER-only; gera link seguro de ativação/recuperação para entrega manual (WhatsApp, SMS, etc.), sem depender de e-mail. |
| `admin-generate-legacy-migration-link` | `admin-generate-legacy-migration-link/index.ts` | `true` | Painel Master — ficha do usuário (contas legado) | MASTER-only; gera link de migração legado → BLISTIQ para contas `@portalfi.brabus`/`@brabus-fi.local` (Fase 16.5, Incidente 19.2). |

Todas MASTER-only revalidam o perfil server-side contra `usuarios.perfil='MASTER' AND ativo=true` — nunca confiam no payload do cliente. Nenhuma lê `SUPABASE_SERVICE_ROLE_KEY`/`POSTMARK_SERVER_TOKEN` fora de `Deno.env.get(...)`.

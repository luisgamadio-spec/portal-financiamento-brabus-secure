-- Fase 4 — configurações e dados operacionais do fluxo de Ativação.
-- Versionamento retroativo (Fase 4.5). Todos os inserts são idempotentes
-- (ON CONFLICT DO NOTHING) — seguros para rodar contra o banco de produção
-- já existente sem sobrescrever valores atuais.

-- E-mail de notificação do Master para novas Revisões Cadastrais (Fase 4.2).
-- Deliberadamente SEM valor pessoal hardcoded neste arquivo versionado —
-- quem aplicar esta migration num ambiente novo deve configurar o valor
-- manualmente (painel/SQL direto) antes de liberar o fluxo. Em produção
-- este valor já existe e este INSERT não o altera (ON CONFLICT DO NOTHING).
insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values (
  'email_notificacao_cadastral',
  '',
  'E-mail que recebe notificação quando uma nova Revisão Cadastral (LOJA/LOGIN_NBS divergente) é criada durante o Primeiro Acesso. Configurar manualmente — não hardcodar e-mail pessoal em migration versionada.',
  now()
)
on conflict (chave) do nothing;

-- Contas sintéticas/de teste explicitamente excluídas da população real de
-- 79 usuários legado, usadas para homologação controlada do fluxo de
-- Ativação (Fases 4.1–4.3) e como exceção ao feature flag global (Fase 4.5).
insert into public.contas_sinteticas_excluidas (usuario_id, motivo, criado_em)
values
  ('067a9355-98dd-4cc3-8b20-ee6308abf09d', 'MASTER TESTE — email fictício ainda, conta de teste, autorizada como veículo do piloto Fase 4.1', now()),
  ('49ba9f49-47b9-49c3-9c6b-a60b468b4c49', 'TESTE ANALISTA — email real de teste (endereço pessoal do administrador), já não elegível pelo critério de email fictício', now()),
  ('9d63ca5e-94bb-4c0b-b4fd-bdb9c4bf7c1f', 'USUARIO TESTE CONVITE — email real de teste (endereço corporativo do administrador), CPF sintético 99999999999, já não elegível pelo critério de email fictício', now())
on conflict (usuario_id) do nothing;

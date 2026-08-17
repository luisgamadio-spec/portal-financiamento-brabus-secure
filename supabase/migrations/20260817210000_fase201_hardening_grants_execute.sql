-- Fase 20.1B — Hardening de EXECUTE grants em funções SECURITY DEFINER.
--
-- Contexto (Fase 20.1A, leitura completa antes de qualquer escrita): das 114 funções
-- SECURITY DEFINER de public, 41 tinham EXECUTE concedido a anon/PUBLIC além de
-- authenticated/service_role. Mapeamento de caller real (frontend, Edge Functions,
-- migrations — nunca por nome) confirmou que NENHUMA das 41 é efetivamente chamada
-- anonimamente: todas dependem de sessão autenticada (usuário comum, MASTER via
-- is_master(), ou service_role em Edge Function). Esta migration é GRANTS-ONLY —
-- nenhum corpo de função é alterado. Toda checagem interna de autorização
-- (auth.uid(), is_master(), perfil, ativo, ownership) permanece como camada
-- adicional, não é substituída pelo grant.
--
-- 3 funções permanecem INTOCADAS por falta de caller identificável (Categoria E,
-- INDETERMINADA): master_concluir_reconciliacao_email, master_desabilitar_migracao_email,
-- master_habilitar_migracao_email.
--
-- Rollback exato: 201_rollback_20.1B.sql (scratchpad), gerado a partir do estado
-- ao vivo via aclexplode(proacl) antes desta migration.

begin;

-- =========================================================================
-- Categoria B — autenticado (usuário comum via supabaseClient.rpc com sessão
-- própria, ou Edge Function repassando o JWT do chamador). Remove anon/PUBLIC,
-- mantém authenticated e service_role.
-- =========================================================================

revoke all on function public.concluir_convite_usuario() from public, anon;
revoke all on function public.iniciar_migracao_email(text) from public, anon;
revoke all on function public.migracao_email_marcar_falha_envio(uuid,text) from public, anon;
revoke all on function public.portal_telemetry_end_session(uuid,text) from public, anon;
revoke all on function public.portal_telemetry_heartbeat(uuid) from public, anon;
revoke all on function public.portal_telemetry_simulation(uuid) from public, anon;
revoke all on function public.portal_telemetry_start_session(text) from public, anon;
revoke all on function public.simulador_get_antecipacao() from public, anon;
revoke all on function public.simulador_get_balao_seminovos() from public, anon;
revoke all on function public.simulador_get_balao_zerokm() from public, anon;
revoke all on function public.simulador_get_coparticipado() from public, anon;
revoke all on function public.simulador_get_financiamento_seminovo() from public, anon;
revoke all on function public.simulador_get_linear_zerokm() from public, anon;
revoke all on function public.simulador_get_semestral_triton_outlander() from public, anon;
revoke all on function public.simulador_get_taxa_botao() from public, anon;
revoke all on function public.simulador_get_taxas_subsidiadas() from public, anon;
revoke all on function public.verificar_migracao_email_status() from public, anon;

-- =========================================================================
-- Categoria C — MASTER (autorização real via is_master() internamente; o
-- grant a authenticated é necessário pois todo usuário logado, inclusive
-- MASTER, apresenta role authenticated — o gate é a checagem interna, não o
-- grant). Remove anon/PUBLIC, mantém authenticated e service_role.
-- =========================================================================

revoke all on function public.master_convidar_usuario(text,text,text,text,text,text,text) from public, anon;
revoke all on function public.master_listar_convites() from public, anon;
revoke all on function public.master_reenviar_convite(uuid) from public, anon;
revoke all on function public.master_simulator_usage_data(timestamp with time zone,timestamp with time zone) from public, anon;

revoke all on function public.master_operational_apply_base03(text,text,jsonb,jsonb,boolean) from public, anon;
revoke all on function public.master_operational_list_batches() from public, anon;
revoke all on function public.master_operational_list_sellers() from public, anon;
revoke all on function public.master_operational_list_spf_extra_base02() from public, anon;

revoke all on function public.master_simulador_commit_antecipacao(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_balao_seminovos(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_balao_zerokm(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_coeficientes_coparticipado(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_coparticipado(text,text,jsonb,jsonb,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_coparticipado(text,text,jsonb,jsonb,jsonb,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_financiamento_seminovo(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_linear(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_semestral_triton_outlander(text,text,jsonb,jsonb,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_taxa_botao(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_commit_taxas_subsidiadas(text,text,jsonb,boolean) from public, anon;
revoke all on function public.master_simulador_listar_bases() from public, anon;

-- =========================================================================
-- Categoria D — service_role apenas (chamada exclusivamente por Edge Function
-- com service key, nunca pelo JWT de usuário final). Remove anon/PUBLIC
-- *e* authenticated.
-- =========================================================================

revoke all on function public.activation_renew_continuation(text,text,timestamp with time zone) from public, anon, authenticated;

commit;

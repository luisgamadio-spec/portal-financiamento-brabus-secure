# Manifesto de funções — schema `public` (Fase IA-1)

Inventário fresh via Management API em 2026-08-21 (UTC), HEAD `5562b0f`. **135 funções totais** no schema `public` — não assumir a contagem de 114 citada em migrations anteriores (esse número cobria só as que tinham EXECUTE para anon/PUBLIC, não o total). 128 `SECURITY DEFINER` / 7 `SECURITY INVOKER`. Todas as 128 `SECURITY DEFINER` têm `search_path` pinado (`pg_catalog, public`) — nenhuma classificada como SUSPEITA por ausência de search_path.

**Git**: 61 representadas (A/B), **74 não representadas (C)** — confirmado por grep case-insensitive de `create (or replace) function public.<nome>` em todas as migrations. **Uso**: 93 ATIVA (chamada confirmada do frontend HTML/JS ou de uma Edge Function), 20 INTERNA (helper chamado só por outra função SQL, sem grant a anon/authenticated ou confirmado via varredura de `pg_get_functiondef` de todas as outras funções), 1 DORMENTE (`operational_reporting_summary`, já documentada como sem caller pela própria migration que a define), 21 INDETERMINADA (nenhuma evidência de uso encontrada nesta fase — não implica função morta, apenas que a fonte da chamada não foi localizada; ver nota metodológica).

## Nota metodológica

Uso confirmado por: (1) grep literal de `.rpc('nome'` em todo `*.html`/`*.js` do frontend; (2) grep de `callRpc(`/`fetch(.../rest/v1/rpc/<nome>)` nas 12 Edge Functions; (3) para nomes ainda sem caller aparente, uma varredura de `pg_get_functiondef` de **todas** as 135 funções, procurando o nome como chamada dentro do corpo de qualquer outra função (fecha o call-graph mesmo quando o chamador também não está no Git). INDETERMINADA é o resultado honesto quando nenhuma das três fontes encontra o caller — não deve ser lida como 'função morta', apenas como 'origem da chamada não localizada nesta auditoria'.


## Criticidade IA-MVP — dependência fechada de `operational_metrics` + `operational_current_scope`

| Função | Assinatura | Security | Grants | Git | Uso |
|---|---|---|---|---|---|
| `operational_current_scope` | `` | DEFINER | authenticated | **C** | INTERNA |
| `operational_metrics` | `p_start date, p_end date` | DEFINER | authenticated | A | ATIVA |
| `resolve_department_temporal` | `p_usuario_id uuid, p_data date, p_fallback ...` | INVOKER | (nenhum extra) | A | INTERNA |
| `resolve_store_temporal` | `p_usuario_id uuid, p_data date, p_fallback ...` | INVOKER | (nenhum extra) | A | INTERNA |

## Criticidade IA-FUTURA — domínios previstos no catálogo de tools da Fase IA-0

| Função | Assinatura | Security | Grants | Git | Uso |
|---|---|---|---|---|---|
| `current_portal_profile` | `` | DEFINER | authenticated | **C** | INTERNA |
| `is_master` | `` | DEFINER | authenticated | **C** | INTERNA |
| `operational_analyst_commission_metrics` | `p_start date, p_end date` | DEFINER | authenticated | A | INDETERMINADA |
| `operational_analyst_commission_metrics_v2` | `p_start date, p_end date` | DEFINER | authenticated | A | ATIVA |
| `operational_analyst_coverage_details` | `p_coverage_id uuid` | DEFINER | authenticated | A | ATIVA |
| `operational_analyst_coverage_metrics` | `p_start date, p_end date, p_store text` | DEFINER | (nenhum extra) | A | INTERNA |
| `operational_commission_metrics` | `p_start date, p_end date` | DEFINER | authenticated | **C** | ATIVA |
| `operational_commission_periods` | `` | DEFINER | authenticated | **C** | ATIVA |
| `operational_fandi_dashboard` | `p_start date, p_end date, p_store text, p_d...` | DEFINER | authenticated | A | ATIVA |
| `operational_model_metrics` | `p_start date, p_end date` | DEFINER | authenticated | A | ATIVA |
| `operational_model_metrics_without_spf` | `p_start date, p_end date` | DEFINER | (nenhum extra) | A | INTERNA |
| `operational_portal_config` | `` | DEFINER | authenticated | A | ATIVA |
| `operational_reporting_summary` | `p_start date, p_end date` | DEFINER | authenticated | A | DORMENTE |
| `operational_salary_details` | `p_start date, p_end date, p_seller_id uuid` | DEFINER | authenticated | A | ATIVA |
| `operational_salary_manager_directory` | `p_start date, p_end date` | DEFINER | authenticated | **C** | ATIVA |
| `operational_score_coparticipated_data` | `p_start date, p_end date` | DEFINER | authenticated | A | ATIVA |
| `simulador_coparticipado_combos_sem_coeficiente` | `p_matriz jsonb, p_coef_batch_id uuid` | INVOKER | anon, authenticated | **C** | INTERNA |
| `simulador_get_antecipacao` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_balao_seminovos` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_balao_zerokm` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_coparticipado` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_financiamento_seminovo` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_linear_zerokm` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_semestral_triton_outlander` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_taxa_botao` | `` | DEFINER | authenticated | **C** | ATIVA |
| `simulador_get_taxas_subsidiadas` | `` | DEFINER | authenticated | **C** | ATIVA |

## NÃO-IA — onboarding, admin, importação, telemetria, atendimento F&I

| Função | Assinatura | Security | Grants | Git | Uso |
|---|---|---|---|---|---|
| `activation_cancel` | `p_ativacao_id uuid, p_motivo text` | DEFINER | (nenhum extra) | A | INTERNA |
| `activation_confirm_email` | `p_token_hash text, p_continuacao_token_hash...` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_create_request` | `p_cpf text, p_email_novo text, p_celular_no...` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_finalize` | `p_ativacao_id uuid` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_lookup_by_cpf` | `p_cpf text` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_mark_auth_ok` | `p_ativacao_id uuid` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_mark_send_error` | `p_ativacao_id uuid, p_erro_codigo text, p_e...` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_prepare_complete` | `p_continuacao_token_hash text` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_renew_continuation` | `p_cpf text, p_continuacao_token_hash text, ...` | DEFINER | (nenhum extra) | A | ATIVA |
| `activation_revert_after_auth_failure` | `p_ativacao_id uuid, p_erro_codigo text, p_e...` | DEFINER | (nenhum extra) | A | ATIVA |
| `ativacao_global_habilitada` | `p_usuario_id uuid` | DEFINER | (nenhum extra) | A | INTERNA |
| `ativacao_rate_limit_check` | `p_ip text, p_endpoint text, p_max_tentativa...` | DEFINER | (nenhum extra) | A | ATIVA |
| `atualizar_meu_status_analista_fi` | `p_status text` | DEFINER | authenticated | **C** | ATIVA |
| `atualizar_status_analista_fi` | `p_cpf_normalizado text, p_status text` | DEFINER | (nenhum extra) | **C** | INTERNA |
| `chamar_analista_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `concluir_continuacao_primeiro_acesso` | `p_token_hash text` | DEFINER | (nenhum extra) | A | ATIVA |
| `concluir_convite_usuario` | `` | DEFINER | authenticated | A | ATIVA |
| `current_portal_cpf` | `` | DEFINER | authenticated | **C** | INDETERMINADA |
| `current_usuario_id` | `` | DEFINER | authenticated | **C** | INDETERMINADA |
| `gestor_alterar_status_analista_fi` | `p_analista_id uuid, p_status text` | DEFINER | authenticated | **C** | ATIVA |
| `gestor_encerrar_expediente_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `gestor_listar_analistas_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `gestor_listar_historico_atendimentos_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `gestor_salvar_analista_fi` | `p_id uuid, p_nome text, p_cpf_normalizado t...` | DEFINER | authenticated | **C** | ATIVA |
| `iniciar_migracao_email` | `p_email_novo text` | DEFINER | authenticated | **C** | ATIVA |
| `link_preprovisioned_portal_user` | `` | DEFINER | (nenhum extra) | **C** | INTERNA |
| `mascarar_identificador_cadastro` | `p_valor text` | INVOKER | authenticated | A | INTERNA |
| `mascarar_nome` | `p_nome text` | INVOKER | (nenhum extra) | A | INTERNA |
| `master_admin_audit_event` | `p_type text, p_description text, p_target t...` | DEFINER | authenticated | **C** | ATIVA |
| `master_admin_manage` | `p_entity text, p_action text, p_payload jsonb` | DEFINER | authenticated | A | ATIVA |
| `master_admin_reference_data` | `` | DEFINER | authenticated | **C** | ATIVA |
| `master_admin_security_data` | `` | DEFINER | authenticated | A | ATIVA |
| `master_aprovar_revisao_cadastral` | `p_revisao_id uuid` | DEFINER | authenticated | A | ATIVA |
| `master_atualizar_autorizacao_usuario` | `p_usuario_id uuid, p_perfil text, p_loja te...` | DEFINER | authenticated | A | ATIVA |
| `master_cadastro_alerta_corrigir_login_nbs` | `p_alerta_id uuid, p_novo_login_nbs text, p_...` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_alerta_excluir` | `p_alerta_id uuid, p_motivo text` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_alerta_ignorar` | `p_alerta_id uuid, p_motivo text, p_observac...` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_alerta_resolver` | `p_alerta_id uuid, p_motivo text` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_alertas_listar` | `p_status text, p_severidade text, p_tipo te...` | DEFINER | authenticated | A | ATIVA |
| `master_cadastro_excecao_criar` | `p_identificador_tipo text, p_identificador_...` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_excecao_revogar` | `p_excecao_id uuid` | DEFINER | authenticated | A | INDETERMINADA |
| `master_cadastro_excecoes_listar` | `p_ativo boolean, p_identificador_tipo text,...` | DEFINER | authenticated | A | ATIVA |
| `master_close_commission_period` | `p_period_id uuid, p_summary jsonb, p_rows j...` | DEFINER | authenticated | **C** | ATIVA |
| `master_commission_closings` | `` | DEFINER | authenticated | **C** | ATIVA |
| `master_commission_snapshot` | `p_closing_id uuid` | DEFINER | authenticated | **C** | ATIVA |
| `master_concluir_reconciliacao_email` | `p_migracao_id uuid, p_email_confirmado_em_a...` | DEFINER | anon, authenticated | **C** | ATIVA |
| `master_convidar_usuario` | `p_cpf text, p_nome text, p_perfil text, p_l...` | DEFINER | authenticated | A | ATIVA |
| `master_corrigir_revisao_cadastral` | `p_revisao_id uuid, p_valor_correto text, p_...` | DEFINER | authenticated | A | ATIVA |
| `master_desabilitar_migracao_email` | `p_usuario_id uuid` | DEFINER | anon, authenticated | **C** | INDETERMINADA |
| `master_gerar_continuacao_primeiro_acesso` | `p_usuario_id uuid, p_token_hash text, p_exp...` | DEFINER | authenticated | A | ATIVA |
| `master_habilitar_migracao_email` | `p_usuario_id uuid` | DEFINER | anon, authenticated | **C** | INDETERMINADA |
| `master_inativar_coparticipado_modelo_fi` | `p_id uuid` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_list_revisoes_cadastrais` | `p_status text` | DEFINER | authenticated | A | ATIVA |
| `master_listar_convites` | `` | DEFINER | authenticated | A | ATIVA |
| `master_listar_coparticipado_modelos_fi` | `` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_listar_parametros_financeiros_fi` | `` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_listar_permissoes_modulos` | `` | DEFINER | authenticated | A | ATIVA |
| `master_operational_apply_base03` | `p_original_filename text, p_source_sha256 t...` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_operational_begin_import` | `p_source_type text, p_original_filename tex...` | DEFINER | authenticated | **C** | INTERNA |
| `master_operational_enrich_analytics` | `p_batch_id uuid, p_source_type text, p_rows...` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_operational_finalize_import` | `p_batch_id uuid, p_rows_accepted integer, p...` | DEFINER | authenticated | **C** | INTERNA |
| `master_operational_import_finance` | `p_batch_id uuid, p_rows jsonb` | DEFINER | authenticated | A | ATIVA |
| `master_operational_import_sales` | `p_batch_id uuid, p_rows jsonb` | DEFINER | authenticated | A | ATIVA |
| `master_operational_import_sellers` | `p_batch_id uuid, p_rows jsonb` | DEFINER | authenticated | **C** | ATIVA |
| `master_operational_import_spf` | `p_batch_id uuid, p_rows jsonb` | DEFINER | authenticated | **C** | ATIVA |
| `master_operational_list_batches` | `` | DEFINER | authenticated | **C** | ATIVA |
| `master_operational_list_sellers` | `` | DEFINER | authenticated | **C** | ATIVA |
| `master_operational_list_spf_extra_base02` | `` | DEFINER | authenticated | **C** | ATIVA |
| `master_provisionar_usuario` | `p_email_auth text, p_cpf text, p_nome text,...` | DEFINER | authenticated | A | INDETERMINADA |
| `master_reenviar_convite` | `p_convite_id uuid` | DEFINER | authenticated | **C** | ATIVA |
| `master_reopen_commission_period` | `p_closing_id uuid` | DEFINER | authenticated | **C** | ATIVA |
| `master_salvar_coparticipado_modelo_fi` | `p_id uuid, p_modelo text, p_prazo integer, ...` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_salvar_parametro_financeiro_fi` | `p_id uuid, p_modulo text, p_chave text, p_v...` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_salvar_permissoes_modulos` | `p_mudancas jsonb` | DEFINER | authenticated | A | ATIVA |
| `master_simulador_commit_antecipacao` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_balao_seminovos` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_balao_zerokm` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_coeficientes_coparticipado` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_coparticipado` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_coparticipado` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_financiamento_seminovo` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_linear` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_semestral_triton_outlander` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_taxa_botao` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_commit_taxas_subsidiadas` | `p_arquivo_nome text, p_arquivo_sha256 text,...` | DEFINER | authenticated | **C** | ATIVA |
| `master_simulador_listar_bases` | `` | DEFINER | authenticated | **C** | INDETERMINADA |
| `master_simulator_usage_data` | `p_start_date timestamp with time zone, p_en...` | DEFINER | authenticated | A | ATIVA |
| `master_update_portal_config` | `p_key text, p_value numeric, p_description ...` | DEFINER | authenticated | **C** | ATIVA |
| `migracao_email_marcar_falha_envio` | `p_migracao_id uuid, p_mensagem text` | DEFINER | authenticated | **C** | ATIVA |
| `normalizar_cpf` | `cpf_input text` | INVOKER | authenticated | **C** | INTERNA |
| `operational_complete_password_change` | `` | DEFINER | authenticated | **C** | ATIVA |
| `operational_my_analyst_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `operational_record_access_event` | `p_success boolean, p_message text, p_user_a...` | DEFINER | authenticated | **C** | ATIVA |
| `portal_modulos_permitidos` | `` | DEFINER | authenticated | A | ATIVA |
| `portal_reconcile_user_facts` | `p_usuario_id uuid` | DEFINER | (nenhum extra) | A | INTERNA |
| `portal_telemetry_end_session` | `p_session_id uuid, p_reason text` | DEFINER | authenticated | A | ATIVA |
| `portal_telemetry_heartbeat` | `p_session_id uuid` | DEFINER | authenticated | A | ATIVA |
| `portal_telemetry_simulation` | `p_session_id uuid` | DEFINER | authenticated | A | ATIVA |
| `portal_telemetry_start_session` | `p_module_id text` | DEFINER | authenticated | A | ATIVA |
| `registrar_alerta_sem_identificador_lote` | `p_batch_id uuid, p_origem_base text, p_quan...` | DEFINER | (nenhum extra) | A | INTERNA |
| `registrar_alertas_reconciliacao_lote` | `p_batch_id uuid, p_origem_base text, p_iten...` | DEFINER | (nenhum extra) | A | INTERNA |
| `registrar_meu_login` | `` | DEFINER | authenticated | **C** | ATIVA |
| `set_atualizado_em` | `` | INVOKER | authenticated | **C** | INDETERMINADA |
| `usuario_logado_fi` | `` | DEFINER | authenticated | **C** | ATIVA |
| `verificar_migracao_email_status` | `` | DEFINER | authenticated | **C** | ATIVA |

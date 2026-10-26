# Utilização da Brabus IA — 26/10/2026

Pedido do Luis: medir o uso da Brabus IA como a Utilização dos Simuladores. **Só utilização, nunca o texto das perguntas.**
A tela é só para o Master. Não entra no Score.

| | |
|---|---|
| Migração | `supabase/migrations/20261026120000_brabus_ia_utilizacao.sql` |
| Desfazer | `docs/rollback/brabus_ia_utilizacao_20261026_rollback.sql` |
| Backup | `ia_backup_antes.json` (sem texto: só ids e md5 dos 2 registros que tinham o texto) |

- `configuracoes.ia_perfis_liberados` guarda os perfis com acesso: todos, **exceto RH/DP**.
  - `bi_acesso_liberado()` responde pelo usuário logado.
  - A função `brabus-intelligence` só passa a usar essa lista quando for publicada a versão nova (etapa separada).
- `bi_uso_perguntas`: 1 linha por pergunta, com quem, quando, sessão, canal, loja/perfil/departamento da época, nomes das ferramentas, status e duração.
  - Não guarda texto nem parâmetros. Grava só `bi_registrar_pergunta()`.
  - Nenhum perfil lê a tabela direto; está na guarda das tabelas internas.
- `master_ia_usage_data(início, fim)`: só o Master. Por usuário: perguntas, dias, primeira/última vez, temas (pela ferramenta) e elegíveis para "Nunca utilizaram".
  - Antes do 1º registro real, as perguntas são **estimadas** pela auditoria `bi_audit_log`, que existe desde 02/10/2026. Ferramentas da mesma sessão com menos de 60 s de intervalo = 1 pergunta.
  - Perguntas sem ferramenta não aparecem nesse período estimado.
- Auditoria: o texto das 2 perguntas do `consultar_manual` (07/10) foi removido, e a remoção ficou registrada em `auditoria` (`BI_TEXTO_REMOVIDO`).
  - **O desfazer não devolve o texto, de propósito.** Os nomes de colegas consultados foram mantidos.

Scripts:
- `test_ia_db.py`: prova antes de aplicar, em rollback. Resultado: 26/26.
- `pos_ia_prod.py`: conferência em produção.
- `backup_ia.py`: captura do estado anterior.
- `diag_ia*.py`: diagnóstico (só agregados).

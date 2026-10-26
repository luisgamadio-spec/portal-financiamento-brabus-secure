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

## Resultado da aplicação (26/10/2026 15:05, produção)

- Migração aplicada (sha256 `a53b20a5…`), sem erro. `pos_ia_prod.py`: **16/16**.
- A guarda das tabelas internas inclui `bi_uso_perguntas` (7 tabelas): **11/11**.

## Função e tela (26/10/2026)

- **Função** `brabus-intelligence` **v41** publicada às 15:20, com `verify_jwt` ligado; a versão publicada é idêntica ao branch (`8a48561`).
  - O acesso vem da lista do banco: **mesmo acesso de hoje para os 117 usuários reais e os 8 perfis do cadastro** (`test_acesso_igual.py`). Testes da função: 155/155.
  - Para desfazer: publicar `funcao_v40_antes/`.
- **Tela** Painel Master → Utilização (Simuladores e Brabus IA), aba **Brabus IA**: homolog `55f1496`, piloto `36f1903`.
  - `test_ia_tela.py`: 16/16 no clone, no homolog publicado e no piloto publicado. Guarda 11/11.

## Correção do corte estimado/real (26/10/2026)

- **Defeito:** a ferramenta da 1ª pergunta real é auditada segundos antes do registro, que acontece no fim da pergunta. Por isso ela contava também como "estimada" (total 204 em vez de 203).
- **Correção:** o período estimado termina no **início** da 1ª pergunta registrada (fim − duração).
  - Migração `20261026170000_brabus_ia_utilizacao_corte.sql`; desfazer em `docs/rollback/brabus_ia_utilizacao_corte_20261026_rollback.sql` (texto exato de antes).
  - Prova: `test_fix_corte.py`, 6/6 em rollback.
- Aplicada em produção às 16:18. A tela (piloto) mostra **203** perguntas (201 estimadas + 2 reais) e 21 usuários; 72 nunca usaram.
- Guarda: 1ª rodada 8/11, sem saída detalhada; as 2 rodadas completas seguintes deram **11/11**. Provável falha passageira da API do Supabase (já houve 502 neste dia), contada como "não negado".

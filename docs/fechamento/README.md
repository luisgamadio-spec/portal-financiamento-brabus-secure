# Fechamento de comissão — mudança de 21/10/2026

Decisões do Luis, valendo **a partir do próximo fechamento**. A competência 22/09–20/10 e as anteriores ficam como estão.

1. A comissão de cada pessoa é gravada em **centavos** e o total oficial é a **soma das linhas**.
2. O fechamento grava **quem é cada pessoa** (`snapshot_comissoes.usuario_id`) e o **CPF do cadastro**.
   - A busca é sempre pelo identificador enviado pela prévia, e só quando o nome confere; nunca por nome.
   - Quem não tem identificador confiável fica com CPF vazio, e o fechamento não é bloqueado.
3. **Auditoria SPF:**
   - código, banco e plano vêm da linha principal do mesmo cliente na Base 03;
   - nova coluna `conta_na_comissao`: os SPFs de R$ 1,00 (marcador da importação NBS) continuam listados, com "Não".
4. **Analistas:** o SPF de R$ 1,00 deixa de contar (bônus por unidade), igual à regra dos vendedores.
   - Os valores já pagos ficam como estão: R$ 600 em 22/09–20/10 e R$ 900 em 21/08–21/09.

O **retorno de R$ 1,00 da Base 02** (marcador do NBS em contratos personalizados/campanha) **fica como está**, por decisão do Luis.

| | |
|---|---|
| Migração | `supabase/migrations/20261021150000_fechamento_centavos_identificacao_spf.sql` |
| Desfazer | `docs/rollback/fechamento_20261021_rollback.sql` — texto EXATO das 6 funções (manager_directory com CRLF); aplicar com `supabase db query --linked -f` |
| Backup | `docs/fechamento/20261021/fech_backup.json` |
| Tela | homolog `ca6a3bc` + `41e419e`; piloto `f0a6d06` (publicadas ANTES do SQL) |

**Atenção ao desfazer:** o desfazer remove as 2 colunas novas. Se já houver fechamento feito depois da mudança, isso apaga a identificação e o "conta na comissão" gravados nele.

## Scripts (`docs/fechamento/20261021/`)

- `gera_fech.py`: gera `fech.sql`, `fech_rollback.sql` e `fech_backup.json` a partir do texto atual de produção. Cada troca de texto é conferida com assert.
- `test_fech_db.py [pedido.json]`: prova **antes** de aplicar (aplica dentro da transação e faz rollback). Resultado: 24/24.
  - Cobre analistas, gerentes, auditoria SPF, fechamento já gravado e permissões por perfil.
  - Faz um fechamento simulado com a prévia real (antigo × novo) e testa o desfazer byte a byte.
- `captura_payload.py <clone|""> <saida.json>`: monta o pedido de fechamento com o código da tela, sem fechar nada.
  - O arquivo gerado contém nomes e comissões de funcionários: **não versionar**.
- `test_export_simulado.py`: RH/DP de um fechamento simulado. Resultado: 7/7, com CPF 90/90 e "Conta na comissão".
  - O .xlsx com CPF é apagado ao final.
- `pos_fech_prod.py [--antes]`: conferência em produção com Master, Analista e Vendedor.
  - Também confere o que **não** pode mudar: comissão dos vendedores, fechamento já gravado e períodos.
- `gera_rhdp.py`, `inspeciona.py`, `compara.py`, `confere_publicado.py`: geração do RH/DP pela tela, estrutura do arquivo, comparação antes × depois e `?v=` servidos.
- `diag_*.py`: diagnósticos (só leitura, só agregados) do SPF 28 × 27, dos marcadores de R$ 1,00 e da identidade nas fontes da prévia.
- `sqlexato.py`: roda SQL por arquivo gravado em binário (o `apoio/sq.py` em modo texto troca LF por CRLF e altera o texto exato).

Depois de qualquer mudança no banco, rode a guarda: `python -I docs/seguranca/guarda_tabelas_internas.py` (10/10).

## Resultado da aplicação (21/10/2026 16:01, produção)

- Migração aplicada (sha256 `657006d3c34e8b15…`, o mesmo arquivo provado), sem erro. A tela já estava no ar (homolog `41e419e`, piloto `f0a6d06`).
- `pos_fech_prod.py`: **15/15**.
  - **Não mudou:** comissão dos vendedores, o fechamento 22/09–20/10 (snapshot e detalhe) e os períodos vistos pelo Vendedor.
  - **Analistas:** 23 unidades de SPF (sem os 4 de R$ 1,00) e identificador em todas as linhas. Gerentes também com identificador.
  - **Auditoria SPF:** código e banco preenchidos, com 4 linhas "não conta".
  - **Fechamento simulado** (rollback): 90 linhas em centavos, total igual à soma, CPF 90/90.
  - **Perfis:** Analista e Vendedor sem acesso às funções do Master nem ao snapshot.
- Guarda das tabelas internas: **10/10**.
- RH/DP do fechamento 22/09–20/10 exportado pelo piloto depois da mudança: idêntico (0 células diferentes).

## 21/10/2026 — reabertura e indicadores do Resumo

- **Reabertura (feita pelo Luis, de propósito):** reimportou as bases 15:00–15:03, reabriu às 15:06 e fechou de novo às 16:10 (Brasília).
  - **v2** (`b22983bf…`) é a oficial, já com as regras novas.
  - **v1** (`56c80a93…`) ficou intacta e inativa.
- **Indicadores do Resumo** (homolog `d023825`, piloto `891cc40`): Vendida, Financiada, Produção, Retorno e SPF eram a soma de **todas** as linhas (vendedor + gerente + analista + gestor) e contavam a mesma venda 3–4 vezes.
  - Agora são os **totais do grupo**: soma dos VENDEDORES, igual à linha do Gestor F&I.
  - Vale no próximo fechamento (o que é gravado) e no RH/DP dos fechamentos já feitos (calculado do snapshot congelado).
  - O que já estava gravado fica no banco como está. A comissão não muda.
- **Valores corretos de 22/09–20/10 (v2):** 314 vendidas, 139 financiadas, produção R$ 14.140.279,00, retorno R$ 669.386,08, SPF R$ 130.868,34, comissão R$ 219.661,09.
- **Fechamentos feitos no V1** (ex.: 21/08–20/09) já gravavam os totais certos.
- Outras telas: só o RH/DP usava esses indicadores. Histórico, Salários & Comissões e Brabus IA usam só a Comissão Total.
- Provas: `compara_resumo.py` e `esperado_grupo.py` (abas 2–8 idênticas; Resumo = totais do grupo), `captura_payload.py` com `SEM_SIM=1` (pedido de fechamento: linhas idênticas, só os 5 indicadores mudam). Guarda 10/10.

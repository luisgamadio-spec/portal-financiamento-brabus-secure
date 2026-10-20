# Segurança do banco — tabelas internas e "Falar com um Analista"

## GUARDA — rodar SEMPRE

```bash
python -I docs/seguranca/guarda_tabelas_internas.py
```

Rodar **depois de toda mudança no banco** (migração, função, permissão) **e de toda publicação do portal**
(homolog e piloto). Só lê o banco (transações somente leitura com rollback) e não imprime dados.
Tem que terminar com **"10/10 verificações OK"** (código de saída 0). Qualquer FALHA = parar e investigar.

O que ela garante, para `configuracoes`, `periodos_comissao`, `ausencias_analistas`,
`mudancas_loja_vendedores`, `analistas_fi` e `chamar_analista_fi_controle`:
- nenhuma permissão de tabela para `anon` (visitante) nem `authenticated` (qualquer logado);
- RLS ligada e nenhuma regra de RLS para esses papéis;
- na prática, Vendedor, Analista e Master reais recebem "permission denied" ao ler direto;
- `chamar_analista_fi` não pode ser chamada por visitante.

As telas leem esses dados **somente pelas funções do banco** (SECURITY DEFINER, com o perfil conferido dentro).

## Mudança de 20/10/2026

| | |
|---|---|
| Migração | `supabase/migrations/20261020120000_seguranca_tabelas_internas_chamar_analista.sql` |
| Desfazer | `docs/rollback/seguranca_20261020_rollback.sql` (texto EXATO de antes, com quebras CRLF — aplicar com `-f`, nunca colando) |
| Backup | `docs/seguranca/20261020/backup_antes.json` (13 regras, 2 funções, permissões) |
| Tela | homolog `e53d3f9`, piloto `25503a2` (publicadas ANTES do SQL) |

1. Remove as 13 regras de RLS sem efeito das 5 tabelas (a RLS continua ligada) e reforça o `revoke`.
2. `operational_commission_periods` não devolve mais `criado_por` (CPF de quem criou o período).
3. `chamar_analista_fi`:
   - só perfis com acesso a um Simulador — mesma regra do menu (`portal_modulos_permitidos()` com
     `simuladorCompleto` ou `simuladorSeminovos`); senão `42501` / hint `PERFIL_SEM_SIMULADOR`;
   - 1 minuto entre chamadas **atendidas** do mesmo usuário (tabela `chamar_analista_fi_controle`);
     antes disso `P0001` / hint `AGUARDE_CHAMAR_ANALISTA` → a tela mostra "Aguarde um instante para chamar de novo.";
   - sem analista online, volta vazio e não conta no intervalo.

Desfazer o banco (de um clone ligado ao projeto):
`supabase db query --linked -f docs/rollback/seguranca_20261020_rollback.sql` — depois rodar a guarda
(ela vai acusar as 13 regras de volta, que é o estado anterior). Desfazer a tela: `git revert` dos commits acima.

### Scripts (`docs/seguranca/20261020/`)

- `gera_seg5.py`: gera `seg5.sql`, `seg5_rollback.sql` e `backup_antes.json` a partir do banco.
- `test_seg5_db.py`: prova **antes** de aplicar: aplica dentro da transação e faz rollback. Resultado: 26/26.
  Não roda depois de aplicado, porque a tabela de controle já existe.
- `test_seg5_tela.py <clone|"">`: testa o botão nos Simuladores e no Início, logado como Vendedor real.
  Usa um analista falso e rollback. Resultado: 7/7.
- `pos_seg5_prod.py`: conferência em produção com Vendedor, Analista e Master, depois de aplicar.
  - `--antes`: grava as assinaturas de antes em `antes_pos.json`.
- `confere_publicado.py`: confere os `?v=` servidos pelo Pages.
- `apoio/`: harness de teste. Os logins são simulados, e as funções do banco rodam com usuários reais em rollback.

Nenhum script grava dados reais. O analista "online" dos testes é um registro falso criado e desfeito dentro da transação.

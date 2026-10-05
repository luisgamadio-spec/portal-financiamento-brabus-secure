# Brabus Intelligence (v1) — construída do zero

Assistente de Financiamentos do Portal F&I. **Não reaproveita nada da IA antiga**: não usa `portal-ai`, `ia-2f-*`, `EVAL.md` nem os arquivos `brabus-intelligence*` antigos do V2.

## Como funciona

```
Portal V2 (bi-chat.js) ──JWT do usuário──► Edge Function brabus-intelligence
                                             ├─ modelo de linguagem (OpenAI) → só conversa e escolhe ferramentas
                                             ├─ 15 ferramentas (agent/ferramentas.ts)
                                             │    ├─ motor de cálculo (engine/) = mesma matemática dos simuladores
                                             │    └─ RPCs do Portal (simulador_get_*, operational_*) com o JWT do usuário
                                             └─ bi_simulacoes / bi_audit_log (RLS)
```

- **A IA não calcula.** Todo número sai do motor ou do banco.
- **O motor reproduz os simuladores do Portal**: conferido contra 82 vetores do Simulador de Novos e 39 do de Seminovos, gerados rodando as páginas originais.
- **Permissão é do banco.** As RPCs rodam com o JWT de quem pergunta; nada usa service role. A IA ainda esconde retorno/rentabilidade do perfil VENDEDOR.
- **Bases dos simuladores em modo fail-closed**: se uma base `simulador_get_*` não estiver ACTIVE, o plano não é ofertado (a tela cai num fallback antigo em silêncio; a IA não).

## Ferramentas

| Ferramenta | Fonte |
|---|---|
| listar_planos_elegiveis, simular_financiamento, buscar_entrada_minima, simular_balao | motor + `simulador_get_*` (+ `operational_model_metrics` para entrada média e ranking) |
| simular_antecipacao, simular_cash_conversion, calcular_taxa | motor + `simulador_get_antecipacao` |
| historico_vendas | `operational_model_metrics` |
| resultado_loja, comparar_lojas, ranking_vendedores | `operational_metrics` (+ `operational_portal_config`) |
| analise_fi | `bi_fandi_dashboard` (cópia da RPC da tela + propostas por banco/status e data do lote); sem ela, `operational_fandi_dashboard` |
| consultar_score | `operational_score_coparticipated_data` + fórmula da tela de Score |
| consultar_salario | fechamento oficial: `master_commission_closings` + `master_commission_snapshot` (versão ativa); prévia: `operational_own_commission_summary` ou `operational_commission_metrics` + `operational_scope_commission_rows` |
| consultar_manual | `agent/manual.ts` (conceitos, sem valores vigentes) |

## Publicar (staging primeiro)

```bash
# 1) tabelas da IA
supabase db push            # aplica supabase/migrations/20261002120000_brabus_intelligence_foundation.sql

# 2) segredos
supabase secrets set OPENAI_API_KEY=... BI_MODEL=<modelo-openai> BI_PERFIS=MASTER

# 3) função
supabase functions deploy brabus-intelligence
```

`BI_PERFIS` controla o rollout: comece com `MASTER`, depois `MASTER,DIRETOR,GERENTE,ANALISTA`, por último `VENDEDOR`.

## Publicação atual (03/10/2026)

- Migration aplicada pelo SQL Editor do painel (tabelas `bi_simulacoes`, `bi_audit_log` e funções `bi_*`).
- Função publicada pelo painel como `brabus-intelligence`, a partir de `deno bundle --minify index.ts` (um arquivo só).
- Segredos: `OPENAI_API_KEY` (já existia), `BI_MODEL=gpt-4.1`, `BI_PERFIS=MASTER`, `BI_ALLOWED_ORIGINS=http://localhost:8700,http://127.0.0.1:8700`.
- "Verify JWT with legacy secret" continua ligado. Se o V2 receber 401 com a sessão válida, o projeto usa as novas chaves de assinatura JWT: desligar essa opção no painel (a função já valida o usuário chamando as RPCs com o token dele).

## Testar

```bash
deno task test        # motor (vetores do Portal) + ferramentas + laço — sem rede
OPENAI_API_KEY=... BI_MODEL=... deno task eval   # 20 perguntas com modelo real e checagem anti-alucinação
```

O `eval` reprova qualquer resposta que traga um valor em R$ que não tenha vindo de uma ferramenta.

## Regras de negócio decididas (Luis, out/2026)

- **Carro + entrada** ("quais planos ofertar") → `objetivo="oferta"`: planos estratégicos, **Plano Balão primeiro, depois Linear**.
- **Parcela específica com a menor entrada** → `buscar_entrada_minima`: **planos mais vendidos** do modelo primeiro; dentro de cada plano, a menor entrada.
- **Pedido de ajuda para montar uma estratégia** → `objetivo="estrategia_historico"`: ordena pelo histórico de vendas do modelo.
- **Taxa Subsidiada, Coparticipado e Semestral Taxa 0% só entram se o usuário pedir** (custam rebate para a loja). A IA não sugere por conta própria.
- **Vendedor não vê retorno nem rentabilidade.**
- **Plano Balão sempre tem balão** (não existe "Balão sem balão"), com o máximo de balão da tabela.
- **Estruturas de balão por aceitação de venda** (`estrutura_balao`): `preferidas` (padrão, 1 balão) = 48x na última, 48x na 36ª, 36x na última, 36x na 24ª; `ate_2_baloes` acrescenta 48x (24ª+48ª) e 36x (18ª+36ª); `todas` (3-4 balões, outros prazos) só com pedido explícito. `balao_personalizado {prazo, meses}` acha a menor entrada para a estrutura que o usuário definir. Na parcela-alvo, a opção de menor entrada vem em destaque.
- **Novos × Seminovos**: resultado, comparação e ranking aceitam `departamento` (NOVOS/SEMINOVOS). Sem ele a visão é Grupo e cada loja traz `por_departamento`.
- **Resultado de loja abre com carros vendidos, financiados e share.**
- **Antecipação**: "daqui a N meses" = HOJE + N meses (`meses_ate_antecipacao`); contrato com balão informa `baloes`; "a última parcela" de contrato com balão final = o balão.
- **Financiar × à vista** sempre pelo Cash Conversion, com taxa de empate; sem a taxa do cliente, cenários de 0,8 / 1,0 / 1,2% a.m.
- **Score** traz composição, destaques (≥ 80% do item) e onde perdeu pontos (< 60%).
- Resultados/ranking/histórico exigem o módulo `dashbi`; Análise F&I exige `gestao`; Score e Comissão exigem os módulos deles (matriz `portal_modulos_permitidos`).

## Ainda em aberto

1. **WhatsApp**: fora desta versão (não há cadastro de telefone por usuário no banco).
2. Algumas RPCs só existem em produção (sem código no Git): os formatos foram levantados do frontend. Por isso o teste em staging vem antes de liberar.

## Cartões (resposta visual)

A função responde `{ resposta, sessao_id, ferramentas, blocos }`. `blocos` são montados pelo backend com os números das ferramentas (o modelo só escolhe quais opções e qual é o destaque, via `apresentar_opcoes`). Tipos:

- `opcoes`: `{ titulo, veiculo, parcela_alvo, destaque, alternativas[] }`. Cada opção: `plano, plano_nome, prazo, entrada, entrada_pct, financiado, parcela, taxa_tabela_pct_am, baloes[{mes, valor, total_no_mes}], total_baloes, baloes_pct_do_veiculo, aceitacao_comercial, entrada_minima_necessaria?, destaque?, rebate_concessionaria?, valor_final_venda?`.
- `resultado`: `{ titulo, periodo, visao, lojas[{loja, vendidos, financiados, share_pct, producao, spf_qtd, retorno?, rentabilidade?, mix_planos[], variacao_vs_anterior{}, por_departamento?{NOVOS, SEMINOVOS}}], total? }`.
- `comparacao`: `{ titulo, periodo, visao, lojas[], linhas[{indicador, rotulo, formato: int|brl|pct, valores[], lider}] }`.

- `score`: `{ titulo, periodo, visao, vendedor{posicao, total_vendedores, vendedor, loja, score, faixa, vendas, financiados, share_pct, spf_qtd, plano_mais_vendido}, composicao[{item, pontos, maximo, pct, pontos_perdidos, detalhe}], destaques[string], melhorar[{item, pontos, maximo, pontos_perdidos, detalhe}], utilizacao_conversao{disponivel, motivo?, pontos, maximo:100, conversao (máx 70), utilizacao (máx 30), status, simulacoes, vendas, financiados, observacao}, ranking[{posicao, vendedor, loja, score, faixa}] }` (ranking = top 5; destaques e melhorar com no máximo 2 itens). Utilização + Conversão vem da RPC `score_utilization_conversion_scope_data` e, como na tela do V2, não entra no Score Oficial.
- `antecipacao`: `{ titulo, contrato{prazo, parcela_mensal, baloes[], primeiro_vencimento, premissa_primeiro_vencimento}, data_antecipacao, regra_data, modalidade, parcelas_ja_pagas_ate_a_data, parcelas_em_aberto_na_data, parcelas_antecipadas, valor_original, desconto_total, desconto_pct, valor_a_pagar, economia, linhas[]? | primeiras_linhas[] + ultimas_linhas[] }`; cada linha `{parcela, tipo (Parcela mensal|Balão), vencimento, meses_antecedencia, valor_original, desconto_pct, desconto, valor_a_pagar}`.
- `cash`: `{ titulo, capital, parcela, prazo, total_pago_no_financiamento, juros_pagos, taxa_de_empate_pct_am, leitura_empate, taxa_informada, cenarios[{taxa_aplicacao_pct_am, valor_futuro_da_aplicacao, rendimento_da_aplicacao, diferenca, recomendacao: FINANCIAR|UTILIZAR|EQUIVALENTE}], observacao }`.

- `salario`: `{ titulo, origem, oficial (bool), competencia, pessoa{nome, perfil, loja, departamento, faixa (texto: "4,5%" ou "Faixa 3")}, comissao_total, comissao_principal?, comissao_spf?, indicadores?{vendidas, financiadas, conversao_pct, producao, spf, retorno?, rentabilidade?}, linhas[]?{loja, departamento, cobertura?, faixa, comissao_total}, aviso? }`. Prévia de outra pessoa cobre Vendedor (`operational_commission_metrics`), Analista (`operational_analyst_commission_metrics_v2`) e Gerente (`operational_salary_manager_directory`), com a comissão de `operational_commission_faixa_rows` (MASTER).

- `fandi`: `{ titulo, periodo, visao, base_atualizada_em, base_aviso?, sem_dados_do_periodo, situacao_das_propostas?{propostas_no_periodo, aprovadas_total, faturadas_ou_pagas, aguardando_faturamento, aprovadas_sem_faturar, aprovadas_nao_convertidas, recusadas, outras, pct{mesmas chaves, % sobre propostas_no_periodo}}, foco (geral|recusas_por_banco|aprovacoes|faturamento|planos|bancos|lojas), resumo{operacoes_financiadas, total_financiado, propostas_aprovadas_em_aberto, valor_aprovado_em_aberto, propostas_recusadas, valor_recusado}, banco_que_mais_recusou?, plano_pedido?, por_banco[{banco, propostas, recusadas, aprovadas_nao_faturadas, faturadas_pagas, taxa_recusa_pct, valor_recusado, financiado}], por_plano[{plano, operacoes, financiado, pct}], propostas_por_status[], por_loja[{loja, aprovadas, recusadas, taxa_aprovacao_pct}], definicoes, aviso? }`.

Retorno/rentabilidade já chegam filtrados por perfil (VENDEDOR não recebe).

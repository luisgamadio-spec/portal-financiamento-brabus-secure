# Loja fantasma "NACOES UNIDAS" — loja canônica na importação de vendas (28/10/2026)

Diagnóstico: a importação da Base 01 só procura o vendedor em `portal_sellers`; vendedor que só existe em `usuarios`
fica "não resolvido" e a loja gravada é o texto bruto "Empresa Vendedora" do NBS ("NACOES UNIDAS"). A loja da venda
vem de `resolve_store_temporal(..., portal_sales.store)`, e o financiamento (loja pelo cadastro) não casava com a venda
(junção por loja), então sumia. Fechamentos gravados não foram afetados.

Aprovado pelo Luis em 28/10/2026, ORDEM SEGURA:
1º texto da planilha traduzido por `public.portal_canoniza_loja`; 2º se não for loja conhecida e o vendedor foi
identificado, a loja do cadastro; 3º o texto como veio (a guarda acusa).
(A regra "sempre o cadastro" mudaria 20 vendas antigas de quem trocou de loja — rejeitada.)

| Arquivo | O que é |
|---|---|
| `20261028120000_loja_canonica_importacao_vendas.sql` | migração (mapa, importação, correção das 4 linhas) |
| `rollback_20261028_loja_canonica.sql` | desfazer (função de importação idêntica à anterior, corpo em CRLF) |
| `master_operational_import_sales_antes.sql` | texto exato da função antes |
| `backup_20261028_linhas_nacoes_unidas.csv` | as 4 linhas antes (sem dados pessoais) |
| `testes_20261028_loja_canonica.sql` | 42 testes, tudo em transação com ROLLBACK |
| `teste_desfazer_20261028.sql` | migração + desfazer na mesma transação (5 testes, ROLLBACK) |

Impacto no período aberto 21/10–20/11 (comissão parcial): vendedor R$ 0,00 → R$ 674,91; gerente NACOES Seminovos
R$ 546,21 → R$ 726,19; analista NACOES R$ 1.644,69 → R$ 1.847,16; gestor F&I R$ 369,41 → R$ 382,91.
Pendente (depois): tela de importação buscar também em `usuarios` e avisar loja desconhecida.

## Aplicado em produção — 28/10/2026 17:18 (OK final do Luis, ordem segura)
- Conferido depois: 4 linhas em NACOES; importação nova com `portal_canoniza_loja(store)`; mapa sem execução para visitante/logado.
- Análise Geral 21/10–20/11 (Master): lojas = as 8 oficiais (sem NACOES UNIDAS); NACOES Seminovos 3 vendas / 3 financiamentos.
- Comissão parcial confere com a simulação: analista NACOES R$ 1.847,16; gerente NACOES Seminovos R$ 726,19;
  vendedor R$ 674,91 (faixa 15%); gestor F&I R$ 382,91 (19 financiadas).
- Guarda com a 17ª checagem (lojas fora das 8 + REVENDA): 17/17 (registro guarda_20261028_172220.txt).
- Desfazer: `supabase db query --linked -f docs/rollback/loja_canonica_20261028_rollback.sql` e depois rodar a guarda.

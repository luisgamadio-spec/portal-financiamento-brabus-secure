// Manual de produtos da Brabus Intelligence ("Bíblia dos Planos").
// Texto CONCEITUAL escrito a partir das regras dos simuladores do Portal.
// Valores vigentes (taxas, coeficientes, rebates) NUNCA ficam aqui: vêm das bases ACTIVE.

export type Topico = { id: string; titulo: string; palavras: string[]; texto: string };

export const MANUAL: Topico[] = [
  {
    id: "linear-novos", titulo: "Financiamento Linear (0km)",
    palavras: ["linear", "cdc", "parcela fixa", "novos", "0km"],
    texto: `Parcelas iguais e mensais, de 12 a 60 meses (12, 18, 24, 30, 36, 42, 48, 60).
Aceita entrada a partir de 0%. A taxa depende da faixa de entrada: 0%, 20%, 30%, 40% e 50% ou mais. Quanto maior a entrada, melhor a faixa de taxa.
A parcela embute tarifa de cadastro, registro e IOF. É o plano mais simples de explicar: "parcela fixa do começo ao fim".
Quando usar: cliente que quer previsibilidade e não quer balão. Argumento: "você sabe exatamente quanto vai pagar todo mês".`,
  },
  {
    id: "balao-novos", titulo: "Plano Balão — MIT FÁCIL (0km)",
    palavras: ["balao", "balão", "mit facil", "residual", "parcela intermediaria", "tradicional"],
    texto: `Parcelas mensais menores com até 4 balões (parcelas extras em meses escolhidos). Prazos: 12, 24, 30, 36, 40, 42 e 48 meses.
Entrada mínima de 10%; a taxa melhora a partir de 20% de entrada. A soma dos balões pode chegar a 100% do valor financiado.
No mês do balão o cliente paga a parcela normal MAIS o balão.
Variações do mesmo plano:
- Semestral/Anual: sem parcela mensal; pagamentos iguais a cada 6 ou 12 meses (24, 36 ou 48 meses). Entrada mínima 20%.
- Parcela Única: entrada mínima de 50%, carência de 24 meses e um pagamento único no mês 25.
Quando usar: cliente que quer parcela mensal baixa e tem previsão de dinheiro extra (13º, bônus, venda de outro bem) ou que troca de carro a cada 2–4 anos.`,
  },
  {
    id: "subsidiada", titulo: "Taxas Subsidiadas (0km)",
    palavras: ["subsidiada", "subsidio", "taxa zero", "taxa 0", "rebate", "taxa botao", "copiar taxa"],
    texto: `O cliente recebe uma taxa reduzida (0%, 0,49%, 0,99% ou 1,19% a.m.) e a concessionária paga um REBATE ao banco para cobrir a diferença.
Exige entrada mínima de 50%. Prazos de 12 a 60 meses. Acima de 24 meses entra um acréscimo fixo na base da parcela.
O rebate sai do valor de venda: valor final de venda = valor do bem − rebate. Por isso subsidiar custa margem para a loja.
"Copiar Taxa Banco": é a taxa (por prazo) que o vendedor cadastra no sistema do banco ao operar uma Taxa Subsidiada.
Quando usar: cliente sensível a taxa, com entrada alta. Antes de ofertar, confirme se a margem da venda comporta o rebate.`,
  },
  {
    id: "coparticipado", titulo: "Plano Coparticipado (0km)",
    palavras: ["coparticipado", "copart", "hpe", "parte brabus", "parte hpe", "campanha"],
    texto: `Taxa reduzida para modelos específicos (Triton, Eclipse Cross e Outlander, por versão). O rebate é dividido entre a montadora (parte HPE) e a concessionária (parte Brabus).
Entrada mínima definida por modelo (normalmente 60%). Prazos de 12 a 60 meses.
Valor final de venda = valor de venda − parte Brabus do rebate.
Atenção: se o cliente optar pelo plano com subsídio, não é pago o trade-in.
Quando usar: modelo da lista da campanha + cliente com entrada alta que quer parcela baixa.`,
  },
  {
    id: "semestral-taxa-zero", titulo: "Semestral Triton/Outlander — Taxa 0%",
    palavras: ["semestral", "taxa 0", "triton", "outlander", "4 parcelas"],
    texto: `Campanha para modelos Triton (e Outlander, quando ativos na base). Entrada fixa calculada pelo modelo (ex.: 60% Triton, 70% Outlander).
O saldo é pago em 4 parcelas semestrais iguais (meses 6, 12, 18 e 24). Também tem rebate dividido HPE/Brabus.
Quando usar: produtor rural, empresário ou cliente com receita sazonal.`,
  },
  {
    id: "linear-seminovos", titulo: "Financiamento Linear (Seminovos)",
    palavras: ["seminovo", "usado", "linear", "ano do veiculo", "faixa de ano"],
    texto: `Parcelas iguais de 12 a 60 meses (12, 18, 24, 30, 36, 42, 48, 50, 60).
A taxa depende da FAIXA DE ANO do veículo (2007–2013, 2014–2017, 2018–2021, 2022–2024, 2025+) e da faixa de entrada (0%, 20%, 40%).
A parcela embute seguro proteção, tarifas e IOF. Entrada mínima 0%.`,
  },
  {
    id: "balao-seminovos", titulo: "Plano Balão (Seminovos)",
    palavras: ["seminovo", "usado", "balao", "balão"],
    texto: `Até 2 balões, limitados a 70% do valor financiado. Prazos 12 a 48 meses.
Só para veículos de 2017 em diante (faixas 2017–2024 e 2025+). A tabela trabalha com entrada a partir de 20%.`,
  },
  {
    id: "antecipacao", titulo: "Antecipação de parcelas",
    palavras: ["antecipar", "antecipacao", "quitar", "quitacao", "desconto", "adiantar"],
    texto: `O cliente pode pagar parcelas futuras antes do vencimento com desconto de juros. O desconto depende de quantos meses faltam para cada parcela vencer (tabela de antecipação do Portal): quanto mais longe o vencimento, maior o desconto.
Pode ser: o contrato todo, um intervalo de parcelas ou uma parcela só.
No simulador de antecipação, o balão de um mês substitui a parcela daquele mês no cálculo.
Argumento: "sobrou dinheiro? antecipe as últimas parcelas, que têm o maior desconto".`,
  },
  {
    id: "cash-conversion", titulo: "Cash Conversion",
    palavras: ["cash conversion", "aplicar", "investir", "capital", "pagar a vista", "a vista", "financiar ou pagar"],
    texto: `Compara duas escolhas do cliente que TEM o dinheiro: pagar à vista ou financiar e deixar o capital aplicado.
Conta: valor final do financiamento = parcela × prazo; valor futuro da aplicação = capital × (1 + taxa da aplicação)^prazo.
Se a aplicação rende mais do que o custo do financiamento, a recomendação é FINANCIAR e preservar o capital; se não, UTILIZAR o capital.
Argumento: "seu dinheiro rendendo paga o carro e ainda sobra".`,
  },
  {
    id: "calculadora-taxa", titulo: "Calculadora de Taxa",
    palavras: ["descobrir taxa", "qual a taxa", "calculadora", "taxa da proposta", "concorrente"],
    texto: `Descobre a taxa mensal a partir do valor financiado, prazo e parcela (por exemplo, para comparar a proposta de outro banco).
Mostra a taxa NET (considerando tarifas e IOF) e o CET mensal.`,
  },
  {
    id: "score", titulo: "Score de Vendedores",
    palavras: ["score", "pontuacao", "nota", "ranking", "faixa"],
    texto: `Nota de 0 a 1000. Novos: volume de vendas (250), penetração de financiamento (230), mix de famílias (130), mix de planos (130), SPF extra (100), retorno médio (160).
Seminovos: volume (300), penetração (270), SPF (150), retorno (280).
Penetração considera bom 60% das vendas financiadas; retorno considera bom 8% sobre a produção. Com poucas vendas (menos de 4) ou poucos financiamentos (menos de 2) os pontos são proporcionais.
Faixas: 900+ Excelência, 800+ Alto, 650+ Bom, 400+ Em desenvolvimento, abaixo Baixo.
O que mais sobe o score: financiar mais vendas, vender SPF e variar planos (Linear, Balão, Coparticipado, Subsidiado).`,
  },
  {
    id: "glossario", titulo: "Glossário do Grupo",
    palavras: ["share", "penetracao", "producao", "retorno", "spf", "competencia", "rentabilidade"],
    texto: `Share / penetração: financiamentos ÷ vendas.
Produção: soma do valor financiado.
Retorno: valor que o banco paga à concessionária pela operação.
SPF: produto SPF EXTRA vendido junto com o financiamento; conta na rentabilidade pelo valor líquido (percentual configurado no Portal, padrão 70%).
Rentabilidade: retorno + SPF líquido.
Competência: período de comissão do Portal (normalmente do dia 21 ao dia 20).`,
  },
];

const sem = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function buscaManual(pergunta: string, max = 3): Topico[] {
  const q = sem(pergunta);
  const pont = MANUAL.map((t) => {
    let p = 0;
    for (const w of t.palavras) if (q.includes(sem(w))) p += 3;
    for (const tok of q.split(/\W+/).filter((x) => x.length > 3)) if (sem(t.texto + " " + t.titulo).includes(tok)) p += 1;
    return { t, p };
  }).filter((x) => x.p > 0).sort((a, b) => b.p - a.p);
  return pont.slice(0, max).map((x) => x.t);
}

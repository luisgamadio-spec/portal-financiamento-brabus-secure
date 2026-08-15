/* ==========================================================================
   CASH CONVERSION — motor financeiro isolado, compartilhado pelos
   simuladores de Novos e Seminovos.

   Metodologia (evolução comercial, validada pelo usuário): a parcela do
   financiamento passou a ser uma ENTRADA MANUAL (o valor ofertado ao
   cliente pelo vendedor), não mais calculada via PMT/taxa do
   financiamento. Ferramenta INDEPENDENTE — não herda dados de nenhuma
   simulação/aba específica (Balão, Semestral/Anual, Parcela Única
   etc.); os quatro insumos (Capital, Parcela Ofertada, Prazo, Taxa da
   Aplicação) são informados pelo usuário no próprio painel do Cash
   Conversion.

   LADO 1 — financiamento (nominal, sem desconto a valor presente):
     VALOR FINAL DAS PARCELAS = parcela * prazo

   LADO 2 — capital investido, mantido aplicado durante o mesmo prazo
   (juros compostos):
     CAPITAL FINAL PROJETADO = capital * (1 + taxaAplicacao) ^ prazo
     RENDIMENTO PROJETADO = capitalFinalProjetado - capital

   DIFERENÇA PROJETADA = capitalFinalProjetado - valorFinalFinanciamento

   CLASSIFICAÇÃO:
     capitalFinalProjetado > valorFinalFinanciamento -> FINANCIAR
     capitalFinalProjetado < valorFinalFinanciamento -> UTILIZAR
     iguais (tolerância de 1 centavo)                -> EQUIVALENTE
   ========================================================================== */
(function (global) {
  'use strict';

  function calcularValorFinalFinanciamento(parcela, prazoMeses) {
    if (!(parcela > 0) || !(prazoMeses > 0)) return 0;
    return parcela * prazoMeses;
  }

  function calcularValorFuturoAplicacao(capital, taxaAplicacao, prazoMeses) {
    return capital * Math.pow(1 + taxaAplicacao, prazoMeses);
  }

  function calcularRendimentoAplicacao(capital, valorFuturoAplicacao) {
    return valorFuturoAplicacao - capital;
  }

  function classificarResultado(valorFuturoAplicacao, valorFinalFinanciamento) {
    var centavosAplicacao = Math.round(valorFuturoAplicacao * 100);
    var centavosFinanciamento = Math.round(valorFinalFinanciamento * 100);
    if (centavosAplicacao === centavosFinanciamento) return 'EQUIVALENTE';
    return centavosAplicacao > centavosFinanciamento ? 'FINANCIAR' : 'UTILIZAR';
  }

  // Função principal — todos os insumos vêm do próprio painel do Cash
  // Conversion (nunca de uma simulação de financiamento existente).
  function calcularCashConversion(params) {
    var capital = params.capital;
    var parcela = params.parcela;
    var prazoMeses = params.prazoMeses;
    var taxaAplicacao = params.taxaAplicacao;

    if (!(capital > 0) || !(parcela > 0) || !(prazoMeses > 0) || !isFinite(taxaAplicacao)) {
      return null;
    }

    var valorFinalFinanciamento = calcularValorFinalFinanciamento(parcela, prazoMeses);
    var valorFuturoAplicacao = calcularValorFuturoAplicacao(capital, taxaAplicacao, prazoMeses);
    var rendimentoAplicacao = calcularRendimentoAplicacao(capital, valorFuturoAplicacao);
    var diferencaProjetada = valorFuturoAplicacao - valorFinalFinanciamento;
    var classificacao = classificarResultado(valorFuturoAplicacao, valorFinalFinanciamento);

    return {
      capital: capital,
      parcela: parcela,
      prazoMeses: prazoMeses,
      taxaAplicacao: taxaAplicacao,
      valorFinalFinanciamento: valorFinalFinanciamento,
      valorFuturoAplicacao: valorFuturoAplicacao,
      rendimentoAplicacao: rendimentoAplicacao,
      diferencaProjetada: diferencaProjetada,
      classificacao: classificacao
    };
  }

  global.CashConversion = {
    calcularValorFinalFinanciamento: calcularValorFinalFinanciamento,
    calcularValorFuturoAplicacao: calcularValorFuturoAplicacao,
    calcularRendimentoAplicacao: calcularRendimentoAplicacao,
    calcularCashConversion: calcularCashConversion
  };
})(window);

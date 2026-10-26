// Brabus Intelligence — ferramentas comuns a Novos e Seminovos:
// Calculadora de Taxa, Simulador de Antecipação e Cash Conversion.

import { addMonths, diffMonthsAhead, parseISO, taxaPricePorIteracao, toISO, type DataISO } from "./comum.ts";
import type { Balao } from "./novos.ts";

// =====================================================================
// CALCULADORA DE TAXA (parcela → taxa)
// =====================================================================
export type SaidaCalcTaxa = { taxaNet: number; taxaCetMes: number; total: number; juros: number };

export function calculadoraTaxa(financiado: number, prazo: number, parcela: number): SaidaCalcTaxa | { erro: string } {
  if (!(financiado > 0)) return { erro: "Informe um valor financiado maior que zero." };
  if (!(Number.isInteger(prazo) && prazo >= 1 && prazo <= 60)) return { erro: "Informe um prazo válido entre 1 e 60 meses." };
  if (!(parcela > 0)) return { erro: "Informe uma parcela maior que zero." };
  const total = parcela * prazo;
  const incompat = { erro: "Parcela incompatível com os dados informados (não cobre o valor financiado com encargos)." };
  if (total < financiado - 0.01) return incompat;
  const estimado = (financiado + 980 + 339.67) / (1 - 0.02949694);
  const taxaNet = taxaPricePorIteracao(estimado, parcela, prazo);
  const taxaCetMes = taxaPricePorIteracao(financiado, parcela, prazo);
  if (taxaNet === null || taxaCetMes === null || !isFinite(taxaNet) || !isFinite(taxaCetMes)) return incompat;
  return { taxaNet, taxaCetMes, total, juros: total - financiado };
}

// =====================================================================
// SIMULADOR DE ANTECIPAÇÃO (tabela de desconto por meses de antecedência)
// =====================================================================
export type TabelaAntecipacao = Record<string, number>;
export type EntradaAntecipacao = {
  prazo: number; parcela: number; primeiroVenc: DataISO; data: DataISO;
  tipo: "todo" | "algumas" | "uma"; de?: number; ate?: number; parcelaEscolhida?: number; baloes?: Balao[];
};
export type LinhaAntecipacao = {
  num: number; venc: DataISO; tipo: "Parcela mensal" | "Balão"; valorOriginal: number;
  meses: number; desconto: number; valorDesconto: number; final: number;
};
export type SaidaAntecipacao = {
  linhas: LinhaAntecipacao[]; qtd: number; brutoTotal: number; baloesTotal: number;
  descTotal: number; finalTotal: number; aviso: string | null;
};

export function antecipacao(e: EntradaAntecipacao, tabela: TabelaAntecipacao): SaidaAntecipacao | { erro: string } {
  const prazo = Number(e.prazo);
  if (!(prazo >= 1 && prazo <= 60)) return { erro: "Informe um prazo entre 1 e 60 meses." };
  if (!(e.parcela > 0)) return { erro: "Informe um valor de parcela mensal maior que zero." };
  const primeira = parseISO(e.primeiroVenc);
  if (!primeira) return { erro: "Informe a data da primeira parcela (AAAA-MM-DD)." };
  const dt = parseISO(e.data);
  if (!dt) return { erro: "Informe a data desejada para antecipação (AAAA-MM-DD)." };

  const balaoPorMes: Record<number, number> = {};
  for (const b of e.baloes ?? []) {
    const mes = Number(b.mes) || 0, valor = Number(b.valor) || 0;
    if (!mes && !valor) continue;
    if (!mes || mes < 1 || mes > prazo) return { erro: `Existe balão fora do prazo. Use parcelas entre 1 e ${prazo}.` };
    if (balaoPorMes[mes] !== undefined) return { erro: "Não é permitido inserir dois balões na mesma parcela." };
    if (!(valor > 0)) return { erro: "Informe valor válido para todos os balões." };
    balaoPorMes[mes] = valor;
  }

  let inicio = 1, fim = prazo;
  if (e.tipo === "algumas") {
    inicio = Number(e.de || 0);
    fim = Number(e.ate || 0);
    if (!(inicio >= 1 && fim >= inicio && fim <= prazo)) return { erro: `Informe um intervalo válido entre 1 e ${prazo}.` };
  } else if (e.tipo === "uma") {
    inicio = fim = Number(e.parcelaEscolhida || 0);
    if (!(inicio >= 1 && inicio <= prazo)) return { erro: `Informe uma parcela válida entre 1 e ${prazo}.` };
  }

  const linhas: LinhaAntecipacao[] = [];
  let brutoTotal = 0, baloesTotal = 0, descTotal = 0, finalTotal = 0, faltou = false;
  for (let num = inicio; num <= fim; num++) {
    const venc = addMonths(primeira, num - 1);
    if (venc.getTime() <= dt.getTime()) continue;
    const meses = diffMonthsAhead(dt, venc);
    let desconto = tabela[String(meses)];
    if (desconto === undefined) { desconto = 0; faltou = true; }
    const valorBalao = balaoPorMes[num] || 0;
    // No Portal, na antecipação o balão SUBSTITUI a parcela do mês (no Plano Balão ele soma).
    const valorOriginal = valorBalao > 0 ? valorBalao : e.parcela;
    const valorDesconto = valorOriginal * desconto;
    const final = valorOriginal - valorDesconto;
    brutoTotal += valorOriginal; baloesTotal += valorBalao; descTotal += valorDesconto; finalTotal += final;
    linhas.push({ num, venc: toISO(venc), tipo: valorBalao > 0 ? "Balão" : "Parcela mensal", valorOriginal, meses, desconto, valorDesconto, final });
  }
  if (!linhas.length) return { erro: "Nenhuma parcela futura encontrada para antecipação. Revise a data e as parcelas escolhidas." };
  return {
    linhas, qtd: linhas.length, brutoTotal, baloesTotal, descTotal, finalTotal,
    aviso: faltou ? "Algumas parcelas não tinham percentual na tabela e foram calculadas sem desconto." : null,
  };
}

// =====================================================================
// CASH CONVERSION (financiar e aplicar × usar o capital)
// =====================================================================
export type SaidaCash = {
  valorFinalFinanciamento: number; valorFuturoAplicacao: number; rendimentoAplicacao: number;
  diferencaProjetada: number; classificacao: "FINANCIAR" | "UTILIZAR" | "EQUIVALENTE";
};

export function cashConversion(capital: number, parcela: number, prazoMeses: number, taxaAplicacao: number): SaidaCash | { erro: string } {
  if (!(capital > 0)) return { erro: "Informe um capital maior que zero." };
  if (!(parcela > 0)) return { erro: "Informe o valor da parcela ofertada." };
  if (!(Number.isInteger(prazoMeses) && prazoMeses >= 1 && prazoMeses <= 60)) return { erro: "Informe um prazo válido entre 1 e 60 meses." };
  if (!isFinite(taxaAplicacao) || taxaAplicacao < 0) return { erro: "Informe a taxa da aplicação." };
  const valorFinalFinanciamento = parcela * prazoMeses;
  const valorFuturoAplicacao = capital * Math.pow(1 + taxaAplicacao, prazoMeses);
  const a = Math.round(valorFuturoAplicacao * 100), f = Math.round(valorFinalFinanciamento * 100);
  return {
    valorFinalFinanciamento, valorFuturoAplicacao, rendimentoAplicacao: valorFuturoAplicacao - capital,
    diferencaProjetada: valorFuturoAplicacao - valorFinalFinanciamento,
    classificacao: a === f ? "EQUIVALENTE" : a > f ? "FINANCIAR" : "UTILIZAR",
  };
}

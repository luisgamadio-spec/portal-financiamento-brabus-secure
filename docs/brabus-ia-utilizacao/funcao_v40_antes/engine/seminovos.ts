// Brabus Intelligence — motor do Simulador de Seminovos.
// Reproduz a matemática de modules/simulador-seminovos.html (validado contra
// tests/fixtures/seminovos_vectors.json, gerados da página original).

import { baseInterna, fatorPrice, pct, taxaInterna } from "./comum.ts";
import type { Balao } from "./novos.ts";

/** RATE_TABLE[faixaAno]["0"|"20"|"40"][prazo] = taxa a.m. */
export type RateTableSeminovo = Record<string, Record<string, Record<string, number>>>;
export type LinhaBalaoSemi = { faixa: string; entrada: number; prazo: number; max: number; taxa: number };
export type TabelasSeminovos = { linear: RateTableSeminovo; balao: LinhaBalaoSemi[] };

export const PRAZOS_LINEAR_SEMI = [12, 18, 24, 30, 36, 42, 48, 50, 60];
export const PRAZOS_BALAO_SEMI = [12, 24, 30, 36, 40, 42, 48];
const FEES = { cadastro: 970, avaliacao: 699, registro: 400 };
const SEGURO_PROTECAO = 0.025;

export function faixaAnoLinear(ano: number): string | null {
  if (ano >= 2007 && ano <= 2013) return "2007-2013";
  if (ano >= 2014 && ano <= 2017) return "2014-2017";
  if (ano >= 2018 && ano <= 2021) return "2018-2021";
  if (ano >= 2022 && ano <= 2024) return "2022-2024";
  if (ano >= 2025 && ano <= 2099) return "2025-2099";
  return null;
}

export function faixaEntradaLinear(pctEntrada100: number): "0" | "20" | "40" {
  if (pctEntrada100 < 20) return "0";
  if (pctEntrada100 < 40) return "20";
  return "40";
}

function pmt(pv: number, rate: number, n: number): number {
  if (!pv || !rate || !n) return 0;
  const pow = Math.pow(1 + rate, n);
  return (pv * (rate * pow)) / (pow - 1);
}

/** Linear Seminovos: seguro 2,5% + tarifas 970/699/400 + IOF por fora com teto de 365 dias. */
export function baseTotalLinearSemi(financiado: number, prazo: number): number {
  const baseSemIOF = financiado * (1 + SEGURO_PROTECAO) + FEES.cadastro + FEES.avaliacao + FEES.registro;
  const dias = Math.min(prazo * 30, 365);
  const iof = baseSemIOF * (0.0038 + 0.000082 * dias);
  return baseSemIOF + iof;
}

export type SaidaLinearSemi = {
  faixaAno: string; faixaEntrada: string; financiado: number; pctEntrada: number;
  itens: { prazo: number; taxa: number | null; parcela: number | null }[];
};

export function linearSeminovo(
  ano: number, valor: number, entrada: number, t: Pick<TabelasSeminovos, "linear">,
): SaidaLinearSemi | { erro: string } {
  const faixa = faixaAnoLinear(ano);
  if (!faixa) return { erro: "Ano fora da tabela vigente. Use anos entre 2007 e 2099." };
  if (!(valor > 0)) return { erro: "Informe o valor do veículo." };
  if (entrada > valor) return { erro: "A entrada não pode ser maior que o valor do veículo." };
  const p100 = (entrada / valor) * 100;
  const eBand = faixaEntradaLinear(p100);
  const financiado = Math.max(0, valor - entrada);
  const itens = PRAZOS_LINEAR_SEMI.map((prazo) => {
    const taxa = t.linear[faixa]?.[eBand]?.[String(prazo)];
    if (taxa == null) return { prazo, taxa: null, parcela: null };
    return { prazo, taxa, parcela: pmt(baseTotalLinearSemi(financiado, prazo), taxa, prazo) };
  });
  return { faixaAno: faixa, faixaEntrada: eBand, financiado, pctEntrada: p100 / 100, itens };
}

export function faixaAnoBalao(ano: number): string | null {
  if (ano >= 2025 && ano <= 2099) return "2025_2099";
  if (ano >= 2017 && ano <= 2024) return "2017_2024";
  return null;
}

export type SaidaBalaoSemi = {
  faixaAno: string; financiado: number; pctEntrada: number; prazo: number; taxa: number;
  limiteBaloes: number; totalBaloes: number; parcela: number;
  fluxo: { mes: number; parcela: number; balao: number; total: number }[];
};

export function balaoSeminovo(
  bem: number, entrada: number, ano: number, prazo: number, baloes: Balao[], t: Pick<TabelasSeminovos, "balao">,
): SaidaBalaoSemi | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  const pe = entrada / bem;
  if (pe < 0.1) return { erro: "A entrada mínima permitida para este plano é de 10%." };
  const fin = Math.max(0, bem - entrada);
  if (fin <= 0) return { erro: "A entrada deve ser menor que o valor do bem." };
  if (!(ano >= 1000 && ano <= 9999)) return { erro: "Informe o ano do veículo para identificar a tabela correta." };
  const faixa = faixaAnoBalao(ano);
  const plano = faixa
    ? t.balao.filter((r) => r.faixa === faixa && r.prazo === prazo && pe >= r.entrada).sort((a, b) => b.entrada - a.entrada)[0]
    : undefined;
  if (!plano) return { erro: "Prazo sem regra cadastrada na tabela para a faixa de ano e entrada informada." };
  const lista = (baloes ?? []).map((b) => ({ mes: Number(b.mes) || 0, valor: Number(b.valor) || 0 })).filter((b) => b.mes || b.valor);
  const usados = new Set<number>();
  let total = 0;
  for (const b of lista) {
    if (!b.mes || b.mes < 1 || b.mes > prazo) return { erro: `Existe balão fora do prazo. Use parcelas entre 1 e ${prazo}.` };
    if (usados.has(b.mes)) return { erro: "Não é permitido inserir dois balões na mesma parcela." };
    if (b.valor <= 0) return { erro: "Informe valor válido para todos os balões." };
    usados.add(b.mes);
    total += b.valor;
    if (usados.size > 2) return { erro: "Escolha até 2 balões." };
  }
  const limite = fin * plano.max;
  if (total > limite + 1e-6) return { erro: `A soma dos balões ultrapassa o máximo permitido (${pct(plano.max)} do financiado).` };
  const i = taxaInterna(plano.taxa);
  const vp = lista.reduce((s, b) => s + b.valor / Math.pow(1 + i, b.mes), 0);
  const saldo = baseInterna(fin) - vp;
  if (saldo <= 0) return { erro: "Os balões escolhidos são altos demais para gerar uma parcela mensal válida." };
  const parcela = saldo / fatorPrice(i, prazo);
  return {
    faixaAno: faixa!, financiado: fin, pctEntrada: pe, prazo, taxa: plano.taxa, limiteBaloes: limite, totalBaloes: total, parcela,
    fluxo: lista.slice().sort((a, b) => a.mes - b.mes).map((b) => ({ mes: b.mes, parcela, balao: b.valor, total: parcela + b.valor })),
  };
}

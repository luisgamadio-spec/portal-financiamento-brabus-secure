// Brabus Intelligence — motor do Simulador de Novos (0km).
// Reproduz a matemática de modules/simulador-novos.html (validado contra
// tests/fixtures/novos_vectors.json, gerados da página original).

import { baseInterna, fatorPrice, pct, taxaInterna } from "./comum.ts";

// ---------- Tipos das tabelas (formato das RPCs simulador_get_*) ----------
export type LinhaLinear = { prazo: number; entrada: number; taxa: number };
export type LinhaBalao = { entrada: number; prazo: number; max: number; taxa: number };
export type ParcelaUnicaCfg = { entrada: number; prazo: number; max: number; taxa: number; coef: number };
export type LinhaRebate = { prazo: number; taxa: number; coef: number; rebate: number };
export type ModeloCopart = {
  name: string; entry: number; rebate: number; hpe: number; brabus: number;
  rates: Record<string, number>;
};
export type ModeloSemestral = { rebateTotal: number; hpeShare: number; brabusShare: number; entradaMinima: number };

export type TabelasNovos = {
  linear: LinhaLinear[];
  tradicional: LinhaBalao[];
  periodica: LinhaBalao[];
  parcelaUnica: ParcelaUnicaCfg;
  rebates: LinhaRebate[];
  taxaBotao: Record<string, number>;
  copartModels: ModeloCopart[];
  copartTxCoef: Record<string, Record<string, number>>;
  semestralModelos: Record<string, ModeloSemestral>;
};

/** Parcela Única nunca vem da base: é fixa no Portal. */
export const PARCELA_UNICA_FIXA: ParcelaUnicaCfg = { entrada: 0.5, prazo: 25, max: 1, taxa: 0.0177, coef: 1.6831 };
export const FATOR_SEMESTRAL_TRITON = 1.1045534653178353;
export const MESES_SEMESTRAL_TRITON = [6, 12, 18, 24];
export const PRAZOS_LINEAR = [12, 18, 24, 30, 36, 42, 48, 60];
export const PRAZOS_BALAO = [12, 24, 30, 36, 40, 42, 48];
export const PRAZOS_PERIODICO = [24, 36, 48];
export const PRAZOS_COPART = [12, 18, 24, 36, 48, 60];
export const TAXAS_SUBSIDIADAS = [0, 0.0049, 0.0099, 0.0119];

export type Balao = { mes: number; valor: number };

// =====================================================================
// FINANCIAMENTO LINEAR
// =====================================================================
export function faixaLinear(pe: number): number {
  if (pe >= 0.5) return 0.5;
  if (pe >= 0.4) return 0.4;
  if (pe >= 0.3) return 0.3;
  if (pe >= 0.2) return 0.2;
  return 0;
}

/** Base do Linear: (fin+980+339,67)/(1-(0,0038+0,000082·prazo·30)). IOF SEM teto de 365 dias (como no Portal). */
export function baseCalculoLinear(fin: number, prazo: number): number {
  const fatorIof = 0.0038 + 0.000082 * Math.max(0, prazo) * 30;
  return (Math.max(0, fin) + 980 + 339.67) / (1 - fatorIof);
}

export function coefLinear(i: number, n: number): number | null {
  if (!(n > 0)) return null;
  return i ? i / (1 - Math.pow(1 + i, -n)) : 1 / n;
}

export type ItemLinear = { prazo: number; taxa: number | null; parcela: number | null };
export type SaidaLinear = { financiado: number; pctEntrada: number; faixa: number; itens: ItemLinear[] };

export function linear(bem: number, entrada: number, t: Pick<TabelasNovos, "linear">): SaidaLinear | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  if (entrada >= bem) return { erro: "A entrada deve ser menor que o valor do bem." };
  const financiado = Math.max(0, bem - entrada);
  const pctEntrada = entrada / bem;
  const faixa = faixaLinear(pctEntrada);
  const itens = PRAZOS_LINEAR.map((p) => {
    const row = t.linear.find((r) => r.prazo === p && Math.abs(r.entrada - faixa) < 0.00001);
    const base = baseCalculoLinear(financiado, p);
    const coef = row ? coefLinear(row.taxa, p) : null;
    const parcela = base > 0 && coef && coef > 0 ? base * coef : null;
    return { prazo: p, taxa: row ? row.taxa : null, parcela };
  });
  return { financiado, pctEntrada, faixa, itens };
}

// =====================================================================
// PLANO BALÃO — TRADICIONAL
// =====================================================================
function planoPorFaixa(tab: LinhaBalao[], prazo: number, pe: number): LinhaBalao | null {
  return tab.filter((r) => r.prazo === prazo && pe >= r.entrada).sort((a, b) => b.entrada - a.entrada)[0] ?? null;
}

function validaBaloes(baloes: Balao[], prazo: number): { lista: Balao[]; total: number } | { erro: string } {
  const lista = (baloes ?? []).map((b) => ({ mes: Number(b.mes) || 0, valor: Number(b.valor) || 0 })).filter((b) => b.mes || b.valor);
  const usados = new Set<number>();
  let total = 0;
  for (const b of lista) {
    if (!b.mes || b.mes < 1 || b.mes > prazo) return { erro: `Existe balão fora do prazo. Use parcelas entre 1 e ${prazo}.` };
    if (usados.has(b.mes)) return { erro: "Não é permitido inserir dois balões na mesma parcela." };
    if (b.valor <= 0) return { erro: "Informe valor válido para todos os balões." };
    usados.add(b.mes);
    total += b.valor;
  }
  return { lista, total };
}

export type SaidaBalao = {
  financiado: number; pctEntrada: number; prazo: number; taxa: number; faixaEntrada: number;
  limiteBaloes: number; totalBaloes: number; parcela: number;
  fluxo: { mes: number; parcela: number; balao: number; total: number }[];
};

/** Entrada mínima do Balão 0km é fixa em 10% no Portal (não vem da tabela). */
export const ENTRADA_MIN_BALAO_NOVOS = 0.1;
/** Portal: "Escolha até 4 balões" (Novos). */
export const MAX_BALOES_TRADICIONAL = 4;

export function balaoTradicional(
  bem: number, entrada: number, prazo: number, baloes: Balao[], t: Pick<TabelasNovos, "tradicional">,
): SaidaBalao | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  const fin = Math.max(0, bem - entrada);
  const pe = entrada / bem;
  if (pe < ENTRADA_MIN_BALAO_NOVOS) return { erro: "A entrada mínima permitida para este plano é de 10%." };
  if (fin <= 0) return { erro: "A entrada deve ser menor que o valor do bem." };
  const plano = planoPorFaixa(t.tradicional, prazo, pe);
  if (!plano) return { erro: "Prazo sem regra cadastrada na tabela para a faixa de entrada informada." };
  const v = validaBaloes(baloes, prazo);
  if ("erro" in v) return v;
  if (v.lista.length > MAX_BALOES_TRADICIONAL) return { erro: `Escolha até ${MAX_BALOES_TRADICIONAL} balões.` };
  const limite = fin * plano.max;
  if (v.total > limite + 1e-6) {
    return { erro: `A soma dos balões ultrapassa o valor máximo de balão permitido (${pct(plano.max)} do financiado).` };
  }
  const i = taxaInterna(plano.taxa);
  const fator = fatorPrice(i, prazo);
  const vp = v.lista.reduce((s, b) => s + b.valor / Math.pow(1 + i, b.mes), 0);
  const saldo = baseInterna(fin) - vp;
  if (saldo <= 0) return { erro: "Os balões escolhidos são altos demais para gerar uma parcela mensal válida." };
  const parcela = saldo / fator;
  const fluxo = v.lista.slice().sort((a, b) => a.mes - b.mes).map((b) => ({ mes: b.mes, parcela, balao: b.valor, total: parcela + b.valor }));
  return { financiado: fin, pctEntrada: pe, prazo, taxa: plano.taxa, faixaEntrada: plano.entrada, limiteBaloes: limite, totalBaloes: v.total, parcela, fluxo };
}

// =====================================================================
// PLANO BALÃO — SEMESTRAL / ANUAL (sem parcela mensal)
// =====================================================================
export type SaidaPeriodica = { financiado: number; pctEntrada: number; prazo: number; tipo: "semestral" | "anual"; taxa: number; meses: number[]; parcela: number };

export function semestralAnual(
  bem: number, entrada: number, prazo: number, tipo: "semestral" | "anual", t: Pick<TabelasNovos, "periodica">,
): SaidaPeriodica | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  const fin = Math.max(0, bem - entrada);
  const pe = entrada / bem;
  if (fin <= 0) return { erro: "A entrada deve ser menor que o valor do bem." };
  const doPrazo = t.periodica.filter((r) => r.prazo === prazo);
  if (!doPrazo.length) return { erro: "Prazo sem regra cadastrada para Semestral / Anual." };
  const minEntrada = Math.min(...doPrazo.map((r) => r.entrada));
  if (pe < minEntrada) return { erro: `A entrada mínima permitida para este plano é de ${pct(minEntrada)}.` };
  const plano = planoPorFaixa(t.periodica, prazo, pe)!;
  const step = tipo === "semestral" ? 6 : 12;
  const meses: number[] = [];
  for (let m = step; m <= prazo; m += step) meses.push(m);
  const i = taxaInterna(plano.taxa);
  const denom = meses.reduce((s, m) => s + 1 / Math.pow(1 + i, m), 0);
  return { financiado: fin, pctEntrada: pe, prazo, tipo, taxa: plano.taxa, meses, parcela: baseInterna(fin) / denom };
}

// =====================================================================
// PLANO BALÃO — PARCELA ÚNICA (carência 24 meses, paga no mês 25)
// =====================================================================
export type SaidaParcelaUnica = { financiado: number; pctEntrada: number; taxa: number; mesPagamento: number; parcela: number };

export function parcelaUnica(bem: number, entrada: number, cfg: ParcelaUnicaCfg = PARCELA_UNICA_FIXA): SaidaParcelaUnica | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  const fin = Math.max(0, bem - entrada);
  const pe = entrada / bem;
  if (fin <= 0) return { erro: "A entrada deve ser menor que o valor do bem." };
  if (pe < cfg.entrada) return { erro: `A entrada mínima permitida para Parcela Única é de ${pct(cfg.entrada)}.` };
  return { financiado: fin, pctEntrada: pe, taxa: cfg.taxa, mesPagamento: 25, parcela: fin * cfg.coef };
}

// =====================================================================
// TAXAS SUBSIDIADAS (rebate pago pela concessionária)
// =====================================================================
export type LinhaSubsidiada = {
  prazo: number; taxa: number; parcela: number; rebatePct: number; rebateValor: number;
  valorFinalVenda: number; viavel: boolean; melhor: boolean;
};
export type SaidaSubsidiadas = { financiado: number; pctEntrada: number; linhas: LinhaSubsidiada[] };

export function taxasSubsidiadas(
  bem: number, entrada: number, minVenda: number, t: Pick<TabelasNovos, "rebates">,
): SaidaSubsidiadas | { erro: string } {
  if (!(bem > 0)) return { erro: "Informe o valor do bem." };
  if (!(entrada > 0)) return { erro: "Informe o valor da entrada." };
  const pe = entrada / bem;
  const fin = bem - entrada;
  if (pe < 0.5) return { erro: "A entrada mínima permitida para esta modalidade é de 50%." };
  if (!(fin > 0)) return { erro: "O valor financiado precisa ser maior que zero." };
  if (minVenda && minVenda >= bem) return { erro: "O valor mínimo de venda deve ser menor que o valor do bem." };
  const linhas = t.rebates
    .filter((r) => TAXAS_SUBSIDIADAS.some((x) => Math.abs(x - r.taxa) < 0.00001))
    .map((r) => {
      const baseParcela = r.prazo <= 24 ? fin : fin + 2500;
      const rebateValor = fin * r.rebate;
      const valorFinalVenda = fin - rebateValor + entrada;
      return {
        prazo: r.prazo, taxa: r.taxa, parcela: baseParcela * r.coef, rebatePct: r.rebate, rebateValor,
        valorFinalVenda, viavel: minVenda > 0 ? valorFinalVenda >= minVenda : true, melhor: false,
      };
    });
  const melhor = linhas.filter((r) => r.viavel)
    .sort((a, b) => b.valorFinalVenda - a.valorFinalVenda || a.taxa - b.taxa || a.prazo - b.prazo)[0];
  if (melhor) melhor.melhor = true;
  return { financiado: fin, pctEntrada: pe, linhas };
}

// =====================================================================
// PLANO COPARTICIPADO (rebate dividido HPE × Brabus)
// =====================================================================
export function coefFor(prazo: number, taxa: number, txCoef: TabelasNovos["copartTxCoef"]): number | null {
  const obj = txCoef[String(prazo)];
  if (!obj) return null;
  const k = Object.keys(obj).find((x) => Math.abs(Number(x) - taxa) < 0.0000001);
  return k !== undefined ? obj[k] : null;
}

export type SaidaCopart = {
  modelo: string; entradaMinima: number; financiado: number;
  termos: { prazo: number; taxa: number; parcela: number | null }[];
  rebateTotal: number; rebateBrabus: number; rebateHpe: number; valorFinalVenda: number;
};

export function coparticipado(
  modelo: string, venda: number, entrada: number, t: Pick<TabelasNovos, "copartModels" | "copartTxCoef">,
): SaidaCopart | { erro: string } {
  const m = t.copartModels.find((x) => x.name === modelo);
  if (!m) return { erro: `Modelo fora do Plano Coparticipado. Modelos válidos: ${t.copartModels.map((x) => x.name).join(", ")}.` };
  if (!(venda > 0)) return { erro: "Informe o valor de venda." };
  if (!(entrada >= venda * m.entry)) return { erro: `A entrada mínima permitida para este plano é de ${pct(m.entry)}.` };
  const fin = Math.max(venda - entrada, 0);
  const termos = PRAZOS_COPART.map((p) => {
    const taxa = m.rates[String(p)];
    const coef = coefFor(p, taxa, t.copartTxCoef);
    const acrescimo = p <= 24 ? 0.0411 : 0.0622;
    return { prazo: p, taxa, parcela: coef ? fin * (1 + acrescimo) * coef : null };
  });
  const total = fin * m.rebate;
  const brabus = total * m.brabus;
  return {
    modelo: m.name, entradaMinima: m.entry, financiado: fin, termos,
    rebateTotal: total, rebateBrabus: brabus, rebateHpe: total * m.hpe, valorFinalVenda: Math.max(venda - brabus, 0),
  };
}

// =====================================================================
// SEMESTRAL TRITON / OUTLANDER — TAXA 0% (entrada fixa)
// =====================================================================
export type SaidaSemestralTriton = {
  modelo: string; entradaPct: number; entrada: number; financiado: number; parcela: number; meses: number[];
  rebateTotal: number; rebateHpe: number; rebateBrabus: number; valorFinalVenda: number;
};

export function semestralTritonOutlander(
  modelo: string, bem: number, t: Pick<TabelasNovos, "semestralModelos">,
): SaidaSemestralTriton | { erro: string } {
  const m = t.semestralModelos[modelo];
  if (!m) return { erro: `Modelo fora da campanha Semestral Taxa 0%. Modelos válidos: ${Object.keys(t.semestralModelos).join(", ")}.` };
  if (!(bem > 0)) return { erro: "Informe o valor de venda." };
  const entrada = bem * m.entradaMinima; // fixa e não arredondada, como no Portal
  const fin = Math.max(0, bem - entrada);
  const rebateTotal = fin * m.rebateTotal;
  const rebateBrabus = rebateTotal * m.brabusShare;
  return {
    modelo, entradaPct: m.entradaMinima, entrada, financiado: fin,
    parcela: (fin * FATOR_SEMESTRAL_TRITON) / MESES_SEMESTRAL_TRITON.length, meses: MESES_SEMESTRAL_TRITON.slice(),
    rebateTotal, rebateHpe: rebateTotal * m.hpeShare, rebateBrabus, valorFinalVenda: bem - rebateBrabus,
  };
}

/** Taxa a cadastrar no banco nas Taxas Subsidiadas ("Copiar Taxa Banco"). */
export function taxaBancoCopiar(prazo: number, t: Pick<TabelasNovos, "taxaBotao">): number | null {
  return t.taxaBotao[String(prazo)] ?? null;
}

// Brabus Intelligence — montagem de ofertas e cálculo reverso.
// Junta os planos dos simuladores numa lista única de opções comparáveis e
// resolve "qual a menor entrada para caber na parcela X".

import * as N from "./novos.ts";
import * as S from "./seminovos.ts";

export type Periodicidade = "mensal" | "semestral" | "anual" | "unica";

export type Opcao = {
  plano: string;            // ex.: "LINEAR", "BALAO", "TAXA_SUBSIDIADA", "COPARTICIPADO"
  plano_nome: string;       // nome como aparece no Portal
  prazo: number;
  periodicidade: Periodicidade;
  qtd_pagamentos: number;
  entrada: number;
  financiado: number;
  taxa_tabela: number | null;  // taxa a.m. da tabela do simulador (null quando o plano não expõe)
  parcela: number;
  // Campos da concessionária: visíveis a todos os perfis com acesso ao simulador (a tela do Portal também mostra o rebate)
  rebate_concessionaria?: number | null;
  valor_final_venda?: number | null;
  // Plano Balão: SEMPRE com balão (não existe Plano Balão sem balão)
  estrutura_baloes?: string;
  aceitacao?: number;
  baloes?: { mes: number; valor: number }[];
  total_baloes?: number;
  limite_baloes?: number;
};

/** Limite de balões por contrato no Portal: Novos até 4, Seminovos até 2. */
export const MAX_BALOES_NOVOS = 4;
export const MAX_BALOES_SEMI = 2;

export type ModoBalao = "preferidas" | "ate_2_baloes" | "todas";
export type EstruturaBalao = { prazo: number; meses: number[]; nome: string; aceitacao: number };

/**
 * Catálogo de estruturas de balão (inteligência comercial do Grupo, out/2026):
 * o que mais vende é 1 balão só. Mais de 2 balões é difícil de vender.
 *  aceitação 1..4 = as campeãs de venda (ordem de preferência do cliente)
 *  aceitação 5..6 = 2 balões (só quando o cliente aceita/pede)
 *  aceitação 9    = 3-4 balões / outros prazos (só se pedirem explicitamente)
 */
export const BALAO_PREFERIDAS: EstruturaBalao[] = [
  { prazo: 48, meses: [48], nome: "48x com balão na última parcela", aceitacao: 1 },
  { prazo: 48, meses: [36], nome: "48x com balão na 36ª parcela", aceitacao: 2 },
  { prazo: 36, meses: [36], nome: "36x com balão na última parcela", aceitacao: 3 },
  { prazo: 36, meses: [24], nome: "36x com balão na 24ª parcela", aceitacao: 4 },
];
export const BALAO_DOIS: EstruturaBalao[] = [
  { prazo: 48, meses: [24, 48], nome: "48x com 2 balões (24ª e 48ª)", aceitacao: 5 },
  { prazo: 36, meses: [18, 36], nome: "36x com 2 balões (18ª e 36ª)", aceitacao: 6 },
];

export function estruturasBalao(modo: ModoBalao, prazos: number[], maxQtd: number): EstruturaBalao[] {
  let out = [...BALAO_PREFERIDAS];
  if (modo !== "preferidas" && maxQtd >= 2) out.push(...BALAO_DOIS);
  if (modo === "todas") {
    for (const p of prazos) {
      const cand: EstruturaBalao[] = [{ prazo: p, meses: [p], nome: `${p}x com balão na última parcela`, aceitacao: 9 }];
      if (maxQtd >= 2 && p >= 12) cand.push({ prazo: p, meses: [Math.round(p / 2), p], nome: `${p}x com 2 balões (${Math.round(p / 2)}ª e ${p}ª)`, aceitacao: 9 });
      if (maxQtd >= 3 && p > 24) {
        const m: number[] = []; for (let k = 12; k < p; k += 12) m.push(k); m.push(p);
        const ms = m.slice(-maxQtd);
        if (ms.length >= 3) cand.push({ prazo: p, meses: ms, nome: `${p}x com ${ms.length} balões anuais`, aceitacao: 9 });
      }
      for (const c of cand) if (!out.some((o) => o.prazo === c.prazo && o.meses.join() === c.meses.join())) out.push(c);
    }
  }
  return out.filter((e) => prazos.includes(e.prazo) && e.meses.length <= maxQtd);
}

/** Divide o total em balões iguais em reais inteiros (nunca passa do limite). */
export function divideBaloes(limite: number, meses: number[]): { mes: number; valor: number }[] {
  const cada = Math.floor(limite / meses.length);
  return cada > 0 ? meses.map((mes) => ({ mes, valor: cada })) : [];
}

export function normalizaModelo(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

/** Casa "Eclipse Cross" + "HPE" com um nome das tabelas por igualdade normalizada. */
export function casaModelo(modelo: string, versao: string | null, nomes: string[]): string | null {
  const alvo = normalizaModelo(`${modelo} ${versao ?? ""}`);
  return nomes.find((n) => normalizaModelo(n) === alvo) ?? null;
}

export type ContextoNovo = {
  tipo: "novo"; modelo: string; versao: string | null; valor: number; tabelas: N.TabelasNovos;
};
export type ContextoSeminovo = {
  tipo: "seminovo"; modelo: string; versao: string | null; ano: number; valor: number; tabelas: S.TabelasSeminovos;
};
export type Contexto = ContextoNovo | ContextoSeminovo;

const ok = <T>(r: T | { erro: string }): r is T => !(r && typeof r === "object" && "erro" in (r as object));

/** Todas as opções calculáveis para uma entrada. Planos inelegíveis simplesmente não aparecem. */
export const opcoesParaEntradaBase = (c: Contexto, entrada: number, modo: ModoBalao = "preferidas", so?: EstruturaBalao[]) => opcoesParaEntrada(c, entrada, modo, so);
export function opcoesParaEntrada(c: Contexto, entrada: number, modo: ModoBalao = "preferidas", so?: EstruturaBalao[]): Opcao[] {
  const out: Opcao[] = [];
  const v = c.valor;
  if (c.tipo === "novo") {
    const t = c.tabelas;
    const lin = N.linear(v, entrada, t);
    if (ok(lin)) for (const it of lin.itens) if (it.parcela) out.push(op("LINEAR", "Financiamento Linear", it.prazo, "mensal", it.prazo, entrada, lin.financiado, it.taxa, it.parcela));
    for (const e of so ?? estruturasBalao(modo, N.PRAZOS_BALAO, MAX_BALOES_NOVOS)) {
      const base = N.balaoTradicional(v, entrada, e.prazo, [], t);
      if (!ok(base)) continue;
      const bs = divideBaloes(base.limiteBaloes, e.meses);
      if (!bs.length) continue;
      const b = N.balaoTradicional(v, entrada, e.prazo, bs, t);
      if (ok(b)) out.push(opBalao(`Plano Balão — ${e.nome}`, e, entrada, b, bs));
    }
    for (const p of N.PRAZOS_PERIODICO) for (const tipo of ["semestral", "anual"] as const) {
      const s = N.semestralAnual(v, entrada, p, tipo, t);
      if (ok(s)) out.push(op("SEMESTRAL_ANUAL", `Plano Balão ${tipo === "semestral" ? "Semestral" : "Anual"}`, p, tipo, s.meses.length, entrada, s.financiado, s.taxa, s.parcela));
    }
    const pu = N.parcelaUnica(v, entrada);
    if (ok(pu)) out.push(op("PARCELA_UNICA", "Parcela Única (mês 25)", 25, "unica", 1, entrada, pu.financiado, pu.taxa, pu.parcela));
    const sub = N.taxasSubsidiadas(v, entrada, 0, t);
    if (ok(sub)) for (const l of sub.linhas) {
      out.push({ ...op("TAXA_SUBSIDIADA", `Taxa Subsidiada ${(l.taxa * 100).toFixed(2).replace(".", ",")}%`, l.prazo, "mensal", l.prazo, entrada, sub.financiado, l.taxa, l.parcela), rebate_concessionaria: l.rebateValor, valor_final_venda: l.valorFinalVenda });
    }
    const nomeCopart = casaModelo(c.modelo, c.versao, t.copartModels.map((m) => m.name));
    if (nomeCopart) {
      const cp = N.coparticipado(nomeCopart, v, entrada, t);
      if (ok(cp)) for (const x of cp.termos) if (x.parcela) {
        out.push({ ...op("COPARTICIPADO", "Plano Coparticipado", x.prazo, "mensal", x.prazo, entrada, cp.financiado, x.taxa, x.parcela), rebate_concessionaria: cp.rebateBrabus, valor_final_venda: cp.valorFinalVenda });
      }
    }
  } else {
    const t = c.tabelas;
    const lin = S.linearSeminovo(c.ano, v, entrada, t);
    if (ok(lin)) for (const it of lin.itens) if (it.parcela) out.push(op("LINEAR", "Financiamento Linear Seminovos", it.prazo, "mensal", it.prazo, entrada, lin.financiado, it.taxa, it.parcela));
    for (const e of so ?? estruturasBalao(modo, S.PRAZOS_BALAO_SEMI, MAX_BALOES_SEMI)) {
      const base = S.balaoSeminovo(v, entrada, c.ano, e.prazo, [], t);
      if (!ok(base)) continue;
      const bs = divideBaloes(base.limiteBaloes, e.meses);
      if (!bs.length) continue;
      const b = S.balaoSeminovo(v, entrada, c.ano, e.prazo, bs, t);
      if (ok(b)) out.push(opBalao(`Plano Balão Seminovos — ${e.nome}`, e, entrada, b, bs));
    }
  }
  return out;
}

/** Semestral Triton/Outlander tem entrada fixa: entra à parte. */
export function opcaoSemestralTriton(c: ContextoNovo): Opcao | null {
  const nome = casaModelo(c.modelo, c.versao, Object.keys(c.tabelas.semestralModelos));
  if (!nome) return null;
  const r = N.semestralTritonOutlander(nome, c.valor, c.tabelas);
  if (!ok(r)) return null;
  return { ...op("SEMESTRAL_TAXA_ZERO", "Semestral Triton/Outlander Taxa 0%", 24, "semestral", 4, r.entrada, r.financiado, 0, r.parcela), rebate_concessionaria: r.rebateBrabus, valor_final_venda: r.valorFinalVenda };
}

function op(plano: string, nome: string, prazo: number, per: Periodicidade, qtd: number, entrada: number, fin: number, taxa: number | null, parcela: number): Opcao {
  return { plano, plano_nome: nome, prazo, periodicidade: per, qtd_pagamentos: qtd, entrada, financiado: fin, taxa_tabela: taxa, parcela };
}

function opBalao(nome: string, e: EstruturaBalao, entrada: number,
  b: { financiado: number; taxa: number; parcela: number; totalBaloes: number; limiteBaloes: number }, baloes: { mes: number; valor: number }[]): Opcao {
  return { ...op("BALAO", nome, e.prazo, "mensal", e.prazo, entrada, b.financiado, b.taxa, b.parcela),
    estrutura_baloes: e.nome, aceitacao: e.aceitacao, baloes, total_baloes: b.totalBaloes, limite_baloes: b.limiteBaloes };
}

const chave = (o: Opcao) => `${o.plano_nome}|${o.prazo}|${o.periodicidade}`;

export type OpcaoEntradaMinima = Opcao & { entrada_minima_necessaria: number };

/**
 * Para cada plano mensal × prazo (entrada até 95% do valor), a menor entrada (em centavos, arredondada para cima)
 * que faz a parcela ficar ≤ alvo. A parcela é não-crescente na entrada em todos os planos
 * (financiado menor e faixa de taxa igual ou melhor), então a busca binária é válida.
 */
export function entradaMinimaParaParcela(c: Contexto, parcelaAlvo: number, planos: string[] | null = null, modo: ModoBalao = "preferidas", so?: EstruturaBalao[]): { opcoes: OpcaoEntradaMinima[]; mais_proxima: Opcao | null } {
  const permitido = (o: Opcao) => !planos || planos.includes(o.plano);
  const opcoesParaEntrada = (cc: Contexto, e: number) => opcoesParaEntradaBase(cc, e, modo, so);
  const v = c.valor;
  const chaves = new Set<string>();
  for (let e = 0; e <= v * 0.95; e += v * 0.05) opcoesParaEntrada(c, e).filter((o) => o.periodicidade === "mensal" && permitido(o)).forEach((o) => chaves.add(chave(o)));
  const resultado: OpcaoEntradaMinima[] = [];
  for (const k of chaves) {
    const avalia = (e: number) => opcoesParaEntrada(c, e).find((o) => chave(o) === k) ?? null;
    // limite inferior: menor entrada (passos de 1%, refinada a centavos) em que o plano existe
    let lo = -1;
    for (let p = 0; p <= 95; p++) { if (avalia(v * p / 100)) { lo = v * p / 100; break; } }
    if (lo < 0) continue;
    if (lo > 0) {
      let a0 = lo - v / 100, b0 = lo;
      while (b0 - a0 > 0.01) { const m = (a0 + b0) / 2; if (avalia(m)) b0 = m; else a0 = m; }
      lo = Math.ceil(b0 * 100) / 100;
    }
    const noLo = avalia(lo);
    if (noLo && noLo.parcela <= parcelaAlvo) { resultado.push({ ...noLo, entrada_minima_necessaria: lo }); continue; }
    // limite superior: maior entrada (até 95%) em que o plano ainda existe
    let hi = -1;
    for (let p = 95; p * v / 100 > lo; p--) { if (avalia(v * p / 100)) { hi = v * p / 100; break; } }
    if (hi < 0) continue;
    const noHi = avalia(hi);
    if (!noHi || noHi.parcela > parcelaAlvo) continue;
    // busca binária até 1 centavo
    let a = lo, b = hi;
    while (b - a > 0.01) {
      const m = (a + b) / 2;
      const o = avalia(m);
      if (o && o.parcela <= parcelaAlvo) b = m; else a = m;
    }
    const entrada = Math.ceil(b * 100) / 100;
    const o = avalia(entrada);
    if (o && o.parcela <= parcelaAlvo + 1e-9) resultado.push({ ...o, entrada_minima_necessaria: entrada });
  }
  resultado.sort((x, y) => x.entrada_minima_necessaria - y.entrada_minima_necessaria || x.parcela - y.parcela);
  let mais_proxima: Opcao | null = null;
  if (!resultado.length) {
    // ninguém chega no alvo: mostra a menor parcela possível (entrada máxima testada em 95%)
    const todas = opcoesParaEntrada(c, v * 0.95).filter((o) => o.periodicidade === "mensal" && permitido(o));
    mais_proxima = todas.sort((a, b) => a.parcela - b.parcela)[0] ?? null;
  }
  return { opcoes: resultado, mais_proxima };
}

// Comparativo de resultados no tempo (ferramenta comparar_periodos) — 15/10/2026.
//
// Regras (pedido do Luis):
// - Comparação JUSTA: período atual incompleto (ex.: 01–15/10) é comparado com o MESMO trecho do período anterior
//   (01–15/09). O mês anterior inteiro aparece só como "referência", nunca como base da variação.
// - Intervalos de tamanhos diferentes: a variação fica "—" (nunca concluir "subiu/caiu").
// - Mês a mês: uma coluna por mês (até 12); o mês em andamento aparece como parcial e fica fora de melhor/pior.
// - Escopo: grupo, loja, departamento, modelo (um ao longo do tempo, ou vários lado a lado) e vendedor.
// Funções puras: recebem as linhas já devolvidas pelo banco e montam a saída e o cartão.

import { ehPseudoLoja, normalizaLoja } from "../data/lojas_periodos.ts";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dt = (s: string) => new Date(s + "T00:00:00Z");
export const addDias = (s: string, n: number) => { const x = dt(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
/** Soma meses mantendo o dia; se o dia não existir no mês de destino, usa o último dia (31/10 − 1 mês = 30/09). */
export const addMeses = (s: string, n: number) => {
  const x = dt(s); const dia = x.getUTCDate();
  x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const ult = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(dia, ult));
  return iso(x);
};
const fimDoMes = (s: string) => iso(new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)));
const inicioDoMes = (s: string) => `${s.slice(0, 8)}01`;
export const br = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const brCurto = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
const dias = (a: string, b: string) => Math.round((dt(b).getTime() - dt(a).getTime()) / 86400000) + 1;
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const nomeMes = (s: string) => `${MESES[+s.slice(5, 7) - 1]}/${s.slice(2, 4)}`;
const valida = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && iso(dt(x)) === x;

export type Papel = "atual" | "base" | "referencia" | "mes" | "intervalo";
export type Coluna = { id: string; rotulo: string; inicio: string; fim: string; datas: string; papel: Papel; parcial: boolean; dias: number };

export class ErroPeriodos extends Error {}

function coluna(id: string, rotulo: string, inicio: string, fim: string, papel: Papel, parcial = false): Coluna {
  return { id, rotulo, inicio, fim, datas: `${br(inicio)} a ${br(fim)}`, papel, parcial, dias: dias(inicio, fim) };
}

/**
 * Planeja as colunas do comparativo.
 * - atual_vs_anterior: [base comparável, atual, (referência = mês anterior inteiro, só se o atual for parcial)];
 *   sem datas = mês atual até hoje; com datas dentro de um mês (ex.: 01–15/10) = o mesmo trecho do mês anterior.
 * - mes_a_mes: os últimos N meses (2 a 12), o atual parcial até hoje.
 * - intervalos: 2 a 6 intervalos livres, em ordem de data.
 */
export function planejaColunas(modo: string, hoje: string, a: { meses?: number | null; data_inicio?: string | null; data_fim?: string | null; intervalos?: { inicio: string; fim: string }[] | null }): Coluna[] {
  if (modo === "atual_vs_anterior" || modo === "modelos") {
    let ini = a.data_inicio ?? null, fim = a.data_fim ?? null;
    if (ini == null) { ini = inicioDoMes(hoje); fim = hoje; }
    if (fim == null || fim === "") fim = hoje;
    if (!valida(ini) || !valida(fim)) throw new ErroPeriodos("Datas inválidas: use AAAA-MM-DD.");
    if (fim < ini) throw new ErroPeriodos("A data final é anterior à inicial.");
    if (fim > hoje) fim = hoje;
    const atual = coluna("atual", ini.slice(0, 7) === fim.slice(0, 7) && ini.slice(8) === "01" ? nomeMes(ini) : "Atual", ini, fim, "atual");
    if (modo === "modelos") return [atual];
    const mesmoMes = ini.slice(0, 7) === fim.slice(0, 7);
    let base: Coluna;
    if (mesmoMes) {
      // mesmo trecho do mês anterior (01–15/10 → 01–15/09; 01–31/10 → 01–30/09)
      const bIni = addMeses(ini, -1);
      const bFim = fim === fimDoMes(fim) ? fimDoMes(addMeses(inicioDoMes(fim), -1)) : addMeses(fim, -1);
      base = coluna("base", nomeMes(bIni), bIni, bFim, "base");
    } else {
      // intervalo que atravessa meses: mesmo tamanho, imediatamente antes
      const n = dias(ini, fim);
      base = coluna("base", "Anterior", addDias(ini, -n), addDias(ini, -1), "base");
    }
    const cols = [base, atual];
    // atual parcial dentro de um mês: o mês anterior inteiro entra só como referência
    if (mesmoMes && fim < fimDoMes(fim)) {
      atual.parcial = true;
      const rIni = inicioDoMes(addMeses(inicioDoMes(ini), -1));
      const rFim = fimDoMes(rIni);
      if (!(base.inicio === rIni && base.fim === rFim)) cols.push(coluna("referencia", `${nomeMes(rIni)} inteiro`, rIni, rFim, "referencia"));
    }
    return cols;
  }
  if (modo === "mes_a_mes") {
    const n = Math.max(2, Math.min(12, Number(a.meses) || 6));
    const cols: Coluna[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const ini = inicioDoMes(addMeses(inicioDoMes(hoje), -i));
      const fimM = fimDoMes(ini);
      const fim = fimM > hoje ? hoje : fimM;
      cols.push(coluna(`m${n - i}`, nomeMes(ini), ini, fim, "mes", fim < fimM));
    }
    return cols;
  }
  if (modo === "intervalos") {
    const xs = (a.intervalos ?? []).filter(Boolean);
    if (xs.length < 2 || xs.length > 6) throw new ErroPeriodos("Informe de 2 a 6 intervalos.");
    const cols = xs.map((x, i) => {
      if (!valida(x.inicio) || !valida(x.fim)) throw new ErroPeriodos("Datas inválidas: use AAAA-MM-DD.");
      if (x.fim < x.inicio) throw new ErroPeriodos("Um intervalo tem data final anterior à inicial.");
      const fim = x.fim > hoje ? hoje : x.fim;
      return coluna(`i${i + 1}`, `${brCurto(x.inicio)}–${brCurto(fim)}`, x.inicio, fim, "intervalo");
    }).sort((x, y) => x.inicio.localeCompare(y.inicio));
    return cols;
  }
  throw new ErroPeriodos(`Modo desconhecido: ${modo}`);
}

// ---------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------
export type Acc = { vendidos: number; financiados: number; producao: number; spf_qtd: number; spf_valor: number; retorno: number; retorno_oculto: boolean; oculto_vendedor: boolean; tem_retorno_loja: boolean; linhas: number };
const novoAcc = (): Acc => ({ vendidos: 0, financiados: 0, producao: 0, spf_qtd: 0, spf_valor: 0, retorno: 0, retorno_oculto: false, oculto_vendedor: false, tem_retorno_loja: false, linhas: 0 });

const semAcento = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();
/** Nome do vendedor casa por todas as palavras digitadas (ex.: "joao silva" casa "JOÃO CARLOS SILVA"). */
export function casaVendedor(nome: string, pedido: string): boolean {
  const n = semAcento(nome), ps = semAcento(pedido).split(/\s+/).filter(Boolean);
  return ps.length > 0 && ps.every((p) => n.includes(p));
}

export type Escopo = { loja: string | null; departamento: string | null; vendedor: string | null };

/** Soma as linhas de operational_metrics (por vendedor × loja × departamento) dentro do escopo. */
export function agregaMetricas(rows: any[] | null | undefined, e: Escopo): Acc {
  const a = novoAcc();
  for (const x of rows ?? []) {
    if (ehPseudoLoja(x.store)) continue;
    if (e.loja && normalizaLoja(x.store) !== e.loja) continue;
    if (e.departamento && String(x.department ?? "").toUpperCase() !== e.departamento) continue;
    if (e.vendedor && (x.seller_id == null || !casaVendedor(x.seller_name, e.vendedor))) continue;
    somaLinha(a, x);
  }
  return a;
}

/** Soma as linhas de operational_model_metrics (por modelo × loja × departamento) de um modelo. */
export function agregaModelo(rows: any[] | null | undefined, e: Escopo, casaModelo: (m: string) => boolean): Acc {
  const a = novoAcc();
  for (const x of rows ?? []) {
    if (ehPseudoLoja(x.store)) continue;
    if (e.loja && normalizaLoja(x.store) !== e.loja) continue;
    if (e.departamento && String(x.department ?? "").toUpperCase() !== e.departamento) continue;
    if (!casaModelo(String(x.model ?? ""))) continue;
    somaLinha(a, x);
  }
  return a;
}

function somaLinha(a: Acc, x: any) {
  a.linhas++;
  a.vendidos += Number(x.sold_count) || 0;
  a.financiados += Number(x.financed_count) || 0;
  a.producao += Number(x.production_value) || 0;
  a.spf_qtd += Number(x.spf_count) || 0;
  a.spf_valor += Number(x.spf_value) || 0;
  // Retorno oculto (perfil sem retorno, ou vendedor de outra loja para analista/gerente): o retorno dessa linha não veio.
  // O total da loja continua válido quando o servidor manda a linha 'RETORNO DA LOJA' (somente_retorno) do mesmo escopo.
  if (x.somente_retorno === true) a.tem_retorno_loja = true;
  else if (x.retorno_oculto === true || !Object.prototype.hasOwnProperty.call(x, "return_value")) a.oculto_vendedor = true;
  a.retorno += Number(x.return_value) || 0;
  a.retorno_oculto = a.oculto_vendedor && !a.tem_retorno_loja;
}

// ---------------------------------------------------------------------
// Indicadores, variações e cartão
// ---------------------------------------------------------------------
export type Formato = "int" | "brl" | "pct";
type Ind = { indicador: string; rotulo: string; formato: Formato; varFormato: "pct" | "pp"; valor: (a: Acc) => number | null };
const r2 = (v: number) => Math.round(v * 100) / 100;

export function indicadoresDisponiveis(veRetorno: boolean): Ind[] {
  const xs: Ind[] = [
    { indicador: "vendidos", rotulo: "Vendidos", formato: "int", varFormato: "pct", valor: (a) => a.vendidos },
    { indicador: "financiados", rotulo: "Financiados", formato: "int", varFormato: "pct", valor: (a) => a.financiados },
    { indicador: "share_pct", rotulo: "Share", formato: "pct", varFormato: "pp", valor: (a) => a.vendidos ? r2(a.financiados / a.vendidos * 100) : null },
    { indicador: "producao", rotulo: "Produção", formato: "brl", varFormato: "pct", valor: (a) => r2(a.producao) },
    // SPF = QUANTIDADE de SPF vendidos (o mesmo número da Análise Geral e do Score); o texto deve dizer "N SPF".
    { indicador: "spf_qtd", rotulo: "SPF (qtd)", formato: "int", varFormato: "pct", valor: (a) => a.spf_qtd },
  ];
  if (veRetorno) xs.push({ indicador: "retorno", rotulo: "Retorno", formato: "brl", varFormato: "pct", valor: (a) => a.retorno_oculto ? null : r2(a.retorno) });
  return xs;
}

function variacao(atual: number | null, base: number | null, f: "pct" | "pp"): number | null {
  if (atual == null || base == null) return null;
  if (f === "pp") return r2(atual - base);
  if (base === 0) return null; // sem base → "—"
  return r2((atual - base) / base * 100);
}

export type LinhaCartao = {
  indicador: string; rotulo: string; formato: Formato; valores: (number | null)[];
  variacao: number | null; variacao_formato: "pct" | "pp";
  /** Base zero (15/10/2026, pedido do Luis): sem %, mostra a diferença absoluta "0 → 5 (+5)". */
  base_zero: { de: number; para: number; diferenca: number } | null;
  melhor: number | null; pior: number | null;
};

/**
 * Monta as linhas do cartão. A variação compara SEMPRE duas colunas de mesmo tamanho:
 * - atual_vs_anterior: atual × base (mesmo trecho) — a referência nunca entra na variação;
 * - mes_a_mes: último mês completo × o anterior (o parcial fica fora), melhor/pior só entre meses completos;
 * - intervalos: último × penúltimo, só se tiverem o mesmo número de dias (senão "—").
 */
export function montaLinhas(modo: string, cols: Coluna[], accs: Acc[], veRetorno: boolean): { linhas: LinhaCartao[]; comparacao: { atual: number; base: number } | null; tamanhos_diferentes: boolean } {
  let par: { atual: number; base: number } | null = null;
  let tamanhosDiferentes = false;
  if (modo === "atual_vs_anterior") {
    par = { atual: cols.findIndex((c) => c.papel === "atual"), base: cols.findIndex((c) => c.papel === "base") };
  } else if (modo === "mes_a_mes") {
    const completos = cols.map((c, i) => (c.parcial ? -1 : i)).filter((i) => i >= 0);
    if (completos.length >= 2) par = { atual: completos[completos.length - 1], base: completos[completos.length - 2] };
  } else if (modo === "intervalos" && cols.length >= 2) {
    const a = cols.length - 1, b = cols.length - 2;
    if (cols[a].dias === cols[b].dias) par = { atual: a, base: b }; else tamanhosDiferentes = true;
  }
  const linhas = indicadoresDisponiveis(veRetorno).map((ind) => {
    const valores = accs.map((acc) => ind.valor(acc));
    let melhor: number | null = null, pior: number | null = null;
    if (modo === "mes_a_mes") {
      const cand = cols.map((c, i) => ({ i, v: valores[i] })).filter((x) => !cols[x.i].parcial && x.v != null) as { i: number; v: number }[];
      if (cand.length >= 2) {
        const max = Math.max(...cand.map((x) => x.v)), min = Math.min(...cand.map((x) => x.v));
        if (max !== min) { melhor = cand.filter((x) => x.v === max).pop()!.i; pior = cand.filter((x) => x.v === min).pop()!.i; }
      }
    }
    return {
      indicador: ind.indicador, rotulo: ind.rotulo, formato: ind.formato, valores,
      variacao: par ? variacao(valores[par.atual], valores[par.base], ind.varFormato) : null,
      base_zero: par && ind.varFormato === "pct" && valores[par.base] === 0 && valores[par.atual] != null && valores[par.atual] !== 0
        ? { de: 0, para: valores[par.atual]!, diferenca: r2(valores[par.atual]!) } : null,
      variacao_formato: ind.varFormato, melhor, pior,
    };
  });
  return { linhas, comparacao: par, tamanhos_diferentes: tamanhosDiferentes };
}

/** Texto das datas da comparação (sempre com as datas; nunca "período anterior comparável" sem datas). */
export function textoComparacao(modo: string, cols: Coluna[], par: { atual: number; base: number } | null, tamanhosDiferentes: boolean): string {
  if (par) {
    const a = cols[par.atual], b = cols[par.base];
    const tipo = modo === "atual_vs_anterior" && a.parcial ? " (mesmo trecho do mês anterior)" : modo === "mes_a_mes" ? " (último mês completo × anterior)" : "";
    return `Variação: ${a.datas} × ${b.datas}${tipo}.`;
  }
  if (tamanhosDiferentes) return "Sem variação: os períodos têm tamanhos diferentes (compare os números de cada um, não a diferença).";
  return "Sem variação: não há dois períodos completos de mesmo tamanho para comparar.";
}

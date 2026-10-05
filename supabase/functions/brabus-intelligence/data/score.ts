import { createHash } from "node:crypto";
import { normalizaLoja } from "./lojas_periodos.ts";
// Score de vendedores — mesma fórmula da tela "Análise de Score" (modules/score.html, calcScores),
// aplicada sobre operational_score_coparticipated_data. Não existe RPC de score pronto.

export const SCORE_WEIGHTS: Record<string, Record<string, number>> = {
  Novos: { volume: 250, share: 230, familias: 130, planos: 130, spf: 100, retorno: 160 },
  Seminovos: { volume: 300, share: 270, spf: 150, retorno: 280 },
};
const MIX_PLANOS = new Set(["LINEAR", "BALÃO", "COPARTICIPADO", "SUBSIDIADO"]);
// Vendedores excluídos do Score na própria tela do Portal.
// Exclusion list kept as SHA-256 (hex, UTF-8) of the normalized name — no names in the code.
const EXCLUIDOS_SHA256 = new Set([
  "41ea3dce7a160a26005022aa1b43d67e7bb56ae72198bfce5fa4586c9b56e688",
  "cef0c08f261fec77990768b9ac068064f7b71f8b28a51b0558b8f59b0428f75b",
  "e0b71f218ecf3dfb0f1d44fd105c8c644690d01857287470934948c2ddf3acc3",
  "edfa93c6acc65d5428f2d3d79fb328841bd4873e4b4ff726167730fe2c273582",
  "900bfd377956f1e350f3000a26dc42ead1105986db7e15ad8615fe0dfe5f8b0f",
  "0a41b9899c5f5b1bd79b8291eec45a6b9cc3b2abeebd5f5e64a76555efbb5d75",
  "9791374b4cce10e2d1c1ec87b09e9f59e5faf2dc8c957729159eec0b4c02068d",
  "4f15e0f6a6bd30a4c3a883e9c6e2f7a2695e23c2a22ba6fa47acd51588099589",
  "66fe8414df0cd5ab9aa5ecc37ccd4b6f7a8ce1b5416f512167d2de9e72d3eb6a",
]);
const excluido = (n: string) => EXCLUIDOS_SHA256.has(createHash("sha256").update(n).digest("hex"));

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
const familia = (m: string) => { const x = norm(m); return x.includes("OUTLANDER") ? "Outlander" : (x.includes("TRITON") || x.includes("L200")) ? "Triton" : x.includes("ECLIPSE") ? "Eclipse Cross" : "Outros"; };
const dept = (v: unknown) => norm(v) === "SEMINOVOS" ? "Seminovos" : "Novos";

export function faixaScore(s: number): string {
  if (s >= 900) return "Excelência";
  if (s >= 800) return "Alto";
  if (s >= 650) return "Bom";
  if (s >= 400) return "Em desenvolvimento";
  return "Baixo";
}

export type LinhaScore = {
  vendedor: string; loja: string; departamento: string; score: number; faixa: string;
  vendas: number; financiados: number; share: number; retorno_medio: number; spf_qtd: number;
  plano_mais_vendido: string;
  composicao: { item: string; pontos: number; maximo: number; detalhe: string }[];
};

export function calculaScores(
  payload: { sales?: any[]; finance?: any[] }, inicio: string, fim: string, loja: string | null, departamento: "Novos" | "Seminovos" | null,
): LinhaScore[] {
  const dentro = (d: string) => d && d.slice(0, 10) >= inicio && d.slice(0, 10) <= fim;
  const elegivel = (nome: string) => { const n = norm(nome); return !!n && n !== "NAO LOCALIZADO" && !excluido(n); };
  const filtra = (r: any) => dentro(r.date) && elegivel(r.seller) && (!loja || (normalizaLoja(r.store) ?? norm(r.store)) === norm(loja)) && (!departamento || dept(r.department) === departamento);
  const sales = (payload.sales ?? []).filter(filtra);
  const fins = (payload.finance ?? []).filter(filtra);

  type Acc = { vendedor: string; loja: string; dept: string; vendas: number; fin: number; producao: number; retorno: number; spfQtd: number; familias: Set<string>; plans: Set<string>; planCounts: Record<string, number> };
  const by: Record<string, Acc> = {};
  const get = (r: any): Acc => {
    const k = `${r.seller}|${r.store}|${dept(r.department)}`;
    return by[k] ??= { vendedor: r.seller, loja: r.store, dept: dept(r.department), vendas: 0, fin: 0, producao: 0, retorno: 0, spfQtd: 0, familias: new Set(), plans: new Set(), planCounts: {} };
  };
  for (const s of sales) { const o = get(s); o.vendas++; if (o.dept === "Novos") o.familias.add(familia(s.model)); }
  for (const f of fins) {
    const o = get(f);
    const plano = f.plan || "LINEAR";
    o.fin++; o.producao += Number(f.financed_value) || 0;
    o.retorno += (Number(f.return_value) || 0) + (Number(f.spf_value) || 0);
    o.spfQtd += Number(f.spf_count) || 0;
    o.plans.add(plano); o.planCounts[plano] = (o.planCounts[plano] || 0) + 1;
  }
  const all = Object.values(by);
  const maxVenda: Record<string, number> = {
    Novos: Math.max(1, ...all.filter((x) => x.dept === "Novos").map((x) => x.vendas)),
    Seminovos: Math.max(1, ...all.filter((x) => x.dept === "Seminovos").map((x) => x.vendas)),
  };
  return all.map((o) => {
    const w = SCORE_WEIGHTS[o.dept] ?? SCORE_WEIGHTS.Seminovos;
    const share = o.vendas ? o.fin / o.vendas : 0;
    const ret = o.producao ? o.retorno / o.producao : 0;
    const volume = Math.min(1, o.vendas / (maxVenda[o.dept] || 1));
    const spfRate = o.fin ? o.spfQtd / o.fin : 0;
    const confVendas = Math.min(1, o.vendas / 4);
    const confFin = Math.min(1, o.fin / 2);
    const comp: LinhaScore["composicao"] = [];
    let score = 0;
    const add = (item: string, pts: number, max: number, detalhe: string) => { comp.push({ item, pontos: Math.round(pts), maximo: max, detalhe }); score += pts; };
    add("Volume de vendas", w.volume * volume, w.volume, `${o.vendas} venda(s); referência ${maxVenda[o.dept]}`);
    add("Penetração de financiamento", w.share * Math.min(1, share / 0.6) * confVendas, w.share, `${o.fin} financiado(s) / ${o.vendas} venda(s)`);
    if (o.dept === "Novos") {
      add("Mix de famílias vendidas", w.familias * Math.min(1, o.familias.size / 3), w.familias, `${o.familias.size} de 3 famílias`);
      const validos = [...o.plans].filter((p) => MIX_PLANOS.has(p)).length;
      add("Mix de planos", w.planos * Math.min(1, validos / MIX_PLANOS.size), w.planos, `${validos} de ${MIX_PLANOS.size} planos comerciais`);
    }
    add("SPF EXTRA", w.spf * Math.min(1, spfRate) * confFin, w.spf, `${o.spfQtd} SPF / ${o.fin} financiamento(s)`);
    add("Retorno médio", w.retorno * Math.min(1, ret / 0.08) * confFin, w.retorno, `retorno médio sobre produção`);
    const final = Math.round(Math.max(0, Math.min(1000, score)));
    return {
      vendedor: o.vendedor, loja: o.loja, departamento: o.dept, score: final, faixa: faixaScore(final),
      vendas: o.vendas, financiados: o.fin, share, retorno_medio: ret, spf_qtd: o.spfQtd,
      plano_mais_vendido: Object.entries(o.planCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—",
      composicao: comp,
    };
  }).sort((a, b) => b.score - a.score || b.financiados - a.financiados);
}

// =====================================================================
// UTILIZAÇÃO + CONVERSÃO (Score V2, regra comercial aprovada por Luis)
// Critério à parte (0–100) mostrado no detalhamento da tela de Score do V2;
// NÃO entra no Score Oficial nem no ranking. Fonte: RPC score_utilization_conversion_scope_data.
//   V = 0                 → 0 (sem oportunidade registrada)
//   S > 0, V > 0, F > 0   → Conversão 70·min(1, F/V) + Utilização 30·min(1, S/(2V))
//   demais combinações    → 0 (utilização sem financiamento / atenção / financiou sem utilizar)
// =====================================================================
export const INICIO_TELEMETRIA = "2026-08-17";

export type UtilConv = {
  disponivel: boolean; motivo?: string; pontos?: number; maximo: 100; conversao?: number; utilizacao?: number;
  status?: string; simulacoes?: number; vendas?: number; financiados?: number;
};

const ROTULO_STATUS: Record<string, string> = {
  CONVERSAO_COM_UTILIZACAO: "Conversão com utilização",
  UTILIZACAO_SEM_FINANCIAMENTO: "Simulou mas não financiou",
  ATENCAO: "Atenção: vendeu sem simular e sem financiar",
  FINANCIOU_SEM_UTILIZAR: "Financiou sem usar o simulador",
  SEM_OPORTUNIDADE_REGISTRADA: "Sem vendas no período",
};

export function classificaUtilConv(S: number, V: number, F: number): UtilConv {
  const base = { disponivel: true, maximo: 100 as const, simulacoes: S, vendas: V, financiados: F };
  if (V === 0) return { ...base, pontos: 0, conversao: 0, utilizacao: 0, status: ROTULO_STATUS.SEM_OPORTUNIDADE_REGISTRADA };
  if (S > 0 && F > 0) {
    const c = 70 * Math.min(1, F / V), u = 30 * Math.min(1, S / (2 * V));
    return { ...base, pontos: Math.round((c + u) * 10) / 10, conversao: Math.round(c * 10) / 10, utilizacao: Math.round(u * 10) / 10, status: ROTULO_STATUS.CONVERSAO_COM_UTILIZACAO };
  }
  const st = S > 0 ? "UTILIZACAO_SEM_FINANCIAMENTO" : F === 0 ? "ATENCAO" : "FINANCIOU_SEM_UTILIZAR";
  return { ...base, pontos: 0, conversao: 0, utilizacao: 0, status: ROTULO_STATUS[st] };
}

/** Junta a linha do Score com as simulações do vendedor (por nome + loja, sem ambiguidade). */
export function utilConvPara(linha: LinhaScore, governadas: any[] | null, fim: string): UtilConv {
  if (fim < INICIO_TELEMETRIA) return { disponivel: false, maximo: 100, motivo: "Período anterior ao início da coleta de uso do simulador (17/08/2026)." };
  if (!governadas) return { disponivel: false, maximo: 100, motivo: "Dados de uso do simulador indisponíveis agora." };
  const loja = (l: unknown) => normalizaLoja(String(l ?? "")) ?? norm(l);
  const doVend = governadas.filter((g) => norm(g.nome) === norm(linha.vendedor) && loja(g.loja) === loja(linha.loja));
  const ids = new Set(doVend.map((g) => g.usuario_id));
  if (ids.size === 0) return { disponivel: false, maximo: 100, motivo: "Vendedor sem vínculo comprovado com um usuário do Portal." };
  if (ids.size > 1) return { disponivel: false, maximo: 100, motivo: "Mais de um usuário do Portal com esse nome e loja." };
  const S = doVend.filter((g) => dept(g.department) === linha.departamento).reduce((s, g) => s + (Number(g.simulations) || 0), 0);
  return classificaUtilConv(S, linha.vendas, linha.financiados);
}

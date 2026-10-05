// Brabus Intelligence — motor de cálculo: helpers comuns.
// Reescrito do zero a partir da especificação dos simuladores do Portal
// (simulador-novos.html / simulador-seminovos.html). Nenhum código de IA antiga.
// Regra: nenhum arredondamento intermediário; só a exibição arredonda.

export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: string };

export const ok = <T>(valor: T): Resultado<T> => ({ ok: true, valor });
export const falha = <T = never>(erro: string): Resultado<T> => ({ ok: false, erro });

/** Formata BRL como o Portal (Intl pt-BR, 2 casas, half-expand). */
export function brl(v: number): string {
  return (isFinite(v) ? v : 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Percentual como o Portal: 0–2 casas. 0.0177 → "1,77%". */
export function pct(v: number): string {
  return (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + "%";
}

/** Percentual com 2 casas fixas. */
export function pct2(v: number): string {
  return (v * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
}

/** Plano Balão: spread interno sobre a taxa da tabela (+0,012 p.p. a.m.). */
export function taxaInterna(t: number): number {
  return t + 0.00012;
}

/** Plano Balão: base com adicional 6,2305%, TC R$980, registro R$339,67 e gross-up de IOF 3,21516%. */
export function baseInterna(fin: number): number {
  const ADICIONAL = 0.062305, CAD = 980, REG = 339.67, IOF = 0.0321516;
  const subtotal = Math.max(0, fin) * (1 + ADICIONAL) + CAD + REG;
  return subtotal / (1 - IOF);
}

/** Fator Price: (1-(1+i)^-n)/i. */
export function fatorPrice(i: number, n: number): number {
  return (1 - Math.pow(1 + i, -n)) / i;
}

/**
 * Resolve a taxa Price por bisseção (Calculadora de Taxa do Portal).
 * Retorna null quando não há taxa compatível.
 */
export function taxaPricePorIteracao(pv: number, pmt: number, n: number): number | null {
  if (!(pv > 0) || !(pmt > 0) || !(n > 0)) return null;
  if (Math.abs(pmt - pv / n) < 0.005) return 0;
  if (pmt < pv / n) return null;
  const f = (i: number) => (pmt * (1 - Math.pow(1 + i, -n))) / i - pv;
  let lo = 1e-10;
  let hi = 1;
  while (f(hi) > 0 && hi < 10) hi *= 2;
  if (f(hi) > 0) return null;
  for (let k = 0; k < 120; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- Datas (calendário puro, sem fuso) ----------
// O Portal usa datas locais (America/Sao_Paulo, sem horário de verão desde 2019).
// Aqui as datas são tratadas como dias de calendário em UTC, o que é equivalente.

export type DataISO = string; // "AAAA-MM-DD"

export function parseISO(d: DataISO): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? "");
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(dt.getTime()) ? null : dt;
}

export function toISO(d: Date): DataISO {
  return d.toISOString().slice(0, 10);
}

/** Soma meses como o Portal: se o dia "transborda", volta para o último dia do mês. */
export function addMonths(d: Date, k: number): Date {
  const r = new Date(d.getTime());
  const dia = r.getUTCDate();
  r.setUTCMonth(r.getUTCMonth() + k);
  if (r.getUTCDate() !== dia) r.setUTCDate(0);
  return r;
}

/** Meses à frente, como no Portal: clamp(ceil(dias/30,4375), 1, 60). */
export function diffMonthsAhead(data: Date, venc: Date): number {
  const ms = venc.getTime() - data.getTime();
  const m = Math.ceil(ms / (86400000 * 30.4375));
  return Math.min(60, Math.max(1, m));
}

/** Arredonda a centavos (só para entradas derivadas de %, como o Portal faz). */
export function centavos(v: number): number {
  return Math.round(v * 100) / 100;
}

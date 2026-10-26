// Carrega as bases ACTIVE dos simuladores (as mesmas RPCs simulador_get_* que o Portal usa)
// e converte para as tabelas do motor. FAIL-CLOSED: se uma base não vier válida,
// a IA NÃO simula aquele plano (diferente da tela, que cai em silêncio num fallback antigo).

import type { Rpc } from "./rpc.ts";
import type { TabelasNovos, ModeloCopart, ModeloSemestral } from "../engine/novos.ts";
import { PARCELA_UNICA_FIXA } from "../engine/novos.ts";
import type { TabelasSeminovos, RateTableSeminovo } from "../engine/seminovos.ts";
import type { TabelaAntecipacao } from "../engine/ferramentas.ts";

export type RefBase = { rpc: string; arquivo: string | null; lote: string | null };
type Resp = { ok?: boolean; linhas?: any; batch_id?: string; arquivo_nome?: string };

const num = (x: unknown) => typeof x === "number" && isFinite(x);
const todosNum = (rows: any[], campos: string[]) => Array.isArray(rows) && rows.length > 0 && rows.every((r) => campos.every((c) => num(r?.[c])));

export class BaseIndisponivel extends Error {}

export class Bases {
  private cache = new Map<string, Promise<Resp>>();
  readonly usadas: RefBase[] = [];
  constructor(private rpc: Rpc) {}

  private async get(rpcName: string): Promise<Resp> {
    if (!this.cache.has(rpcName)) this.cache.set(rpcName, this.rpc.call<Resp>(rpcName));
    const r = await this.cache.get(rpcName)!;
    if (!r || r.ok !== true || !r.linhas || (Array.isArray(r.linhas) && !r.linhas.length)) {
      throw new BaseIndisponivel(`A base ${rpcName} não está ativa no Portal.`);
    }
    if (!this.usadas.some((u) => u.rpc === rpcName)) this.usadas.push({ rpc: rpcName, arquivo: r.arquivo_nome ?? null, lote: r.batch_id ?? null });
    return r;
  }

  /** Tenta carregar; devolve null (e não o erro) quando a base específica está fora. */
  private async talvez<T>(f: () => Promise<T>): Promise<T | null> {
    try { return await f(); } catch (e) { if (e instanceof BaseIndisponivel) return null; throw e; }
  }

  async linearZeroKm() {
    const r = await this.get("simulador_get_linear_zerokm");
    if (!todosNum(r.linhas, ["prazo", "entrada_pct", "taxa"])) throw new BaseIndisponivel("Base Linear 0km em formato inesperado.");
    return (r.linhas as any[]).map((x) => ({ prazo: x.prazo, entrada: x.entrada_pct, taxa: x.taxa }));
  }

  async balaoZeroKm() {
    const r = await this.get("simulador_get_balao_zerokm");
    if (!todosNum(r.linhas, ["entrada_minima", "prazo", "max_balao", "taxa"])) throw new BaseIndisponivel("Base Balão 0km em formato inesperado.");
    const m = (x: any) => ({ entrada: x.entrada_minima, prazo: x.prazo, max: x.max_balao, taxa: x.taxa });
    const rows = r.linhas as any[];
    return { tradicional: rows.filter((x) => x.bloco === "TRADICIONAL").map(m), periodica: rows.filter((x) => x.bloco === "SEMESTRAL_ANUAL").map(m) };
  }

  async taxasSubsidiadas() {
    const r = await this.get("simulador_get_taxas_subsidiadas");
    if (!todosNum(r.linhas, ["prazo", "taxa", "coeficiente", "rebate"])) throw new BaseIndisponivel("Base Taxas Subsidiadas em formato inesperado.");
    return (r.linhas as any[]).map((x) => ({ prazo: x.prazo, taxa: x.taxa, coef: x.coeficiente, rebate: x.rebate }));
  }

  async taxaBotao() {
    const r = await this.get("simulador_get_taxa_botao");
    if (!todosNum(r.linhas, ["prazo", "taxa_copiar"])) throw new BaseIndisponivel("Base Taxa Botão em formato inesperado.");
    return Object.fromEntries((r.linhas as any[]).map((x) => [String(x.prazo), x.taxa_copiar]));
  }

  async antecipacao(): Promise<TabelaAntecipacao> {
    const r = await this.get("simulador_get_antecipacao");
    if (!todosNum(r.linhas, ["meses_antecipacao", "desconto"])) throw new BaseIndisponivel("Base Antecipação em formato inesperado.");
    return Object.fromEntries((r.linhas as any[]).map((x) => [String(x.meses_antecipacao), x.desconto]));
  }

  async semestralTriton(): Promise<Record<string, ModeloSemestral>> {
    const r = await this.get("simulador_get_semestral_triton_outlander");
    const rows = r.linhas as any[];
    if (!todosNum(rows, ["rebate_total", "rebate_hpe", "rebate_brabus", "entrada_minima"]) || !rows.every((x) => typeof x.modelo === "string" && x.modelo)) {
      throw new BaseIndisponivel("Base Semestral Triton/Outlander em formato inesperado.");
    }
    const out: Record<string, ModeloSemestral> = {};
    for (const x of rows) out[x.modelo] = { rebateTotal: x.rebate_total, hpeShare: x.rebate_hpe, brabusShare: x.rebate_brabus, entradaMinima: x.entrada_minima };
    return out;
  }

  async coparticipado(): Promise<{ copartModels: ModeloCopart[]; copartTxCoef: Record<string, Record<string, number>> }> {
    const r = await this.get("simulador_get_coparticipado");
    const mm = r.linhas?.matriz_modelos, tc = r.linhas?.tx_coef;
    if (!todosNum(mm, ["entrada_minima", "rebate_total", "rebate_hpe", "rebate_brabus", "prazo", "taxa"]) || !todosNum(tc, ["prazo", "taxa", "coeficiente"])) {
      throw new BaseIndisponivel("Base Coparticipado em formato inesperado.");
    }
    const txCoef: Record<string, Record<string, number>> = {};
    for (const x of tc as any[]) (txCoef[String(x.prazo)] ??= {})[String(x.taxa)] = x.coeficiente;
    const porNome = new Map<string, ModeloCopart>();
    for (const x of mm as any[]) {
      const m: ModeloCopart = porNome.get(x.modelo) ?? { name: x.modelo, entry: x.entrada_minima, rebate: x.rebate_total, hpe: x.rebate_hpe, brabus: x.rebate_brabus, rates: {} as Record<string, number> };
      m.rates[String(x.prazo)] = x.taxa;
      porNome.set(x.modelo, m);
    }
    return { copartModels: [...porNome.values()], copartTxCoef: txCoef };
  }

  async balaoSeminovos() {
    const r = await this.get("simulador_get_balao_seminovos");
    if (!todosNum(r.linhas, ["entrada_minima", "prazo", "max_balao", "taxa"])) throw new BaseIndisponivel("Base Balão Seminovos em formato inesperado.");
    return (r.linhas as any[]).map((x) => ({ faixa: x.bloco, entrada: x.entrada_minima, prazo: x.prazo, max: x.max_balao, taxa: x.taxa }));
  }

  async financiamentoSeminovo(): Promise<RateTableSeminovo> {
    const r = await this.get("simulador_get_financiamento_seminovo");
    const rows = r.linhas as any[];
    if (!todosNum(rows, ["entrada_pct", "prazo", "taxa"]) || !rows.every((x) => typeof x.faixa_ano === "string" && x.faixa_ano)) {
      throw new BaseIndisponivel("Base Financiamento Seminovo em formato inesperado.");
    }
    const t: RateTableSeminovo = {};
    for (const x of rows) ((t[x.faixa_ano] ??= {})[String(Math.round(x.entrada_pct * 100))] ??= {})[String(x.prazo)] = x.taxa;
    return t;
  }

  /**
   * Tabelas de Novos. Linear e Balão são obrigatórias; as demais, se fora do ar,
   * deixam o plano correspondente vazio (e o plano some das opções).
   */
  async novos(): Promise<{ tabelas: TabelasNovos; indisponiveis: string[] }> {
    const [linear, balao] = await Promise.all([this.linearZeroKm(), this.balaoZeroKm()]);
    const ind: string[] = [];
    const [reb, botao, semi, cop] = await Promise.all([
      this.talvez(() => this.taxasSubsidiadas()), this.talvez(() => this.taxaBotao()),
      this.talvez(() => this.semestralTriton()), this.talvez(() => this.coparticipado()),
    ]);
    if (!reb) ind.push("Taxas Subsidiadas");
    if (!semi) ind.push("Semestral Triton/Outlander");
    if (!cop) ind.push("Plano Coparticipado");
    return {
      tabelas: {
        linear, tradicional: balao.tradicional, periodica: balao.periodica, parcelaUnica: PARCELA_UNICA_FIXA,
        rebates: reb ?? [], taxaBotao: botao ?? {}, semestralModelos: semi ?? {},
        copartModels: cop?.copartModels ?? [], copartTxCoef: cop?.copartTxCoef ?? {},
      },
      indisponiveis: ind,
    };
  }

  async seminovos(): Promise<TabelasSeminovos> {
    const [linear, balao] = await Promise.all([this.financiamentoSeminovo(), this.balaoSeminovos()]);
    return { linear, balao };
  }
}

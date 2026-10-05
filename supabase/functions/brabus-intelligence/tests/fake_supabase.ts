// Supabase falso para testes: responde as RPCs com o MESMO formato das de produção
// (formato levantado do portal-app.js e dos parsers do Painel Master).

const fx = (f: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const TN = { ...fx("tabelas_novos_fallback.json"), ...fx("tabelas_novos_xlsx.json") };
const TS = fx("tabelas_seminovos_fallback.json");

const ok = (linhas: unknown, arquivo: string) => ({ ok: true, linhas, batch_id: "00000000-0000-0000-0000-00000000b0b0", arquivo_nome: arquivo });

export const BASES_RPC: Record<string, unknown> = {
  simulador_get_linear_zerokm: ok(TN.linear.map((r: any) => ({ prazo: r.prazo, entrada_pct: r.entrada, taxa: r.taxa })), "Linear Coef.xlsx"),
  simulador_get_balao_zerokm: ok([
    ...TN.tradicional.map((r: any) => ({ bloco: "TRADICIONAL", entrada_minima: r.entrada, prazo: r.prazo, max_balao: r.max, taxa: r.taxa })),
    ...TN.periodica.map((r: any) => ({ bloco: "SEMESTRAL_ANUAL", entrada_minima: r.entrada, prazo: r.prazo, max_balao: r.max, taxa: r.taxa })),
  ], "Coef Balão.xlsx"),
  simulador_get_taxas_subsidiadas: ok(TN.rebates.map((r: any) => ({ prazo: r.prazo, taxa: r.taxa, coeficiente: r.coef, rebate: r.rebate })), "rebates.xlsx"),
  simulador_get_taxa_botao: ok(Object.entries(TN.taxaBotao).map(([p, t]) => ({ prazo: +p, taxa_copiar: t })), "taxa botão.xlsx"),
  simulador_get_antecipacao: ok(Object.entries(TN.antecipacao).map(([m, d]) => ({ meses_antecipacao: +m, desconto: d })), "ANTECIPAÇÃO.xlsx"),
  simulador_get_semestral_triton_outlander: ok(Object.entries(TN.semestralModelos).map(([m, v]: any) => ({ modelo: m, rebate_total: v.rebateTotal, rebate_hpe: v.hpeShare, rebate_brabus: v.brabusShare, entrada_minima: v.entradaMinima })), "coparticipado semestral.xlsx"),
  simulador_get_coparticipado: ok({
    matriz_modelos: TN.copartModels.flatMap((m: any) => Object.entries(m.rates).map(([p, t]) => ({ modelo: m.name, entrada_minima: m.entry, rebate_total: m.rebate, rebate_hpe: m.hpe, rebate_brabus: m.brabus, prazo: +p, taxa: t }))),
    tx_coef: Object.entries(TN.copartTxCoef).flatMap(([p, o]: any) => Object.entries(o).map(([t, c]) => ({ prazo: +p, taxa: +t, coeficiente: c }))),
  }, "taxa coparticipado.xlsx"),
  simulador_get_balao_seminovos: ok(TS.balao.map((r: any) => ({ bloco: r.faixa, entrada_minima: r.entrada, prazo: r.prazo, max_balao: r.max, taxa: r.taxa })), "Coef Balão Seminovos.xlsx"),
  simulador_get_financiamento_seminovo: ok(Object.entries(TS.linear).flatMap(([fa, e]: any) => Object.entries(e).flatMap(([pct, pr]: any) => Object.entries(pr).map(([p, t]) => ({ faixa_ano: fa, entrada_pct: +pct / 100, prazo: +p, taxa: t })))), "coef seminovo.xlsx"),
};

export type Usuario = { perfil: string; loja: string | null; modulos: string[]; nome: string };

export const PERIODOS = { rows: [
  { nome_periodo: "Setembro/2026", data_inicio: "2026-08-21", data_fim: "2026-09-20", periodo_atual: false, ativo: true, criado_por: "00000000000" },
  { nome_periodo: "Outubro/2026", data_inicio: "2026-09-21", data_fim: "2026-10-20", periodo_atual: true, ativo: true, criado_por: "00000000000" },
] };

// Linhas de operational_metrics (por vendedor × loja), período atual e anterior.
const linhaVend = (seller: string, store: string, sold: number, fin: number, prod: number, ret: number, spf: number, mix: [string, number][]) => ({
  seller_id: seller, seller_name: seller, store, department: "NOVOS", sold_count: sold, sales_value: sold * 170000,
  financed_count: fin, share_percent: sold ? fin / sold * 100 : 0, production_value: prod, return_value: ret,
  spf_count: spf, spf_value: spf * 1000, spf_net_value: spf * 700, profitability_value: ret + spf * 700,
  plan_breakdown: mix.map(([plan_type, financed_count]) => ({ plan_type, financed_count, production_value: 0, return_value: 0 })),
});
export const METRICS_ATUAL = { rows: [
  linhaVend("ANA SOUZA", "MITSUBISHI | EUROPA", 10, 7, 560000, 28000, 4, [["LINEAR", 4], ["BALÃO", 2], ["COPARTICIPADO", 1]]),
  linhaVend("BRUNO LIMA", "EUROPA", 6, 3, 240000, 9000, 1, [["LINEAR", 3]]),
  linhaVend("CARLA DIAS", "MITSUBISHI | BARRA FUNDA", 12, 6, 500000, 30000, 5, [["BALÃO", 4], ["SUBSIDIADO", 2]]),
  linhaVend("REVENDA X", "REVENDA", 30, 0, 0, 0, 0, []),
  { ...linhaVend("DIEGO SEMI", "EUROPA", 5, 2, 120000, 4000, 0, [["LINEAR", 2]]), department: "SEMINOVOS" },
] };
export const METRICS_ANTERIOR = { rows: [
  linhaVend("ANA SOUZA", "EUROPA", 8, 4, 300000, 15000, 2, [["LINEAR", 4]]),
  linhaVend("CARLA DIAS", "BARRA FUNDA", 10, 6, 480000, 25000, 3, [["BALÃO", 6]]),
] };

const sale = (seller: string, model: string, date = "2026-09-25") => ({ seller, store: "EUROPA", department: "NOVOS", model, date });
const fin = (seller: string, plan: string, spf = 0, date = "2026-09-25") => ({ seller, store: "EUROPA", department: "NOVOS", plan, date, financed_value: 100000, return_value: 6000, spf_value: spf ? 800 : 0, spf_count: spf });
export const SCORE_DATA = {
  sales: [sale("ANA SOUZA", "ECLIPSE CROSS HPE"), sale("ANA SOUZA", "TRITON"), sale("ANA SOUZA", "OUTLANDER"), sale("ANA SOUZA", "ECLIPSE CROSS"), sale("ANA SOUZA", "TRITON"),
    sale("BRUNO LIMA", "TRITON"), sale("BRUNO LIMA", "TRITON")],
  finance: [fin("ANA SOUZA", "LINEAR", 1), fin("ANA SOUZA", "BALÃO", 1), fin("ANA SOUZA", "LINEAR"), fin("BRUNO LIMA", "LINEAR")],
};

export const FANDI = {
  summary: { operational_quantity: 20, total_financed: 1800000 },
  banks: [{ bank: "BANCO A", quantity: 12, total_financed: 1100000 }, { bank: "BANCO B", quantity: 8, total_financed: 700000 }],
  plans: [{ plan_type: "LINEAR", quantity: 11, financed_value: 990000 }, { plan_type: "COPARTICIPADO", quantity: 5, financed_value: 450000 }, { plan_type: "BALÃO", quantity: 4, financed_value: 360000 }],
  proposal_outcomes: [
    { store: "EUROPA", department: "NOVOS", outcome: "APROVADA", quantity: 3, financed_value: 270000 },
    { store: "EUROPA", department: "NOVOS", outcome: "RECUSADA", quantity: 4, financed_value: 320000 },
    { store: "ABC", department: "NOVOS", outcome: "RECUSADA", quantity: 1, financed_value: 80000 },
  ],
  bank_outcomes: [
    { bank: "BANCO A", proposals: 20, refused: 3, approved_not_billed: 5, billed: 12, refused_value: 240000 },
    { bank: "BANCO B", proposals: 12, refused: 6, approved_not_billed: 1, billed: 5, refused_value: 480000 },
  ],
  proposal_status: [{ status: "FATURADA", quantity: 17, financed_value: 1500000 }, { status: "RECUSADA", quantity: 9, financed_value: 720000 }],
  source_completed_at: "2026-10-02T08:15:00Z",
};

export const MODEL_METRICS = { rows: [
  { store: "EUROPA", department: "NOVOS", model: "ECLIPSE CROSS HPE 4X2", sold_count: 9, financed_count: 6, production_value: 480000, return_value: 24000,
    average_installments: 48, average_installment_value: 2900, valid_entry_count: 6, entry_total: 540000, entry_sales_value_total: 1080000,
    plan_breakdown: [{ plan_type: "COPARTICIPADO", financed_count: 3 }, { plan_type: "LINEAR", financed_count: 2 }, { plan_type: "BALÃO", financed_count: 1 }] },
  { store: "EUROPA", department: "NOVOS", model: "ECLIPSE CROSS HPE-S 4X2", sold_count: 5, financed_count: 4, production_value: 400000, return_value: 20000,
    average_installments: 36, average_installment_value: 4000, valid_entry_count: 4, entry_total: 300000, entry_sales_value_total: 760000,
    plan_breakdown: [{ plan_type: "SUBSIDIADO", financed_count: 4 }] },
] };

export function fakeFetch(u: Usuario, extra: Record<string, (args: any) => unknown> = {}, log: string[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const m = /\/rest\/v1\/rpc\/(\w+)/.exec(url);
    const resp = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
    if (!m) return resp(404, { message: "rota" });
    const fn = m[1];
    log.push(fn);
    if (extra[fn]) { const r = extra[fn](body); return r instanceof Response ? r : resp(200, r); }
    if (BASES_RPC[fn]) return resp(200, BASES_RPC[fn]);
    switch (fn) {
      case "operational_current_scope":
        return resp(200, { profile: u.perfil, store: u.loja, departments: ["NOVOS", "SEMINOVOS"], is_master: u.perfil === "MASTER" });
      case "portal_modulos_permitidos": return resp(200, u.modulos);
      case "usuario_logado_fi": return resp(200, [{ nome: u.nome, cpf: "12345678900", perfil: u.perfil }]);
      case "operational_commission_periods": return resp(200, PERIODOS);
      case "operational_portal_config": return resp(200, { rows: [{ chave: "share_minimo", valor: "0.5" }] });
      case "operational_metrics": return resp(200, body.p_start >= "2026-09-21" ? METRICS_ATUAL : METRICS_ANTERIOR);
      case "operational_model_metrics": return resp(200, MODEL_METRICS);
      case "operational_score_coparticipated_data": return resp(200, SCORE_DATA);
      case "master_commission_closings": return u.perfil === "MASTER" ? resp(200, { rows: [
        { id: "f-ago", status: "FECHADO", ativo: true, versao: 1, data_inicio: "2026-07-21", data_fim: "2026-08-20", fechado_em: "2026-08-22T10:00:00Z" },
        { id: "f-set-v1", status: "FECHADO", ativo: false, versao: 1, data_inicio: "2026-08-21", data_fim: "2026-09-20", fechado_em: "2026-09-22T10:00:00Z" },
        { id: "f-set-v2", status: "FECHADO", ativo: true, versao: 2, data_inicio: "2026-08-21", data_fim: "2026-09-20", fechado_em: "2026-09-23T10:00:00Z" },
      ] }) : resp(403, { code: "42501", message: "sem acesso" });
      case "operational_analyst_commission_metrics_v2": return resp(200, { rows: [{ analyst_name: "ANALISTA FICTICIO DA SILVA TESTE", store: "EUROPA", transfer: false, coverage_id: null, sold_count: 12, financed_count: 7, production_value: 1254350, return_value: 72897, spf_value: 1100 }] });
      case "operational_commission_faixa_rows": return u.perfil === "MASTER" ? resp(200, { rows: [{ perfil: "ANALISTA", store: "EUROPA", faixa: 0.045, faixa_level: 2, comissao_total: 3465.02 }] }) : resp(403, { code: "42501", message: "sem acesso" });
      case "operational_salary_manager_directory": return resp(200, { rows: [] });
      case "operational_own_commission_summary": return resp(200, { rows: [], comissao_total: 0, profile: u.perfil });
      case "bi_fandi_dashboard": return resp(200, FANDI);
      case "operational_commission_metrics": return resp(200, { rows: [
        { seller_id: "s1", seller_name: "CARLOS NOVOS", store: "MITSUBISHI | ALPHAVILLE", department: "NOVOS", sold_count: 3, financed_count: 2, production_value: 200000, return_value: 9000 },
        { seller_id: "s2", seller_name: "PAULA SEMI", store: "MITSUBISHI | ALPHAVILLE", department: "SEMINOVOS", sold_count: 4, financed_count: 3, production_value: 150000, return_value: 7000 },
      ] });
      case "operational_scope_commission_rows": return resp(200, u.perfil === "ANALISTA" || u.perfil === "GERENTE" ? { rows: [
        { perfil: "VENDEDOR", seller_id: "s1", store: "ALPHAVILLE", department: "NOVOS", faixa: 2, comissao_total: 1000 },
        { perfil: "VENDEDOR", seller_id: "s2", store: "ALPHAVILLE", department: "SEMINOVOS", faixa: 1, comissao_total: 800 },
      ] } : { rows: [] });
      case "master_commission_snapshot": return resp(200, { rows: body.p_closing_id === "f-set-v2" ? [
        { nome: "DOUGLAS FERREIRA", perfil: "VENDEDOR", loja: "MITSUBISHI | EUROPA", departamento: "NOVOS", vendidas: 9, financiadas: 5, share: 55.6, producao: 480000, retorno: 21000, spf_extra: 3, spf_liquido: 2100, rentabilidade_total: 23100, faixa: 3, comissao: 4350, detalhes: { comissao_principal: 3900, comissao_spf: 450, comissao_total: 4350 } },
        { nome: "DOUGLAS SANTOS", perfil: "VENDEDOR", loja: "MITSUBISHI | ABC", departamento: "NOVOS", vendidas: 4, financiadas: 2, share: 50, producao: 200000, retorno: 8000, spf_extra: 0, spf_liquido: 0, rentabilidade_total: 8000, faixa: 1, comissao: 1200, detalhes: { comissao_principal: 1200, comissao_spf: 0, comissao_total: 1200 } },
      ] : [] });
      case "score_utilization_conversion_scope_data": return resp(200, [{ usuario_id: "u-ana", nome: "Ana Souza", loja: "MITSUBISHI | EUROPA", department: "NOVOS", simulations: 8 }]);
      default: return resp(404, { message: `rpc ${fn} não simulada` });
    }
  };
}

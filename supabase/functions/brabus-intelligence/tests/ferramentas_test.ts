// Testes das ferramentas com Supabase falso (formato real das RPCs).
import { assert, assertEquals } from "./assert.ts";
import { fakeFetch, type Usuario } from "./fake_supabase.ts";
import { Rpc } from "../data/rpc.ts";
import { Bases } from "../data/bases.ts";
import { carregaContexto } from "../data/contexto.ts";
import { storeMemoria } from "../data/store.ts";
import { casaModeloTexto, DEFINICOES, executar, type ToolCtx } from "../agent/ferramentas.ts";
import { resolvePeriodo, normalizaLoja } from "../data/lojas_periodos.ts";

const MASTER: Usuario = { perfil: "MASTER", loja: null, nome: "Luis", modulos: [] };
const VENDEDOR: Usuario = { perfil: "VENDEDOR", loja: "EUROPA", nome: "Ana", modulos: ["simuladorCompleto", "simuladorSeminovos"] };

async function ctxPara(u: Usuario, extra = {}, store = storeMemoria(), log: string[] = []): Promise<ToolCtx & { log: string[] }> {
  const rpc = new Rpc("https://x.supabase.co", "anon", "jwt", fakeFetch(u, extra, log) as any);
  let n = 0;
  return {
    rpc, bases: new Bases(rpc), usuario: await carregaContexto(rpc), store, sessao: "s1", canal: "portal",
    hoje: "2026-10-02", uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, cache: new Map(), log,
  };
}
const VEIC = { tipo: "novo", modelo: "Eclipse Cross", versao: "HPE", ano_modelo: null, valor_veiculo: 180000 };

Deno.test("schemas: todas as ferramentas em modo estrito, required = todas as propriedades", () => {
  for (const d of DEFINICOES as any[]) {
    assert(d.strict === true, d.name);
    assertEquals(Object.keys(d.parameters.properties).sort(), [...d.parameters.required].sort(), d.name);
    assert(d.parameters.additionalProperties === false, d.name);
  }
  assertEquals(new Set((DEFINICOES as any[]).map((d) => d.name)).size, DEFINICOES.length, "nomes únicos");
});

Deno.test("contexto: CPF do cadastro é descartado", async () => {
  const c = await ctxPara(MASTER);
  assert(!JSON.stringify(c.usuario).includes("12345678900"));
});

Deno.test("P1: Eclipse Cross HPE 180k / 90k → opções ranqueadas com histórico", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assert(!r.erro, JSON.stringify(r));
  assertEquals(r.origem_entrada, "informada");
  assert(r.opcoes.length >= 3);
  // Oferta padrão: Plano Balão primeiro, depois Linear; subsídio fora porque não foi pedido.
  assertEquals(r.opcoes[0].plano, "BALAO");
  assertEquals(r.opcoes[1].plano, "LINEAR");
  assert(!r.opcoes.some((o: any) => ["COPARTICIPADO", "TAXA_SUBSIDIADA", "SEMESTRAL_TAXA_ZERO"].includes(o.plano)));
  assert(r.subsidio_disponivel_se_pedir);
  // Estratégia pelo histórico: Linear (2 de 6) lidera com 50% de entrada (Coparticipado não pedido)
  const h: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "estrategia_historico", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assertEquals(h.opcoes[0].plano, "LINEAR");
  assert(h.opcoes[0].motivo_ranking.includes("33%"), h.opcoes[0].motivo_ranking);
  // Pedindo Coparticipado com 60%: entra, e no histórico (50%) lidera
  const r60: any = await executar("simular_financiamento", { ...VEIC, entrada: 108000, objetivo: "estrategia_historico", planos_com_subsidio: ["COPARTICIPADO"], apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assertEquals(r60.opcoes[0].plano, "COPARTICIPADO");
  assert(r60.opcoes[0].rebate_concessionaria > 0);
  assertEquals(r.historico_base.financiados, 6);
  const lin60 = r.opcoes.find((o: any) => o.plano === "LINEAR");
  assert(lin60, "linear presente");
  // Linear 60x 180k/90k = R$ 2.984,38 (vetor V001 da página original)
  const todos = [...r.opcoes];
  const v = todos.find((o: any) => o.plano === "LINEAR" && o.prazo === 60);
  if (v) assertEquals(v.parcela, 2984.38);
  assert(r.opcoes.every((o: any) => typeof o.simulacao_id === "string"));
  assert(r.bases.length >= 2 && r.bases[0].arquivo, "cita a base usada");
});

Deno.test("P1b: entrada null usa média % do histórico; sem histórico pede a entrada", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_financiamento", { ...VEIC, entrada: null, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: ["LINEAR"], prazos: [60], parcela_alvo: null }, c);
  assertEquals(r.origem_entrada, "media_historico");
  assertEquals(r.entrada_usada, 90000); // 540.000 / 1.080.000 = 50% de 180.000
  const s: any = await executar("simular_financiamento", { ...VEIC, modelo: "Outlander", versao: "Signature", entrada: null, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assertEquals(s.origem_entrada, "sem_historico");
});

Deno.test("P2: parcela-alvo R$ 1.800 → menor entrada, em ordem de entrada", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 1800, planos_com_subsidio: null }, c);
  assert(r.atingivel, JSON.stringify(r).slice(0, 300));
  // Sem subsídio pedido: só Linear e Balão; mais vendido (Linear 2 > Balão 1 no histórico) primeiro
  assert(r.opcoes.every((o: any) => ["LINEAR", "BALAO"].includes(o.plano)), JSON.stringify(r.opcoes.map((o: any) => o.plano)));
  assertEquals(r.opcoes[0].plano, "LINEAR");
  const lin = r.opcoes.filter((o: any) => o.plano === "LINEAR");
  for (let k = 1; k < lin.length; k++) assert(lin[k].entrada_minima_necessaria >= lin[k - 1].entrada_minima_necessaria);
  assert(r.opcoes.every((o: any) => o.parcela <= 1800));
  const sub: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 1800, planos_com_subsidio: ["TAXA_SUBSIDIADA"] }, c);
  assert(sub.opcoes.some((o: any) => o.plano === "TAXA_SUBSIDIADA"));
  const imp: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 50, planos_com_subsidio: null }, c);
  assertEquals(imp.atingivel, false);
  assert(imp.mais_proxima);
});

Deno.test("P3: resultado da Europa na competência, com variação já calculada", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("resultado_loja", { loja: "Brabus Europa", departamento: "NOVOS", periodo: null, data_inicio: null, data_fim: null }, c);
  assert(!r.erro, JSON.stringify(r));
  assertEquals(r.periodo_inicio, "2026-09-21");
  const e = r.lojas[0];
  assertEquals(e.loja, "EUROPA");
  assertEquals(e.vendidos, 16); // "MITSUBISHI | EUROPA" + "EUROPA" somados
  assertEquals(e.financiados, 10);
  assertEquals(e.share_pct, 62.5);
  assertEquals(e.variacao_vs_anterior.financiados, 6);
  assertEquals(e.variacao_vs_anterior.share_pp, 12.5);
});

Deno.test("P4: Europa × Barra Funda — líder e diferença por indicador; REVENDA fora", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("comparar_lojas", { lojas: ["europa", "Barra Funda"], departamento: "NOVOS", periodo: null, data_inicio: null, data_fim: null }, c);
  const fin = r.comparacao.find((x: any) => x.indicador === "financiados");
  assertEquals(fin.lider, "EUROPA");
  assertEquals(fin.por_loja.find((x: any) => x.loja === "BARRA FUNDA").diferenca_para_lider, -4);
  assert(!JSON.stringify(r).includes("REVENDA"));
});

Deno.test("vendedor: sem retorno/rentabilidade, sem ranking por retorno", async () => {
  const c = await ctxPara(VENDEDOR);
  const r: any = await executar("resultado_loja", { loja: null, periodo: null, data_inicio: null, data_fim: null }, c);
  const s = JSON.stringify(r);
  assert(!/"retorno|rentabilidade|return_value|profitability/.test(s), s);
  const k: any = await executar("ranking_vendedores", { criterio: "retorno", loja: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assert(k.erro);
  const h: any = await executar("historico_vendas", { modelo: "Eclipse Cross", versao: "HPE", loja: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assert(!("retorno_medio_pct" in h));
});

Deno.test("módulo: vendedor sem score/comissão recebe recusa clara (e fica auditado como erro)", async () => {
  const store = storeMemoria();
  const c = await ctxPara(VENDEDOR, {}, store);
  const r: any = await executar("consultar_score", { vendedor: null, loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assert(String(r.erro).includes("Análise de Score"));
  assertEquals(store.log.at(-1)!.status, "erro");
});

Deno.test("permissão do banco (42501) vira 'negado' no log", async () => {
  const store = storeMemoria();
  const c = await ctxPara(MASTER, { bi_fandi_dashboard: () => new Response(JSON.stringify({ code: "42501", message: "Perfil sem acesso" }), { status: 403 }) }, store);
  const r: any = await executar("analise_fi", { foco: "geral", plano: null, loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assert(String(r.erro).includes("não tem acesso"));
  assertEquals(store.log.at(-1)!.status, "negado");
});

Deno.test("simulacao_id: reaproveita; expirada pede refazer; inexistente não vaza", async () => {
  let agora = Date.now();
  const store = storeMemoria(() => agora);
  const c = await ctxPara(MASTER, {}, store);
  const r: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: ["LINEAR"], prazos: [48], parcela_alvo: null }, c);
  const id = r.opcoes[0].simulacao_id;
  const a: any = await executar("simular_antecipacao", { simulacao_id: id, prazo: null, parcela: null, primeiro_vencimento: "2026-11-01", data_antecipacao: "2026-11-15", tipo: "todo", de: null, ate: null, parcela_escolhida: null }, c);
  assertEquals(a.contrato.prazo, 48);
  assertEquals(a.contrato.parcela_mensal, r.opcoes[0].parcela);
  assert(a.valor_a_pagar < a.valor_original);
  const cc: any = await executar("simular_cash_conversion", { simulacao_id: id, parcela: null, prazo: null, capital: 90000, taxa_aplicacao_mensal: 0.01 }, c);
  assert(["FINANCIAR", "UTILIZAR", "EQUIVALENTE"].includes(cc.cenarios[0].recomendacao));
  agora += 5 * 3600_000;
  const e: any = await executar("simular_antecipacao", { simulacao_id: id, prazo: null, parcela: null, primeiro_vencimento: null, data_antecipacao: null, tipo: "todo", de: null, ate: null, parcela_escolhida: null }, c);
  assert(String(e.erro).includes("expirou"));
  const x: any = await executar("simular_antecipacao", { simulacao_id: "11111111-1111-4111-8111-111111111111", prazo: null, parcela: null, primeiro_vencimento: null, data_antecipacao: null, tipo: "todo", de: null, ate: null, parcela_escolhida: null }, c);
  assertEquals(x.erro, "Simulação não encontrada.");
});

Deno.test("base fora do ar: Linear/Balão obrigatórias falham fechado; Coparticipado some com aviso", async () => {
  const sem = await ctxPara(MASTER, { simulador_get_linear_zerokm: () => ({ ok: false }) });
  const r: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, sem);
  assert(String(r.erro).includes("não está ativa"), JSON.stringify(r));
  const semCop = await ctxPara(MASTER, { simulador_get_coparticipado: () => ({ ok: false }) });
  const s: any = await executar("simular_financiamento", { ...VEIC, entrada: 108000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, semCop);
  assert(!s.opcoes.some((o: any) => o.plano === "COPARTICIPADO"));
  assert(s.avisos.some((a: string) => a.includes("Coparticipado")));
});

Deno.test("seminovo exige ano e usa a faixa de ano", async () => {
  const c = await ctxPara(MASTER);
  const s: any = await executar("simular_financiamento", { tipo: "seminovo", modelo: "Triton", versao: null, ano_modelo: null, valor_veiculo: 120000, entrada: 30000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assert(String(s.erro).includes("ano"));
  const ok: any = await executar("simular_financiamento", { tipo: "seminovo", modelo: "Triton", versao: null, ano_modelo: 2022, valor_veiculo: 120000, entrada: 30000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assert(ok.opcoes.length > 0 && ok.opcoes.every((o: any) => ["LINEAR", "BALAO"].includes(o.plano)));
});

Deno.test("modelo: HPE não casa HPE-S", () => {
  assert(casaModeloTexto("ECLIPSE CROSS HPE 4X2", "Eclipse Cross", "HPE"));
  assert(!casaModeloTexto("ECLIPSE CROSS HPE-S 4X2", "Eclipse Cross", "HPE"));
  assert(casaModeloTexto("ECLIPSE CROSS HPE-S 4X2", "eclipse cross", "hpe-s"));
});

Deno.test("lojas e períodos", () => {
  assertEquals(normalizaLoja("Brabus Europa"), "EUROPA");
  assertEquals(normalizaLoja("MITSUBISHI | A. FRANCO"), "ANALIA FRANCO");
  assertEquals(normalizaLoja("Gastão Vidigal"), "GASTAO");
  assertEquals(normalizaLoja("Lua"), null);
  const p: any = resolvePeriodo("competencia_atual", "2026-10-02", [], null, null);
  assertEquals([p.inicio, p.fim], ["2026-09-21", "2026-10-02"]);
  assert(p.aviso.includes("21→20"));
  const m: any = resolvePeriodo("mes_atual", "2026-10-02", [], null, null);
  assertEquals([m.inicio, m.fim], ["2026-10-01", "2026-10-02"]);
  assert(m.aviso.includes("base é pequena"));
  const ant: any = resolvePeriodo("mes_anterior", "2026-03-31", [], null, null);
  assertEquals([ant.inicio, ant.fim], ["2026-02-01", "2026-02-28"]);
});

Deno.test("manual responde conceito sem números vigentes", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("consultar_manual", { pergunta: "como funciona o cash conversion?" }, c);
  assertEquals(r.topicos[0].titulo, "Cash Conversion");
});

Deno.test("Plano Balão sempre tem balão; parcela-alvo explora estruturas de balão", async () => {
  const c = await ctxPara(MASTER);
  const f: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null }, c);
  assert(!JSON.stringify(f).toLowerCase().includes("sem balão"));
  assertEquals(f.opcoes[0].plano, "BALAO");
  assertEquals(f.opcoes[1].plano, "LINEAR");
  for (const o of f.opcoes.filter((x: any) => x.plano === "BALAO")) {
    assert(o.baloes.length >= 1 && o.baloes.length <= 4, JSON.stringify(o));
    assert(o.total_baloes <= o.limite_baloes + 1e-6);
  }
  const r: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 1800, planos_com_subsidio: null }, c);
  const menor = r.opcoes.find((o: any) => o.destaque);
  assert(menor && menor.plano === "BALAO", JSON.stringify(menor));
  const lin = r.opcoes.find((o: any) => o.plano === "LINEAR");
  assert(menor.entrada_minima_necessaria < lin.entrada_minima_necessaria);
  assert(r.opcoes.every((o: any) => o.parcela <= 1800));
  // simular_balao recusa sem balão e acima de 4 balões
  let erro = "";
  try { await executar("simular_balao", { ...VEIC, entrada: 90000, prazo: 48, baloes: [] }, c); } catch (e) { erro = String(e); }
  const r0: any = erro ? { erro } : await executar("simular_balao", { ...VEIC, entrada: 90000, prazo: 48, baloes: [] }, c);
  assert(JSON.stringify(r0).includes("pelo menos 1 balão"), JSON.stringify(r0));
  const r5: any = await executar("simular_balao", { ...VEIC, entrada: 90000, prazo: 48, baloes: [1, 2, 3, 4, 5].map((m) => ({ mes: m * 6, valor: 1000 })) }, c).catch((e) => ({ erro: String(e) }));
  assert(JSON.stringify(r5).includes("até 4 balões"), JSON.stringify(r5));
});

Deno.test("Novos × Seminovos: Grupo traz a divisão; NOVOS não mistura seminovos; cartões", async () => {
  const c = await ctxPara(MASTER);
  const g: any = await executar("resultado_loja", { loja: "Europa", departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(g.lojas[0].vendidos, 21);
  assertEquals(g.lojas[0].por_departamento.NOVOS.vendidos, 16);
  assertEquals(g.lojas[0].por_departamento.SEMINOVOS.vendidos, 5);
  assert(String(g.visao).startsWith("GRUPO"));
  const n: any = await executar("resultado_loja", { loja: "Europa", departamento: "NOVOS", periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(n.lojas[0].vendidos, 16);
  assertEquals(n.visao, "NOVOS");
  const bl = [...c.blocos!.values()];
  assert(bl.some((b) => b.tipo === "resultado" && (b as any).visao === "NOVOS"));
  const cmp: any = await executar("comparar_lojas", { lojas: ["Europa", "Barra Funda"], departamento: "SEMINOVOS", periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(cmp.lojas.length, 1);
  assert(cmp.sem_dados_ou_fora_do_escopo.includes("BARRA FUNDA"));
  const b: any = c.blocos!.get("comparacao");
  assertEquals(b.linhas[0].rotulo, "Vendidos");
});

Deno.test("Balão: padrão só com as estruturas que mais vendem (1 balão); personalizada; cartão de opções", async () => {
  const c = await ctxPara(MASTER);
  const f: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null, estrutura_balao: null }, c);
  const bal = [...f.opcoes].filter((o: any) => o.plano === "BALAO");
  assert(bal.length >= 1 && bal.every((o: any) => o.baloes.length === 1), JSON.stringify(bal.map((o: any) => o.plano_nome)));
  assertEquals(f.opcoes[0].plano_nome, "Plano Balão — 48x com balão na última parcela");
  const ok = new Set(["48|48", "48|36", "36|36", "36|24"]);
  assert(bal.every((o: any) => ok.has(`${o.prazo}|${o.baloes[0].mes}`)));
  const r: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 1800, planos_com_subsidio: null, estrutura_balao: "ate_2_baloes", balao_personalizado: null }, c);
  assert(r.opcoes.filter((o: any) => o.plano === "BALAO").every((o: any) => o.baloes.length <= 2));
  const p: any = await executar("buscar_entrada_minima", { ...VEIC, parcela_alvo: 2500, planos_com_subsidio: null, estrutura_balao: null, balao_personalizado: { prazo: 48, meses: [30] } }, c);
  assert(p.opcoes.length >= 1 && p.opcoes.every((o: any) => o.baloes[0].mes === 30 && o.parcela <= 2500), JSON.stringify(p).slice(0, 300));
  const bo: any = c.blocos!.get("opcoes");
  assert(bo.destaque && bo.destaque.baloes[0].mes === 30);
  const ap: any = await executar("apresentar_opcoes", { simulacao_ids: [f.opcoes[1].simulacao_id, f.opcoes[0].simulacao_id], destaque_id: f.opcoes[0].simulacao_id, titulo: "Teste" }, c);
  assert(ap.ok);
  const b2: any = c.blocos!.get("opcoes");
  assertEquals(b2.destaque.simulacao_id, f.opcoes[0].simulacao_id);
  assertEquals(b2.alternativas.length, 1);
});

Deno.test("Balão: resumo em linguagem de cliente", async () => {
  const c = await ctxPara(MASTER);
  const f: any = await executar("simular_financiamento", { ...VEIC, entrada: 90000, objetivo: "oferta", planos_com_subsidio: null, apenas_planos: null, prazos: null, parcela_alvo: null, estrutura_balao: null }, c);
  const o = f.opcoes[0];
  assertEquals(o.resumo_baloes, "1 balão de R$ 90.000 na 48ª parcela");
  assertEquals(o.como_paga[0].rotulo, "48 parcelas mensais");
  assertEquals(o.como_paga[1].rotulo, "+ balão na 48ª parcela");
  assert((c.blocos!.get("opcoes") as any).base.startsWith("Histórico:"));
  const lin = f.opcoes.find((x: any) => x.plano === "LINEAR");
  assertEquals(lin.como_paga, [{ rotulo: `${lin.prazo} parcelas mensais`, valor: lin.parcela }]);
});

Deno.test("Antecipação: 'daqui a um ano' = hoje + 12 meses; última parcela com balão = o balão", async () => {
  const c = await ctxPara(MASTER);
  const base = { simulacao_id: null, prazo: 60, parcela: 2985, baloes: null, primeiro_vencimento: null, data_antecipacao: null, de: null, ate: null, parcela_escolhida: null };
  const q: any = await executar("simular_antecipacao", { ...base, meses_ate_antecipacao: 12, tipo: "todo" }, c);
  assertEquals(q.data_antecipacao, "2027-10-02");
  assertEquals(q.parcelas_ja_pagas_ate_a_data, 12);
  assertEquals(q.parcelas_antecipadas, 48);
  assert(q.contrato.premissa_primeiro_vencimento);
  const b: any = await executar("simular_antecipacao", { ...base, prazo: 48, baloes: [{ mes: 48, valor: 55663 }], meses_ate_antecipacao: 12, tipo: "uma", parcela_escolhida: 48 }, c);
  assertEquals(b.parcelas_antecipadas, 1);
  assertEquals(b.linhas[0].tipo, "Balão");
  assertEquals(b.linhas[0].valor_original, 55663);
  assert(b.linhas[0].meses_antecedencia >= 35 && b.linhas[0].meses_antecedencia <= 37, JSON.stringify(b.linhas[0]));
  assertEquals((c.blocos!.get("antecipacao") as any).tipo, "antecipacao");
});

Deno.test("Cash Conversion sem taxa: cenários + taxa de empate", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_cash_conversion", { simulacao_id: null, parcela: 2985, prazo: 60, capital: 90000, taxa_aplicacao_mensal: null }, c);
  assertEquals(r.cenarios.length, 3);
  assertEquals(r.total_pago_no_financiamento, 179100);
  assert(r.taxa_de_empate_pct_am > 1.1 && r.taxa_de_empate_pct_am < 1.2, String(r.taxa_de_empate_pct_am));
  assertEquals((c.blocos!.get("cash") as any).tipo, "cash");
  assert(/mais que 1,1\d% a\.m\./.test(r.leitura_empate), r.leitura_empate);
});

Deno.test("Score: composição, destaques e onde perdeu pontos; cartão", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("consultar_score", { vendedor: null, loja: null, departamento: "NOVOS", periodo: "personalizado", data_inicio: "2026-09-01", data_fim: "2026-09-30" }, c);
  assertEquals(r.foco.vendedor, "ANA SOUZA");
  assert(r.foco.composicao.length >= 5);
  assert(r.foco.destaques.length >= 1, JSON.stringify(r.foco));
  assert(r.foco.pontos_a_melhorar.every((x: any) => x.pontos_perdidos > 0));
  const uc = r.foco.utilizacao_conversao;
  assert(uc.disponivel, JSON.stringify(uc));
  assertEquals(uc.simulacoes, 8);
  assertEquals(uc.conversao, 42);
  assertEquals(uc.utilizacao, 24);
  assertEquals(uc.pontos, 66);
  assert(r.foco.destaques.length <= 2 && r.foco.pontos_a_melhorar.length <= 2);
  const b: any = c.blocos!.get("score");
  assertEquals(b.utilizacao_conversao.pontos, 66);
  assertEquals(b.vendedor.posicao, 1);
  assertEquals(b.ranking.length, 2);
});

Deno.test("Utilização + Conversão: regras da tela de Score do V2", async () => {
  const { classificaUtilConv } = await import("../data/score.ts");
  assertEquals(classificaUtilConv(0, 0, 0).pontos, 0);
  assertEquals(classificaUtilConv(20, 10, 6).pontos, 72); // 70*0,6 + 30*1
  assertEquals(classificaUtilConv(5, 10, 0).pontos, 0);
  assertEquals(classificaUtilConv(0, 10, 6).status, "Financiou sem usar o simulador");
});

Deno.test("Salário: último fechamento oficial (versão ativa), nome ambíguo pergunta, sem trocar pessoa", async () => {
  const c = await ctxPara(MASTER);
  const amb: any = await executar("consultar_salario", { pessoa: "Douglas", fechamento: "ultimo_fechado", loja: null }, c);
  assertEquals(amb.opcoes.length, 2);
  const r: any = await executar("consultar_salario", { pessoa: "Douglas", fechamento: "ultimo_fechado", loja: "Europa" }, c);
  assertEquals(r.pessoa.nome, "DOUGLAS FERREIRA");
  assertEquals(r.comissao_total, 4350);
  assertEquals(r.comissao_principal, 3900);
  assertEquals(r.comissao_spf, 450);
  assertEquals(r.competencia, "2026-08-21 a 2026-09-20");
  assert(String(r.origem).includes("versão 2"));
  assertEquals((c.blocos!.get("salario") as any).tipo, "salario");
  const m: any = await executar("consultar_salario", { pessoa: "Douglas Ferreira", fechamento: "2026-09", loja: null }, c);
  assertEquals(m.comissao_total, 4350);
  const n: any = await executar("consultar_salario", { pessoa: "Fulano", fechamento: "ultimo_fechado", loja: null }, c);
  assert(String(n.mensagem).includes("não aparece"));
});

Deno.test("Salário (prévia): analista encontrado pelo nome, comissão da faixa do banco; MASTER sem comissão própria", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("consultar_salario", { pessoa: "Analista Ficticio", fechamento: "competencia_atual", loja: null }, c);
  assertEquals(r.pessoa.perfil, "ANALISTA");
  assertEquals(r.comissao_total, 3465.02);
  assertEquals(r.pessoa.faixa, "4,5%");
  assertEquals(r.indicadores.vendidas, 12);
  assertEquals(r.indicadores.conversao_pct, 58.33);
  assertEquals(r.oficial, false);
  const eu: any = await executar("consultar_salario", { pessoa: null, fechamento: "competencia_atual", loja: null }, c);
  assert(String(eu.mensagem).includes("não tem comissão calculada"), JSON.stringify(eu));
});

Deno.test("FANDI: banco que mais recusou, aprovadas hoje, coparticipados no mês; cartão", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("analise_fi", { foco: "recusas_por_banco", plano: null, loja: null, departamento: null, periodo: "mes_atual", data_inicio: null, data_fim: null }, c);
  assertEquals(r.banco_que_mais_recusou.banco, "BANCO B");
  assertEquals(r.banco_que_mais_recusou.taxa_recusa_pct, 50);
  assertEquals(r.base_atualizada_em, "2026-10-02T08:15:00Z");
  const h: any = await executar("analise_fi", { foco: "aprovacoes", plano: null, loja: null, departamento: null, periodo: "hoje", data_inicio: null, data_fim: null }, c);
  assertEquals(h.periodo_inicio, "2026-10-02");
  assertEquals(h.resumo.propostas_aprovadas_em_aberto, 3);
  assertEquals(h.resumo.propostas_recusadas, 5);
  const g: any = await executar("analise_fi", { foco: "planos", plano: "COPARTICIPADO", loja: null, departamento: null, periodo: "personalizado", data_inicio: "2026-08-01", data_fim: "2026-08-31" }, c);
  assertEquals(g.plano_pedido.operacoes, 5);
  assertEquals(g.plano_pedido.pct, 25);
  assertEquals((c.blocos!.get("fandi") as any).foco, "planos");
});

Deno.test("FANDI: sem bi_fandi_dashboard cai na RPC da tela e avisa", async () => {
  const c = await ctxPara(MASTER, { bi_fandi_dashboard: () => new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function public.bi_fandi_dashboard" }), { status: 404 }), operational_fandi_dashboard: () => ({ summary: { operational_quantity: 2, total_financed: 100 }, banks: [], plans: [], proposal_outcomes: [] }) });
  const r: any = await executar("analise_fi", { foco: "geral", plano: null, loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(r.resumo.operacoes_financiadas, 2);
  assert(String(r.aviso).includes("bi_fandi_dashboard"));
});

Deno.test("FANDI: timeout da bi_fandi_dashboard cai na RPC da tela com aviso", async () => {
  const c = await ctxPara(MASTER, { bi_fandi_dashboard: () => new Response(JSON.stringify({ code: "57014", message: "canceling statement due to statement timeout" }), { status: 500 }), operational_fandi_dashboard: () => ({ summary: { operational_quantity: 3, total_financed: 100 }, banks: [], plans: [], proposal_outcomes: [] }) });
  const r: any = await executar("analise_fi", { foco: "recusas_por_banco", plano: null, loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(r.resumo.operacoes_financiadas, 3);
  assert(String(r.aviso).includes("demorou"));
});

Deno.test("FANDI: situação das propostas e aviso de base desatualizada", async () => {
  const c = await ctxPara(MASTER);
  // base importada em 02/10 05:15 (SP); período de hoje (02/10) está coberto só até essa hora
  const h: any = await executar("analise_fi", { foco: "faturamento", plano: null, loja: null, departamento: null, periodo: "personalizado", data_inicio: "2026-09-01", data_fim: "2026-09-30" }, c);
  assertEquals(h.situacao_das_propostas.faturadas_ou_pagas, 17);
  assertEquals(h.situacao_das_propostas.recusadas, 9);
  assertEquals(h.situacao_das_propostas.aprovadas_total, 17);
  assertEquals(h.situacao_das_propostas.pct.recusadas, 34.62);
  assertEquals(h.base_aviso, null);
  const fut: any = await executar("analise_fi", { foco: "recusas_por_banco", plano: null, loja: null, departamento: null, periodo: "personalizado", data_inicio: "2026-10-05", data_fim: "2026-10-10" }, c);
  assertEquals(fut.sem_dados_do_periodo, true);
  assert(String(fut.base_aviso).includes("ainda não há propostas deste período"));
});

Deno.test("Acessos: vendedor só vê o próprio salário/score, sem retorno; módulos bloqueiam ferramentas", async () => {
  const V: Usuario = { perfil: "VENDEDOR", loja: "EUROPA", nome: "Ana Souza", modulos: ["simuladorCompleto", "comissoes", "analiseScoreVendedores", "dashbi"] };
  const c = await ctxPara(V);
  const outro: any = await executar("consultar_salario", { pessoa: "Douglas", fechamento: "ultimo_fechado", loja: null }, c);
  assert(String(outro.erro).includes("só o seu próprio salário"), JSON.stringify(outro));
  const sc: any = await executar("consultar_score", { vendedor: null, loja: null, departamento: "NOVOS", periodo: "personalizado", data_inicio: "2026-09-01", data_fim: "2026-09-30" }, c);
  assertEquals(sc.foco.vendedor, "ANA SOUZA");
  assertEquals(sc.ranking, undefined);
  assertEquals((c.blocos!.get("score") as any).ranking.length, 0);
  const sc2: any = await executar("consultar_score", { vendedor: "Bruno", loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assert(String(sc2.erro).includes("só o seu próprio score"));
  const res: any = await executar("resultado_loja", { loja: "Europa", departamento: "NOVOS", periodo: null, data_inicio: null, data_fim: null }, c);
  assert(!JSON.stringify(res).includes("retorno") && !JSON.stringify(res).includes("rentabilidade"), JSON.stringify(res).slice(0, 300));

  const rk: any = await executar("ranking_vendedores", { criterio: "producao", loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }, c);
  assertEquals(rk.ranking, undefined);
  assertEquals(rk.sua_posicao.posicao, 1);
  assert(!JSON.stringify(rk).includes("BRUNO"), JSON.stringify(rk));

  const semMod: Usuario = { perfil: "VENDEDOR", loja: "EUROPA", nome: "Ana Souza", modulos: [] };
  const c2 = await ctxPara(semMod);
  for (const [nome, args] of [
    ["calcular_taxa", { financiado: 90000, prazo: 48, parcela: 2700 }],
    ["simular_cash_conversion", { simulacao_id: null, parcela: 2985, prazo: 60, capital: 90000, taxa_aplicacao_mensal: null }],
    ["resultado_loja", { loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }],
    ["analise_fi", { foco: "geral", plano: null, loja: null, departamento: null, periodo: null, data_inicio: null, data_fim: null }],
    ["consultar_salario", { pessoa: null, fechamento: "competencia_atual", loja: null }],
  ] as const) {
    const r: any = await executar(nome, args, c2);
    assert(String(r.erro).includes("não tem acesso"), `${nome}: ${JSON.stringify(r)}`);
  }
});

Deno.test("Salário: analista vê vendedores de Novos e Seminovos da loja, na competência atual e na anterior (como a tela)", async () => {
  const A: Usuario = { perfil: "ANALISTA", loja: "ALPHAVILLE", nome: "Douglas Teste", modulos: ["comissoes"] };
  const c = await ctxPara(A);
  const n: any = await executar("consultar_salario", { pessoa: "Carlos", fechamento: "competencia_atual", loja: null }, c);
  assertEquals(n.comissao_total, 1000);
  const sAtual: any = await executar("consultar_salario", { pessoa: "Paula", fechamento: "competencia_atual", loja: null }, c);
  assertEquals(sAtual.comissao_total, 800);
  assertEquals(sAtual.pessoa.departamento, "SEMINOVOS");
  const ant: any = await executar("consultar_salario", { pessoa: "Paula", fechamento: "ultimo_fechado", loja: null }, c);
  assertEquals(ant.comissao_total, 800);
  assertEquals(ant.oficial, false);
  assert(String(ant.origem).includes("calculados pelo Portal"), ant.origem);
  assert(!String(ant.competencia).includes("2026-09-21 a 2026-10-20"), ant.competencia);
  const fora: any = await executar("consultar_salario", { pessoa: "Fulano Outra Loja", fechamento: "competencia_atual", loja: null }, c);
  assert(String(fora.mensagem).includes("Não encontrei") || String(fora.mensagem).includes("fora do seu escopo"), JSON.stringify(fora));
});

// ---------------- Planos com subsídio completos (layout do Simulador) ----------------
const PC = (plano: string, extra: Record<string, unknown> = {}) => ({ ...VEIC, plano, entrada: null, prazos: null, ...extra });

Deno.test("Coparticipado: todos os prazos com taxa e parcela, entrada mínima e rebate total/HPE/Brabus", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_plano_campanha", PC("COPARTICIPADO", { modelo: "Eclipse", versao: "HPE" }), c);
  assertEquals(r.modelo_tabela, "ECLIPSE CROSS HPE");
  assertEquals(r.entrada_minima, 108000);
  assertEquals(r.entrada, 108000);
  assertEquals(r.prazos_do_plano, [12, 18, 24, 36, 48, 60]);
  assert(r.linhas.every((l: any) => l.parcela > 0 && typeof l.taxa_pct_am === "number" && l.simulacao_id), JSON.stringify(r.linhas));
  assert(r.linhas[0].parcela > r.linhas[5].parcela, "parcela cai com o prazo");
  assertEquals(Math.round((r.rebate.hpe + r.rebate.brabus) * 100), Math.round(r.rebate.total * 100));
  assertEquals(r.valor_final_venda, Math.round((180000 - r.rebate.brabus) * 100) / 100);
  const b: any = c.blocos!.get("plano");
  assertEquals(b.tipo, "plano");
  assertEquals(b.linhas.length, 6);
  assert(b.rebate.total > 0);
});

Deno.test("Coparticipado: entrada abaixo do mínimo e modelo fora do plano dão erro claro", async () => {
  const c = await ctxPara(MASTER);
  const e1: any = await executar("simular_plano_campanha", PC("COPARTICIPADO", { entrada: 50000 }), c);
  assert(String(e1.erro).includes("60"), JSON.stringify(e1));
  const e2: any = await executar("simular_plano_campanha", PC("COPARTICIPADO", { modelo: "Pajero", versao: "Sport" }), c);
  assert(String(e2.erro).includes("não está no Plano Coparticipado"), JSON.stringify(e2));
});

Deno.test("Taxa Subsidiada: taxas × prazos com rebate, valor final e taxa a cadastrar no banco", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_plano_campanha", PC("TAXA_SUBSIDIADA"), c);
  assertEquals(r.entrada_minima, 90000);
  assert(r.taxas_pct_am.includes(0) && r.taxas_pct_am.length >= 3, JSON.stringify(r.taxas_pct_am));
  assert(r.linhas.every((l: any) => l.rebate > 0 && l.valor_final_venda > 0 && l.parcela > 0));
  assert(r.linhas.some((l: any) => l.taxa_banco_cadastrar_pct_am != null));
  assertEquals(r.linhas.filter((l: any) => l.melhor_valor_final).length, 1);
  const e: any = await executar("simular_plano_campanha", PC("TAXA_SUBSIDIADA", { entrada: 40000 }), c);
  assert(String(e.erro).includes("50%"), JSON.stringify(e));
});

Deno.test("Semestral Taxa 0%: entrada fixa, 4 semestrais e rebate total/HPE/Brabus; Eclipse fora da campanha", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("simular_plano_campanha", { ...PC("SEMESTRAL_TAXA_ZERO"), modelo: "Triton", versao: "Katana", valor_veiculo: 300000, entrada: 100000 }, c);
  assertEquals(r.modelo_tabela, "TRITON KATANA");
  assertEquals(r.entrada_fixa, true);
  assertEquals(r.pagamentos.map((p: any) => p.mes), [6, 12, 18, 24]);
  assertEquals(r.taxa_pct_am, 0);
  assert(r.avisos.some((x: string) => x.includes("entrada é fixa")));
  assertEquals(Math.round((r.rebate.hpe + r.rebate.brabus) * 100), Math.round(r.rebate.total * 100));
  const e: any = await executar("simular_plano_campanha", PC("SEMESTRAL_TAXA_ZERO"), c);
  assert(String(e.erro).includes("Semestral Taxa 0%"), JSON.stringify(e));
});

Deno.test("Planos com subsídio: Vendedor com simulador vê o rebate (a tela do Portal também mostra)", async () => {
  const c = await ctxPara(VENDEDOR);
  const r: any = await executar("simular_plano_campanha", PC("COPARTICIPADO"), c);
  assert(r.rebate?.brabus > 0, JSON.stringify(r).slice(0, 300));
});

Deno.test("Salário: nome com grafia diferente encontra a pessoa e avisa qual nome considerou", async () => {
  const c = await ctxPara(MASTER);
  const r: any = await executar("consultar_salario", { pessoa: "Duglas Ferreyra", fechamento: "ultimo_fechado", loja: null }, c);
  assertEquals(r.pessoa.nome, "DOUGLAS FERREIRA");
  assert(String(r.aviso_nome).includes("DOUGLAS FERREIRA"), JSON.stringify(r.aviso_nome));
  const ex: any = await executar("consultar_salario", { pessoa: "Douglas Ferreira", fechamento: "ultimo_fechado", loja: null }, c);
  assertEquals(ex.aviso_nome, undefined);
  const p: any = await executar("consultar_salario", { pessoa: "Karlos Novoz", fechamento: "competencia_atual", loja: null }, c);
  assertEquals(p.pessoa.nome, "CARLOS NOVOS");
});

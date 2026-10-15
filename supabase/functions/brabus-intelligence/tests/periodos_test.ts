// Testes da ferramenta comparar_periodos (comparativo no tempo, 15/10/2026). Dados 100% fictícios.
import { assert, assertEquals } from "./assert.ts";
import { executar, type ToolCtx } from "../agent/ferramentas.ts";
import { montaLinhas, planejaColunas, agregaMetricas } from "../agent/periodos.ts";
import { RpcError } from "../data/rpc.ts";
import type { Contexto } from "../data/contexto.ts";
import { systemPrompt } from "../agent/prompt.ts";

// ---------------------------------------------------------------------
// Base fictícia: fatos diários por vendedor/loja/departamento, agregados como operational_metrics devolve
// ---------------------------------------------------------------------
type Fato = { dia: string; loja: string; dep: string; vend: string; sid: string; vendidos: number; fin: number; prod: number; ret: number; spf: number };
const FATOS: Fato[] = [];
const add = (dia: string, loja: string, dep: string, vend: string, vendidos: number, fin: number, prod: number, ret: number, spf = 0) =>
  FATOS.push({ dia, loja, dep, vend, sid: "id-" + vend, vendidos, fin, prod, ret, spf });
// Bandeirantes Novos: 01–15/09 sem financiamento (como no caso real), 16–30/09 com 8; outubro 01–15 com 5
add("2026-09-05", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO UM", 4, 0, 0, 0);
add("2026-09-12", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO DOIS", 3, 0, 0, 0);
add("2026-09-20", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO UM", 9, 5, 600000, 30000, 2);
add("2026-09-28", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO DOIS", 6, 3, 350000, 14310, 1);
add("2026-10-03", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO UM", 5, 3, 500000, 20000, 2);
add("2026-10-10", "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO DOIS", 3, 2, 312665, 14708.38, 1);
// meses anteriores (mês a mês)
for (const [m, v, f] of [["05", 10, 4], ["06", 12, 6], ["07", 8, 3], ["08", 15, 9]] as const) {
  add(`2026-${m}-10`, "BANDEIRANTES", "NOVOS", "VENDEDOR FICTICIO UM", v, f, f * 100000, f * 5000, 1);
}
// outra loja / Seminovos (não podem vazar para o recorte Bandeirantes Novos)
add("2026-09-08", "BANDEIRANTES", "SEMINOVOS", "VENDEDOR FICTICIO TRES", 12, 10, 700000, 40000, 3);
add("2026-10-08", "EUROPA", "NOVOS", "VENDEDOR FICTICIO EUROPA", 7, 4, 400000, 18000, 2);

function metricas(ini: string, fim: string, opts: { ocultarOutrasLojasDe?: string } = {}) {
  const por = new Map<string, any>();
  for (const f of FATOS) {
    if (f.dia < ini || f.dia > fim) continue;
    const k = `${f.sid}|${f.loja}|${f.dep}`;
    const x = por.get(k) ?? { seller_id: f.sid, seller_name: f.vend, store: f.loja, department: f.dep, sold_count: 0, financed_count: 0, production_value: 0, return_value: 0, spf_count: 0, spf_value: 0, plan_breakdown: [] };
    x.sold_count += f.vendidos; x.financed_count += f.fin; x.production_value += f.prod; x.return_value += f.ret; x.spf_count += f.spf; x.spf_value += f.spf * 1000;
    por.set(k, x);
  }
  let rows = [...por.values()];
  if (opts.ocultarOutrasLojasDe) {
    // como o servidor faz para analista/gerente: vendedores de outras lojas sem retorno + linha 'RETORNO DA LOJA'
    const loja = opts.ocultarOutrasLojasDe;
    const tot = new Map<string, number>();
    rows = rows.map((x) => {
      if (x.store === loja) return x;
      tot.set(`${x.store}|${x.department}`, (tot.get(`${x.store}|${x.department}`) ?? 0) + x.return_value);
      const { return_value: _r, ...sem } = x;
      return { ...sem, retorno_oculto: true };
    });
    for (const [k, v] of tot) {
      const [store, department] = k.split("|");
      rows.push({ seller_id: null, seller_name: "RETORNO DA LOJA", agregado_loja: true, somente_retorno: true, store, department, sold_count: 0, financed_count: 0, production_value: 0, spf_count: 0, spf_value: 0, return_value: v, plan_breakdown: [] });
    }
  }
  return { rows };
}
function modelos(ini: string, fim: string) {
  const base = metricas(ini, fim).rows;
  // dois modelos fictícios: divide o resultado de cada linha 60/40
  return { rows: base.flatMap((x: any) => [
    { model: "ECLIPSE CROSS HPE", store: x.store, department: x.department, sold_count: Math.round(x.sold_count * 0.6), financed_count: Math.round(x.financed_count * 0.6), production_value: x.production_value * 0.6, return_value: x.return_value * 0.6, spf_count: 0, spf_value: 0, plan_breakdown: [] },
    { model: "TRITON SPORT GLS", store: x.store, department: x.department, sold_count: x.sold_count - Math.round(x.sold_count * 0.6), financed_count: x.financed_count - Math.round(x.financed_count * 0.6), production_value: x.production_value * 0.4, return_value: x.return_value * 0.4, spf_count: 0, spf_value: 0, plan_breakdown: [] },
  ]) };
}

const U = (perfil: Contexto["perfil"], loja: string | null, nome = "Usuario Ficticio"): Contexto =>
  ({ nome, perfil, perfil_bruto: perfil, loja, departamentos: ["NOVOS", "SEMINOVOS"], modulos: ["dashbi", "gestao"] });

function ctxPara(usuario: Contexto, o: { ocultar?: string; falhaPrimeira?: boolean; atraso?: number } = {}) {
  const chamadas: string[] = [];
  let ativas = 0, maxAtivas = 0, falhou = false;
  const ctx: ToolCtx & { chamadas: string[]; maxAtivas: () => number } = {
    rpc: {
      call: async (fn: string, a: any) => {
        ativas++; maxAtivas = Math.max(maxAtivas, ativas);
        try {
          await new Promise((ok) => setTimeout(ok, o.atraso ?? 5));
          chamadas.push(`${fn} ${a.p_start}..${a.p_end}`);
          if (o.falhaPrimeira && !falhou) { falhou = true; throw new RpcError(fn, 504, null, "Tempo esgotado ao consultar o Portal."); }
          return fn === "operational_model_metrics" ? modelos(a.p_start, a.p_end) : metricas(a.p_start, a.p_end, { ocultarOutrasLojasDe: o.ocultar });
        } finally { ativas--; }
      },
    } as any,
    bases: null as any, usuario, store: { auditar: async () => {} } as any,
    sessao: "t", canal: "portal", hoje: "2026-10-15", uuid: () => crypto.randomUUID(), cache: new Map(),
    chamadas, maxAtivas: () => maxAtivas,
  };
  return ctx;
}
const NULOS = { meses: null, data_inicio: null, data_fim: null, intervalos: null, loja: null, departamento: null, modelo: null, versao: null, modelos: null, vendedor: null };
const MASTER = U("MASTER", null, "Master Ficticio");
const linha = (r: any, rot: string) => (r.indicadores as any[]).find((x) => x.indicador === rot);

// ---------------------------------------------------------------------
// Colunas (comparação justa)
// ---------------------------------------------------------------------
Deno.test("colunas: mês parcial (01–15/10) × MESMO trecho do anterior (01–15/09); setembro inteiro só como referência", () => {
  const c = planejaColunas("atual_vs_anterior", "2026-10-15", {});
  assertEquals(c.map((x) => [x.papel, x.inicio, x.fim, x.parcial]), [["base", "2026-09-01", "2026-09-15", false], ["atual", "2026-10-01", "2026-10-15", true], ["referencia", "2026-09-01", "2026-09-30", false]]);
  const d = planejaColunas("atual_vs_anterior", "2026-10-15", { data_inicio: "2026-10-01", data_fim: "2026-10-15" });
  assertEquals(d.map((x) => [x.inicio, x.fim]), c.map((x) => [x.inicio, x.fim]));
});
Deno.test("colunas: 31/10 vira 30/09 no mês anterior; mês fechado não tem referência", () => {
  const c = planejaColunas("atual_vs_anterior", "2026-11-05", { data_inicio: "2026-10-01", data_fim: "2026-10-31" });
  assertEquals(c.map((x) => [x.papel, x.inicio, x.fim]), [["base", "2026-09-01", "2026-09-30"], ["atual", "2026-10-01", "2026-10-31"]]);
  const d = planejaColunas("atual_vs_anterior", "2026-11-05", { data_inicio: "2026-10-10", data_fim: "2026-10-31" });
  assertEquals(d[0].fim, "2026-09-30", "trecho que termina no último dia termina no último dia do mês anterior");
});
Deno.test("colunas: mês a mês de 6 meses (mai..out), outubro parcial", () => {
  const c = planejaColunas("mes_a_mes", "2026-10-15", { meses: 6 });
  assertEquals(c.map((x) => x.rotulo), ["mai/26", "jun/26", "jul/26", "ago/26", "set/26", "out/26"]);
  assertEquals(c.map((x) => x.parcial), [false, false, false, false, false, true]);
  assertEquals(c[5].fim, "2026-10-15");
});

// ---------------------------------------------------------------------
// Conversa de referência (Bandeirantes Novos), com os argumentos que o modelo deve mandar
// ---------------------------------------------------------------------
Deno.test("referência 1: 'e comparado ao mês anterior?' → 01–15/10 × 01–15/09 com datas, base zero vira '0 → N'", async () => {
  const ctx = ctxPara(MASTER);
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", loja: "Bandeirantes", departamento: "NOVOS" }, ctx);
  assert(!r.erro, r.erro);
  assert(r.comparacao.includes("01/10/2026 a 15/10/2026 × 01/09/2026 a 15/09/2026"), r.comparacao);
  assertEquals(linha(r, "Vendidos").por_periodo.map((x: any) => x.valor), [7, 8, 22]);
  assertEquals(linha(r, "Vendidos").variacao, "+14.29%");
  assert(String(linha(r, "Financiados").variacao).startsWith("de 0 para 5"), linha(r, "Financiados").variacao);
  const b: any = [...ctx.blocos!.values()][0];
  assertEquals(b.tipo, "periodos");
  const fin = b.linhas.find((l: any) => l.indicador === "financiados");
  assertEquals([fin.variacao, fin.base_zero], [null, { de: 0, para: 5, diferenca: 5 }]);
  assert(b.colunas.every((c: any) => /\d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/.test(c.datas)), "toda coluna tem datas");
  // a referência nunca é base: a variação de vendidos é 8 × 7, não 8 × 22
  assertEquals(b.linhas[0].variacao, 14.29);
});
Deno.test("referência 2: 'consegue fazer um comparativo dos dois períodos?' → a ferramenta compara UMA loja no tempo (sem erro)", async () => {
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "intervalos", loja: "Bandeirantes", departamento: "NOVOS",
    intervalos: [{ inicio: "2026-10-01", fim: "2026-10-15" }, { inicio: "2026-09-01", fim: "2026-09-15" }] }, ctxPara(MASTER));
  assert(!r.erro, r.erro);
  assertEquals(r.periodos.map((p: any) => p.datas), ["01/09/2026 a 15/09/2026", "01/10/2026 a 15/10/2026"]);
  assertEquals(linha(r, "Vendidos").variacao, "+14.29%");
});
Deno.test("referência 3: 'últimos 60 dias' + 'separado mês a mês' → 3 meses, sem estourar o banco (no máx. 2 consultas juntas)", async () => {
  const ctx = ctxPara(MASTER, { atraso: 30 });
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "mes_a_mes", meses: 3, loja: "Bandeirantes", departamento: "NOVOS" }, ctx);
  assert(!r.erro, r.erro);
  assertEquals(r.periodos.map((p: any) => p.periodo ?? p.rotulo), ["ago/26", "set/26", "out/26"]);
  assert(r.periodos[2].parcial === true, "outubro é parcial");
  assert(ctx.maxAtivas() <= 2, `consultas simultâneas: ${ctx.maxAtivas()}`);
  assertEquals(ctx.chamadas.length, 3);
});
Deno.test("tempo esgotado (504) na 1ª consulta: tenta de novo e responde", async () => {
  const ctx = ctxPara(MASTER, { falhaPrimeira: true });
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", loja: "Bandeirantes", departamento: "NOVOS" }, ctx);
  assert(!r.erro, r.erro);
  assertEquals(ctx.chamadas.length, 4, "3 períodos + 1 nova tentativa");
});

// ---------------------------------------------------------------------
// Mês a mês, intervalos, modelos
// ---------------------------------------------------------------------
Deno.test("mês a mês de 6 meses: variação = último mês completo × anterior; melhor/pior sem o mês parcial", async () => {
  const ctx = ctxPara(MASTER);
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "mes_a_mes", meses: 6, loja: "Bandeirantes", departamento: "NOVOS" }, ctx);
  assert(r.comparacao.includes("01/09/2026 a 30/09/2026 × 01/08/2026 a 31/08/2026"), r.comparacao);
  const v = linha(r, "Vendidos");
  assertEquals(v.por_periodo.map((x: any) => x.valor), [10, 12, 8, 15, 22, 8]);
  assertEquals([v.melhor_mes, v.pior_mes], ["set/26", "jul/26"]);
  const b: any = [...ctx.blocos!.values()][0];
  assert(b.linhas[0].melhor !== 5 && b.linhas[0].pior !== 5, "outubro (parcial) fora de melhor/pior");
});
Deno.test("intervalos de tamanhos diferentes: sem variação (nunca 'subiu/caiu')", async () => {
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "intervalos", loja: "Bandeirantes", departamento: "NOVOS",
    intervalos: [{ inicio: "2026-10-01", fim: "2026-10-15" }, { inicio: "2026-09-01", fim: "2026-09-30" }] }, ctxPara(MASTER));
  assert((r.indicadores as any[]).every((x) => x.variacao == null), "sem variação");
  assert(r.comparacao.includes("tamanhos diferentes"), r.comparacao);
});
Deno.test("dois modelos no mesmo período: lado a lado (cartão de comparação, com as datas)", async () => {
  const ctx = ctxPara(MASTER);
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "modelos", modelos: ["Eclipse Cross", "Triton"], loja: "Bandeirantes", departamento: "NOVOS" }, ctx);
  assert(!r.erro, r.erro);
  assertEquals(r.modelos.map((m: any) => m.modelo), ["Eclipse Cross", "Triton"]);
  const b: any = [...ctx.blocos!.values()][0];
  assertEquals([b.tipo, b.lojas, b.periodo], ["comparacao", ["Eclipse Cross", "Triton"], "01/10/2026 a 15/10/2026"]);
});
Deno.test("um modelo ao longo dos meses (mês a mês)", async () => {
  const r: any = await executar("comparar_periodos", { ...NULOS, modo: "mes_a_mes", meses: 3, modelo: "Eclipse Cross", loja: "Bandeirantes", departamento: "NOVOS" }, ctxPara(MASTER));
  assert(!r.erro, r.erro);
  assert(r.escopo.includes("Eclipse Cross"), r.escopo);
  assertEquals(linha(r, "Vendidos").por_periodo.map((x: any) => x.valor), [9, 13, 5]);
});

// ---------------------------------------------------------------------
// Perfis
// ---------------------------------------------------------------------
Deno.test("perfil Vendedor: só o próprio nome; nunca retorno", async () => {
  const eu = U("VENDEDOR", "BANDEIRANTES", "Vendedor Ficticio Um");
  const outro: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", vendedor: "Vendedor Ficticio Dois" }, ctxPara(eu));
  assert(String(outro.erro).includes("próprios"), outro.erro);
  const meu: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", vendedor: "Vendedor Ficticio Um" }, ctxPara(eu));
  assert(!meu.erro, meu.erro);
  assertEquals(linha(meu, "Vendidos").por_periodo.map((x: any) => x.valor), [4, 5, 13]);
  assert(!(meu.indicadores as any[]).some((x) => x.indicador === "Retorno"), "vendedor não recebe a linha de retorno");
  assert(!JSON.stringify(meu).includes("return"), "nenhum campo de retorno");
});
Deno.test("perfil Gerente: outra loja tem o total de retorno; vendedor de outra loja vem sem retorno ('—')", async () => {
  const g = U("GERENTE", "BANDEIRANTES", "Gerente Ficticio");
  const loja: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", loja: "Europa" }, ctxPara(g, { ocultar: "BANDEIRANTES" }));
  assertEquals(linha(loja, "Retorno").por_periodo[1].valor, 18000, "total da loja vem da linha RETORNO DA LOJA");
  const vend: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", vendedor: "Vendedor Ficticio Europa" }, ctxPara(g, { ocultar: "BANDEIRANTES" }));
  assertEquals(linha(vend, "Vendidos").por_periodo[1].valor, 7);
  assertEquals(linha(vend, "Retorno").por_periodo[1].valor, null, "retorno do vendedor de outra loja não é exibido");
  const propria: any = await executar("comparar_periodos", { ...NULOS, modo: "atual_vs_anterior", vendedor: "Vendedor Ficticio Um" }, ctxPara(g, { ocultar: "BANDEIRANTES" }));
  assertEquals(linha(propria, "Retorno").por_periodo[1].valor, 20000, "vendedor da própria loja com retorno");
});

// ---------------------------------------------------------------------
// Instruções do modelo
// ---------------------------------------------------------------------
Deno.test("prompt: comparação no tempo sempre pela ferramenta; nunca concluir com períodos de tamanhos diferentes; SPF em quantidade", () => {
  const p = systemPrompt({ nome: "X", perfil: "MASTER", perfil_bruto: "MASTER", loja: null, departamentos: [], modulos: [] } as any, "2026-10-15", "portal");
  assert(p.includes("use SEMPRE comparar_periodos"), "regra da ferramenta");
  assert(p.includes("tamanhos diferentes"), "regra dos tamanhos");
  assert(p.includes("N SPF"), "regra do SPF");
});

Deno.test("agregação: Seminovos e outras lojas não entram no recorte Bandeirantes Novos", () => {
  const a = agregaMetricas(metricas("2026-09-01", "2026-09-15").rows, { loja: "BANDEIRANTES", departamento: "NOVOS", vendedor: null });
  assertEquals([a.vendidos, a.financiados], [7, 0]);
  const cols = planejaColunas("atual_vs_anterior", "2026-10-15", {});
  const { linhas } = montaLinhas("atual_vs_anterior", cols, [a, a, a], false);
  assert(linhas.every((l) => l.indicador !== "retorno"), "sem retorno quando o perfil não vê");
});

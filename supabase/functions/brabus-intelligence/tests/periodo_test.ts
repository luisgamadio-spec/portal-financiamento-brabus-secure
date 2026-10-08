// Períodos livres na BI (bug de 08/10/2026: "últimos 60 dias" virou 90 no ranking de vendedores).
// Regra: qualquer "últimos N dias" ou intervalo de datas é aceito; a saída sempre traz o período REAL
// (rótulo com datas + início/fim) e a loja/escopo considerado.
import { assert, assertEquals } from "./assert.ts";
import { fakeFetch, METRICS_ATUAL, type Usuario } from "./fake_supabase.ts";
import { Rpc } from "../data/rpc.ts";
import { Bases } from "../data/bases.ts";
import { carregaContexto } from "../data/contexto.ts";
import { storeMemoria } from "../data/store.ts";
import { DEFINICOES, executar, type ToolCtx } from "../agent/ferramentas.ts";
import { resolvePeriodo } from "../data/lojas_periodos.ts";

const MASTER: Usuario = { perfil: "MASTER", loja: null, nome: "Luis", modulos: [] };
const GERENTE: Usuario = { perfil: "GERENTE", loja: "EUROPA", nome: "Gil", modulos: ["dashbi"] };
const VENDEDOR: Usuario = { perfil: "VENDEDOR", loja: "EUROPA", nome: "Ana Souza", modulos: ["dashbi"] };
const HOJE = "2026-10-08";

async function ctxCom(u: Usuario, chamadas: any[]): Promise<ToolCtx> {
  const extra = { operational_metrics: (b: any) => { chamadas.push(b); return METRICS_ATUAL; } };
  const rpc = new Rpc("https://x.supabase.co", "anon", "jwt", fakeFetch(u, extra) as any);
  let n = 0;
  return { rpc, bases: new Bases(rpc), usuario: await carregaContexto(rpc), store: storeMemoria(), sessao: "s", canal: "portal",
    hoje: HOJE, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, cache: new Map() };
}
const RANK = { criterio: "vendidos", loja: null, departamento: "NOVOS", periodo: null, dias: null, data_inicio: null, data_fim: null };

Deno.test("período: 'últimos 60 dias' = 60 dias corridos até hoje, com as datas no rótulo", () => {
  const r: any = resolvePeriodo("ultimos_dias", HOJE, [], null, null, 60);
  assertEquals([r.inicio, r.fim], ["2026-08-10", "2026-10-08"]);
  assertEquals(r.rotulo, "últimos 60 dias (10/08/2026 a 08/10/2026)");
  // qualquer N, não só 30/90
  for (const n of [1, 7, 45, 60, 120, 365]) {
    const x: any = resolvePeriodo("ultimos_dias", HOJE, [], null, null, n);
    assertEquals(Math.round((Date.parse(x.fim) - Date.parse(x.inicio)) / 86400000) + 1, n, `N=${n}`);
  }
  // atalhos continuam e agora também mostram as datas
  assertEquals((resolvePeriodo("ultimos_90", HOJE, []) as any).rotulo, "últimos 90 dias (11/07/2026 a 08/10/2026)");
});

Deno.test("período: intervalo com datas e 'desde' (sem data final = até hoje); inválidos dão erro claro", () => {
  const a: any = resolvePeriodo("personalizado", HOJE, [], "2026-09-01", "2026-09-15");
  assertEquals([a.inicio, a.fim, a.rotulo], ["2026-09-01", "2026-09-15", "01/09/2026 a 15/09/2026"]);
  const b: any = resolvePeriodo("personalizado", HOJE, [], "2026-09-21", null);
  assertEquals([b.inicio, b.fim], ["2026-09-21", HOJE]);
  for (const n of [0, -5, 800, 2.5, null]) assert("erro" in (resolvePeriodo("ultimos_dias", HOJE, [], null, null, n as any) as any), `dias=${n}`);
  assert("erro" in (resolvePeriodo("personalizado", HOJE, [], "2026-09-15", "2026-09-01") as any), "fim antes do início");
});

Deno.test("schema: TODAS as ferramentas com período aceitam ultimos_dias + dias e intervalo livre", () => {
  const comPeriodo = (DEFINICOES as any[]).filter((d) => d.parameters.properties.periodo);
  assertEquals(comPeriodo.map((d) => d.name).sort(),
    ["analise_fi", "comparar_lojas", "consultar_score", "historico_vendas", "ranking_vendedores", "resultado_loja"]);
  for (const d of comPeriodo) {
    const p = d.parameters.properties;
    assert(p.periodo.enum.includes("ultimos_dias"), d.name);
    assert(p.dias && p.data_inicio && p.data_fim, d.name);
    assert(/nunca outro/i.test(p.periodo.description), d.name);
  }
});

Deno.test("conversa real (MASTER): 60 dias → grupo todo → correção do usuário: sempre 60 dias, sem trocar por 90", async () => {
  const chamadas: any[] = [];
  const c = await ctxCom(MASTER, chamadas);
  // 1) "Quem foi o vendedor que mais vendeu carros novos nos últimos 60 dias?" — loja herdada da conversa (Analia Franco)
  const r1: any = await executar("ranking_vendedores", { ...RANK, loja: "ANALIA FRANCO", periodo: "ultimos_dias", dias: 60 }, c);
  // 2) "E no grupo todo?"
  const r2: any = await executar("ranking_vendedores", { ...RANK, periodo: "ultimos_dias", dias: 60 }, c);
  // 3/4) "e nos últimos 60 dias?" / "ué, eu te pedi em 60 dias."
  const r3: any = await executar("ranking_vendedores", { ...RANK, periodo: "ultimos_dias", dias: 60 }, c);
  for (const ch of chamadas) assertEquals([ch.p_start, ch.p_end], ["2026-08-10", "2026-10-08"], "RPC com os 60 dias pedidos");
  for (const r of [r1, r2, r3]) {
    assertEquals(r.periodo, "últimos 60 dias (10/08/2026 a 08/10/2026)");
    assertEquals([r.periodo_inicio, r.periodo_fim], ["2026-08-10", "2026-10-08"]);
    assert(!/90/.test(r.periodo), "nunca 90");
  }
  assertEquals(r1.loja_considerada, "ANALIA FRANCO", "a loja herdada aparece na saída para a resposta dizer");
  assertEquals(r2.loja_considerada, "todas as lojas (Grupo)");
});

Deno.test("intervalo 'de 01/09 a 15/09': RPC e saída com exatamente essas datas, em todas as ferramentas de período", async () => {
  const chamadas: any[] = [];
  const c = await ctxCom(MASTER, chamadas);
  const per = { periodo: "personalizado", dias: null, data_inicio: "2026-09-01", data_fim: "2026-09-15" };
  const rk: any = await executar("ranking_vendedores", { ...RANK, ...per }, c);
  const rl: any = await executar("resultado_loja", { loja: null, departamento: null, ...per }, c);
  assertEquals(chamadas[0].p_start + "|" + chamadas[0].p_end, "2026-09-01|2026-09-15");
  for (const r of [rk, rl]) {
    assertEquals(r.periodo, "01/09/2026 a 15/09/2026");
    assertEquals([r.periodo_inicio, r.periodo_fim], ["2026-09-01", "2026-09-15"]);
  }
  assertEquals(rl.loja_considerada, "todas as lojas (Grupo)");
});

Deno.test("loja considerada: gerente sem loja = a própria loja; com loja = a pedida", async () => {
  const c = await ctxCom(GERENTE, []);
  const sem: any = await executar("ranking_vendedores", { ...RANK, periodo: "ultimos_dias", dias: 60 }, c);
  assertEquals(sem.loja_considerada, "sua loja (EUROPA)");
  const com: any = await executar("ranking_vendedores", { ...RANK, loja: "EUROPA", periodo: "ultimos_dias", dias: 60 }, c);
  assertEquals(com.loja_considerada, "EUROPA");
});

Deno.test("loja considerada: MASTER (escopo do servidor vem com 'MASTER', não é loja) = Grupo", async () => {
  const c = await ctxCom({ perfil: "MASTER", loja: "MASTER", nome: "Luis", modulos: [] }, []);
  const r: any = await executar("ranking_vendedores", { ...RANK, periodo: "ultimos_dias", dias: 60 }, c);
  assertEquals(r.loja_considerada, "todas as lojas (Grupo)");
});

Deno.test("ranking no perfil Vendedor: só a própria posição, nenhum nome nem número de colega", async () => {
  const c = await ctxCom(VENDEDOR, []);
  const r: any = await executar("ranking_vendedores", { ...RANK, departamento: null, periodo: "ultimos_dias", dias: 60 }, c);
  const txt = JSON.stringify(r);
  assert(r.ranking === undefined, "sem lista");
  for (const outro of ["BRUNO LIMA", "CARLA DIAS", "DIEGO SEMI", "REVENDA X"]) assert(!txt.includes(outro), `vazou ${outro}`);
  assertEquals(r.periodo, "últimos 60 dias (10/08/2026 a 08/10/2026)");
  assertEquals(r.loja_considerada, "só os seus números (perfil Vendedor)");
  // sem posição/total: o servidor só devolve o próprio vendedor (posição "1 de 1" seria enganosa)
  assertEquals(r.sua_posicao, undefined);
  assertEquals(r.total_vendedores, undefined);
  assert(r.seus_numeros && typeof r.seus_numeros.vendidos === "number", JSON.stringify(r));
});

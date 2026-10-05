// Laço modelo ↔ ferramentas com um "modelo" roteirizado (sem rede).
import { assert, assertEquals } from "./assert.ts";
import { fakeFetch } from "./fake_supabase.ts";
import { Rpc } from "../data/rpc.ts";
import { Bases } from "../data/bases.ts";
import { carregaContexto } from "../data/contexto.ts";
import { storeMemoria } from "../data/store.ts";
import { conversar } from "../agent/loop.ts";
import type { ChamadaFerramenta, Llm, RespostaLlm } from "../agent/llm.ts";

class Roteiro implements Llm {
  vistos: unknown[][] = [];
  constructor(private passos: ((itens: any[]) => RespostaLlm)[]) {}
  async passo(_i: string, itens: unknown[]): Promise<RespostaLlm> { this.vistos.push([...itens]); return this.passos[this.vistos.length - 1](itens as any[]); }
  resultado(c: ChamadaFerramenta, s: unknown) { return { type: "function_call_output", call_id: c.id, output: JSON.stringify(s) }; }
  mensagem(p: "user" | "assistant", t: string) { return { role: p, content: t }; }
}

async function ctx() {
  const rpc = new Rpc("https://x", "anon", "jwt", fakeFetch({ perfil: "MASTER", loja: null, nome: "Luis", modulos: [] }) as any);
  return { rpc, bases: new Bases(rpc), usuario: await carregaContexto(rpc), store: storeMemoria(), sessao: "s", canal: "portal", hoje: "2026-10-02", uuid: () => crypto.randomUUID(), cache: new Map() };
}

Deno.test("loop: chama ferramenta, devolve o resultado ao modelo e termina com texto", async () => {
  const llm = new Roteiro([
    () => ({ itens: [{ type: "function_call", call_id: "c1" }], chamadas: [{ id: "c1", nome: "resultado_loja", args: { loja: "Europa", departamento: "NOVOS", periodo: null, data_inicio: null, data_fim: null } }], texto: "" }),
    (itens) => {
      const out = itens.find((x) => x.type === "function_call_output");
      const dado = JSON.parse(out.output);
      return { itens: [], chamadas: [], texto: `Europa financiou ${dado.lojas[0].financiados}.` };
    },
  ]);
  const r = await conversar(llm, await ctx(), [{ papel: "user", texto: "oi" }, { papel: "assistant", texto: "olá" }], "Resultado da Europa?");
  assertEquals(r.texto, "Europa financiou 10.");
  assertEquals(r.ferramentas, [{ nome: "resultado_loja", ok: true }]);
  // o histórico entra só como texto
  assertEquals((llm.vistos[0] as any[]).length, 3);
});

Deno.test("loop: para em 8 passos se o modelo não parar de chamar ferramentas", async () => {
  const sempre = () => ({ itens: [], chamadas: [{ id: "x", nome: "consultar_manual", args: { pergunta: "balão" } }], texto: "" });
  const r = await conversar(new Roteiro(Array(10).fill(sempre)), await ctx(), [], "?");
  assertEquals(r.passos, 8);
  assert(r.texto.includes("longa"));
});

Deno.test("loop: ferramenta desconhecida vira erro para o modelo, não exceção", async () => {
  const llm = new Roteiro([
    () => ({ itens: [], chamadas: [{ id: "c", nome: "apagar_tudo", args: {} }], texto: "" }),
    (itens) => ({ itens: [], chamadas: [], texto: JSON.parse(itens.at(-1).output).erro }),
  ]);
  const r = await conversar(llm, await ctx(), [], "?");
  assert(r.texto.includes("desconhecida"));
});

Deno.test("OpenAI 429: espera e tenta de novo; se continuar, vira LimiteLlm", async () => {
  const { OpenAiLlm, LimiteLlm } = await import("../agent/llm.ts");
  let n = 0;
  const ok = { output: [{ type: "message", content: [{ type: "output_text", text: "oi" }] }] };
  const f1 = (async () => (++n === 1 ? new Response('{"error":{"message":"Please try again in 0.01s."}}', { status: 429 }) : new Response(JSON.stringify(ok)))) as any;
  const r = await new OpenAiLlm("k", "m", f1).passo("i", [], []);
  assertEquals(r.texto, "oi");
  assertEquals(n, 2);
  const f2 = (async () => new Response('{"error":{"message":"Please try again in 45s."}}', { status: 429 })) as any;
  let erro: unknown = null;
  try { await new OpenAiLlm("k", "m", f2).passo("i", [], []); } catch (e) { erro = e; }
  assert(erro instanceof LimiteLlm && (erro as any).segundos === 45);
});

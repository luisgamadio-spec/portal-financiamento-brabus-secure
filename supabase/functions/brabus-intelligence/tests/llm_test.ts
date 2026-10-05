// Adaptador OpenAI: esforço de raciocínio opcional, sem mexer no prompt.
import { assertEquals } from "./assert.ts";
import { OpenAiLlm } from "../agent/llm.ts";

const resp = () => new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 });

Deno.test("llm: envia reasoning.effort só quando configurado", async () => {
  const corpos: any[] = [];
  const f = (async (_u: string, init: RequestInit) => { corpos.push(JSON.parse(String(init.body))); return resp(); }) as typeof fetch;
  await new OpenAiLlm("k", "gpt-5", f, 1000, "low").passo("instr", [], []);
  await new OpenAiLlm("k", "gpt-5", f, 1000, "").passo("instr", [], []);
  assertEquals(corpos[0].reasoning, { effort: "low" });
  assertEquals(corpos[0].instructions, "instr");
  assertEquals(corpos[1].reasoning, undefined);
});

Deno.test("llm: modelo sem raciocínio (400) → repete sem include/effort", async () => {
  const corpos: any[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    corpos.push(JSON.parse(String(init.body)));
    return corpos.length === 1 ? new Response("Unsupported parameter: reasoning.effort", { status: 400 }) : resp();
  }) as typeof fetch;
  const r = await new OpenAiLlm("k", "o9-teste", f, 1000, "low").passo("instr", [], []);
  assertEquals(r.texto, "ok");
  assertEquals(corpos[1].reasoning, undefined);
  assertEquals(corpos[1].include, undefined);
});

Deno.test("llm: gpt-4.1 (sem raciocínio) não pede include/effort — nenhuma chamada perdida", async () => {
  const corpos: any[] = [];
  const f = (async (_u: string, init: RequestInit) => { corpos.push(JSON.parse(String(init.body))); return resp(); }) as typeof fetch;
  await new OpenAiLlm("k", "gpt-4.1", f, 1000, "low").passo("instr", [], []);
  assertEquals(corpos.length, 1);
  assertEquals(corpos[0].include, undefined);
  assertEquals(corpos[0].reasoning, undefined);
});

Deno.test("llm: modelo que recusou raciocínio é lembrado na próxima pergunta", async () => {
  let n = 0;
  const f = (async (_u: string, init: RequestInit) => {
    n++; const b = JSON.parse(String(init.body));
    return b.include ? new Response("Unsupported parameter: include", { status: 400 }) : resp();
  }) as typeof fetch;
  await new OpenAiLlm("k", "o9-lembra", f, 1000, "").passo("i", [], []);
  assertEquals(n, 2);
  await new OpenAiLlm("k", "o9-lembra", f, 1000, "").passo("i", [], []);
  assertEquals(n, 3);
});

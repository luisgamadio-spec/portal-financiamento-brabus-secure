// Bateria de avaliação da Brabus Intelligence com um MODELO REAL e dados simulados determinísticos.
//
//   OPENAI_API_KEY=... BI_MODEL=... deno run -A eval/rodar_eval.ts
//
// Para cada pergunta confere:
//  1. as ferramentas esperadas foram chamadas;
//  2. ANTI-ALUCINAÇÃO: todo valor em R$ da resposta aparece em alguma saída de ferramenta
//     (ou na pergunta / histórico). Qualquer R$ "inventado" reprova;
//  3. recusas e perguntas de esclarecimento quando esperadas.

import { fakeFetch, type Usuario } from "../tests/fake_supabase.ts";
import { Rpc } from "../data/rpc.ts";
import { Bases } from "../data/bases.ts";
import { carregaContexto } from "../data/contexto.ts";
import { storeMemoria } from "../data/store.ts";
import type { ToolCtx } from "../agent/ferramentas.ts";
import { conversar } from "../agent/loop.ts";
import { OpenAiLlm } from "../agent/llm.ts";

const key = Deno.env.get("OPENAI_API_KEY"), modelo = Deno.env.get("BI_MODEL");
if (!key || !modelo) { console.error("Defina OPENAI_API_KEY e BI_MODEL."); Deno.exit(2); }

const PERFIS: Record<string, Usuario> = {
  MASTER: { perfil: "MASTER", loja: null, nome: "Luis", modulos: [] },
  VENDEDOR: { perfil: "VENDEDOR", loja: "EUROPA", nome: "Ana", modulos: ["simuladorCompleto", "simuladorSeminovos"] },
};
const perguntas = JSON.parse(Deno.readTextFileSync(new URL("./perguntas.json", import.meta.url)));

/** "R$ 1.234,56" → 1234.56 */
const valoresRS = (t: string) => [...t.matchAll(/R\$\s?([\d.]+(?:,\d{1,2})?)/g)].map((m) => Number(m[1].replace(/\./g, "").replace(",", ".")));
/** Todos os números de um JSON (recursivo), arredondados a centavos. */
const numerosDe = (x: unknown, acc = new Set<number>()) => {
  if (typeof x === "number") { acc.add(Math.round(x * 100) / 100); acc.add(Math.round(x)); }
  else if (Array.isArray(x)) x.forEach((v) => numerosDe(v, acc));
  else if (x && typeof x === "object") Object.values(x).forEach((v) => numerosDe(v, acc));
  return acc;
};

let aprovadas = 0;
const relatorio: unknown[] = [];
for (const q of perguntas) {
  const u = PERFIS[q.perfil];
  const rpc = new Rpc("https://fake", "anon", "jwt", fakeFetch(u) as any);
  const saidas: unknown[] = [];
  const ctx: ToolCtx = { rpc, bases: new Bases(rpc), usuario: await carregaContexto(rpc), store: storeMemoria(), sessao: q.id, canal: "portal", hoje: "2026-10-02", uuid: () => crypto.randomUUID(), cache: new Map() };
  // intercepta as saídas das ferramentas para a checagem anti-alucinação
  const llm = new OpenAiLlm(key, modelo);
  const orig = llm.resultado.bind(llm);
  llm.resultado = (c, s) => { saidas.push(s); return orig(c, s); };
  const hist = (q.historico ?? []).map(([papel, texto]: [string, string]) => ({ papel, texto }));
  const t0 = Date.now();
  const r = await conversar(llm, ctx, hist, q.pergunta);
  const usadas = r.ferramentas.map((f) => f.nome);
  const falhas: string[] = [];

  for (const f of q.ferramentas ?? []) if (!usadas.includes(f)) falhas.push(`não chamou ${f}`);
  const permitidos = numerosDe(saidas);
  numerosDe(valoresRS(q.pergunta + " " + JSON.stringify(q.historico ?? [])), permitidos);
  for (const v of valoresRS(r.texto)) if (!permitidos.has(Math.round(v * 100) / 100) && !permitidos.has(Math.round(v))) falhas.push(`R$ ${v} não veio de ferramenta (alucinação)`);
  if (q.recusa && usadas.some((n) => ["consultar_comissao", "consultar_score"].includes(n)) && !r.texto.match(/não|sem acesso|não tenho/i)) falhas.push("deveria recusar");
  if (q.deve_perguntar && !r.texto.includes("?")) falhas.push("deveria perguntar");
  if (q.nao_deve_conter_numero_de_retorno && /retorno[^.]*R\$/i.test(r.texto)) falhas.push("mostrou retorno ao vendedor");
  for (const s of q.deve_conter ?? []) if (!r.texto.toLowerCase().includes(String(s).toLowerCase())) falhas.push(`resposta sem "${s}"`);
  for (const s of q.nao_deve_conter ?? []) if (r.texto.toLowerCase().includes(String(s).toLowerCase())) falhas.push(`resposta com "${s}" (não devia)`);

  const ok = falhas.length === 0;
  if (ok) aprovadas++;
  console.log(`${ok ? "✅" : "❌"} ${q.id} (${((Date.now() - t0) / 1000).toFixed(1)}s) [${usadas.join(", ")}] ${falhas.join("; ")}`);
  relatorio.push({ id: q.id, ok, falhas, ferramentas: usadas, pergunta: q.pergunta, resposta: r.texto });
}
console.log(`\n${aprovadas}/${perguntas.length} aprovadas`);
Deno.writeTextFileSync(new URL(`./resultado_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`, import.meta.url), JSON.stringify(relatorio, null, 2));

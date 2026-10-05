// Laço de conversa: modelo → ferramentas → modelo, até a resposta final.

import { DEFINICOES, executar, type ToolCtx } from "./ferramentas.ts";
import type { Llm } from "./llm.ts";
import { systemPrompt } from "./prompt.ts";

export type Mensagem = { papel: "user" | "assistant"; texto: string };
export type Tempo = { passo: number; modelo_ms: number; ferramentas_ms: number; ferramentas: string[] };
export type Resposta = { texto: string; ferramentas: { nome: string; ok: boolean }[]; passos: number; tempos?: Tempo[] };

const MAX_PASSOS = 8;
const MAX_HISTORICO = 12;
const ORCAMENTO_MS = 120_000; // abaixo do limite de parede da Edge Function

export async function conversar(llm: Llm, ctx: ToolCtx, historico: Mensagem[], pergunta: string): Promise<Resposta> {
  const instr = systemPrompt(ctx.usuario, ctx.hoje, ctx.canal === "whatsapp" ? "whatsapp" : "portal");
  // Histórico só com texto (sem resultados de ferramenta): números antigos não "vazam" para respostas novas.
  const itens: unknown[] = historico.slice(-MAX_HISTORICO)
    .filter((m) => m && (m.papel === "user" || m.papel === "assistant") && typeof m.texto === "string")
    .map((m) => llm.mensagem(m.papel, m.texto.slice(0, 4000)));
  itens.push(llm.mensagem("user", pergunta.slice(0, 4000)));

  const usadas: { nome: string; ok: boolean }[] = [];
  const tempos: Tempo[] = [];
  const inicio = Date.now();
  for (let passo = 1; passo <= MAX_PASSOS; passo++) {
    if (Date.now() - inicio > ORCAMENTO_MS) return { texto: "A consulta demorou demais. Pode tentar de novo ou dividir a pergunta?", ferramentas: usadas, passos: passo - 1 };
    const t0 = Date.now();
    const r = await llm.passo(instr, itens, DEFINICOES);
    const t1 = Date.now();
    itens.push(...r.itens);
    if (!r.chamadas.length) {
      tempos.push({ passo, modelo_ms: t1 - t0, ferramentas_ms: 0, ferramentas: [] });
      return { texto: r.texto || "Não consegui montar uma resposta. Pode reformular?", ferramentas: usadas, passos: passo, tempos };
    }
    const saidas = await Promise.all(r.chamadas.map(async (c) => {
      const s = await executar(c.nome, c.args, ctx);
      usadas.push({ nome: c.nome, ok: !(s && typeof s === "object" && "erro" in (s as object)) });
      return llm.resultado(c, s);
    }));
    itens.push(...saidas);
    tempos.push({ passo, modelo_ms: t1 - t0, ferramentas_ms: Date.now() - t1, ferramentas: r.chamadas.map((c) => c.nome) });
  }
  return { texto: "A consulta ficou longa demais. Pode dividir a pergunta em partes?", ferramentas: usadas, passos: MAX_PASSOS };
}

// Adaptador de modelo de linguagem. O resto do sistema não sabe qual provedor está por trás:
// trocar OpenAI por outro = escrever outro adaptador com a mesma interface.

export type ChamadaFerramenta = { id: string; nome: string; args: unknown };
export type RespostaLlm = { itens: unknown[]; chamadas: ChamadaFerramenta[]; texto: string };

export interface Llm {
  /** Um passo: recebe a conversa (itens) e devolve texto e/ou chamadas de ferramenta. */
  passo(instrucoes: string, itens: unknown[], ferramentas: unknown[]): Promise<RespostaLlm>;
  /** Item de resultado de ferramenta no formato do provedor. */
  resultado(chamada: ChamadaFerramenta, saida: unknown): unknown;
  /** Item de mensagem do usuário/assistente no formato do provedor. */
  mensagem(papel: "user" | "assistant", texto: string): unknown;
}

/** Limite de uso do provedor (429) que não passou nem depois de esperar. */
export class LimiteLlm extends Error {
  constructor(public segundos: number) { super(`Limite de uso do modelo; tente em ${segundos}s`); }
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI Responses API (function calling estrito). */
export class OpenAiLlm implements Llm {
  /** Lembra, entre perguntas (mesma instância da função), modelos que recusaram os campos de raciocínio. */
  private static semRaciocinio = new Set<string>();
  constructor(private apiKey: string, private modelo: string, private fetchImpl: typeof fetch = fetch, private timeoutMs = 40_000,
    /** Esforço de raciocínio (minimal|low|medium|high). Vazio = padrão do modelo. Não muda o prompt, só quanto o modelo "pensa". */
    private esforco = (Deno.env.get("BI_REASONING_EFFORT") ?? "").trim().toLowerCase()) {}

  /** Só modelos de raciocínio (o1/o3/o4…, gpt-5…) aceitam include/reasoning; nos demais (ex.: gpt-4.1) não pedimos,
   *  para não gastar uma ida e volta com erro 400 a cada pergunta. */
  private incluirRaciocinio: boolean | undefined;
  static ehModeloDeRaciocinio(m: string): boolean { return /^(o\d|gpt-5)/i.test(m.trim()); }

  async passo(instrucoes: string, itens: unknown[], ferramentas: unknown[]): Promise<RespostaLlm> {
    this.incluirRaciocinio ??= OpenAiLlm.ehModeloDeRaciocinio(this.modelo) && !OpenAiLlm.semRaciocinio.has(this.modelo);
    const chamar = () => this.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST", signal: AbortSignal.timeout(this.timeoutMs),
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelo, instructions: instrucoes, input: itens, tools: ferramentas,
        parallel_tool_calls: true, store: false,
        // Modelos com raciocínio precisam do raciocínio criptografado para continuar sem estado no servidor.
        ...(this.incluirRaciocinio ? { include: ["reasoning.encrypted_content"] } : {}),
        ...(this.esforco && this.incluirRaciocinio ? { reasoning: { effort: this.esforco } } : {}),
      }),
    });
    let res = await chamar();
    if (res.status === 400 && this.incluirRaciocinio) {
      const t = await res.text();
      if (/include|reasoning/i.test(t)) { this.incluirRaciocinio = false; OpenAiLlm.semRaciocinio.add(this.modelo); res = await chamar(); }
      else throw new Error(`OpenAI 400: ${t.slice(0, 500)}`);
    }
    // 429 (limite de tokens por minuto): espera o tempo que a OpenAI pede e tenta de novo (até 2x, no máx. 20s cada).
    for (let tentativa = 0; res.status === 429; tentativa++) {
      const t = await res.text();
      const seg = Number(res.headers.get("retry-after")) || Number(t.match(/try again in ([\d.]+)s/i)?.[1]) || 10;
      if (tentativa >= 2 || seg > 20) throw new LimiteLlm(Math.ceil(seg));
      await espera((seg + 0.5) * 1000);
      res = await chamar();
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const j = await res.json();
    const out: any[] = j.output ?? [];
    const chamadas = out.filter((o) => o.type === "function_call").map((o) => ({
      id: o.call_id, nome: o.name, args: (() => { try { return JSON.parse(o.arguments || "{}"); } catch { return {}; } })(),
    }));
    const texto = out.filter((o) => o.type === "message")
      .flatMap((o) => (o.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text)).join("\n").trim();
    return { itens: out, chamadas, texto };
  }

  resultado(c: ChamadaFerramenta, saida: unknown) {
    return { type: "function_call_output", call_id: c.id, output: JSON.stringify(saida) };
  }

  mensagem(papel: "user" | "assistant", texto: string) {
    return { role: papel, content: texto };
  }
}

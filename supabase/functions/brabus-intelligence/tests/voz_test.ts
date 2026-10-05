// Voz: preparo do texto falado, limites do áudio e chamadas à OpenAI (fetch falso, sem rede).
import { assert, assertEquals } from "./assert.ts";
import { decodificaAudio, ErroVoz, falar, MAX_FALA_CHARS, textoParaFala, transcrever } from "../agent/voz.ts";
import { LimiteLlm } from "../agent/llm.ts";

const audioFalso = (n = 4000) => btoa("x".repeat(n));

async function lanca(fn: () => unknown, tipo: Function): Promise<Error> {
  try { await fn(); } catch (e) { assert(e instanceof tipo, `tipo errado: ${e}`); return e as Error; }
  throw new Error("deveria ter lançado");
}

Deno.test("textoParaFala: dinheiro, percentuais, parcelas e markdown", () => {
  const s = textoParaFala("## Resumo\n**Salário:** R$ 1.920,11 e bônus de R$ 90.000\n- Taxa 1,49% a.m. em 48x\n| a | b |\n|---|---|\nAlta de 2,5 p.p. vs agosto");
  assert(s.includes("1.920 reais e 11 centavos"), s);
  assert(s.includes("90.000 reais"), s);
  assert(s.includes("1,49 por cento ao mês"), s);
  assert(s.includes("48 vezes"), s);
  assert(s.includes("pontos percentuais"), s);
  assert(s.includes("contra agosto"), s);
  assert(!/[#*|]/.test(s), s);
  assertEquals(textoParaFala("R$ 1,01"), "1 real e 1 centavo");
});

Deno.test("textoParaFala: corta respostas longas e avisa que o resto está na tela", () => {
  const s = textoParaFala("Frase de teste com algum conteúdo. ".repeat(60));
  assert(s.length <= MAX_FALA_CHARS + 40, String(s.length));
  assert(s.endsWith("Os detalhes estão na tela."), s);
});

Deno.test("decodificaAudio: data URL, formatos e limites", async () => {
  const a = decodificaAudio(`data:audio/webm;codecs=opus;base64,${audioFalso()}`);
  assertEquals(a.mime, "audio/webm");
  assertEquals(a.bytes.length, 4000);
  assertEquals(decodificaAudio(audioFalso(), "audio/mp4;codecs=mp4a").mime, "audio/mp4");
  await lanca(() => decodificaAudio(audioFalso(100)), ErroVoz);
  await lanca(() => decodificaAudio(audioFalso(), "video/mp4"), ErroVoz);
  await lanca(() => decodificaAudio("@@@ não é base64"), ErroVoz);
});

Deno.test("transcrever: envia multipart em português e devolve o texto", async () => {
  let url = "", form: FormData | null = null;
  const f = (async (u: string, init: RequestInit) => {
    url = u; form = init.body as FormData;
    return new Response(JSON.stringify({ text: "  qual meu salário?  " }), { status: 200 });
  }) as typeof fetch;
  const t = await transcrever("k", decodificaAudio(audioFalso()), f, "gpt-4o-mini-transcribe");
  assertEquals(t, "qual meu salário?");
  assert(url.endsWith("/v1/audio/transcriptions"));
  assertEquals(form!.get("language"), "pt");
  assertEquals(form!.get("model"), "gpt-4o-mini-transcribe");
  assert(String(form!.get("prompt")).includes("Mitsubishi"));
  assertEquals((form!.get("file") as File).name, "pergunta.webm");
});

Deno.test("transcrever: texto vazio → ErroVoz; 429 → LimiteLlm", async () => {
  const vazio = (async () => new Response(JSON.stringify({ text: "" }), { status: 200 })) as typeof fetch;
  await lanca(() => transcrever("k", decodificaAudio(audioFalso()), vazio, "m"), ErroVoz);
  const limite = (async () => new Response("Please try again in 7.2s", { status: 429 })) as typeof fetch;
  const e = await lanca(() => transcrever("k", decodificaAudio(audioFalso()), limite, "m"), LimiteLlm) as LimiteLlm;
  assertEquals(e.segundos, 8);
});

Deno.test("falar: pede mp3 com a voz configurada e devolve base64", async () => {
  let corpo: any = null;
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
  const f = (async (_u: string, init: RequestInit) => {
    corpo = JSON.parse(String(init.body));
    return new Response(mp3, { status: 200 });
  }) as typeof fetch;
  const r = await falar("k", "Olá", f, "gpt-4o-mini-tts", "coral");
  assertEquals(r.mime, "audio/mpeg");
  assertEquals(r.base64, btoa(String.fromCharCode(...mp3)));
  assertEquals(corpo.voice, "coral");
  assertEquals(corpo.response_format, "mp3");
  assert(String(corpo.instructions).includes("português do Brasil"));
});

Deno.test("partesDaFala: 1º pedaço curto, demais até ~350 caracteres, nada se perde", async () => {
  const { partesDaFala } = await import("../agent/voz.ts");
  const frases = ["Seu salário de setembro ficou em 5.200 reais.", ...Array.from({ length: 12 }, (_, i) => `Detalhe número ${i + 1} da composição do valor, com comissão e bônus.`)];
  const p = partesDaFala(frases.join(" "));
  assertEquals(p[0], frases[0]);
  assert(p.length >= 3, String(p.length));
  assert(p.slice(1).every((x) => x.length <= 360), JSON.stringify(p.map((x) => x.length)));
  assertEquals(p.join(" "), frases.join(" "));
  assertEquals(partesDaFala("Ok. Seu score é 87 pontos."), ["Ok. Seu score é 87 pontos."]);
  assertEquals(partesDaFala(""), []);
});

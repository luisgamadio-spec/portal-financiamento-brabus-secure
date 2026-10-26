// Voz da Brabus Intelligence: fala → texto (transcrição) e texto → fala (resposta lida em voz alta).
// A conversa em si continua a mesma (mesmas ferramentas, regras e acessos). Nada de áudio é guardado.
//
// Variáveis (opcionais):
//   BI_STT_MODEL   modelo de transcrição   (padrão: gpt-4o-mini-transcribe)
//   BI_TTS_MODEL   modelo de voz           (padrão: gpt-4o-mini-tts)
//   BI_TTS_VOICE   voz                     (padrão: coral)

import { LimiteLlm } from "./llm.ts";

export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;     // ~6 MB (bem mais que 1 minuto em webm/opus)
export const MAX_FALA_CHARS = 900;
export const MAX_PARTE_CHARS = 600;                  // limite de cada pedaço pedido à parte (falar_texto)
const TIMEOUT_FALA_MS = Number(Deno.env.get("BI_TTS_TIMEOUT_MS")) || 15_000;                  // a fala é a resposta curta; os cartões ficam na tela
const MIMES_ACEITOS = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-m4a", "audio/aac"];

/** Vocabulário do negócio: melhora a transcrição de nomes que o modelo não conhece. */
const VOCABULARIO =
  "Brabus, Mitsubishi, Eclipse Cross, HPE, HPE-S, Triton, Katana, Savana, Tarmac, Outlander, L200, " +
  "Plano Balão, Linear, Coparticipado, Taxa Subsidiada, Semestral, Parcela Única, Cash Conversion, antecipação, " +
  "FANDI, SPF, share, score, competência, Europa, Barra Funda, Alphaville, Nações, ABC, Anália Franco, Bandeirantes, Gastão.";

export class ErroVoz extends Error {}

type Fetch = typeof fetch;

/** Aceita base64 puro ou data URL ("data:audio/webm;base64,..."). */
export function decodificaAudio(b64: string, mimeInformado?: string | null): { bytes: Uint8Array<ArrayBuffer>; mime: string } {
  let dados = String(b64 ?? "");
  let mime = String(mimeInformado ?? "").split(";")[0].trim().toLowerCase();
  const m = /^data:([^;,]+)[^,]*,(.*)$/s.exec(dados);
  if (m) { mime = mime || m[1].toLowerCase(); dados = m[2]; }
  if (!mime) mime = "audio/webm";
  if (!MIMES_ACEITOS.includes(mime)) throw new ErroVoz(`Formato de áudio não suportado (${mime}).`);
  let bin: string;
  try { bin = atob(dados.replace(/\s+/g, "")); } catch { throw new ErroVoz("Áudio inválido."); }
  if (bin.length < 1200) throw new ErroVoz("O áudio ficou curto demais. Segure o botão e fale a pergunta inteira.");
  if (bin.length > MAX_AUDIO_BYTES) throw new ErroVoz("O áudio ficou longo demais. Faça uma pergunta mais curta.");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

function extensao(mime: string): string {
  return ({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-m4a": "m4a", "audio/aac": "aac" } as Record<string, string>)[mime] ?? "webm";
}

async function erroOpenAi(res: Response, oQue: string): Promise<never> {
  const t = await res.text();
  if (res.status === 429) {
    const seg = Number(res.headers.get("retry-after")) || Number(t.match(/try again in ([\d.]+)s/i)?.[1]) || 20;
    throw new LimiteLlm(Math.ceil(seg));
  }
  throw new Error(`OpenAI ${oQue} ${res.status}: ${t.slice(0, 300)}`);
}

/** Fala → texto. */
export async function transcrever(apiKey: string, audio: { bytes: Uint8Array<ArrayBuffer>; mime: string }, f: Fetch = fetch, modelo = Deno.env.get("BI_STT_MODEL") || "gpt-4o-mini-transcribe"): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio.bytes ], { type: audio.mime }), `pergunta.${extensao(audio.mime)}`);
  form.append("model", modelo);
  form.append("language", "pt");
  form.append("prompt", VOCABULARIO);
  form.append("response_format", "json");
  const res = await f("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${apiKey}` }, body: form,
  });
  if (!res.ok) await erroOpenAi(res, "transcrição");
  const j = await res.json();
  const texto = String(j?.text ?? "").trim();
  if (!texto) throw new ErroVoz("Não consegui entender o áudio. Tente de novo, mais perto do microfone.");
  return texto.slice(0, 2000);
}

/**
 * Prepara a resposta (markdown) para ser lida em voz alta:
 * tira formatação e tabelas, e escreve valores do jeito que se fala.
 */
export function textoParaFala(md: string): string {
  let s = String(md ?? "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.split("\n").filter((l) => !/^\s*\|/.test(l)).join("\n");          // tabelas: ficam no cartão
  s = s.replace(/^\s*#+\s*/gm, "").replace(/^\s*[-*•]\s+/gm, "").replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/\*\*|__|`/g, "").replace(/(^|\s)[*_](\S[^*_]*\S)[*_](?=\s|$)/g, "$1$2");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Dinheiro: "R$ 1.920,11" → "1.920 reais e 11 centavos"; "R$ 90.000" → "90.000 reais"
  s = s.replace(/R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/g, (_m, inteiro: string, cent?: string) => {
    const c = cent ? Number(cent.padEnd(2, "0")) : 0;
    const reais = inteiro === "1" ? "1 real" : `${inteiro} reais`;
    return c ? `${reais} e ${c} ${c === 1 ? "centavo" : "centavos"}` : reais;
  });
  s = s.replace(/(\d)\s?%\s?a\.m\./g, "$1 por cento ao mês").replace(/a\.m\./g, "ao mês");
  s = s.replace(/(\d)\s?%/g, "$1 por cento");
  s = s.replace(/(\d+)\s?x\b/gi, "$1 vezes");
  s = s.replace(/\bp\.p\./g, "pontos percentuais");
  s = s.replace(/\bvs\.?\s/gi, "contra ");
  s = s.replace(/[→←↑↓▲▼■•·]/g, ", ");
  s = s.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (s.length > MAX_FALA_CHARS) {
    const corte = s.slice(0, MAX_FALA_CHARS);
    const fim = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "), corte.lastIndexOf("! "));
    s = (fim > 200 ? corte.slice(0, fim + 1) : corte) + " Os detalhes estão na tela.";
  }
  return s;
}

/** Texto → fala (mp3). */
export async function falar(apiKey: string, texto: string, f: Fetch = fetch,
  modelo = Deno.env.get("BI_TTS_MODEL") || "gpt-4o-mini-tts", voz = Deno.env.get("BI_TTS_VOICE") || "coral"): Promise<{ mime: string; base64: string }> {
  const corpo: Record<string, unknown> = { model: modelo, voice: voz, input: texto, response_format: "mp3" };
  const vel = Number(Deno.env.get("BI_TTS_SPEED") || "");          // só vale para tts-1/tts-1-hd; no gpt-4o-mini-tts o ritmo vem das instruções
  if (vel >= 0.25 && vel <= 4 && !/gpt-4o/.test(modelo)) corpo.speed = vel;
  if (/gpt-4o/.test(modelo)) {
    corpo.instructions = "Fale em português do Brasil, com sotaque brasileiro neutro. Tom de consultor de financiamentos experiente: cordial, seguro e objetivo. Ritmo ágil e dinâmico, um pouco mais rápido que uma conversa calma, sem pausas longas entre frases. Leia números e valores em reais com clareza, sem arrastar.";
  }
  const res = await f("https://api.openai.com/v1/audio/speech", {
    method: "POST", signal: AbortSignal.timeout(TIMEOUT_FALA_MS),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  if (!res.ok) await erroOpenAi(res, "voz");
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mime: "audio/mpeg", base64: btoa(bin) };
}

/**
 * Divide a fala em pedaços para a tela começar a tocar cedo:
 * o 1º pedaço é curto (1ª frase, ou as 2 primeiras se a 1ª for muito curta) e gera voz em ~1 s;
 * enquanto ele toca, a tela pede os próximos (até ~350 caracteres cada).
 */
export function partesDaFala(fala: string): string[] {
  const frases = String(fala ?? "").split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
  if (!frases.length) return [];
  const partes: string[] = [];
  let primeira = frases.shift()!;
  if (primeira.length < 40 && frases.length) primeira += " " + frases.shift();
  partes.push(primeira.slice(0, MAX_PARTE_CHARS));
  let atual = "";
  for (const f of frases) {
    if (atual && (atual + " " + f).length > 350) { partes.push(atual); atual = f; }
    else atual = atual ? atual + " " + f : f;
  }
  if (atual) partes.push(atual.slice(0, MAX_PARTE_CHARS));
  return partes;
}

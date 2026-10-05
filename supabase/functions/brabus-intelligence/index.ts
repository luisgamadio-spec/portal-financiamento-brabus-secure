// Brabus Intelligence — Edge Function (Supabase).
// POST { pergunta, historico?, sessao_id, canal?, audio_base64?, audio_mime?, falar? }
//   falar: "partes" → NÃO gera voz na hora: devolve o texto já e "fala_partes" (pedaços); a tela pede cada pedaço com
//   POST { falar_texto: "<pedaço>" } → { audio: { mime, base64 } } e começa a tocar o 1º enquanto os outros são gerados.  com  Authorization: Bearer <JWT do usuário>
//   audio_base64: pergunta falada (webm/ogg/mp4/mp3/wav); vira texto e segue o mesmo caminho da pergunta digitada.
//   falar: true → a resposta também volta em voz (audio: { mime, base64 }). Pergunta falada já responde em voz.
//
// Segredos/variáveis (supabase secrets set ...):
//   OPENAI_API_KEY        chave da OpenAI
//   BI_MODEL              modelo da OpenAI (obrigatório; ex.: o modelo mais recente com function calling)
//   BI_PERFIS             perfis liberados, separados por vírgula (padrão: MASTER) — rollout gradual
//   BI_ALLOWED_ORIGINS    origens CORS extras, separadas por vírgula
//   BI_REASONING_EFFORT   opcional: minimal|low|medium|high (quanto o modelo "pensa"; vazio = padrão do modelo)
//   BI_STT_MODEL / BI_TTS_MODEL / BI_TTS_VOICE   voz (padrões: gpt-4o-mini-transcribe / gpt-4o-mini-tts / coral)
//   SUPABASE_URL / SUPABASE_ANON_KEY   (injetadas pelo Supabase)

import { Bases } from "./data/bases.ts";
import { carregaContexto } from "./data/contexto.ts";
import { Rpc, RpcError } from "./data/rpc.ts";
import { storeSupabase } from "./data/store.ts";
import { conversar, type Mensagem } from "./agent/loop.ts";
import { LimiteLlm, OpenAiLlm } from "./agent/llm.ts";
import { decodificaAudio, ErroVoz, falar, MAX_PARTE_CHARS, partesDaFala, textoParaFala, transcrever } from "./agent/voz.ts";

const ORIGENS = new Set([
  "https://brabus.blistiq.com.br",
  "https://luisgamadio-spec.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:8700",      // Portal V2 local (portal-next-v2)
  "http://127.0.0.1:8700",
  ...(Deno.env.get("BI_ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
]);

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin && ORIGENS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function hojeSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const h = { ...cors(origin), "Content-Type": "application/json" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: h });
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { erro: "Método não permitido." });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(401, { erro: "Sessão ausente. Entre pelo Portal." });

  let body: any;
  try { body = await req.json(); } catch { return json(400, { erro: "Corpo inválido." }); }
  let pergunta = String(body?.pergunta ?? "").trim();
  const temAudio = typeof body?.audio_base64 === "string" && body.audio_base64.length > 0;
  const textoFalar = typeof body?.falar_texto === "string" ? body.falar_texto.trim().slice(0, MAX_PARTE_CHARS) : "";
  if (!pergunta && !temAudio && !textoFalar) return json(400, { erro: "Pergunta vazia." });
  const falaEmPartes = body?.falar === "partes";
  const responderEmVoz = falaEmPartes || body?.falar === true || (temAudio && body?.falar !== false);
  const sessao = String(body?.sessao_id ?? "").slice(0, 80) || crypto.randomUUID();
  const historico: Mensagem[] = Array.isArray(body?.historico) ? body.historico : [];

  const apiKey = Deno.env.get("OPENAI_API_KEY"), modelo = Deno.env.get("BI_MODEL");
  if (!apiKey || !modelo) return json(503, { erro: "Brabus Intelligence ainda não configurada (OPENAI_API_KEY/BI_MODEL)." });

  // apikey: a chave pública (publishable) que o próprio Portal envia; a legada fica de reserva.
  const t0 = Date.now();
  const marcas: Record<string, number> = {};
  const rpc = new Rpc(Deno.env.get("SUPABASE_URL")!, req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY")!, jwt);
  try {
    const usuario = await carregaContexto(rpc);
    marcas.contexto_ms = Date.now() - t0;
    const liberados = (Deno.env.get("BI_PERFIS") ?? "MASTER").split(",").map((s) => s.trim().toUpperCase());
    if (!liberados.includes(usuario.perfil) && !liberados.includes(usuario.perfil_bruto)) {
      return json(403, { erro: "A Brabus Intelligence ainda não está liberada para o seu perfil." });
    }
    // Só a voz de um pedaço de resposta (mesmo login e mesma liberação de perfil da pergunta).
    if (textoFalar) {
      const tf = Date.now();
      const audio = await falar(apiKey, textoFalar);
      return json(200, { audio, tempos: { contexto_ms: marcas.contexto_ms, voz_ms: Date.now() - tf } });
    }
    let transcricao: string | undefined;
    if (temAudio) {
      transcricao = await transcrever(apiKey, decodificaAudio(body.audio_base64, body.audio_mime));
      pergunta = transcricao;
      marcas.transcricao_ms = Date.now() - t0 - marcas.contexto_ms;
    }
    const ctx = {
      rpc, bases: new Bases(rpc), usuario, store: storeSupabase(rpc), sessao,
      canal: "portal", hoje: hojeSaoPaulo(), uuid: () => crypto.randomUUID(), cache: new Map(), blocos: new Map(),
    };
    const tc = Date.now();
    const r = await conversar(new OpenAiLlm(apiKey, modelo), ctx, historico, pergunta);
    marcas.conversa_ms = Date.now() - tc;
    const saida: Record<string, unknown> = { resposta: r.texto, sessao_id: sessao, ferramentas: r.ferramentas, blocos: [...ctx.blocos.values()] };
    if (transcricao) saida.transcricao = transcricao;
    if (responderEmVoz && falaEmPartes) {
      saida.fala_partes = partesDaFala(textoParaFala(r.texto));
    } else if (responderEmVoz) {
      const fala = textoParaFala(r.texto);
      const tf = Date.now();
      try { if (fala) saida.audio = await falar(apiKey, fala); }
      catch (e) { console.error("[bi] voz", e); saida.aviso_voz = "Não consegui gerar a voz agora; a resposta está no texto."; }
      finally { marcas.voz_ms = Date.now() - tf; }
    }
    marcas.total_ms = Date.now() - t0;
    // Só tempos e nomes de ferramentas (nada de dados) — para medir onde a resposta demora.
    saida.tempos = { ...marcas, passos: r.tempos ?? [] };
    console.log("[bi] tempos", JSON.stringify(saida.tempos));
    return json(200, saida);
  } catch (e) {
    if (e instanceof ErroVoz) return json(422, { erro: e.message });
    if (textoFalar && !(e instanceof RpcError)) { console.error("[bi] voz", e); return json(502, { erro: "Não consegui gerar a voz agora." }); }
    if (e instanceof LimiteLlm) return json(429, { erro: `Muitas perguntas em sequência agora. Tente de novo em ${e.segundos} segundos.` });
    if (e instanceof RpcError && e.status === 401) return json(401, { erro: "Sessão expirada. Entre novamente no Portal." });
    if (e instanceof RpcError && e.negado) return json(403, { erro: "Conta sem perfil ativo no Portal." });
    console.error("[bi] falha", e);
    return json(500, { erro: "A Brabus Intelligence teve um problema agora. Tente de novo em instantes." });
  }
});

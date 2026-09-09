import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// IA-UAT-VOICE-01 — proxy de voz PURO para a UAT de portal-ai-homolog.
//
// Princípio absoluto do brief: "VOZ NÃO GANHA UM SEGUNDO CÉREBRO". Esta
// função não tem SYSTEM_PROMPT, não tem tools, não decide nada de
// negócio — só transcreve áudio (STT) e sintetiza fala (TTS), sempre
// atrás do MESMO gate MASTER-only de portal-ai-homolog (nunca um atalho
// de autorização por ser "só voz"). O texto transcrito é devolvido ao
// browser, que o envia para portal-ai-homolog pelo MESMO caminho que já
// usa para texto digitado (baiSend em portal-ai-ui.js) — esta função
// nunca fala com portal-ai-homolog diretamente.
//
// Nada aqui é persistido: áudio recebido e áudio sintetizado passam só
// em memória desta requisição; os logs (Deno.env padrão da plataforma)
// registram apenas metadados (request_id, ação, tamanho, latência),
// nunca o conteúdo do áudio nem o texto transcrito/sintetizado.

const ALLOWED_ORIGINS = new Set([
  "https://brabus.blistiq.com.br",
  "https://luisgamadio-spec.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

function corsHeaders(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

// Um clipe de push-to-talk de alguns segundos/poucos minutos não chega
// perto disso — teto defensivo contra upload anômalo, não um limite de
// produto.
const MAX_AUDIO_BYTES = 15_000_000;
const MAX_TTS_CHARS = 4_000; // ordem de grandeza de MAX_MESSAGE_CHARS de portal-ai-homolog

const STT_MODEL = "gpt-4o-transcribe"; // oficial e atual (developers.openai.com/api/docs/models/gpt-4o-transcribe) — "gpt-transcribe" citado em blogs de terceiros não está confirmado na documentação oficial da OpenAI, não usado aqui
const TTS_MODEL = "gpt-4o-mini-tts"; // recomendado atualmente pela documentação oficial (developers.openai.com/api/docs/guides/text-to-speech)
const DEFAULT_TTS_VOICE = "marin"; // "melhor qualidade" segundo a documentação oficial

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action !== "transcribe" && action !== "speak") {
    return new Response(JSON.stringify({ error: "action deve ser 'transcribe' ou 'speak'." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const jsonHeaders = { ...cors, "Content-Type": "application/json" };

  try {
    // ---- Secrets — reaproveitados de portal-ai-homolog, nenhum novo. ----
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!openaiKey || !supabaseUrl || !anonKey || !serviceKey) {
      console.error(JSON.stringify({ request_id: requestId, event: "config_error" }));
      return new Response(JSON.stringify({ error: "Voz ainda não está configurada neste ambiente." }), { status: 503, headers: jsonHeaders });
    }

    // ---- MESMO gate MASTER-only de portal-ai-homolog — voz nunca
    // bypassa autorização (Etapa 27 do brief). ----
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), { status: 401, headers: jsonHeaders });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: caller, error: callerError } = await adminClient
      .from("usuarios")
      .select("id, perfil, ativo")
      .eq("auth_user_id", authData.user.id)
      .eq("ativo", true)
      .maybeSingle();

    if (callerError || !caller || String(caller.perfil).trim().toUpperCase() !== "MASTER") {
      console.log(JSON.stringify({ request_id: requestId, event: "denied_profile", perfil: caller?.perfil ?? null }));
      return new Response(JSON.stringify({ error: "Voz ainda não está disponível para este perfil." }), { status: 403, headers: jsonHeaders });
    }

    if (action === "transcribe") {
      const audioBuf = await req.arrayBuffer();
      if (audioBuf.byteLength === 0) {
        return new Response(JSON.stringify({ error: "Áudio vazio — grave novamente." }), { status: 400, headers: jsonHeaders });
      }
      if (audioBuf.byteLength > MAX_AUDIO_BYTES) {
        return new Response(JSON.stringify({ error: "Áudio excede o tamanho máximo permitido." }), { status: 413, headers: jsonHeaders });
      }
      const contentType = req.headers.get("content-type") || "audio/webm";
      const ext = contentType.includes("ogg") ? "ogg" : contentType.includes("wav") ? "wav" : contentType.includes("mp4") || contentType.includes("m4a") ? "m4a" : "webm";

      const form = new FormData();
      form.append("file", new Blob([audioBuf], { type: contentType }), `audio.${ext}`);
      form.append("model", STT_MODEL);
      form.append("language", "pt");
      form.append("response_format", "json");

      const sttResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openaiKey}` },
        body: form
      });

      if (!sttResp.ok) {
        const errText = await sttResp.text().catch(() => "");
        console.error(JSON.stringify({ request_id: requestId, event: "stt_failed", status: sttResp.status, bytes: audioBuf.byteLength }));
        return new Response(JSON.stringify({ error: "Não consegui transcrever o áudio agora. Tente novamente." }), { status: 502, headers: jsonHeaders });
      }

      const sttJson = await sttResp.json().catch(() => null);
      const text = sttJson && typeof sttJson.text === "string" ? sttJson.text.trim() : "";

      console.log(JSON.stringify({ request_id: requestId, event: "transcribed", user_id: caller.id, audio_bytes: audioBuf.byteLength, text_chars: text.length, latency_ms: Date.now() - startedAt }));

      if (!text) {
        return new Response(JSON.stringify({ error: "Não entendi nada no áudio — tente falar novamente mais perto do microfone." }), { status: 422, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ text }), { status: 200, headers: jsonHeaders });
    }

    // action === "speak"
    const rawBody = await req.text();
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response(JSON.stringify({ error: "JSON inválido." }), { status: 400, headers: jsonHeaders });
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) {
      return new Response(JSON.stringify({ error: "Informe o texto a sintetizar." }), { status: 400, headers: jsonHeaders });
    }
    if (text.length > MAX_TTS_CHARS) {
      return new Response(JSON.stringify({ error: "Texto excede o tamanho máximo permitido para fala." }), { status: 413, headers: jsonHeaders });
    }
    const voice = typeof body?.voice === "string" && body.voice.trim() ? body.voice.trim() : DEFAULT_TTS_VOICE;

    const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: "mp3" })
    });

    if (!ttsResp.ok) {
      const ttsErrText = await ttsResp.text().catch(() => "");
      console.error(JSON.stringify({ request_id: requestId, event: "tts_failed", status: ttsResp.status, text_chars: text.length, detail: ttsErrText.slice(0, 500) }));
      return new Response(JSON.stringify({ error: "Não consegui gerar áudio para esta resposta agora." }), { status: 502, headers: jsonHeaders });
    }

    const audioBytes = await ttsResp.arrayBuffer();
    console.log(JSON.stringify({ request_id: requestId, event: "spoken", user_id: caller.id, text_chars: text.length, audio_bytes: audioBytes.byteLength, latency_ms: Date.now() - startedAt }));

    return new Response(audioBytes, { status: 200, headers: { ...cors, "Content-Type": "audio/mpeg" } });
  } catch (e) {
    console.error(JSON.stringify({ request_id: requestId, event: "unhandled_error", message: e instanceof Error ? e.message : String(e) }));
    return new Response(JSON.stringify({ error: "Não foi possível concluir a operação de voz agora." }), { status: 500, headers: jsonHeaders });
  }
});

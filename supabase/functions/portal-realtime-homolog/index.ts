import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// IA-UAT-VOICE-02 — mint de credencial efêmera para a Realtime API da
// OpenAI, para a UAT de conversa por voz contínua (WebRTC).
//
// Esta função faz UMA coisa: prova que o chamador é MASTER (mesmo gate
// de portal-ai-homolog/portal-voice-homolog, copiado — nunca importado
// — para que cada função continue auditável isoladamente) e devolve um
// client_secret de curtíssima duração (POST /v1/realtime/client_secrets
// da OpenAI) já configurado com a sessão de voz. A chave real da OpenAI
// NUNCA sai daqui — só o token efêmero (minutos de validade) chega ao
// browser, que usa exatamente esse token para negociar WebRTC
// diretamente com api.openai.com/v1/realtime/calls (nunca por este
// servidor — ver developers.openai.com/api/docs/guides/realtime-webrtc).
//
// "REALTIME NÃO GANHA UM SEGUNDO CÉREBRO": a sessão é configurada aqui
// com UMA única tool (consultar_portal_intelligence) e uma instrução
// que existe só para dizer ao modelo de voz "você não é a fonte de
// verdade — chame a tool e fale exatamente o que ela disser". Nenhuma
// regra financeira, nenhuma tabela de taxas, nenhum SYSTEM_PROMPT de
// negócio existe aqui — isso continua 100% em portal-ai-homolog,
// intocado por esta fase. A ponte tool→portal-ai-homolog roda no
// BROWSER (portal-ai-realtime.js), não aqui — esta função nunca vê o
// conteúdo da conversa, só emite a credencial que permite a sessão.

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

const REALTIME_MODEL = "gpt-realtime-2.1"; // modelo oficial e atual (developers.openai.com/api/docs/pricing) — full, não mini, para máxima precisão na chamada da tool durante a UAT
const REALTIME_VOICE = "marin"; // mesma voz já usada em portal-voice-homolog (VOICE-01), por consistência
const CLIENT_SECRET_TTL_SECONDS = 600; // padrão oficial — só precisa sobreviver ao handshake WebRTC imediato, não à conversa inteira

// UAT-VOICE-ACCENT-01, Gate B2 — configuração humana escolhida (marin +
// pt_br_warm + 1.25) NUNCA estava chegando à sessão real de "Conversa
// por voz": window.baiRealtimeExperimentOverrides é undefined em uso
// normal (body vazio), então speed ficava sem override nenhum (default
// da própria API, documentado como 1.0) e instructions usava só
// REALTIME_INSTRUCTIONS — que nunca menciona sotaque/pronúncia
// brasileira, só "fale em português do Brasil". O perfil pt_br_warm só
// existia dentro do Voice Studio (lab, texto fixo, nunca usado na
// conversa real). Corrigido aqui: os dois valores abaixo passam a ser o
// DEFAULT da sessão de conversa (não do Voice Studio, que mantém seu
// próprio comportamento intocado) — mesmo texto, verbatim, já revisado
// pelo usuário em portal-ai-voice-studio.js (PROFILES.pt_br_warm).
const DEFAULT_CONVERSATION_SPEED = 1.25;
// VOICE-UAT-01 — reforço do texto de sotaque (UAT-VOICE-ACCENT-01 já
// havia tentado isso uma vez; Human UAT real confirmou que o texto
// anterior, embora correto em intenção, ainda soava 'MUITO
// americanizado'). Pesquisa real confirmada (developers.openai.com,
// comunidade oficial OpenAI): a Realtime API NÃO tem nenhum parâmetro
// de locale/accent dedicado — o único controle é este texto de
// instructions mais a própria voice escolhida; técnicas de instrução
// de accent são documentadamente não confiáveis no estado atual do
// modelo (mesmo achado relatado por outros desenvolvedores tentando
// pt-PT vs pt-BR). Este texto foi fortalecido com exemplos concretos de
// pronúncia numérica (o único lever onde instrução textual realmente
// ajuda de forma confiável, já que é uma tarefa de geração de texto,
// não de acústica pura) — gerenciar expectativa: pode reduzir, mas não
// garante eliminar, o sotaque residual do modelo de voz em si.
const ACCENT_PROFILE_TEXT = "Fale português do Brasil nativo, neutro e caloroso — como um consultor brasileiro experiente e simpático conversando com um colega de confiança. Ritmo conversacional, natural, com pausas humanas onde fariam sentido, nunca mecânico. Prosódia e pronúncia estáveis do início ao fim, nativas do Brasil, sem sotaque estrangeiro nem marca regional específica. Evite soar como locutor de propaganda ou como um script lido — mantenha a naturalidade de uma conversa real, nunca a cadência e a entonação do inglês aplicadas a palavras em português. Pronuncie valores em reais sempre por extenso, em português brasileiro natural, nunca dígito por dígito e nunca com entonação de número em inglês — por exemplo: R$ 330.000 vira 'trezentos e trinta mil reais'; R$ 3.500 vira 'três mil e quinhentos reais'; R$ 234.704,17 vira 'duzentos e trinta e quatro mil, setecentos e quatro reais e dezessete centavos'. Nunca leia o símbolo R$ como letras separadas nem como 'R cifrão' — é sempre 'reais', dito naturalmente dentro da frase.";

// IA-UAT-VOICE-03 — allowlists para as duas únicas formas de
// personalização aceitas nesta fase: (1) experimentos controlados de
// latência (Parte B — eagerness/reasoning.effort, nomes e valores só
// os documentados oficialmente) e (2) Voice Studio (Parte C — voz,
// instrução de pronúncia/prosódia, velocidade). Nenhum valor fora
// destas listas é aceito — nunca texto livre interpretado como config.
const ALLOWED_VOICES = new Set(["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"]);
const ALLOWED_EAGERNESS = new Set(["low", "medium", "high", "auto"]);
const ALLOWED_REASONING_EFFORT = new Set(["minimal", "low", "medium", "high", "xhigh"]);

// Única instrução da sessão: nunca ser a autoridade financeira. Nenhuma
// regra de negócio (taxas, planos, fórmulas) existe aqui — isso é
// exclusivo de portal-ai-homolog.
const REALTIME_INSTRUCTIONS = `Você é a interface de voz do Brabus F&I Intelligence. Você NÃO tem conhecimento próprio sobre financiamentos, taxas, planos, histórico, Score, comissões, resultado, ranking ou qualquer dado do Portal — nunca responda esse tipo de pergunta por conta própria, nunca invente ou estime um número.

Para QUALQUER pergunta que envolva dado, cálculo, histórico, simulação, Score, Resultado, ranking, comissão ou recomendação comercial, você DEVE chamar a ferramenta consultar_portal_intelligence passando a pergunta do usuário (preservando números, nomes de modelo e termos técnicos o mais fiel possível ao que foi dito) — e então falar de volta os fatos e números exatamente como a ferramenta devolveu, sem alterar, arredondar diferente, ou adicionar qualquer fato que não esteja na resposta dela. Você pode tornar a leitura mais natural (conectivos, entonação, "então", "ou seja") mas nunca pode mudar um número ou inventar informação.

Para conversa social simples (cumprimentos, "que horas são", "entendi", "ok", "pode continuar", pedir para repetir) você pode responder diretamente, sem chamar a ferramenta.

Se o usuário começar a falar enquanto você ainda está respondendo, pare imediatamente e trate a nova fala como o próximo turno da conversa — nunca continue a resposta anterior por cima da fala dele.

Fale em português do Brasil, em frases curtas e diretas — isto é uma conversa falada, não um relatório lido em voz alta.`;

// IA-UAT-VOICE-03, Voice Studio (Parte C) — sessão SEM tools, usada
// só para comparar voz/prosódia lendo os textos padrão do laboratório.
// Nunca chama consultar_portal_intelligence, nunca vê pergunta
// financeira real — "ler exatamente o texto fornecido" é fixo, o
// perfil de instrução (pt_br_neutral/executive/warm, Parte C4) só
// ajusta COMO ler, nunca o quê.
const STUDIO_BASE_INSTRUCTIONS = "Você está em um laboratório de teste de voz. Quando o usuário pedir para você ler um texto, leia exatamente o texto fornecido, sem adicionar, remover ou parafrasear nada — só ajuste a entrega de acordo com as características de fala abaixo.\n\n";

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "consultar_portal_intelligence",
    description:
      "Consulta a inteligência financeira do Portal (histórico de financiamentos, simulações, Score F&I, Resultado, ranking, comissões, recomendações comerciais). SEMPRE use esta ferramenta para qualquer pergunta que envolva dado ou cálculo — nunca responda esse tipo de pergunta de nenhuma outra forma. Passe a pergunta do usuário preservando números, nomes de modelo e termos técnicos.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "A pergunta ou pedido do usuário, em português, preservando números e termos técnicos exatamente como foram ditos."
        }
      },
      required: ["message"],
      additionalProperties: false
    }
  }
];

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
  }

  const jsonHeaders = { ...cors, "Content-Type": "application/json" };

  try {
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!openaiKey || !supabaseUrl || !anonKey || !serviceKey) {
      console.error(JSON.stringify({ request_id: requestId, event: "config_error" }));
      return new Response(JSON.stringify({ error: "Conversa por voz ainda não está configurada neste ambiente." }), { status: 503, headers: jsonHeaders });
    }

    // Mesmo gate MASTER-only de portal-ai-homolog/portal-voice-homolog —
    // Realtime nunca é um atalho de autorização.
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
      return new Response(JSON.stringify({ error: "Conversa por voz ainda não está disponível para este perfil." }), { status: 403, headers: jsonHeaders });
    }

    // ---- IA-3B — kill switch server-authoritative (mesmo padrão de
    // ia_texto_habilitada em portal-ai-homolog / portal-voice-homolog).
    // Roda DEPOIS do gate MASTER, ANTES de qualquer parsing de body,
    // mint de credencial efêmera ou chamada à OpenAI -- inclui o modo
    // Voice Studio (Parte C), que nunca pode ser usado para contornar
    // esta flag: o check abaixo acontece antes de `overrides`/`isStudio`
    // sequer serem lidos. Fail-closed em toda ambiguidade. Mesma flag
    // única de portal-voice-homolog -- Voice-01 e Realtime sempre
    // ligam/desligam juntos nesta fase. ----
    let voiceEnabled = false;
    try {
      const { data: cfgData, error: cfgError } = await userClient.rpc("operational_portal_config");
      if (!cfgError) {
        const rows = cfgData?.rows ?? [];
        const row = Array.isArray(rows) ? rows.find((r: any) => r?.chave === "ia_voz_habilitada") : null;
        voiceEnabled = String(row?.valor ?? "").trim().toLowerCase() === "true";
      }
    } catch {
      voiceEnabled = false;
    }
    if (!voiceEnabled) {
      console.log(JSON.stringify({ request_id: requestId, event: "denied_voice_disabled" }));
      return new Response(JSON.stringify({ error: "Conversa por voz está temporariamente indisponível." }), { status: 503, headers: jsonHeaders });
    }

    // IA-UAT-VOICE-03 — corpo opcional, só para os dois usos explícitos
    // desta fase (Parte B: experimento de latência; Parte C: Voice
    // Studio). Body vazio == exatamente o comportamento do VOICE-02,
    // byte a byte. Todo valor passa por allowlist — nunca aceito como
    // veio do cliente.
    let overrides: any = {};
    try {
      const rawBody = await req.text();
      if (rawBody) overrides = JSON.parse(rawBody) || {};
    } catch { /* body inválido == tratado como vazio, usa defaults */ }

    const isStudio = overrides.mode === "studio";
    const voice = (typeof overrides.voice === "string" && ALLOWED_VOICES.has(overrides.voice)) ? overrides.voice : REALTIME_VOICE;
    // UAT-VOICE-ACCENT-01, Gate B2 — só a sessão de conversa real ganha o
    // default 1.25 (a velocidade escolhida pelo usuário); Voice Studio
    // mantém seu próprio comportamento de sempre (sem default aqui, só o
    // que o laboratório mandar).
    const speedOverride = (typeof overrides.speed === "number" && overrides.speed >= 0.25 && overrides.speed <= 1.5) ? overrides.speed : undefined;
    const speed = speedOverride !== undefined ? speedOverride : (isStudio ? undefined : DEFAULT_CONVERSATION_SPEED);
    const eagerness = (typeof overrides.eagerness === "string" && ALLOWED_EAGERNESS.has(overrides.eagerness)) ? overrides.eagerness : undefined;
    const reasoningEffort = (typeof overrides.reasoning_effort === "string" && ALLOWED_REASONING_EFFORT.has(overrides.reasoning_effort)) ? overrides.reasoning_effort : undefined;
    // studioProfileText: só um bloco de descrição de prosódia/sotaque
    // (Parte C4/C5) — nunca substitui a instrução de segurança acima,
    // sempre concatenado depois dela. Limite curto: isto é uma
    // descrição de estilo de fala, não um prompt livre.
    const studioProfileText = (isStudio && typeof overrides.profile_text === "string") ? overrides.profile_text.slice(0, 2000) : "";

    const audioInput: any = {
      turn_detection: isStudio ? null : { type: "semantic_vad", create_response: true, interrupt_response: true }
    };
    const audioOutput: any = { voice };
    if (speed !== undefined) audioOutput.speed = speed;

    const sessionConfig: any = {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: isStudio ? (STUDIO_BASE_INSTRUCTIONS + studioProfileText) : (REALTIME_INSTRUCTIONS + "\n\n" + ACCENT_PROFILE_TEXT),
      audio: { input: audioInput, output: audioOutput },
      tools: isStudio ? [] : REALTIME_TOOLS,
      tool_choice: isStudio ? "none" : "auto",
      output_modalities: ["audio"]
    };
    if (!isStudio && reasoningEffort) sessionConfig.reasoning = { effort: reasoningEffort };
    if (!isStudio && eagerness) sessionConfig.audio.input.turn_detection.eagerness = eagerness;

    const mintResp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_SECONDS },
        session: sessionConfig
      })
    });

    if (!mintResp.ok) {
      const errText = await mintResp.text().catch(() => "");
      console.error(JSON.stringify({ request_id: requestId, event: "mint_failed", status: mintResp.status, detail: errText.slice(0, 500) }));
      return new Response(JSON.stringify({ error: "Não consegui iniciar a sessão de voz agora." }), { status: 502, headers: jsonHeaders });
    }

    const mintJson = await mintResp.json();
    console.log(JSON.stringify({ request_id: requestId, event: "session_minted", user_id: caller.id, expires_at: mintJson.expires_at, mode: isStudio ? "studio" : "conversation", voice, eagerness: eagerness ?? null, reasoning_effort: reasoningEffort ?? null }));

    // Devolve SOMENTE o token efêmero e a expiração — nunca a chave
    // real, nunca o objeto de sessão completo (evita qualquer vazamento
    // acidental de configuração desnecessária ao browser).
    return new Response(JSON.stringify({
      value: mintJson.value,
      expires_at: mintJson.expires_at,
      model: REALTIME_MODEL,
      applied: {
        mode: isStudio ? "studio" : "conversation", voice, speed: speed ?? null,
        eagerness: eagerness ?? null, reasoning_effort: reasoningEffort ?? null,
        accent_profile_applied: !isStudio // UAT-VOICE-ACCENT-01, Gate B1 — rastreável sem expor o texto do perfil ao cliente
      }
    }), { status: 200, headers: jsonHeaders });
  } catch (e) {
    console.error(JSON.stringify({ request_id: requestId, event: "unhandled_error", message: e instanceof Error ? e.message : String(e) }));
    return new Response(JSON.stringify({ error: "Não foi possível iniciar a conversa por voz agora." }), { status: 500, headers: jsonHeaders });
  }
});

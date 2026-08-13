// Fase 4.1 — ATIVAR MEU ACESSO / identificação por CPF.
// Endpoint público (verify_jwt=false): não existe sessão antes deste passo.
// CPF apenas localiza um cadastro elegível — nunca autentica.
// Resposta sempre no mesmo formato/forma, elegível ou não, para não
// permitir enumeração de CPFs cadastrados na empresa.
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);
function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  };
}
const GENERIC = {
  elegivel: false,
  nomeMascarado: ""
};
async function verifyTurnstile(token, ip) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret) return false;
  if (!token) return false;
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body
    });
    const data = await resp.json();
    return data?.success === true;
  } catch (_e) {
    return false;
  }
}
Deno.serve(async (req)=>{
  const origin = req.headers.get("origin");
  const headers = {
    ...corsHeaders(origin),
    "Content-Type": "application/json"
  };
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers
    });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify(GENERIC), {
      status: 200,
      headers
    });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const payload = await req.json().catch(()=>({}));
    const cpf = String(payload?.cpf || "").replace(/\D/g, "");
    const captchaToken = String(payload?.captchaToken || "");
    // Rate limit (janela deslizante por IP) — checa antes de qualquer
    // trabalho de verificação/consulta, para custar o mínimo possível a
    // um cliente que já excedeu o limite.
    const rl = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ativacao_rate_limit_check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_ip: ip,
        p_endpoint: "activation-lookup",
        p_max_tentativas: 10,
        p_janela_minutos: 10
      })
    });
    const permitido = await rl.json().catch(()=>false);
    if (permitido !== true) {
      return new Response(JSON.stringify(GENERIC), {
        status: 429,
        headers
      });
    }
    if (cpf.length !== 11) {
      return new Response(JSON.stringify(GENERIC), {
        status: 200,
        headers
      });
    }
    const turnstileOk = await verifyTurnstile(captchaToken, ip);
    if (!turnstileOk) {
      return new Response(JSON.stringify(GENERIC), {
        status: 403,
        headers
      });
    }
    const lookupResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/activation_lookup_by_cpf`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_cpf: cpf
      })
    });
    if (!lookupResp.ok) {
      return new Response(JSON.stringify(GENERIC), {
        status: 200,
        headers
      });
    }
    const result = await lookupResp.json();
    return new Response(JSON.stringify({
      elegivel: result?.elegivel === true,
      nomeMascarado: result?.nome_mascarado || ""
    }), {
      status: 200,
      headers
    });
  } catch (_e) {
    return new Response(JSON.stringify(GENERIC), {
      status: 200,
      headers
    });
  }
});

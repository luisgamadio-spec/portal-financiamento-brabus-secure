// Fase 4.1 — ATIVAR MEU ACESSO / confirmação de e-mail.
// Fase 4.2 — passou a também emitir a credencial de continuação (token
// distinto, hash separado do token de verificação já consumido) que
// autoriza SOMENTE a etapa seguinte (definir senha) para ESTA ativação.
// Endpoint público (verify_jwt=false), consumido por verificar-acesso.html
// (sem supabase-js, sem sessão). Nesta função, o único efeito no banco é
// marcar EMAIL_VERIFICADO + gravar o hash da continuação. NÃO toca
// auth.users, NÃO toca usuarios.
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);
function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  };
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, "0")).join("");
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
    return new Response(JSON.stringify({
      success: false
    }), {
      status: 200,
      headers
    });
  }
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const payload = await req.json().catch(()=>({}));
    const token = String(payload?.token || "");
    if (!token) {
      return new Response(JSON.stringify({
        success: false
      }), {
        status: 200,
        headers
      });
    }
    const tokenHash = await sha256Hex(token);
    const continuationTokenRaw = randomToken();
    const continuationTokenHash = await sha256Hex(continuationTokenRaw);
    const continuationExpiraEm = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/activation_confirm_email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify({
        p_token_hash: tokenHash,
        p_continuacao_token_hash: continuationTokenHash,
        p_continuacao_expira_em: continuationExpiraEm
      })
    });
    const data = await resp.json().catch(()=>null);
    const ok = resp.ok && data?.ok === true;
    return new Response(JSON.stringify({
      success: ok,
      // Token de continuação só é retornado quando a confirmação
      // realmente aconteceu agora — nunca reaproveitado entre chamadas.
      continuationToken: ok ? continuationTokenRaw : undefined
    }), {
      status: 200,
      headers
    });
  } catch (_e) {
    return new Response(JSON.stringify({
      success: false
    }), {
      status: 200,
      headers
    });
  }
});

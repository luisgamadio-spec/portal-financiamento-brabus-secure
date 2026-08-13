// Fase 4.1 — ATIVAR MEU ACESSO / solicitação de verificação de e-mail.
// Endpoint público (verify_jwt=false): ainda não existe sessão.
// NÃO altera auth.users, NÃO altera usuarios.email_auth — só cria/atualiza
// uma linha em ativacoes_acesso_usuario e envia o e-mail de verificação.
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
async function verifyTurnstile(token, ip) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret || !token) return false;
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
      success: false,
      codigo: "METODO_INVALIDO"
    }), {
      status: 200,
      headers
    });
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN");
  async function callRpc(fn, args) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify(args)
    });
    return {
      ok: resp.ok,
      data: await resp.json().catch(()=>null)
    };
  }
  try {
    const payload = await req.json().catch(()=>({}));
    const cpf = String(payload?.cpf || "").replace(/\D/g, "");
    const captchaToken = String(payload?.captchaToken || "");
    const email = String(payload?.email || "").trim().toLowerCase();
    const celular = String(payload?.celular || "");
    const loja = String(payload?.loja || "");
    const nbs = String(payload?.nbs || "");
    const rl = await callRpc("ativacao_rate_limit_check", {
      p_ip: ip,
      p_endpoint: "activation-request",
      p_max_tentativas: 6,
      p_janela_minutos: 10
    });
    if (rl.data !== true) {
      return new Response(JSON.stringify({
        success: false,
        codigo: "RATE_LIMIT"
      }), {
        status: 429,
        headers
      });
    }
    const turnstileOk = await verifyTurnstile(captchaToken, ip);
    if (!turnstileOk) {
      return new Response(JSON.stringify({
        success: false,
        codigo: "CAPTCHA_INVALIDO"
      }), {
        status: 403,
        headers
      });
    }
    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await callRpc("activation_create_request", {
      p_cpf: cpf,
      p_email_novo: email,
      p_celular_novo: celular,
      p_loja_informada: loja,
      p_nbs_informado: nbs,
      p_token_hash: tokenHash,
      p_expira_em: expiraEm
    });
    if (!result.ok || result.data?.ok !== true) {
      const codigo = result.data?.codigo || "ERRO_DESCONHECIDO";
      return new Response(JSON.stringify({
        success: false,
        codigo
      }), {
        status: 200,
        headers
      });
    }
    // Envio do e-mail — token vai só na URL (fragmento, no HTML da página
    // de callback), nunca fica gravado em texto puro no banco.
    const origemFrontend = ALLOWED_ORIGINS.has(origin || "") ? origin : "https://luisgamadio-spec.github.io/portal-financiamento-brabus-secure";
    const linkConfirmacao = `${origemFrontend}/verificar-acesso.html#token=${rawToken}`;
    const emailResp = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": POSTMARK_TOKEN
      },
      body: JSON.stringify({
        From: "Portal F&I <no-reply@notify.blistiq.com.br>",
        To: email,
        Subject: "Confirme seu e-mail — Ativação do Portal F&I",
        HtmlBody: `
          <p>Recebemos uma solicitação para ativar seu acesso ao Portal F&amp;I.</p>
          <p>Confirme seu e-mail para continuar:</p>
          <p><a href="${linkConfirmacao}">Confirmar e-mail</a></p>
          <p>Este link expira em 30 minutos. Se você não solicitou esta ativação, ignore este e-mail.</p>
        `,
        TextBody: `Recebemos uma solicitação para ativar seu acesso ao Portal F&I.\n\n` + `Confirme seu e-mail para continuar: ${linkConfirmacao}\n\n` + `Este link expira em 30 minutos. Se você não solicitou esta ativação, ignore este e-mail.`,
        MessageStream: "outbound"
      })
    });
    if (!emailResp.ok) {
      const errText = await emailResp.text().catch(()=>"");
      await callRpc("activation_mark_send_error", {
        p_ativacao_id: result.data?.ativacao_id,
        p_erro_codigo: "FALHA_ENVIO_EMAIL",
        p_erro_mensagem: errText.slice(0, 300)
      }).catch(()=>{});
      return new Response(JSON.stringify({
        success: false,
        codigo: "FALHA_ENVIO_EMAIL"
      }), {
        status: 200,
        headers
      });
    }
    return new Response(JSON.stringify({
      success: true,
      codigo: "OK"
    }), {
      status: 200,
      headers
    });
  } catch (_e) {
    return new Response(JSON.stringify({
      success: false,
      codigo: "ERRO_INTERNO"
    }), {
      status: 200,
      headers
    });
  }
});

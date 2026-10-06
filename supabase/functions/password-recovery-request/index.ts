// AUTH-RECOVERY-01 — "Esqueci minha senha" / solicitação.
// PROPOSAL ONLY — not deployed by this wave.
//
// Endpoint público (verify_jwt=false): identifica a conta pelo e-mail
// já verificado (usuarios.email_auth), nunca por CPF. Sempre responde
// com o mesmo formato de sucesso, elegível ou não (proteção contra
// enumeração de e-mails, brief AUTH-RECOVERY-01 Section 4) — a
// distinção só existe dentro de password_recovery_create_request, que
// decide silenciosamente se uma linha foi inserida.
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "https://v2.brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

// AUTH-RECOVERY-02 Section 5/9 -- real defect found and fixed here: the
// HTTP Origin header NEVER carries a path (it is always exactly
// scheme://host[:port]), so a GitHub Pages PROJECT site served under a
// repo-name subpath (V2 homologação:
// https://luisgamadio-spec.github.io/portal-fi-v2/) can never be
// recovered from `origin` alone -- using the bare origin as the link
// base (as the real activation-request's own pattern does) would have
// produced a broken link (404 at the GitHub Pages account root)
// whenever a request genuinely originated from V2's published
// homologação site. This explicit map is the fix: CORS still checks
// the bare origin (ALLOWED_ORIGINS above, correct as-is), but the
// EMAIL LINK is built from this full, path-aware base per known
// origin. V1 production and local already have no subpath, so they
// are unaffected either way.
const ORIGIN_BASE_URL: Record<string, string> = {
  "https://luisgamadio-spec.github.io": "https://luisgamadio-spec.github.io/portal-fi-v2",
  "https://brabus.blistiq.com.br": "https://brabus.blistiq.com.br",
  // Piloto de produção do V2: o link do e-mail volta para o próprio piloto.
  "https://v2.brabus.blistiq.com.br": "https://v2.brabus.blistiq.com.br",
  "http://localhost:8080": "http://localhost:8080",
  "http://127.0.0.1:8080": "http://127.0.0.1:8080"
};
const DEFAULT_BASE_URL = "https://luisgamadio-spec.github.io/portal-fi-v2";

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  };
}

async function verifyTurnstile(token: string, ip: string) {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  if (!secret || !token) return false;
  try {
    const body = new URLSearchParams();
    body.set("secret", secret);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = await resp.json();
    return data?.success === true;
  } catch (_e) {
    return false;
  }
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const GENERIC_OK = { success: true, codigo: "OK" };

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, codigo: "METODO_INVALIDO" }), { status: 200, headers });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN");

  async function callRpc(fn: string, args: Record<string, unknown>) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE as string, Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(args)
    });
    return { ok: resp.ok, data: await resp.json().catch(() => null) };
  }

  try {
    const payload = await req.json().catch(() => ({}));
    const email = String(payload?.email || "").trim().toLowerCase();
    const captchaToken = String(payload?.captchaToken || "");

    // Rate limit first, same shared RPC every other activation endpoint
    // already uses (reused, not duplicated) — a tighter window than
    // activation-request's since a recovery request is a lighter,
    // more-frequently-legitimate action.
    const rl = await callRpc("ativacao_rate_limit_check", {
      p_ip: ip,
      p_endpoint: "password-recovery-request",
      p_max_tentativas: 6,
      p_janela_minutos: 10
    });
    if (rl.data !== true) {
      return new Response(JSON.stringify({ success: false, codigo: "RATE_LIMIT" }), { status: 429, headers });
    }

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      // Still returns the generic success shape — an obviously-malformed
      // email gets the same non-committal response, never a distinct
      // "invalid format" signal that could aid probing.
      return new Response(JSON.stringify(GENERIC_OK), { status: 200, headers });
    }

    const turnstileOk = await verifyTurnstile(captchaToken, ip);
    if (!turnstileOk) {
      return new Response(JSON.stringify({ success: false, codigo: "CAPTCHA_INVALIDO" }), { status: 403, headers });
    }

    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const result = await callRpc("password_recovery_create_request", {
      p_email: email,
      p_token_hash: tokenHash,
      p_expira_em: expiraEm,
      p_ip: ip
    });

    // Only send the email when the RPC silently confirms eligibility —
    // the HTTP response the caller sees is identical either way.
    if (result.ok && result.data?.elegivel === true) {
      const origemFrontend = (origin && ORIGIN_BASE_URL[origin]) || DEFAULT_BASE_URL;
      const linkRecuperacao = `${origemFrontend}/index.html#recuperar-senha=${rawToken}`;
      const emailResp = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": POSTMARK_TOKEN as string },
        body: JSON.stringify({
          From: "Portal F&I <no-reply@notify.blistiq.com.br>",
          To: email,
          Subject: "Redefinição de senha — Portal F&I",
          HtmlBody: `
            <p>Recebemos uma solicitação para redefinir a senha da sua conta no Portal F&amp;I.</p>
            <p>Se foi você, defina uma nova senha:</p>
            <p><a href="${linkRecuperacao}">Redefinir minha senha</a></p>
            <p>Este link expira em 30 minutos. Se você não solicitou esta redefinição, ignore este e-mail — sua senha atual continua válida.</p>
          `,
          TextBody: `Recebemos uma solicitação para redefinir a senha da sua conta no Portal F&I.\n\nSe foi você, defina uma nova senha: ${linkRecuperacao}\n\nEste link expira em 30 minutos. Se você não solicitou esta redefinição, ignore este e-mail.`,
          MessageStream: "outbound"
        })
      });
      // A delivery failure is logged server-side only, via auditoria —
      // never surfaced to the client, which would otherwise leak that
      // the email WAS eligible. Same insert shape as activation-
      // request's own failure logging.
      if (!emailResp.ok) {
        const errText = await emailResp.text().catch(() => "");
        await fetch(`${SUPABASE_URL}/rest/v1/auditoria`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE as string, Authorization: `Bearer ${SERVICE_ROLE}` },
          body: JSON.stringify({
            tipo: "RECUPERACAO_SENHA_FALHA_ENVIO",
            descricao: `Falha ao enviar e-mail de recuperação de senha: ${errText.slice(0, 300)}`,
            base_origem: "Edge Function password-recovery-request",
            resolvido: false
          })
        }).catch(() => {});
      }
    }

    return new Response(JSON.stringify(GENERIC_OK), { status: 200, headers });
  } catch (_e) {
    return new Response(JSON.stringify(GENERIC_OK), { status: 200, headers });
  }
});

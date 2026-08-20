import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Fase 3.5 — passo 1 do fluxo de migração de e-mail (usuário existente,
// e-mail fictício → e-mail real). Requer sessão válida do próprio
// usuário (nunca aceita usuario_id/auth_user_id do payload — tudo
// resolvido a partir do JWT, dentro da RPC iniciar_migracao_email via
// auth.uid()). Não usa service_role para a parte de validação/token —
// só para nada aqui, na verdade: toda a lógica sensível roda dentro da
// RPC SECURITY DEFINER, chamada com o próprio JWT do usuário.
const ALLOWED_ORIGINS = {
  "http://127.0.0.1:8080": "http://127.0.0.1:8080/verificar-email.html",
  "http://localhost:8080": "http://localhost:8080/verificar-email.html",
  "https://luisgamadio-spec.github.io": "https://luisgamadio-spec.github.io/portal-financiamento-brabus-secure/verificar-email.html",
  "https://brabus.blistiq.com.br": "https://brabus.blistiq.com.br/verificar-email.html"
};
const TURNSTILE_ACTION = "email_migration_request";
// Fase 3.6.1 — validação server-side do Turnstile via Siteverify oficial
// da Cloudflare. FALHA FECHADA: qualquer motivo (token ausente/vazio/
// inválido/expirado/reutilizado, indisponibilidade, timeout, resposta
// malformada) resulta em rejeição — nunca chama iniciar_migracao_email
// nem Postmark. Nunca loga secret/captchaToken.
async function verificarTurnstile(token, remoteip, secret) {
  if (!token) return {
    ok: false,
    motivo: "token_ausente"
  };
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(()=>controller.abort(), 8000);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: remoteip || undefined
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const json = await res.json().catch(()=>null);
    if (!res.ok || !json) return {
      ok: false,
      motivo: "resposta_invalida"
    };
    if (json.success !== true) {
      const codes = Array.isArray(json["error-codes"]) ? json["error-codes"].join(",") : "desconhecido";
      return {
        ok: false,
        motivo: `siteverify_falhou:${codes}`
      };
    }
    // action é conferido só se a Cloudflare o devolveu (defesa extra
    // contra reaproveitar um token gerado para outro fluxo, ex. login) —
    // não é hard-requirement documentado, então só rejeita se vier
    // explicitamente diferente do esperado.
    if (json.action && json.action !== TURNSTILE_ACTION) {
      return {
        ok: false,
        motivo: "action_incompativel"
      };
    }
    return {
      ok: true,
      motivo: ""
    };
  } catch (e) {
    return {
      ok: false,
      motivo: "erro_rede_ou_timeout"
    };
  }
}
const ALLOWED_CORS_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

serve(async (req)=>{
  const corsOrigin = req.headers.get("origin");
  const corsHeaders = {
    "Access-Control-Allow-Origin": corsOrigin && ALLOWED_CORS_ORIGINS.has(corsOrigin) ? corsOrigin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", {
        headers: corsHeaders
      });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({
        error: "Método não permitido"
      }), {
        status: 405,
        headers: corsHeaders
      });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const postmarkToken = Deno.env.get("POSTMARK_SERVER_TOKEN");
    const turnstileSecret = Deno.env.get("TURNSTILE_SECRET_KEY");
    if (!supabaseUrl || !anonKey || !postmarkToken || !turnstileSecret) {
      return new Response(JSON.stringify({
        error: "Variáveis de ambiente não configuradas"
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
    const authHeader = req.headers.get("Authorization") || "";
    // Cliente com o JWT do próprio chamador — a RPC resolve auth.uid()
    // a partir dele. Nenhum service_role é necessário nesta função.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const body = await req.json().catch(()=>({}));
    const emailNovo = String(body.email_novo || "").trim();
    const origin = req.headers.get("Origin") || "";
    const redirectBase = ALLOWED_ORIGINS[origin];
    if (!redirectBase) {
      return new Response(JSON.stringify({
        error: "Origem não autorizada"
      }), {
        status: 403,
        headers: corsHeaders
      });
    }
    if (!emailNovo) {
      return new Response(JSON.stringify({
        error: "E-mail é obrigatório"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    // Turnstile — server-side, fail-closed. Nada abaixo deste ponto
    // (RPC de migração, Postmark) executa se isto não passar.
    const captchaToken = String(body.captchaToken || "");
    const remoteip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
    const turnstileResult = await verificarTurnstile(captchaToken, remoteip, turnstileSecret);
    console.log(JSON.stringify({
      evento: "TURNSTILE_EMAIL_MIGRATION",
      timestamp: new Date().toISOString(),
      sucesso: turnstileResult.ok,
      motivo: turnstileResult.ok ? null : turnstileResult.motivo
    }));
    if (!turnstileResult.ok) {
      return new Response(JSON.stringify({
        success: false,
        message: "Não foi possível concluir a verificação de segurança. Tente novamente."
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const { data: rpcData, error: rpcError } = await callerClient.rpc("iniciar_migracao_email", {
      p_email_novo: emailNovo
    });
    if (rpcError) {
      // Mensagem da RPC já é segura para exibir (validações de negócio,
      // sem dado sensível de terceiros).
      return new Response(JSON.stringify({
        error: rpcError.message
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    const migracaoId = rpcData.migracao_id;
    const token = rpcData.token;
    const nome = String(rpcData.nome || "").split(" ")[0] || "";
    const linkVerificacao = `${redirectBase}#token=${token}`;
    const subject = "Confirme seu e-mail — Portal F&I Brabus";
    const textBody = `Olá${nome ? ", " + nome : ""},

Recebemos uma solicitação para atualizar o endereço de e-mail utilizado no Portal F&I Brabus.

Para confirmar, acesse o link abaixo:
${linkVerificacao}

Este link expira em 30 minutos.

Se você não solicitou esta alteração, nenhuma ação é necessária e seu acesso atual continuará funcionando normalmente.

Portal F&I Brabus`;
    const htmlBody = `<p>Olá${nome ? ", " + nome : ""},</p>
<p>Recebemos uma solicitação para atualizar o endereço de e-mail utilizado no Portal F&amp;I Brabus.</p>
<p><a href="${linkVerificacao}">Confirmar meu e-mail</a></p>
<p>Este link expira em 30 minutos.</p>
<p>Se você não solicitou esta alteração, nenhuma ação é necessária e seu acesso atual continuará funcionando normalmente.</p>
<p>Portal F&amp;I Brabus</p>`;
    const postmarkRes = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken
      },
      body: JSON.stringify({
        From: "Portal F&I <no-reply@notify.blistiq.com.br>",
        To: emailNovo,
        Subject: subject,
        TextBody: textBody,
        HtmlBody: htmlBody,
        MessageStream: "outbound",
        TrackOpens: false,
        TrackLinks: "None"
      })
    });
    const postmarkJson = await postmarkRes.json().catch(()=>null);
    const ok = postmarkRes.ok && postmarkJson?.ErrorCode === 0;
    console.log(JSON.stringify({
      evento: "REQUEST_EMAIL_MIGRATION",
      timestamp: new Date().toISOString(),
      migracao_id: migracaoId,
      sucesso: ok,
      http_status: postmarkRes.status,
      postmark_error_code: postmarkJson?.ErrorCode ?? null
    }));
    if (!ok) {
      await callerClient.rpc("migracao_email_marcar_falha_envio", {
        p_migracao_id: migracaoId,
        p_mensagem: `Postmark HTTP ${postmarkRes.status} ErrorCode ${postmarkJson?.ErrorCode ?? "?"}`
      });
      return new Response(JSON.stringify({
        success: false,
        message: "Falha ao enviar e-mail de verificação"
      }), {
        status: 502,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      success: true,
      message: "E-mail de verificação enviado"
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: String(e?.message || e)
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});

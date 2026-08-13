// Fase 4.2 — ATIVAR MEU ACESSO / conclusão (EMAIL_VERIFICADO -> CONCLUIDO).
// Endpoint público (verify_jwt=false) — aceitável somente porque a
// autorização real vem do continuation token (aleatório, hash único,
// curta duração, de uso único), nunca do usuario_id/auth_user_id/email
// informados pelo cliente. Esses dados vêm sempre do servidor
// (activation_prepare_complete), nunca do corpo da requisição.
//
// Única função responsável por: revalidar tudo, travar atomicamente
// (ATIVANDO), atualizar auth.users no MESMO auth_user_id, sincronizar
// public.usuarios, criar revisões cadastrais quando Loja/NBS divergem,
// marcar CONCLUIDO, e notificar MASTER best-effort.
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
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
function validarSenha(senha) {
  if (typeof senha !== "string" || senha.length < 8) {
    return "SENHA_CURTA";
  }
  if (!/[a-zA-Z]/.test(senha) || !/[0-9]/.test(senha)) {
    return "SENHA_FRACA";
  }
  return null;
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
  async function notificarMasterSeNecessario(fin) {
    if (!fin || fin.revisao_criada !== true) return;
    try {
      const cfgResp = await fetch(`${SUPABASE_URL}/rest/v1/configuracoes?chave=eq.email_notificacao_cadastral&select=valor`, {
        headers: {
          apikey: SERVICE_ROLE,
          Authorization: `Bearer ${SERVICE_ROLE}`
        }
      });
      const cfg = await cfgResp.json().catch(()=>[]);
      const destino = cfg?.[0]?.valor;
      if (!destino) return;
      const POSTMARK_TOKEN = Deno.env.get("POSTMARK_SERVER_TOKEN");
      const linhas = [];
      if (fin.revisao_loja) {
        linhas.push(`<p><b>Campo:</b> LOJA<br><b>Valor anterior:</b> ${fin.loja_anterior || "(vazio)"}<br><b>Valor informado:</b> ${fin.loja_nova}</p>`);
      }
      if (fin.revisao_nbs) {
        linhas.push(`<p><b>Campo:</b> LOGIN NBS<br><b>Valor anterior:</b> ${fin.nbs_anterior || "(vazio)"}<br><b>Valor informado:</b> ${fin.nbs_novo}</p>`);
      }
      await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": POSTMARK_TOKEN
        },
        body: JSON.stringify({
          From: "Portal F&I <no-reply@notify.blistiq.com.br>",
          To: destino,
          Subject: "Portal F&I — Revisão cadastral pendente",
          HtmlBody: `
            <p>A ativação de acesso de <b>${fin.usuario_nome}</b> foi concluída normalmente.</p>
            <p>Um ou mais dados informados divergem do cadastro anterior e aguardam revisão:</p>
            ${linhas.join("")}
            <p>Acesse o Painel Master para aprovar ou corrigir.</p>
          `,
          MessageStream: "outbound"
        })
      });
    } catch (_e) {
    // Falha de notificação nunca reverte a ativação — só não é enviada.
    }
  }
  try {
    const payload = await req.json().catch(()=>({}));
    const continuationToken = String(payload?.continuationToken || "");
    const novaSenha = String(payload?.novaSenha || "");
    const confirmarSenha = String(payload?.confirmarSenha || "");
    const rl = await callRpc("ativacao_rate_limit_check", {
      p_ip: ip,
      p_endpoint: "activation-complete",
      p_max_tentativas: 8,
      p_janela_minutos: 15
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
    if (!continuationToken) {
      return new Response(JSON.stringify({
        success: false,
        codigo: "TOKEN_INVALIDO"
      }), {
        status: 200,
        headers
      });
    }
    if (novaSenha !== confirmarSenha) {
      return new Response(JSON.stringify({
        success: false,
        codigo: "SENHAS_NAO_COINCIDEM"
      }), {
        status: 200,
        headers
      });
    }
    const senhaErro = validarSenha(novaSenha);
    if (senhaErro) {
      return new Response(JSON.stringify({
        success: false,
        codigo: senhaErro
      }), {
        status: 200,
        headers
      });
    }
    const tokenHash = await sha256Hex(continuationToken);
    const prep = await callRpc("activation_prepare_complete", {
      p_continuacao_token_hash: tokenHash
    });
    // Retomada segura: Auth já foi atualizado numa tentativa anterior,
    // só falta sincronizar usuarios/revisões — NÃO repete o update de Auth.
    if (prep.data?.codigo === "AGUARDANDO_FINALIZACAO" && prep.data?.ativacao_id) {
      const fin = await callRpc("activation_finalize", {
        p_ativacao_id: prep.data.ativacao_id
      });
      if (fin.ok && fin.data?.ok === true) {
        if (fin.data?.ja_concluida !== true) await notificarMasterSeNecessario(fin.data);
        return new Response(JSON.stringify({
          success: true,
          codigo: "OK"
        }), {
          status: 200,
          headers
        });
      }
      return new Response(JSON.stringify({
        success: false,
        codigo: "FINALIZACAO_PENDENTE"
      }), {
        status: 200,
        headers
      });
    }
    if (!prep.ok || prep.data?.ok !== true) {
      const codigo = prep.data?.codigo || "ERRO_DESCONHECIDO";
      return new Response(JSON.stringify({
        success: false,
        codigo
      }), {
        status: 200,
        headers
      });
    }
    const { ativacao_id, auth_user_id, email_novo } = prep.data;
    // Etapa B — atualiza o MESMO auth_user_id. Nunca cria/exclui identidade.
    const authResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${auth_user_id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify({
        email: email_novo,
        password: novaSenha,
        email_confirm: true
      })
    });
    if (!authResp.ok) {
      const errText = await authResp.text().catch(()=>"");
      await callRpc("activation_revert_after_auth_failure", {
        p_ativacao_id: ativacao_id,
        p_erro_codigo: "FALHA_AUTH_UPDATE",
        p_erro_mensagem: errText.slice(0, 300)
      });
      return new Response(JSON.stringify({
        success: false,
        codigo: "FALHA_AO_ATIVAR"
      }), {
        status: 200,
        headers
      });
    }
    // Ponto sem volta: Auth já mudou. Grava a prova antes de prosseguir.
    await callRpc("activation_mark_auth_ok", {
      p_ativacao_id: ativacao_id
    });
    const fin = await callRpc("activation_finalize", {
      p_ativacao_id: ativacao_id
    });
    if (!fin.ok || fin.data?.ok !== true) {
      // Auth já está correto; usuarios/revisões ficam pendentes de
      // reconciliação (mesmo ativacao_id, chamada idempotente futura).
      return new Response(JSON.stringify({
        success: false,
        codigo: "FINALIZACAO_PENDENTE"
      }), {
        status: 200,
        headers
      });
    }
    await notificarMasterSeNecessario(fin.data);
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

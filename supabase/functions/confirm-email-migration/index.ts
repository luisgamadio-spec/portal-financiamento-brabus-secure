import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Fase 3.5 — passo 2 do fluxo de migração de e-mail. Endpoint PÚBLICO,
// sem sessão (o link pode ser aberto em outro dispositivo/navegador) —
// o token é a única credencial. Resposta sempre genérica para qualquer
// falha (token inválido/expirado/usado), nunca revela dado cadastral,
// nunca permite enumeração.

const GENERIC_ERROR = "Link inválido ou expirado. Solicite novamente no Portal.";
const RATE_LIMIT_MAX_TENTATIVAS = 20;
const RATE_LIMIT_JANELA_MIN = 10;

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método não permitido" }), {
        status: 405,
        headers: corsHeaders
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), {
        status: 500,
        headers: corsHeaders
      });
    }
    const adminClient = createClient(supabaseUrl, serviceKey);

    // Rate limit por IP — defesa em profundidade (token de 256 bits já
    // é a proteção principal, ver Fase 3.2).
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
    const { data: rl } = await adminClient
      .from("migracao_email_confirm_tentativas")
      .select("ip, janela_inicio, tentativas")
      .eq("ip", ip)
      .maybeSingle();
    const agora = new Date();
    if (rl && (agora.getTime() - new Date(rl.janela_inicio).getTime()) < RATE_LIMIT_JANELA_MIN * 60 * 1000) {
      if (rl.tentativas >= RATE_LIMIT_MAX_TENTATIVAS) {
        return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
      await adminClient.from("migracao_email_confirm_tentativas")
        .update({ tentativas: rl.tentativas + 1 }).eq("ip", ip);
    } else {
      await adminClient.from("migracao_email_confirm_tentativas")
        .upsert({ ip, janela_inicio: agora.toISOString(), tentativas: 1 });
    }

    const body = await req.json().catch(() => ({}));
    const token = String(body.token || "");
    if (!token) {
      return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const tokenHash = await sha256Hex(token);

    // Busca por hash — nunca por usuario_id/email vindos da requisição.
    const { data: migracao } = await adminClient
      .from("migracoes_email_usuario")
      .select("*")
      .eq("token_hash", tokenHash)
      .eq("status", "PENDENTE_VERIFICACAO")
      .maybeSingle();

    if (!migracao || new Date(migracao.expira_em).getTime() < Date.now()) {
      return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Transição condicional (WHERE status ainda PENDENTE_VERIFICACAO) —
    // garante exatamente-uma-vez mesmo sob concorrência (ex.: scanner de
    // e-mail corporativo + clique real quase simultâneos).
    const { data: verificado, error: verErr } = await adminClient
      .from("migracoes_email_usuario")
      .update({ status: "VERIFICADO", verificado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() })
      .eq("id", migracao.id)
      .eq("status", "PENDENTE_VERIFICACAO")
      .select()
      .maybeSingle();

    if (verErr || !verificado) {
      // Outra requisição já consumiu — mesma resposta genérica.
      return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Revalidação — o e-mail pode ter deixado de estar disponível entre
    // a solicitação e a confirmação.
    const emailNovo = String(verificado.email_novo);
    const { data: usuarioAtual } = await adminClient
      .from("usuarios")
      .select("id, auth_user_id, email_auth, ativo")
      .eq("id", verificado.usuario_id)
      .maybeSingle();

    const revalidacaoFalhou =
      !usuarioAtual ||
      usuarioAtual.ativo !== true ||
      usuarioAtual.auth_user_id !== verificado.auth_user_id ||
      String(usuarioAtual.email_auth).toLowerCase() !== String(verificado.email_anterior).toLowerCase();

    if (revalidacaoFalhou) {
      await adminClient.from("migracoes_email_usuario").update({
        status: "ERRO", erro_codigo: "REVALIDACAO_FALHOU",
        erro_mensagem: "Estado do usuário mudou entre a solicitação e a confirmação.",
        atualizado_em: new Date().toISOString()
      }).eq("id", migracao.id);
      return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    await adminClient.from("migracoes_email_usuario").update({
      status: "PROCESSANDO", processando_em: new Date().toISOString(), atualizado_em: new Date().toISOString()
    }).eq("id", migracao.id);

    // Único ponto que toca Auth — service_role, updateUserById na MESMA
    // identidade (nunca cria usuário, nunca mexe em senha/metadata).
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(
      verificado.auth_user_id,
      { email: emailNovo, email_confirm: true }
    );

    // Nunca presumir sucesso/falha só pelo retorno — reconsultar sempre.
    const { data: authUserAgora } = await adminClient.auth.admin.getUserById(verificado.auth_user_id);
    const authConfirmadoComNovoEmail =
      !!authUserAgora?.user && String(authUserAgora.user.email).toLowerCase() === emailNovo.toLowerCase();

    if (!authConfirmadoComNovoEmail) {
      await adminClient.from("migracoes_email_usuario").update({
        status: "ERRO", erro_codigo: "AUTH_UPDATE_FALHOU",
        erro_mensagem: String(updateErr?.message || "Não confirmado após reconsulta"),
        atualizado_em: new Date().toISOString()
      }).eq("id", migracao.id);
      return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Auth confirmado — do ponto de vista do usuário, login já funciona
    // com o novo e-mail. Sincroniza usuarios.email_auth; se isso falhar,
    // não é mais um erro para o usuário (AUTH_OK_USUARIOS_PENDENTE, a
    // reconciliação resolve depois).
    const { error: usuariosErr } = await adminClient
      .from("usuarios")
      .update({ email_auth: emailNovo, atualizado_em: new Date().toISOString() })
      .eq("id", verificado.usuario_id);

    if (usuariosErr) {
      await adminClient.from("migracoes_email_usuario").update({
        status: "AUTH_OK_USUARIOS_PENDENTE",
        erro_codigo: "USUARIOS_UPDATE_FALHOU",
        erro_mensagem: String(usuariosErr.message || ""),
        atualizado_em: new Date().toISOString()
      }).eq("id", migracao.id);
      return new Response(JSON.stringify({ success: true, message: "E-mail confirmado com sucesso." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    await adminClient.from("migracoes_email_usuario").update({
      status: "CONCLUIDO", concluido_em: new Date().toISOString(), atualizado_em: new Date().toISOString()
    }).eq("id", migracao.id);

    console.log(JSON.stringify({
      evento: "CONFIRM_EMAIL_MIGRATION",
      timestamp: new Date().toISOString(),
      migracao_id: migracao.id,
      sucesso: true
    }));

    return new Response(JSON.stringify({ success: true, message: "E-mail confirmado com sucesso." }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, message: GENERIC_ERROR }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    });
  }
});

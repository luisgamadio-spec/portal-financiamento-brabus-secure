import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Fase 3.5 — Etapa 16: rotina IDEMPOTENTE de reconciliação para o estado
// AUTH_OK_USUARIOS_PENDENTE (Auth já trocou o e-mail, usuarios.email_auth
// ainda não). MASTER-only. Nunca reenvia e-mail, nunca gera token novo,
// nunca chama updateUserById de novo — só reconsulta Auth (fonte da
// verdade) e sincroniza usuarios se, e somente se, confirmado agora.

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), {
        status: 500,
        headers: corsHeaders
      });
    }

    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401,
        headers: corsHeaders
      });
    }

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: master, error: masterError } = await adminClient
      .from("usuarios")
      .select("id, nome, perfil, ativo")
      .eq("auth_user_id", authData.user.id)
      .eq("perfil", "MASTER")
      .eq("ativo", true)
      .maybeSingle();
    if (masterError || !master) {
      return new Response(JSON.stringify({ error: "Apenas usuário MASTER ativo pode executar reconciliação" }), {
        status: 403,
        headers: corsHeaders
      });
    }

    const { data: pendentes } = await adminClient
      .from("migracoes_email_usuario")
      .select("id, auth_user_id, email_novo")
      .eq("status", "AUTH_OK_USUARIOS_PENDENTE");

    const resultados: any[] = [];
    for (const m of pendentes || []) {
      const { data: authUserAgora } = await adminClient.auth.admin.getUserById(m.auth_user_id);
      const confirmado = !!authUserAgora?.user &&
        String(authUserAgora.user.email).toLowerCase() === String(m.email_novo).toLowerCase();

      if (!confirmado) {
        resultados.push({ migracao_id: m.id, reconciliado: false, motivo: "Auth ainda não confirma o e-mail esperado" });
        continue;
      }

      // Usa o próprio JWT do MASTER chamador — a RPC já valida MASTER de
      // novo, server-side, por conta própria (defesa em profundidade).
      const { error: rpcErr } = await userClient.rpc("master_concluir_reconciliacao_email", {
        p_migracao_id: m.id,
        p_email_confirmado_em_auth: authUserAgora!.user!.email
      });
      resultados.push({ migracao_id: m.id, reconciliado: !rpcErr, erro: rpcErr?.message || null });
    }

    return new Response(JSON.stringify({ success: true, total: (pendentes || []).length, resultados }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    });
  }
});

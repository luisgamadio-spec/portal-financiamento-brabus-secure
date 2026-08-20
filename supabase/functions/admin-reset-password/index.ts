import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };

    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método não permitido" }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");

    if (!supabaseUrl || !serviceKey || !anonKey) {
      return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const authHeader = req.headers.get("Authorization") || "";

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
    });

    const { data: authData, error: authError } = await userClient.auth.getUser();

    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401,
        headers: corsHeaders,
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
      return new Response(JSON.stringify({ error: "Apenas usuário MASTER ativo pode resetar senhas" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = await req.json();

    const cpf = String(body.cpf || "")
      .replace(/\D/g, "")
      .padStart(11, "0");

    const password = String(body.password || "123456");

    if (!cpf || cpf.length !== 11) {
      return new Response(JSON.stringify({ error: "CPF inválido" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Senha deve ter no mínimo 6 caracteres" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { data: target, error: targetError } = await adminClient
      .from("usuarios")
      .select("id, auth_user_id, cpf, nome")
      .eq("cpf", cpf)
      .maybeSingle();

    if (targetError || !target) {
      return new Response(JSON.stringify({ error: "Usuário não encontrado na tabela usuarios" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    if (!target.auth_user_id) {
      return new Response(JSON.stringify({ error: "Usuário ainda não possui primeiro acesso/auth_user_id" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(target.auth_user_id, {
      password,
    });

    if (updateAuthError) {
      return new Response(JSON.stringify({ error: updateAuthError.message }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    await adminClient
      .from("usuarios")
      .update({
        primeiro_acesso: true,
        senha_alterada_em: new Date().toISOString(),
      })
      .eq("cpf", cpf);

    await adminClient.from("auditoria").insert({
      tipo: "RESET_SENHA",
      descricao: `Senha resetada para padrão pelo MASTER ${master.nome || ""}`,
      cpf,
      vendedor: target.nome || "",
      base_origem: "Painel Master",
    });

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Senha resetada com sucesso para 123456",
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  }
});
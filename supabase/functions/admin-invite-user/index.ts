import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Padrão já usado em outras Edge Functions administrativas: dois clientes —
// userClient (anon key + Authorization do chamador) só para identificar
// QUEM está chamando; adminClient (service_role, nunca exposto ao
// navegador) para consultar usuarios com privilégio e operar o Auth Admin.
// A service_role só existe aqui, como variável de ambiente da função.
// Incidente 15.1 — callback de convite real nunca mais decidido pelo
// cliente. Antes desta correção, o redirect vinha de location.origin do
// navegador de quem clicava "convidar", validado só contra uma allowlist
// que incluía localhost para desenvolvimento — um MASTER operando o
// Painel a partir de 127.0.0.1:8080 gerava, sem querer, um convite real
// com link quebrado (casos Bruno/Rodrigo). Agora o callback de produção
// é uma constante fixa no backend; nada vindo do corpo da requisição,
// de Origin ou de Referer jamais participa dessa decisão.
const PRODUCTION_INVITE_REDIRECT = "https://brabus.blistiq.com.br/primeiro-acesso.html";
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

serve(async (req)=>{
  const origin = req.headers.get("origin");
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return new Response(JSON.stringify({
        error: "Variáveis de ambiente não configuradas"
      }), {
        status: 500,
        headers: corsHeaders
      });
    }
    // 1) Quem está chamando? Nunca confiar em nada vindo do frontend sem
    //    verificar o JWT contra o próprio Supabase Auth.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({
        error: "Usuário não autenticado"
      }), {
        status: 401,
        headers: corsHeaders
      });
    }
    const adminClient = createClient(supabaseUrl, serviceKey);
    // 2) É MASTER de verdade, na fonte oficial (tabela usuarios) — não um
    //    perfil que o frontend "disse" que tinha.
    const { data: master, error: masterError } = await adminClient.from("usuarios").select("id, nome, perfil, ativo").eq("auth_user_id", authData.user.id).eq("perfil", "MASTER").eq("ativo", true).maybeSingle();
    if (masterError || !master) {
      return new Response(JSON.stringify({
        error: "Apenas usuário MASTER ativo pode convidar usuários"
      }), {
        status: 403,
        headers: corsHeaders
      });
    }
    const body = await req.json();
    const conviteId = String(body.convite_id || "");
    if (!conviteId) {
      return new Response(JSON.stringify({
        error: "convite_id obrigatório"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    // 3) Convite é sempre relido do banco (fonte de verdade) — nunca se
    //    confia em e-mail/CPF/perfil vindos soltos do payload da requisição.
    //    tentativas_envio é lido aqui para incrementar corretamente (não
    //    mais fixado em 1 a cada chamada).
    const { data: convite, error: conviteError } = await adminClient.from("convites_usuario").select("id, usuario_id, cpf, nome, perfil, loja, email, status, tentativas_envio").eq("id", conviteId).maybeSingle();
    if (conviteError || !convite) {
      return new Response(JSON.stringify({
        error: "Convite não encontrado"
      }), {
        status: 404,
        headers: corsHeaders
      });
    }
    if (convite.status !== "PENDENTE") {
      return new Response(JSON.stringify({
        error: `Convite não está pendente (status atual: ${convite.status})`
      }), {
        status: 409,
        headers: corsHeaders
      });
    }
    // 4) Cenário A × Cenário B: se usuarios.auth_user_id já existir, o
    //    Supabase Auth JÁ criou a conta numa tentativa anterior — chamar
    //    inviteUserByEmail de novo falharia com "already registered"
    //    (limitação conhecida e não resolvida da própria plataforma:
    //    github.com/supabase/auth/issues/2180). admin.generateLink() só
    //    GERA o link, não envia e-mail — sem SMTP customizado não há como
    //    entregar esse link com segurança sem inventar um mailer próprio,
    //    o que não foi autorizado nesta fase. Por isso: recusa explícita
    //    e documentada, em vez de tentar (e falhar) ou improvisar envio.
    const { data: usuarioAlvo, error: usuarioError } = await adminClient.from("usuarios").select("id, auth_user_id").eq("id", convite.usuario_id).maybeSingle();
    if (usuarioError || !usuarioAlvo) {
      return new Response(JSON.stringify({
        error: "Usuário vinculado ao convite não encontrado"
      }), {
        status: 404,
        headers: corsHeaders
      });
    }
    if (usuarioAlvo.auth_user_id) {
      const msg = "Este convite já foi entregue com sucesso anteriormente — já existe uma conta " + "aguardando primeiro acesso para este e-mail. O reenvio automático de e-mail para uma conta " + "já criada não é suportado com segurança pela API atual do Supabase sem SMTP customizado " + "(limitação conhecida da própria plataforma). Verifique com o colaborador se o e-mail não " + "está na caixa de spam antes de tentar qualquer outra ação.";
      await adminClient.from("convites_usuario").update({
        tentativas_envio: (convite.tentativas_envio || 1) + 1,
        atualizado_em: new Date().toISOString()
      }).eq("id", conviteId);
      await adminClient.from("auditoria").insert({
        tipo: "CONVITE_REENVIO_NAO_SUPORTADO",
        descricao: `Reenvio solicitado para ${convite.email}, mas a conta já existe no Auth — reenvio automático recusado (limitação documentada).`,
        base_origem: "Edge Function admin-invite-user",
        vendedor: convite.nome,
        cpf: convite.cpf,
        loja: convite.loja,
        resolvido: false
      });
      return new Response(JSON.stringify({
        error: msg,
        scenario: "B_ACCOUNT_EXISTS"
      }), {
        status: 409,
        headers: corsHeaders
      });
    }
    // 5) Cenário A: nenhuma conta Auth criada ainda — envia o convite real
    //    via Supabase Auth Admin. Único ponto do sistema inteiro que usa
    //    service_role para isso.
    const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(convite.email, {
      redirectTo: PRODUCTION_INVITE_REDIRECT,
      data: {
        nome: convite.nome,
        perfil: convite.perfil,
        loja: convite.loja,
        cpf: convite.cpf
      }
    });
    const novaTentativa = (convite.tentativas_envio || 0) + 1;
    if (inviteError || !invited?.user) {
      await adminClient.from("convites_usuario").update({
        status: "FALHA",
        erro_mensagem: String(inviteError?.message || "Falha desconhecida ao enviar convite"),
        tentativas_envio: novaTentativa,
        atualizado_em: new Date().toISOString()
      }).eq("id", conviteId);
      await adminClient.from("auditoria").insert({
        tipo: "CONVITE_FALHA",
        descricao: `Falha ao enviar convite para ${convite.email}: ${String(inviteError?.message || "erro desconhecido")}`,
        base_origem: "Edge Function admin-invite-user",
        vendedor: convite.nome,
        cpf: convite.cpf,
        loja: convite.loja,
        resolvido: false
      });
      return new Response(JSON.stringify({
        error: "Falha ao enviar convite: " + String(inviteError?.message || "erro desconhecido")
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    // 6) Sucesso: liga o auth.users recém-criado ao registro funcional já
    //    existente em usuarios (mesmo id para sempre — nunca recriado).
    await adminClient.from("usuarios").update({
      auth_user_id: invited.user.id
    }).eq("id", convite.usuario_id);
    await adminClient.from("convites_usuario").update({
      status: "ENVIADO",
      tentativas_envio: novaTentativa,
      atualizado_em: new Date().toISOString()
    }).eq("id", conviteId);
    await adminClient.from("auditoria").insert({
      tipo: "CONVITE_ENVIADO",
      descricao: `Convite enviado com sucesso para ${convite.email} (MASTER: ${master.nome}, tentativa ${novaTentativa})`,
      base_origem: "Edge Function admin-invite-user",
      vendedor: convite.nome,
      cpf: convite.cpf,
      loja: convite.loja,
      resolvido: false
    });
    return new Response(JSON.stringify({
      ok: true,
      message: "Convite enviado com sucesso"
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

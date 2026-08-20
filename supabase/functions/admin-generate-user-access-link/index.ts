import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Incidente 16.1 — contingência de acesso sem depender de entrega por
// e-mail (caso David Portnoi: conta legada, email_auth sintético
// {CPF}@portalfi.brabus, sem caixa postal real). O MASTER gera um link
// (invite ou recovery) e o entrega manualmente ao colaborador; nunca
// enviamos e-mail aqui.
//
// Callback de produção fixo no backend, nunca vindo do cliente — mesma
// correção do Incidente 15.1 (admin-invite-user / admin-resend-user-invite).
const PRODUCTION_ACCESS_REDIRECT = "https://brabus.blistiq.com.br/primeiro-acesso.html";
// Prova técnica (Fase 16.1, Parte A) confirmou empiricamente: gerar um
// novo link do mesmo tipo para o mesmo usuário INVALIDA o anterior,
// mesmo que o anterior nunca tenha sido usado. Por isso o rate limit
// aqui não é só anti-abuso — evita que o próprio MASTER invalide sem
// querer um link que acabou de compartilhar.
const RATE_LIMIT_MIN_INTERVALO_MS = 5 * 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

serve(async (req) => {
  const origin = req.headers.get("origin");
  const corsHeaders = {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers: corsHeaders });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return new Response(JSON.stringify({ error: "Variáveis de ambiente não configuradas" }), { status: 500, headers: corsHeaders });
    }
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), { status: 401, headers: corsHeaders });
    }
    const adminClient = createClient(supabaseUrl, serviceKey);
    // MASTER-only, verificado na fonte oficial — nunca confiar no frontend.
    const { data: master, error: masterError } = await adminClient
      .from("usuarios").select("id, nome, perfil, ativo")
      .eq("auth_user_id", authData.user.id).eq("perfil", "MASTER").eq("ativo", true).maybeSingle();
    if (masterError || !master) {
      return new Response(JSON.stringify({ error: "Apenas usuário MASTER ativo pode gerar links de acesso" }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json();
    const usuarioId = String(body.usuario_id || "");
    const tipo = String(body.tipo || "");
    if (!usuarioId) {
      return new Response(JSON.stringify({ error: "usuario_id obrigatório" }), { status: 400, headers: corsHeaders });
    }
    if (tipo !== "activation" && tipo !== "recovery") {
      return new Response(JSON.stringify({ error: "tipo deve ser 'activation' ou 'recovery'" }), { status: 400, headers: corsHeaders });
    }

    // Default deny — releitura completa do usuário-alvo a partir do banco,
    // nunca de dados soltos vindos do payload.
    const { data: alvo, error: alvoError } = await adminClient
      .from("usuarios").select("id, nome, cpf, perfil, loja, email_auth, auth_user_id, ativo, primeiro_acesso")
      .eq("id", usuarioId).maybeSingle();
    if (alvoError || !alvo) {
      return new Response(JSON.stringify({ error: "Usuário não encontrado" }), { status: 404, headers: corsHeaders });
    }
    if (!alvo.auth_user_id) {
      return new Response(JSON.stringify({ error: "Este usuário ainda não possui conta Auth." }), { status: 409, headers: corsHeaders });
    }

    if (tipo === "activation") {
      if (alvo.ativo || !alvo.primeiro_acesso) {
        return new Response(JSON.stringify({ error: "Este usuário não está elegível para link de ativação (já está ativo ou não aguarda primeiro acesso)." }), { status: 409, headers: corsHeaders });
      }
    } else {
      // recovery
      if (!alvo.ativo || alvo.primeiro_acesso) {
        return new Response(JSON.stringify({ error: "Este usuário não está elegível para link de recuperação (precisa estar ativo, com primeiro acesso já concluído)." }), { status: 409, headers: corsHeaders });
      }
    }

    // Confirma que a conta Auth referenciada realmente existe e bate com
    // o e-mail cadastrado (defesa contra auth_user_id desatualizado) —
    // aplica-se aos dois tipos; o e-mail sintético (@portalfi.brabus) é
    // aceito normalmente para recovery, pois o link nunca é enviado por
    // e-mail, só entregue manualmente pelo MASTER.
    const { data: authAlvo, error: authAlvoError } = await adminClient.auth.admin.getUserById(alvo.auth_user_id);
    if (authAlvoError || !authAlvo?.user) {
      return new Response(JSON.stringify({ error: "Conta Auth vinculada não foi localizada." }), { status: 409, headers: corsHeaders });
    }
    if ((authAlvo.user.email || "").toLowerCase() !== (alvo.email_auth || "").toLowerCase()) {
      return new Response(JSON.stringify({ error: "E-mail divergente entre usuarios e Auth — geração bloqueada por segurança." }), { status: 409, headers: corsHeaders });
    }

    // Rate limit server-side — não depende só da UI.
    const auditoriaTipo = tipo === "activation" ? "LINK_ATIVACAO_GERADO" : "LINK_RECUPERACAO_GERADO";
    const { data: ultimoEvento } = await adminClient
      .from("auditoria").select("criado_em")
      .eq("tipo", auditoriaTipo).eq("cpf", alvo.cpf)
      .order("criado_em", { ascending: false }).limit(1).maybeSingle();
    if (ultimoEvento?.criado_em) {
      const desde = Date.now() - new Date(ultimoEvento.criado_em).getTime();
      if (desde < RATE_LIMIT_MIN_INTERVALO_MS) {
        const restamMin = Math.ceil((RATE_LIMIT_MIN_INTERVALO_MS - desde) / 60000);
        return new Response(JSON.stringify({ error: `Aguarde cerca de ${restamMin} minuto(s) antes de gerar outro link para este usuário. Gerar um novo link invalida o anterior.` }), { status: 429, headers: corsHeaders });
      }
    }

    const linkType = tipo === "activation" ? "invite" : "recovery";
    const generateOptions: Record<string, unknown> = { redirectTo: PRODUCTION_ACCESS_REDIRECT };
    if (tipo === "activation") {
      generateOptions.data = { nome: alvo.nome, perfil: alvo.perfil, loja: alvo.loja, cpf: alvo.cpf };
    }
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: linkType,
      email: authAlvo.user.email as string,
      options: generateOptions
    });
    if (linkError || !linkData?.properties?.action_link) {
      await adminClient.from("auditoria").insert({
        tipo: tipo === "activation" ? "LINK_ATIVACAO_FALHA" : "LINK_RECUPERACAO_FALHA",
        descricao: `Falha ao gerar link (${tipo}) para usuario_id ${alvo.id}: ${String(linkError?.message || "sem action_link")}`,
        base_origem: "Edge Function admin-generate-user-access-link",
        vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
      });
      return new Response(JSON.stringify({ error: "Não foi possível gerar o link." }), { status: 502, headers: corsHeaders });
    }

    // Auditoria SEM segredo — nunca o link/token/hash.
    await adminClient.from("auditoria").insert({
      tipo: auditoriaTipo,
      descricao: `Link de ${tipo === "activation" ? "ativação" : "recuperação"} gerado por ${master.nome} para usuario_id ${alvo.id}`,
      base_origem: "Edge Function admin-generate-user-access-link",
      vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
    });

    // O link só é retornado UMA vez, aqui, ao MASTER autenticado — nunca
    // persistido, nunca logado, nunca gravado em auditoria.
    return new Response(JSON.stringify({ ok: true, link: linkData.properties.action_link }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});

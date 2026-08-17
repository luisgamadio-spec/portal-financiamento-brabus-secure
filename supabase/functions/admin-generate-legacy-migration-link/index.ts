import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Fase 16.5 — contingência de migração legado -> BLISTIQ sem depender do
// Postmark (Fases 16.3/16.4 provaram: generateLink(type='invite') é
// rejeitado pela própria API para Auth legado já confirmado; recovery não
// conclui migração). Reaproveita EXATAMENTE a mesma RPC/estado usados pelo
// fluxo self-service (activation_create_request / ativacoes_acesso_usuario)
// — única fonte de verdade de "migrado" continua sendo
// ativacoes_acesso_usuario.status = 'CONCLUIDO'. Esta função só gera o
// token no backend e devolve o link pronto ao MASTER, sem enviar e-mail.
const PRODUCTION_ACCESS_REDIRECT_BASE = "https://brabus.blistiq.com.br/verificar-acesso.html";
const EMAIL_ACESSO_DOMINIOS_LEGADOS = ["portalfi.brabus", "brabus-fi.local"];
const ATIVACAO_STATUS_EM_ANDAMENTO = ["PENDENTE_EMAIL", "EMAIL_ENVIADO", "EMAIL_VERIFICADO", "PENDENTE_SENHA", "ATIVANDO"];
const RATE_LIMIT_MIN_INTERVALO_MS = 5 * 60 * 1000;

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
function dominioEmail(email: string) {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}
function ehEmailLegado(email: string) {
  return EMAIL_ACESSO_DOMINIOS_LEGADOS.includes(dominioEmail(email));
}
function emailValido(email: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

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
      return new Response(JSON.stringify({ error: "Apenas usuário MASTER ativo pode gerar links de migração." }), { status: 403, headers: corsHeaders });
    }

    const body = await req.json().catch(() => ({}));
    const usuarioId = String(body.usuario_id || "");
    const emailRealInformado = String(body.email_real || "").trim().toLowerCase();
    if (!usuarioId) {
      return new Response(JSON.stringify({ error: "usuario_id obrigatório" }), { status: 400, headers: corsHeaders });
    }

    // Default deny — releitura completa do usuário-alvo a partir do banco,
    // nunca de dados soltos vindos do payload (perfil/status/loja/redirect/
    // email_auth/auth_user_id nunca são aceitos do cliente).
    const { data: alvo, error: alvoError } = await adminClient
      .from("usuarios").select("id, nome, cpf, perfil, loja, login_nbs, celular, email_auth, auth_user_id, ativo, primeiro_acesso")
      .eq("id", usuarioId).maybeSingle();
    if (alvoError || !alvo) {
      return new Response(JSON.stringify({ error: "Usuário não encontrado" }), { status: 404, headers: corsHeaders });
    }
    if (!alvo.auth_user_id) {
      return new Response(JSON.stringify({ error: "Este usuário ainda não possui conta Auth." }), { status: 409, headers: corsHeaders });
    }
    if (!alvo.ativo) {
      return new Response(JSON.stringify({ error: "Este usuário não está ativo." }), { status: 409, headers: corsHeaders });
    }
    if (!ehEmailLegado(alvo.email_auth || "")) {
      return new Response(JSON.stringify({ error: "Este usuário não é uma conta legada elegível para migração BLISTIQ (e-mail de acesso já não é do domínio legado)." }), { status: 409, headers: corsHeaders });
    }

    // Confirma que a conta Auth referenciada realmente existe e bate com o
    // e-mail cadastrado — mesma defesa já usada em admin-generate-user-access-link.
    const { data: authAlvo, error: authAlvoError } = await adminClient.auth.admin.getUserById(alvo.auth_user_id);
    if (authAlvoError || !authAlvo?.user) {
      return new Response(JSON.stringify({ error: "Conta Auth vinculada não foi localizada." }), { status: 409, headers: corsHeaders });
    }
    if ((authAlvo.user.email || "").toLowerCase() !== (alvo.email_auth || "").toLowerCase()) {
      return new Response(JSON.stringify({ error: "E-mail divergente entre usuarios e Auth — geração bloqueada por segurança." }), { status: 409, headers: corsHeaders });
    }

    // Fonte de verdade única (Fase 16.3/16.5): último registro em
    // ativacoes_acesso_usuario decide se já concluiu, está em andamento
    // (reaproveita e-mail já informado) ou nunca começou (exige e-mail novo).
    const { data: ultimaAtivacao } = await adminClient
      .from("ativacoes_acesso_usuario")
      .select("id, status, email_novo, celular_novo, loja_informada, nbs_informado")
      .eq("usuario_id", alvo.id).order("criado_em", { ascending: false }).limit(1).maybeSingle();

    if (ultimaAtivacao?.status === "CONCLUIDO") {
      return new Response(JSON.stringify({ error: "Este usuário já concluiu a migração BLISTIQ." }), { status: 409, headers: corsHeaders });
    }

    // Rate limit server-side — não depende só da UI.
    const { data: ultimoEvento } = await adminClient
      .from("auditoria").select("criado_em")
      .eq("tipo", "LINK_MIGRACAO_GERADO").eq("cpf", alvo.cpf)
      .order("criado_em", { ascending: false }).limit(1).maybeSingle();
    if (ultimoEvento?.criado_em) {
      const desde = Date.now() - new Date(ultimoEvento.criado_em).getTime();
      if (desde < RATE_LIMIT_MIN_INTERVALO_MS) {
        const restamMin = Math.ceil((RATE_LIMIT_MIN_INTERVALO_MS - desde) / 60000);
        return new Response(JSON.stringify({ error: `Aguarde cerca de ${restamMin} minuto(s) antes de gerar outro link para este usuário. Gerar um novo link invalida o anterior.` }), { status: 429, headers: corsHeaders });
      }
    }

    let emailNovo: string;
    let celularNovo: string;
    let lojaInformada: string;
    let nbsInformado: string;
    const temAtivacaoEmAndamento = !!ultimaAtivacao && ATIVACAO_STATUS_EM_ANDAMENTO.includes(ultimaAtivacao.status);

    if (temAtivacaoEmAndamento) {
      // Retoma a mesma tentativa — nunca pede o e-mail de novo, nunca
      // aceita um e-mail diferente do cliente para este caso.
      emailNovo = String(ultimaAtivacao!.email_novo || "");
      celularNovo = String(ultimaAtivacao!.celular_novo || "");
      lojaInformada = String(ultimaAtivacao!.loja_informada || alvo.loja || "");
      nbsInformado = String(ultimaAtivacao!.nbs_informado || alvo.login_nbs || "");
    } else {
      // Nunca iniciou (ou tentativa anterior terminou em ERRO/CANCELADO
      // sem e-mail reaproveitável) — o MASTER precisa informar o e-mail
      // real explicitamente. Nunca inferido a partir do nome.
      if (!emailRealInformado) {
        return new Response(JSON.stringify({ error: "EMAIL_REAL_OBRIGATORIO", codigo: "EMAIL_REAL_OBRIGATORIO" }), { status: 422, headers: corsHeaders });
      }
      if (!emailValido(emailRealInformado)) {
        return new Response(JSON.stringify({ error: "E-mail informado é inválido." }), { status: 400, headers: corsHeaders });
      }
      if (ehEmailLegado(emailRealInformado)) {
        return new Response(JSON.stringify({ error: "O e-mail de destino não pode ser um endereço do domínio legado." }), { status: 400, headers: corsHeaders });
      }
      // Checagem de conflito nas fontes reais de unicidade de e-mail.
      const { data: authConflito } = await adminClient
        .from("usuarios").select("id").neq("id", alvo.id).ilike("email_auth", emailRealInformado).maybeSingle();
      if (authConflito) {
        return new Response(JSON.stringify({ error: "Este e-mail já está em uso por outro usuário." }), { status: 409, headers: corsHeaders });
      }
      // Conflito de e-mail em auth.users é revalidado dentro da própria
      // RPC activation_create_request (EMAIL_JA_EM_USO) — checagem final,
      // atômica, na mesma transação que grava o token.
      const { data: ativacaoConflito } = await adminClient
        .from("ativacoes_acesso_usuario").select("id").neq("usuario_id", alvo.id)
        .ilike("email_novo", emailRealInformado).in("status", ATIVACAO_STATUS_EM_ANDAMENTO).maybeSingle();
      if (ativacaoConflito) {
        return new Response(JSON.stringify({ error: "Este e-mail já está sendo usado em outra migração em andamento." }), { status: 409, headers: corsHeaders });
      }
      const { data: migracaoConflito } = await adminClient
        .from("migracoes_email_usuario").select("id").ilike("email_novo", emailRealInformado)
        .in("status", ["PENDENTE_VERIFICACAO", "VERIFICADO", "PROCESSANDO", "FALHA_ENVIO"]).maybeSingle();
      if (migracaoConflito) {
        return new Response(JSON.stringify({ error: "Este e-mail já está em uso em uma migração de e-mail em andamento." }), { status: 409, headers: corsHeaders });
      }
      const { data: conviteConflito } = await adminClient
        .from("convites_usuario").select("id").ilike("email", emailRealInformado)
        .in("status", ["PENDENTE", "ENVIADO"]).maybeSingle();
      if (conviteConflito) {
        return new Response(JSON.stringify({ error: "Este e-mail já está em uso em um convite pendente." }), { status: 409, headers: corsHeaders });
      }
      emailNovo = emailRealInformado;
      celularNovo = String(alvo.celular || "");
      lojaInformada = String(alvo.loja || "");
      nbsInformado = String(alvo.login_nbs || "");
    }

    const rawToken = randomToken();
    const tokenHash = await sha256Hex(rawToken);
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const rpcResp = await fetch(`${supabaseUrl}/rest/v1/rpc/activation_create_request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({
        p_cpf: alvo.cpf, p_email_novo: emailNovo, p_celular_novo: celularNovo,
        p_loja_informada: lojaInformada, p_nbs_informado: nbsInformado,
        p_token_hash: tokenHash, p_expira_em: expiraEm
      })
    });
    const rpcData = await rpcResp.json().catch(() => null);
    if (!rpcResp.ok || rpcData?.ok !== true) {
      const codigo = rpcData?.codigo || "ERRO_DESCONHECIDO";
      await adminClient.from("auditoria").insert({
        tipo: "LINK_MIGRACAO_FALHA",
        descricao: `Falha ao gerar link de migração (${codigo}) para usuario_id ${alvo.id}, gerado por ${master.nome}`,
        base_origem: "Edge Function admin-generate-legacy-migration-link",
        vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
      });
      return new Response(JSON.stringify({ error: `Não foi possível gerar o link (${codigo}).`, codigo }), { status: 502, headers: corsHeaders });
    }

    // Auditoria SEM segredo — nunca o link/token/hash, e-mail apenas
    // referenciado (já é um dado que o MASTER acabou de ver/digitar).
    await adminClient.from("auditoria").insert({
      tipo: "LINK_MIGRACAO_GERADO",
      descricao: `Link de migração BLISTIQ gerado por ${master.nome} para usuario_id ${alvo.id} (destino: ${emailNovo})`,
      base_origem: "Edge Function admin-generate-legacy-migration-link",
      vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
    });

    const link = `${PRODUCTION_ACCESS_REDIRECT_BASE}#token=${rawToken}`;
    // O link só é retornado UMA vez, aqui, ao MASTER autenticado — nunca
    // persistido, nunca logado, nunca gravado em auditoria.
    return new Response(JSON.stringify({ ok: true, link, email_destino: emailNovo }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as any)?.message || e) }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
    });
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Incidente 13.2 — reenvio seguro de convite para contas Auth já
// criadas e ainda não confirmadas (Checkpoint 7 do Incidente 13.1
// determinou que admin-invite-user recusa deliberadamente esse
// cenário, pois inviteUserByEmail() falha com "already registered"
// para e-mail já existente no Auth — limitação documentada do
// Supabase). Esta função usa generateLink(type:'invite') em vez de
// inviteUserByEmail() para o mesmo e-mail: gera um novo link sem
// tentar recriar a identidade, preservando auth.users.id.
//
// Mesmo padrão de dois clientes já usado em admin-invite-user:
// userClient (anon + JWT do chamador) só identifica quem está
// chamando; adminClient (service_role, nunca exposto ao navegador)
// consulta usuarios com privilégio e opera o Auth Admin.
// Incidente 15.1 — callback de convite real nunca mais decidido pelo
// cliente (mesma correção aplicada em admin-invite-user). Antes, o
// redirect vinha de location.origin do navegador de quem clicava
// "reenviar"; um MASTER operando o Painel a partir de 127.0.0.1:8080
// gerava, sem querer, um reenvio real com link quebrado (caso Bruno).
// Agora o callback de produção é uma constante fixa no backend; nada
// vindo do corpo da requisição, de Origin ou de Referer participa.
const PRODUCTION_INVITE_REDIRECT = "https://brabus.blistiq.com.br/primeiro-acesso.html";
// Template institucional — mesmo conteúdo aprovado no Incidente 12.7
// (mailer_templates_invite_content), reproduzido aqui porque
// generateLink() não passa pelo motor de template do Supabase Auth.
// Só usa nome (sem CPF/NBS/perfil/loja/IDs internos).
function buildInviteHtml(nome, actionLink) {
  const saudacao = nome ? `Olá, ${nome}.` : "Olá.";
  return `<div style="background-color:#f4f4f7;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e5ea;">
    <tr>
      <td style="padding:28px 32px 8px 32px;text-align:center;border-bottom:1px solid #eeeeee;">
        <div style="font-size:11px;letter-spacing:1px;color:#9a8654;text-transform:uppercase;font-weight:bold;">Grupo Brabus Mitsubishi</div>
        <div style="font-size:18px;color:#1a1a1a;font-weight:bold;margin-top:4px;">Portal F&amp;I</div>
      </td>
    </tr>
    <tr>
      <td style="padding:28px 32px;">
        <p style="font-size:15px;line-height:1.5;color:#333333;margin:0 0 16px 0;">${saudacao}</p>
        <p style="font-size:15px;line-height:1.5;color:#333333;margin:0 0 24px 0;">Seu acesso ao Portal F&amp;I — Grupo Brabus Mitsubishi foi criado.</p>
        <p style="font-size:15px;line-height:1.5;color:#333333;margin:0 0 24px 0;">Para concluir seu cadastro e definir sua senha, utilize o botão abaixo.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px auto;">
          <tr>
            <td style="border-radius:8px;background-color:#c0392b;">
              <a href="${actionLink}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">ATIVAR MEU ACESSO</a>
            </td>
          </tr>
        </table>
        <p style="font-size:13px;line-height:1.5;color:#777777;margin:0 0 8px 0;">Por segurança, este link possui prazo de validade.</p>
        <p style="font-size:13px;line-height:1.5;color:#777777;margin:0 0 24px 0;">Se você não reconhece este convite, ignore esta mensagem.</p>
        <p style="font-size:12px;line-height:1.5;color:#999999;margin:0 0 4px 0;">Se o botão não funcionar, copie e cole o endereço abaixo no navegador:</p>
        <p style="font-size:12px;line-height:1.5;color:#4a67d6;margin:0;word-break:break-all;">${actionLink}</p>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 32px;text-align:center;background-color:#fafafa;border-top:1px solid #eeeeee;">
        <p style="font-size:12px;color:#999999;margin:0;">Portal F&amp;I — Grupo Brabus Mitsubishi</p>
        <p style="font-size:11px;color:#bbbbbb;margin:4px 0 0 0;">Desenvolvido por BLISTIQ em 2026.</p>
      </td>
    </tr>
  </table>
</div>`;
}
// Janela mínima entre reenvios para o mesmo usuário (Parte O) — evita
// disparo acidental repetido pelo MASTER, sem depender só da UI.
const REENVIO_MIN_INTERVALO_MS = 5 * 60 * 1000;
serve(async (req)=>{
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
    const postmarkToken = Deno.env.get("POSTMARK_SERVER_TOKEN");
    if (!supabaseUrl || !serviceKey || !anonKey || !postmarkToken) {
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
      return new Response(JSON.stringify({ error: "Apenas usuário MASTER ativo pode reenviar convites" }), { status: 403, headers: corsHeaders });
    }
    const body = await req.json();
    const usuarioId = String(body.usuario_id || "");
    if (!usuarioId) {
      return new Response(JSON.stringify({ error: "usuario_id obrigatório" }), { status: 400, headers: corsHeaders });
    }
    // Default deny — releitura completa do usuário-alvo a partir do banco,
    // nunca de dados soltos vindos do payload (Parte B/C).
    const { data: alvo, error: alvoError } = await adminClient
      .from("usuarios").select("id, nome, cpf, perfil, loja, email_auth, auth_user_id, ativo, primeiro_acesso")
      .eq("id", usuarioId).maybeSingle();
    if (alvoError || !alvo) {
      return new Response(JSON.stringify({ error: "Usuário não encontrado" }), { status: 404, headers: corsHeaders });
    }
    if (!alvo.auth_user_id) {
      return new Response(JSON.stringify({ error: "Este usuário ainda não possui conta Auth — use o convite normal, não o reenvio." }), { status: 409, headers: corsHeaders });
    }
    if (alvo.ativo) {
      return new Response(JSON.stringify({ error: "Este usuário já ativou o acesso — reenvio não se aplica a contas já ativas." }), { status: 409, headers: corsHeaders });
    }
    if (!alvo.primeiro_acesso) {
      return new Response(JSON.stringify({ error: "Este usuário não está aguardando primeiro acesso." }), { status: 409, headers: corsHeaders });
    }
    if (!alvo.email_auth || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alvo.email_auth)) {
      return new Response(JSON.stringify({ error: "E-mail cadastrado inválido para reenvio." }), { status: 409, headers: corsHeaders });
    }
    // Confirma que a conta Auth referenciada realmente existe (não apenas
    // o ponteiro auth_user_id em usuarios).
    const { data: authAlvo, error: authAlvoError } = await adminClient.auth.admin.getUserById(alvo.auth_user_id);
    if (authAlvoError || !authAlvo?.user) {
      return new Response(JSON.stringify({ error: "Conta Auth vinculada não foi localizada." }), { status: 409, headers: corsHeaders });
    }
    if ((authAlvo.user.email || "").toLowerCase() !== alvo.email_auth.toLowerCase()) {
      return new Response(JSON.stringify({ error: "E-mail divergente entre usuarios e Auth — reenvio bloqueado por segurança." }), { status: 409, headers: corsHeaders });
    }
    // Convite original (histórico) — releitura, nunca sobrescrita.
    const { data: convite, error: conviteError } = await adminClient
      .from("convites_usuario").select("id, tentativas_envio, atualizado_em, status")
      .eq("usuario_id", alvo.id).order("convidado_em", { ascending: false }).limit(1).maybeSingle();
    if (conviteError || !convite) {
      return new Response(JSON.stringify({ error: "Convite original não encontrado — não é possível reenviar." }), { status: 404, headers: corsHeaders });
    }
    // Rate limit server-side (Parte O) — não depende só da UI.
    if (convite.atualizado_em) {
      const desde = Date.now() - new Date(convite.atualizado_em).getTime();
      if (desde < REENVIO_MIN_INTERVALO_MS) {
        const restamMin = Math.ceil((REENVIO_MIN_INTERVALO_MS - desde) / 60000);
        return new Response(JSON.stringify({ error: `Aguarde cerca de ${restamMin} minuto(s) antes de tentar reenviar novamente.` }), { status: 429, headers: corsHeaders });
      }
    }
    // Gera novo link SEM recriar a identidade (Parte A/E) — nunca logamos
    // action_link/token, só metadados estruturais.
    const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "invite",
      email: alvo.email_auth,
      options: {
        redirectTo: PRODUCTION_INVITE_REDIRECT,
        data: { nome: alvo.nome, perfil: alvo.perfil, loja: alvo.loja, cpf: alvo.cpf }
      }
    });
    if (linkError || !linkData?.properties?.action_link) {
      await adminClient.from("auditoria").insert({
        tipo: "CONVITE_REENVIO_FALHA",
        descricao: `Falha ao gerar novo link de convite para usuario_id ${alvo.id}: ${String(linkError?.message || "sem action_link")}`,
        base_origem: "Edge Function admin-resend-user-invite",
        vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
      });
      return new Response(JSON.stringify({ error: "Não foi possível reenviar o convite." }), { status: 502, headers: corsHeaders });
    }
    // auth.users.id preservado por definição: generateLink não cria
    // identidade nova, só emite um token para o e-mail informado.
    const actionLink = linkData.properties.action_link;
    const emailResp = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": postmarkToken
      },
      body: JSON.stringify({
        From: "Portal F&I <no-reply@notify.blistiq.com.br>",
        To: alvo.email_auth,
        Subject: "Seu acesso ao Portal F&I",
        HtmlBody: buildInviteHtml(alvo.nome, actionLink),
        TextBody: `Seu acesso ao Portal F&I — Grupo Brabus Mitsubishi foi criado.\n\nPara concluir seu cadastro e definir sua senha, acesse: ${actionLink}\n\nSe você não reconhece este convite, ignore esta mensagem.`,
        MessageStream: "outbound"
      })
    });
    const novaTentativa = (convite.tentativas_envio || 1) + 1;
    if (!emailResp.ok) {
      const errText = await emailResp.text().catch(()=>"");
      await adminClient.from("convites_usuario").update({
        tentativas_envio: novaTentativa, atualizado_em: new Date().toISOString(), erro_mensagem: errText.slice(0, 300)
      }).eq("id", convite.id);
      await adminClient.from("auditoria").insert({
        tipo: "CONVITE_REENVIO_FALHA",
        descricao: `Postmark recusou o reenvio para usuario_id ${alvo.id}: HTTP ${emailResp.status}`,
        base_origem: "Edge Function admin-resend-user-invite",
        vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
      });
      return new Response(JSON.stringify({ error: "Não foi possível reenviar o convite." }), { status: 502, headers: corsHeaders });
    }
    const postmarkResult = await emailResp.json().catch(()=>({}));
    // Histórico preservado (Parte J): mesmo convite original, só
    // incrementa tentativas_envio/atualizado_em — igual ao padrão já
    // usado por admin-invite-user, nunca cria linha nova nem apaga a
    // evidência do primeiro envio.
    await adminClient.from("convites_usuario").update({
      status: "ENVIADO", tentativas_envio: novaTentativa, atualizado_em: new Date().toISOString(), erro_mensagem: null
    }).eq("id", convite.id);
    await adminClient.from("auditoria").insert({
      tipo: "CONVITE_REENVIADO",
      descricao: `Convite reenviado por ${master.nome} para usuario_id ${alvo.id} (tentativa ${novaTentativa}, MessageID mascarado: ${String(postmarkResult.MessageID || "").slice(0, 8)}...)`,
      base_origem: "Edge Function admin-resend-user-invite",
      vendedor: alvo.nome, cpf: alvo.cpf, loja: alvo.loja, resolvido: false
    });
    return new Response(JSON.stringify({ ok: true, message: "Convite reenviado com sucesso" }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }
    });
  }
});

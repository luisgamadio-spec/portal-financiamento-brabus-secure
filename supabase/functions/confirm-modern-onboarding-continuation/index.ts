// Incidente 22.1 -- conclusao do primeiro acesso moderno interrompido
// (Auth confirmado + senha ja definida + usuarios.ativo=false +
// primeiro_acesso=true). Caso sentinela: Herbert Martins Nascimento.
//
// Endpoint publico (verify_jwt=false) -- espelha exatamente o padrao ja
// usado por confirm-access-activation (Fase 4.1/4.2): o token bruto e
// hasheado (SHA-256) aqui, nunca em SQL, e a RPC recebe/compara somente o
// hash. NAO depende de sessao Supabase existente (Parte AK do Incidente
// 22.1) -- o token e o unico credencial, verificado inteiramente pela RPC
// concluir_continuacao_primeiro_acesso (grants: service_role somente,
// nunca anon/authenticated -- mesmo padrao de defesa em profundidade das
// RPCs anonimas do fluxo legado).
//
// NUNCA mexe em auth.users, NUNCA troca senha, NUNCA cria/recria
// identidade -- so conclui o vinculo usuarios/convites_usuario, exatamente
// como concluir_convite_usuario() teria feito se a sessao original nao
// tivesse sido perdida.
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);
function corsHeaders(origin) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  };
}
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false }), { status: 200, headers });
  }
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    const payload = await req.json().catch(() => ({}));
    const token = String(payload?.token || "");
    if (!token) {
      return new Response(JSON.stringify({ success: false, codigo: "TOKEN_INVALIDO" }), { status: 200, headers });
    }
    const tokenHash = await sha256Hex(token);
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/concluir_continuacao_primeiro_acesso`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`
      },
      body: JSON.stringify({ p_token_hash: tokenHash })
    });
    const data = await resp.json().catch(() => null);
    const ok = resp.ok && data?.ok === true;
    // Nunca repassa detalhe interno alem do codigo -- mesma disciplina do
    // restante do fluxo (nunca token/hash/e-mail/CPF na resposta).
    return new Response(JSON.stringify({
      success: ok,
      codigo: data?.codigo || (ok ? "CONCLUIDO" : "ERRO"),
      nome: ok ? data?.nome : undefined
    }), { status: 200, headers });
  } catch (_e) {
    return new Response(JSON.stringify({ success: false, codigo: "ERRO_INTERNO" }), { status: 200, headers });
  }
});

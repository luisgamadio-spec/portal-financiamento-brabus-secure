// AUTH-RECOVERY-01 — "Esqueci minha senha" / conclusão.
// PROPOSAL ONLY — not deployed by this wave.
//
// Endpoint público (verify_jwt=false) — aceitável somente porque a
// autorização real vem do token de recuperação (aleatório, hash único,
// curta duração, uso único, prova de posse do e-mail já verificado),
// nunca do usuario_id/auth_user_id informados pelo cliente. Esses
// dados vêm sempre do servidor, nunca do corpo da requisição.
//
// AUTH-RECOVERY-02 Section 3/9 — ORDEM CORRIGIDA (defeito real
// encontrado e corrigido nesta wave): a versão anterior consumia o
// token ANTES de chamar a Auth Admin API — uma falha na atualização da
// senha deixava o usuário com um token já gasto e nenhum caminho para
// concluir. Agora, na ordem exigida pelo brief:
//   1) password_recovery_prepare  -- valida e TRANCA o token
//      atomicamente (PENDENTE -> PROCESSANDO), sem consumir ainda;
//   2) Auth Admin API atualiza a senha;
//   3a) sucesso  -> password_recovery_finalize (PROCESSANDO ->
//       CONCLUIDA, consumida_em = now() -- SÓ AQUI o token é gasto);
//   3b) falha    -> password_recovery_revert (PROCESSANDO -> PENDENTE
//       -- o MESMO token recebido por e-mail continua válido para nova
//       tentativa, nunca fica "morto" por uma falha que não mudou nada).
// O travamento atômico do passo 1 (UPDATE ... WHERE status='PENDENTE')
// é também o que impede duas requisições concorrentes de processarem o
// mesmo token ao mesmo tempo — nunca há uma janela de uso duplo.
const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "https://v2.brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080"
]);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin"
  };
}

async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validarSenha(senha: string) {
  if (typeof senha !== "string" || senha.length < 8) return "SENHA_CURTA";
  if (!/[a-zA-Z]/.test(senha) || !/[0-9]/.test(senha)) return "SENHA_FRACA";
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, codigo: "METODO_INVALIDO" }), { status: 200, headers });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  async function callRpc(fn: string, args: Record<string, unknown>) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE as string, Authorization: `Bearer ${SERVICE_ROLE}` },
      body: JSON.stringify(args)
    });
    return { ok: resp.ok, data: await resp.json().catch(() => null) };
  }

  try {
    const payload = await req.json().catch(() => ({}));
    const token = String(payload?.token || "");
    const novaSenha = String(payload?.novaSenha || "");
    const confirmarSenha = String(payload?.confirmarSenha || "");

    const rl = await callRpc("ativacao_rate_limit_check", {
      p_ip: ip,
      p_endpoint: "password-recovery-complete",
      p_max_tentativas: 8,
      p_janela_minutos: 15
    });
    if (rl.data !== true) {
      return new Response(JSON.stringify({ success: false, codigo: "RATE_LIMIT" }), { status: 429, headers });
    }

    if (!token) {
      return new Response(JSON.stringify({ success: false, codigo: "TOKEN_INVALIDO" }), { status: 200, headers });
    }
    if (novaSenha !== confirmarSenha) {
      return new Response(JSON.stringify({ success: false, codigo: "SENHAS_NAO_COINCIDEM" }), { status: 200, headers });
    }
    const senhaErro = validarSenha(novaSenha);
    if (senhaErro) {
      return new Response(JSON.stringify({ success: false, codigo: senhaErro }), { status: 200, headers });
    }

    const tokenHash = await sha256Hex(token);

    async function auditoria(tipo: string, descricao: string) {
      await fetch(`${SUPABASE_URL}/rest/v1/auditoria`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE as string, Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ tipo, descricao: descricao.slice(0, 300), base_origem: "Edge Function password-recovery-complete", resolvido: false })
      }).catch(() => {});
    }

    // Step 1: validate + atomically LOCK the token (PENDENTE ->
    // PROCESSANDO). Does NOT consume it yet.
    const prepare = await callRpc("password_recovery_prepare", { p_token_hash: tokenHash });
    if (!prepare.ok || prepare.data?.ok !== true) {
      const codigo = prepare.data?.codigo || "TOKEN_INVALIDO";
      return new Response(JSON.stringify({ success: false, codigo }), { status: 200, headers });
    }

    const { recuperacao_id, auth_user_id, usuario_id } = prepare.data;

    // Step 2: update Auth — same real mechanism activation-complete
    // already uses, server-side only. Never changes email, never
    // creates/deletes an identity.
    // AUTH-RECOVERY-04 Section 2/4 -- a fetch that THROWS (network
    // error, connection reset, our own timeout below) is fundamentally
    // different from a fetch that RETURNS a definitive HTTP response,
    // even an error one. A returned response -- any status code -- means
    // the request reached Auth and Auth processed it: we KNOW the
    // outcome. A thrown exception means we genuinely do not know
    // whether Auth received and applied the change before the failure
    // occurred (our connection could drop after Auth already committed
    // the update). Collapsing these two into one "failure" case (the
    // AUTH-RECOVERY-01/02/03 versions of this file both did) is exactly
    // the bug this wave's brief named: "a ausência do marcador NÃO
    // constitui prova de que a alteração Auth não ocorreu." An explicit
    // 8s timeout turns an indefinitely-hanging call into the SAME
    // "unknown" case, rather than leaving it unbounded.
    let authOutcome;
    let authDetail = "";
    try {
      const authResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${auth_user_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", apikey: SERVICE_ROLE as string, Authorization: `Bearer ${SERVICE_ROLE}` },
        body: JSON.stringify({ password: novaSenha }),
        signal: AbortSignal.timeout(8000)
      });
      if (authResp.ok) {
        authOutcome = "success";
      } else {
        authOutcome = "failure";
        authDetail = await authResp.text().catch(() => "");
      }
    } catch (fetchErr) {
      authOutcome = "unknown";
      authDetail = String((fetchErr as any)?.message || fetchErr);
    }

    if (authOutcome === "failure") {
      // Step 3b: a DEFINITIVE rejection from Auth itself -- the update
      // never applied. Safe to revert: the SAME token (still unconsumed)
      // remains valid for a retry.
      await callRpc("password_recovery_revert", { p_recuperacao_id: recuperacao_id });
      await auditoria("RECUPERACAO_SENHA_FALHA_AUTH", `Falha confirmada pela Auth Admin API (token revertido para nova tentativa): ${authDetail}`);
      return new Response(JSON.stringify({ success: false, codigo: "FALHA_AO_REDEFINIR" }), { status: 200, headers });
    }

    if (authOutcome === "unknown") {
      // Step 3c (NEW): outcome genuinely indeterminate -- NEVER revert
      // (would risk a second real Auth update if the first one actually
      // landed), NEVER finalize by assumption. Move to a distinct,
      // permanent-within-this-system state: RECONCILIACAO_PENDENTE.
      // Resolving it for real requires a human checking Auth's own
      // audit trail directly (outside this schema) -- no RPC here
      // guesses or auto-resolves it.
      await callRpc("password_recovery_mark_ambiguous", { p_recuperacao_id: recuperacao_id });
      await auditoria("RECUPERACAO_SENHA_RESULTADO_INDETERMINADO", `Chamada à Auth Admin API não retornou resposta definitiva (timeout/erro de rede) -- token bloqueado em RECONCILIACAO_PENDENTE, nunca reaberto automaticamente: ${authDetail}`);
      return new Response(JSON.stringify({ success: false, codigo: "RESULTADO_INDETERMINADO" }), { status: 200, headers });
    }

    // AUTH-RECOVERY-03/04 -- we now KNOW Auth succeeded (a definitive
    // 2xx response was received, above). This marker is written
    // immediately, synchronously, before finalize is even attempted --
    // the same "ponto sem volta" checkpoint the real activation-complete
    // already uses (activation_mark_auth_ok, before activation_finalize).
    // HONESTY NOTE (AUTH-RECOVERY-04): this write can ITSELF still fail
    // to persist if the process dies in the split second between
    // authOutcome being set to "success" in memory and this INSERT
    // committing -- no additional write, however placed, can fully close
    // that residual window (this is a fundamental limitation of
    // coordinating two independent systems without a distributed
    // transaction, not a bug this file failed to fix). What changed this
    // wave: reconcile_stuck() no longer treats a MISSING marker as proof
    // of failure -- a stuck PROCESSANDO row with no AUTH_OK marker is now
    // moved to RECONCILIACAO_PENDENTE (never silently reopened to
    // PENDENTE), so even this last-resort crash can never cause a second
    // real Auth update. The marker's real value is the COMMON case: when
    // it DOES persist (the overwhelming majority of the time), it lets
    // reconciliation promote straight to CONCLUIDA instead of leaving
    // every stuck row equally ambiguous.
    await auditoria("RECUPERACAO_SENHA_AUTH_OK", `Auth atualizado com sucesso para usuario_id ${usuario_id} (recuperacao_id ${recuperacao_id}) -- ponto sem volta, gravado antes da finalização.`);

    // Step 3a: Auth confirmed successful — ONLY NOW is the token
    // actually spent.
    const finalize = await callRpc("password_recovery_finalize", { p_recuperacao_id: recuperacao_id });
    if (!finalize.ok || finalize.data?.ok !== true) {
      // Auth already succeeded; finalize lost a race (should be
      // essentially impossible given the exclusive PROCESSANDO lock,
      // but never silently claim failure after a real password change).
      await auditoria("RECUPERACAO_SENHA_FINALIZACAO_PENDENTE", `Senha já redefinida no Auth para usuario_id ${usuario_id}, mas a finalização do registro falhou — requer verificação manual.`);
      return new Response(JSON.stringify({ success: true, codigo: "OK" }), { status: 200, headers });
    }

    await auditoria("RECUPERACAO_SENHA_CONCLUIDA", `Senha redefinida via recuperação self-service para usuario_id ${usuario_id}`);

    return new Response(JSON.stringify({ success: true, codigo: "OK" }), { status: 200, headers });
  } catch (_e) {
    return new Response(JSON.stringify({ success: false, codigo: "ERRO_INTERNO" }), { status: 200, headers });
  }
});

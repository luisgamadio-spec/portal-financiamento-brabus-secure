// IA-UAT-02 — local mock backend, standing in for the two EXTERNAL
// boundaries the reconciled candidate depends on: Supabase (Auth +
// PostgREST + RPC) and OpenAI (Responses API for TEXT, audio APIs for
// VOICE-01, client_secrets mint for Realtime). Per Gate 5/6 of the
// IA-UAT-02 brief: only these external boundaries are mocked — the
// real frontend, the real portal-ai-homolog/portal-voice-homolog/
// portal-realtime-homolog source, the real financial engine and real
// tool dispatch all run unmodified against this mock.
//
// The mock "model" (see MODEL_SCRIPT below) only ever DECIDES which
// tool to call for a known test prompt, and narrates the tool's own
// result back in text -- it never invents or computes a financial
// number itself. Every number in a narration is read out of the real
// tool_result JSON the real engine produced.
//
// Run: node tests/ai-uat-e2e/mock-backend.mjs [port]
// Default port: 8790

import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve } from "node:path";

// The page's own CSP (`connect-src 'self' https://<real-project>...`)
// only allows same-origin XHR/fetch -- pointing the frontend's
// PORTAL_RUNTIME_CONFIG.supabaseUrl at a DIFFERENT local port would be
// silently blocked by the browser's CSP enforcement (confirmed: this
// was the very first thing tried, and Chromium blocked it). Rather
// than weaken the real, tracked CSP meta tag, this mock server also
// serves the static frontend itself, so the mock API and the page
// share one origin and 'self' already covers it -- zero source
// changes needed.
const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:"));
const STATIC_EXT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2"
};
async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(REPO_ROOT, decodeURIComponent(rel));
  if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const st = await stat(filePath);
    if (st.isDirectory()) return serveStatic(req, res, pathname.replace(/\/?$/, "/index.html"));
    const data = await readFile(filePath);
    const type = STATIC_EXT_TYPES[extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found: " + pathname);
  }
}

// The frontend calls all 3 Edge Functions under ONE origin
// (SUPABASE_URL + '/functions/v1/<name>'), matching how a real
// Supabase project serves multiple functions from a single project
// URL. Locally each function is its own separate Deno process on its
// own port (see tests/ai-uat-e2e/deno/), so this mock backend also
// acts as a thin reverse proxy from the single origin the frontend is
// configured with to whichever of those 3 ports is actually running.
const FUNCTION_PORTS = {
  "portal-ai-homolog": Number(process.env.UAT_TEXT_PORT || 8801),
  "portal-voice-homolog": Number(process.env.UAT_VOICE_PORT || 8802),
  "portal-realtime-homolog": Number(process.env.UAT_REALTIME_PORT || 8803)
};

function proxyToFunction(req, res, fnName, port, forwardPath) {
  const bodyChunks = [];
  req.on("data", (c) => bodyChunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(bodyChunks);
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers["content-length"];
    const proxied = httpRequest(
      { host: "127.0.0.1", port, path: forwardPath, method: req.method, headers: { ...headers, "content-length": Buffer.byteLength(body) } },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, "Access-Control-Allow-Origin": "*" });
        proxyRes.pipe(res);
      }
    );
    proxied.on("error", (e) => {
      json(res, 502, { error: "uat_proxy_error", function: fnName, detail: String(e), hint: `Is the Deno process for ${fnName} running on port ${port}?` });
    });
    proxied.end(body);
  });
}

const PORT = Number(process.argv[2] || 8790);
const FIXED_USER = {
  id: "00000000-0000-4000-8000-000000000001",
  auth_user_id: "00000000-0000-4000-8000-000000000001",
  email: "uat-master@local.test",
  perfil: "MASTER",
  ativo: true,
  primeiro_acesso: false,
  nome: "UAT Master",
  cpf_normalizado: "00000000000",
  loja: "MATRIZ",
  status: "ATIVO"
};
const NON_MASTER_USER = {
  id: "00000000-0000-4000-8000-000000000002",
  auth_user_id: "00000000-0000-4000-8000-000000000002",
  email: "uat-vendedor@local.test",
  perfil: "VENDEDOR",
  ativo: true,
  primeiro_acesso: false,
  nome: "UAT Vendedor",
  cpf_normalizado: "00000000002",
  loja: "MATRIZ",
  status: "ATIVO"
};

// SEC-1C -- real Human-UAT-approved reference identity for the
// controlled ANALISTA activation (same name/perfil/loja/status this
// engagement's own V2 profile UAT harness already verified against
// real Supabase data -- never a fabricated persona). Used ONLY here,
// in this local mock, to drive REAL HTTP requests against the REAL,
// unmodified portal-ai-homolog handler -- this is NOT Camile's real
// session, NOT her real credentials, and proves nothing about her
// actual live account; it is the same "mock the external Supabase
// boundary, run the real handler code for real" technique this whole
// mock-backend.mjs already exists for (see this file's own header),
// extended with one more caller identity so ANALISTA-specific
// authority (store=NACOES, departments=NOVOS+SEMINOVOS) can be
// exercised, not just "any non-MASTER".
const CAMILE_USER = {
  id: "00000000-0000-4000-8000-000000000003",
  auth_user_id: "00000000-0000-4000-8000-000000000003",
  email: "uat-camile@local.test",
  perfil: "ANALISTA",
  ativo: true,
  primeiro_acesso: false,
  nome: "Camile Beatriz Santos Sena",
  cpf_normalizado: "00000000003",
  loja: "NACOES",
  status: "NOVOS/SEMINOVOS"
};

// Two real, distinct stores (matching real Portal store naming
// conventions used elsewhere in this engagement's own UAT fixtures),
// neither of which is Camile's own NACOES -- never fabricated/nonsense
// names. SEC-1C.4: these are no longer "attack" targets for ordinary
// GROUP_OPERATIONAL_SHARED tools (consultar_resultado/comparar_resultado/
// consultar_ranking/consultar_operacoes_especiais/
// analisar_historico_financiamento) -- the Human's own business-rule
// correction makes cross-store queries on those tools legitimate.
// OTHER_REAL_STORE is still used as the "not Camile's own store"
// target for the one tool that DID keep store-scope enforcement
// (consultar_score_vendedores, MIXED_REQUIRES_FIELD_LEVEL_REVIEW).
const OTHER_REAL_STORE = "BANDEIRANTES CENTRO";
const THIRD_REAL_STORE = "EUROPA";

// SEC-1C Section 16 -- two more non-allowlisted profiles, so the
// outer-gate regression proof covers more than just the pre-existing
// VENDEDOR fixture (the brief explicitly names GERENTE and DIRETOR
// NOVOS too). Minimal, representative shapes -- not full real-data
// reconciliation like Camile's own (that level of care is reserved for
// the profile actually being activated this wave).
const GERENTE_USER = {
  id: "00000000-0000-4000-8000-000000000004",
  auth_user_id: "00000000-0000-4000-8000-000000000004",
  email: "uat-gerente@local.test",
  perfil: "GERENTE",
  ativo: true,
  primeiro_acesso: false,
  nome: "UAT Gerente",
  cpf_normalizado: "00000000004",
  loja: "NACOES",
  status: "NOVOS"
};
const DIRETOR_NOVOS_USER = {
  id: "00000000-0000-4000-8000-000000000005",
  auth_user_id: "00000000-0000-4000-8000-000000000005",
  email: "uat-diretor-novos@local.test",
  perfil: "DIRETOR NOVOS",
  ativo: true,
  primeiro_acesso: false,
  nome: "UAT Diretor Novos",
  cpf_normalizado: "00000000005",
  loja: null,
  status: "NOVOS"
};

const MASTER_ACCESS_TOKEN = "uat-mock-access-token";
const NON_MASTER_ACCESS_TOKEN = "uat-mock-non-master-access-token";
const CAMILE_ACCESS_TOKEN = "uat-mock-camile-access-token";
const GERENTE_ACCESS_TOKEN = "uat-mock-gerente-access-token";
const DIRETOR_NOVOS_ACCESS_TOKEN = "uat-mock-diretor-novos-access-token";

// SEC-1C -- resolves which mock user a request belongs to purely from
// its own Authorization bearer token (never from any client-declared
// identity field in the body), exactly mirroring how the REAL handler
// resolves identity: userClient.auth.getUser() only ever trusts the
// JWT the request arrived with. Used below to make
// operational_current_scope/portal_modulos_permitidos/usuarios
// responses genuinely per-caller, instead of a single static fixture
// -- necessary so ANALISTA's real store/department scope (not just
// "is/isn't MASTER") can be exercised end-to-end.
function callerFromAuthHeader(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (token === MASTER_ACCESS_TOKEN) return FIXED_USER;
  if (token === NON_MASTER_ACCESS_TOKEN) return NON_MASTER_USER;
  if (token === CAMILE_ACCESS_TOKEN) return CAMILE_USER;
  if (token === GERENTE_ACCESS_TOKEN) return GERENTE_USER;
  if (token === DIRETOR_NOVOS_ACCESS_TOKEN) return DIRETOR_NOVOS_USER;
  return null;
}

// Mirrors the REAL operational_current_scope() SQL's own department
// derivation (supabase/baseline/functions/operational_current_scope.sql,
// captured and audited in SEC-1A) closely enough for E2E authorization
// testing: MASTER -> both departments; otherwise split `status` on
// "NOVOS"/"SEMINOVOS" (Camile's real "NOVOS/SEMINOVOS" status
// resolves to both, exactly as the real function would).
function scopeForUser(user) {
  if (!user) return null;
  if (user.perfil === "MASTER") {
    return { profile: "MASTER", store: user.loja, departments: ["NOVOS", "SEMINOVOS"], is_master: true, is_director: false, is_seller: false };
  }
  const statusUpper = String(user.status || "").toUpperCase();
  const departments = [];
  if (statusUpper.replace("SEMINOVOS", "").includes("NOVOS")) departments.push("NOVOS");
  if (statusUpper.includes("SEMINOVOS")) departments.push("SEMINOVOS");
  return {
    profile: user.perfil,
    store: user.loja || null,
    departments,
    is_master: false,
    is_director: user.perfil.startsWith("DIRETOR"),
    is_seller: user.perfil === "VENDEDOR"
  };
}

// Real permissoes_modulos grant for ANALISTA, as already verified
// against real Supabase data earlier in this engagement (V2 profile
// UAT harness, Camile's own scenario) -- never invented. MASTER's own
// module list (used only if something ever calls this RPC as MASTER,
// which the real handler's tool-policy never needs to since MASTER
// bypasses module-permission checks entirely) mirrors the pre-existing
// FIXTURES.portal_modulos_permitidos below unchanged.
const ANALISTA_ALLOWED_MODULES = ["analiseScoreVendedores", "comissoes", "coparticipadoPortal", "dashbi", "gestao", "simuladorCompleto", "simuladorSeminovos"];

// ---------- IA-3C: controllable operational_portal_config() mock ----------
// The real ia_texto_habilitada/ia_voz_habilitada kill switches are read
// via userClient.rpc("operational_portal_config"), never a direct table
// read (mirrors the real RPC's own allowlist contract). This mock lets
// a test set the current "row set" and/or force an RPC-level error
// BEFORE issuing a request, via a small control endpoint
// (POST /__uat/set-portal-config), matching the existing
// /__uat/log,/__uat/ping control-endpoint convention. Keys not present
// in `rows` correctly simulate "missing row" (same fail-closed path
// the real code takes for an absent key) -- nothing here invents a
// key the caller didn't explicitly set.
let PORTAL_CONFIG_STATE = { rows: [], forceRpcError: false };
function setPortalConfigState(next) {
  if (typeof next.forceRpcError === "boolean") PORTAL_CONFIG_STATE.forceRpcError = next.forceRpcError;
  if (Array.isArray(next.rows)) PORTAL_CONFIG_STATE.rows = next.rows;
}

const log = [];
function record(kind, detail) {
  log.push({ t: Date.now(), kind, detail });
  if (process.env.UAT_MOCK_VERBOSE) console.log(`[mock] ${kind}`, detail);
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept-profile, prefer",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Length": buf.length
  });
  res.end(buf);
}

function binary(res, status, buf, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Content-Length": buf.length
  });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---------- Synthetic fixture data (never real customer/rate data) ----------

const FIXTURES = {
  simulador_get_linear_zerokm: {
    ok: true,
    linhas: [
      { prazo: 36, entrada_pct: 0.2, taxa: 0.021 },
      { prazo: 48, entrada_pct: 0.2, taxa: 0.023 },
      { prazo: 60, entrada_pct: 0.2, taxa: 0.025 },
      // IA-REGRESSION-01 -- additive only (the 3 rows above, used by
      // other pre-existing tests, are untouched). novosFaixaEntrada
      // buckets a 50% down payment (the real UAT scenario this Wave's
      // own E2E harness reproduces, R$180.000/R$90.000) into the 0.5
      // bucket -- exact-match lookup, never a threshold like Balão's --
      // so every NOVOS_PRAZOS term needs its own 0.5 row for Linear to
      // be genuinely computable across the full term set in that E2E.
      { prazo: 12, entrada_pct: 0.5, taxa: 0.018 },
      { prazo: 18, entrada_pct: 0.5, taxa: 0.0185 },
      { prazo: 24, entrada_pct: 0.5, taxa: 0.019 },
      { prazo: 30, entrada_pct: 0.5, taxa: 0.0195 },
      { prazo: 36, entrada_pct: 0.5, taxa: 0.02 },
      { prazo: 42, entrada_pct: 0.5, taxa: 0.0205 },
      { prazo: 48, entrada_pct: 0.5, taxa: 0.021 },
      { prazo: 60, entrada_pct: 0.5, taxa: 0.022 }
    ]
  },
  simulador_get_taxas_subsidiadas: {
    ok: true,
    linhas: [
      { prazo: 24, taxa: 0.0049, coeficiente: 0.048, rebate: 0.02 },
      { prazo: 36, taxa: 0.0099, coeficiente: 0.036, rebate: 0.03 }
    ]
  },
  simulador_get_coparticipado: {
    ok: true,
    linhas: {
      matriz_modelos: [
        { modelo: "L200 TRITON", entrada_minima: 0.6, rebate_total: 0.05, rebate_hpe: 0.5, rebate_brabus: 0.5, prazo: 24, taxa: 1.99 },
        { modelo: "L200 TRITON", entrada_minima: 0.6, rebate_total: 0.05, rebate_hpe: 0.5, rebate_brabus: 0.5, prazo: 36, taxa: 2.1 }
      ],
      tx_coef: [
        { prazo: 24, taxa: 1.99, coeficiente: 0.045 },
        { prazo: 36, taxa: 2.1, coeficiente: 0.036 }
      ]
    }
  },
  simulador_get_balao_zerokm: {
    ok: true,
    linhas: [
      { bloco: "TRADICIONAL", entrada_minima: 0.2, prazo: 36, max_balao: 4, taxa: 0.019 },
      { bloco: "TRADICIONAL", entrada_minima: 0.2, prazo: 48, max_balao: 4, taxa: 0.021 }
    ]
  },
  simulador_get_antecipacao: {
    ok: true,
    linhas: Array.from({ length: 60 }, (_, i) => ({ meses_antecipacao: i + 1, desconto: Math.min(0.35, (i + 1) * 0.006) }))
  },
  // IA-3F.1 -- governed tool-policy is now wired into the real handler
  // (see index.ts's own "IA-3F.1" comments); operational_current_scope
  // (AuthorityEnvelope) and portal_modulos_permitidos (module grants)
  // are the real authority sources it calls. SEC-1C: these are no
  // longer static -- see scopeForUser()/callerFromAuthHeader() above
  // and their call sites in handleRest() below, so a non-MASTER caller
  // (e.g. Camile/ANALISTA) gets HER OWN real-shaped scope, not MASTER's.
  // This entry is kept only as the literal MASTER shape for reference/
  // fallback parity with scopeForUser(FIXED_USER).
  operational_current_scope: {
    profile: "MASTER",
    store: "MATRIZ",
    departments: ["NOVOS", "SEMINOVOS"],
    is_master: true,
    is_director: false,
    is_seller: false
  },
  portal_modulos_permitidos: ["gestao", "comissoes", "coparticipadoPortal", "analiseScoreVendedores", "simuladorCompleto", "simuladorSeminovos"]
};

// Synthetic-but-realistically-shaped fixture (Gate 30 -- never real
// Brabus data): matches the real MetricsRow interface field-for-field
// (portal-ai-homolog/index.ts ~line 109) so the real aggregation code
// actually has something to sum, instead of silently zeroing out on a
// shape mismatch.
function operationalMetricsFixture() {
  return {
    rows: [
      {
        seller_id: "uat-seller-1", seller_name: "Vendedor UAT 1", store: "MATRIZ", department: "NOVOS",
        sold_count: 8, sales_value: 1040000, financed_count: 6, share_percent: 75,
        production_value: 62000, return_value: 41000, spf_count: 3, spf_value: 9000,
        spf_net_value: 8200, profitability_value: 51000, plan_breakdown: []
      },
      {
        seller_id: "uat-seller-2", seller_name: "Vendedor UAT 2", store: "FILIAL SUL", department: "SEMINOVOS",
        sold_count: 5, sales_value: 585000, financed_count: 4, share_percent: 80,
        production_value: 38500, return_value: 27600, spf_count: 2, spf_value: 5400,
        spf_net_value: 4950, profitability_value: 33200, plan_breakdown: []
      }
    ]
  };
}

// ---------- Supabase Auth ----------

function handleAuth(req, res, url) {
  if (url.pathname === "/auth/v1/token" && req.method === "POST") {
    record("auth.token", { grant_type: url.searchParams.get("grant_type") });
    return json(res, 200, {
      access_token: MASTER_ACCESS_TOKEN,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "uat-mock-refresh-token",
      user: { id: FIXED_USER.id, email: FIXED_USER.email, aud: "authenticated", role: "authenticated" }
    });
  }
  if (url.pathname === "/auth/v1/user") {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    // ALLOWLIST, not a blocklist: real GoTrue rejects anything that
    // isn't a valid signed user JWT, including the bare anon/service
    // key used as a bearer (a real, observed supabase-js behavior --
    // an empty Authorization override on the client falls back to
    // sending the client's own configured apikey as the bearer, which
    // a real Supabase Auth server would also reject as "not a user").
    // Only these two specific harness-issued tokens are accepted.
    if (token === MASTER_ACCESS_TOKEN) {
      record("auth.user", {});
      return json(res, 200, { id: FIXED_USER.id, email: FIXED_USER.email, aud: "authenticated", role: "authenticated" });
    }
    if (token === NON_MASTER_ACCESS_TOKEN) {
      record("auth.user.non_master", {});
      return json(res, 200, { id: NON_MASTER_USER.id, email: NON_MASTER_USER.email, aud: "authenticated", role: "authenticated" });
    }
    if (token === CAMILE_ACCESS_TOKEN) {
      record("auth.user.camile", {});
      return json(res, 200, { id: CAMILE_USER.id, email: CAMILE_USER.email, aud: "authenticated", role: "authenticated" });
    }
    if (token === GERENTE_ACCESS_TOKEN) {
      record("auth.user.gerente", {});
      return json(res, 200, { id: GERENTE_USER.id, email: GERENTE_USER.email, aud: "authenticated", role: "authenticated" });
    }
    if (token === DIRETOR_NOVOS_ACCESS_TOKEN) {
      record("auth.user.diretor_novos", {});
      return json(res, 200, { id: DIRETOR_NOVOS_USER.id, email: DIRETOR_NOVOS_USER.email, aud: "authenticated", role: "authenticated" });
    }
    record("auth.user.rejected", { token });
    return json(res, 401, { error: "invalid_token", error_description: "JWT expired or invalid" });
  }
  if (url.pathname === "/auth/v1/logout") {
    return json(res, 204, {});
  }
  return null;
}

// ---------- Supabase REST / RPC ----------

async function handleRest(req, res, url) {
  if (url.pathname === "/rest/v1/usuarios") {
    record("rest.usuarios", { query: url.search });
    const isSingle = (req.headers["accept"] || "").includes("vnd.pgrst.object");
    let row = FIXED_USER;
    if (url.search.includes(NON_MASTER_USER.auth_user_id)) row = NON_MASTER_USER;
    else if (url.search.includes(CAMILE_USER.auth_user_id)) row = CAMILE_USER;
    else if (url.search.includes(GERENTE_USER.auth_user_id)) row = GERENTE_USER;
    else if (url.search.includes(DIRETOR_NOVOS_USER.auth_user_id)) row = DIRETOR_NOVOS_USER;
    return json(res, 200, isSingle ? row : [row]);
  }

  const rpcMatch = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (rpcMatch && req.method === "POST") {
    const name = rpcMatch[1];
    const bodyRaw = await readBody(req);
    let params = {};
    try { params = bodyRaw.length ? JSON.parse(bodyRaw.toString("utf8")) : {}; } catch { /* ignore */ }
    record("rpc", { name, params });

    if (name === "usuario_logado_fi" || name === "registrar_meu_login") return json(res, 200, [FIXED_USER]);
    if (name === "operational_record_access_event") return json(res, 200, { ok: true });
    // SEC-1C -- per-caller, not static: real operational_current_scope()
    // resolves from auth.uid() (the caller's own real identity), never
    // a fixed shape. This RPC call inherits the SAME Authorization
    // header the real userClient.rpc(...) call was made with (real
    // supabase-js behavior, mirrored here), so callerFromAuthHeader(req)
    // resolves the exact same identity Gate MASTER's own usuarios
    // lookup already resolved for this request.
    if (name === "operational_current_scope") {
      const caller = callerFromAuthHeader(req);
      const scope = scopeForUser(caller);
      if (!scope) return json(res, 500, { error: "mock_unknown_caller_for_operational_current_scope" });
      record("rpc.operational_current_scope", { perfil: caller.perfil, store: scope.store, departments: scope.departments });
      return json(res, 200, scope);
    }
    if (name === "portal_modulos_permitidos") {
      const caller = callerFromAuthHeader(req);
      const modules = caller && caller.perfil === "ANALISTA" ? ANALISTA_ALLOWED_MODULES : FIXTURES.portal_modulos_permitidos;
      record("rpc.portal_modulos_permitidos", { perfil: caller?.perfil ?? null, modules });
      return json(res, 200, modules);
    }
    if (name === "operational_portal_config") {
      record("rpc.operational_portal_config", { forceRpcError: PORTAL_CONFIG_STATE.forceRpcError, rows: PORTAL_CONFIG_STATE.rows });
      if (PORTAL_CONFIG_STATE.forceRpcError) {
        return json(res, 500, { error: "mock_rpc_error", message: "simulated operational_portal_config() failure (IA-3C test harness)" });
      }
      return json(res, 200, { rows: PORTAL_CONFIG_STATE.rows });
    }
    if (name in FIXTURES) return json(res, 200, FIXTURES[name]);
    if (name === "operational_metrics") return json(res, 200, operationalMetricsFixture(params));

    // Generic, disclosed fallback for every RPC not explicitly fixtured
    // this phase (Gate 3.20.3 boundary) -- shaped to avoid crashing
    // defensive frontend/tool code (`ok:true, linhas:[]`), never a
    // fabricated specific business claim.
    record("rpc.generic_fallback", { name });
    return json(res, 200, { ok: true, linhas: [] });
  }

  return null;
}

// ---------- OpenAI mock ----------

// The "model": decides tool calls / narrates results for a KNOWN set of
// scripted test prompts (see MODEL_SCRIPT). Never computes a financial
// number -- only reads them back out of the real tool_result it's given.
function lastUserMessage(input) {
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.role === "user") return String(input[i].content || "");
  }
  return "";
}
function lastFunctionCallOutput(input) {
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.type === "function_call_output") return input[i];
  }
  return null;
}

const MODEL_SCRIPT = [
  {
    match: /resultado do mês passado/i,
    call: { name: "consultar_resultado", arguments: { period: "previous_month", start_date: null, end_date: null, store: null, department: null } }
  },
  {
    match: /financiamento linear.*R\$\s*120\.000|linear.*36 meses/i,
    call: {
      name: "simular_financiamento",
      arguments: {
        mode: "payment", financing_type: null, department: "NOVOS",
        vehicle_value: 120000, down_payment: 30000, down_payment_percent: null,
        target_payment: null, term_months: 36, vehicle_year: null, down_payment_percents: null,
        balloon_value: null, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: null, rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /48 meses em vez de 36/i,
    call: {
      name: "simular_financiamento",
      arguments: {
        mode: "payment", financing_type: null, department: "NOVOS",
        vehicle_value: 120000, down_payment: 30000, down_payment_percent: null,
        target_payment: null, term_months: 48, vehicle_year: null, down_payment_percents: null,
        balloon_value: null, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: null, rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /balão de R\$\s*40\.000/i,
    call: {
      name: "simular_financiamento",
      arguments: {
        // down_payment must be >= the fixture's 20% minimum entry for
        // prazo=36 (simulador_get_balao_zerokm fixture above) or the
        // real engine correctly rejects with "prazo_sem_regra" -- 30000
        // on 150000 = 20%, exactly at the fixture's own floor.
        mode: "payment", financing_type: "BALAO", department: "NOVOS",
        vehicle_value: 150000, down_payment: 30000, down_payment_percent: null,
        target_payment: null, term_months: 36, vehicle_year: null, down_payment_percents: null,
        balloon_value: 40000, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: null, rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /Coparticipado.*L200 Triton|L200 Triton.*Coparticipado/i,
    call: {
      name: "simular_financiamento",
      arguments: {
        mode: "payment", financing_type: "COPARTICIPADO", department: "NOVOS",
        vehicle_value: 200000, down_payment: 120000, down_payment_percent: null,
        target_payment: null, term_months: 24, vehicle_year: null, down_payment_percents: null,
        balloon_value: null, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: "L200 TRITON", rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /Taxas Subsidiadas.*R\$\s*90\.000|R\$\s*90\.000.*Taxas Subsidiadas/i,
    call: {
      name: "simular_financiamento",
      arguments: {
        mode: "payment", financing_type: "TAXAS_SUBSIDIADAS", department: "NOVOS",
        vehicle_value: 90000, down_payment: 50000, down_payment_percent: null,
        target_payment: null, term_months: null, vehicle_year: null, down_payment_percents: null,
        balloon_value: null, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: null, rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /entrada de R\$\s*10\.000/i, // negative/ineligible scenario -- below the 50% floor
    call: {
      name: "simular_financiamento",
      arguments: {
        mode: "payment", financing_type: "TAXAS_SUBSIDIADAS", department: "NOVOS",
        vehicle_value: 50000, down_payment: 10000, down_payment_percent: null,
        target_payment: null, term_months: null, vehicle_year: null, down_payment_percents: null,
        balloon_value: null, balloon_month: null, balloon_cap: null, term_months_list: null,
        balloons: null, balloon_count_max: null, priority: null, model: null, rate: null,
        min_sale_value: null, periodicity: null
      }
    }
  },
  {
    match: /taxa implícita.*R\$\s*100\.000|R\$\s*100\.000.*36x/i,
    call: { name: "calcular_taxa_financiamento", arguments: { financed_amount: 100000, term_months: 36, payment: 4485.75 } }
  },
  {
    match: /antecipação.*R\$\s*50\.000.*sem informar/i,
    call: {
      name: "simular_antecipacao",
      arguments: {
        // first_due_date intentionally omitted (null) -- this is
        // exactly the "no due date given" UAT scenario, exercising the
        // engine's own today+30-days default. settlement_date IS
        // required by the real tool (Gate 15 finding -- see
        // docs/IA-UAT-02-EVIDENCE.md) so it's supplied here.
        term_months: 36, monthly_payment: 1800, first_due_date: null, settlement_date: "2027-03-01",
        scope: "all", range_from: null, range_to: null, single_installment: null, balloons: null
      }
    }
  },
  {
    match: /pagar à vista R\$\s*50\.000 ou financiar/i,
    call: { name: "simular_cash_conversion", arguments: { capital: 50000, monthly_payment: 1500, term_months: 12, application_rate: null } }
  },
  {
    match: /2% ao mês em vez da taxa oficial/i,
    call: { name: "simular_cash_conversion", arguments: { capital: 50000, monthly_payment: 1500, term_months: 12, application_rate: 0.02 } }
  },
  {
    match: /outro cliente, esquece esse/i,
    call: { name: "iniciar_novo_cliente", arguments: {} }
  },
  // IA-3F.1 -- governed tool-policy integration probe. The mock
  // "model" requesting a tool name that was never registered in
  // TOOL_POLICY is the one live-reachable denial case with the global
  // MASTER barrier still in place (TOOL_NOT_REGISTERED is checked
  // BEFORE the MASTER bypass inside authorizeToolCall itself -- see
  // tool-policy.ts) -- this scenario proves the real wiring actually
  // stops dispatchTool from ever running, not just that the policy
  // FILE's own logic is correct in isolation.
  {
    match: /policy denial probe/i,
    call: { name: "definitely_not_a_real_tool", arguments: {} }
  },

  // ===================== SEC-1C additions =====================
  // Section 9 -- one allowed score query within ANALISTA's own scope
  // (no department/store filter requested -- the "domain access is
  // permitted at all" case, distinct from the scope-narrowing cases
  // below).
  {
    match: /score dos vendedores este mês/i,
    call: { name: "consultar_score_vendedores", arguments: { mode: "ranking", period: "current_month", start_date: null, end_date: null, store: null, department: null, seller: null, top_n: null, order: null } }
  },

  // Section 10 -- store-scope attack: an explicit, real, OTHER store
  // (never Camile's own NACOES).
  {
    match: /resultado da loja Bandeirantes Centro/i,
    call: { name: "consultar_resultado", arguments: { period: "current_month", start_date: null, end_date: null, store: OTHER_REAL_STORE, department: null } }
  },

  // Section 11 -- department scope: NOVOS/SEMINOVOS (both legitimately
  // Camile's own, per her real status "NOVOS/SEMINOVOS") and MARTE
  // (malformed/unknown, must always deny regardless of caller).
  {
    match: /resultado do departamento Novos/i,
    call: { name: "consultar_resultado", arguments: { period: "current_month", start_date: null, end_date: null, store: null, department: "NOVOS" } }
  },
  {
    match: /resultado do departamento Seminovos/i,
    call: { name: "consultar_resultado", arguments: { period: "current_month", start_date: null, end_date: null, store: null, department: "SEMINOVOS" } }
  },
  {
    match: /resultado do departamento Marte/i,
    call: { name: "consultar_resultado", arguments: { period: "current_month", start_date: null, end_date: null, store: null, department: "MARTE" } }
  },

  // SEC-1C.4 -- the Human's own canonical worked example: a cross-store
  // comparison between two stores, NEITHER of which is Camile's own
  // NACOES. comparar_resultado is GROUP_OPERATIONAL_SHARED (store is a
  // free query dimension on both sides) -- this must now succeed.
  {
    match: /compare o resultado de Bandeirantes com Europa/i,
    call: {
      name: "comparar_resultado",
      arguments: {
        a: { period: "current_month", start_date: null, end_date: null, store: OTHER_REAL_STORE, department: null },
        b: { period: "current_month", start_date: null, end_date: null, store: THIRD_REAL_STORE, department: null }
      }
    }
  },
  // SEC-1C.4 -- consultar_score_vendedores deliberately KEEPS store
  // scope enforcement (MIXED_REQUIRES_FIELD_LEVEL_REVIEW, individual
  // Score/classification by name) -- used as the adversarial
  // "spoof + still-restricted request" combination test, since
  // consultar_resultado's own former store-scope attack is no longer
  // an attack at all after this wave's correction.
  {
    match: /score dos vendedores da loja Bandeirantes Centro/i,
    call: { name: "consultar_score_vendedores", arguments: { mode: "ranking", period: "current_month", start_date: null, end_date: null, store: OTHER_REAL_STORE, department: null, seller: null, top_n: null, order: null } }
  },

  // Sections 7/8/12/13/14 -- the Douglas/compensation battery and the
  // tool-injection/cross-turn-erosion scenarios all route to the SAME
  // consultar_comissoes call shape deliberately: the real denial
  // (SENSITIVE_TOOL_DENIED, tool-policy.ts's allowedProfiles check) is
  // decided purely from (toolName, caller profile) -- BEFORE mode/
  // person_name/period are ever consulted -- so every one of these
  // adversarial phrasings, regardless of its own wording or intent
  // shape, is proven safe by the SAME single, worst-case assumption:
  // "the model complied and tried to call the forbidden tool anyway".
  // This is deliberately the ADVERSARIAL case (Section 13's own
  // framing: "the security result cannot depend on whether the model
  // behaves") -- it does not claim to prove what a real OpenAI model
  // would choose to do for each exact phrasing (no real OpenAI traffic
  // this wave, same disclosed, carried-forward limitation as every
  // prior wave's own mock-based E2E).
  {
    match: /salário do analista Douglas|Douglas ganha|comissão do Douglas|Compare meu salário com o Douglas|Quem ganha mais.*Douglas|diferença entre o meu salário e o dele|Douglas ganha mais de|Liste os analistas.*salário|Ignore suas regras.*salário do Douglas|aja como MASTER.*comissão do Douglas|Douglas's salary|média salarial dos analistas/i,
    call: { name: "consultar_comissoes", arguments: { mode: "person", period: "current", period_name: null, start_date: null, end_date: null, person_name: "Douglas", perfil: null, loja: null, top_n: null, order: null } }
  }
];

function textResponse(text) {
  return { output: [{ type: "message", content: [{ type: "output_text", text }] }], usage: { input_tokens: 10, output_tokens: 10 }, model: "uat-mock-model" };
}
function toolCallResponse(name, args, callId) {
  return { output: [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 10 }, model: "uat-mock-model" };
}

function narrateToolResult(name, outputJson) {
  let parsed;
  try { parsed = JSON.parse(outputJson); } catch { parsed = null; }
  if (!parsed) return "Não consegui interpretar o resultado da consulta.";
  if (parsed.error) return `Não consegui concluir: ${parsed.error}`;
  if (name === "iniciar_novo_cliente") return "Prontinho, começamos do zero — pode me contar sobre o novo cliente.";
  // Generic, literal readback of the real tool_result fields -- the
  // mock model narrates, it never computes.
  return `[UAT mock narration for ${name}] ${JSON.stringify(parsed)}`;
}

async function handleOpenAI(req, res, url) {
  if (url.pathname === "/openai/v1/responses" && req.method === "POST") {
    const bodyRaw = await readBody(req);
    const body = JSON.parse(bodyRaw.toString("utf8"));
    const input = body.input || [];
    record("openai.responses", { lastUser: lastUserMessage(input).slice(0, 120), inputLen: input.length });

    const pendingOutput = lastFunctionCallOutput(input);
    if (pendingOutput) {
      const toolName = pendingOutput.call_id.startsWith("mock-") ? pendingOutput.call_id.slice("mock-".length) : "tool";
      const text = narrateToolResult(toolName, pendingOutput.output);
      return json(res, 200, textResponse(text));
    }

    const userMsg = lastUserMessage(input);
    // IA-UAT-02 Gate 22 -- deliberate, safely-scoped upstream-failure
    // trigger for the error-handling scenario. Never fires on a real
    // user message; only on this exact scripted marker.
    if (userMsg === "__UAT_TRIGGER_UPSTREAM_ERROR__") {
      record("openai.responses.simulated_failure", {});
      return json(res, 500, { error: { message: "simulated upstream failure (IA-UAT-02 test harness)" } });
    }
    const scripted = MODEL_SCRIPT.find((s) => s.match.test(userMsg));
    if (scripted) {
      return json(res, 200, toolCallResponse(scripted.call.name, scripted.call.arguments, `mock-${scripted.call.name}`));
    }
    record("openai.responses.unscripted", { userMsg: userMsg.slice(0, 200) });
    return json(res, 200, textResponse("Não tenho um cenário de teste roteirizado para essa pergunta neste mock local — isso não indica uma falha do candidato, apenas que o script de UAT não cobriu esta frase."));
  }

  if (url.pathname === "/openai/v1/audio/transcriptions" && req.method === "POST") {
    await readBody(req); // drain, content not inspected (synthetic fixture audio)
    record("openai.stt", {});
    return json(res, 200, { text: "Qual foi o resultado do mês passado?" });
  }

  if (url.pathname === "/openai/v1/audio/speech" && req.method === "POST") {
    await readBody(req);
    record("openai.tts", {});
    // Minimal valid MP3-ish byte stream stand-in (not a real decodable
    // file -- the contract under test is "an audio Response comes
    // back", not audio fidelity, which is HUMAN_LISTENING_PENDING).
    return binary(res, 200, Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]), "audio/mpeg");
  }

  if (url.pathname === "/openai/v1/realtime/client_secrets" && req.method === "POST") {
    const bodyRaw = await readBody(req);
    let session = {};
    try { session = JSON.parse(bodyRaw.toString("utf8"))?.session || {}; } catch { /* ignore */ }
    record("openai.realtime.mint", { model: session.model });
    return json(res, 200, { value: "uat-mock-ephemeral-secret", expires_at: Math.floor(Date.now() / 1000) + 600 });
  }

  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, accept-profile, prefer",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }
  if (url.pathname === "/__uat/log") return json(res, 200, log);
  if (url.pathname === "/__uat/ping") return json(res, 200, { ok: true });
  if (url.pathname === "/__uat/set-portal-config" && req.method === "POST") {
    const bodyRaw = await readBody(req);
    let next = {};
    try { next = JSON.parse(bodyRaw.toString("utf8")); } catch { /* ignore, no-op */ }
    setPortalConfigState(next);
    record("uat.set_portal_config", next);
    return json(res, 200, { ok: true, state: PORTAL_CONFIG_STATE });
  }

  const fnMatch = url.pathname.match(/^\/functions\/v1\/([a-z-]+)(.*)$/);
  if (fnMatch && FUNCTION_PORTS[fnMatch[1]]) {
    record("proxy", { fn: fnMatch[1], method: req.method });
    const forwardPath = (fnMatch[2] || "/") + url.search;
    return proxyToFunction(req, res, fnMatch[1], FUNCTION_PORTS[fnMatch[1]], forwardPath || "/");
  }

  try {
    if (url.pathname.startsWith("/auth/v1/")) {
      const handled = handleAuth(req, res, url);
      if (handled !== null) return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      const handled = await handleRest(req, res, url);
      if (handled !== null) return;
    }
    if (url.pathname.startsWith("/openai/")) {
      const handled = await handleOpenAI(req, res, url);
      if (handled !== null) return;
    }
  } catch (e) {
    record("error", { message: String(e) });
    return json(res, 500, { error: "mock_backend_error", detail: String(e) });
  }

  if (req.method === "GET" && !url.pathname.startsWith("/auth/") && !url.pathname.startsWith("/rest/") && !url.pathname.startsWith("/openai/") && !url.pathname.startsWith("/functions/")) {
    return serveStatic(req, res, url.pathname);
  }

  record("unhandled", { method: req.method, path: url.pathname });
  json(res, 404, { error: "not_found_in_mock", path: url.pathname });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-backend] listening on http://127.0.0.1:${PORT}`);
});

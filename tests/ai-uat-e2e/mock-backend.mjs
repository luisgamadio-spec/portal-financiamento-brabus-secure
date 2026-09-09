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

const MASTER_ACCESS_TOKEN = "uat-mock-access-token";
const NON_MASTER_ACCESS_TOKEN = "uat-mock-non-master-access-token";

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
      { prazo: 60, entrada_pct: 0.2, taxa: 0.025 }
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
  }
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
    const wantsNonMaster = url.search.includes(NON_MASTER_USER.auth_user_id);
    const row = wantsNonMaster ? NON_MASTER_USER : FIXED_USER;
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

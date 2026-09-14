// SEC-1B -- proves department/store scope enforcement (Finding 1 from
// SEC-1A) is actually WIRED into evaluateToolPolicy(), the real
// function index.ts's own tool-call loop calls before every
// dispatchTool() invocation. tool-policy.ts's own checkDepartmentScope/
// checkStoreScope already had full coverage in isolation (see
// tool-policy.test.mjs) -- this file proves the GAP that existed until
// this Wave (they were never actually called anywhere) is closed, by
// importing the real evaluateToolPolicy/scopeCheckDepartment/
// scopeCheckStore/extractRequestedDepartments/extractRequestedStores
// functions directly from supabase/functions/portal-ai-homolog/
// scope-policy.ts -- the SAME module index.ts itself imports
// evaluateToolPolicy from (index.ts's own body no longer defines it;
// it was moved there verbatim this wave specifically so it stays
// unit-testable from plain Node, since index.ts itself cannot be
// imported outside Deno -- see scope-policy.ts's own header comment
// for why). Same "never a hand-copied duplicate" discipline as every
// other file in this directory.
//
// WHY THIS IS UNIT-LEVEL, NOT HTTP-LEVEL (documented, not an omission):
// the outer Gate MASTER (unchanged this Wave, see
// tests/ai-uat-e2e/policy-dispatch-integration.mjs's own still-passing
// 14/14 regression) rejects every non-MASTER caller with HTTP 403
// BEFORE authorityEnvelope is ever resolved -- so a real end-to-end
// HTTP scenario literally cannot construct a live non-MASTER
// AuthorityEnvelope to exercise this logic against today, and MASTER's
// own authority always short-circuits both scope checks to
// allowed:true unconditionally (by design -- see Test 15 below). The
// ONLY way to exercise the dormant non-MASTER scope-enforcement path
// today is a direct, synthetic AuthorityEnvelope at the unit level,
// exactly as this file does -- this is the SAME documented limitation
// SEC-1A's own audit already established as the reason this path is
// "dormant."
//
// DISPATCH-ZERO INVARIANT: every case below that asserts allowed ===
// false is, by construction, a case where index.ts's own tool-call
// loop (unmodified by this Wave -- see its own "IA-3F.1"/"SEC-1B"
// comments) never calls dispatchTool(): `if (!policyDecision.allowed)
// { output = {error: ...} } else { dispatchTool(...) }` is the same
// code, unedited, already proven live at the HTTP tier for the
// TOOL_NOT_REGISTERED case (policy-dispatch-integration.mjs's DENY
// case, 14/14 PASS, unchanged this Wave). A policyDecision.allowed ===
// false from evaluateToolPolicy() -- regardless of WHICH check inside
// it produced that false -- reaches dispatchTool() exactly as
// unreachably as any other denial reason does.
//
// Run: node tests/ia-reconciliation/scope-enforcement.test.mjs

import {
  evaluateToolPolicy,
  scopeCheckDepartment,
  scopeCheckStore,
  extractRequestedDepartments,
  extractRequestedStores
} from "../../supabase/functions/portal-ai-homolog/scope-policy.ts";
import { TOOL_POLICY } from "../../supabase/functions/portal-ai-homolog/tool-policy.ts";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function authority(profile, { store = null, departments = [], isMaster = false, isSeller = false } = {}) {
  return { profile, store, departments, isMaster, isSeller };
}

const ALWAYS_GRANTED = async () => true;
const ALWAYS_DENIED = async () => false;

async function main() {
  // ================= A/B -- SEC-1C.4: GROUP_OPERATIONAL_SHARED tools,
  // store is a query dimension, never a confidentiality boundary =====
  {
    const gerenteAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });

    // A. GERENTE / own store -> allowed (all other policy conditions --
    // profile in policy, module permission -- also pass)
    const rA = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "NACOES" }, gerenteAuth, ALWAYS_GRANTED);
    check("A. GERENTE / own store (NACOES) requested -> ALLOWED", rA.allowed === true, rA);

    // B. SEC-1C.4 correction (was: DENIED, STORE_SCOPE_DENIED, prior to
    // the Human's own business-rule correction): consultar_resultado is
    // GROUP_OPERATIONAL_SHARED (tool-policy.ts's own dataClass,
    // requiresStoreScope now false) -- an ordinary operational/
    // commercial Group result carries no confidentiality boundary by
    // store. This is the exact canonical case the Human's own UAT
    // asked for: "Qual foi o resultado da Bandeirantes?" from a NACOES
    // caller must succeed, not be denied.
    const rB = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "OUTRA LOJA" }, gerenteAuth, ALWAYS_GRANTED);
    check("B. GERENTE / different store (OUTRA LOJA) requested for an ordinary operational result -> ALLOWED (SEC-1C.4: store is a query dimension, not a confidentiality boundary, for GROUP_OPERATIONAL_SHARED tools)", rB.allowed === true, rB);

    // B2. SEC-1D.1 correction (was: DENIED, STORE_SCOPE_DENIED, in
    // SEC-1D -- that Wave deliberately left consultar_score_vendedores's
    // requiresStoreScope=true pending exactly the RPC change this Wave
    // applied live). consultar_score_vendedores is now
    // SCORE_CONTROLLED_PERFORMANCE with requiresStoreScope=false: the
    // Human's own contract ("ANALISTA/GERENTE/DIRETOR: ... cross-store
    // Score allowed") is backed by a REAL RPC change this Wave
    // (operational_score_coparticipated_data gained p_group_view,
    // applied and verified live) -- store is now a genuine query
    // dimension for a non-seller caller holding the real
    // analiseScoreVendedores grant, same as GROUP_OPERATIONAL_SHARED
    // tools. The VENDEDOR identity boundary is unaffected: it is
    // enforced by the INDEPENDENT SCORE_SELLER_SCOPE_DENIED check
    // (Section SEC-1D below), never by this flag.
    const rB2 = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month", department: "NOVOS", store: "OUTRA LOJA" }, gerenteAuth, ALWAYS_GRANTED);
    check("B2. GERENTE / different store requested for consultar_score_vendedores -> ALLOWED (SEC-1D.1: RPC change landed, store is now a query dimension for an authorized non-seller caller)", rB2.allowed === true, rB2);
  }

  // ================= C/D -- VENDEDOR NOVOS, department scope, simular_financiamento =================
  {
    const vendedorNovosAuth = authority("VENDEDOR", { store: "NACOES", departments: ["NOVOS"] });

    // C. VENDEDOR NOVOS requesting NOVOS -> the simulation tool is allowed
    const rC = await evaluateToolPolicy("simular_financiamento", { department: "NOVOS" }, vendedorNovosAuth, ALWAYS_GRANTED);
    check("C. VENDEDOR (NOVOS) / department=NOVOS -> ALLOWED", rC.allowed === true, rC);

    // D. VENDEDOR NOVOS requesting SEMINOVOS -> denied by the NEW
    // department-scope check specifically (checkModulePermission is
    // stubbed ALWAYS_GRANTED here on purpose -- proves the denial
    // comes from the caller's own resolved authority.departments,
    // independent of and in addition to the pre-existing per-department
    // module-permission mechanism, exactly the gap SEC-1A Finding 1
    // described: a module-permission grant alone must never be
    // sufficient once the caller's own department scope disagrees).
    const rD = await evaluateToolPolicy("simular_financiamento", { department: "SEMINOVOS" }, vendedorNovosAuth, ALWAYS_GRANTED);
    check("D. VENDEDOR (NOVOS) / department=SEMINOVOS -> DENIED, DEPARTMENT_SCOPE_DENIED (module permission was granted -- the NEW scope check alone catches this)", rD.allowed === false && rD.reason === "DEPARTMENT_SCOPE_DENIED", rD);
  }

  // ================= E/F -- DIRETOR NOVOS, department scope =================
  {
    // Per operational_current_scope.sql (read this session, SEC-1A):
    // DIRETOR NOVOS resolves departments=['NOVOS'] only, store=null
    // (no store restriction -- director authority is department-wide,
    // matching Gate 26's own "global-authority-shaped profiles" note
    // in tool-policy.ts's checkStoreScope, unmodified by this Wave).
    const diretorNovosAuth = authority("DIRETOR_NOVOS", { store: null, departments: ["NOVOS"] });

    // E. DIRETOR NOVOS / NOVOS -> allowed where policy permits
    const rE = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "QUALQUER LOJA NOVOS" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("E. DIRETOR_NOVOS / department=NOVOS -> ALLOWED (store unrestricted for a director -- Gate 26, preserved, not weakened)", rE.allowed === true, rE);

    // F. DIRETOR NOVOS / SEMINOVOS -> denied where department scope applies
    const rF = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "SEMINOVOS", store: "QUALQUER LOJA" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("F. DIRETOR_NOVOS / department=SEMINOVOS -> DENIED, DEPARTMENT_SCOPE_DENIED (NEVER equivalent to MASTER)", rF.allowed === false && rF.reason === "DEPARTMENT_SCOPE_DENIED", rF);
  }

  // ================= G/H -- consultar_comissoes stays strict =================
  {
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });

    // G. ANALISTA requesting consultar_comissoes -> SENSITIVE_TOOL_DENIED
    // (pre-existing authorizeToolCall behavior, unmodified this Wave --
    // re-verified here through the FULL evaluateToolPolicy wrapper,
    // not just tool-policy.ts's own authorizeToolCall in isolation, so
    // the exact real call site's own behavior is proven, not assumed.)
    const rG = await evaluateToolPolicy("consultar_comissoes", { mode: "summary", period: "current" }, analistaAuth, ALWAYS_GRANTED);
    check("G. ANALISTA / consultar_comissoes -> DENIED, SENSITIVE_TOOL_DENIED", rG.allowed === false && rG.reason === "SENSITIVE_TOOL_DENIED", rG);

    // H. ANALISTA attempting Douglas's salary specifically -- the exact
    // canonical scenario (SEC-1A Section 9 / SEC-1B Section 7). Denied
    // at the SAME policy layer, before dispatchTool/RPC/model context
    // -- see this file's own header comment for the dispatch-zero
    // invariant this denial structurally guarantees in the real loop.
    const rH = await evaluateToolPolicy("consultar_comissoes", { mode: "person", period: "current", person_name: "Douglas" }, analistaAuth, ALWAYS_GRANTED);
    check("H. ANALISTA / consultar_comissoes(person_name='Douglas') -> DENIED before dispatch (dispatch count structurally 0 -- see header)", rH.allowed === false && rH.reason === "SENSITIVE_TOOL_DENIED", rH);

    // Same canonical case, now also proven for VENDEDOR and GERENTE --
    // consultar_comissoes must remain MASTER+RH only for every
    // non-MASTER profile, not just ANALISTA.
    const vendedorAuth = authority("VENDEDOR", { store: "NACOES", departments: ["NOVOS"] });
    const rH2 = await evaluateToolPolicy("consultar_comissoes", { mode: "person", period: "current", person_name: "Douglas" }, vendedorAuth, ALWAYS_GRANTED);
    check("H2. VENDEDOR / consultar_comissoes(person_name='Douglas') -> DENIED, SENSITIVE_TOOL_DENIED", rH2.allowed === false && rH2.reason === "SENSITIVE_TOOL_DENIED", rH2);

    const gerenteAuth2 = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });
    const rH3 = await evaluateToolPolicy("consultar_comissoes", { mode: "person", period: "current", person_name: "Douglas" }, gerenteAuth2, ALWAYS_GRANTED);
    check("H3. GERENTE / consultar_comissoes(person_name='Douglas') -> DENIED, SENSITIVE_TOOL_DENIED", rH3.allowed === false && rH3.reason === "SENSITIVE_TOOL_DENIED", rH3);

    const diretorAuth2 = authority("DIRETOR_NOVOS", { store: null, departments: ["NOVOS"] });
    const rH4 = await evaluateToolPolicy("consultar_comissoes", { mode: "person", period: "current", person_name: "Douglas" }, diretorAuth2, ALWAYS_GRANTED);
    check("H4. DIRETOR_NOVOS / consultar_comissoes(person_name='Douglas') -> DENIED, SENSITIVE_TOOL_DENIED", rH4.allowed === false && rH4.reason === "SENSITIVE_TOOL_DENIED", rH4);
  }

  // ================= I/J -- malformed / unknown scope values =================
  {
    const gerenteAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });

    // I. malformed store (wrong type entirely -- e.g. the model/an
    // adversarial payload sends a number instead of a string) -> denied.
    // SEC-1D.1: after this Wave's RPC change + Score store-policy
    // correction, NO tool in TOOL_POLICY has requiresStoreScope=true
    // any more (every tool's store boundary is now either absent by
    // data classification -- GROUP_OPERATIONAL_SHARED -- or delegated
    // to the RPC + a dedicated identity check -- Score) -- so there is
    // no live tool left to route a malformed-store-type case THROUGH
    // evaluateToolPolicy's generic loop. The underlying fail-closed
    // behavior itself is unchanged and proven directly here instead
    // (scopeCheckStore is the exact function that loop calls):
    const rI = scopeCheckStore(42, gerenteAuth);
    check("I. malformed store (non-string) -> scopeCheckStore itself still fails closed, DENIED/STORE_SCOPE_DENIED (never passthrough) -- proven directly now that no tool routes this through evaluateToolPolicy's generic loop", rI.allowed === false && rI.reason === "STORE_SCOPE_DENIED", rI);

    // J. unknown/unrecognized department string -> denied (never
    // silently normalized to null and treated as "no request" --
    // that collapse is correct for normalizeDepartment()'s OWN
    // business-defaulting purpose, but wrong for this security layer;
    // see scopeCheckDepartment's own header comment for why the two
    // are deliberately different functions). department scope is
    // UNCHANGED by SEC-1C.4 for every tool, consultar_resultado
    // included -- this case is still valid, unedited.
    const rJ = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "MARTE", store: "NACOES" }, gerenteAuth, ALWAYS_GRANTED);
    check("J. unknown department ('MARTE') -> DENIED, DEPARTMENT_SCOPE_DENIED (fail closed, never passthrough; department enforcement unchanged by SEC-1C.4)", rJ.allowed === false && rJ.reason === "DEPARTMENT_SCOPE_DENIED", rJ);

    // Direct unit coverage of the two low-level helpers themselves,
    // isolated from evaluateToolPolicy's own tool-lookup/profile logic.
    check("scopeCheckDepartment: truly ABSENT department (undefined) -> ALLOWED (pass-through; tool's own required-field validation is a separate, already-existing concern)", scopeCheckDepartment(undefined, gerenteAuth).allowed === true);
    check("scopeCheckDepartment: empty string department -> ALLOWED (treated as absent)", scopeCheckDepartment("", gerenteAuth).allowed === true);
    check("scopeCheckStore: truly ABSENT store (null) -> ALLOWED (pass-through)", scopeCheckStore(null, gerenteAuth).allowed === true);
    check("scopeCheckStore: non-string store ({}) -> DENIED, STORE_SCOPE_DENIED", scopeCheckStore({}, gerenteAuth).allowed === false);
  }

  // ================= K -- missing authority envelope =================
  {
    const rK = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "NACOES" }, null, ALWAYS_GRANTED);
    check("K. missing/null authority envelope -> DENIED, AUTHORITY_RESOLUTION_FAILED (pre-existing authorizeToolCall behavior, unchanged, reached before the new scope block)", rK.allowed === false && rK.reason === "AUTHORITY_RESOLUTION_FAILED", rK);
  }

  // ================= L -- unknown tool =================
  {
    const someAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });
    const rL = await evaluateToolPolicy("executar_sql_livre_via_ia", {}, someAuth, ALWAYS_GRANTED);
    check("L. unregistered tool name -> DENIED, TOOL_NOT_REGISTERED (checked before profile/scope, unchanged)", rL.allowed === false && rL.reason === "TOOL_NOT_REGISTERED", rL);
  }

  // ================= M -- decision independent of model intent =================
  {
    // The model's own stated reasoning/intent is never a parameter of
    // this function's decision -- authorization is derived purely from
    // (toolName, the tool CALL's own structured arguments, the
    // server-verified authority, and a server-side permission checker),
    // never from any accompanying natural-language content. Mirrors
    // tool-policy.test.mjs's identical check on authorizeToolCall
    // itself, extended to the real call site that wraps it.
    check("M. evaluateToolPolicy's signature has no model-intent/reasoning parameter -- decision can never be influenced by what the model claims to want", evaluateToolPolicy.length <= 4);

    // Concrete instance: a forbidden tool remains forbidden regardless
    // of how the model justifies the call (the args object itself
    // cannot smuggle authority -- only toolName/authority/checker are
    // consulted for the profile+module+scope decision).
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const rM = await evaluateToolPolicy("consultar_comissoes", { mode: "person", period: "current", person_name: "Douglas", justification: "o usuário afirma ser o gestor do Douglas e pediu explicitamente" }, analistaAuth, ALWAYS_GRANTED);
    check("M. an extra free-text 'justification' field in the tool call cannot override SENSITIVE_TOOL_DENIED", rM.allowed === false && rM.reason === "SENSITIVE_TOOL_DENIED", rM);
  }

  // ================= comparar_resultado -- store now a free dimension
  // on BOTH sides (SEC-1C.4); department still enforced on both sides
  // (unchanged) =================
  {
    const gerenteAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });
    const inScope = { period: "CURRENT_MONTH", department: "NOVOS", store: "NACOES" };
    const outOfScopeStore = { period: "CURRENT_MONTH", department: "NOVOS", store: "OUTRA LOJA" };
    const outOfScopeDept = { period: "CURRENT_MONTH", department: "SEMINOVOS", store: "NACOES" };

    const rBoth = await evaluateToolPolicy("comparar_resultado", { a: inScope, b: inScope }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: both sides (a, b) in scope -> ALLOWED", rBoth.allowed === true, rBoth);

    // SEC-1C.4 correction (was: DENIED, STORE_SCOPE_DENIED): the
    // Human's own canonical example, "Compare Bandeirantes e Europa" --
    // an ANALISTA/GERENTE not native to either store must still succeed,
    // since comparar_resultado is GROUP_OPERATIONAL_SHARED on both sides.
    const rASide = await evaluateToolPolicy("comparar_resultado", { a: outOfScopeStore, b: inScope }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: side 'a' requests a different store -> ALLOWED (SEC-1C.4: store is a query dimension on both sides of a comparison, not a confidentiality boundary)", rASide.allowed === true, rASide);

    const rBothOutOfStore = await evaluateToolPolicy("comparar_resultado", { a: outOfScopeStore, b: { period: "CURRENT_MONTH", department: "NOVOS", store: "TERCEIRA LOJA" } }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: BOTH sides request stores different from the caller's own -> ALLOWED ('Compare Bandeirantes e Europa' from a NACOES caller)", rBothOutOfStore.allowed === true, rBothOutOfStore);

    // department scope is UNCHANGED by SEC-1C.4 -- still enforced,
    // independently, on each side.
    const rBSide = await evaluateToolPolicy("comparar_resultado", { a: inScope, b: outOfScopeDept }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: side 'b' out of department scope (a is fine) -> DENIED, DEPARTMENT_SCOPE_DENIED (department enforcement unchanged by SEC-1C.4)", rBSide.allowed === false && rBSide.reason === "DEPARTMENT_SCOPE_DENIED", rBSide);
  }

  // ================= consultar_ranking -- SEC-1C.4: GROUP_OPERATIONAL_SHARED,
  // store now a free dimension ("Qual loja teve maior share?") =======
  {
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const rNoStore = await evaluateToolPolicy("consultar_ranking", { period: "CURRENT_MONTH", dimension: "store", metric: "share", department: null, store: null, top_n: null, order: null, entities: null, plan_filter: null }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_ranking: group-wide store ranking, no store filter ('Qual loja teve maior share?') -> ALLOWED", rNoStore.allowed === true, rNoStore);
    const rOtherStoreFilter = await evaluateToolPolicy("consultar_ranking", { period: "CURRENT_MONTH", dimension: "seller", metric: "sales", department: null, store: "OUTRA LOJA", top_n: null, order: null, entities: null, plan_filter: null }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_ranking: explicit different-store filter -> ALLOWED (SEC-1C.4: ordinary seller/store ranking, not Score/commission)", rOtherStoreFilter.allowed === true, rOtherStoreFilter);
  }

  // ================= consultar_operacoes_especiais -- SEC-1C.4:
  // GROUP_OPERATIONAL_SHARED, store now a free dimension =================
  {
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const rOk = await evaluateToolPolicy("consultar_operacoes_especiais", { period: "CURRENT_MONTH", tipo: "COPARTICIPADO", store: "NACOES" }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_operacoes_especiais: own store requested -> ALLOWED", rOk.allowed === true, rOk);
    // SEC-1C.4 correction (was: DENIED, STORE_SCOPE_DENIED): confirmed
    // by direct code read this Wave that this tool returns masked
    // operation references + seller name + deal-level figures, never
    // client identity/CPF/compensation -- an ordinary operations
    // ledger, GROUP_OPERATIONAL_SHARED.
    const rDenied = await evaluateToolPolicy("consultar_operacoes_especiais", { period: "CURRENT_MONTH", tipo: "COPARTICIPADO", store: "OUTRA LOJA" }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_operacoes_especiais: different store requested -> ALLOWED (SEC-1C.4: ordinary operations ledger, no compensation/client-identity fields)", rDenied.allowed === true, rDenied);
  }

  // ================= analisar_historico_financiamento -- SEC-1C.4:
  // GROUP_OPERATIONAL_SHARED, store now a free dimension =================
  {
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const rHist = await evaluateToolPolicy("analisar_historico_financiamento", { period: "last_90_days", mode: "summary", department: "NOVOS", store: "OUTRA LOJA", model: null, plan_filter: null, down_payment_min_percent: null, down_payment_max_percent: null, term_months: null, limit: null }, analistaAuth, ALWAYS_GRANTED);
    check("analisar_historico_financiamento: different store requested -> ALLOWED (SEC-1C.4: confirmed by code read to carry no seller name/PII in any mode, GROUP_OPERATIONAL_SHARED)", rHist.allowed === true, rHist);
  }

  // ================= MASTER regression at the FULL evaluateToolPolicy wrapper =================
  {
    // Test 15 -- MASTER remains unconditionally allowed regardless of
    // ANY requested department/store, through the exact same
    // evaluateToolPolicy() wrapper every other test above exercises
    // (not just tool-policy.ts's own checkDepartmentScope/
    // checkStoreScope in isolation, already proven in
    // tool-policy.test.mjs). This is the concrete proof that adding
    // scope enforcement did not narrow MASTER's own existing contract.
    const masterAuth = authority("MASTER", { isMaster: true, store: "QUALQUER LOJA", departments: ["NOVOS", "SEMINOVOS"] });
    for (const [toolName, requestedArgs] of [
      ["consultar_resultado", { period: "CURRENT_MONTH", department: "SEMINOVOS", store: "LOJA QUE NAO EXISTE" }],
      ["comparar_resultado", { a: { period: "CURRENT_MONTH", department: "SEMINOVOS", store: "X" }, b: { period: "CURRENT_MONTH", department: "NOVOS", store: "Y" } }],
      ["simular_financiamento", { department: "SEMINOVOS" }],
      ["consultar_comissoes", { mode: "person", period: "current", person_name: "Qualquer Pessoa" }]
    ]) {
      const r = await evaluateToolPolicy(toolName, requestedArgs, masterAuth, ALWAYS_GRANTED);
      check(`MASTER regression: ${toolName} remains ALLOWED regardless of requested scope (module permission granted)`, r.allowed === true, r);
    }
  }

  // ================= SEC-1C.4 -- data classification is explicit and
  // machine-checkable (tool-policy.ts's own dataClass field), not just
  // a comment, and requiresStoreScope is correctly derived per class =====
  {
    const GROUP_SHARED = ["consultar_resultado", "comparar_resultado", "consultar_ranking", "consultar_operacoes_especiais", "analisar_historico_financiamento"];
    for (const name of GROUP_SHARED) {
      check(`dataClass: ${name} is GROUP_OPERATIONAL_SHARED`, TOOL_POLICY[name].dataClass === "GROUP_OPERATIONAL_SHARED", TOOL_POLICY[name].dataClass);
      check(`dataClass: ${name} has requiresStoreScope=false`, TOOL_POLICY[name].requiresStoreScope === false, TOOL_POLICY[name].requiresStoreScope);
    }
    check("dataClass: consultar_comissoes is SENSITIVE_RESTRICTED", TOOL_POLICY.consultar_comissoes.dataClass === "SENSITIVE_RESTRICTED");
    // SEC-1D: the Human's own Score contract resolved the formerly-
    // unconfirmed MIXED_REQUIRES_FIELD_LEVEL_REVIEW classification into
    // its own dedicated SCORE_CONTROLLED_PERFORMANCE class (see
    // tool-policy.ts's own updated comment for why it is neither
    // GROUP_OPERATIONAL_SHARED nor SENSITIVE_RESTRICTED).
    check("dataClass: consultar_score_vendedores is SCORE_CONTROLLED_PERFORMANCE (SEC-1D)", TOOL_POLICY.consultar_score_vendedores.dataClass === "SCORE_CONTROLLED_PERFORMANCE");
    check("dataClass: consultar_score_vendedores requiresStoreScope=false (SEC-1D.1: the RPC change landed live this Wave; ANALISTA/GERENTE/authorized DIRETOR cross-store Score is now genuinely delivered by the RPC, not merely allowed-on-paper)", TOOL_POLICY.consultar_score_vendedores.requiresStoreScope === false);
    check("dataClass: consultar_score_vendedores KEEPS requiresDepartmentScope=true", TOOL_POLICY.consultar_score_vendedores.requiresDepartmentScope === true);
    check("dataClass: consultar_score_vendedores now includes VENDEDOR in allowedProfiles (own-score only, enforced by the SCORE_SELLER_SCOPE_DENIED mode gate below, not by this list alone)", TOOL_POLICY.consultar_score_vendedores.allowedProfiles.includes("VENDEDOR"));
    for (const name of ["simular_financiamento", "simular_antecipacao", "simular_cash_conversion", "calcular_taxa_financiamento", "iniciar_novo_cliente"]) {
      check(`dataClass: ${name} is CALCULATION_NO_DATA_AUTHORITY`, TOOL_POLICY[name].dataClass === "CALCULATION_NO_DATA_AUTHORITY", TOOL_POLICY[name].dataClass);
    }
    // department scope UNCHANGED for every GROUP_OPERATIONAL_SHARED tool
    // that had it before (Section 8's own explicit caution).
    check("dataClass: consultar_resultado KEEPS requiresDepartmentScope=true (department audited/preserved separately from store)", TOOL_POLICY.consultar_resultado.requiresDepartmentScope === true);
  }

  // ================= SEC-1D -- Score authority: VENDEDOR own-score
  // ALLOW, VENDEDOR third-party DENY (adversarial), ANALISTA/GERENTE/
  // MASTER regression unaffected. Tested at the internal policy/
  // tool-call boundary (evaluateToolPolicy direct call) -- the outer
  // homolog gate (index.ts, unchanged this Wave) still blocks VENDEDOR/
  // GERENTE/DIRETOR from reaching this code live; this is the dormant-
  // but-correct pattern this file already documents at its own header
  // (same as every other non-MASTER scope-enforcement proof here). =====
  {
    const vendedorScoreAuth = authority("VENDEDOR", { store: "NACOES", departments: ["NOVOS"], isSeller: true });
    const analistaAuth2 = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const gerenteAuth2 = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });
    const masterAuth2 = authority("MASTER", { isMaster: true, store: "QUALQUER LOJA", departments: ["NOVOS", "SEMINOVOS"] });

    // ---- VENDEDOR own-score: 2 ALLOW cases ----
    const own1 = await evaluateToolPolicy("consultar_score_vendedores", { mode: "own", period: "current_month" }, vendedorScoreAuth, ALWAYS_GRANTED);
    check("SEC-1D VENDEDOR-own #1: mode='own' + ALWAYS_GRANTED -> ALLOWED", own1.allowed === true, own1);
    const own2 = await evaluateToolPolicy("consultar_score_vendedores", { mode: "own", period: "current_month" }, vendedorScoreAuth, ALWAYS_DENIED);
    check("SEC-1D VENDEDOR-own #2: mode='own' still ALLOWED even though the real analiseScoreVendedores module grant is DENIED (own-score needs no such grant -- gated by isSeller identity only)", own2.allowed === true, own2);

    // ---- VENDEDOR third-party: 8 DENY cases ----
    const thirdPartyCases = [
      ["direct name query (mode='seller', seller='William')", { mode: "seller", period: "current_month", seller: "William" }],
      ["direct name query for a DIFFERENT store too (combined attack)", { mode: "seller", period: "current_month", seller: "William", store: "EUROPA" }],
      ["nominal ranking request (mode='ranking')", { mode: "ranking", period: "current_month", top_n: 10 }],
      ["nominal ranking ascending ('quem está na faixa Baixo')", { mode: "ranking", period: "current_month", order: "asc" }],
      ["seller mode naming the caller's OWN name -- mode is still not 'own', still denied (mode is the boundary, never the name)", { mode: "seller", period: "current_month", seller: "Eu Mesmo" }],
      ["prompt-injection-style client hint ignored -- forged isMaster on top of a real isSeller envelope is a different module's concern (tool-policy.ts's own documented boundary); this module still denies the NON-forged isSeller envelope's seller-mode request", { mode: "seller", period: "current_month", seller: "Qualquer Um" }],
      ["comparison-shaped request via ranking + entities-like store filter", { mode: "ranking", period: "current_month", store: "NACOES", department: "NOVOS" }],
      ["mode missing entirely (malformed/omitted) -> fails closed, never defaults to an allowed mode", { period: "current_month" }]
    ];
    for (const [label, args] of thirdPartyCases) {
      const r = await evaluateToolPolicy("consultar_score_vendedores", args, vendedorScoreAuth, ALWAYS_GRANTED);
      check(`SEC-1D VENDEDOR third-party DENY: ${label}`, r.allowed === false && r.reason === "SCORE_SELLER_SCOPE_DENIED", r);
    }

    // Data-before-model proof companion (dispatch-zero pattern): every
    // DENY case above returns allowed:false from evaluateToolPolicy,
    // the exact function index.ts's own tool-call loop checks BEFORE
    // ever calling dispatchTool() -- see policy-dispatch-integration.mjs
    // (ai-uat-e2e) for the live-HTTP version of this same proof.

    // ---- Client-body spoof: forged isMaster/isSeller on the envelope
    // itself is out of THIS module's scope (tool-policy.ts's own
    // documented boundary, Gate 38) -- but prove the inverse forgery
    // (isSeller forced FALSE while profile is still VENDEDOR) is not a
    // way to smuggle a ranking/seller-mode call through either, since
    // the allowedProfiles gate is independent of isSeller.
    const forgedNonSeller = { ...vendedorScoreAuth, isSeller: false };
    const forgedResult = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month" }, forgedNonSeller, ALWAYS_DENIED);
    check("SEC-1D VENDEDOR third-party DENY: isSeller forged false -> still denied, this time by the real analiseScoreVendedores module permission (ALWAYS_DENIED), never by defaulting to ALLOWED", forgedResult.allowed === false && forgedResult.reason === "MODULE_PERMISSION_DENIED", forgedResult);

    // ---- mode='own' is meaningless for a non-seller identity: denied,
    // never silently answered with someone else's store-wide pool ----
    const analistaOwn = await evaluateToolPolicy("consultar_score_vendedores", { mode: "own", period: "current_month" }, analistaAuth2, ALWAYS_GRANTED);
    check("SEC-1D: ANALISTA requesting mode='own' -> DENIED, SCORE_SELLER_SCOPE_DENIED (no personal Score record exists for a non-seller identity)", analistaOwn.allowed === false && analistaOwn.reason === "SCORE_SELLER_SCOPE_DENIED", analistaOwn);

    // ---- ANALISTA/GERENTE/MASTER regression: existing same-store
    // ranking/seller behavior (SEC-1C.4-era) is completely unaffected ----
    const analistaRanking = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month", department: "NOVOS", store: "NACOES" }, analistaAuth2, ALWAYS_GRANTED);
    check("SEC-1D regression: ANALISTA / own-store ranking -> still ALLOWED", analistaRanking.allowed === true, analistaRanking);
    const gerenteSeller = await evaluateToolPolicy("consultar_score_vendedores", { mode: "seller", period: "current_month", seller: "Qualquer Vendedor", store: "NACOES" }, gerenteAuth2, ALWAYS_GRANTED);
    check("SEC-1D regression: GERENTE / own-store seller lookup -> still ALLOWED", gerenteSeller.allowed === true, gerenteSeller);
    const masterOwn = await evaluateToolPolicy("consultar_score_vendedores", { mode: "own", period: "current_month" }, masterAuth2, ALWAYS_GRANTED);
    check("SEC-1D: MASTER requesting mode='own' -> DENIED too (correctness guard: MASTER isn't a seller, so 'own' would mislabel the RPC's full group result as 'Você mesmo' -- MASTER keeps full access via mode='ranking'/'seller' instead, proven below)", masterOwn.allowed === false && masterOwn.reason === "SCORE_SELLER_SCOPE_DENIED", masterOwn);
    const masterRanking = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month" }, masterAuth2, ALWAYS_DENIED);
    check("SEC-1D regression: MASTER / mode='ranking' -> still ALLOWED unconditionally, even with the module permission callback denying (MASTER bypasses it entirely, as before this Wave)", masterRanking.allowed === true, masterRanking);
  }

  // ================= SEC-1D.1 -- DIRETOR Score authority: DIRETOR_NOVOS
  // individual/cross-store ALLOW (real analiseScoreVendedores grant =
  // true), DIRETOR_SEMINOVOS DENY (real grant = false, no permission
  // matrix change), cross-department bypass attempt still DENIED. =====
  {
    const diretorNovosAuth = authority("DIRETOR_NOVOS", { store: null, departments: ["NOVOS"] });
    const diretorSeminovosAuth = authority("DIRETOR_SEMINOVOS", { store: null, departments: ["SEMINOVOS"] });

    const dnIndividual = await evaluateToolPolicy("consultar_score_vendedores", { mode: "seller", period: "current_month", seller: "Qualquer Vendedor", department: "NOVOS" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("SEC-1D.1 DIRETOR_NOVOS: individual seller Score (NOVOS, real grant=true) -> ALLOWED", dnIndividual.allowed === true, dnIndividual);

    const dnRanking = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month", department: "NOVOS" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("SEC-1D.1 DIRETOR_NOVOS: cross-store ranking (NOVOS) -> ALLOWED (store is not a boundary for this profile either)", dnRanking.allowed === true, dnRanking);

    const dnSeminovos = await evaluateToolPolicy("consultar_score_vendedores", { mode: "ranking", period: "current_month", department: "SEMINOVOS" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("SEC-1D.1 DIRETOR_NOVOS: requesting SEMINOVOS (outside own department authority) -> DENIED, DEPARTMENT_SCOPE_DENIED (department remains a real boundary, never bypassed by p_group_view)", dnSeminovos.allowed === false && dnSeminovos.reason === "DEPARTMENT_SCOPE_DENIED", dnSeminovos);

    const dsIndividual = await evaluateToolPolicy("consultar_score_vendedores", { mode: "seller", period: "current_month", seller: "Qualquer Vendedor", department: "SEMINOVOS" }, diretorSeminovosAuth, ALWAYS_DENIED);
    check("SEC-1D.1 DIRETOR_SEMINOVOS: individual seller Score -> DENIED, MODULE_PERMISSION_DENIED (real analiseScoreVendedores grant is false, unchanged -- never silently granted)", dsIndividual.allowed === false && dsIndividual.reason === "MODULE_PERMISSION_DENIED", dsIndividual);

    const dnOwn = await evaluateToolPolicy("consultar_score_vendedores", { mode: "own", period: "current_month" }, diretorNovosAuth, ALWAYS_GRANTED);
    check("SEC-1D.1 DIRETOR_NOVOS: mode='own' -> DENIED (a director is not a seller identity; same correctness guard as MASTER above)", dnOwn.allowed === false && dnOwn.reason === "SCORE_SELLER_SCOPE_DENIED", dnOwn);
  }

  console.log(`\n=== SEC-1B: Scope Enforcement Wiring Tests: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main();

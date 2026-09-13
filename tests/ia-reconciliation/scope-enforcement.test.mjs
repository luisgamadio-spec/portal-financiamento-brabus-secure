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

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail !== undefined ? " -- " + JSON.stringify(detail) : ""}`); }
}

function authority(profile, { store = null, departments = [], isMaster = false } = {}) {
  return { profile, store, departments, isMaster };
}

const ALWAYS_GRANTED = async () => true;
const ALWAYS_DENIED = async () => false;

async function main() {
  // ================= A/B -- GERENTE, store scope =================
  {
    const gerenteAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });

    // A. GERENTE / allowed store -> allowed (all other policy
    // conditions -- profile in policy, module permission -- also pass)
    const rA = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "NACOES" }, gerenteAuth, ALWAYS_GRANTED);
    check("A. GERENTE / own store (NACOES) requested -> ALLOWED", rA.allowed === true, rA);

    // B. GERENTE / different store -> denied BEFORE dispatch
    const rB = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: "OUTRA LOJA" }, gerenteAuth, ALWAYS_GRANTED);
    check("B. GERENTE / different store (OUTRA LOJA) requested -> DENIED, STORE_SCOPE_DENIED", rB.allowed === false && rB.reason === "STORE_SCOPE_DENIED", rB);
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
    // adversarial payload sends a number instead of a string) -> denied
    const rI = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "NOVOS", store: 42 }, gerenteAuth, ALWAYS_GRANTED);
    check("I. malformed store (non-string) -> DENIED, STORE_SCOPE_DENIED (fail closed, never passthrough)", rI.allowed === false && rI.reason === "STORE_SCOPE_DENIED", rI);

    // J. unknown/unrecognized department string -> denied (never
    // silently normalized to null and treated as "no request" --
    // that collapse is correct for normalizeDepartment()'s OWN
    // business-defaulting purpose, but wrong for this security layer;
    // see scopeCheckDepartment's own header comment for why the two
    // are deliberately different functions).
    const rJ = await evaluateToolPolicy("consultar_resultado", { period: "CURRENT_MONTH", department: "MARTE", store: "NACOES" }, gerenteAuth, ALWAYS_GRANTED);
    check("J. unknown department ('MARTE') -> DENIED, DEPARTMENT_SCOPE_DENIED (fail closed, never passthrough)", rJ.allowed === false && rJ.reason === "DEPARTMENT_SCOPE_DENIED", rJ);

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

  // ================= comparar_resultado -- BOTH sides checked =================
  {
    const gerenteAuth = authority("GERENTE", { store: "NACOES", departments: ["NOVOS"] });
    const inScope = { period: "CURRENT_MONTH", department: "NOVOS", store: "NACOES" };
    const outOfScopeStore = { period: "CURRENT_MONTH", department: "NOVOS", store: "OUTRA LOJA" };
    const outOfScopeDept = { period: "CURRENT_MONTH", department: "SEMINOVOS", store: "NACOES" };

    const rBoth = await evaluateToolPolicy("comparar_resultado", { a: inScope, b: inScope }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: both sides (a, b) in scope -> ALLOWED", rBoth.allowed === true, rBoth);

    const rASide = await evaluateToolPolicy("comparar_resultado", { a: outOfScopeStore, b: inScope }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: side 'a' out of store scope (b is fine) -> DENIED, STORE_SCOPE_DENIED (both sides independently enforced, not just the first arg read)", rASide.allowed === false && rASide.reason === "STORE_SCOPE_DENIED", rASide);

    const rBSide = await evaluateToolPolicy("comparar_resultado", { a: inScope, b: outOfScopeDept }, gerenteAuth, ALWAYS_GRANTED);
    check("comparar_resultado: side 'b' out of department scope (a is fine) -> DENIED, DEPARTMENT_SCOPE_DENIED", rBSide.allowed === false && rBSide.reason === "DEPARTMENT_SCOPE_DENIED", rBSide);
  }

  // ================= consultar_operacoes_especiais -- store-only scope =================
  {
    // Per TOOL_POLICY: requiresDepartmentScope=false, requiresStoreScope=true.
    const analistaAuth = authority("ANALISTA", { store: "NACOES", departments: ["NOVOS", "SEMINOVOS"] });
    const rOk = await evaluateToolPolicy("consultar_operacoes_especiais", { period: "CURRENT_MONTH", tipo: "COPARTICIPADO", store: "NACOES" }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_operacoes_especiais: own store requested -> ALLOWED", rOk.allowed === true, rOk);
    const rDenied = await evaluateToolPolicy("consultar_operacoes_especiais", { period: "CURRENT_MONTH", tipo: "COPARTICIPADO", store: "OUTRA LOJA" }, analistaAuth, ALWAYS_GRANTED);
    check("consultar_operacoes_especiais: different store requested -> DENIED, STORE_SCOPE_DENIED", rDenied.allowed === false && rDenied.reason === "STORE_SCOPE_DENIED", rDenied);
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

  console.log(`\n=== SEC-1B: Scope Enforcement Wiring Tests: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main();

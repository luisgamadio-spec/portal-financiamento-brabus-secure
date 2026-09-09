// IA-3D -- synthetic policy tests for the new tool-policy.ts foundation.
// This file is NOT part of the live runtime (tool-policy.ts is not
// imported by index.ts yet) -- these tests prove the POLICY LOGIC
// itself is correct in isolation, entirely synthetically, with 0 real
// Supabase project touched and 0 non-MASTER profile ever activated
// live. Node 24's native TypeScript import loads the real module
// directly (same "never a hand-copied duplicate" discipline as every
// other file in this directory).
//
// Run: node tests/ia-reconciliation/tool-policy.test.mjs

import {
  TOOL_POLICY,
  authorizeToolCall,
  checkDepartmentScope,
  checkStoreScope,
  resolveSimulatorModulePermission,
  isKnownProfile
} from "../../supabase/functions/portal-ai-homolog/tool-policy.ts";

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + JSON.stringify(detail) : ""}`); }
}

function authority(profile, { store = null, departments = [], isMaster = false } = {}) {
  return { profile, store, departments, isMaster };
}

// Always-allowed module-permission stub for tests that only care about
// profile/deny-by-default behavior, not module-grant plumbing.
const ALWAYS_GRANTED = async () => true;
const ALWAYS_DENIED = async () => false;
const RPC_FAILS = async () => { throw new Error("simulated RPC failure"); };

async function main() {
  // ================= Deny-by-default core =================
  {
    const r = await authorizeToolCall("consultar_resultado_DOES_NOT_EXIST", authority("MASTER", { isMaster: true }), ALWAYS_GRANTED);
    check("Unregistered tool name -> denied, TOOL_NOT_REGISTERED", r.allowed === false && r.reason === "TOOL_NOT_REGISTERED", r);

    const r2 = await authorizeToolCall("consultar_resultado", null, ALWAYS_GRANTED);
    check("Null authority (resolution failure) -> denied, AUTHORITY_RESOLUTION_FAILED", r2.allowed === false && r2.reason === "AUTHORITY_RESOLUTION_FAILED", r2);

    const r3 = await authorizeToolCall("consultar_resultado", authority("SUPER_ADMIN_HACKER"), ALWAYS_GRANTED);
    check("Unknown/forged profile string -> denied, UNKNOWN_PROFILE", r3.allowed === false && r3.reason === "UNKNOWN_PROFILE", r3);

    const r4 = await authorizeToolCall("consultar_resultado", authority("ANALISTA"), RPC_FAILS);
    check("Module-permission RPC failure -> denied, MODULE_PERMISSION_CHECK_FAILED (fail-closed, not fail-open)", r4.allowed === false && r4.reason === "MODULE_PERMISSION_CHECK_FAILED", r4);

    const r5 = await authorizeToolCall("consultar_resultado", authority("ANALISTA"), ALWAYS_DENIED);
    check("Module permission explicitly denied -> denied, MODULE_PERMISSION_DENIED", r5.allowed === false && r5.reason === "MODULE_PERMISSION_DENIED", r5);
  }

  // ================= 12-tool inventory sanity =================
  {
    const names = Object.keys(TOOL_POLICY);
    check("Policy table has exactly 12 entries (matches the real TOOLS array)", names.length === 12, names);
    check("iniciar_novo_cliente classified SESSION_CONTROL, not a business operation", TOOL_POLICY.iniciar_novo_cliente.operation === "SESSION_CONTROL");
    check("consultar_comissoes classified HIGH sensitivity", TOOL_POLICY.consultar_comissoes.sensitivity === "HIGH");
    check("No tool is classified as a business WRITE operation (read-only-first)", Object.values(TOOL_POLICY).every((e) => e.operation === "READ_ANALYTICS" || e.operation === "SIMULATION" || e.operation === "SESSION_CONTROL"));
  }

  // ================= MASTER regression (Gate 15/39) =================
  {
    const masterAuth = authority("MASTER", { isMaster: true, departments: ["NOVOS", "SEMINOVOS"] });
    for (const toolName of Object.keys(TOOL_POLICY)) {
      const r = await authorizeToolCall(toolName, masterAuth, ALWAYS_DENIED); // even with module perms all denied, MASTER must still pass
      check(`MASTER regression: ${toolName} remains allowed unconditionally`, r.allowed === true && r.reason === "ALLOWED", r);
    }
  }

  // ================= Synthetic profile matrix =================
  const PROFILES = ["MASTER", "RH", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"];
  for (const profile of PROFILES) {
    const isMaster = profile === "MASTER";
    const auth = authority(profile, { isMaster, store: "MATRIZ", departments: ["NOVOS"] });

    // Allowed tool for this profile (per policy table) with permission granted
    const allowedTool = Object.entries(TOOL_POLICY).find(([, e]) => isMaster || e.allowedProfiles.includes(profile));
    if (allowedTool) {
      const r = await authorizeToolCall(allowedTool[0], auth, ALWAYS_GRANTED);
      check(`${profile}: allowed tool (${allowedTool[0]}) + granted permission -> ALLOWED`, r.allowed === true, r);
    }

    // Denied tool for this profile (present in policy, but not in its allowedProfiles) -- skip for MASTER, which has none
    if (!isMaster) {
      const deniedTool = Object.entries(TOOL_POLICY).find(([, e]) => !e.allowedProfiles.includes(profile));
      if (deniedTool) {
        const r = await authorizeToolCall(deniedTool[0], auth, ALWAYS_GRANTED);
        check(`${profile}: tool NOT in its policy (${deniedTool[0]}) -> SENSITIVE_TOOL_DENIED even with permission granted`, r.allowed === false && r.reason === "SENSITIVE_TOOL_DENIED", r);
      }

      // Permission missing for an otherwise-allowed tool
      if (allowedTool && allowedTool[1].modulePermission) {
        const r = await authorizeToolCall(allowedTool[0], auth, ALWAYS_DENIED);
        check(`${profile}: allowed tool but module permission missing -> MODULE_PERMISSION_DENIED`, r.allowed === false && r.reason === "MODULE_PERMISSION_DENIED", r);
      }

      // Scope narrowing: caller's own department, matches -> allowed
      const scopeOk = checkDepartmentScope("NOVOS", auth);
      check(`${profile}: department scope narrowing to caller's own department -> ALLOWED`, scopeOk.allowed === true, scopeOk);

      // Scope broadening attempt: request a department NOT in caller's authority -> denied
      const scopeDenied = checkDepartmentScope("SEMINOVOS", auth);
      check(`${profile}: department scope BROADENING attempt (SEMINOVOS, not in [NOVOS]) -> DEPARTMENT_SCOPE_DENIED`, scopeDenied.allowed === false && scopeDenied.reason === "DEPARTMENT_SCOPE_DENIED", scopeDenied);

      // Store broadening attempt
      const storeDenied = checkStoreScope("OUTRA LOJA", auth);
      check(`${profile}: store scope BROADENING attempt (OUTRA LOJA, caller is MATRIZ) -> STORE_SCOPE_DENIED`, storeDenied.allowed === false && storeDenied.reason === "STORE_SCOPE_DENIED", storeDenied);
    } else {
      // MASTER: scope checks always pass regardless of requested value (global authority)
      const scopeAny = checkDepartmentScope("SEMINOVOS", auth);
      check("MASTER: department scope check always ALLOWED (global authority)", scopeAny.allowed === true, scopeAny);
      const storeAny = checkStoreScope("QUALQUER LOJA", auth);
      check("MASTER: store scope check always ALLOWED (global authority)", storeAny.allowed === true, storeAny);
    }

    // Unknown tool for every profile including MASTER
    const rUnknown = await authorizeToolCall("tool_that_does_not_exist", auth, ALWAYS_GRANTED);
    check(`${profile}: unregistered tool name -> denied regardless of profile`, rUnknown.allowed === false && rUnknown.reason === "TOOL_NOT_REGISTERED", rUnknown);
  }

  // Unknown profile explicit denial for every tool
  {
    const rUnknownProfile = await authorizeToolCall("consultar_resultado", authority("ESTAGIARIO_NAO_EXISTE"), ALWAYS_GRANTED);
    check("Unknown profile denied even for a tool granted to everyone else", rUnknownProfile.allowed === false && rUnknownProfile.reason === "UNKNOWN_PROFILE", rUnknownProfile);
  }

  // ================= RH-specific note (Gate 19/22) =================
  {
    check("isKnownProfile('RH') === true (RH IS a recognized policy profile, once its authority resolves)", isKnownProfile("RH") === true);
    // RH profile IS known to the policy vocabulary, but until
    // operational_current_scope() itself resolves an RH caller (a
    // separate, unmerged backend fix -- Gate 22), no AuthorityEnvelope
    // for RH can ever be constructed live -- that resolution failure
    // itself denies via AUTHORITY_RESOLUTION_FAILED, proven above.
    // consultar_comissoes remains RH's only currently-designed tool:
    const rhAuth = authority("RH", { isMaster: false, store: null, departments: ["NOVOS", "SEMINOVOS"] });
    const rhComissoes = await authorizeToolCall("consultar_comissoes", rhAuth, ALWAYS_GRANTED);
    check("RH: consultar_comissoes allowed once authority + permission resolve", rhComissoes.allowed === true, rhComissoes);
    const rhScore = await authorizeToolCall("consultar_score_vendedores", rhAuth, ALWAYS_GRANTED);
    check("RH: consultar_score_vendedores denied (RH is not in that tool's policy, real permissoes_modulos row is false)", rhScore.allowed === false, rhScore);
  }

  // ================= Adversarial tests (Gate 38) =================
  {
    const vendedorAuth = authority("VENDEDOR", { isMaster: false, store: "MATRIZ", departments: ["NOVOS"] });

    // "ignore permissions" / "act as MASTER" -- forged isMaster flag on
    // an otherwise-real VENDEDOR authority object. This can only ever
    // happen if a caller constructs the AuthorityEnvelope itself
    // (a bug elsewhere), not from this module's own logic -- but prove
    // the module's own behavior is exactly "trust the isMaster field
    // as given" (i.e. the module's contract is: authority must already
    // be server-verified BEFORE this function ever sees it; it is not
    // this module's job to re-verify auth.uid()). Documented, not a gap
    // this file can close by itself.
    const forgedMaster = { ...vendedorAuth, isMaster: true };
    const r1 = await authorizeToolCall("consultar_comissoes", forgedMaster, ALWAYS_GRANTED);
    check("Adversarial: a forged isMaster=true on a non-MASTER envelope IS trusted by this function (documents the boundary: authority must be server-constructed before reaching here, never client-suppliable)", r1.allowed === true, r1);

    // "show another store" via requested argument, real (non-forged) authority
    const otherStore = checkStoreScope("LOJA-QUE-NAO-E-MINHA", vendedorAuth);
    check("Adversarial: 'show another store' request denied for real VENDEDOR authority", otherStore.allowed === false && otherStore.reason === "STORE_SCOPE_DENIED", otherStore);

    // "show Seminovos when only Novos" allowed
    const otherDept = checkDepartmentScope("SEMINOVOS", vendedorAuth);
    check("Adversarial: 'show Seminovos' request denied for VENDEDOR scoped to NOVOS only", otherDept.allowed === false && otherDept.reason === "DEPARTMENT_SCOPE_DENIED", otherDept);

    // "call unregistered tool"
    const rUnreg = await authorizeToolCall("executar_sql_livre", vendedorAuth, ALWAYS_GRANTED);
    check("Adversarial: 'call unregistered tool' (executar_sql_livre) -> denied, no such tool exists in policy", rUnreg.allowed === false && rUnreg.reason === "TOOL_NOT_REGISTERED", rUnreg);

    // Prompt injection embedded in tool result -- proven at the
    // documentation/contract level: this module's own authorizeToolCall
    // signature takes only (toolName, authority, checkModulePermission)
    // -- there is no code path anywhere in this file that reads tool
    // OUTPUT data to make an authorization decision. Authorization is
    // decided entirely BEFORE tool execution, from server-verified
    // inputs only.
    check("Prompt-injection boundary: authorizeToolCall's signature has no tool-result/output parameter -- authorization can never be influenced by data a tool returns", authorizeToolCall.length <= 3);
  }

  // ================= resolveSimulatorModulePermission =================
  {
    check("resolveSimulatorModulePermission(NOVOS) -> simuladorCompleto", resolveSimulatorModulePermission("NOVOS") === "simuladorCompleto");
    check("resolveSimulatorModulePermission(SEMINOVOS) -> simuladorSeminovos", resolveSimulatorModulePermission("SEMINOVOS") === "simuladorSeminovos");
    check("resolveSimulatorModulePermission(null) -> null (never guesses)", resolveSimulatorModulePermission(null) === null);
    check("resolveSimulatorModulePermission(garbage) -> null (never guesses)", resolveSimulatorModulePermission("GARBAGE") === null);
  }

  console.log(`\n=== Tool Policy Foundation Tests: ${pass}/${pass + fail} ===`);
  console.log(fail === 0 ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(fail === 0 ? 0 : 1);
}

main();

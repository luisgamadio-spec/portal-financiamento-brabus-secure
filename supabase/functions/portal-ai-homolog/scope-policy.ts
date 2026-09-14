// SEC-1B — Finding 1: department/store scope enforcement, actually
// applied to tool arguments for the first time. tool-policy.ts's
// checkDepartmentScope()/checkStoreScope() already existed (IA-3D/
// IA-3F.1) and are unmodified by this wave; the gap this file closes
// is purely that nothing in index.ts ever called them (docs/
// IA-3D-TOOL-POLICY.md §11 item 4, "Not done").
//
// This lives in its own file, imported by BOTH index.ts (real, live
// wiring) and tests/ia-reconciliation/scope-enforcement.test.mjs
// (direct, synthetic unit coverage), for the same reason tool-policy.ts
// itself is a separate file: index.ts has remote (https://) imports
// that Node's native TypeScript loader cannot resolve, so nothing that
// needs isolated Node-level unit testing can live inside index.ts
// itself. Has zero Deno-specific or remote-URL dependency, importable
// from plain Node exactly like tool-policy.ts already is.
//
// DEPARTMENT VOCABULARY NOTE: this file defines its own local
// NOVOS/SEMINOVOS normalizer rather than importing index.ts's
// normalizeDepartment() (impossible without pulling in index.ts's own
// remote imports transitively). This mirrors tool-policy.ts's own
// existing, pre-this-wave precedent: its `Department` type is already
// an independent `"NOVOS" | "SEMINOVOS"` declaration, not imported
// from index.ts either — the two-value department vocabulary is
// treated as a fixed, stable domain constant across this whole
// function's files, not something requiring single-sourcing.

import {
  authorizeToolCall,
  checkDepartmentScope,
  checkStoreScope,
  resolveSimulatorModulePermission,
  TOOL_POLICY,
  type AuthorityEnvelope,
  type AuthorizeResult,
  type ModulePermissionChecker,
  type ReasonCode
} from "./tool-policy.ts";

// Collapses "field absent" and "field present but unrecognized" into
// the same null — mirrors index.ts's own normalizeDepartment() (Parte
// 26) exactly, but is NOT what the two functions below call directly:
// see their own comments for why a security fail-closed gate needs a
// DIFFERENT distinction (absent vs. malformed) than this business-
// defaulting normalizer provides.
function normalizeDepartmentValue(input: unknown): "NOVOS" | "SEMINOVOS" | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toUpperCase();
  if (s === "NOVOS") return "NOVOS";
  if (s === "SEMINOVOS") return "SEMINOVOS";
  return null;
}

// These two extract-and-check helpers are DELIBERATELY separate from
// normalizeDepartmentValue() above: that normalizer collapses "field
// absent" and "field present but unrecognized" into the same `null`
// output, which is correct for the tool's OWN business defaulting
// (dispatchTool's per-tool validators, in index.ts, own the "is this
// required" question) but wrong for a security fail-closed gate — a
// caller-supplied garbage department/store value must DENY here,
// never silently pass through as if nothing had been requested.
// "Truly absent" (undefined/null/empty) is the only case treated as
// "no request" (tool-policy.ts's own existing checkDepartmentScope/
// checkStoreScope contract: absent = caller's own default scope
// elsewhere, not this layer's concern).
export function scopeCheckDepartment(raw: unknown, authority: AuthorityEnvelope): { allowed: boolean; reason: ReasonCode } {
  if (raw === null || raw === undefined || raw === "") return { allowed: true, reason: "ALLOWED" };
  if (typeof raw !== "string") return { allowed: false, reason: "DEPARTMENT_SCOPE_DENIED" };
  const normalized = normalizeDepartmentValue(raw);
  if (normalized === null) return { allowed: false, reason: "DEPARTMENT_SCOPE_DENIED" }; // present but not NOVOS/SEMINOVOS -- malformed, fail closed
  const result = checkDepartmentScope(normalized, authority);
  return { allowed: result.allowed, reason: result.reason as ReasonCode };
}

export function scopeCheckStore(raw: unknown, authority: AuthorityEnvelope): { allowed: boolean; reason: ReasonCode } {
  if (raw === null || raw === undefined || raw === "") return { allowed: true, reason: "ALLOWED" };
  if (typeof raw !== "string" || !raw.trim()) return { allowed: false, reason: "STORE_SCOPE_DENIED" }; // present but not a real store name -- malformed, fail closed
  const result = checkStoreScope(raw, authority);
  return { allowed: result.allowed, reason: result.reason as ReasonCode };
}

// Per-tool extraction of the raw department/store request(s) from
// that tool's OWN argument shape, so the generic, args-shape-agnostic
// scope checks above can be applied uniformly without coupling
// tool-policy.ts itself to any tool's argument contract (same
// decoupling principle documented at authorizeToolCall's own
// simular_financiamento module-permission special case, in
// tool-policy.ts). comparar_resultado is the one tool carrying TWO
// independent scopes (a and b) -- both must pass. Every tool listed
// here has requiresDepartmentScope/requiresStoreScope === true in
// TOOL_POLICY for the corresponding list; tools absent from a list
// either don't require that scope, or (comparar_resultado's a/b) are
// handled by their own explicit case.
export function extractRequestedDepartments(toolName: string, args: any): unknown[] {
  switch (toolName) {
    case "comparar_resultado":
      return [args?.a?.department, args?.b?.department];
    case "consultar_resultado":
    case "consultar_ranking":
    case "analisar_historico_financiamento":
    case "simular_financiamento":
      return [args?.department];
    case "consultar_score_vendedores":
      // SEC-1D -- mode="own" has no requested-department DIMENSION at
      // all (it's an identity lookup, not a filtered query); dispatchTool
      // itself forces department to null for this mode regardless, so
      // nothing is actually narrowed by skipping this check here -- it
      // only avoids a spurious DEPARTMENT_SCOPE_DENIED if a model/prompt
      // attaches an unrelated department value alongside mode="own".
      return args?.mode === "own" ? [] : [args?.department];
    default:
      return [];
  }
}

export function extractRequestedStores(toolName: string, args: any): unknown[] {
  switch (toolName) {
    case "comparar_resultado":
      return [args?.a?.store, args?.b?.store];
    case "consultar_resultado":
    case "consultar_ranking":
    case "consultar_operacoes_especiais":
    case "analisar_historico_financiamento":
      return [args?.store];
    case "consultar_score_vendedores":
      // SEC-1D -- same reasoning as extractRequestedDepartments above.
      return args?.mode === "own" ? [] : [args?.store];
    default:
      return [];
  }
}

// =========================================================
// evaluateToolPolicy — moved here verbatim from index.ts this wave
// (SEC-1B). It had zero actual Deno/Supabase dependency to begin with
// (checkModulePermission is an injected callback, never a direct RPC
// call from this function itself) — living here, alongside the scope
// checks it now also calls, means BOTH index.ts's real live dispatch
// path AND this file's own Node-level unit tests
// (tests/ia-reconciliation/scope-enforcement.test.mjs) exercise the
// EXACT SAME function, never a hand-copied duplicate. index.ts imports
// this directly and calls it unchanged at its one real call site
// (the tool-call loop, just before dispatchTool()).
//
// simular_financiamento's module permission is department-dependent
// (resolveSimulatorModulePermission), deliberately kept OUT of
// authorizeToolCall's own signature (tool-policy.ts stays decoupled
// from any single tool's argument shape) -- this is the one narrow,
// per-tool follow-up check IA-3F.1's own activation plan (step 3)
// described, applied only when the primary decision already allowed
// and only for a non-MASTER caller (MASTER already returned
// allowed:true unconditionally inside authorizeToolCall itself).
export async function evaluateToolPolicy(
  toolName: string,
  args: any,
  authority: AuthorityEnvelope | null,
  checkModulePermission: ModulePermissionChecker
): Promise<AuthorizeResult> {
  const decision = await authorizeToolCall(toolName, authority, checkModulePermission);
  if (!decision.allowed) return decision;
  if (toolName === "simular_financiamento" && authority && !authority.isMaster) {
    const moduleId = resolveSimulatorModulePermission(args?.department);
    if (!moduleId) return { allowed: false, reason: "MODULE_PERMISSION_REQUIRED", detail: "department" };
    const granted = await checkModulePermission(moduleId).catch(() => false);
    if (!granted) return { allowed: false, reason: "MODULE_PERMISSION_DENIED", detail: moduleId };
  }

  // SEC-1D -- Score identity/mode boundary. The Human-approved Score
  // contract: a VENDEDOR (isSeller) may see ONLY their own Score
  // (mode="own"), never a named third party or a ranking/comparison
  // that could reveal or let a third-party Score be inferred
  // (mode="seller"/"ranking", whoever the name argument is -- "prompt is
  // not security": the model could be induced to pass the caller's OWN
  // name as a mode="seller" argument, and this check would still apply,
  // since it keys on the MODE, never on whether the requested name
  // happens to match the caller). This runs BEFORE the
  // analiseScoreVendedores module-permission check below (identity is a
  // sharper, more fundamental boundary than capability) and BEFORE
  // dispatchTool (AUTH BEFORE PROTECTED RETRIEVAL -- evaluateToolPolicy
  // always runs before dispatchTool, see index.ts's own tool-call loop).
  // MASTER already returned allowed:true unconditionally inside
  // authorizeToolCall and never reaches this block.
  if (toolName === "consultar_score_vendedores" && authority) {
    const mode = args?.mode;
    // mode="own" is meaningless for a non-seller identity -- including
    // MASTER. MASTER is not excluded from this ONE check (unlike every
    // other check in this file, which exempts MASTER as global
    // authority): MASTER already has full Score visibility via
    // mode="ranking"/"seller" (unaffected below), and letting MASTER
    // reach mode="own" would not leak anything MASTER can't already
    // see -- but toolConsultarScoreVendedores's own "own" branch
    // (index.ts) returns the RPC's FULL result set unfiltered for a
    // master caller (the RPC's own v_is_master bypass), which would be
    // mislabeled "Você mesmo" instead of the single real identity the
    // label promises. A correctness guard, not a security one: denied
    // rather than silently answered with the wrong shape of data.
    if (!authority.isSeller && mode === "own") {
      return { allowed: false, reason: "SCORE_SELLER_SCOPE_DENIED", detail: "mode" };
    }
    if (!authority.isMaster) {
      if (authority.isSeller && mode !== "own") {
        return { allowed: false, reason: "SCORE_SELLER_SCOPE_DENIED", detail: "mode" };
      }
      if (mode !== "own") {
        // Every mode except "own" still requires the real, canonical
        // analiseScoreVendedores module grant -- tool-policy.ts's
        // authorizeToolCall deliberately nulls this tool's static
        // modulePermission (mirroring simular_financiamento) so
        // mode="own" can be reached by a VENDEDOR caller (real grant:
        // false) without ever touching the ranking/seller-lookup
        // capability; this is where that same check now actually
        // happens for every other mode, unchanged in effect from
        // before this Wave.
        const granted = await checkModulePermission("analiseScoreVendedores").catch(() => false);
        if (!granted) return { allowed: false, reason: "MODULE_PERMISSION_DENIED", detail: "analiseScoreVendedores" };
      }
    }
  }

  // SEC-1B — Finding 1 (department/store scope enforcement), now
  // actually applied. authority is guaranteed non-null here: every
  // `decision.allowed === true` path in authorizeToolCall() already
  // required a resolved, known-profile authority first. Both check
  // functions short-circuit allowed:true for authority.isMaster
  // unconditionally (tool-policy.ts, unmodified by this wave) — since
  // the outer Gate MASTER (index.ts, unchanged this wave) is still the
  // sole reachable path for all real traffic today, this block has
  // ZERO live behavioral effect right now. It exists so the dormant
  // non-MASTER path is already safe once a future, separately-
  // authorized wave relaxes that outer gate — never widens what's
  // allowed, only narrows an already-narrow decision further, exactly
  // like the simular_financiamento module-permission follow-up
  // immediately above.
  const policyEntry = TOOL_POLICY[toolName];
  if (policyEntry && authority) {
    if (policyEntry.requiresDepartmentScope) {
      for (const raw of extractRequestedDepartments(toolName, args)) {
        const result = scopeCheckDepartment(raw, authority);
        if (!result.allowed) return { allowed: false, reason: result.reason, detail: "department" };
      }
    }
    if (policyEntry.requiresStoreScope) {
      for (const raw of extractRequestedStores(toolName, args)) {
        const result = scopeCheckStore(raw, authority);
        if (!result.allowed) return { allowed: false, reason: result.reason, detail: "store" };
      }
    }
  }

  return decision;
}

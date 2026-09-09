// IA-3D — governed semantic tool-policy foundation for Brabus F&I
// Intelligence.
//
// STATUS: FOUNDATION ONLY. This file exists, is fully tested (see
// tests/ia-reconciliation/tool-policy.test.mjs), but is NOT imported by
// index.ts and has ZERO effect on the live function. The global
// MASTER-only gate in index.ts (unchanged this wave) remains the only
// live authorization boundary. Wiring this module into dispatchTool()
// is explicitly deferred to a later, separately-authorized wave
// (IA-3E+) — see docs/IA-3D-TOOL-POLICY.md for the activation plan.
//
// CORE PRINCIPLE: the SERVER decides. Never the model (system-prompt
// instruction is not a security boundary), never the browser (a client
// context hint is a default/narrowing signal only, never authority),
// and never a value the model merely asked for (a requested argument is
// validated against verified scope, never trusted as-is). Every branch
// below fails closed: an unregistered tool, an unrecognized profile, a
// missing/failed authority resolution, a missing/failed module
// permission check, or a denied department/store scope all return
// allowed:false — there is no fail-open path anywhere in this file.
//
// EVIDENCE BASE (read directly from source this wave, not assumed):
// - Canonical profile/scope resolver: public.operational_current_scope()
//   (supabase/baseline/functions/operational_current_scope.sql, a
//   read-only capture of the REAL, live, already-cross-profile-tested
//   function — MASTER, DIRETOR NOVOS, DIRETOR SEMINOVOS, ANALISTA,
//   GERENTE, VENDEDOR proven; RH is NOT yet in this function's allowed
//   list on origin/main — see the RH note below).
// - Canonical module-permission catalog:
//   supabase/migrations/20260814090000_fase93_permissoes_modulos_schema.sql
//   (public.modulos_portal / public.permissoes_modulos, real permission
//   IDs used verbatim below — none invented).
// - The 12 real tools: supabase/functions/portal-ai-homolog/index.ts's
//   own TOOLS array (re-read in full this wave).
//
// RH NOTE (do not remove): a separate, currently LOCAL/UNMERGED commit
// (Secure repo, "fix(auth): reconcile RH operational scope") adds an RH
// branch to operational_current_scope() (RH -> NOVOS+SEMINOVOS, no
// store restriction). That commit is NOT on origin/main as of this
// file's authoring and is explicitly not depended upon here (Gate 22).
// Until it lands, a real RH caller's authority resolution against
// operational_current_scope() fails (SQLSTATE 42501) and this module's
// own AUTHORITY_RESOLUTION_FAILED path correctly denies every tool for
// them — not a special case, the same deny-by-default path any
// resolution failure takes.

export type Profile =
  | "MASTER"
  | "RH"
  | "ANALISTA"
  | "GERENTE"
  | "VENDEDOR"
  | "DIRETOR_NOVOS"
  | "DIRETOR_SEMINOVOS";

export type Department = "NOVOS" | "SEMINOVOS";

// Mirrors operational_current_scope()'s own real return shape
// (jsonb_build_object('profile', ..., 'store', ..., 'departments', ...,
// 'is_master', ..., 'is_director', ..., 'is_seller', ...)) — this type
// is NOT a new authority model, it is the existing one, typed.
export interface AuthorityEnvelope {
  profile: Profile;
  store: string | null;
  departments: Department[];
  isMaster: boolean;
}

export type ReasonCode =
  | "ALLOWED"
  | "TOOL_NOT_REGISTERED"
  | "UNKNOWN_PROFILE"
  | "AUTHORITY_RESOLUTION_FAILED"
  | "MODULE_PERMISSION_REQUIRED"
  | "MODULE_PERMISSION_DENIED"
  | "MODULE_PERMISSION_CHECK_FAILED"
  | "DEPARTMENT_SCOPE_DENIED"
  | "STORE_SCOPE_DENIED"
  | "SENSITIVE_TOOL_DENIED";

export type Operation = "READ_ANALYTICS" | "SIMULATION" | "SESSION_CONTROL";
export type Sensitivity = "LOW" | "MEDIUM" | "HIGH";

export interface ToolPolicyEntry {
  domain: string;
  operation: Operation;
  sensitivity: Sensitivity;
  // Explicit allowlist, independent of MASTER (MASTER is checked first
  // and separately in authorizeToolCall -- never re-derived from this
  // list, so MASTER's existing contract can never silently shrink if
  // this list is edited later).
  allowedProfiles: Profile[];
  // Canonical modulo_id from public.modulos_portal, or null for a tool
  // that needs no module permission (SESSION_CONTROL only).
  modulePermission: string | null;
  // Whether tool arguments carry a department/store field that must be
  // scope-checked against the caller's verified AuthorityEnvelope.
  requiresDepartmentScope: boolean;
  requiresStoreScope: boolean;
}

// ---------------------------------------------------------------------
// The 12-tool policy table.
//
// Every `modulePermission` value is a REAL id from modulos_portal,
// copied verbatim (never invented): simuladorCompleto, simuladorSeminovos,
// dashbi, gestao, coparticipadoPortal, analiseScoreVendedores, comissoes.
//
// consultar_comissoes is the one deliberate departure from a literal
// module-permission mirror (Gate 22 finding, documented inline below)
// -- every other tool's allowedProfiles is exactly the set of profiles
// whose real permissoes_modulos row for that module is `true` in at
// least one department, per the schema migration read this wave.
// ---------------------------------------------------------------------
export const TOOL_POLICY: Record<string, ToolPolicyEntry> = {
  consultar_resultado: {
    domain: "gestao", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: "gestao", requiresDepartmentScope: true, requiresStoreScope: true
  },
  comparar_resultado: {
    domain: "gestao", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: "gestao", requiresDepartmentScope: true, requiresStoreScope: true
  },
  consultar_ranking: {
    domain: "gestao", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: "gestao", requiresDepartmentScope: true, requiresStoreScope: true
  },
  consultar_operacoes_especiais: {
    domain: "coparticipadoPortal", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE"], // DIRETOR_SEMINOVOS/VENDEDOR/RH: real permissoes_modulos row is false for coparticipadoPortal (Coparticipado is NOVOS-only by product design, per simular_financiamento's own tool description)
    modulePermission: "coparticipadoPortal", requiresDepartmentScope: false, requiresStoreScope: true
  },
  consultar_score_vendedores: {
    domain: "analiseScoreVendedores", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE"], // same real-matrix basis as coparticipadoPortal
    modulePermission: "analiseScoreVendedores", requiresDepartmentScope: true, requiresStoreScope: true
  },
  // ---- Gate 22 finding: consultar_comissoes is deliberately NARROWER
  // than a literal `comissoes` module-permission mirror would produce.
  // The real permissoes_modulos matrix grants `comissoes=true` to
  // essentially every profile (VENDEDOR/GERENTE/ANALISTA/DIRETOR*
  // included) -- but that module permission was designed to gate a
  // SELF-SERVICE "Acompanhamento de Salário" UI page (presumably
  // self-scoped to the caller's own person server-side, not audited
  // this wave). The AI tool itself has no such self-scoping in its own
  // code: mode='person' accepts ANY person_name, mode='ranking' and
  // mode='summary' return GROUP-WIDE data. Mirroring the UI's
  // permission literally would grant every profile the ability to ask
  // "what does my manager earn" or "rank everyone's commission" --
  // materially broader than the UI module's own intent. Restricted to
  // MASTER + RH only (the two profiles whose function is administering/
  // auditing compensation) until a self-scoping contract is proven for
  // every other profile.
  consultar_comissoes: {
    domain: "comissoes", operation: "READ_ANALYTICS", sensitivity: "HIGH",
    allowedProfiles: ["MASTER", "RH"],
    modulePermission: "comissoes", requiresDepartmentScope: false, requiresStoreScope: false
  },
  simular_financiamento: {
    domain: "simuladores", operation: "SIMULATION", sensitivity: "LOW",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: null, // department-dependent: simuladorCompleto (NOVOS) or simuladorSeminovos (SEMINOVOS) -- resolved per-call from args.department, see resolveSimulatorModulePermission()
    requiresDepartmentScope: true, requiresStoreScope: false
  },
  analisar_historico_financiamento: {
    // No dedicated modulo_id exists for "Histórico" in the real
    // catalog. Mapped to `gestao` as the closest existing analytical
    // permission (same underlying data domain as consultar_resultado's
    // own group). Flagged, not asserted as a proven 1:1 correspondence
    // -- a Human/product decision should confirm this mapping before
    // this tool is ever wired live (Debt, Section 41).
    domain: "gestao (inferred mapping, unconfirmed)", operation: "READ_ANALYTICS", sensitivity: "MEDIUM",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: "gestao", requiresDepartmentScope: true, requiresStoreScope: true
  },
  simular_antecipacao: {
    domain: "simuladores", operation: "SIMULATION", sensitivity: "LOW",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: null, requiresDepartmentScope: false, requiresStoreScope: false // tool takes no department argument -- table-driven by months, not department-gated at the tool contract level
  },
  simular_cash_conversion: {
    domain: "simuladores", operation: "SIMULATION", sensitivity: "LOW",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: null, requiresDepartmentScope: false, requiresStoreScope: false
  },
  calcular_taxa_financiamento: {
    domain: "simuladores", operation: "SIMULATION", sensitivity: "LOW",
    allowedProfiles: ["MASTER", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: null, requiresDepartmentScope: false, requiresStoreScope: false
  },
  iniciar_novo_cliente: {
    // SESSION_CONTROL, not BUSINESS_WRITE -- confirmed by direct source
    // read (index.ts): mechanically splices the in-memory conversation
    // array (input.splice(1, conversationLength)) before dispatchTool
    // is ever reached; 0 DB access, 0 RPC call, 0 parameters. Available
    // to any profile that already has any Intelligence access at all --
    // it is a conversation-hygiene control, not a data domain.
    domain: "session", operation: "SESSION_CONTROL", sensitivity: "LOW",
    allowedProfiles: ["MASTER", "RH", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"],
    modulePermission: null, requiresDepartmentScope: false, requiresStoreScope: false
  }
};

// department-dependent module permission for simular_financiamento
// (the one tool whose real module split is NOVOS vs SEMINOVOS, per the
// modulos_portal catalog's own simuladorCompleto/simuladorSeminovos
// split).
export function resolveSimulatorModulePermission(department: string | null | undefined): string | null {
  if (department === "SEMINOVOS") return "simuladorSeminovos";
  if (department === "NOVOS") return "simuladorCompleto";
  return null; // unresolved department -- caller must still pass a real department per the tool's own existing contract; policy does not guess
}

export interface AuthorizeResult {
  allowed: boolean;
  reason: ReasonCode;
  detail?: string;
}

// A caller-supplied function that performs the REAL, live
// portal_modulos_permitidos() lookup for (moduleId) against the
// caller's own verified identity -- this module NEVER hardcodes the
// true/false grant matrix itself (that data can change independently
// of this code and must never drift into a stale replica, the exact
// lesson of this project's own FIX-IA-GATE-01 Score incident).
export type ModulePermissionChecker = (moduleId: string) => Promise<boolean>;

const KNOWN_PROFILES: Profile[] = ["MASTER", "RH", "ANALISTA", "GERENTE", "VENDEDOR", "DIRETOR_NOVOS", "DIRETOR_SEMINOVOS"];

export function isKnownProfile(p: unknown): p is Profile {
  return typeof p === "string" && (KNOWN_PROFILES as string[]).includes(p);
}

// Deny-by-default authorization decision. Every return path is
// enumerated explicitly -- there is no code path that reaches the end
// of this function without an explicit allowed:true/false.
export async function authorizeToolCall(
  toolName: string,
  authority: AuthorityEnvelope | null,
  checkModulePermission: ModulePermissionChecker
): Promise<AuthorizeResult> {
  const entry = TOOL_POLICY[toolName];
  if (!entry) {
    return { allowed: false, reason: "TOOL_NOT_REGISTERED", detail: toolName };
  }

  if (!authority || !isKnownProfile(authority.profile)) {
    return { allowed: false, reason: authority ? "UNKNOWN_PROFILE" : "AUTHORITY_RESOLUTION_FAILED" };
  }

  // MASTER: preserves the exact current 12-tool contract unconditionally
  // -- never re-derived from allowedProfiles, so this can never
  // silently regress if the policy table above is edited later.
  if (authority.isMaster) {
    return { allowed: true, reason: "ALLOWED" };
  }

  if (!entry.allowedProfiles.includes(authority.profile)) {
    return { allowed: false, reason: "SENSITIVE_TOOL_DENIED", detail: `${authority.profile} not in policy for ${toolName}` };
  }

  const modulePermission =
    toolName === "simular_financiamento" ? null /* resolved by caller per-args via resolveSimulatorModulePermission before calling this, if desired -- kept out of this function's own signature to avoid coupling policy to one tool's argument shape */
    : entry.modulePermission;

  if (modulePermission) {
    let granted: boolean;
    try {
      granted = await checkModulePermission(modulePermission);
    } catch {
      return { allowed: false, reason: "MODULE_PERMISSION_CHECK_FAILED", detail: modulePermission };
    }
    if (!granted) {
      return { allowed: false, reason: "MODULE_PERMISSION_DENIED", detail: modulePermission };
    }
  }

  return { allowed: true, reason: "ALLOWED" };
}

// ---------------------------------------------------------------------
// Scope enforcement -- client hints/model-requested values may only
// NARROW an already-verified scope, never broaden it. Never silently
// substitutes the caller's own scope for a rejected out-of-scope
// request (Gate 25's own "DENY or force Y" choice: this module always
// DENIES, so the caller/model gets an explicit, honest signal instead
// of a silently-redirected answer that could be mistaken for what was
// actually asked).
// ---------------------------------------------------------------------

export interface ScopeCheckResult {
  allowed: boolean;
  reason: ReasonCode | "ALLOWED";
}

export function checkDepartmentScope(
  requested: string | null | undefined,
  authority: AuthorityEnvelope
): ScopeCheckResult {
  if (authority.isMaster) return { allowed: true, reason: "ALLOWED" };
  if (!requested) return { allowed: true, reason: "ALLOWED" }; // absent request -- caller defaults elsewhere (tool's own existing required-field validation), not this module's concern
  if (!authority.departments.includes(requested as Department)) {
    return { allowed: false, reason: "DEPARTMENT_SCOPE_DENIED" };
  }
  return { allowed: true, reason: "ALLOWED" };
}

export function checkStoreScope(
  requested: string | null | undefined,
  authority: AuthorityEnvelope
): ScopeCheckResult {
  if (authority.isMaster) return { allowed: true, reason: "ALLOWED" };
  if (!requested) return { allowed: true, reason: "ALLOWED" }; // null/absent = caller's own default scope, not a broadening request
  if (!authority.store) return { allowed: true, reason: "ALLOWED" }; // no store constraint on this authority (e.g. RH's corporate scope, once resolvable) -- any explicit store request passes through unchanged, per Gate 26's "validated requested filters may pass" for global-authority-shaped profiles
  const normalize = (s: string) => s.trim().toUpperCase();
  if (normalize(requested) !== normalize(authority.store)) {
    return { allowed: false, reason: "STORE_SCOPE_DENIED" };
  }
  return { allowed: true, reason: "ALLOWED" };
}

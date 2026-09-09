# Brabus F&I Intelligence — Governed Semantic Tool Policy (IA-3D)

Status: **FOUNDATION ONLY. NOT WIRED IN. NOT ACTIVATED.** The global
MASTER-only gate in `portal-ai-homolog/index.ts` (unchanged this phase)
remains the sole live authorization boundary for every real request.
`supabase/functions/portal-ai-homolog/tool-policy.ts` exists, is fully
tested in isolation (`tests/ia-reconciliation/tool-policy.test.mjs`,
79/79), but `index.ts` does not `import` it — it has zero effect on the
deployed function.

## 1. Why a policy foundation, not an activation

Today `portal-ai-homolog` has exactly one authorization decision:
MASTER or not. All 12 tools are equally available to any MASTER
caller, and no other profile can reach the function's tool-dispatch
path at all (the global gate returns 403 first). This phase builds the
**foundation** for a future, more granular model — server-verified
profile → module permission → operational scope → tool execution —
without changing what happens today for any real caller.

## 2. Core principle

The server decides. Not the model (a system-prompt instruction is not
a security boundary — see `index.ts`'s own extensive per-domain privacy
instructions, which are defense-in-depth, never the only defense). Not
the browser (a client-supplied hint may narrow a default, never grant
access). Not a value the model merely requested (every argument is
checked against server-verified scope before it can reach a tool).

## 3. Evidence base (read directly this phase, not assumed)

- **12 real tools**: `portal-ai-homolog/index.ts`'s own `TOOLS` array,
  re-read in full. All 12 already self-describe as read-only in their
  own tool descriptions except `iniciar_novo_cliente` (session reset,
  0 parameters, 0 backend access, mechanically proven — see
  `structural.test.mjs`).
- **Canonical authority resolver**: `public.operational_current_scope()`
  (`supabase/baseline/functions/operational_current_scope.sql`, a
  read-only capture of the real, live function). Already
  cross-profile-tested by its own author phase: MASTER, DIRETOR NOVOS,
  DIRETOR SEMINOVOS, ANALISTA, GERENTE, VENDEDOR proven consistent.
  Returns `{profile, store, departments, is_master, is_director,
  is_seller}` — this module's `AuthorityEnvelope` type is that shape,
  typed, not a new authority model.
- **Canonical module-permission catalog**:
  `supabase/migrations/20260814090000_fase93_permissoes_modulos_schema.sql`
  (`public.modulos_portal` / `public.permissoes_modulos`) — every
  `modulePermission` value in the policy table below is one of these
  real ids (`gestao`, `comissoes`, `coparticipadoPortal`,
  `analiseScoreVendedores`, `simuladorCompleto`, `simuladorSeminovos`),
  copied verbatim, never invented.

### RH — a proven, disclosed gap

`operational_current_scope()`'s allowed-profile list on `origin/main`
today is `MASTER, DIRETOR NOVOS, DIRETOR SEMINOVOS, ANALISTA, GERENTE,
VENDEDOR` — **RH is not in it**. A separate, local, **unmerged**
commit in this repository (`fix(auth): reconcile RH operational
scope`, on branch `p2-rh-operational-scope-local`, not depended upon
here per Gate 22) adds an RH branch (`NOVOS+SEMINOVOS`, no store
restriction). Until that commit lands on `origin/main`, a real RH
caller's own authority resolution fails (`SQLSTATE 42501`), and this
policy module's `AUTHORITY_RESOLUTION_FAILED` path correctly denies
every tool for them — not a special case, the same path any resolution
failure takes. `RH` is nonetheless a **recognized** profile in this
module's own vocabulary (`isKnownProfile("RH") === true`) so the
policy table is ready the moment that backend fix lands, with no
further code change needed here.

## 4. Tool inventory (12/12, from source this phase)

| Tool | Domain | Backend authority | Operation | Sensitivity |
|---|---|---|---|---|
| `consultar_resultado` | Dash BI / Gestão | RPC `operational_metrics` | READ_ANALYTICS | MEDIUM |
| `comparar_resultado` | Dash BI / Gestão | Same (reuses `consultar_resultado`) | READ_ANALYTICS | MEDIUM |
| `consultar_ranking` | Dash BI / Gestão | RPC `operational_metrics` + `operational_model_metrics_without_spf` | READ_ANALYTICS | MEDIUM |
| `consultar_operacoes_especiais` | Coparticipado/Subsidiado | RPC `operational_score_coparticipated_data` | READ_ANALYTICS | MEDIUM |
| `consultar_score_vendedores` | Score | Same RPC (shared dataset) | READ_ANALYTICS | MEDIUM |
| `consultar_comissoes` | Salários & Comissões | RPC `operational_commission_periods`/`operational_commission_metrics`/`operational_analyst_commission_metrics_v2`/`operational_salary_manager_directory`/`master_commission_closings`/`master_commission_snapshot`/`master_operational_spf_audit_period` | READ_ANALYTICS | **HIGH** |
| `simular_financiamento` | Simuladores | RPC `simulador_get_*` (rate tables, not customer data) | SIMULATION | LOW |
| `analisar_historico_financiamento` | Histórico | Same shared RPC as Score/Coparticipado | READ_ANALYTICS | MEDIUM |
| `simular_antecipacao` | Simuladores | RPC `simulador_get_antecipacao` (discount table) | SIMULATION | LOW |
| `simular_cash_conversion` | Simuladores | **Local computation only, 0 RPC** (`_userClient` unused in source) | SIMULATION | LOW |
| `calcular_taxa_financiamento` | Simuladores | **Local computation only, 0 RPC** | SIMULATION | LOW |
| `iniciar_novo_cliente` | Session | None — in-memory `input.splice()` only | SESSION_CONTROL | LOW |

No tool performs a database write. No tool requires service-role data
access for business reads (service role is used only to resolve the
caller's own `usuarios.perfil`, unchanged from today).

## 5. The one deliberate departure: `consultar_comissoes`

The real `permissoes_modulos` matrix grants `comissoes=true` to nearly
every profile (VENDEDOR/GERENTE/ANALISTA/DIRETOR* included) — but that
permission gates a **self-service** "Acompanhamento de Salário" UI
page. The AI tool itself has no equivalent self-scoping in its own
code: `mode='person'` accepts *any* `person_name`, `mode='ranking'`/
`mode='summary'` return group-wide data. Mirroring the UI permission
literally would let a VENDEDOR ask "what does my manager earn" —
materially broader than the UI module's intent. **Policy restricts
this tool to `MASTER` + `RH` only**, regardless of the broader UI
permission, until/unless a self-scoping contract is proven for every
other profile in a future phase.

## 6. Scope enforcement

`checkDepartmentScope()`/`checkStoreScope()`: a requested value may
only **narrow**, never broaden. MASTER always passes (global
authority). A non-MASTER request for a department/store outside the
caller's own verified scope is **denied outright** — never silently
substituted with the caller's own value (an honest "denied" beats a
silent redirect that could be mistaken for what was actually asked).

## 7. Trust boundary — explicit, tested, and load-bearing

`authorizeToolCall()` **trusts the `AuthorityEnvelope` it is given**;
it does not itself call `operational_current_scope()` or verify a JWT.
This is proven directly by test (`tool-policy.test.mjs`, "Adversarial:
a forged isMaster=true..."): if a caller constructs a forged envelope,
this module has no way to detect that. **This is by design and by
necessity** — the whole point of a policy module is to be pure,
synchronous-shaped, and independently testable — but it means the
wiring wave (below) carries the entire weight of constructing
`AuthorityEnvelope` **exclusively** from a genuine, server-verified
`operational_current_scope()` result, **never** from any
client-suppliable field. This is the single most important fact for
whoever wires this module in next.

## 8. Result sanitization — already present, not newly built

`portal-ai-homolog/index.ts` already has a real, evidence-backed
discipline: CPF/chassi/customer-identity fields are **never read** from
RPC results in the first place (stronger than "collected then
redacted") — e.g. line ~1678's own comment: "cpf NUNCA é lido, mesmo
que a RPC o inclua," with a documented real incident (line ~1839) where
an RPC unexpectedly included CPF and the code was fixed to never read
that field. Reinforced by extensive per-domain system-prompt privacy
instructions (lines ~6125–6299). No new sanitization layer was built
this phase — the existing one is real, tested by the project's own
history, and Gate 28 explicitly warns against stripping business-
required aggregate fields a new layer might over-remove.

## 9. Prompt-injection boundary

`authorizeToolCall()`'s signature is `(toolName, authority,
checkModulePermission)` — it has no parameter for tool *output*.
Authorization is decided entirely before tool execution, from
server-verified inputs only. Data a tool returns (including anything
an adversarial store/model/customer-adjacent string might contain) can
never influence an authorization decision, structurally, not just by
convention.

## 10. Voice/Realtime — one shared policy, no second registry

This policy belongs to Brabus Intelligence's core, not to any one
transport. Voice-01 has 0 business tools (unchanged). Realtime retains
exactly its 1 bridge tool, `consultar_portal_intelligence`, which
forwards into the same TEXT brain — so once this policy is eventually
wired into TEXT's own `dispatchTool()`, Voice/Realtime inherit it
automatically through that same bridge, with no separate Voice policy
registry ever created.

## 11. Activation plan (future wave, not this one)

1. Construct `AuthorityEnvelope` from a real, live
   `userClient.rpc("operational_current_scope")` call, immediately
   after the existing MASTER-gate-equivalent session check.
2. Call `authorizeToolCall(toolName, envelope, checkModulePermission)`
   inside `dispatchTool()`, before the existing per-tool argument
   validation — `checkModulePermission` must call the real
   `portal_modulos_permitidos()` RPC live, never a hardcoded table.
3. For `simular_financiamento`, resolve
   `resolveSimulatorModulePermission(args.department)` and check it
   the same way.
4. Apply `checkDepartmentScope()`/`checkStoreScope()` to every relevant
   tool argument before it reaches the tool's own implementation.
5. Keep the global MASTER gate in place initially — this policy layer
   becomes a **second**, narrower gate for non-MASTER callers, not a
   replacement, until non-MASTER activation is separately,
   explicitly authorized.
6. Confirm `HOMOLOG_PLATFORM_VERIFY_JWT_HARDENING_PENDING` and
   `CURRENT_SUPABASE_OPENAI_KEY_ENVIRONMENT_BINDING_UNPROVEN` (see
   `docs/IA-RECONCILIATION-V2.md` §22–23) are both closed before any
   real non-MASTER traffic is ever allowed to reach this code path.

Not executed this wave.

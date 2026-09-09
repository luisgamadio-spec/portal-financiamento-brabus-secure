# Brabus F&I Intelligence — Reconciliation Ledger (IA-RECON-01)

Status: **RECONCILED_LOCAL_CANDIDATE**. Not LIVE. Not HUMAN_APPROVED.
Local branch `ia-reconciliation-v2-local`, worktree
`C:\Projetos\ia-reconciliation-v2-local`. Every historical branch this
document references is unmodified evidence — nothing was deleted,
renamed, rebased, or force-updated.

## 1. Starting state

- Portal V2 baseline (context only, untouched by this phase): `7590915`.
- Secure repo audited HEAD at the start of this phase: `4d8ce1d`
  (branch `hotfix/fandi-analista-group-scope`), which is byte-identical
  to `origin/main`'s tip (`git rev-parse origin/main HEAD` — both
  `4d8ce1d`).
- Working tree at start: clean except pre-existing untracked files
  (spreadsheets, `scripts/`, `supabase/.temp/`, `supabase/README.md`)
  — none touched.

## 2. Selected base

**Base: `origin/main` (`4d8ce1d`)**, not `ia-uat-fix-local`.

Reason: `origin/main` carries the latest non-Intelligence Secure state
(75+ commits of real production fixes since the Intelligence branches
diverged — the most recent being `4d8ce1d` itself, a FANDI store-scope
fix from the same day this phase started). Starting from
`ia-uat-fix-local` instead would have silently discarded all of that.
The actual merge-base of `origin/main` and `ia-uat-fix-local` is
`5e5dd10` ("restore SPF Extra context in F&I dashboard", 2026-08-27) —
both branches are real, live lines of work from that point forward,
neither a strict ancestor of the other. Reconciliation therefore means
selectively importing Intelligence-specific files from
`ia-uat-fix-local` onto the `origin/main` base, not merging or
rebasing either branch.

## 3. IA-2B multiverse — resolved

RECOVERY-01 flagged ~15 divergent "IA-2B UI" continuations. Direct
`git log --all --grep` found exactly **7** distinct commit objects with
the identical subject "feat: Brabus F&I Intelligence UI (IA-2B,
MASTER-only)": `f73779e`, `1d598d9`, `63bcac5`, `3e98de8`, `ce85772`,
`f43ed2b`, `ca3b338`.

**Tree-identical**: `63bcac5` and `3e98de8` (identical tree hash
`c52f932…`, identical parent — the same commit reachable via two
branch names).

**Actually divergent at the whole-tree level, but semantically
identical for the one file that matters**: all 7 have different overall
tree hashes (each was committed on top of a different snapshot of the
wider, unrelated codebase — different `index.html`/`portal-app.js`
states at each point). But `assets/js/portal-ai-ui.js` — the entire
substance of "IA-2B" — is **byte-identical across all 7** (`diff` = 0
lines for every pair checked). The "multiverse" is real at the
repository-history level (7 independent forks never merged with each
other) but not a semantic conflict: they all shipped the exact same
frontend feature.

**Selected authority: `f73779e`**, because it is the one candidate that
is an ancestor of `origin/main` (verified:
`git merge-base --is-ancestor f73779e origin/main` → yes). This means
the current reconciliation base **already contains** the authoritative
IA-2B frontend — no import was needed for the base drawer feature
itself.

**Real divergence found and resolved**: `origin/main`'s current
`assets/js/portal-ai-ui.js` and `ia-uat-fix-local`'s current copy
differ by only 18 lines (`diff` of the two full current files) — not
1000+ as an earlier same-session pass mis-measured against the wrong
comparison pair. The 18-line difference is exactly one thing:
`origin/main`'s copy has an extra safety gate,
**`IA-PROD-CONTAINMENT-01`** (`window.PORTAL_RUNTIME_CONFIG.aiAssistantEnabled
=== false` disables the button even for MASTER), which
`ia-uat-fix-local`'s copy lacks (expected — it's a UAT branch, not
production-facing). `origin/main`'s copy is therefore a strict superset
for the base IA-2B feature.

A **third, more evolved copy** was found outside git entirely: `C:\Projetos\uat-serve\assets\js\portal-ai-ui.js`
(untracked, no `.git` anywhere in that folder). It is a superset of
BOTH other copies — it has `IA-PROD-CONTAINMENT-01` (confirmed by
direct grep) *and* the full VOICE-01/Realtime/Voice Studio UI wiring
(mic button, realtime status bar, voice studio button,
`AI_CONVERSATION_GEN` staleness counter for post-reset responses) *and*
had **already, independently**, applied a fix for the exact
`baiFormatValue` date-rendering defect RECOVERY-01 found (different
variable name, same fix). **This file was adopted as authoritative**
for the reconciliation branch, replacing the smaller in-branch patch
this phase had drafted first (same behavior, proven by re-running the
frontend test suite against the adopted file — still 7/7).

## 4. Feature dependency graph

```
IA-2A (portal-ai/index.ts, backend, undeployed)
  └─ IA-2B (portal-ai-ui.js, frontend drawer) — consumes IA-2A's HTTP contract only
       └─ [fork point 5e5dd10] portal-ai-homolog/index.ts first committed (c8ce1f0)
            ├─ IA-2C.x — Coparticipado/Subsidiado/Salários/Score tools (read-only analytics)
            │    └─ IA-2C.4 — Score F&I replica (depends on operational_score_coparticipated_data,
            │         same RPC as IA-2C.3) — later re-synced by FIX-IA-GATE-01 (see §8)
            ├─ IA-2D.x — Linear/Semestral/Anual simulation tools, historical financing tool
            ├─ IA-2F.x — Taxa Implícita, Cash Conversion, Antecipação engines
            ├─ IA-2G.x — orchestration/commercial/natural-conversation prompt rules
            ├─ UAT-BALAO-AUTONOMY-01 → UAT-BALAO-EXPLORATION-01 (multi-balloon builds on single-balloon)
            ├─ UAT-ANTECIPACAO-AUTONOMY-01 (first_due_date default)
            ├─ UAT-CASH-CONVERSION-AUTONOMY-01 (fixed rate + financing-first prompt)
            ├─ IA-UAT-VOICE-NOVOCLIENTE-01 — scenario-reset tool (iniciar_novo_cliente)
            │    └─ VOICE-01 (c42fc31, portal-voice-homolog) — depends on the TEXT brain existing
            │         └─ VOICE-02/Realtime (27c0e11, portal-realtime-homolog) — proxies to TEXT brain
            │              └─ VOICE-03 (55518d6) — Voice Studio lab mode
            │                   └─ UAT-VOICE-ACCENT-01 (f7b8a86) — speed/profile default wiring
            └─ IA-CHECKPOINT-1 (8eae327, portal-ai ONLY) — real deploy attempt, found+fixed a
                 bundling-breaking stray-backtick bug in portal-ai's SYSTEM_PROMPT — verified this
                 phase that portal-ai-homolog never had the same two backtick literals (§8)
```

Everything below `portal-ai-homolog/index.ts`'s first commit is a
single linear chain on one branch (`ia-uat-fix-local`) — there is no
second multiverse for this deeper feature work; RECOVERY-01's
"fragmented across ~15 branches" framing applied to the *base* IA-2B
commit only, not to the feature work built on top of it.

## 5. What was imported into this branch

| Path | Source | Reason |
|---|---|---|
| `supabase/functions/portal-ai-homolog/index.ts` | `ia-uat-fix-local` tip (`a9fdd56`), unmodified | Single linear source for every post-IA-2B tool; already contains IA-2A's 3 original tools plus everything since |
| `supabase/functions/portal-voice-homolog/index.ts` | `ia-uat-fix-local` tip, unmodified | VOICE-01 backend, single source |
| `supabase/functions/portal-realtime-homolog/index.ts` | `ia-uat-fix-local` tip, unmodified | Realtime backend, single source |
| `assets/js/portal-ai-ui.js` | `C:\Projetos\uat-serve` (untracked, never in any repo) | Proven superset — production gate + date fix + voice/realtime wiring, verified by test suite |
| `assets/js/portal-ai-voice.js` | `C:\Projetos\uat-serve` | VOICE-01 frontend, no other copy exists anywhere |
| `assets/js/portal-ai-realtime.js` | `C:\Projetos\uat-serve` | Realtime frontend, no other copy exists anywhere |
| `assets/js/portal-ai-voice-studio.js` | `C:\Projetos\uat-serve` | Voice Studio (LAB ONLY), no other copy exists anywhere |
| `index.html` | Modified in-branch, +6 lines | Wires the 3 new script tags, commented as MASTER-only/flag-gated/lab-only |

`supabase/functions/portal-ai/index.ts` was **not** touched or
imported by this phase's own commits — per Gate 10, this phase never
wrote to it.

**IA-3B correction (`IA_RECONCILIATION_LEDGER_PORTAL_AI_FROZEN_CLAIM_INACCURATE`,
LOW, documentation debt)**: the paragraph above, and Gate 10's own
framing, describe this file as "untouched... stays exactly as
`origin/main` already has it." Direct measurement on this branch
contradicts that: `origin/main`'s copy is 869 lines / 3 tools, but
**this branch's own copy of `portal-ai/index.ts` is 5,784 lines / 11
tools** — it independently diverged through the same IA-2C→2G feature
history as `portal-ai-homolog`, via a separate, slightly-behind
lineage, well before this phase ever ran. Gate 10's intent (never
write to this file, treat `portal-ai-homolog` as the forward
authority) was honored correctly — no commit in this phase touches
it. But the "stays exactly as `origin/main` already has it" claim
itself was never true and should not be repeated or trusted as
provenance evidence for this file going forward. This correction does
not rewrite the rest of this document's historical narrative — it
corrects one factual claim, discovered and proven during IA-3A.1.

## 6. Frontend inventory classification (Gate 29)

| File | Classification |
|---|---|
| `portal-ai-ui.js` (uat-serve copy) | REQUIRED — adopted as authoritative |
| `portal-ai-voice.js` | REQUIRED — VOICE-01's only frontend |
| `portal-ai-realtime.js` | REQUIRED — Realtime's only frontend |
| `portal-ai-voice-studio.js` | LAB ONLY — its own header literally reads "🧪 Voice Studio — LAB ONLY, não é a UI final"; wired but must never become the customer-facing entry point |

## 7. Antecipação date-rendering fix (Gate 18)

Confirmed present (bug reproduced by direct code inspection before any
fix): `baiFormatValue()`'s numeric guard rejected any non-number value
before format was even checked, so `format: "date"` values (plain
`"YYYY-MM-DD"` strings from `first_due_date`/`settlement_date`) always
fell through to `"—"`.

The adopted `uat-serve` copy of `portal-ai-ui.js` already carried an
independent fix for this. Verified correct and safe:

- Pure string rebuild (`"YYYY-MM-DD".split("-")` → `"DD/MM/YYYY"`),
  never routed through `Date()`/`toLocaleDateString()` — zero timezone
  conversion risk (Gate 18's explicit requirement).
- `null`/malformed values still fall back to `"—"`, not a crash or a
  fabricated date.
- All pre-existing formats (`currency`/`percent`/default numeric)
  unaffected — proven by `tests/ia-reconciliation/frontend-format.test.mjs`,
  7/7 including 3 explicit regression checks for the untouched formats.

No financial value was touched — this is a presentation-only fix, per
RECOVERY-01's own authorization for exactly this defect.

## 8. Score integration — fully audited (Gate 22)

`portal-ai-homolog/index.ts` (IA-2C.4, lines ~1043–1076) contains a
byte-for-byte replica of `modules/score.html`'s `calcScores()` —
extracted verbatim (weights, `isScoreSellerEligible`, `normalizeText`,
`EXCLUDED_SELLERS`), validated 70/70 sellers matching a real Playwright
run of the actual `score.html` in a real browser, cross-checked a
second way by an independent Python script (5 immaterial rounding
differences explained and provably absent in this TS/Deno
implementation, since both this file and `score.html` are JS runtimes
sharing `Math.round`'s exact semantics).

**A real, disclosed incident is on record inside the source itself**:
`FIX-IA-GATE-01` found that Score 2.0 (a later production change,
`origin/main` commit `e2eeff3`) changed the scoring formula without the
AI's replica being updated — proven live with a real, named seller
(Eric Tavares dos Santos: AI said 738/"Bom", correct was 352/"Baixo").
This was fixed in the same phase (weights/`MIX_PLANOS_UNIVERSO`/
confidence factors re-synced against `modules/score.html` line 254/540
at `e2eeff3`).

**Verified this phase, against TODAY's `origin/main`**: `e2eeff3` is
still an ancestor of the current `origin/main` tip, and
`modules/score.html` has **0 diff** since `e2eeff3` — the replica is
currently in sync with production, not stale again. Status: **IMPLEMENTED,
TESTED (70/70 cross-checked twice), currently valid — re-verified
against production drift, not merely assumed**.

## 9. Bundling-safety check (new finding this phase)

`origin/main` commit `8eae327` documents a real, deploy-blocking bug in
`portal-ai/index.ts`: two literal backticks inside a template-literal
`SYSTEM_PROMPT` (`` `possible:false` ``, `` `payment` ``) closed the
string early and broke TypeScript bundling entirely — never caught
before because Deno/the Supabase bundler were unavailable throughout
most of this project's history.

Checked whether `portal-ai-homolog/index.ts` has the same two literals:
**it does not** (`grep` for the exact strings: 0 matches). Additionally,
this phase's own test harness (`tests/ia-reconciliation/*.test.mjs`)
imports slices of the real file through Node 24's native TypeScript
parser, and a full-file import attempt reached module-resolution (a
Deno-specific `https:` import Node's loader correctly can't follow) —
not a syntax error — meaning the file parses as valid TypeScript
end-to-end. No evidence of a bundling-breaking defect in
`portal-ai-homolog/index.ts`.

## 10. Scenario memory & Novo Cliente — fully audited (Gates 24–25)

**There is no server-side or database-persisted scenario memory.** The
backend is explicitly stateless by design (its own comment: "back-end
é sem estado, a continuidade inteira vem do array que o cliente
manda"). "Memory" is the `conversation` array (last 8 turns) the
frontend sends with every request — natural-language turns, not
discrete structured fields. Nothing (capital, parcela, prazo, balloon
context, client identity, ...) is ever written to a table; it only
exists as text the model reads fresh each turn.

`iniciar_novo_cliente` (schema: 0 parameters, "não consulta o Portal
nem calcula nada") is a pure reset marker:

1. When the model calls it, the dispatcher **mechanically splices out**
   the prior conversation block from `input` before the model
   formulates this turn's reply (`input.splice(1, conversationLength)`)
   — not merely a prompt instruction hoping the model complies.
2. Fires at most once per request (`scenarioReset` flag) even if the
   model calls it more than once.
3. Never reaches `dispatchTool`/any RPC — handled with an early
   `continue` before the tool-dispatch switch.
4. Returns `scenario_reset: true` to the caller, so the **frontend**
   also prunes its own `AI_CONVERSATION` array — otherwise the next
   turn would resend the old history anyway, since the backend holds
   nothing.

### Memory table (Gate 44)

| Field | Persisted | Scope | Source | Cleared by Novo Cliente | Notes |
|---|---|---|---|---|---|
| Client identity | NO | Client-side page memory only | Natural-language conversation turns | YES (via splice + `scenario_reset`) | Never a structured field; never written to any table |
| Vehicle value / capital / entrada / prazo / parcela | NO | Client-side page memory only | Natural-language conversation turns | YES | Same as above — the model infers these from prior turns' text each time |
| Balloon count / value / months | NO | Client-side page memory only | Natural-language conversation turns | YES | Same |
| Financial plan / comparison context | NO | Client-side page memory only | Natural-language conversation turns | YES | Same |
| Cash Conversion / Antecipação scenario | NO | Client-side page memory only | Natural-language conversation turns | YES | Same |
| Last selected tool | NO | Not tracked at all | N/A | N/A | The model re-decides which tool to call every turn from the conversation text; no explicit "last tool" state exists |
| System prompt / tool schemas / engine constants (`CASH_CONVERSION_APPLICATION_RATE`, `BALAO_MAX_COUNT`, ...) | Effectively YES (code, not data) | GLOBAL | Source file | NO — correctly, per Gate 25 | Business rules are never client/scenario state; `iniciar_novo_cliente` cannot touch them because it never executes any tool logic |

## 11. Prompt reconciliation (Gate 26)

No rewrite performed. `portal-ai/index.ts` (frozen, `origin/main`) and
`portal-ai-homolog/index.ts` (this branch's authority) diverge simply
because the homolog line is IA-2A's prompt plus every later phase's
additive sections (IA-2C/2D/2F/2G, financing-first guidance, Novo
Cliente instructions) — not two competing rewrites of the same
sections. No conflicting instruction pair was found between them; the
homolog prompt is a strict superset in intent. `portal-ai`'s one
independent fix since divergence (`8eae327`'s backtick escaping) does
not apply to homolog, which never had the bug (§9).

## 12. Tool registry (Gate 27)

12 tools declared in `portal-ai-homolog`'s `TOOLS` array. 11 have a
matching `dispatchTool()` executor case; the 12th
(`iniciar_novo_cliente`) is the one documented, intentional exception —
it never reaches `dispatchTool` by design (§10). 0 orphan executor
cases (no `dispatchTool` case exists for a name that isn't registered).
Proven by `tests/ia-reconciliation/structural.test.mjs` (15/15,
source-invariant, re-verified against the real file at every run).

## 13. Structured blocks (Gate 28)

Every `build*Block()` function checked (`buildCashConversionBlock`,
`buildAntecipacaoBlock`) reads only `result.<field>` / `args.<field>`
into its `value:` entries — 0 calculation calls
(`cashConversionCalcular`/`antecipacaoCalcular`/`Math.pow`/`Math.round`)
found inside either builder. Frontend (`baiBuildMetricsBlock` and
friends) only formats (`baiFormatValue`) — it never derives a number.
Financial truth stays entirely in the engine layer.

## 14. TEXT / VOICE-01 / Realtime architecture

- **TEXT** (`portal-ai-homolog`): direct, first-class access to all 12
  tools.
- **VOICE-01** (`portal-voice-homolog`): STT/TTS proxy only, 0 tools
  registered — it transcribes speech to text and synthesizes the
  reply's audio; it does not reason about financial tools itself.
- **Realtime** (`portal-realtime-homolog`): registers exactly 1 tool,
  `consultar_portal_intelligence`, which forwards the user's message as
  text into the TEXT brain and relays the answer back — its own system
  instructions explicitly forbid it from holding any business rule
  itself ("Nenhuma regra de negócio... existe aqui — isso é exclusivo
  de portal-ai-homolog").

This is the intended architecture (Gate 33 explicitly allows indirect
access through the TEXT brain as valid, not a gap to fill) — not
duplicated here.

### Channel matrix (Gate 45)

| Capability | TEXT | VOICE-01 | REALTIME | Authoritative Engine | Parity Status |
|---|---|---|---|---|---|
| Linear/Balão/Coparticipado/Subsidiado/Antecipação/Cash Conversion/Taxa Implícita/Score/Histórico | DIRECT | NOT_AVAILABLE | VIA_TEXT_BRAIN | `portal-ai-homolog/index.ts` | Semantic parity holds for REALTIME (same engine, reached indirectly); VOICE-01 has no path to these at all — it is a pure audio I/O layer, not a reasoning channel |
| `iniciar_novo_cliente` (scenario reset) | DIRECT | NOT_AVAILABLE | VIA_TEXT_BRAIN | `portal-ai-homolog/index.ts` | Same as above |

## 15. Security (Gate 35)

MASTER-only gate confirmed structurally present in `portal-ai-homolog`:
401 for no session (`"Usuário não autenticado"`), 403 for a real,
authenticated non-MASTER caller (`caller.perfil !== "MASTER"`, resolved
via a genuine DB lookup — never a trusted client claim). Proven by
`structural.test.mjs`'s 3 security checks. No live/production auth call
was made — all checks are source-invariant against the real file text.

## 16. Known limitations (preserved, not silently fixed)

- **Balão placement**: for a fixed balloon amount, an earlier month
  produces a materially lower payment than the current "last month"
  convention (proven live, ~42% lower in one sampled scenario). Not
  implemented — an explicit, disclosed OPEN PRODUCT DECISION, not an
  oversight.
- **Taxa Implícita commercial-table matching**: the calculator's
  fixed-fee assumptions do not reconcile with the real Linear/
  Coparticipado/Subsidiadas rate tables (empirically proved with a
  concrete example: R$100.000/36x/R$4.485,75 real Linear payment, table
  rate 2,15% a.m. vs. the calculator's own 2,58%/2,86%). Automatic
  commercial-table matching was deliberately not built.
- **Voice Accent human decision**: `pt_br_warm`/speed `1.25` are wired
  as the current *technical* default only. The commit that wired them
  says explicitly no human listened and chose a winner. This phase does
  not choose one either — preserved as pending.

## 17. Generic core vs. Brabus-specific configuration (Gate 36)

**Generic core**: the tool-dispatcher pattern (explicit registry, no
arbitrary RPC/SQL execution), the deterministic-engine-computes/
model-never-invents-numbers discipline, the MASTER-gate structure
(server-side DB lookup, never client-trusted), the stateless
conversation-array memory model, the `iniciar_novo_cliente`
splice-based reset mechanism.

**Brabus-specific configuration** (hardcoded, not abstracted):
`CASH_CONVERSION_APPLICATION_RATE = 0.0112`, `BALAO_MAX_COUNT`
(NOVOS:4/SEMINOVOS:2), the Score weight tables and eligible-seller
exclusion list, Taxa Implícita's fee assumptions, store names, and
"Brabus"/"Grupo Brabus"/"Mitsubishi" branding strings scattered through
prompt text and UI copy. No generic/multi-tenant seam exists today —
not addressed this phase (Gate 36 explicitly defers productization).

**Hardcoded debt**: the same list above — every business constant lives
as a literal inside `portal-ai-homolog/index.ts`, not in a separate
config layer.

## 18. Test baseline

| Test Area | Before this phase | After this phase | Result |
|---|---|---|---|
| Financial engine determinism (Cash Conversion rate, override rejection, Antecipação default date, Balão caps) | No executable test existed anywhere in the repo (self-reported commit-message claims only) | `tests/ia-reconciliation/financial-engine.test.mjs`, 11/11, extracts and runs the REAL current source | NEW, PASS |
| Antecipação structured date rendering | Confirmed broken by direct code inspection (RECOVERY-01 + re-confirmed this phase) | Fixed (adopted from `uat-serve`'s independent fix); `frontend-format.test.mjs`, 7/7 | NEW, PASS |
| Tool registry / security gate / scenario-memory structure | No executable test existed | `structural.test.mjs`, 15/15 | NEW, PASS |
| Score replica vs. current production `score.html` | Self-reported (70/70, dated) | Re-verified this phase: `e2eeff3` still ancestor of `origin/main`, `modules/score.html` 0 diff since | RE-VERIFIED, PASS |
| `portal-ai-homolog` TypeScript syntax validity | Never checked against a real parser (Deno unavailable throughout) | Verified via Node 24's native TS parser (full-file import reaches module resolution, not a syntax error) | NEW, PASS |
| Existing Deno/Playwright-based historical tests (EVAL.md 30 questions, "26/26"/"29 scenarios"/"15/15" claims in commit messages) | Self-reported, tier-4 evidence, never independently re-run | Not re-run this phase (Deno/Supabase CLI unavailable in this environment — same constraint IA-2A's own report disclosed) | UNCHANGED — still self-reported only |

Total new deterministic tests this phase: **33/33 passing** (11 + 7 + 15).

## 19. Remaining UAT requirements

Everything in this document is a **local, evidence-backed technical
reconciliation**, not an approval. Required before any further step:

1. Human review of this ledger and the reconciled `portal-ai-homolog`
   source (business-rule correctness, prompt tone, security posture).
2. A real Deno/Supabase-bundler pass (unavailable in this environment)
   to confirm actual deployability, beyond this phase's Node-based
   syntax-validity check.
3. A human decision on the Voice Accent A/B question (§16).
4. A human decision on the Balão placement limitation (§16).
5. Only after (1)–(4): Portal V2 integration planning (explicitly out
   of scope for this phase, per Gate 37).

## 20. IA-UAT-01 Appendix — technical + functional homologation

This appendix records what changed and what was newly proven in
IA-UAT-01, moving the candidate from `RECONCILED_LOCAL_CANDIDATE`
toward `HOMOLOG_READY_LOCAL`. It does not rewrite the provenance
history above — §1–§19 remain the IA-RECON-01 record as written.

### 20.1 Toolchain discovery

Neither Deno nor the Supabase CLI is globally installed in this
environment (no admin rights), but both run cleanly with no
installation step via `npx --yes deno ...` / `npx --yes supabase ...`
(local, temporary, no login/link/deploy — within Gate 3's explicit
allowance). Versions resolved: **Deno 2.9.6**, **Supabase CLI
2.116.0**. `supabase functions serve` (the strongest tier — real HTTP
execution against the Edge Runtime) needs Docker, which is **not
installed** here — disclosed as `ENVIRONMENT_BLOCKED`, distinct from a
source defect.

### 20.2 Build validation (new, real `deno check`)

IA-RECON-01 only confirmed the 3 homolog functions were valid enough
for Node 24 to `import()` (type-stripping only — Node does not
type-check). This phase ran real `deno check` (genuine TypeScript
type-checking) against all three:

| File | `deno check` before fixes | `deno check` after fixes |
|---|---|---|
| `portal-ai-homolog/index.ts` | 7 errors (all non-null-assertion omissions) | **0 errors** |
| `portal-voice-homolog/index.ts` | 0 errors | 0 errors |
| `portal-realtime-homolog/index.ts` | 0 errors | 0 errors |

All 7 errors were the same shape: a field typed `T | undefined` on the
tool-args interface, used at a call site alongside 4–5 sibling call
sites in the same function that already correctly asserted it
non-null with `!`. Each was traced against its siblings before fixing.
Fixed with a bare `!` non-null assertion (compile-time-only, erased at
runtime, zero behavioral effect — a TypeScript language guarantee, not
an assumption) at 7 call sites across `balaoRequiredDownPayment`,
`dispatchTool`'s entity/down-payment/balloon comparison branches. The
full pre-existing 26-test suite (financial-engine + structural) was
re-run unchanged after the fixes and stayed 26/26 — empirical
confirmation alongside the type-level guarantee.

### 20.3 Expanded executable tool validation (new)

IA-RECON-01 validated the tool **registry** (12 tools present,
dispatch wired) but not most tools' actual calculation behavior beyond
Cash Conversion/Antecipação/Balão-cap. This phase adds direct
executable validation, against the real extracted source, with
synthetic (never customer) fixtures, for every tool whose calculation
core is a pure function reachable without a live RPC:

| Tool / area | Test file | Result |
|---|---|---|
| Coparticipado | `tool-coverage.test.mjs` | 8/8 |
| Taxas Subsidiadas | `tool-coverage.test.mjs` | 7/7 |
| Semestral / Anual | `tool-coverage.test.mjs` | 5/5 |
| Financiamento Linear (NOVOS + SEMINOVOS) | `linear.test.mjs` | 22/22 |
| Taxa Implícita (Descobridor de Taxa) | `taxa-implicita.test.mjs` | 15/15 |
| Scenario memory / `iniciar_novo_cliente` reset, turn-by-turn | `memory-reset.test.mjs` | 13/13 |
| TEXT/VOICE-01/Realtime channel contract | `channel-contract.test.mjs` | 31/31 |

Combined with the pre-existing `financial-engine.test.mjs` (11/11),
`structural.test.mjs` (15/15), and `frontend-format.test.mjs` (7/7):
**134/134 deterministic tests passing**, all against today's real
source, none hand-copied (per the extraction discipline in the file
header of `tests/ia-reconciliation/extract.mjs`).

Two tools remain validated only at the **registry/dispatch/schema**
level, not executed end-to-end, because their calculation path
requires a live Supabase RPC this phase does not call (Gate 30 — no
production reads):
- **Score** (`consultar_score_vendedores`) — the `calcScores()` replica
  itself was already re-verified byte-identical to production in
  IA-RECON-01 §8 (`e2eeff3` still an ancestor of `origin/main`, 0 diff
  on `modules/score.html`); this phase adds no new evidence beyond
  re-confirming that ancestry still holds.
- **Histórico** (`analisar_historico_financiamento`) — registry
  presence, dispatch wiring, and 0-parameter/parameter-schema shape
  confirmed via `structural.test.mjs`; the RPC-backed query/filter
  logic itself is not independently executed this phase.

This is an honest, disclosed boundary — not a claim that these two are
untested at every tier, and not a claim that they are as thoroughly
proven as the 7 tools executed directly above.

### 20.4 Security contract (Gate 28)

`channel-contract.test.mjs` extends §15's single-file check to all
three homolog functions: the identical MASTER-only gate (real
`usuarios` table DB lookup, 401/403 pattern, identical CORS allowlist)
is structurally confirmed present in `portal-ai-homolog`,
`portal-voice-homolog`, and `portal-realtime-homolog` alike — voice and
realtime never take an authorization shortcut. As in §15, this is
source-invariant proof (regex against the real file text); no live
HTTP request was sent against any deployed or local endpoint (Docker
unavailable, §20.1).

### 20.5 Channel classification (Gate 33)

Each channel is classified **separately** — there is no single global
readiness status:

| Channel | Classification | Basis |
|---|---|---|
| **TEXT** (`portal-ai-homolog`) | Structurally + functionally validated locally (134 executable tests, 0 `deno check` errors). Not validated at the HTTP/Edge-Runtime tier (Docker unavailable) or against real OpenAI traffic (forbidden this phase). | DIRECT — owns all 12 tools and every deterministic engine. |
| **VOICE-01** (`portal-voice-homolog`) | Structurally validated (security parity, 0-tools transport-only contract, `deno check` clean). Never executed at the HTTP tier. | VOICE_TRANSPORT_TO_TEXT — STT/TTS only, 0 financial tools by design; any data question still requires the transcribed text to be sent through the TEXT channel by the frontend. |
| **Realtime** (`portal-realtime-homolog`) | Structurally validated (security parity, exactly 1 proxy tool, instructions forbid answering from the model's own knowledge, `deno check` clean). Never executed at the HTTP/WebRTC tier. | VIA_TEXT_BRAIN — its one tool forwards to the same TEXT brain; no independent financial logic. |
| **Voice Studio** (lab mode inside `portal-realtime-homolog`) | Structurally confirmed isolated (0 tools, `tool_choice: "none"`, its own instruction set, never the production accent profile). | NOT_AVAILABLE as a customer-facing entry point — LAB ONLY by its own source comment, unchanged from IA-RECON-01. |

### 20.6 Remaining human UAT

See `docs/IA-HUMAN-UAT-01.md` (new this phase) for the concrete,
non-technical scenario checklist. Everything in §20.1–20.5 is
technical/automated evidence; none of it is a substitute for a human
running that checklist and recording HUMAN_UAT_APPROVED or specific
failures.

### 20.7 Remaining product decisions

Unchanged from §16 — this phase did not resolve, and was not asked to
resolve, the Balão placement convention or the Voice Accent A/B
choice. Both remain open, disclosed decisions, not defects.

### 20.8 Test baseline update

Total new/expanded deterministic tests this phase: **123** (20 + 22 +
15 + 13 + 31 + 22 net-new across `tool-coverage.test.mjs`/
`linear.test.mjs`/`taxa-implicita.test.mjs`/`memory-reset.test.mjs`/
`channel-contract.test.mjs`, with `tool-coverage.test.mjs`'s
Coparticipado 8 checks already counted in IA-RECON-01's original 33).
Combined with IA-RECON-01's 33: **134/134 passing**, 0 regressions.
One environment note: on this Windows/Node 24 setup,
`tool-coverage.test.mjs` and `linear.test.mjs` occasionally exit with
a non-zero code from a known Node.js libuv assertion
(`UV_HANDLE_CLOSING`, `src/win/async.c`) that fires **after** all
assertions have already printed and passed — a Node-on-Windows
process-teardown race unrelated to this code (both files also exited
cleanly with code 0 on other runs, same PASS output every time).
Treat the printed PASS/FAIL lines, not the process exit code alone, as
the result of record for these two files.

## 21. IA-3B — reconciliation onto a surgical `origin/main` base

Local branch `ia3b-intelligence-reconciliation` (worktree
`C:\Projetos\portal-financiamento-brabus-secure-ia3b`), based on
`origin/main` (`4d8ce1d`) — **not** on this branch, and **not** a
branch merge. Only the 7 authorized Intelligence files were brought in
via explicit `git checkout ia-reconciliation-v2-local -- <path>`
(`portal-ai-homolog/index.ts`, the 3 Voice/Realtime frontend files,
`portal-ai-ui.js`) plus the existing test harness/docs/kill-switch
migration — never a blind merge of this branch's other, unrelated
commits. `supabase/functions/portal-ai/index.ts` deliberately left
untouched (Gate 11) — this document's own Gate 10 claim about that file
is corrected below.

**Gate 10 correction (`IA_RECONCILIATION_LEDGER_PORTAL_AI_FROZEN_CLAIM_INACCURATE`,
LOW, documentation debt):** §5's original text and Gate 10 above state
`supabase/functions/portal-ai/index.ts` "stays exactly as `origin/main`
already has it (untouched, undeployed, frozen)." Direct measurement
(IA-3A.1) proved this false as a *provenance* claim: on **this
branch**, `portal-ai/index.ts` is 5,784 lines / 11 tools, not
`origin/main`'s 869 lines / 3 tools — it independently diverged through
the same feature history as `portal-ai-homolog`, before any
reconciliation phase touched anything. The corrected, accurate claim:
no commit in IA-RECON-01 or any later phase (IA-3B included) ever
writes to this file — Gate 10's actual *intent* (never touch it,
`portal-ai-homolog` is the forward authority) was honored correctly
throughout; only the "stays exactly as origin/main" *provenance*
sentence itself was never true and should not be repeated as evidence.

New this phase: `ia_voz_habilitada` kill switch added to
`portal-voice-homolog`/`portal-realtime-homolog` (same
`operational_portal_config()` pattern as `ia_texto_habilitada`,
default `FALSE`, fail-closed, checked before Voice Studio mode is even
read). Migration `20260905100000_ia_voz_kill_switch.sql` created, **not
applied**. `MANIFEST.md` corrected (deployment-status claim only, using
live-probe evidence — tool-count description left as-is since this
branch's `portal-ai` copy genuinely still has 3 tools) and extended
with rows for the 3 previously-undocumented `-homolog` functions.

## 22. IA-3C — operational security verification

Closed `PLATFORM_VERIFY_JWT_CONFIGURATION` fully via the Supabase
Management API (already authenticated in this environment — no Human
lookup needed):

| Function | Live version | Platform `verify_jwt` |
|---|---|---|
| `portal-ai` | v2 | `true` |
| `portal-ai-homolog` | **v36** | `false` |
| `portal-voice-homolog` | v3 | `false` |
| `portal-realtime-homolog` | v3 | `false` |

`OPENAI_API_KEY` existence reconfirmed live (name present; only a
one-way digest was ever returned by the CLI, never a usable value).
Provenance (dedicated vs. shared) searched across all git history and
docs — genuinely absent — escalated as the one Human checkpoint
(closed in §23 below).

Closed the IA-3B D1 debt: extended `tests/ai-uat-e2e/mock-backend.mjs`
with a controllable `operational_portal_config()` mock and added
`tests/ai-uat-e2e/kill-switch-e2e.mjs` — real HTTP-level proof, against
the real unmodified Deno processes, of the full kill-switch matrix for
all 3 functions (25/25), including the Voice Studio bypass check and
the Realtime long-lived-key/600s-TTL boundary. Found and fixed a real
staleness bug in `selftest-text.mjs` (written before the TEXT kill
switch existed, silently broken by it, 12/37 → 37/37 after an explicit
mock-config fix). **215/215 tests green this wave, 0 regressions, 0
production function code changed.**

**`MASTER_RUNTIME_503` correction:** IA-3C's own report classified this
historical debt `RESOLVED`, interpreting it as the kill switches' own
intended fail-closed default. **That inference was insufficiently
evidenced** — no occurrence of this exact label was ever found anywhere
in this repository's tracked history or docs (its origin is external to
this repo). Corrected classification:
`MASTER_RUNTIME_503_ORIGINAL_INCIDENT_INSUFFICIENT_EVIDENCE` — open/
unproven, not claimed resolved, until a controlled real runtime test
against the real project specifically reproduces and explains it.

**Recommendation, not applied:** enable `verify_jwt=true` on the 3
homolog functions before Human production UAT (mirrors `portal-ai`'s
own already-`true` setting) — carried as
`HOMOLOG_PLATFORM_VERIFY_JWT_HARDENING_PENDING`.

## 23. IA-3C.1 — Human secret-provenance evidence

Human inspected the OpenAI Platform directly (no key value, prefix, or
credential shared) and found **two active, environment-specifically-named
API keys**: one labeled for Production, one labeled for Homologação.

**Classification: `OPENAI_INTELLIGENCE_KEYS_ENVIRONMENT_SEPARATED_HUMAN_CONFIRMED`**
— intentional Production/Homologation credential separation is
confirmed at the OpenAI Platform level.

This does **not** by itself prove which of the two keys is the one
currently stored in Supabase as `OPENAI_API_KEY` — no metadata links
the two systems together automatically. **Do not claim**
`CURRENT_SUPABASE_OPENAI_KEY_IS_HOMOLOGATION_KEY`.

**Classification: `CURRENT_SUPABASE_OPENAI_KEY_ENVIRONMENT_BINDING_UNPROVEN`**
— a narrow, disclosed operational debt. Before any eventual
activation/real-OpenAI-traffic wave, the environment binding must be
independently proven (e.g. a controlled, disclosed test call whose
response metadata identifies which OpenAI project served it) or the
key intentionally reset to the correct environment-specific credential.
No secret-value work was performed to reach this classification, and
none is needed to close it later — it is a binding-proof question, not
a rotation question.

This does not block IA-3D, which performs no OpenAI activation.

## 24. IA-3D — governed semantic tool-policy foundation

New file `supabase/functions/portal-ai-homolog/tool-policy.ts` — a
deny-by-default authorization module for all 12 real tools, built from
directly-read evidence (the real `TOOLS` array, the real, already
cross-profile-tested `public.operational_current_scope()`, and the
real `public.modulos_portal`/`permissoes_modulos` catalog — see
`docs/IA-3D-TOOL-POLICY.md` for the full design and activation plan).
**Foundation only** — not imported by `index.ts`, zero effect on the
live function; the existing global MASTER-only gate remains the sole
live authorization boundary. 79/79 new synthetic/adversarial tests
pass, 0 real Supabase project or OpenAI traffic touched, 0 non-MASTER
profile ever activated live.

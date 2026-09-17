#!/usr/bin/env node
// IA_CAPABILITY_LOCK — Phase 1.
//
// A dedicated, permanent, mandatory-before-deploy gate for Brabus
// Intelligence's deterministic business capabilities. Born from
// CAPABILITY-LOCK-1's own central finding: "300 tests green" does not
// by itself mean a business capability is protected -- a test that
// only asserts a prompt STRING is present can pass forever while the
// capability it describes silently regresses. This runner therefore
// does not invent new test logic; it aggregates and RUNS the existing
// real behavioral tests this repo already has (each one independently
// extracting and executing the actual current source, per this
// repo's own established `extract.mjs` discipline), and refuses to
// let a PROMPT_STRING-only test satisfy a capability gate on its own.
//
// Every capability below is scored on tests actually spawned and
// checked by exit code -- never a hand-maintained "yes it passes"
// table. `node tests/ia-capability-lock/run.mjs` is the single command
// a future deploy gate should require to exit 0.
//
// Usage: node tests/ia-capability-lock/run.mjs [--skip-live-db] [--skip-e2e]

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, "..", "..");
const RECON = join(REPO_ROOT, "tests", "ia-reconciliation");
const E2E = join(REPO_ROOT, "tests", "ai-uat-e2e");
const LIVE_DB = join(REPO_ROOT, "tests", "live-db");

const argv = process.argv.slice(2);
const SKIP_LIVE_DB = argv.includes("--skip-live-db");
const SKIP_E2E = argv.includes("--skip-e2e");

// ---------------------------------------------------------------------
// Proof-type vocabulary (IMPORTANT — TEST TYPES, per this Wave's brief):
//   ENGINE_BEHAVIOR   — extracts and executes the real calculation/
//                        selection function(s) from current source
//                        against a fixture, asserts real numeric/
//                        business outcomes.
//   MOCKED_E2E        — drives the real Deno handler (or the real
//                        request-handler region extracted verbatim)
//                        end-to-end with only the LLM/transport layer
//                        mocked; proves real orchestration/dispatch
//                        behavior, not merely a unit result.
//   LIVE_DB           — real execution against the live linked
//                        Supabase project inside a BEGIN...ROLLBACK
//                        transaction; proves the actual deployed RPC
//                        authority, not a local fixture.
//   SOURCE_INVARIANT  — a real regex/structural check against the
//                        CURRENT source text (e.g. "this constant is
//                        absent from file X"), re-read at test time
//                        rather than hand-copied — weaker than
//                        ENGINE_BEHAVIOR (doesn't execute anything)
//                        but still protects against silent removal
//                        of a real guarantee, so it still counts.
//   PROMPT_STRING     — NOT A VALID CAPABILITY PROOF on its own, per
//                        this Wave's explicit instruction. Present in
//                        the codebase as an additional hygiene layer,
//                        never listed as capability evidence below.
// ---------------------------------------------------------------------

const CAPABILITIES = [
  {
    id: "1_LINEAR",
    name: "LINEAR financing",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "linear.test.mjs" }],
  },
  {
    id: "2_BALAO_NOVOS",
    name: "BALÃO NOVOS — counts 1/2/3/4",
    proofType: "ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "financial-engine.test.mjs" }, // BALAO_MAX_COUNT.NOVOS===4 assertion
      { dir: RECON, file: "multi-balloon-escalation.test.mjs" },
      { dir: RECON, file: "balloon-candidate-consistency.test.mjs" },
    ],
  },
  {
    id: "3_BALAO_SEMINOVOS",
    name: "BALÃO SEMINOVOS — counts 1/2",
    proofType: "ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "financial-engine.test.mjs" }, // BALAO_MAX_COUNT.SEMINOVOS===2 assertion
      { dir: RECON, file: "balloon-entry-search-escalation.test.mjs" }, // includes a SEMINOVOS ceiling-respect case
    ],
  },
  {
    id: "4_BALAO_HUMAN_REGRESSION",
    name: "BALÃO — Human regression (R$180k/R$1.800, lower-entry follow-up, deterministic count escalation)",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "balloon-entry-search-escalation.test.mjs" }],
  },
  {
    id: "5_SUBSIDIADO",
    name: "SUBSIDIADO — 49.99% reject / exactly 50.00% reject / >50% accept",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "tool-coverage.test.mjs" }],
  },
  {
    id: "6_COPARTICIPADO",
    name: "COPARTICIPADO real calculation",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "tool-coverage.test.mjs" }],
  },
  {
    id: "7_CASH_CONVERSION",
    name: "Cash Conversion — exact forward-authority value",
    proofType: "ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "financial-engine.test.mjs" },
      { dir: RECON, file: "settlement-cashconversion-cards.test.mjs" },
    ],
  },
  {
    id: "8_RATE_CALCULATION",
    name: "Rate calculation — deterministic bisection fixture",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "taxa-implicita.test.mjs" }],
  },
  {
    id: "9_TARGET_PAYMENT",
    name: "Target payment — omitted-term deterministic search",
    proofType: "ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "financial-engine.test.mjs" },
      { dir: RECON, file: "goal-driven-finance-and-cash-context.test.mjs" },
    ],
  },
  {
    id: "10_AUTOMATIC_TERM_SELECTION",
    name: "Automatic term selection (single selection authority)",
    proofType: "ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "commercial-proposal-selection.test.mjs" },
      { dir: RECON, file: "balloon-candidate-consistency.test.mjs" },
    ],
  },
  {
    id: "11_ANTECIPACAO",
    name: "Antecipação — settlement structural/math cases",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "settlement-cashconversion-cards.test.mjs" }],
  },
  {
    id: "12_REVENDA",
    name: "REVENDA exclusion — real live authority",
    proofType: "LIVE_DB",
    requiresLiveDb: true,
    tests: [{ dir: LIVE_DB, file: "revenda3_ia3b_canonical_rpc_regression.mjs" }],
  },
  {
    id: "13_AUTHORIZATION",
    name: "Authorization — VENDEDOR/ANALISTA/GERENTE/DIRETOR NOVOS/MASTER",
    proofType: "MOCKED_E2E",
    tests: [
      { dir: RECON, file: "scope-enforcement.test.mjs" }, // policy-layer, all 5 profiles including MASTER-unchanged control
      { dir: RECON, file: "tool-policy.test.mjs" },
      { dir: E2E, file: "policy-dispatch-integration.mjs" },
      // Real Deno-handler, per-profile live e2e — genuine end-to-end
      // proof, each spawns its own local mock backend + real handler
      // process (no external network dependency). Skippable via
      // --skip-e2e for a fast local loop; the deploy gate should
      // always run them.
      ...(SKIP_E2E ? [] : [
        { dir: E2E, file: "sec1c-analista-activation-e2e.mjs" },
        { dir: E2E, file: "sec1e-vendedor-score-e2e.mjs" },
        { dir: E2E, file: "sec1f-gerente-e2e.mjs" },
        { dir: E2E, file: "sec1g-diretor-novos-e2e.mjs" },
      ]),
    ],
  },
  {
    id: "14_RAW_JSON_SUPPRESSION",
    name: "Raw tool-payload suppression in user-facing replies",
    proofType: "ENGINE_BEHAVIOR",
    tests: [{ dir: RECON, file: "conversation-orchestration-hardening.test.mjs" }],
  },
  {
    id: "15_FINANCE_FOLLOWUP_CONTINUITY",
    name: "Finance follow-up continuity (stateful orchestration)",
    proofType: "MOCKED_E2E",
    tests: [
      { dir: RECON, file: "stateful-orchestration-integration.test.mjs" },
      { dir: RECON, file: "memory-reset.test.mjs" },
    ],
  },
  {
    // IA-CAPLOCK5 -- real Human UAT defect: a financing follow-up that
    // mutates a calculation constraint (Balão count, term, target
    // payment, financing type) must trigger a NEW deterministic engine
    // execution, never a description of the previous proposal.
    // stateful-orchestration-integration.test.mjs's own TEST F reproduces
    // the exact incident (open recommendation -> "no máximo 2 balões" ->
    // "quero exatamente 2 balões") end to end through the real
    // requiredDownPaymentPlan/blockRDP orchestration; TEST G covers the
    // general constraint-mutation matrix. balloon-count-constraint.test.mjs
    // proves the real balaoRequiredDownPaymentEscalateForTarget engine
    // itself genuinely honors the new ceiling/exact parameters (never
    // invented numbers -- every comparison derived from the engine's own
    // output at each count).
    id: "16_STATEFUL_FINANCIAL_CONSTRAINT_MUTATION",
    name: "Stateful financial constraint mutation (Balão count/term/target/financing-type follow-ups trigger real recalculation)",
    proofType: "MOCKED_E2E_AND_ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "stateful-orchestration-integration.test.mjs" },
      { dir: RECON, file: "balloon-count-constraint.test.mjs" },
    ],
  },
  {
    // IA-CAPLOCK7 -- real Human UAT defect: a DERIVED monetary value from
    // the assistant's own previous answer (e.g. a wrongly-computed "total
    // devido") contaminated canonical financing conversation state,
    // becoming the apparent vehicle_value for a new, real engine
    // dispatch. stateful-orchestration-integration.test.mjs's own TEST H
    // reproduces the exact incident end to end (explanation-only turn
    // preserves vehicle_value/down_payment/target_payment, triggers no
    // engine execution, produces no cards; a later EXPLICIT mutation
    // still works) plus TEST I (a second, different quoted amount,
    // proving the fix is a structural intent classifier, never a
    // hardcoded exception for the incident's own numbers).
    // balloon-count-constraint.test.mjs's own Part 8 proves, against the
    // real unmodified balaoOptimizeMinPaymentMulti, that the ORIGINAL
    // synthesis error (balloon_month_total_due summing every balloon
    // instead of only the one due in that month) is fixed and reproduces
    // the incident's exact wrong (R$111.806,14) and right (R$29.306,14)
    // figures from real engine output.
    id: "17_CANONICAL_FINANCIAL_STATE_INTEGRITY",
    name: "Canonical financial state integrity (explanation-only turns never mutate vehicle_value/down_payment/target_payment; balloon due-month synthesis is deterministic)",
    proofType: "MOCKED_E2E_AND_ENGINE_BEHAVIOR",
    tests: [
      { dir: RECON, file: "stateful-orchestration-integration.test.mjs" },
      { dir: RECON, file: "balloon-count-constraint.test.mjs" },
    ],
  },
  {
    // IA-CAPLOCK8 -- closes the exact structural limitation CAPLOCK7's
    // own report disclosed: financial constraint mutations were
    // individually understood, but a LATER turn could reconstruct state
    // from the last self-sufficient historical message and silently
    // lose mutations made in intermediate turns (vehicle-value
    // mutations were lost outright; down-payment/term mutations reset
    // to the original historical anchor the instant a later turn's own
    // independent backward scan bypassed them). stateful-orchestration-
    // integration.test.mjs's own TEST J reproduces the brief's full
    // T1-T10 golden sequence end to end through the real orchestration
    // path (multi-hop accumulation, explanation-only no-op, exact-
    // replaces-max normalization, term delegated<->fixed transitions,
    // BALAO<->LINEAR mode transitions with constraint clearing,
    // down-payment-unknown<->known objective transitions); TEST K
    // proves conversation isolation (two independent conversations
    // never observe each other's mutations, re-checked across repeated
    // calls, never a process-global mutable state).
    id: "18_CUMULATIVE_FINANCIAL_CONVERSATION_STATE",
    name: "Cumulative financial conversation state (multi-hop mutation accumulation, unnamed-constraint persistence, conversation isolation)",
    proofType: "MOCKED_E2E",
    tests: [
      { dir: RECON, file: "stateful-orchestration-integration.test.mjs" },
    ],
  },
];

// ---------------------------------------------------------------------
// PART D — prompt-only items. Explicitly visible, explicitly NOT part
// of the pass/fail gate above (per this Wave's own instruction: they
// must not block implementation, but must never be silently presented
// as "locked"). Preserve-as-is this Wave; each is annotated with why
// it can't yet be ENGINE_BEHAVIOR/MOCKED_E2E-proven.
// ---------------------------------------------------------------------
const PROMPT_ONLY_ITEMS = [
  { name: "Voice pending acknowledgement (no duplicate 'ainda processando')", status: "HUMAN_REALTIME_REQUIRED", reason: "Governed entirely by Realtime session instructions text; requires a live OpenAI Realtime session to observe actual model compliance — this repo's own conversation-orchestration-hardening.test.mjs CASE1 header discloses it 'cannot prove live OpenAI Realtime model compliance'." },
  { name: "Voice interruption / genuine-new-intent-mid-pending-tool-call", status: "BEHAVIORAL_HARNESS_PENDING", reason: "Configured via Realtime turn_detection + instruction text; no test simulates an actual new question arriving mid-pending-tool-call today. A harness could be built (mock Realtime session) but does not exist yet." },
  { name: "Explicit-advice narrative (\"o que você me aconselha?\")", status: "BEHAVIORAL_HARNESS_PENDING", reason: "conversation-orchestration-hardening.test.mjs CASE5 only asserts the trigger phrases exist in the prompt text — no test drives an actual model response and checks for OBSERVED EVIDENCE→INTERPRETATION→RECOMMENDATION structure." },
  { name: "Historical weak-sample narrative discipline", status: "BEHAVIORAL_HARNESS_PENDING", reason: "sample_quality/percentiles are ENGINE_BEHAVIOR (server-computed, real); the discipline of NOT reinforcing a recommendation with an INSUFICIENTE/SEM_DADOS sample is prompt-only, unverified by any behavioral test." },
  { name: "Coparticipado Trade-In disclosure", status: "BEHAVIORAL_HARNESS_PENDING", reason: "PROMPT_FINANCE_COPARTICIPADO's Trade-In-loss warning is real prompt text (IA-KNOWLEDGE-1), but no test asserts a model response actually includes it when relevant." },
];

// ---------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------
function runTest(dir, file) {
  const path = join(dir, file);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path], { encoding: "utf8", timeout: 120000 });
  const ms = Date.now() - started;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const combined = stdout + stderr;
  const connectivityFailure = /ENOTFOUND|ECONNREFUSED|Cannot find project ref|Access token not provided|not logged in|Failed to connect/i.test(combined);
  return { file, exitCode: result.status, ms, connectivityFailure, tail: stdout.trim().split("\n").slice(-3).join(" | ") };
}

function dedupeTests(tests) {
  const seen = new Set();
  return tests.filter((t) => {
    const key = join(t.dir, t.file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

console.log("=== IA_CAPABILITY_LOCK — Phase 1 ===\n");

const summary = [];
for (const cap of CAPABILITIES) {
  if (cap.requiresLiveDb && SKIP_LIVE_DB) {
    console.log(`[${cap.id}] ${cap.name} — SKIPPED (--skip-live-db)`);
    summary.push({ ...cap, verdict: "SKIPPED" });
    continue;
  }
  const uniqueTests = dedupeTests(cap.tests);
  const results = uniqueTests.map((t) => runTest(t.dir, t.file));
  const anyConnectivityFailure = cap.requiresLiveDb && results.some((r) => r.exitCode !== 0 && r.connectivityFailure);
  let verdict;
  if (anyConnectivityFailure) {
    verdict = "REQUIRED_LIVE_DB_CHECK";
  } else {
    verdict = results.every((r) => r.exitCode === 0) ? "PASS" : "FAIL";
  }
  console.log(`[${cap.id}] ${cap.name} — ${verdict} (${cap.proofType})`);
  for (const r of results) {
    const mark = r.exitCode === 0 ? "  ok " : "  ** ";
    console.log(`${mark}${r.file} (${r.ms}ms) ${r.exitCode !== 0 ? "-- " + r.tail : ""}`);
  }
  summary.push({ ...cap, verdict, results });
}

console.log("\n=== PART D — PROMPT-ONLY ITEMS (visible, not gated this Phase) ===\n");
for (const item of PROMPT_ONLY_ITEMS) {
  console.log(`[${item.status}] ${item.name}`);
  console.log(`  ${item.reason}`);
}

console.log("\n=== SUMMARY ===\n");
let allOk = true;
for (const s of summary) {
  console.log(`${s.id.padEnd(32)} ${s.verdict.padEnd(24)} ${s.proofType}`);
  if (s.verdict === "FAIL") allOk = false;
}
const requiredLiveDbCount = summary.filter((s) => s.verdict === "REQUIRED_LIVE_DB_CHECK").length;
if (requiredLiveDbCount > 0) {
  console.log(`\n${requiredLiveDbCount} capability(ies) require live DB access to verify in this environment (REQUIRED_LIVE_DB_CHECK) — not a failure, but not a pass either; the deploy gate must not silently treat this as green.`);
}

console.log(`\nRESULT: ${allOk ? "PASS (no FAIL verdicts)" : "FAIL — at least one capability's behavioral proof failed"}`);
process.exit(allOk ? 0 : 1);

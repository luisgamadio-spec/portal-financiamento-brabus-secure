# Brabus F&I Intelligence — Automated End-to-End UAT Evidence (IA-UAT-02)

Branch `ia-reconciliation-v2-local`. Local homolog candidate only —
zero deploy, zero production mutation. This document records what was
actually *executed* (real browser, real frontend, real Edge Function
source, real financial engine) versus what remains
`HUMAN_LISTENING_PENDING`/`ENVIRONMENT_BLOCKED`.

## 1. Runtime architecture used

```
Chromium (Playwright)
   │  http://127.0.0.1:8080/index.html  (real, unmodified frontend)
   ▼
tests/ai-uat-e2e/mock-backend.mjs (Node, port 8080)
   ├─ serves the real static frontend files (same origin as the API,
   │  required so the page's own CSP `connect-src 'self' ...` allows
   │  the calls without weakening that CSP)
   ├─ mocks Supabase Auth (/auth/v1/*) and PostgREST/RPC (/rest/v1/*)
   │  with synthetic, disclosed fixtures (Gate 30 — never real data)
   ├─ mocks OpenAI (/openai/v1/responses, /audio/*, /realtime/*) with
   │  a scripted "model" that only ever DECIDES which tool to call for
   │  a known test prompt and narrates the tool's own JSON result back
   │  — it never computes a financial number itself
   └─ reverse-proxies /functions/v1/<name> to the 3 REAL Deno processes:
        portal-ai-homolog        → 127.0.0.1:8801 (unmodified source)
        portal-voice-homolog     → 127.0.0.1:8802 (unmodified source)
        portal-realtime-homolog  → 127.0.0.1:8803 (unmodified source)
```

Each Deno process runs the **actual, unmodified** `index.ts` from
`supabase/functions/<name>/`. Two harness techniques redirect only the
external network boundary, never the source itself:

- `tests/ai-uat-e2e/deno/import_map.json` redirects portal-ai-homolog's
  own `import { serve } from ".../std@0.168.0/http/server.ts"` to a
  local shim (`shim-http-server.ts`) that binds to a harness-chosen
  port instead of std's hardcoded default — so all 3 functions can run
  side by side without a port collision.
- `tests/ai-uat-e2e/deno/fetch-patch.ts` monkey-patches the global
  `fetch` so any call to `https://api.openai.com/*` is transparently
  rewritten to hit the mock backend's `/openai/*` routes instead (the
  real source still calls the exact same OpenAI URLs it calls in
  production — it has no idea it's being redirected), and wraps
  `Deno.serve` the same way for portal-voice-homolog/
  portal-realtime-homolog (which call it directly, no options).

Supabase URLs need no patching at all — `SUPABASE_URL` is simply set
to the mock backend's own origin via the same env var the real
deployed function reads.

**UAT classification: `DETERMINISTIC_MODEL_BOUNDARY_E2E`**, not
`REAL_MODEL_E2E` — no real, paid OpenAI traffic was used (forbidden
this phase). Everything downstream of "which tool got called with
which arguments" — the financial engine, `dispatchTool`, structured
block builders, the frontend's rendering — is 100% real, unmodified
source under test.

## 2. Browser environment

- Playwright 1.62.1 (npm), Chromium (Playwright's bundled Chrome for
  Testing 151.0.7922.34), installed locally this phase, headless.
- Desktop viewport: 1366×768. Mobile viewport: 390×844.
- Login: real `signInWithPassword` flow through the real
  `#loginForm`, against the mock Auth endpoint (issues a fixed MASTER
  session for `uat-master@local.test`).
- `assets/js/portal-runtime-config.local.js` (gitignored, never
  committed — see `.gitignore`) is the project's own pre-existing
  local-dev convention (`portal-runtime-config.example.js`), pointed
  at the mock backend's same-origin URL with `aiAssistantEnabled:
  true`.

## 3. Scenario matrix (desktop, 1366×768)

All 14 scenarios ran through the **real AI drawer UI** — typed into
the real `#brabusAiInput`, sent via the real `#brabusAiSendBtn`, read
back from the real rendered `.brabusAiBubble`/`.brabusAiBlockPanel`
DOM. Screenshots in `tests/screenshots/ia-uat-02/` (19 total).

| # | Scenario | Input (excerpt) | Real tool dispatched | Structured block rendered | Result |
|---|---|---|---|---|---|
| 1 | Basic TEXT question | "Qual foi o resultado do mês passado?" | `consultar_resultado` | Grupo — mês anterior (vendas, financiamentos, share, produção...) | PASS |
| 2 | Financiamento Linear | R$120.000, entrada 30.000, 36x | `simular_financiamento` | Valor R$120.000,00 / Entrada R$30.000,00 (25%) / Financiado R$90.000,00 / **Parcela 36x R$4.010,97** | PASS |
| 3 | Balão | R$150.000, balão R$40.000, entrada 30.000, 36x | `simular_financiamento` (BALAO) | Balão structured block, balloon amount preserved | PASS |
| 4 | Coparticipado | L200 Triton, R$200.000/120.000/24x | `simular_financiamento` (COPARTICIPADO) | Coparticipado block with rebate breakdown | PASS |
| 5 | Taxas Subsidiadas | R$90.000, entrada R$50.000 | `simular_financiamento` (TAXAS_SUBSIDIADAS) | Options block, term-by-term | PASS |
| 6 | Taxa Implícita | R$100.000, 36x R$4.485,75 | `calcular_taxa_financiamento` | NET/CET/annual-derived block | PASS |
| 7 | Antecipação, no due date | saldo R$50.000 | `simular_antecipacao` | `first_due_date` rendered as a real date (today+30d), `first_due_date_assumed:true` | PASS |
| 8 | Cash Conversion basic | R$50.000 à vista vs. financiar 12x | `simular_cash_conversion` | Official 1,12% a.m. shown | PASS |
| 9 | Cash Conversion custom rate | "e se fosse 2% ao mês?" | `simular_cash_conversion` | Block explicitly labels the rate row **"PREMISSA PADRÃO FIXA, NÃO A TAXA SUGERIDA"** at 1,1% — the 2% request is tracked (`requested_rate`) but never enters the calculation | PASS |
| 10 | Multi-turn follow-up | "E se fosse 48 meses em vez de 36?" (no vehicle value restated) | `simular_financiamento` | Reused `vehicle_value:120000` from turn 1, `term_months:48` — confirmed via block content check | PASS |
| 11 | Negative/ineligible | R$50.000, entrada R$10.000 (20%, below 50% floor) | `simular_financiamento` | `"valid":false`, `"message":"A entrada mínima permitida para esta modalidade é de 50%."` — no fabricated payment | PASS |
| 12 | Novo Cliente reset | "Beleza, agora é outro cliente, esquece esse" | `iniciar_novo_cliente` | `scenario_reset:true`; follow-up "qual era o valor do veículo?" no longer echoes R$120.000 | PASS |
| 13 | Error handling | simulated OpenAI 500 | (upstream failure) | Clean error bubble: *"Não foi possível concluir a análise agora. Tente novamente."* — no stack trace, no secret leaked | PASS |
| 14 | Mobile pass | same basic question, 390×844 | `consultar_resultado` | Rendered correctly, `document.scrollWidth - clientWidth = 0` | PASS |

**Financial UI parity (Gate 30)**: for every scenario, the number
shown in the drawer's structured block is read directly from the same
`tool_result` JSON the real engine returned (verified both via the
harness's own `_homolog_debug` field, captured at the HTTP level for
every scenario in `tests/ai-uat-e2e/selftest-text.mjs`'s run, and
visually in the screenshots) — the frontend performs no recalculation
anywhere in this run.

**No hallucinated numbers (Gate 31)**: 0. Every material number
narrated by the mock model is a literal readback of the real
`tool_result` — the mock model is structurally incapable of
calculating (see `MODEL_SCRIPT` in `mock-backend.mjs`: it only selects
a tool name + args, or echoes JSON it's handed).

## 4. Findings

### 4.1 Audio autoplay blocked by the page's own CSP (disclosed, not fixed)

Every assistant reply triggers an automatic TTS autoplay attempt
(`portal-ai-ui.js`). The synthesized audio is played from a `blob:`
URL, but index.html's CSP has no `media-src` directive, so
`default-src 'self'` applies — and `blob:` is not same-origin under
CSP source matching. Every autoplay attempt across all 14 scenarios
was blocked by the browser with:

> Loading media from 'blob:...' violates the following Content
> Security Policy directive: "default-src 'self'"...

This reproduces **regardless of mock vs. real production backend** —
it is a genuine, disclosed frontend gap, not a harness artifact. Per
Gate 32, a CSP change is a security-relevant surface and was **not**
unilaterally fixed this phase — reported for a human decision (a
narrow `media-src 'self' blob:` addition would resolve it, but that
judgment belongs to a human reviewer, not this automated pass).
Text/structured-block rendering is completely unaffected — the drawer
shows the correct reply either way, only spoken playback silently
fails (surfaces to the user as "🔇 Áudio indisponível").

### 4.2 Fixed: AI input textarea had no accessible name (PRESENTATION_DEFECT, authorized fix)

`#brabusAiInput` had only a `placeholder`, no `aria-label`/`<label>` —
a placeholder is not a reliable accessible name (it disappears on
input and many screen readers don't announce it as a label). Every
other control in the drawer (`expand`, `close`, `mic`,
`mic-cancel`) already had a proper `aria-label`; this was the one gap.

**Fix applied** (`assets/js/portal-ai-ui.js`, one line): added
`aria-label="Pergunta para a Brabus F&I Intelligence"` to the
textarea. Zero behavioral change — confirmed by re-running the full
14-scenario Playwright suite (still 14/14) and the full 134-test
IA-UAT-01 baseline (still 134/134) after the change.

### 4.3 No other console errors, no other network errors

Across all 14 scenarios and both viewports: 0 unexplained console
errors, 0 unexplained network errors (the one 502 in scenario 13 is
the deliberately-triggered failure under test). 0 mobile horizontal
overflow.

## 5. Security (Gate 28 — HTTP-level, not browser-driven)

Run directly against the real Deno processes via
`tests/ai-uat-e2e/selftest-text.mjs` and a companion inline check
against portal-voice-homolog/portal-realtime-homolog:

| Path | Result |
|---|---|
| TEXT: no/invalid bearer token | 401 |
| TEXT: authenticated, non-MASTER caller | 403 |
| VOICE-01: no bearer token | 401 |
| Realtime: no bearer token | 401 |

Same MASTER-only gate, same 401/403 pattern, across all 3 functions —
consistent with IA-UAT-01 §20.4's structural finding, now also proven
with a live, executed request (not only a regex over the source text).

## 6. VOICE-01 / Realtime functional automation (Gates 23-24)

Executed live against the real Deno processes (not browser-driven —
WebRTC/microphone capture is not automatable without a real audio
device and is `HUMAN_LISTENING_PENDING` regardless of environment):

- `POST /functions/v1/portal-voice-homolog?action=transcribe` → 200,
  `{"text": "..."}` (synthetic audio fixture, STT boundary mocked).
- `POST /functions/v1/portal-voice-homolog?action=speak` → 200, binary
  `audio/mpeg` response.
- `POST /functions/v1/portal-realtime-homolog` → 200, mint response
  with `model:"gpt-realtime-2.1"`, `voice:"marin"`, `speed:1.25`,
  `accent_profile_applied:true` — matching the documented human-chosen
  defaults exactly.

**Classification: `FUNCTIONAL_AUTOMATION_PASS`** for the REST contract
layer of both channels (session/credential/transport lifecycle,
security gate, config defaults). The actual WebRTC audio session and
any judgment of voice quality/naturalness remain
`HUMAN_LISTENING_PENDING` — genuinely not automatable without a real
microphone/speaker and a human ear.

## 7. Automation coverage summary

| Category | Status |
|---|---|
| TEXT functional UAT | PASS (14/14 browser scenarios, 37/37 HTTP-level) |
| Financial engine/UI parity | PASS |
| Multi-turn | PASS |
| Novo Cliente | PASS |
| Security | PASS (structural + live HTTP) |
| Mobile | PASS (0 horizontal overflow) |
| VOICE-01 functional automation | PASS (REST layer); audio quality HUMAN_LISTENING_PENDING |
| Realtime functional automation | PASS (REST layer); WebRTC session/barge-in HUMAN_REQUIRED |
| Accessibility smoke | 1 gap found and fixed (input aria-label); no redesign |
| No hallucinated numbers | 0 found |

## 8. What remains genuinely human-only

- Voice Accent naturalness/preference (`pt_br_warm` vs. alternatives) — subjective listening.
- Realtime barge-in "feel" during a real spoken conversation.
- Business-tone/wording judgment on the negative-truth scenario's exact phrasing (the engine's refusal is proven correct; whether the language "sounds right" to a seller is a human call).
- Anything requiring real production OpenAI traffic or real customer data (out of scope this phase by design).

## 9. Portal V2 integration readiness (Gate 40)

TEXT functional UAT passes, financial engine/UI parity passes,
multi-turn passes, Novo Cliente passes, no security defect was found,
and the only open items are the disclosed CSP/audio finding (frontend,
non-financial) and genuinely subjective voice items.

**Ready For Portal V2 Integration Planning: YES** — planning only, not
implementation, per Gate 40's own scope limit.

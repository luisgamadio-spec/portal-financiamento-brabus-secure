# Brabus F&I Intelligence — Human UAT Checklist (IA-UAT-01)

This is for a human MASTER user to run by hand, in a browser, against
the **local** reconciled candidate. It does not require any technical
knowledge — just follow each step, type what's shown, and compare what
you see to "Expected". Everything below can be done in one sitting.

**Before you start**: this checklist tests the reconciled *local*
candidate, not the live production Portal. Nothing here touches real
customer data or the production AI. If a step fails, write down
exactly what you typed and what you saw — that's all the detail
needed to report it.

---

### 1. Basic question (TEXT)

- **Do**: Open the AI assistant and type: `Qual foi o resultado do mês passado?`
- **Expect**: A direct answer about last month's result, with real
  numbers (not "não sei" or a generic non-answer).
- **FAIL if**: It answers with made-up numbers, refuses without
  reason, or the button/chat isn't there at all for your MASTER login.

### 2. Financiamento Linear

- **Do**: Type: `Simula um financiamento linear de um veículo novo de R$ 120.000, com R$ 30.000 de entrada, em 36 meses.`
- **Expect**: A single parcela (monthly payment) value for 36 months,
  presented clearly, with the down payment and financed amount shown.
- **FAIL if**: No number is given, the numbers look impossible (e.g.
  negative or zero payment), or it asks you to repeat information you
  already gave.

### 3. Balão

- **Do**: Type: `Simula um financiamento com balão de R$ 40.000 num veículo de R$ 150.000, entrada de R$ 20.000, em 36 meses.`
- **Expect**: A monthly payment plus a clear mention of the R$ 40.000
  balloon due at the end.
- **FAIL if**: The balloon amount is silently dropped from the answer,
  or the payment shown ignores the balloon entirely.

### 4. Coparticipado / Taxas Subsidiadas

- **Do**: Type: `Quais as condições de Taxas Subsidiadas para um bem de R$ 90.000 com entrada de R$ 50.000?`
- **Expect**: Either a list of payment options by term, or a clear
  message that the entry is below the minimum required (if your test
  entry is under 50%).
- **FAIL if**: It gives a payment without ever mentioning a term
  (prazo), or the same answer for every input regardless of the
  numbers you gave.

### 5. Taxa Implícita (Descobridor de Taxa)

- **Do**: Type: `Um cliente financiou R$ 100.000 em 36x de R$ 4.485,75. Qual a taxa implícita desse contrato?`
- **Expect**: Two rates, clearly labeled as different things (one
  "NET" and one "CET" or similar wording) — not a single unlabeled
  number.
- **FAIL if**: Only one rate is shown with no explanation of which
  kind it is, or it claims this rate "is" the table rate for Linear
  (it is a different, independent calculation — the assistant should
  never say the two match).

### 6. Antecipação — no due date given

- **Do**: Type: `Quero simular a antecipação de um contrato com saldo de R$ 50.000, sem informar a data da próxima parcela.`
- **Expect**: It proceeds using a default first due date (roughly 30
  days from today) and says so, rather than refusing or leaving it
  blank.
- **FAIL if**: It crashes, shows a blank/garbled date, or silently
  uses a date that's clearly wrong (e.g. last year, or "01/01/1970").

### 7. Cash Conversion — cash vs. financing

- **Do**: Type: `Vale mais a pena o cliente pagar à vista R$ 50.000 ou financiar e deixar o dinheiro aplicado por 12 meses?`
- **Expect**: A side-by-side comparison with a final future value for
  the "keep it invested" option, using the bank's own official
  investment rate (do not need to know the exact number — just that a
  clear comparison with a conclusion is given).
- **FAIL if**: No comparison is made, or it just restates the question
  back to you.

### 8. Cash Conversion — customer asks for a different rate

- **Do**: In the same conversation, type: `E se a taxa de aplicação fosse 2% ao mês em vez da taxa oficial?`
- **Expect**: The assistant explains that the official rate is what's
  actually used for the real calculation, while still being able to
  tell you what a 2% scenario would look like AS A SEPARATE, clearly
  labeled "what-if" — never silently substituting 2% into the official
  numbers.
- **FAIL if**: It quietly recalculates the official comparison using
  2% without flagging that this isn't the real, approved rate.

### 9. Multi-turn context (same client)

- **Do**: After scenario 2 above (the R$120.000 Linear simulation),
  without starting over, type: `E se fosse em 48 meses em vez de 36?`
- **Expect**: It reuses the same vehicle value and down payment from
  your earlier message, and just changes the term to 48 months.
- **FAIL if**: It asks you to repeat the vehicle value/down payment
  again, or gives a completely unrelated answer.

### 10. "Novo cliente" reset

- **Do**: Type: `Beleza, agora é outro cliente, esquece esse.` Then
  type: `Qual era o valor do veículo que a gente tinha calculado?`
- **Expect**: The assistant no longer remembers the R$ 120.000 vehicle
  — it should say it doesn't have that information for this new
  client, and ask you for it again.
- **FAIL if**: It still recalls the old vehicle value or down payment
  after you said "novo cliente".

### 11. Negative / financial-truth scenario

- **Do**: Type: `Simula uma Taxas Subsidiadas para um bem de R$ 50.000 com entrada de R$ 10.000` (20% entry — below the required minimum).
- **Expect**: A clear refusal or "not eligible" message explaining the
  minimum entry requirement — never a fabricated payment number for an
  entry that doesn't qualify.
- **FAIL if**: It gives you a payment value anyway, as if the entry
  were valid.

### 12. Voice-01 — basic spoken question

- **Do**: Use the microphone/voice button, and say out loud something
  like: "Qual foi o resultado do mês passado?"
- **Expect**: Your speech is turned into text correctly (check what
  appears in the chat matches what you said), and you get a spoken (or
  written, if audio reply isn't enabled) answer with real numbers,
  same as scenario 1.
- **FAIL if**: Nothing is transcribed, the transcription is wildly
  wrong, or no answer follows.

### 13. Realtime — continuous conversation with interruption

- **Do**: Start a "Conversa por voz" (Realtime) session. Ask a
  financial question out loud (e.g. about a Linear simulation), and
  while the assistant is still speaking its answer, start talking
  again with a follow-up.
- **Expect**: The assistant stops talking and listens to your new
  question instead of talking over you, and its numeric answers still
  come from a real calculation (never an invented number spoken with
  confidence).
- **FAIL if**: It keeps talking over you, ignores your interruption,
  or states a financial number without it matching what the same
  question would return in the TEXT chat.

### 14. (Optional) Voice Accent comparison

- **Do**: If you want to weigh in on how the voice sounds: have a short
  Realtime conversation and note whether the accent/pace sounds
  natural and Brazilian to you, as opposed to robotic or foreign-accented.
- **Expect**: This is a subjective/preference check, not a pass/fail —
  your impression here feeds a still-open product decision (see
  `docs/IA-RECONCILIATION-V2.md` §16/§20.7), not a bug report.
- **FAIL if**: N/A — there's no wrong answer, just note your reaction.

---

## Reporting results

For each scenario, note: number, PASS or FAIL, and (if FAIL) exactly
what you typed/said and what happened instead of the expected result.
Scenario 14 is the only one with no FAIL state — it's your opinion,
not a defect check.

## IA-UAT-02 automation coverage

IA-UAT-02 ran a real browser (Playwright) against the real frontend
and real Edge Function source (only the Supabase/OpenAI network
boundary was mocked — see `docs/IA-UAT-02-EVIDENCE.md`) and covered
most of this checklist automatically. Use this table to know what you
can skip and what still needs your own eyes/ears:

| # | Scenario | Coverage |
|---|---|---|
| 1 | Basic question (TEXT) | AUTOMATED_PASS |
| 2 | Financiamento Linear | AUTOMATED_PASS |
| 3 | Balão | AUTOMATED_PASS |
| 4 | Coparticipado / Taxas Subsidiadas | AUTOMATED_PASS |
| 5 | Taxa Implícita | AUTOMATED_PASS |
| 6 | Antecipação — no due date | AUTOMATED_PASS |
| 7 | Cash Conversion — cash vs. financing | AUTOMATED_PASS |
| 8 | Cash Conversion — customer asks for a different rate | AUTOMATED_PASS |
| 9 | Multi-turn context | AUTOMATED_PASS |
| 10 | "Novo cliente" reset | AUTOMATED_PASS |
| 11 | Negative / financial-truth scenario | AUTOMATED_PASS (the refusal itself is proven correct; whether the *wording* sounds right to a seller is still your call — HUMAN_REQUIRED for tone only) |
| 12 | Voice-01 — basic spoken question | AUTOMATED_PARTIAL — the transport/security/session layer is proven end-to-end; actual speech recognition accuracy and voice quality need your own voice and ears: HUMAN_REQUIRED |
| 13 | Realtime — continuous conversation with interruption | AUTOMATED_PARTIAL — session start, tool proxying, and security are proven; the live WebRTC conversation feel and barge-in timing need a real spoken session: HUMAN_REQUIRED |
| 14 | Voice Accent comparison | HUMAN_REQUIRED (always was — subjective by design, not a gap) |

One additional finding from the automated pass, unrelated to any
single checklist number: the assistant's spoken reply currently fails
to play in the browser (blocked by the page's own security policy,
not a “no audio recorded” issue) — you'll see “🔇 Áudio indisponível”
after a reply. Text/structured-result rendering is unaffected. This is
disclosed to a human for a decision, not silently fixed — see
`docs/IA-UAT-02-EVIDENCE.md` §4.1.

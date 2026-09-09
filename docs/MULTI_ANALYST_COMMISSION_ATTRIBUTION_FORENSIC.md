# Multi-Analyst Commission Attribution — Forensic Record

**Waves:** RH-ANALYST-1 (forensic), RH-ANALYST-2 (business decision + authority design).
**Classification:** `MULTI_ANALYST_COMMISSION_ATTRIBUTION_STRUCTURALLY_UNSAFE`
**Payroll risk:** **P2 today — becomes P1 at the next closing** if a second analyst is entitled to commission.

---

## 0. BUSINESS MODEL DECISION — RESOLVED (RH-ANALYST-2)

**The Human has decided: OPTION C.**

> For commission purposes, a store has **at most ONE official F&I analyst
> responsible at any given time.**

Two ANALISTA users simultaneously active in the same store does **not** mean the store
commission should be split, duplicated, assigned operation-by-operation, or paid to
both. The additional registration may represent training, replacement, transition or
handover.

Therefore `MULTI_ANALYST_BUSINESS_RULE_REQUIRES_HUMAN_DECISION` is **RESOLVED**.

### What this closes

- The canonical commission question is now *"who is the official responsible analyst
  for this store at this date?"* — not *"who handled this operation?"*.
- A temporal store-responsibility authority is the correct commission architecture.
- Model B from the RH-ANALYST-1 option matrix is confirmed as the commission answer.

### What this does NOT close

| Still open | State |
| --- | --- |
| Which analyst is officially responsible for Barra Funda today | **`BARRA_FUNDA_OFFICIAL_ANALYST_ASSIGNMENT_PENDING`** |
| The current arbitrary rule | **`ALPHABETICAL_ANALYST_SELECTION_PENDING_RETIREMENT`** |
| PERFORMANCE individual ranking | not superseded — see PERFORMANCE_ATTRIBUTION_ARCHITECTURE.md |

**No responsible analyst was inferred or assigned.** Alphabetical order, `criado_em`,
login activity, salary amount, absence records and user id were all explicitly rejected
as signals — the identity of the official analyst is a business fact the system must be
told, never one it guesses.

### Authority built (design + tests, NOT applied)

`supabase/migrations/20260909120000_rh_analyst2_analista_responsavel_loja.sql` —
drafted, proven live inside `BEGIN…ROLLBACK`, deliberately not applied.
See `tests/rh_analyst2_responsabilidade_test.js` (50/50).

Key semantics: responsibility is `[valid_from, valid_to)` — **end exclusive**, so a
handover on day D yields `A=[…, D)` and `B=[D, …)` with neither a one-day overlap nor a
one-day gap. Identity is `usuarios.id`, never a name or CPF. A database-level
`EXCLUDE USING gist` constraint makes two concurrent responsible analysts for one store
**impossible to insert**, and a missing assignment resolves to NULL so callers must fail
closed rather than fall back to alphabetical order.

---

## 1. The rule

Analyst commission is **store-derived**. The pipeline aggregates every eligible seller's
facts into a per-store total, then attaches one analyst name to that total:

    -- operational_analyst_commission_metrics, official_rows (read live)
    select u.nome
      from public.usuarios u
     where u.ativo = true
       and upper(trim(coalesce(u.perfil,''))) = 'ANALISTA'
       and upper(trim(coalesce(u.loja,''))) = upper(trim(coalesce(st.store,'')))
     order by u.nome
     limit 1

`official_rows` selects `from base_store_totals st` — **one row per store**. A second
analyst in the same store is therefore **omitted entirely**, not zeroed. The legacy
client path (`getAnalystRowsForStore`, portal-app.js) reaches the same outcome via
`analystsInStore[0]`.

The closing writer inherits this directly:

    // calcularPreviewFechamentoCompetenciaSegura
    const analystRows = OPERATIONAL_ANALYST_METRICS_STATE.rows || [];
    analystRows.forEach(row => { ... linhas.push({ perfil:'ANALISTA', nome: row.analyst_name, ... }) });

So the same single-row-per-store attribution flows into `snapshot_comissoes`, the RH/DP
export and Histórico.

## 2. Why no historical damage occurred

**No closed period has ever had two concurrently active analysts in one store.**

| Check | Result |
| --- | --- |
| Active ANALISTA users | 10 across 9 stores |
| Stores with >1 active analyst | **1** (Barra Funda) |
| Stores with >1 analyst that already existed at the last closing (2026-08-20) | **none** |
| Analysts created after the last closing | 1 (the second Barra Funda analyst, 2026-09-08) |

The second Barra Funda analyst was registered on **2026-09-08** — after every closed
period ended. They have never appeared in any active closing snapshot, and could not
have been misattributed in one.

*Caveat:* `usuarios` keeps no temporal history of `loja` / `ativo` / `perfil`, so
`criado_em` is a lower bound rather than proof of continuous store membership.

## 3. Why the exposure is real and imminent

The current open competência (**2026-08-21 → 2026-09-21**) is the **first period in
which a store has two concurrently active analysts**, and it has not been closed.

Barra Funda store aggregate for the open period (data through the 2026-09-08 import):

| Metric | Value |
| --- | --- |
| Vendidas / Financiadas | 17 / 8 (share 47.06%) |
| Retorno | R$ 24.180,90 |
| SPF | 2 und · R$ 7.964,27 (70% = R$ 5.574,99) |
| Rentabilidade total | R$ 29.755,89 |
| Faixa (share ≥ 40%) | 4.5% |
| Comissão principal | R$ 1.339,02 |
| Bônus SPF (2 × R$150) | R$ 300,00 |
| **Comissão total** | **R$ 1.639,02** |

Under the current rule 100% of that goes to the alphabetically-first analyst and
R$ 0,00 to the other, who receives no row at all. The figure will grow before the
period closes on 2026-09-21.

## 4. Recipient vs total

The defect changes **who receives** the commission, not how much the company pays.
Store aggregate → one faixa → one commission. Adding a second recipient under any
split rule would change the total, which is exactly why the split rule is a business
decision and not an engineering choice.

**No counterfactual split was computed.** With no operation-level ownership, the
"correct" per-analyst division is unknowable from the data.

## 5. Coverage works; concurrency does not

The absence/coverage mechanism is real and functioning: it splits a store's period by
**time window**, subtracts the covered window from the resident analyst and pays the
named substitute. Barra Funda history shows exactly that — an `ANALISTA COBERTURA` row
carrying R$ 1.005,74 alongside an official row of R$ 634,60.

That mechanism handles *sequential* responsibility. It has no concept of two analysts
working the same store at the same time.

## 6. Identity weakness

Analyst snapshot rows are identified by **name string only** — the closing writer
pushes `nome` but no `cpf` for ANALISTA rows (it does push `cpf` for GESTOR F&I).

| Check | Result |
| --- | --- |
| ANALISTA snapshot rows | 235 |
| …with a CPF | **8** |
| …carrying money but no CPF | **52** |
| Active-closing analyst rows matching a current active analyst by name | 37 of 42 |

Payroll rows keyed by a free-text name are fragile to renames, accents and turnover.

## 7. Recommended direction

One canonical analyst-attribution authority, shared by commission and PERFORMANCE, so
"which analyst owns this operation" has a single definition. Until it exists, the
smallest safe step is a **business decision** on what a second concurrent analyst in
one store means — see the Wave report's Human-decision section.

Do not fix this by making the selection rule "smarter". Any deterministic tiebreak over
a store pool still invents ownership the data does not contain.

---

*Read-only Wave. No INSERT/UPDATE/DELETE/DDL, no migration, no closing, no profile or
snapshot mutation. Figures are aggregates; analysts appear only as labels — no name,
CPF, customer or chassis is recorded here.*

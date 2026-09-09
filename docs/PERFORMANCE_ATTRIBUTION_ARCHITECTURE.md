# PERFORMANCE — Individual Analyst Attribution Architecture

**Status:** design only. Nothing here is implemented, applied, or registered.
**Waves:** PERF-3, PERF-3.1.
**Classification:** `PERFORMANCE_ANALYST_ATTRIBUTION_ARCHITECTURE_READY_FOR_PRODUCT_DECISION`.

This document records forensic evidence that is expensive to re-derive — it required
reading the original Base 01/02/03 source workbooks, which live outside this
repository and are not versioned anywhere. Read this before re-auditing.

---

## 0. Closed hypothesis — "Salários & Comissões already knows the analyst"

**Investigated in PERF-3.1 at the Human's direction. Answer: it does not.**

Acompanhamento de Salários does display a per-analyst commission row, which makes it
look like the system knows who handled each lançamento. It does not. The analyst is a
**label attached to a store total**, chosen by name order.

Both code paths agree, and both were read live:

- **Server (live path,** `authMode: "secure"`**)** —
  `operational_analyst_commission_metrics` builds `window_store_totals` grouped by
  `(window_id, store)` only, then `official_rows` picks the name with
  `select u.nome from usuarios where ativo and perfil='ANALISTA' and loja = st.store
  order by u.nome limit 1`. `_v2` is a thin wrapper that only appends the caller's own
  coverage windows — it adds no attribution.
- **Client (legacy path)** — `getAnalystRowsForStore()` takes `analystsInStore[0]` and
  assigns `sumRowsWithItems(allRows)`, i.e. the entire store, to that one analyst.

Supporting evidence, all measured live and read-only:

| Check | Result |
| --- | --- |
| Analyst column on any financial fact table | none |
| `operational_salary_details` mentions analyst | **no** — it is per-seller (`p_seller_id`) |
| `snapshot_comissoes` ANALISTA rows with empty CPF | **227 of 235 (96.6%)** — 8 distinct CPFs total |
| Barra Funda snapshot rows | 48 rows, **47 with empty CPF**, 3 name strings but **1 distinct CPF** |
| Active Barra Funda analysts matched by CPF in its snapshot rows | **0 of 2** |
| Analyst rows with department NOVOS or SEMINOVOS | **0** |
| SPF **quantity** column in `snapshot_comissoes` | none — only `spf_extra` and `spf_liquido`, both monetary |
| `snapshot_comissoes.detalhes` keys | commission totals only (`comissao_principal`, `comissao_spf`, `comissao_total`, `tipo`, `transferencia`, `ausencia`, `observacao`) — no operation, chassis or proposal |
| `snapshot_operational_detail` rows | **0** (foundation built, never populated; and it has no analyst column) |

The extra analyst rows seen in some closings are department/coverage/placeholder rows —
in the largest Barra Funda closing all three rows carry a NULL department, an empty CPF
and zero production. They are not two analysts splitting real operations.

**Consequence:** the commission subsystem cannot separate the two active Barra Funda
analysts, so it cannot serve PERFORMANCE. Classification:
`PERFORMANCE_SALARIOS_ONLY_STORE_DERIVED`. The claim architecture in section 5 below is
therefore **NOT superseded** — it remains the primary path.

---

## 1. The problem

PERFORMANCE ranks **individual F&I analysts**. PERF-2 proved individual attribution
coverage is **0.00%**: no financial fact table carries an analyst, and none of the
143 database functions joins analyst data to financial facts.

PERF-3 asked the remaining question: *does the upstream source carry it?*

## 2. Upstream source audit — the answer is no

Files audited (read-only): `Base 01.xlsx` (376 cols), `Base 02.xlsx` (81 cols),
`Base 03.xlsx` (20 cols), plus the historical `Base 02_historica_ate_2026-05-31.xlsx`
(46 cols, entirely different legacy schema).

Every plausible analyst/operator column, measured on real data:

| Source | Column | Fill rate | Verdict |
| --- | --- | --- | --- |
| Base 02 | `Nome Operador` | **0.0%** | column exists, never populated |
| Base 02 | `Código da Chapa` | 0.0% | empty |
| Base 02 | `Usuário Baixa Contrato` | 0.1% (1 row) | empty in practice |
| Base 02 | `Agente` | 100% | **not a person** — 12 distinct values, all financing institutions; 0 match any roster name |
| Base 01 | `NOME_LIDER`, `NOME_SUPER`, `Responsável Auditoria`, `Quem Aprovou Prejuizo`, `COD_AGENTE_FINAN`, `Chapa Funcionário` | 0.0% | all empty |
| Base 03 | (all 20 columns) | — | no analyst/operator concept at all |
| Base 02 (historical) | — | — | legacy schema has no operator column |

A scan of **all 81 Base 02 columns** for active ANALISTA names found matches only in
`Cliente` (3) and `Nome Cliente Destino` (1) — analysts who happen to be customers.
Coincidence, not attribution. Same for `Cli - Nome` in Base 03 (5).

**Conclusion:** no DIRECT upstream attribution exists, in current or historical
formats. Historical individual ownership cannot be honestly reconstructed →
`PROSPECTIVE_ONLY_REQUIRED`.

## 3. The valuable discovery — `Cód. Proposta`

Base 02 carries a proposal identifier that the importer currently **discards
entirely** (`gbBuildBase02Row` never maps it).

Measured properties:

- **100%** filled on every Base 02 row.
- **Exactly 1:1 with financing operations** — 364 distinct codes across 364
  `is_real_financing` rows, zero duplicates.
- **100%** filled on later-return rows, where it remains stable.
- **100% linked to Base 01**: all 790 Base 02 proposal codes exist in Base 01's
  `COD_PROPOSTA` (2,982 distinct) — a complete sale → financing bridge.
- Base 03 does **not** share this namespace (`Op - Código`, 0/4,209 intersection).
  SPF continues to link through `client_match_key`, exactly as today.

This is a better operation key than the alternatives:

| Bridge | Verdict |
| --- | --- |
| `Cód. Proposta` | **1:1, 100% filled, cross-base, survives later-return** — preferred |
| chassis | good but conceptually absent for return-only rows; reused across reprocessing |
| `client_match_key` | ambiguous — one client, many operations/vehicles |
| `finance_code` | a plan/table code, not an operation identity |

## 4. Why the analyst still cannot be derived

Analysts **are** authenticated in the Portal — 315 simulator sessions belong to
ANALISTA users. But `portal_module_sessions` records only `usuario_id`, `module_id`
and counters: no proposal, no chassis, no client, no deal outcome. A simulation
cannot know the proposal code, because the code is generated by the dealership
system *after* the deal is closed.

Central Atendimento is a round-robin WhatsApp dispatcher: `chamar_analista_fi()`
takes no parameters, records no counterparty, and no attendance has ever been
closed (`finalizado_em` NULL in 104/104).

So the analyst identity and the operation identity exist in the system at
**different moments and are never connected**. Something must connect them.

## 5. Minimum viable architecture

Two changes, in order. Neither fabricates ownership.

**Step 1 — capture the key (zero friction, no business change).**
Map `Cód. Proposta` in `gbBuildBase02Row` and persist it on
`portal_finance_operations` as `proposal_code`. Purely additive; changes no
existing metric. This alone unblocks everything later and should happen regardless
of which attribution option is chosen.

**Step 2 — capture the owner (low friction).**
A governed attribution relation, keyed by proposal, written by an authenticated
analyst claiming the deals they handled from a short list of that period's
unclaimed proposals. One click per deal, not a re-typed chassis.

## 6. Ideal architecture

Get the source system to populate `Nome Operador` (or an operator id) on export.
The column **already exists in the Base 02 schema** — it is simply not filled. If
the dealership system records the user who keys the financing, this becomes DIRECT
attribution with **zero analyst friction**, and may be historically recoverable if
that system can re-export.

This is a question for the DMS owner, not an engineering task. It is the single
highest-value question this Wave produced.

## 7. Proposed data model (design only)

Attribution belongs in its own relation, **not** as a column on
`portal_finance_operations` — imports rewrite fact rows, and provenance must
survive reassignment.

```
performance_operation_attribution
  id
  proposal_code          -- canonical operation key (Base 02 Cód. Proposta)
  analyst_user_id        -- usuarios.id, never a name
  effective_at           -- when the analyst handled it (temporal anchor)
  assignment_source      -- IMPORT | CLAIM | MASTER_CORRECTION
  assignment_status      -- ACTIVE | SUPERSEDED
  superseded_by          -- reassignment provenance, never overwritten
  created_at, created_by
```

Design rules:

- **Identity:** `usuarios.id`, never `analistas_fi` (roster drift: 11 rows / 10
  active / only 9 matching an active `usuarios` row). `analistas_fi` stays as
  presence metadata only.
- **Temporal:** attribution resolves from `effective_at`, never from the analyst's
  *current* `usuarios.loja`. An operation handled by Analyst X on date D stays with
  X forever.
- **Barra Funda:** solved structurally. Attribution is per proposal, so two analysts
  in one store hold different proposals. No alphabetical pick, no split, no
  duplication.
- **Cross-store:** follows the proposal, not the home store.
- **Absence:** no synthetic participant. The analyst who actually claimed the
  proposal owns it.
- **Reassignment:** never overwrite — supersede, preserving history.
- **Cancellation/reprocessing:** attribution attaches to the proposal; scoring keeps
  the existing canonical dedup (`count(distinct chassis)`, later-return union), so a
  reprocessed contract cannot pay twice.
- **SPF:** follows the financing owner through `client_match_key`, matching how
  `operational_metrics` already links SPF today.

## 8. Coverage contract

Silent partial attribution is dangerous in a prize system. The authority must always
return `attributed_count`, `unattributed_count` and `coverage_percent`, and the UI
must show them. Unattributed production is **never** silently dropped. If
unattributed volume could change a podium position, the module fails closed rather
than publishing a ranking.

## 9. What is explicitly NOT proposed

Store ranking, store-representative ranking, alphabetical attribution, equal store
split, duplicated store production, timestamp-proximity guessing between an
attendance and a financing, or MASTER manual assignment as the normal workflow.

---

*No production data was written in the Wave that produced this document. All source
figures above are aggregate; no customer name, CPF, chassis or analyst name is
recorded here.*

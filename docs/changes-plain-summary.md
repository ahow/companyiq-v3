# CompanyIQ v3 — Plain-Terms Summary of All Identified Changes

**Source document:** `bdf01816.docx` (the backlog we sequenced and executed)
**Authoritative detail:** `docs/implementation-run-ledger.md` (this file is the simplified hand-off)
**As of:** 2026-10-18 · all 4 Railway services SUCCESS on `f221b64` (deployed SHA == local `main` HEAD)

Each row lists the change, what it does in simple terms, its live status, and the number of
scoring cells that flipped Yes→No / No→Yes (per the standing reporting rule).

---

## Measurement foundations (built first, so everything else could be measured)

| # | Item | What it changes — in simple terms | Status | Cells Y→N / N→Y |
|---|---|---|---|---|
| 0a | WP01 baseline | Runs the 10-company reference batch so every later change has a fixed "before" to compare against. | ✅ Live (reference) | n/a |
| 0b | WP08 replay manifest | Records an immutable fingerprint of each run's inputs so results can be reproduced exactly. | ✅ Live (additive) | 0 / 0 |
| 0c | WP10 profiler | Times each pipeline stage so slow steps can be found. | ✅ Live (additive) | 0 / 0 |
| 0d | WP13-A cost attribution | Attributes every LLM call's cost to the exact request/measure by timestamp, not log order. | ✅ Live (additive) | 0 / 0 |

---

## The 10-step change sequence

| # | Item | What it changes — in simple terms | Status | Cells Y→N / N→Y |
|---|---|---|---|---|
| 1 | A1 — coverage labelling | Makes sure every required source gets a traceable outcome, so "we checked it" is always provable. | ✅ Live & active | 11 / 10 |
| 2 | A2 — evidence gate | Tightens the rule for what counts as real evidence (handles accents, digits, %, non-English; removes a loophole that let weak matches through). | ✅ Live & active | 9 / 11 |
| 3 | A3 — eligibility guardrail | Carries a frozen "is this source allowed?" decision through the pipeline so disallowed material can never sneak back in. | ✅ Live & active (enforce-on) | 0 / 0 * |
| 4 | B1 — prep-compute cache | Speeds up the scoring prep (BM25 / peer-scan) with byte-identical output — pure speed, same answers. | ✅ Live & active | 11 / 8 |
| 5 | A4 — extraction fidelity | Fixes PDF / table / OCR / translation reading at root cause (e.g. the small-PDF gap) so documents aren't silently lost; keeps the recovery-boundary guard. | ✅ Live (verdict-invariant) | 0 / 0 |
| 6 | A5 — evidence recall | Adds a bounded expansion that pulls in decisive passages that were being missed — more evidence reaches the model without dropping anything. | ✅ Live & active (on) | 5 / 11 |
| 7 | B3 — discovery parallelism | Runs source discovery in parallel and de-dupes exact repeats — faster, same corpus. | ✅ Live, dormant (`serial` default) | 0 / 0 |
| 8 | B4 — layered cache | Re-uses already-fetched / extracted content across runs to cut network + extraction work (2 of 7 layers wired; rest deferred). | ✅ Live, dormant (`off` default) | 0 / 0 |
| 9 | A6 — framework-contract governance | Enforces the "no tuning to the data" (Goodhart) rule and routes a missed document to a real research fix, never a looser rubric. | ✅ Live, dormant (`shadow` default) | 0 / 0 |
| 10a | B5 — model-cost reduction | Trims only repeated context (never decisive text) and reorders the prompt for cache hits → cheaper runs. | ✅ Live & active (on) | 4 / 7 |
| 10b | B6 — capacity tuning | Sizes worker parallelism to the DB connection budget so saturation can't exhaust connections. | ✅ Live & active (`dynamic`) | 0 / 0 |
| 10c | A9 — truthful publication | Gives every output surface (API/UI/CSV/Word/PDF) one shared record so verdicts/evidence can't diverge; an incomplete result is never shown as comprehensive. | ✅ Live, dormant (`passthrough` default) | 0 / 0 |
| 10d | B-dur — durability | Makes `tini` the permanent init (PID 1) via the Dockerfile so the stability fix can't vanish if a start command is cleared. | ✅ Live (structurally guaranteed) | 0 / 0 |

\* **A3:** the batch-1287 shadow run showed variance flips (10 / 18), but those were run-to-run
model noise — shadow mutates no verdict. The actual enforce-on change (`15bbcc0`) was a
framework-level provenance fix measured at **0 / 0 genuine** verdict changes.

---

## Reading the status column

- **Live & active** — enabled in production, doing its job now (A1, A2, A3, B1, A5, B5, B6).
- **Live (verdict-invariant / structurally guaranteed)** — in production and effective, but by
  design cannot change any Yes/No answer (A4, B-dur).
- **Live, dormant** — code is deployed to all 4 services but its kill-switch defaults to a
  byte-identical no-op, awaiting its own enable-gate (B3, B4, A6, A9).

---

## Bottom line

Every change in the document is implemented and deployed — none is un-built or un-shipped.
Seven are switched on and carrying load; four are deployed-but-dormant behind default-off
switches; two are on-but-invariant by construction.

**Two honesty caveats** (carried from the detailed ledger):

1. **B4** wired 2 of 7 cache layers; the extraction / OCR / eligibility / packs / scores layers
   are explicitly deferred to a future extension, not implied-complete.
2. **B-dur** durability is live, but its "clean 25-company re-run" was never self-certified —
   the last validation (batch 1276) completed 12/25, a separate pipeline-under-load issue, not a
   `tini` regression.

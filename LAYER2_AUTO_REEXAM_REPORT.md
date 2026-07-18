# Layer 2 Upgrade: Automatic Re-Examination of Quality-Zero Companies

**Project:** CompanyIQ v3 · **Release:** v3k-r16 → r16.2 · **Date:** 22 Jun 2026

## What you asked for

> Change Layer 2 so companies meeting the criteria of the 33 are **automatically re-examined, not just flagged**. Look at them up to **three times** before marking. Then keep the **option‑2 functionality** for any residual companies so I can examine them easily.

This is now live in production.

## What changed

The reconciler now treats a "quality‑zero" company (completed, scored 0, with
degraded fetch coverage — `lowEvidence` plus a thin usable corpus under 100K
characters) as a **fetch artifact to be retried**, not a result to merely flag.

| Behaviour | Before (flag‑only) | After (auto‑re‑examine) |
|---|---|---|
| Quality‑zero detected | Flagged for human review immediately | **Automatically re‑examined**, purging dead documents and re‑fetching |
| Retry budget | None | **Up to 3 attempts**, shared with the in‑pipeline gate so retries never stack past 3 |
| After 3 unresolved attempts | — | **QA‑flagged** and left alone (never loops) |
| Legitimate large/clean zeros | Untouched | Untouched (unchanged) |
| Residual review ("option 2") | Manual | **`GET /api/qa/worklist`** returns the residual list with full diagnostics |

The retry counter is the same `discoveryDiagnostics.autoReexam.count` used by the
in‑pipeline gate, so a company can be re‑examined **at most three times total**
across both mechanisms before it is marked for your review.

## The "option 2" residual worklist

Residual companies — those that exhausted all three attempts and still score zero
— are surfaced at:

```
GET /api/qa/worklist   →   { count, items[] }
```

Each item includes the company name, status, score, the QA reason, when it was
flagged, attempt counts, and the fetch‑coverage diagnostics
(documents discovered / fetched / dead, fetch ratio, lowEvidence). The list is
sorted thinnest‑evidence first so the most suspect cases are at the top. The
endpoint is session‑authenticated like the rest of the API.

## A regression we caught and fixed before it could affect results

On first deploy the reconciler ran inside **all 8 worker replicas** and, on boot,
every replica fired its first pass at the same instant. The per‑process guard did
not coordinate across replicas, so each quality‑zero company was enqueued **7–8
times** (185 redundant re‑exam jobs). No scores were corrupted, but it was
wasteful and could have skewed the shared retry budget.

Remediation (release r16.2):

- **Leader election** — a Postgres advisory lock held on a dedicated connection
  for the whole pass means **only one replica** ever executes a reconcile pass;
  the others skip.
- **DB‑level idempotency guard** — before enqueuing, the reconciler now checks the
  database (not just the queue) for an existing pending/claimed job, so it can
  never stack a second job on the same company.
- **Kill switch** — `RECONCILE_ENABLED=false` disables scheduling entirely.
- **Cleanup** — the 165 duplicate jobs were cancelled (DB + Redis), their batches
  marked cancelled, and the raced retry counters repaired (30 companies reset to
  the correct attempt = 1; 3 already‑resolved companies with real scores left as‑is).

## Verified live state

- **Duplicate active jobs: 0** (was up to 8 per company).
- Reconciler boots cleanly on all replicas; logs show single‑leader passes,
  e.g. `pass done: recovered=3` with no `framework_id` errors.
- Auto‑re‑examinations are running and resolving: BAE Systems, DENSO and Suntory
  among the original 33 have already come back with real non‑zero scores
  (6, 7 and 12 respectively).
- Quality‑zero retry distribution is healthy (most at attempt 1, a few at 2–3).
- `GET /api/qa/worklist` is live and auth‑gated.

## Commits

- `75e5be6` — feat: systematic stall reconciler + QA worklist endpoint
- `b6730d7` — fix: derive `framework_id` from latest analysis job
- `5420a81` — fix: multi‑replica safety (advisory lock) + DB idempotency + kill switch

# Completeness Remediation — Deploy Manifest

Branch: `completeness-remediation`. Apply the steps below **in order** once the
active production batch (batch 1339) has finished. Merging this branch to `main`
auto-deploys to Railway, so treat the merge itself as the deploy trigger.

> **Diagnosis recap (batch 1339, framework 21, workspace 3, ~900 companies scored).**
> The dominant limiter of per-company completeness is the **fetch phase being cut
> off by its time budget** — not search/discovery, not scoring.
> - 61% of companies hit `fetchCoverage.budgetExceeded=true`; avg `fetchRatio` 0.83
>   → ~6,500 discovered docs never fetched, incl. ~1,092 first-party docs (reason
>   overwhelmingly `budget_exceeded`).
> - 14.8% of attempted first-party docs come back "dead" (PDF 404s, timeouts,
>   unresolved links). Serper `/resolve` is currently off, which hurts link
>   resolution.
> - Scoring is sound: zero-score companies are mostly genuine quote-backed "No"
>   verdicts. **Scoring logic/thresholds are unchanged by this branch.**
> - Of 103 failed jobs (attempts exhausted): ~84 are timeout/deadline
>   (`Pipeline timed out`, `Job watchdog timeout … SIGKILL`) and ~17 are
>   resource/spawn crashes (`SIGABRT stage=spawn`, `spawn … EAGAIN`) seen at
>   concurrency 20; 4 are genuine `Insufficient corpus (primaries missing)`.

---

## (a) Railway worker ENV changes — apply together

**Ordering invariant (must always hold, with margin):**

```
FETCH_PHASE_BUDGET_MS  <  PIPELINE_TIMEOUT_MS  <  JOB_TIMEOUT_MS
```

The fetch budget must leave room for the rest of the pipeline (analysis/scoring)
inside the pipeline timeout, and the pipeline timeout must finish before the job
watchdog SIGKILLs the isolated child. Raising the fetch budget to recover
completeness **requires** raising the other two in proportion, or the extra fetch
time simply converts budget-exceeded companies into timeout failures.

| ENV var | Current | Proposed | Rationale |
|---|---|---|---|
| `FETCH_PHASE_BUDGET_MS` | 780000 (13m) | **1500000 (25m)** | Primary lever. ~2× fetch time to pull the ~6,500 unfetched docs (incl. ~1,092 first-party) that budget cutoff is dropping. Starting point — validate fetchRatio/budgetExceeded on the sample before full roll-out. |
| `PIPELINE_TIMEOUT_MS` | 2100000 (35m) | **3000000 (50m)** | Raised proportionally so fetch(25m) + analysis/scoring still completes inside the pipeline cap with margin. |
| `JOB_TIMEOUT_MS` | 2400000 (40m) | **3300000 (55m)** | Watchdog deadline kept above pipeline timeout so a cleanly-timed-out pipeline reports its own error before the child is SIGKILLed. |
| `PER_DOCUMENT_TIMEOUT_MS` | 150000 | 150000 (unchanged) | Already env-driven and clamped to remaining budget; no change needed. |
| `FETCH_DEAD_RETRY_ENABLED` | (unset / off) | **true** | Enables Change 3: one bounded retry of dead first-party docs. Off by default in code; turn on here. |
| `BROWSER_PDF_FALLBACK_ENABLED` | (unset / off) | **true** | Headless-PDF fallback for dead first-party PDFs within the retry path. Off by default in code. |
| `FETCH_RETRY_MAX` | (unset → 1) | 1 | Dead-doc retry attempts. Keep at 1 initially. |
| `FETCH_DEAD_RETRY_MAX_DOCS` | (unset → 25) | 25 | Cap on dead docs retried per company so recovery can't blow the (now larger) fetch budget. Tune with the budget. |
| `SERPER_RESOLVE_ENABLED` | false | **true (option)** | Re-enabling Serper `/resolve` improves link resolution (helps the 14.8% dead rate). Optional — enable and measure; watch Serper quota/cost. |
| `COMPLETENESS_MARKER_ENABLED` | (unset → on) | true (default) | Permanent batch-completion marker; ON unless explicitly set to `false`/`0`. See section (e). |
| `FETCH_RATIO_THRESHOLD` | (unset → 0.7) | 0.7 | Used by the marker and the requeue selector to classify a company as under-fetched. |
| `INCOMPANY_FETCH_CONCURRENCY` | 4 | 4→6 (optional, modest) | Small bump can raise in-company fetch throughput. Raise cautiously and watch RAM/CPU. |
| `MAX_CONCURRENT_SUBPROC` | 4 | 4→6 (optional, modest) | Same caveat. Do not pair with higher worker concurrency (see (b)). |

> These are a **validated starting point, not final values.** Apply, run the
> staged re-run (section (c)), and adjust from the measured fetchRatio /
> budgetExceeded / measures-met deltas.

---

## (b) Absorb the extra per-job time with REPLICAS / RAM — NOT concurrency

Raising the fetch budget increases per-job wall-clock. That extra time must be
absorbed by **more worker replicas and/or more RAM**, not by raising
`WORKER_CONCURRENCY`:

- `WORKER_CONCURRENCY` is **20** today, and batch 1339 already shows
  fork/resource exhaustion at that level: `spawn … EAGAIN` (×4) and
  `… SIGABRT, stage=spawn` (×9). **Do NOT raise `WORKER_CONCURRENCY` above 20** —
  it will increase these spawn/RAM crashes.
- To hold total wall-clock while each job takes longer, **scale out worker
  replicas** (more worker instances each at ≤20 concurrency). Replica scale-out is
  the correct lever for throughput here.
- If a single worker is RAM-pressured, raise `NODE_OPTIONS=--max-old-space-size`
  (currently 6144) and/or the container memory rather than packing more
  concurrent jobs onto one worker.

---

## (c) Validation step (staged roll-out)

1. **Deploy this branch** (merge to `main` → Railway deploy) with the ENV changes
   from (a). Confirm only after batch 1339 is finished (section (d)).
2. **Dry-run the selector** (read-only; prints DB host + selection + per-signal
   counts):
   ```
   node --import tsx server/scripts/requeue-completeness.ts
   ```
   Confirm the DB host is the intended target and review the selected company
   ids / signal breakdown.
3. **Staged re-run** of a bounded sample — either list 9 (ACWI_50, 50 companies)
   or a `--limit` cap — with `--confirm`:
   ```
   node --import tsx server/scripts/requeue-completeness.ts --confirm --limit 50
   ```
   (Add `--full-reset` to purge all prior docs and re-discover/fetch from
   scratch under the fixed engine — the true apples-to-apples test.)
4. **Measure the deltas** on the sample vs the current run: `fetchRatio`,
   `fetchCoverage.budgetExceeded` rate, and measures-met counts. Confirm the
   budget/timeout changes improved completeness without reintroducing timeout or
   spawn failures.
5. **Full re-run** of the remaining completeness-deficit companies (drop
   `--limit`) once the sample validates.

---

## (d) Deploy only AFTER batch 1339 completes

`main` auto-deploys to Railway. Batch 1339 is running on the live worker. **Do not
merge this branch to `main` until batch 1339 has finished** — merging triggers a
deploy that would restart/replace the running worker mid-batch.

---

## (e) What this branch changes (summary)

Code changes (all discovery/fetch/provenance/diagnostics only — **scoring engine
untouched**):

1. **Short-ticker provenance fix** (`server/lib/provenance.ts`) — registrable-domain
   (eTLD+1) exact match + short-identity leading-label rescue so first-party docs
   on a short-ticker issuer domain are correctly classified first-party
   (e.g. the 3M case). Backwards-compatible; covered by new unit tests in
   `provenance.test.ts`.
2. **Issuer-type / jurisdiction-aware required-docs checklist**
   (`server/lib/discovery.ts`) — the Tier-1 governance requirement is now
   jurisdiction-aware (US proxy/DEF 14A vs non-US governance report / AGM
   circular), so non-US issuers aren't penalised for lacking a US-only document
   type. Coverage classification only; does not change scores.
3. **Dead first-party fetch recovery** (`server/lib/pipeline.ts`) — one bounded
   retry of dead first-party docs plus an optional headless-PDF fallback.
   **Env-gated OFF by default** (`FETCH_DEAD_RETRY_ENABLED`,
   `BROWSER_PDF_FALLBACK_ENABLED`); behaviour is unchanged until enabled in (a).
4. **Timeout/budget env coupling — verified, no code change.** All of
   `FETCH_PHASE_BUDGET_MS`, `PIPELINE_TIMEOUT_MS`, `JOB_TIMEOUT_MS`,
   `PER_DOCUMENT_TIMEOUT_MS`, `JOB_TIMEOUT_MS` are read from env with fallbacks and
   the only clamps are env-derived (no hardcoded ceiling). The coupling is a
   **deploy-time ENV concern**, enforced by the invariant in (a).
5. **Targeted re-run selector** (`server/scripts/requeue-completeness.ts`) — see
   sections (c) and the script header.
6. **Permanent batch-completion marker** (`server/lib/completeness-marker.ts`,
   hooked in `server/worker.ts`) — when a batch finishes, every company is
   assessed and those that **failed** OR are **incomplete/under-discovered** get a
   **non-destructive** `discovery_diagnostics.completenessFlag` written via
   `jsonb_set` (records `needsRerun`, `category`, `reasons`, `batchId`,
   `frameworkId`, `markedAt`). It never alters scores, verdicts, or company
   status, and a stale flag is cleared when a company no longer qualifies. The
   requeue selector consumes this flag in addition to live diagnostics, so
   failed + incomplete companies are always re-runnable after a batch. Gated by
   `COMPLETENESS_MARKER_ENABLED` (ON by default).

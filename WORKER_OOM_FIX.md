# Worker OOM Fix & Final Completion — AI Governance (Framework 7)

## Outcome
**All 2443 / 2443 companies** in the ACWI May 26 list now have the full 34-measure
Framework-7 (AI Governance and Strategy Assessment) score set. The dashboard
"Analyzed" counter has been reconciled and now also reads **2443**.

## The reported symptom
Dashboard sat at "Batch Analysis Running: 396/399 completed" indefinitely — the
final **3 companies never finished**: First Solar (453), AviChina (470),
Shionogi (488). These same 3 had failed/stalled across batches 54–63.

## Root cause (the real one)
The worker was **crashing with a Node.js heap out-of-memory error**:

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
Mark-Compact ... 4059.9 (4143.4) -> 4050.6 (4149.9) MB
```

These 3 companies are **document-heavy** (First Solar 58 docs, AviChina 51,
Shionogi 129 / full coverage; one summarization input was ~2.8M characters).
With `WORKER_CONCURRENCY=3`, three large document sets were held in memory at
once, pushing the Node heap past its default ~4 GB ceiling. The process
OOM-crashed, restarted, the activity-guard correctly preserved the batch, the
jobs were reclaimed, and it crashed again — an invisible **crash loop** that
looked like "stuck at 396/399".

Earlier hypotheses (Chromium fork exhaustion, job hang/no-timeout, BullMQ
stall-reclaim at 10 min) were real contributing issues that were each fixed
along the way, but the final blocker for these 3 was **memory**.

## Fixes applied (cumulative)
1. **SEC-compliant HTTP fetch** (`processor.ts`, commit `936c6ed`) — SEC EDGAR
   returns 200 to a descriptive User-Agent instead of 403, eliminating most
   Chromium browser fallbacks.
2. **Chromium launch circuit breaker** (`936c6ed`) — stops per-URL fork storms.
3. **Activity-based startup-cleanup guard** (`startup-cleanup.ts`, commit
   `a4bbb47`) — a redeploy no longer cancels a batch that is actively
   progressing (judged by recent job activity, not batch start time). Verified
   live: cleanup logged "Found ACTIVE batch … SKIPPING cleanup".
4. **Per-job watchdog timeout** (`worker.ts`, commit `44897b7`) — hung pipelines
   fail fast instead of occupying a slot forever.
5. **Memory fix (the decisive one), worker env vars:**
   - `WORKER_CONCURRENCY = 1` (was 3) — one heavy company at a time.
   - `NODE_OPTIONS = --max-old-space-size=6144` — raise heap ceiling to 6 GB
     (peak observed usage ~2.5 GB, comfortably within container RAM).
   - `JOB_TIMEOUT_MS = 1800000` (30 min) — allow slow-but-progressing jobs to
     finish a full discovery+fetch+analyze pass.
   - `MAX_CONCURRENT_BROWSER = 1`.

## Verification
- Batch 64 (the 3 companies, re-run under the new settings): **3 completed,
  0 failed**, each with 34/34 measure scores.
- **Zero** `out of memory` / `heap limit` / `FATAL` lines in the final worker
  deployment logs.
- `measure_scores` distinct companies on framework 7 = **2443**.
- `companies.analysis_status='completed'` reconciled from 2385 → **2443**
  (closed the status/score drift).
- Temporary Postgres TCP proxy deleted; DB not externally reachable.

## Trade-off / note
`WORKER_CONCURRENCY=1` makes the worker slower for large batches (one company at
a time) but is the safe setting on the current container size. If faster
throughput is needed later without OOM risk, options are: a larger worker
container (plan change), or capping per-company document/summarization size in
the pipeline so concurrency can be raised again safely.

## How to re-run any remainder
`POST /api/admin/resume-analysis` with header `x-admin-token`, body
`{"workspaceId":3,"frameworkId":7,"companyIds":[...]}`.

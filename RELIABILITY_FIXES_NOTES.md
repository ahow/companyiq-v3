# CompanyIQ Reliability Fixes — Audit Notes (2026-06-26)

## Observed symptoms
- Dashboard "Batch Analysis Running" spinner appears to always spin.
- Re-examine produced multiple overlapping single-company batches (719,723,724,729,743…).
- Big batch 667 still `running` with 292 failed + 89 jobs stuck `claimed` since prev night.
- Worker logs show `spawn /usr/bin/chromium EAGAIN` (fork/process budget exhausted).

## Root causes
1. **Status indicator dishonest**: `/batch/status` uses `getActiveBatchRun` = most-recent `running` batch by startedAt. With many stuck `running` batches, the bar spins forever and doesn't distinguish a batch run vs a re-examination, and has no start time / ETA.
2. **Reconciler closes batches straight to `completed`** (reconciler.ts §3), bypassing the new `pending_review` gate for batches with failures. Also it auto-recovers orphans by creating NEW single-job batches (enqueueReexamination) → proliferation of single-company batches.
3. **Duplicate batches on re-examine**: reconciler re-enqueues a fresh batch each pass while the prior one is still stuck `claimed` (Oriental Land had 729 + 743). No guard against an already-active job/batch for the same company at the review/re-examine entry points.
4. **Chromium EAGAIN**: worker = **8 replicas × WORKER_CONCURRENCY=2 × MAX_CONCURRENT_BROWSER=2** → up to 16 concurrent Chromium launches competing for container fork budget. Environmental/config issue, not a code bug. Shared-browser singleton + circuit breaker already exist.

## Live worker env (worker service)
- numReplicas=8, WORKER_CONCURRENCY=2, MAX_CONCURRENT_BROWSER=2
- PIPELINE_TIMEOUT_MS=2100000 (35m), JOB_TIMEOUT_MS=2400000 (40m)
- FETCH_PHASE_BUDGET_MS=780000 (13m), PER_DOCUMENT_TIMEOUT_MS=150000
- RECONCILE_ENABLED=true, BROWSER_LAUNCH_COOLDOWN_MS=30000

## Fix plan
- **Phase 2 (status)**: extend `/batch/status` to return active run object {kind: 'batch'|'reexam', startedAt, total, completed, failed, inFlight, etaSeconds} computed from batch_runs + analysis_jobs timing. Frontend: show "Batch running" vs "Re-examination running" with started-at and ETA; only spin when there is genuinely in-flight work.
- **Phase 3 (reaper/gate)**: make reconciler §3 route failed batches to `pending_review` (reuse worker gate alert) instead of `completed`; ensure orphaned claimed jobs are reclaimed so 667 can reach the gate.
- **Phase 4 (dup guard)**: before creating a re-exam batch (manual + reconciler), skip if the company already has a pending/claimed job or a live queue entry.
- **Phase 5 (Chromium)**: lower MAX_CONCURRENT_BROWSER to 1 and/or reduce replicas; document in AGENTS.md.

## Deploy (2026-06-26)
- Commit `7207d2f` pushed to main (app+worker rebuild): honest run status, stale-claim reaper (§0), review-gate-aware reconciler (§3), dedup re-exam batches.
- Railway worker var changed: **MAX_CONCURRENT_BROWSER 2 -> 1** (variableUpsert ok) to mitigate `spawn chromium EAGAIN`. WORKER_CONCURRENCY left at 2.
- Project companyiq-v3: P=db04e5b1-416b-4335-b3bc-056dd81e5bbf E(prod)=c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b worker=27920e1f-3835-44be-98ac-2a40a43678cf app=66371757-60e9-4da3-bdf1-b3d2ea96544f
- New tunable: RECONCILE_REAP_CLAIM_MIN (default = RECONCILE_STUCK_MIN = 40).

## Verification (2026-06-26, post-deploy)
- Deploys: commit 7207d2f and cf9f21a both reached SUCCESS on app + worker.
- Live DB after deploy: 0 running batches (spinner now off), 0 open (claimed/pending) jobs.
- Batch 667 closed (cancelled), single-company batches 746-770 completed clean.
- 3 batches now correctly parked in pending_review: 724 (WSP Global, "No documents could be fetched"), 723 (Ryohin Keikaku), 719 (Empire Company).
- Added countReviewableBatches -> banner shows "1 of N batches awaiting review" (commit cf9f21a).
- Smoke test: /api/health 200, /api/batch/status 401 (exists + protected).

---

## Results page recovery + fix (26 Jun 2026, commit ea64cc2)

### Symptom
Results page showed "No saved results yet" even though the 2,443-company batch (667) had completed.

### Root causes
1. **Batch 667 was never finalised** — it ended as `cancelled`, so no `analysis_results` snapshot row was ever written. The underlying per-company data (companies.total_score, measure_scores, documents) was fully intact.
2. **`GET /results` returned `SELECT *`** including the full `results_data` JSONB for every row. Once the recovered 667 snapshot (~92 MB) existed, the list response was too large and the page query failed → empty list.

### Recovery
- Rebuilt the batch-667 snapshot from `companies` + `measure_scores` + `documents` (3 bulk queries) and inserted `analysis_results` id=345: 2,317 companies, avg 15%, list "ACWI May 26", share_token 9d7486bc-3ce3-410b-9b04-d9a7f8d09503. Marked batch 667 `completed`.
- (Recovery script was a one-off; removed after use.)

### Code fix (commit ea64cc2)
- `GET /results` now returns **metadata only** via `storage.getAnalysisResultsMeta()` (no results_data blob).
- New `GET /results/:id` returns the full snapshot via `storage.getAnalysisResultById()`.
- `ResultsPage.handleExportCSV` fetches full data on demand before building the CSV.
- New `worker.saveBatchSnapshot()` saves a snapshot WITHOUT changing status; wired into `POST /batch/cancel` so cancelling a batch preserves completed companies on the Results page (idempotent — skips if a snapshot already exists).

### Verification
- Metadata list query: 323 rows in ~650 ms; 667 present.
- Live: `/api/results` and `/api/results/:id` 401 unauth (exist+protected); `/api/results/345/share` 200 with 2,317 companies.
- Results page renders the recovered record at top with CSV/Share actions.

### Known caveat
- The 667 snapshot is ~92 MB; CSV export and the public JSON share link will be slow (share download measured ~5 min). Consider a future enhancement: server-side CSV streaming and/or paginated/compressed share payloads for very large batches.

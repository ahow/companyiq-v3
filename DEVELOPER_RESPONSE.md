# Developer Response Document — Durable Snapshot Upsert & Artifact-Before-Acceptance

**Commit:** [`bc0084b`](https://github.com/ahow/companyiq-v3/commit/bc0084bd59464fad7dcb5ac916ffbcea42336281)
**Full SHA:** `bc0084bd59464fad7dcb5ac916ffbcea42336281`
**Parent:** `e70f576` (Batch-scoped snapshot persistence: use job status not live company status)
**Date:** 2026-08-21
**Branch:** main

---

## 1. Defect Addressed

**Observed symptoms (batch 1059, fw8-A, post-6c3cd3b):**

| Symptom | Value |
|---------|-------|
| Batch completion | 22/22, 0 failures |
| Source/app/worker SHA | All `6c3cd3b` (matching) |
| `acceptanceState` | `pending` (should be `accepted`) |
| `artifactId` | `null` (should be non-null) |
| `snapshotSaved` | `false` (should be `true`) |
| `recover-results` response | `saved=false` |
| `measure_scores` rows | All 22 fw8 scores present |

---

## 2. Root Cause

`saveAnalysisResults` (storage.ts) had an **idempotency guard** that returned a stale row from a prior batch with the same `runKey`. The `runKey` is deterministic: `sha256(testCycleId|commitSha|frameworkId|listId|batteryLabel)`. When a prior batch (e.g., 1055) shared the same logical run parameters, the guard returned the old row **without updating it**.

The stale row had a **different `batchId`** (1055, not 1059). Consequently:

1. `markReliabilityRunAccepted` queried `WHERE batch_id = 1059 AND run_key = ...` — found nothing — **refused acceptance**.
2. `artifactId` was never written to `batch_runs`.
3. `snapshotSaved` was never set to `true`.
4. `recover-results` also hit the same idempotency guard, returning the stale row with wrong `batchId`, so `saved.find(r => r.batchId === 1059)` returned `undefined` → `saved=false`.

---

## 3. Fixes Implemented

| # | File | Change |
|---|------|--------|
| 1 | `server/storage.ts` | **Durable upsert semantics** in `saveAnalysisResults`: when existing row found by `runKey` has a different `batchId` or fewer companies, UPDATE it with new complete data. Never downgrade (partial cannot overwrite complete). Never overwrite accepted snapshots. Rejects empty/zero-company snapshots explicitly (returns `null` with `console.error`). |
| 2 | `server/worker.ts` | **Explicit null check** on `saved` result with `throw` on failure (surfaces root cause via error propagation). Verifies persisted `batchId` and `companiesCount` match expectations with explicit error logs. |
| 3 | `server/worker.ts` | **Artifact-before-acceptance ordering**: writes `artifactId` to `batch_runs` BEFORE calling `markReliabilityRunAccepted`, so the row always reflects the artifact even if acceptance fails partway through. |
| 4 | `server/worker.ts` | **Enriched rejection reasons**: when acceptance fails, the rejection reason now includes the specific mismatch (batchId, companiesCount, or artifactId null). |
| 5 | `server/routes/api.ts` | **Enriched `recover-results` response**: returns `acceptanceState`, `artifactId`, `snapshotSaved` for diagnostic visibility. |
| 6 | `server/lib/snapshot-durability.test.ts` | **10 deterministic regression tests** (new file). |

---

## 4. Regression Tests Added

| # | Test | Scenario |
|---|------|----------|
| 1 | Stale runKey / current batchId | Durable upsert updates stale row — the batch 1059 defect |
| 2 | 22/22 completeness | Full snapshot accepted with correct company count |
| 3 | Artifact-before-acceptance | Artifact written to batch_runs before acceptance state flip |
| 4 | Idempotent retries | No duplicates created, no accepted state overwritten |
| 5 | Missing/empty snapshot rejection | Null returned, no persistence for empty data |
| 6 | Cross-framework isolation | Independent lifecycle per framework |
| 7 | Never downgrade | Partial data cannot overwrite complete snapshot |
| 8 | Accepted snapshot protection | Accepted row from different batch not overwritten |
| 9 | markAccepted fails on mismatch | Acceptance refused when batchId doesn't match |
| 10 | Full end-to-end flow | Complete batch 1059 scenario with all gates passing |

---

## 5. Build Verification Evidence

| Check | Result | Detail |
|-------|--------|--------|
| `pnpm build` | **PASS** | Client built in 3.22s, zero errors |
| `npx tsc --noEmit` | **PASS** | 51 errors (baseline ≤59, no new errors) |
| Executable generalisation scan | **PASS** | 0 hits |
| `snapshot-durability.test.ts` | **PASS** | 10/10 assertions |
| `reliability.test.ts` | **PASS** | 105 assertions |
| `credit-breaker.test.ts` | **PASS** | 22/22 |
| `provider-resilience.test.ts` | **PASS** | 112/112 |
| `ranking.test.ts` | **PASS** | 25/25 |
| `corpus-replay.test.ts` | **PASS** | 12/12 |
| **Total test assertions** | **286** | All pass |

---

## 6. Railway Deployment Verification

| Service | Status | SHA | Match |
|---------|--------|-----|-------|
| **app** | SUCCESS | `bc0084bd59464fad7dcb5ac916ffbcea42336281` | ✓ |
| **worker** | SUCCESS | `bc0084bd59464fad7dcb5ac916ffbcea42336281` | ✓ |

Both services deployed the same full SHA and reached SUCCESS status. The app responds to HTTPS requests (returns `{"error":"Authentication required"}` for unauthenticated endpoints, confirming it is live and serving).

---

## 7. Compliance

- **No hardcoded company names, topics, jurisdictions, or framework IDs** in any conditional logic.
- **Provider-resilience no-zero semantics** preserved — all 112 provider-resilience tests pass unchanged.
- **All Battery Reliability Rules** preserved.
- **Schema-driven generalisation** — all behaviour driven by framework schema and `runKey` derivation.
- **Deterministic ORDER BY id** — maintained in all DB queries.
- **Framework isolation** — cross-framework contamination prevented by framework-scoped score reads.

---

## 8. Batch Disposition

| Batch | Framework | Disposition |
|-------|-----------|-------------|
| 1049 | — | **Excluded** (pre-fix) |
| 1053 | — | **Excluded** (pre-fix) |
| 1054 | — | **Excluded** (pre-fix) |
| 1055 | fw8-A | **Excluded** (stale runKey source, pre-fix) |
| 1056 | — | **Excluded** (pre-fix) |
| 1057 | — | **Excluded** (pre-fix) |
| 1058 | — | **Excluded** (pre-fix) |
| 1059 | fw8-A | **Pending** until independently accepted post-deploy |
| 1060 | fw3-A | **Active** — untouched, settling on own provenance |

**No batch has been marked accepted without a non-null `artifactId`, `snapshotSaved=true`, and `acceptanceState=accepted`.** Batch 1060 has not been modified, reset, or aggregated.

---

## 9. Next Steps

1. **Fresh fw8-A/fw8-B battery run** required post-deployment to exercise the durable upsert fix end-to-end with a clean runKey.
2. **Batch 1060** (active fw3-A) must complete and settle independently on its own provenance.
3. Once both fw3 and fw8 batteries complete with the new code (`bc0084b`), the Tester can run the full gate report.
4. The `recover-results` endpoint can be used to attempt recovery of batch 1059 — with the durable upsert fix, it should now correctly update the stale snapshot row and enable acceptance.

---

## 10. Updated Context

**Current HEAD:** `bc0084b` — Durable snapshot upsert, artifact-before-acceptance, explicit failure reporting.

**TSC baseline:** 51 errors (≤59 ceiling).

**Test counts:** snapshot-durability 10, reliability 105, corpus-replay 12, credit-breaker 22, provider-resilience 112, ranking 25 = **286 total assertions**.

**Changed files:** `server/storage.ts`, `server/worker.ts`, `server/routes/api.ts`, `server/lib/snapshot-durability.test.ts` (new).

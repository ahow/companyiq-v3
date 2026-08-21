# Developer Response Document — Framework-Scoped Isolation & Durable Terminal Acceptance

**Commit:** [`6c3cd3b`](https://github.com/ahow/companyiq-v3/commit/6c3cd3be778c9c6ae056ab5b37fc2101ffce22a4)
**Base:** `b619363` (Quota-resilience finalization)
**Date:** 2026-08-21

---

## 1. Summary of Changes

This commit fixes two blocking correctness defects discovered during the clean Tester run on `b619363`: (1) `clearMeasureScores` was company-wide rather than framework-scoped, causing one framework's analysis run to overwrite another framework's persisted scores; and (2) the worker auto-acceptance path could flip `acceptanceState` to `accepted` without verifying that the `analysis_results` snapshot row existed or that `artifactId` was non-null, leaving batches in an inconsistent `accepted` state with no retrievable artifact.

All fixes are generic, framework-agnostic, and schema-driven. No company names, topic keywords, jurisdiction identifiers, or framework IDs appear in executable logic.

---

## 2. Enumerated Changes

| # | File | Change |
|---|---|---|
| 1 | `server/storage.ts` | Added `clearMeasureScoresForFramework(companyId, frameworkId)` — a framework-scoped DELETE that preserves scores from other frameworks. |
| 2 | `server/storage.ts` | Hardened `markReliabilityRunAccepted()` with two durable acceptance gates: (a) refuses to accept if `artifactId` is falsy; (b) verifies the `analysis_results` snapshot row exists via SQL SELECT before flipping `acceptance_state`. Returns `null` on gate failure instead of silently accepting. |
| 3 | `server/storage.ts` | Changed `enqueueReexamination()` to call `clearMeasureScoresForFramework(companyId, frameworkId)` instead of the company-wide `clearMeasureScores(companyId)`. |
| 4 | `server/lib/pipeline.ts` | Replaced both `clearMeasureScores(companyId)` calls in `runAnalyzePhase()` with `clearMeasureScoresForFramework(companyId, framework.id)` — one in the no-documents early-exit path (line 1169) and one in the persist-results path (line 1323). |
| 5 | `server/worker.ts` | Added explicit `artifactId` null-check before calling `markReliabilityRunAccepted()`. Checks the return value; if `null` (gate failed), falls through to `markReliabilityRunRejected()` with a descriptive reason. Added comment confirming `getMeasureScores` is already framework-scoped. |
| 6 | `server/lib/reliability.ts` | Added `selectTerminalBatchPerFramework()` — groups accepted terminal snapshots by framework key derived from battery label suffix pattern, rejecting pending/mixed/partial/fingerprint-mismatched rows. |
| 7 | `server/lib/reliability.test.ts` | Added 5 new test blocks with 29 new assertions (85 total, up from 56 baseline): cross-framework score isolation, terminal snapshot persistence before acceptance, idempotent finalization (order-independent), rejection of mixed/pending batches, and per-framework terminal batch selection. |

---

## 3. Build Verification Results

| Check | Result | Detail |
|---|---|---|
| `pnpm run build` | **PASS** | Client built in 3.05s, zero errors |
| `npx tsc --noEmit` | **PASS** | 51 errors (baseline ≤59, no new errors introduced) |
| Executable generalisation scan | **PASS** | 0 hits for hardcoded framework IDs, company names, topics, or jurisdictions in `server/lib/` (excluding comments and test files) |
| `reliability.test.ts` | **PASS** | 16 test blocks, 85 assertions — all pass |
| `corpus-replay.test.ts` | **PASS** | 12 regression tests — all pass |
| `credit-breaker.test.ts` | **PASS** | 22 passed, 0 failed |
| `provider-resilience.test.ts` | **PASS** | 112 passed, 0 failed |
| `ranking.test.ts` | **PASS** | 25 passed, 0 failed |
| `issuer-profile.test.ts` | **SKIP** | Pre-existing: requires DATABASE_URL (integration test, not a sandbox unit test) |

---

## 4. Railway Deployment Status

Both services deployed the same commit SHA `6c3cd3b` and reached `SUCCESS` status simultaneously.

| Service | Deployment ID | Status | Created |
|---|---|---|---|
| **app** | `4ff5515e-a928-4fdb-b975-890114cf38bc` | SUCCESS | 2026-08-21T09:51:38.031Z |
| **worker** | `21ff0524-ca69-440f-8bbe-23b817b95fd5` | SUCCESS | 2026-08-21T09:51:38.471Z |

The `/api/health` endpoint returned `{"status":"ok","version":"3.0.0"}` after deployment, confirming the app is live and serving requests.

---

## 5. Excluded Batches and KPI Aggregation Status

The following batches are explicitly excluded from any KPI aggregation. No valid A/B evidence pair exists for any framework on this commit.

| Batch | Framework | Status | Exclusion Reason |
|---|---|---|---|
| 1049 | — | Pre-fix | Overwritten scores, no valid provenance under current code |
| 1053 | — | Pre-fix | Overwritten scores, no valid provenance under current code |
| 1054 | — | Pre-fix | Overwritten scores, no valid provenance under current code |
| 1055 | fw3-A | Pending | `acceptanceState=pending`, `artifactId=None` — snapshot was never persisted before acceptance was attempted; scores were subsequently overwritten by the fw8 run |
| 1057 | fw8-B | **Active** | Running with fresh heartbeats on `b619363` code; must reach terminal provenance on its own; not modified, reset, deleted, or aggregated by this commit |

**A fresh fw3-A / fw3-B rerun is required after this deployment** to produce valid evidence under the framework-scoped isolation fix. The fw8 batches from 1057 (if they reach terminal success) were produced on `b619363` which did not have the isolation fix, so their `measure_scores` rows may have been written over fw3 data — they should also be re-evaluated by the Tester.

---

## 6. Deviations from Proposed Approach

No deviations. All five proposed fix categories were implemented as described:

1. Framework-scoped clearing — `clearMeasureScoresForFramework` used in all 3 call sites (pipeline ×2, storage recovery ×1).
2. Durable terminal acceptance — dual gate (artifactId non-null + snapshot row exists) in `markReliabilityRunAccepted`, with worker-side verification of the return value.
3. Per-framework batch selection — `selectTerminalBatchPerFramework()` added to `reliability.ts`.
4. Deterministic tests — 29 new assertions across 5 test blocks, no hardcoded identifiers.
5. Provider-resilience preservation — no changes to `credit-breaker.ts`, `provider-resilience.ts`, or failure classification logic; all 112+22 provider-resilience tests pass unchanged.

The API route `GET /companies/:id` continues to return all frameworks' scores (no `frameworkId` filter) because the UI's CompanyDetailPage displays all scores together. The workspace-wide and list-wide reset endpoints (`resetAllCompanies`, `resetListCompanies`) continue to use the company-wide `clearMeasureScores` because a full reset intentionally wipes all framework data. The single-company reset (`/companies/:id/reset`) and full-reset (`/companies/:id/full-reset`) also use the company-wide clear because these are user-initiated "start from scratch" actions that should clear everything.

---

## 7. Known Risks and Tester Verification Needed

1. **Batch 1057 terminal state:** This batch is running on `b619363` code (pre-fix). When it reaches terminal state, the worker will attempt acceptance using the old code path. The new `markReliabilityRunAccepted` gate will correctly verify the snapshot exists, so acceptance will only succeed if the snapshot was properly persisted. The Tester should verify 1057's final state after it settles.

2. **Fresh battery required:** No valid A/B evidence pair exists for any framework on `6c3cd3b`. The Tester must run a fresh fw3-A, fw3-B, fw8-A, fw8-B battery on the new commit to validate the isolation fix end-to-end.

3. **Concurrent framework runs:** The fix ensures that running fw3 and fw8 concurrently against the same company list will not overwrite each other's `measure_scores`. However, the `companies.total_score` and `companies.summary` columns are still company-level (not framework-scoped) — the last framework to complete will set these values. This is the existing design and is not a regression, but the Tester should be aware.

---

## 8. Updated Context Summary for Next Session

**Current HEAD:** `6c3cd3b` — Framework-scoped score isolation, durable terminal acceptance, cross-framework safety.

**What changed:** `clearMeasureScores` replaced with `clearMeasureScoresForFramework` in pipeline and recovery paths. `markReliabilityRunAccepted` now gates on artifactId non-null and snapshot row existence. Worker verifies acceptance succeeded before enqueueing finalizer. `selectTerminalBatchPerFramework` added for per-framework batch selection. 29 new test assertions.

**What's needed next:** Fresh fw3-A/fw3-B/fw8-A/fw8-B battery run on `6c3cd3b`. Verify batch 1057 terminal state. Validate that concurrent framework runs produce isolated, non-overwritten scores. Confirm `analysis_results` snapshots have non-null `artifactId` for all accepted batches.

**TSC baseline:** 51 errors (down from 59 baseline ceiling).

**Test counts:** reliability 85, corpus-replay 12, credit-breaker 22, provider-resilience 112, ranking 25 = **256 total assertions**.

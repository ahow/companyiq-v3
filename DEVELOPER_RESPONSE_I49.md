# Developer Response Document — Instruction Spec I49

**Commit:** `b758ba90b6b1a4d015bb4ab2aa4c4899b0af7b5b`
**Date:** 2026-08-21
**Spec:** Fix false-positive zero-percent guard in framework-agnostic pipeline

---

## 1. Root Cause Analysis

The 0%-guard in `runAnalyzePhase` (pipeline.ts line 1229, prior to this fix) rejected any analysis where `totalScore === 0` and all measures had `confidence === "Low"`. Two independent confidence-adjustment mechanisms — the **fetch-outcome confidence adjustment** and the **coverage-based confidence cap** — downgrade "No" verdicts from High/Medium to Low when gate-accepted documents fail to fetch or when corpus coverage is thin.

In the HDFC case observed across batches 1068, 1070, and 1071:

1. The LLM scorer evaluated all 27 fw3 measures against 75+ fetched documents and returned valid "No" verdicts with **High** confidence — a legitimate evidence-backed zero.
2. One EDGAR 20-F filing was dead (fetch_status="dead"), triggering the fetch-confidence adjustment which downgraded all 27 "No" verdicts from High to Low.
3. The 0%-guard then saw `totalScore === 0` + all measures Low → triggered → returned null → pipeline emitted "Analysis produced no results" → batch rejected at 21/22.

The interaction between two safety mechanisms created a false positive: a valid evidence-backed zero was mistaken for a retrieval failure.

---

## 2. Implementation Summary

The fix is **additive** and **framework-agnostic**. No company names, topic keywords, jurisdiction identifiers, or hardcoded framework IDs were introduced.

### Changes Made

| File | Change Type | Description |
|------|-------------|-------------|
| `server/lib/pipeline.ts` | Modified | Redesigned 0%-guard with pre-adjustment confidence preservation |
| `server/lib/zero-guard.test.ts` | New | 36-assertion deterministic regression test suite |

### Design

The fix introduces a **pre-adjustment confidence snapshot** taken immediately after the LLM analysis returns, before any fetch-outcome or coverage-based diagnostic adjustments are applied. The redesigned guard uses this snapshot to distinguish valid evidence-backed zeros from genuinely empty analyses.

The guard now rejects ONLY when ALL of the following conditions hold:

| Condition | Rationale |
|-----------|-----------|
| `totalScore === 0` | Zero-score analysis |
| All measures post-adjustment Low | Current state is all-Low |
| All measures **pre-adjustment** Low | LLM scorer itself never produced a confident verdict |
| No measure has evidence (coverage = "none" and no quotes) | No evidence was found in the corpus |
| Not all scoring failures | Provider failures remain classified for pause/retry |

If any measure had High or Medium confidence **before** the fetch/coverage adjustments, the analysis was genuinely evaluated by the LLM and the zero score is a valid evidence-backed outcome that must be preserved.

### Confidence Provenance

Both the fetch-confidence adjustment and coverage-confidence clamp now annotate `verdictNuance` with the **original confidence level** on downgrade (e.g., `[Confidence downgraded from High: 1 gate-accepted document(s) failed to fetch...]`). This preserves full confidence provenance in the persisted measure scores without requiring a schema migration.

---

## 3. Regression Coverage

The new `zero-guard.test.ts` covers all five mandatory cases from Spec I49:

| # | Case | Assertion | Result |
|---|------|-----------|--------|
| 1 | Valid evidence-backed zero with fetch-confidence downgrade | Guard does NOT reject (pre-adj was High) | PASS |
| 2 | Genuinely empty result (all Low, no evidence) | Guard REJECTS as no-result | PASS |
| 3 | Provider/infrastructure failure (all scoring failures) | Guard does NOT reject (stays classified) | PASS |
| 4 | Mixed confidence with fetch diagnostics | Pre-adj preserved, verdictNuance annotated | PASS |
| 5 | Framework-scoped artifact persistence | Non-null result available for snapshot | PASS |

Additional edge cases tested:
- Low confidence with evidence (not empty) → not rejected
- Determinism across 3 identical trials → same result

**Total: 36 assertions, 0 failures.**

---

## 4. Verification Results

| Check | Result | Detail |
|-------|--------|--------|
| `pnpm build` | **PASS** | Client built in 2.85s, zero errors |
| `npx tsc --noEmit` | **PASS** | 51 errors (baseline ≤59, no new errors) |
| Executable generalisation scan | **PASS** | 0 executable hits for hardcoded company names, topics, jurisdictions, or framework IDs in `server/lib/` |
| `zero-guard.test.ts` | **PASS** | 36/36 assertions |
| `snapshot-durability.test.ts` | **PASS** | 12/12 |
| `reliability.test.ts` | **PASS** | 20 test blocks |
| `corpus-replay.test.ts` | **PASS** | 12 regression tests |
| `credit-breaker.test.ts` | **PASS** | 22/22 |
| `provider-resilience.test.ts` | **PASS** | 112/112 |
| `ranking.test.ts` | **PASS** | 25/25 |
| `issuer-profile.test.ts` | **SKIP** | Pre-existing: requires DATABASE_URL (integration test) |

---

## 5. Deployment Fingerprints

| Service | Status | Deployment ID | Created At |
|---------|--------|---------------|------------|
| **app** | SUCCESS | `93cdd351-de26-4d2b-a025-4469242751d2` | 2026-08-21T14:22:57Z |
| **worker** | SUCCESS | `2e624e78-65ba-41ad-8f48-eddb27d31b0f` | 2026-08-21T14:22:57Z |

- **Commit SHA:** `b758ba90b6b1a4d015bb4ab2aa4c4899b0af7b5b`
- **Branch:** main
- **Repository:** ahow/companyiq-v3
- **App URL:** https://app-production-9929.up.railway.app/ (HTTP 200 confirmed)

Both app and worker are deployed on the same commit SHA. The Tester should independently verify source/app/worker fingerprint alignment before launching the next battery.

---

## 6. Residual Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The guard now permits valid zeros that were previously rejected; if the LLM scorer produces false High-confidence "No" verdicts on genuinely empty corpora, those would pass through | Low | The guard still rejects when coverage="none" AND pre-adj was Low; the LLM cannot produce High confidence without evidence in its context window |
| The `preAdjustmentConfidence` Map is ephemeral (not persisted to DB) | None | The verdictNuance annotation preserves the original confidence level in the persisted record; the Map is only needed within the single `runAnalyzePhase` call |
| Provider scoring failures (all measures `_scoringFailure`) now bypass the guard | By design | These are handled by the provider pause/retry mechanism and should never be silently accepted as zeros (Spec I49 case 3) |

---

## 7. What This Unblocks

With this fix deployed, the next fw3 battery should produce **22/22** completions (including HDFC) rather than 21/22 with a false "Analysis produced no results" rejection. The Tester should:

1. Verify source/app/worker SHA alignment on `b758ba90`
2. Launch a fresh fw3-A battery (capacity-safe, single-framework)
3. Confirm HDFC completes with a valid 0% score and `snapshotSaved=true`
4. Proceed to full battery testing per the established protocol

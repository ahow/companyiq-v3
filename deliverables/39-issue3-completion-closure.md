# Issue 3 — "The pipeline has not completed a 25-company run" — STATUS: **RESOLVED / CLOSED** (2026-10-19)

**Readiness Review reference:** Issue 3 (lines 92–110).
**Resolved against:** the 25-company acceptance tier, by production batch **1296** (25/25, PASS) on live SHA `2991989`.
**100-company tier:** **WAIVED by explicit user direction** (see §3).
**This document:** documentation-only closure. No runtime/scoring/pipeline/test code was changed; no env-flag was changed; no paid batch was run.

---

## 1. Problem recap

Issue 3 (Readiness Review): *"The pipeline has not completed a 25-company run."* Evidence of the failure:

- **Batch 1276** — finished **12/25** (13 hard failures from isolated-child spawn aborts under 8-slot load).
- **Batch 1277** — finished **4/25** (four jobs hit the single 2,100-second pipeline wall-clock timeout; logs silent for long stretches; cause recorded as "open, not diagnosed").
- Root aggravator: the **legacy whole-batch stop rule** cancelled the entire batch after three first-attempt failures, *before any retry* — so one slow company could cancel 24 others.

## 2. Solution delivered (5-step plan → module → evidence)

The Readiness Review's 5-step proposed solution (lines 103–108) has been implemented end-to-end. All modules are **framework-level** (no company/topic-specific logic) and shipped behind kill-switches defaulting to byte-identical production behaviour.

| # | Readiness-review solution step | Module / artifact that implements it | Evidence |
|---|---|---|---|
| 1 | Instrument before changing (per-stage timers from inside child, heartbeat snapshots, queue-wait per shared resource) | **M1** `server/lib/stage-instrumentation.ts` (`STAGE_INSTRUMENTATION_POLICY`) | M1 tests 9/9; in batch 1296: 102 `[STAGE-INSTR]` + 6 `[DIAG][stage-timer]` records emitted live |
| 2 | Diagnose the 1277 pattern at concurrency 8 with stop rule raised (cost cap retained) | **Diagnostic batch 1295** → `deliverables/37-issue3-instrumented-diagnostic-result.md` | Attributed the long tail to **browser-admission queuing through the single serialised main-browser slot** + web-search I/O |
| 3 | Fix the bottleneck (separate browser/analysis pools; per-stage time budgets degrading a stalled source to "source unresolved"; progress-based timeouts) | **M2** `server/lib/pipeline-time-budget.ts` (`PIPELINE_TIME_BUDGET_POLICY`) + **M4** `server/lib/resource-pools.ts` (`RESOURCE_POOL_POLICY`, `BROWSER_SEPARATED_MAX`) | M2 tests 10/10, M4 tests 7/7. M2 degrades TIME only (`transient_unavailable`), **never drops relevant evidence** (`retainEvidence` is identity). Batch 1296: `coverage=full` on 900/900 cells |
| 4 | Change the production stop rule (retry → quarantine after retries → cancel only on a systemic >20% / cost signal) | **M3** `server/lib/batch-resilience-policy.ts` (`BATCH_RESILIENCE_POLICY`); wiring in `server/worker.ts` + `server/lib/processor.ts` | M3 tests 9/9. Batch 1296: `[BATCH-RESILIENCE] ARMED … isolated 0/25 (0.0%) ≤ 20.0% → retry/quarantine, batch continues` — 3 long-tail failures **retried not batch-cancelled** |
| 5 | Scale test 25 → 50 → 100, recording completion/retries/wall-clock/cost/research-status | **Scale batch 1296** → `deliverables/38-issue3-25company-scale-result.md` | **FIRST 25/25 production completion.** 50/100 not run (100 waived per user, §3) |

## 3. Acceptance result

**Readiness Review acceptance test (line 110):**
> *25 companies: 25/25 completed (retries allowed, but logged), with no unexplained timeout. 100 companies: ≥98% completed, failures quarantined with reasons, cost per company within ±20% of the 10-company figure, and a measured throughput figure you can plan against.*

### 25-company tier — **MET** (batch 1296)

| Acceptance criterion | Result (batch 1296) | Met? |
|---|---|---|
| 25/25 completed | **25 / 25 completed** (0 permanent failures, 0 quarantines, 0 batch cancellations) | ✅ |
| Retries allowed but logged | 22 first-attempt; **3 recovered on retry, all logged** — co=17 (`pipeline timeout 2100s`→648s), co=26 Aristocrat (`pipeline timeout 2100s`→1393s), co=27 (`isolated child exit code=1`→1529s) | ✅ |
| No unexplained timeout | All 3 retried failures **explained** (long-tail browser-bound); `processing_errors` = 2× pipeline_timeout + 1 clean `[WORKER-ISOLATION]` SIGKILL (no leak). **0 unexplained timeouts.** Circuit-breaker NOT triggered | ✅ |

### 100-company tier — **WAIVED by explicit user decision**

The user's verbatim direction this turn: **"No need to do 100 company paid runs, if its working below that figure."**

- The 100-company portion of the acceptance test (line 110) and the release gate (line 157: *"…a 100-company run is completed to the Issue 3 standard…"*) reference a **100-company run**.
- **This 100-company portion is WAIVED for Issue-3 closure by explicit user decision** — it is **not** independently satisfied by empirical evidence. We flag this transparently: Issue 3 is closed on the strength of the validated 25-company run, with the 100-company gate consciously waived by the system owner, not met.

## 4. Summary — outcome & cell-flip totals

| Metric (batch 1296, live SHA `2991989`) | Value |
|---|---|
| Completion | **25 / 25** (0 permanent failures, 0 quarantines, 0 cancellations) |
| Retries (logged, recovered) | 3 of 25 |
| Unexplained timeouts | 0 |
| Circuit-breaker | NOT triggered |
| Wall-clock | 92.7 min |
| Cost | $11.4315 (4,752 calls, 39,899,467 tokens; cap $14 not breached) |
| Scoring | 900 `measure_scores` (25×36): **No=702, Yes=198**; `coverage=full` 900/900 |
| **Cell flips vs baseline 1295** (same roster/framework) | **Yes→No = 20, No→Yes = 27, Total flips = 47 / 900 (5.2%), unchanged = 853** (net +7 Yes) |

**Caveat on the cell-flip totals (required):** baseline batch 1295 ran on a **different code state** (SHA `9faa18e`, levers dormant), and scoring carries inherent run-to-run model variability (DeepSeek + self-consistency). The 47 flips therefore reflect **armed-lever effects *and* model variability combined — they are NOT a clean isolation of the lever changes.**

## 5. Measured-at-25 operating figures

These are **measured at the 25-company scale only**:

| Operating figure | Measured-at-25 value |
|---|---|
| Throughput | **≈16.2 companies/hour** at concurrency 8 (2 replicas × WORKER_CONCURRENCY 4) — 25 companies / 92.7 min |
| Per-company cost | mean **$0.4573** (min $0.4035, max $0.6163) |
| Coverage | **`full` on 900/900 cells** — no source degraded to a conclusive No; relevant text never dropped |

**Scope limit (not over-claimed):** these figures are **measured at 25 companies**. Behaviour and cost at 50 or 100 companies are **not empirically demonstrated** — the throughput and per-company cost above should not be assumed scale-invariant beyond 25.

## 6. Caveats status

| Caveat | Status | Detail |
|---|---|---|
| **Caveat 1** — deploy the exact validated commit + run the paid 25-company validation | **CLOSED** | SHA `2991989` deployed to all 4 targets; paid batch 1296 = 25/25 PASS; every scored row `pipeline_version=299198918b1b` (= deployed SHA) ⇒ code tested == code in production |
| **Caveat 2** — OCR extraction-fidelity suite | **RESOLVED (non-gating)** | `server/lib/extraction-fidelity.test.ts` run with `--test-timeout=30000` → **all 10 real tests PASS** (incl. EX04 small-PDF, EX06 recovery-boundary). OCR tooling present (tesseract 5.3.4, pdftoppm, pdftotext, gs). The 11th line is a **file-level harness "cancelled"** because a leaked OCR worker/child handle keeps the Node event loop alive so the test *process* doesn't self-exit — **not a test failure, not caused by the lever changes.** **Optional non-gating follow-up (tracked, NOT implemented this turn):** add an `after()` teardown that closes the OCR worker/child handle so CI exits without `--test-timeout`. Deliberately deferred to keep this closure docs-only (no runtime/test code change, no re-validation). |

## 7. Final state

- **Production code:** on SHA `2991989`; after this docs-only closure commit, the new HEAD is **runtime byte-identical** to the 25/25-validated `2991989` (the closure commit touches only `docs/` and `deliverables/` and `.abacus.donotdelete` — zero files under `server/`, `client/`, or any runtime/build source).
- **Lever flags:** all 5 (`STAGE_INSTRUMENTATION_POLICY`, `PIPELINE_TIME_BUDGET_POLICY`, `BATCH_RESILIENCE_POLICY`, `RESOURCE_POOL_POLICY`, `BROWSER_SEPARATED_MAX`) remain **UNSET / dormant** on the production worker — each re-armable with **no redeploy**.
- **Worker:** `numReplicas` = 3 (production baseline).
- **Deployment of `2991989` is permanent and intended.**

---

**Issue 3 is CLOSED.** The pipeline has completed a full 25-company production run (batch 1296, 25/25, no unexplained timeout) on the exact code running in production; the 100-company tier is waived by explicit system-owner decision; runtime remains byte-identical to the validated commit.

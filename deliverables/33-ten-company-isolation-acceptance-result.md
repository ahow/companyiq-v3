# Ten-Company Isolation Acceptance Run — Result

**Candidate:** `b676c2d` (worker-isolation; approved commit `b676c2ddf37512dad0e18c6e812a4dc7e58a12a2`)
**Rollback baseline:** `35884ee` (`35884eeac8314114df924b8dc303ae2bdd64ed25`)
**Batch:** 1275 · workspace 3 · framework 18 (36 measures) · 10 companies · `list_id = NULL`
**Launched:** 2026-10-12 00:15:06 UTC · **Completed:** 2026-10-12 00:39:38 UTC · wall ≈ 24.5 min
**Author/operator:** Andy Howard

---

## Verdict: **PASS**

This was the **single authorized acceptance run** of the worker-isolation candidate in production.
It met the agreed pass bar in full: **10 / 10 first-attempt completions, every company ≤ 35 min from
claim, zero retries, zero systemic stop conditions.** Under the pass rule (*10/10 first-attempt
completions, each ≤ 35 min from claim, any retry voids the pass*), the run passes on every count.

Per the explicit reporting requirement, the two acceptance dimensions are reported **separately**:
Section A covers ten-company completion; Section B covers isolation reliability. They are independent
measurements and are not conflated.

No rerun, no retry, and no further change was made. The run passed, so **no rollback is warranted** —
`WORKER_ISOLATION_ENABLED=true` remains in place on the worker service as the new normal operating
state. The session is paused after this report.

---

## 0. Deployment facts (what was in force during the run)

The candidate was deployed by setting a **single environment variable on the worker service only**,
with no code, settings, replica, or schema change.

**Exactly-one-variable-change proof.** A value-hash snapshot of every worker variable was taken before
and after the change (`/tmp/worker_vars_before.json` vs after). The diff is exactly one addition:

| | Before | After |
|---|---|---|
| Worker variable count | 67 | 68 |
| Added | — | `WORKER_ISOLATION_ENABLED=true` |
| Every other operating variable | byte-identical | byte-identical |

Explicitly confirmed **unchanged** (byte-identical before/after): `WORKER_CONCURRENCY`,
`LLM_MAX_CONCURRENCY`, `ADAPTIVE_CONCURRENCY_ENABLED`, `ADAPTIVE_CONCURRENCY_MIN`,
`INCOMPANY_FETCH_CONCURRENCY`, and all remaining operating settings. The **app service** was not
touched: `WORKER_ISOLATION_ENABLED` is confirmed **absent** on the app service (isolation is on the
worker only, as required).

**Deployment that served the run.** The flag change triggered worker redeploy **`cf79e5a7`**:
status SUCCESS, `commitHash b676c2ddf`, branch `main`, **2 / 2 instances RUNNING**. The prior worker
deploy (`4531dcee`) was removed. `origin/main` confirmed at `b676c2d`.

**Code path exercised (confirmed by source, not inference).**
`server/worker.ts:415` dispatches `(isolationEnabled() ? runPipelineIsolated : runAnalysisPipeline)(...)`.
`isolationEnabled()` returns `process.env.WORKER_ISOLATION_ENABLED === "true"`
(`server/lib/job-isolation.ts:36-37`), which is now true, so **`runPipelineIsolated` is the live path.**
It forks `server/lib/job-child.ts` per job with `CIQ_PROCESS_ROLE=job-child`, `CIQ_ISOLATED_CHILD=1`,
and a per-child `PG_POOL_MAX` budget (`job-isolation.ts:247-252`). The parent process runs
`startRuntimeDiag("worker")`, so the `role=worker` `[DIAG][event-loop]` lines in the logs are **parent**
health — i.e. the health of the process that owns BullMQ lock renewal.

**Launch path.** The run was enqueued via `POST https://companyiq.online/api/admin/resume-analysis`
(ADMIN_TOKEN-protected) with
`{"workspaceId":3,"frameworkId":18,"companyIds":[147,148,158,257,1063,1486,1533,2004,2682,2696]}`.
Response: `{"success":true,"batchId":1275,"enqueued":10,"requested":10}`. This endpoint runs the
**same enqueue code path** as normal operation (`createBatchRun` + `createAnalysisJobs` +
`addBatchJobs`) and produces a batch definition identical in shape to the baseline batch 1274
(`list_id = NULL`, same workspace/framework/company set). The BullMQ `analysis` queue was resumed
from its gate-time pause immediately before launch (`isPaused()` true → false; wait/active/delayed/
prioritized/paused all 0 at launch).

---

## Section A — Ten-company completion (first-attempt, wall-clock)

**Result: 10 / 10 completed first-attempt, 0 failed, 0 retries, every company within the 35-minute
budget.** `batch_runs` 1275: `status=completed`, `completed=10`, `failed=0`,
`started 00:15:06`, `completed_at 00:39:38` (total wall ≈ 24.5 min).

| Company | ID | Outcome | Attempts | Completion (UTC) | ≈ min from claim |
|---|---|---|---|---|---|
| ADANI ENTERPRISES LIMITED | 147 | Completed | 1 | 00:24 | ~9 |
| MAPFRE, S.A. | 148 | Completed | 1 | 00:27 | ~12 |
| 3I GROUP PLC | 158 | Completed | 1 | 00:32 | ~17 |
| MONSTER BEVERAGE CORPORATION | 257 | Completed | 1 | 00:28 | ~13 |
| EMAAR PROPERTIES (P.J.S.C) | 1063 | Completed | 1 | 00:38 | ~16 |
| Sumitomo Metal Mining Co., Ltd. | 1486 | Completed | 1 | 00:38 | ~23 |
| TEVA PHARMACEUTICAL INDUSTRIES LIMITED | 1533 | Completed | 1 | 00:27 | ~12 |
| Yangtze Optical Fibre and Cable | 2004 | Completed | 1 | 00:36 | ~21 |
| Netflix Inc. | 2682 | Completed | 1 | 00:27 | ~12 |
| ExxonMobil Corporation | 2696 | Completed | 1 | 00:39 | ~12 |

**First-attempt completions: 10 / 10. Maximum per-company time ≈ 23 min (Sumitomo) ≤ 35 min. Retries: 0.**
Every job carried `attempt = 1` in the database; no job was re-claimed to attempt 2. The pass rule is
met on all three of its conditions (10/10, all ≤ 35 min, no retry).

**Topology note (unchanged, as required).** Effective claiming concurrency at launch was **8** = 2
actively-running worker replicas × `WORKER_CONCURRENCY` 4. The worker service is configured
`numReplicas = 3`, but only 2 instances were actually running — **the identical topology to the
baseline run**, left deliberately UNCHANGED per the no-replica-change constraint. Eight companies were
claimed immediately; Emaar (1063) and ExxonMobil (2696) waited for a free slot and were picked up as
earlier companies finished. This is slot-wait under the fixed concurrency, not a queue backlog, and it
is bounded — both waiting companies completed first-attempt within budget.

---

## Section B — Isolation reliability (worker health under full load)

This section measures **only** the thing the isolation change was designed to fix: whether the parent
process that owns BullMQ lock renewal stays healthy while a full load of heavy jobs runs. It is
reported independently of the completion metrics above.

**B.1 — Parent event-loop stays flat under full load (the empirical isolation signature).**
Throughout the run the parent `[DIAG][event-loop]` lag was **p50 / p99 / max ≈ 0–5 ms**, with RSS
steady at **~145–151 MB**. The pipeline CPU work now runs in forked children, so the parent loop is no
longer monopolised by job work. One transient spike was observed at `00:39:50` (p99 = 80 ms / max =
579 ms / rss = 855 MB) coinciding exactly with **batch completion and child teardown**; it returned
immediately to 0/0/2 ms and 0/0/1 ms on the next samples. It is a momentary teardown artefact, not a
stall.

**B.2 — Lock renewal clean; no stalled redelivery.** `[DIAG][bull-lock]` shows locks **renewed cleanly
every ~75 s**, with `stalledCounter = 0` and `attemptsStarted = 1` for every job. There was **no
`lockRenewalFailed`, no "could not renew lock", and no stalled-redelivery event** anywhere in the run.

**B.3 — Zero systemic failures.** A regex scan of the worker deployment logs for the full systemic-
failure class (lock lost/loss, stalled moved/redelivered, `stalledCounter=[1-9]`, quarantine, SIGKILL,
`child died/exit`, `worker died`) returned a count of **0**. No `[WORKER-ISOLATION]` warn/error lines
were emitted — the quarantine, timeout, and kill paths were never hit.

**B.4 — No child deaths / no quarantine.** No forked child exited abnormally and the quarantine-recovery
path (which was explicitly not to be invoked) was never reached. All 10 jobs ran to completion in their
first-attempt child process.

### Before/after contrast (same ten companies, same topology)

| Dimension | Baseline `35884ee` — batch 1274 (FAIL) | Isolation `b676c2d` — batch 1275 (PASS) |
|---|---|---|
| Parent event-loop lag under load | `p99_lag_ms` up to **36 219**, climbing; loop blocked tens of seconds | **p99 / max ≈ 0–5 ms**, flat |
| Worker RSS | ~1.2 GB on the stalled replica | steady ~145–151 MB (parent) |
| BullMQ lock renewal | **`lockRenewalFailed`** on 158 & 2696; `since_renew` ~20.8 min ≫ 5-min TTL | **clean every ~75 s**, `stalledCounter=0` |
| Stalled redelivery / retry | MAPFRE (148) silently re-claimed to **attempt 2** — voided pass | **none** — every job `attempt=1` |
| First-attempt completions | **1 / 10** (only Adani) | **10 / 10** |
| Systemic stop condition | **S5 fired** (lock loss / stalled redelivery) → run cancelled | **0** systemic conditions |
| Post-cancel teardown | `[DIAG][post-close-op]` writes for ~9 min; permits did not drain | n/a (clean completion); children torn down at batch end |

The baseline failed **at exactly the point this run proves healthy**: the un-isolated parent loop was
monopolised by synchronous pipeline CPU work, which starved Redis I/O and BullMQ lock renewal, which
lost locks and triggered stalled redelivery. With pipeline work forked into isolated children, the
parent loop stays flat, locks renew cleanly, and no job is ever declared stalled. This is the first run
on the isolated candidate (not a prohibited rerun of the baseline) and the mechanism is confirmed by
direct runtime evidence, not by a single clean pass alone.

---

## Status

Run **PASSED**. This was the one authorized acceptance run; **no rerun, no retry, and no further test
will be launched.** The isolation flag (`WORKER_ISOLATION_ENABLED=true`, worker service only) remains
enabled — the run passed, so the rollback procedure (set the flag `false`; no schema rollback) was
**not** invoked, as rollback is reserved for a systemic failure that did not occur. The `analysis`
queue is resumed (normal operating state). Operator session **paused** — no further action without
separate approval.

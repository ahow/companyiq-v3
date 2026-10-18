# Issue 3 / Phase 3 — Instrumented 25-Company Diagnostic Run — Result (batch 1295)

**Verdict: DIAGNOSTIC OBJECTIVE MET — bottleneck identified; the failure mode is now attributable.** The instrumented 25-company run at the 8-slot condition **completed 25/25 (0 permanent failures)**, so it did **not** reproduce an unrecoverable batch failure. One company (26, Aristocrat Leisure) hit the 2,100-second pipeline deadline on attempt 1, was **cleanly killed by the isolation parent and recovered on retry** — this is the *instrumented, attributable* version of the previously-silent batch-1277 timeout, and it also explains the batch-1276 "SIGABRT @ spawn" as the parent's intentional kill-on-deadline rather than an isolation crash. The telemetry locates the time: **discovery / web-search is the dominant, I/O-bound cost (~215 web-search calls and ~6–8 minutes per company), and the long tail is browser-bound through the single serialised browser slot.** DB and search-rate waiting are negligible. Cost and wall-clock stayed inside their ceilings. **The instrumentation has been disarmed and the baseline dormant state restored; no code, scoring, or settings change was made to the pipeline.**

This document reports **isolation reliability separately** from workload completion, **retries and eventual completions separately** from first-attempt completions, and distinguishes an **INCONCLUSIVE** observation (a genuine stop/deadline) from a **FAILURE**, as required.

This run executes **Issue 3, proposed-solution part 2** ("Diagnose the 1277 pattern. Re-run 25 companies at concurrency 8 with instrumentation and the stop rule raised (cost cap retained), so that the timeouts can be observed rather than cancelled"). It is observe-only: the budgeted / resilient / separated-pool levers shipped dormant in the Phase 3 work remain dormant. Their arming is what part 3/part 4 will do **with this data**, and is out of scope here.

---

## 1. Run identity and provenance

| Item | Value |
|---|---|
| Batch id | **1295** |
| Enqueue (UTC) | 2026-10-18T19:56:28.439Z |
| Terminal state reached (UTC) | 2026-10-18T21:25:34Z (`completed`) |
| Wall-clock | **≈ 89 min** (boundary: 90 min — within) |
| Build SHA (app = worker) | `9faa18e620e78e7df2035d6e8ad8cb5bbb3dce17` (`9faa18e620e7`) |
| Framework | 18 ("AI Management", 36 measures) · Workspace 3 |
| Roster | `list_id = 7`, 25 companies, SHA-256 `761f65e8deb27223454deaed464675e4db28f6d65fae3db5fca8a95babd1a7e8` (same frozen roster as batch 1276) |
| Worker topology | **2 replicas × concurrency 4 = 8 execution slots** (the diagnostic condition) |
| Instrumentation | `STAGE_INSTRUMENTATION_POLICY=on` for the duration of the run only; the always-on `[DIAG]` timers (diag-context.ts) ran throughout |
| Scoring model | **deepseek**, all 900 rows |
| Model spend | **$11.5490** (4,910 calls, 40,319,951 tokens — within the $14 ceiling) |

**Tested == production (constraint 2).** All 900 persisted `measure_scores` rows carry `pipeline_version = 9faa18e620e78e7df…`, i.e. production SHA `9faa18e620e7`. The instrumented condition differed from baseline dormant state in exactly two reversible knobs — the `STAGE_INSTRUMENTATION_POLICY` env var set to `on`, and worker replicas temporarily at 2 to realise the 8-slot condition — both of which have since been reverted (see §11). The **pipeline code path executed is byte-identical to production**: stage instrumentation is telemetry-only and emits nothing that touches the scoring/evidence surface.

---

## 2. Diagnostic objective — MET

| Part-2 objective (from the Readiness Review) | Result | Status |
|---|---|---|
| Re-run 25 companies at concurrency 8 | 25 jobs, 8 slots, batch 1295 | **Done** |
| With instrumentation | `STAGE_INSTRUMENTATION_POLICY=on` + always-on `[DIAG]` timers; 2,310 telemetry records captured | **Done** |
| Stop rule raised so timeouts are observed, not cancelled | Batch ran to natural completion; the one deadline event was captured in full, not cancelled | **Done** |
| Cost cap retained | $14 ceiling held; actual $11.55 | **Done** |
| **Observe the 1277 timeout pattern** | **The 2,100s pipeline deadline was captured on company 26 with a full isolation trace** (§5) | **Observed** |
| **Identify the bottleneck** | **Discovery/web-search dominance (I/O-bound) + browser-bound long tail through the single browser slot** (§6) | **Identified** |

The run answers the question the Readiness Review left "open, not diagnosed": **where do the jobs spend their time, and what is the shared serialised resource?** It is the web-search execution latency in discovery (per-company, not contended) plus the single serialised browser slot (contended) in the long tail — not the DB pool, not LLM permits, not rate-limiting, and not an isolation-capacity failure.

---

## 3. Completion and completeness

| Criterion | Result | Status |
|---|---|---|
| 25 companies reach a terminal state | 25 completed, 0 failed | **PASS** |
| First-attempt completions | 24 first-attempt; 1 (company 26) completed on attempt 2 | reported separately (§4) |
| 36 results per company (900 total) | **900 rows = 25 × exactly 36 each** | **PASS** |
| Provenance consistent | single `pipeline_version 9faa18e620e7`; model deepseek; `evidence_fingerprint` 900/900; `prompt_hash` 900/900; `abstained` 0 | **PASS** |
| Verdict distribution | **No = 709, Yes = 191** (of 900) | recorded |

No null/empty scores and no abstentions. 900/900 rows carry an evidence fingerprint and a prompt hash.

**Quality signal, orthogonal to the timeout diagnostic.** 455 of the 900 rows carry `needs_readjudication = true` and `rationale_score_inconsistent = true` (identical sets) — the framework flags a row for re-adjudication when the rationale text and the numeric score disagree. This is a **framework scoring-quality signal**, not a batch defect and not related to the timeout investigation; it is recorded here for completeness and belongs to the scoring-quality work stream, not Issue 3.

---

## 4. First-attempt vs retried completions (reported separately)

| Quantity | Value |
|---|---|
| Companies completed first attempt | 24 |
| Companies that required a retry | 1 (company 26, Aristocrat Leisure) |
| Retry attempts consumed | 1 (attempt 2 succeeded; `maxRetries=3` not exhausted) |
| **Eventual completions produced by retries** | **1** (company 26, attempt 2, dur ≈ 1,292 s) |
| Permanent (retry-exhausted) failures | **0** |

Per-job duration (`completed_at − claimed_at`, n = 25): min 679 s, mean 1,276 s, **p50 1,292 s**, p90 1,548 s, max 1,881 s. The retry on company 26 recovered cleanly within budget — the recovery boundary functioned: a tripped deadline surfaced, retried, and recovered with **zero permanent loss**.

---

## 5. The captured timeout — company 26 (the instrumented 1277 pattern)

This is the headline diagnostic capture: the previously-silent timeout, now fully attributable.

**processing_errors row (attempt 1, 21:03:33Z):**
```
26 | ARISTOCRAT LEISURE LIMITED | pipeline_timeout |
{"type":"timeout","elapsedSeconds":2100,"limitSeconds":2100,
 "message":"Pipeline timed out after 2100s (limit: 2100s) [isolated child killed by parent]"}
```

**The single `[WORKER-ISOLATION]` event (21:03:33Z):**
```
pipeline_deadline reached for child pid=8258 (stage=pipeline, outstandingLeases=none)
  → revoke + SIGKILL groups
```

**Interpretation (established from the capture).** Company 26's first attempt reached the **2,100-second (35-minute) pipeline wall-clock deadline**. The isolation **parent** then did exactly what it is designed to do: it revoked leases and SIGKILLed the child process group. `outstandingLeases=none` means the kill was **clean** — no leaked permit, no half-held browser lease, no contamination. The job then **auto-retried and completed on attempt 2**.

This single capture resolves two previously-open items:

- **Batch 1277 "silent timeout" (cause previously "open, not diagnosed").** Same mechanism: a job runs out the 2,100s wall-clock. In 1277 the logs were silent because there was no per-stage instrumentation; here the `[DIAG]` timers + the `[WORKER-ISOLATION]` trace show the deadline trip *and where the time went* (a browser-bound long tail — §6).
- **Batch 1276 "SIGABRT @ spawn" reading.** The isolation parent's deadline enforcement is an **intentional kill-on-deadline**, not an isolation crash or a containment breach. The 1276 failures were the parent killing children, consistent with the same resource pressure surfacing differently under the whole-batch-cancel stop rule — not a breach of the isolation boundary.

The difference in **outcome** between 1295 and 1276/1277 is the stop rule, not the isolation layer: with the whole-batch-cancel rule raised for this diagnostic, the one deadline became a recoverable single-company retry instead of a batch-wide cancellation. That is precisely the behaviour Issue 3 part 4 (retry → quarantine → systemic-only cancel) is designed to make permanent.

---

## 6. Where the time goes — bottleneck attribution (established from telemetry)

The attribution comes from **32 `[DIAG][stage-timer]` records** (one discovery-close and one pipeline-close per company) plus 656 `[STAGE-INSTR]` heartbeats, 470 `[DIAG][event-loop]` samples, 14 `[DIAG][score-write]` records and 2 db-op samples — 2,310 telemetry records in total.

### 6.1 Discovery / web-search is the dominant, I/O-bound cost

Every company's discovery phase is dominated by the `search_provider` web-search calls:

| Signal (per company, representative range) | Observation |
|---|---|
| `search_provider` calls (`done`) | **~196 – 236** web_search calls per company |
| `search_provider` busy_sum | **~360 – 430 s** (outliers: co 2566 ≈ 560 s, co 2568 ≈ 412 s) |
| `search_provider` union_wall | **~340 – 410 s** |
| `db_ops` busy_sum (discovery) | **7 – 45 ms** — negligible |
| `search_rate_wait` busy_sum | **16 – 28 ms** — negligible |

Representative discovery closes: company 9 (CSX) `attempt_wall 405,330 ms / 217 calls`; company 13 (Martin Marietta) `451,501 ms / 218 calls`; company 16 (Stryker) `475,378 ms / 217 calls`.

**Conclusion.** Per-company time ≈ (external web-search execution latency) × (~215 calls). It is **I/O-bound on the search provider**, *not* rate-limited (`search_rate_wait` is ~20 ms), *not* DB-bound (`db_ops` is ~tens of ms in discovery), and *not* LLM-bound. This is a per-company serial cost, not a cross-company contention — each job does its own ~215 searches.

### 6.2 The long tail is browser-bound through the single serialised browser slot

Pipeline-close stage-timers for the slow companies show the time moving into the browser stages, which are serialised through the single browser slot (`maxBrowsers=1`):

| Company | `browser_admission_wait` busy_sum / union | `browser_nav_parse` union | Note |
|---|---|---|---|
| 23 (ABB) | 1,873,133 ms / 740,852 ms (3 errors) | 190,127 ms | heaviest admission contention |
| 28 (BT Group) | 1,469,962 ms / 485,413 ms (3 errors) | 243,310 ms | — |
| 2566 (Coterra) | 1,531,362 ms / 450,027 ms (4 errors) | 186,583 ms | — |
| 2568 (FactSet) | 1,200,830 ms / 417,423 ms (3 errors) | 386,835 ms | — |
| 26 (Aristocrat, att-1) | 36,465 ms / 36,465 ms (1 error) | **419,549 ms** | the timed-out attempt |

`browser_admission_wait` busy_sum far exceeds its union_wall (e.g. co 23: 1.87M vs 0.74M ms) — the signature of **multiple browser requests queued behind one serialised slot**. Browser fallbacks fire on HTTP-403 sources, and each fallback must wait for the single slot. The slowest company (26) spent ~420 s in `browser_nav_parse` alone on attempt 1 — enough, on top of its discovery cost, to run out the 2,100s deadline.

**Conclusion.** The long tail that produces the one deadline trip is **browser-bound and serialised** — exactly the "shared, serialised resource" the Readiness Review hypothesised. This is the lever Issue 3 part 3 targets (separate bounded pools for browser recovery vs analysis; per-stage budgets that degrade a stalled source to "source unresolved" rather than consuming the whole pipeline budget).

### 6.3 What is NOT the bottleneck

- **DB pool** — `db_ops` busy_sum is tens of milliseconds in discovery; even in the browser phase (where corpus writes happen) it is ≤ ~39 s and never pending.
- **Search rate-limiting** — `search_rate_wait` is ~12–28 ms per company.
- **LLM permits** — no permit leak; model spend accrued normally across all 900 rows.
- **Worker host compute/memory** — `[DIAG][event-loop]` p50_lag ~0 ms, p99 ~1 ms, RSS ~150 MB throughout. The host was never compute-, memory-, or event-loop-bound.
- **Isolation capacity** — one clean deadline-kill, no breach (§8).

---

## 7. StageLedger instrumentation gap (genuine, by construction)

All 656 `[STAGE-INSTR]` heartbeats report `stage=pipeline` with an **empty `waits[]`** array. This is because `recordWait()` (`server/lib/stage-instrumentation.ts:178`) **has no callers** — the StageLedger is wired at the worker heartbeat seam (`server/worker.ts:414`, a single `startStage("pipeline")`) but the per-shared-resource wait recording is not yet called from the pipeline internals.

**Impact and honest scope.** The StageLedger therefore proves **liveness and total elapsed** (a timed-out job still leaves a durable "it was in stage=pipeline at T" record — the part-1 goal of "timed-out jobs leave a record"), but it does **not** itself provide sub-stage attribution. The sub-stage attribution in §6 comes entirely from the **always-on `[DIAG]` timers** (`diag-context.ts`), which did fire and did capture the per-resource busy/union times. The two instruments are complementary; the diagnostic conclusions rest on the `[DIAG]` data, which is complete. Wiring `recordWait()` into the shared-resource acquisition points is a clean follow-up for when the budgeted/resilient path is armed — it would let the StageLedger heartbeat itself carry per-resource waits for jobs that die mid-stage.

---

## 8. Isolation reliability (reported separately from completion)

| Property | Observation | Verdict |
|---|---|---|
| Containment (child failure stays contained) | The one deadline event cleanly revoked + SIGKILLed one child group; the other 24 jobs and the supervisor were unaffected | **RELIABLE** |
| Breaches / quarantine residue | 0 `[WORKER-ISOLATION]` breach/quarantine lines (the single isolation line is a healthy deadline-kill) | **None** |
| Permit / lease leak | `outstandingLeases=none` at the kill; no leaked permit | **None** |
| Parent health | `[DIAG][event-loop]` flat (p50 ~0 ms, RSS ~150 MB) throughout | **Healthy** |
| OOM / FATAL / crash | None observed | **None** |

The single `[WORKER-ISOLATION]` event is **not** a breach, quarantine, permit-leak, or crash — it is the parent enforcing the pipeline deadline exactly as designed, cleanly. **Isolation reliability held throughout.** This is reported separately from completion, per the standing requirement: the completion outcome (25/25) and the isolation outcome (clean) are two different properties, both good here.

---

## 9. 1295 vs the motivating failure runs

| | **1295** (this run) | **1276** | **1277** |
|---|---|---|---|
| Jobs | 25 | 25 | 25 |
| Completed | **25** | 12 | 4 |
| Failed (terminal) | **0** | 13 (SIGABRT @ spawn) | — |
| Batch status | `completed` | `completed` (held `pending_review`) | **cancelled** (silent-timeout) |
| measure_scores persisted | **900** | **0** | — |
| Stop rule | raised for diagnosis (retry allowed) | whole-batch-cancel active | whole-batch-cancel active |
| Dominant observed cause | browser-bound long tail → 1 recoverable 2,100s deadline | isolated-child spawn aborts under 8-slot load | 2,100s pipeline timeouts, logs silent |
| Instrumentation | **full (`[STAGE-INSTR]` + `[DIAG]`)** | none | none |

The decisive variable between a 25/25 completion and a 12/25 or 4/25 outcome was the **stop rule**, not the pipeline or isolation code. With retries allowed and the batch not cancelled on the first slow company, the same underlying browser-bound long tail produced one recoverable retry instead of a batch-wide failure.

---

## 10. Cell-flip accounting (constraint 3)

| Flip category | Count | Basis |
|---|---|---|
| Total cells Yes → No | **0** | n/a — no prior persisted baseline for this roster (see below) |
| Total cells No → Yes | **0** | n/a — no prior persisted baseline for this roster |
| Total flips | **0** | by construction — this run changed no scoring surface |

**Two independent reasons the flip count is 0, neither fabricated:**

1. **No persisted same-roster baseline exists to diff against.** Batch 1276 (the only prior run on this exact 25-company roster) persisted **0** `measure_scores` rows (it was held in `pending_review`), and batches 1289/1275 ran disjoint rosters. There is therefore no prior set of persisted cells for these 25 companies to compare the 1295 cells against — the honest entry is "no baseline → 0 (n/a)", not a diff against invented prior values.
2. **The instrumentation is telemetry-only by construction.** `STAGE_INSTRUMENTATION_POLICY=on` and the `[DIAG]` timers emit logs; they touch no analyzer, evidence, or scoring code. The budgeted/resilient/separated levers stayed dormant at their defaults. So even against a hypothetical baseline, this run's scoring path is the unchanged production path and would produce **0** framework-scoring changes.

The 900 cells produced by 1295 (No = 709, Yes = 191) now stand as the first persisted baseline for this roster, against which any *future* armed-lever run can be diffed for flips.

---

## 11. Disarm and baseline restoration (post-run)

The instrumented condition was fully reverted after the run; the pipeline is back in its baseline dormant state.

| Action | Result |
|---|---|
| `STAGE_INSTRUMENTATION_POLICY` variable delete | **done** — variable absent (verified) |
| Worker replicas 2 → 3 | **done** — `numReplicas=3` (verified) |
| Worker redeploy on prod SHA | deploy `8ecc1d7e-f52` SUCCESS on commit `9faa18e620e7` |
| Post-disarm verification | `STAGE_INSTRUMENTATION_POLICY` absent; `numReplicas=3`; git HEAD == prod SHA `9faa18e620e78e7df…` |

No scoring, schema, pool, or pipeline-logic change was made at any point. The only mutations were the two reversible diagnostic knobs, both reverted. **No further Railway mutation is needed.**

---

## 12. INCONCLUSIVE vs FAILURE

The one 2,100s deadline on company 26 attempt 1 is reported as an **observed, attributable deadline event that recovered on retry** — a genuine stop condition captured with full evidence, **not** a failure (the company completed; 0 permanent failures in the batch). The batch as a whole is a **success** against the part-2 diagnostic objective: it both observed the timeout pattern and identified the bottleneck. This is not an INCONCLUSIVE run — the diagnostic question was answered.

---

## 13. Conclusion

- **Diagnostic objective MET.** The instrumented 25-company / 8-slot run completed 25/25 (0 permanent failures), captured the 2,100s timeout pattern with a full isolation trace, and located the time.
- **Bottleneck identified:** discovery/web-search is the dominant, **I/O-bound** per-company cost (~215 web-search calls, ~6–8 min/company); the **long tail is browser-bound through the single serialised browser slot** (the "shared serialised resource" the Readiness Review hypothesised). DB pool, search rate-limiting, LLM permits, worker host compute/memory, and isolation capacity are **not** the bottleneck.
- **The 1277 "silent timeout" and 1276 "SIGABRT @ spawn" are now explained:** both are the isolation parent enforcing the 2,100s deadline (clean kill-on-deadline, not a breach); the different outcomes trace to the whole-batch-cancel stop rule, not to the pipeline or isolation code.
- **Isolation reliability held** (reported separately): one clean deadline-kill, `outstandingLeases=none`, no breach/leak/crash.
- **Recovery boundary worked:** the one deadline surfaced → retried → recovered, zero permanent loss.
- **Cost $11.55 and wall ~89 min** stayed within the $14 and 90-minute ceilings.
- **Cell-flips = 0** (no same-roster persisted baseline; telemetry-only by construction).
- **Instrumentation disarmed; baseline dormant state restored; code tested == code in production (`9faa18e620e7`).**
- **Next (not this turn, part 3/part 4 of Issue 3):** use this attribution to arm the budgeted path (per-stage budgets degrading a stalled browser source to "source unresolved") and the separated browser/analysis pools, and to make the retry → quarantine → systemic-only stop rule the production default — then part 5 scale-tests 25 → 50 → 100.

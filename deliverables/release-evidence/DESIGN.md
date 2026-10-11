# Worker Isolation — Design (batch 1274 root cause)

Branch: `fix/worker-isolation` (from `35884ee`). Status: design + implementation, **not deployed**.

## 1. Problem statement (from evidence, not assumption)

Batch 1274 failed because the worker's single Node event loop was blocked for long stretches by synchronous CPU work in the analyze/scoring phase. Everything that needs the loop to run on time then failed together: BullMQ lock renewal (~1.25 M ms since the last renewal against a 300 k ms lock), Redis PING (7–41 s RTT), and PG pool acquisition (connections checked out by a job could not be released while the loop was stuck). The visible results were "could not renew lock", stalled redelivery, and attempt 2 with `last_error=NULL`.

`PROFILE_EVIDENCE.md` measured this directly with a stubbed-network harness that ran the real pipeline code:

| Run | Blocked share of analyze wall time | ELD p99 / max | Longest blocking slice |
|---|---|---|---|
| c4 (4 concurrent jobs) | 64 % (38 stalls, 44.2 s of 69.5 s) | 534 ms / 8254 ms | 8846 ms |
| c1 (1 job, control) | 17 slices, 13.5 s | — | 5864 ms |

**Verdict: DISTRIBUTED.** 312 distinct application functions across 28 modules. Top-1 function = 16.3 % (tokenize), top-3 = 43.1 %, top-5 = 54 %, HHI 0.081, GC 15–20 %. No single function reaches 20 % of blocking time. The single-job control has the same shape (HHI 0.071).

**What follows from the verdict:**
- Optimising one or two hot functions cannot fix this. Removing the top function entirely still leaves about 84 % of the blocking, and the longest single-job slice (5.9 s) is already longer than the stall budget.
- Yielding inside each hot loop would mean editing dozens of functions across 28 modules. That spreads risk across scoring logic, which is the opposite of a minimal fix.
- The CPU work has to move **off the thread that owns lifecycle**: claim, heartbeat, ownership watch, BullMQ lock renewal, Redis, and terminal writes.

## 2. Rejected alternatives

| Option | Why rejected |
|---|---|
| Lengthen the lock, raise pool size or timeouts, add replicas | Explicitly out of scope, and none of them removes the blocking. Lock renewal would still starve. Renewal-only workarounds are excluded. |
| Optimise hot functions | The DISTRIBUTED verdict shows no single function to target (§1). |
| `worker_threads` | This would share the process heap and GC with the parent. GC accounts for 15–20 % of blocking, and a full-heap GC pauses every isolate in the process. Module singletons (pg Pool, LLM semaphore, browser, `AsyncLocalStorage` contexts) would need the same brokerage anyway. A thread also cannot be hard-killed safely while it holds native resources such as Puppeteer or child processes. |
| One long-lived "scoring server" child per replica | Concurrent jobs would share one blocked loop again, so the problem moves rather than disappears. It would also need a job multiplexer. |
| Run only the analyze phase in a child | The fetch and discovery state, BatchFetchState and the lifecycle would be split across two processes partway through a job. That is more IPC and more failure modes than isolating the whole pipeline. |

**Chosen: one child process per job attempt (`child_process.fork`).** It is the smallest boundary that fully separates the CPU work from lifecycle ownership: the code inside the child is byte-for-byte the existing `runAnalysisPipeline`.

## 3. Boundary

```
 worker-main (PARENT, one per replica)              job child (one per running job)
 ─────────────────────────────────────              ──────────────────────────────────
 BullMQ consume + lock renewal                      runAnalysisPipeline(...) UNCHANGED
 claimJob / attempt_token / lifecycle               own lifecycle (same token+deadline)
 heartbeat, ownership watch (30 s)                  own diag ctx + LLM usage ctx
 credit / off-peak / cancel gates                   own pg Pool (budgeted, §4)
 load company / framework / measures                NO Redis connection
 JOB_TIMEOUT watchdog + pipeline/job deadline kill   NO usage pool (rows → parent)
 completeJob / failJob / retry / batch counts       permits requested from parent (§5)
 permit broker: LLM 8 / browser 1 / subproc 6
 usage-row sink (usage pool max 2)                  parent-death watchdog thread
```

What stays where:
- **The parent keeps everything that must stay responsive or must happen exactly once:**
  - claim and ownership (`claimJob`, `attempt_token`), the heartbeat and the ownership watch;
  - BullMQ lock renewal and the Redis cancel cache;
  - the hard watchdog;
  - all terminal writes (`completeJob`, `failJob`, retry enqueue, batch counters, `maybeHandleBatchCompletion`).
  
  `worker.ts` lines 466–732 (post-pipeline handling) are untouched.
- **The child runs only `runAnalysisPipeline`.** Inside it builds:
  - its own `AttemptLifecycleState` from the same `{jobId, batchId, attemptNumber, deadlineAt, attemptToken}`, so every SQL-fenced score write it performs carries the same ownership predicate as today;
  - the same diag context, `attemptId` and LLM usage context, so logs, `[LIFECYCLE-FENCE]` and `[SCORING-REQ]` markers and score provenance stay correlated.
- **The call-site change in `worker.ts` is one expression.** Inside the existing `raceWithWatchdog(...)`, `runAnalysisPipeline({...})` becomes `runPipelineIsolated({...})` when `WORKER_ISOLATION_ENABLED=true`. The watchdog, revoke and heartbeat code around it is unchanged.
- **Gating.** The feature is off by default: `WORKER_ISOLATION_ENABLED` unset means identical code paths to `35884ee`.

Data crossing the boundary uses Node `serialization: "advanced"` (structured clone), so `Date`, `Map` and `Set` in the company, framework, measure and BatchFetchState objects arrive intact.

## 4. DB budget partitioning (partition, not multiply)

The per-replica budgets are **unchanged**: `PG_POOL_MAX=20` and `PG_USAGE_POOL_MAX=2`. Under isolation they are divided between processes rather than replicated into each one.

**Main pool (20 per replica):**
- Parent reserve `R = WORKER_ISOLATION_PARENT_PG_RESERVE` (default 4). It covers claim, 4 × heartbeat, 4 × ownership watch, terminal writes, the reconciler and the gates. All of these are short single statements.
- Per-child budget `C = floor((PG_POOL_MAX − R) / WORKER_CONCURRENCY) = floor(16 / 4) = 4`. It is computed from the *configured maximum* `WORKER_CONCURRENCY`, so adaptive concurrency (minimum 2) can only lower total use.
- Main-pool ceiling = `R + WORKER_CONCURRENCY × C = 4 + 16 = 20 = PG_POOL_MAX`. Together with the usage pool (2, below) the **full replica inventory is 22 = baseline 20 + 2** (3 replicas × 22 = 66, exactly as today). At `WORKER_CONCURRENCY=10`, C = 1 and the total is 4 + 10 + 2 = 16. The full per-pool inventory with file:line is in `RESPONSIBILITY_TABLE.md` §1 (test A1).
- Enforcement:
  - The child is forked with `PG_POOL_MAX=C` in its environment; `server/db.ts` already reads that variable.
  - The parent's pool is capped at `R` by a role check in `db.ts`. `worker-main.ts` imports a side-effect module first that sets `CIQ_PROCESS_ROLE=worker-parent`. The cap applies only when that role is set **and** `WORKER_ISOLATION_ENABLED=true`. The web service and the flag-off worker keep `PG_POOL_MAX`.
- If `C` would be below 1, the parent refuses to fork and fails the job with an explicit error. It never silently oversubscribes.

**Usage pool (2 per replica):** children open **no** usage pool. `llm-usage.ts` `enqueueUsageEvent` forwards each row to the parent over IPC when running as a child. The parent pushes it into its existing buffer, which flushes batched multi-row INSERTs on the existing pool (max 2). Total stays 2. Splitting 2 connections across 4 children was not possible without either multiplying or starving.

**Redis:** none of `pipeline.ts`'s static imports reach `redis.ts` (verified by grep; the only reference is a dynamic import in a cancel-only `storage.ts` path that the pipeline does not call). Children therefore hold **zero** Redis connections, and replica Redis connection counts are unchanged.

**Trade-off (stated plainly):** today one job can momentarily use up to 20 connections when the others are idle. Under isolation a job is hard-capped at 4. In-job DB concurrency is bounded by in-flight measures, and those are bounded by LLM permits (8 per replica, shared). The pool-acquire timeouts in 1274 came from connections held across blocked loops, not from a shortage of connections. The cap still needs staging evidence; `R` is the single tunable and does not change the replica total.

## 5. Semaphore brokerage (per-replica limits stay per-replica)

Three in-process semaphores define per-replica limits today. A naive per-job process would multiply each by 4. Each is brokered by the parent instead:

| Permit | Limit (unchanged) | Hook |
|---|---|---|
| LLM | `LLM_MAX_CONCURRENCY=8` | `ai-providers.ts` `acquireLlmSlot`/`releaseLlmSlot` |
| Browser | `MAX_CONCURRENT_BROWSER=1` | `processor.ts` `acquireBrowserSlot`/`releaseBrowserSlot` |
| PDF subprocess | `MAX_CONCURRENT_SUBPROC=6` | `processor.ts` `acquireProcSlot`/`releaseProcSlot` |

**Protocol** (`server/lib/isolation-ipc.ts`, leaf module, no imports from the pipeline):
- **Requesting a permit.** When `CIQ_ISOLATED_CHILD=1`, each acquire function's first line delegates to `remoteAcquire(kind, signal)`. The child sends `{t:"acquire", id, kind}` and the parent runs the **real** local semaphore (FIFO and cancellable waiter semantics unchanged), then replies `{t:"granted", id}`. `release` sends `{t:"release", id}`.
- **Cancellation while waiting.** If the child's `AbortSignal` fires while it waits, it sends `{t:"cancelAcquire", id}`:
  - for LLM permits, the parent aborts its own waiter (no permit is taken);
  - for browser and subprocess permits, which have no signal, the parent releases the permit immediately on grant.
  
  If a grant arrives after a local abort, the child releases it straight away.
- **Leak-proofing.** The parent records every grant per child. When a child exits for any reason (normal exit, crash, SIGKILL, OOM), every outstanding permit is released. A dead child can never strand LLM or browser capacity.
- **Cost.** Permit round-trips are local IPC and microseconds-scale. They are negligible next to a 400 ms+ LLM call. The parent stays responsive to grant permits because it does no CPU work.

**Known residual:** each child that uses the browser launches its own Chromium. Only one page is ever active per replica (permit = 1), but up to 4 idle Chromium processes can be alive. Each one dies with its child (§7). This is called out as a memory risk to watch in staging.

## 6. IPC message set

**Parent → child**

| Message | Purpose |
|---|---|
| `init` | `{batchId, jobId, attemptId, attemptNumber, attemptToken, deadlineAt, companyId, frameworkId, workspaceId, company, framework, measures, skipFetch, skipDiscovery, sourceBatchId, batchFetchState}` |
| `revoke` | `{reason}`: parent lifecycle revoked (watchdog, ownership lost). The child calls `revokeAttempt(childLifecycle, reason)`, which aborts in-flight HTTP through the attempt `AbortSignal`. |
| `cancel` | Batch cancel observed by the parent's Redis cache (polled every 500 ms). The child flips its registered `BatchCancelSource`, so `cancelCheck`, `assertDispatchAllowed` and `requestAbortSignal` all see it. |
| `granted` | `{id}` |

**Child → parent**

| Message | Purpose |
|---|---|
| `ready` | Modules loaded. |
| `acquire` / `release` / `cancelAcquire` | Permits (§5). |
| `usage` | `{row}`: LLM usage row (§4). |
| `stage` | `{stage}`: last diag stage, used in crash messages. |
| `result` | `{result, revokedReason, batchFetchState}`: pipeline returned. |
| `error` | `{name, message, stack, code, provider, failureClass}`: pipeline threw. The parent rebuilds `ProviderScoringError` and `LifecycleCancelledError` so `isProviderQuotaError` and the existing catch block behave identically. |

If the child's lifecycle was revoked internally (for example the pipeline's own `PIPELINE_TIMEOUT_MS`), the parent mirrors the reason onto its lifecycle. The existing `"Cancelled"` → watchdog-style final-failure mapping in `worker.ts` then picks up the same `revokedReason`.

**BatchFetchState** (the batch-scoped host circuit breaker) is seeded into the child from the parent's map at start. The child's final state is merged back at the end: union of broken hosts, maximum of slow counts. **Semantic difference:** a host tripped by job A becomes visible to jobs already running at the same time only when A finishes, not instantly. Jobs started after A finishes see it immediately, as today.

## 7. Deadlines, cancellation, crash recovery, retry classification

**Two parent-owned hard deadlines** (`job-isolation.ts` L188-202). Both are timers on the parent loop, which is never blocked by pipeline CPU:
- **Pipeline deadline**: `PIPELINE_TIMEOUT_MS` from spawn, the same env var as `pipeline.ts` L100 (code default 540 s; production 35 min). Normally the child's own in-process timeout fires first and reports the usual result. The parent timer is the backstop for a child that is blocked or hung.
- **Job deadline**: `lc.deadlineAt = claimTime + JOB_TIMEOUT_MS` (`worker.ts` L339; code default 600 s; production 40 min).
- On either deadline the parent calls `revokeAttempt(lc, "pipeline_timeout" | "job_watchdog_timeout")` and **immediately SIGKILLs** every process group of the child. No cleanup grace applies after a deadline:
  - the cancel/revoke grace (10 s → SIGTERM → +5 s SIGKILL) is pre-empted;
  - the 2 s post-report exit grace is cut off.
  
  So neither dispatch permission (the lifecycle is revoked) nor persist permission (child writes are fenced in SQL by `deadlineAt` and the token) can outlive a deadline.
- `raceWithWatchdog(..., JOB_TIMEOUT)` in `worker.ts` is unchanged and stays as the outer guard.

**Cancellation:**
- The parent polls `cancelCheck` every 500 ms and forwards `cancel`. The pipeline returns `"Cancelled"` at its next checkpoint.
- A child that ignores it is SIGTERMed after `WORKER_ISOLATION_KILL_GRACE_MS` and SIGKILLed 5 s later. If a deadline comes first, the child is killed at the deadline instead.
- Either way the outcome stays a cancellation (test D6).

**Outcome delivery (no success while work is alive):**
- `result`/`error` only *records* the outcome. The parent settles on child **exit**: it SIGKILLs any stragglers in the child's groups, polls until every group is gone (≤ 2 s), releases the child's permits, and only then resolves.
- A child that reports but does not exit is SIGKILLed after `WORKER_ISOLATION_EXIT_GRACE_MS` (2 s).

**Retry classification** (`classifyIsolatedOutcome`, one row per event, fed into the unchanged `worker.ts` policy now in `retry-policy.ts`):

| Event | Outcome | Retry |
|---|---|---|
| admin cancel / forced kill after cancel | `"Cancelled"` | none (cancellation) |
| ownership lost | `"Cancelled"`, fenced to `Job watchdog timeout … (attempt revoked: ownership_lost)`; stale `failJob` is a no-op | none, no duplicate |
| job deadline | `Job watchdog timeout: isolated child killed at job deadline` | none |
| pipeline deadline | `Pipeline timed out after Ns` (same string as in-process) | retriable (existing policy) |
| crash / OOM / external kill | `Isolated job child exited unexpectedly (code/signal/stage)` | retriable, non-NULL `last_error` |

**Parent death:**
- Graceful exit: `process.on("exit")` SIGKILLs every live group.
- SIGKILL/OOM of the parent (the exit hook does not run): each child runs a **watchdog `worker_thread`** (`job-child.ts` L35) that polls `process.ppid` every 250 ms. It sits on its own thread, so it works even when the child's main loop is blocked in synchronous CPU work. When the parent is gone it SIGKILLs registered descendant groups and its own group. `disconnect` triggers the same path when the main loop is free.
- Chromium is launched by Puppeteer with `detached:true` (its own group), so the child registers its pid with the parent via a `pgroup` message (`processor.ts` L1035).

**Documented limits:**
- A grandchild that calls `setsid` itself and is not registered escapes the group kill.
- Parent-death detection takes up to 250 ms.
- Outcome delivery can lag the report by up to exit grace (2 s) + group reap (2 s).

## 8. Cost and measured overheads

| Item | Value |
|---|---|
| Child cold start (import `pipeline.ts` via tsx, sandbox 2 vCPU) | 1.65 s import, 1.9 s wall |
| Child baseline RSS | ~200 MB |
| 4 children, baseline only | ~0.8 GB on top of the ~150 MB parent |

The cold start is negligible against multi-minute jobs. The baseline RSS is offset by GC pressure no longer accumulating in one 1.2 GB heap. **Staging must confirm replica memory headroom** before the flag is turned on in production.

## 9. Constraints honoured

- No changes to `PG_POOL_MAX`, `PG_USAGE_POOL_MAX`, `PG_CONNECTION_TIMEOUT_MS`, `WORKER_LOCK_DURATION_MS`, `JOB_TIMEOUT_MS`, `WORKER_CONCURRENCY`, `LLM_MAX_CONCURRENCY`, `MAX_CONCURRENT_BROWSER` or replica count.
- Not a renewal-only workaround: the lock still renews on the parent loop, which now does no CPU work.
- Default off. No merge or deploy; the branch is pushed for review only.

## 10. Test plan (deterministic, no network): `server/lib/job-isolation.test.ts`, 22 tests

1. **Blocked processor:** the child busy-loops for 3 s and the parent event-loop lag stays under 100 ms.
2. **Cancellation:** `cancel` → the child returns `Cancelled`, with no permit leak.
3. **Revoke (ownership lost), child ignores SIGTERM:** the group is SIGKILLed, and the result is fenced to non-retriable.
4. **Crash** holding an LLM permit: explicit retriable error, and the permit is released.
5. **Permit brokerage:** LLM max 8, browser max 1.
6. **Usage forwarding:** rows reach the parent, and the child has no usage pool.
7. **Full 36-measure real pipeline** in the child (stub PG/providers).
8. **A1** pool inventory 22 = baseline. **B1** pipeline deadline. **B2** job deadline with nothing written after `deadlineAt`. **C** (×2) supervisor SIGKILLed while the child is blocked or idle. **D** retry table. **D6** cancel + deadline. **E1/E1b** queued acquisitions withdrawn. **E2/E3** no success while background work is alive. **E4** subprocess max 6. **F1** child startup audit. **G1** 4 CPU-bound children on 2 CPUs.
9. **Existing suites** re-run against the branch (see `TEST_RESULTS.md`).

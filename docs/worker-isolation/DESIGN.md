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
 JOB_TIMEOUT watchdog (raceWithWatchdog)            NO usage pool (rows → parent)
 completeJob / failJob / retry / batch counts       permits requested from parent (§5)
 permit broker: LLM 8 / browser 1 / subproc 6
 usage-row sink (usage pool max 2)
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
- Total ceiling = `R + WORKER_CONCURRENCY × C = 4 + 16 = 20 = PG_POOL_MAX`. 3 replicas × 20 = 60, exactly as today.
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

## 7. Deadlines, cancellation, crash recovery

**Deadline (hard, parent-owned):**
- **Watchdog fires.** The existing `raceWithWatchdog(..., JOB_TIMEOUT, onFire)` still runs in the parent. Its timer can now always fire on time because the parent loop is not blocked. `onFire` revokes the parent lifecycle, which is forwarded to the child as `revoke`.
- **Escalation.** The supervisor's own escalation timer arms at `deadlineAt` *and* on revoke or cancel: after `WORKER_ISOLATION_KILL_GRACE_MS` (default 10 s) it sends SIGTERM to the child's **process group**, and after another 5 s it sends SIGKILL. Children are forked `detached:true` (their own group), so Chromium and pdftotext descendants die with them.
- **Terminal handling.** Terminal handling (`failJob`, final failure, no retry for watchdog timeouts) is the existing code. The job cannot be left leased: the parent writes the terminal state on its own responsive loop, and child writes after revocation are refused by the existing SQL fence (`deadlineAt` and token predicates).

**Cancellation:**
- The parent's existing composed `cancelCheck` (Redis cache, watchdog flag, revoked lifecycle) is polled and forwarded as `cancel`.
- The pipeline returns `"Cancelled"` at its next checkpoint, and the parent runs the unchanged `cancelTrace e/f` and `failJob("Cancelled (batch cancelled)")` path.
- A child that does not finish within the grace period is killed. The lease is released by the parent's terminal write either way.

**Crash recovery:**
- A child exit without `result` or `error` (non-zero code, signal, OOM kill, IPC disconnect) rejects with an explicit error, for example: `Isolated job child exited unexpectedly (code=1 signal=null stage=analyze)`.
- That flows into the existing catch path, so `failJob` records a **non-NULL `last_error`**. It is retriable under `isRetriableError` (bounded by `MAX_RETRY_ATTEMPTS`) unless the exit followed a revoke or deadline, in which case the message carries `Job watchdog timeout` and is final, as today.
- If the parent dies, the IPC channel closes; children listen for `disconnect` and exit immediately (no orphans). Parent `exit` also SIGKILLs every live child group synchronously.

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
- Default off. No push, merge or deploy.

## 10. Test plan (deterministic, no network)

1. **Blocked processor:** the child busy-loops for 3 s. A parent event-loop probe stays under 100 ms lag throughout, and parent timers fire on schedule.
2. **Cancellation:** the parent sends `cancel`. The child's `cancelCheck` becomes true within one poll, the child returns `Cancelled`, it exits, and no permits leak.
3. **Deadline:** a child that ignores `revoke` is SIGTERM/SIGKILLed after the grace period. The supervisor rejects with a watchdog error, and the process group is gone.
4. **Crash:** the child calls `process.exit(1)` mid-job. The supervisor rejects with an explicit non-empty message, it is classified retriable, and permits held by the child are released.
5. **Permit brokerage:** across 4 children each asking for 5 LLM permits, the parent observes a maximum of 8 concurrent grants. Browser maximum is 1. Every permit is released.
6. **Usage forwarding:** a usage row emitted in the child arrives in the parent buffer. The child never creates a usage pool.
7. **Full 36-measure run** through the isolated path with stubbed LLM, storage and score writes: 36 scores produced, `success=true`, and the parent loop stays responsive.
8. **Existing suites** re-run against the branch and compared to the `35884ee` baseline (94/97 pass, with 3 pre-existing failures).

// ─── Lifecycle / cancellation / ownership fencing ────────────────────────────
// One durable contract for admin-cancel, supersession, timeout and ownership
// loss: STOP, NO RETRY, TERMINAL STATE.
//
// Authority model:
//   • Postgres is authoritative: batch_runs.status + analysis_jobs.attempts
//     (the owning-attempt identity, incremented atomically by claimJob) +
//     analysis_jobs.status='claimed'. Every authoritative write is guarded
//     atomically against these in ONE statement or ONE short DB-only
//     transaction that locks the job row (FOR UPDATE) and share-locks the batch
//     row (FOR SHARE, so a concurrent cancel/supersede UPDATE linearises
//     strictly before or after the write, never in between).
//   • The Redis cancel flag (markBatchCancelled / isBatchCancelledCached) and
//     the in-process revoked flag are NON-authoritative notifications used only
//     to stop dispatching new work early and to abort in-flight HTTP. If they
//     are lost, the SQL guards still refuse stale writes.
//
// ══ SHARED BATCH/JOB LOCK ORDER (every lifecycle path) ══════════════════════
//   Canonical "job-side" lock statement (CANONICAL_JOB_LOCK below):
//       SELECT … FROM analysis_jobs j JOIN batch_runs b ON b.id = j.batch_id
//       WHERE j.id = $job [AND <rule predicate>]
//       FOR UPDATE OF j FOR SHARE OF b
//   i.e. job row EXCLUSIVE, batch row SHARE, in one statement, at the start of
//   a short DB-only transaction; the write follows; COMMIT. Used by:
//     • persistence   — runFencedWrite / storage.replaceMeasureScoresFenced
//     • claim         — storage.claimJob           (claimPredicate)
//     • success       — storage.completeJob(owner)  (successCompletionPredicate)
//     • failure       — storage.failJob(owner)      (failureRecordPredicate)
//   "Batch-side" writers take ONLY the batch row, exclusively, via a single
//   autocommit UPDATE batch_runs … (row lock FOR NO KEY UPDATE):
//     • cancellation  — storage.cancelBatchRun
//     • supersession  — storage.createBatchRun's UPDATE … status='cancelled'
//                       (then notifySupersededBatches: Redis + queue only)
//     • batch terminal/progress — completeBatchRun, setBatchRunStatus,
//                       incrementBatchCompleted/Failed, touchBatchHeartbeat
//   Reconciliation (reconciler.ts) only issues single autocommit statements on
//   ONE table each (analysis_jobs OR batch_runs), never both in one txn.
//   Rule: nothing ever holds a batch_runs row lock and then requests an
//   analysis_jobs row lock. touchBatchHeartbeat / increment* are always called
//   AFTER the job-side transaction has committed (never inside it — that would
//   self-block on our own FOR SHARE from a second pool connection).
//
//   Why no deadlock: a wait-for cycle needs some txn holding b and waiting for
//   j. Batch-side writers hold only b and never request j; job-side txns
//   request j then b(SHARE). SHARE locks of different job-side txns on the
//   same b are compatible, and distinct jobs never contend on each other's j.
//   Two job-side txns on the SAME j serialise on j before touching b. Hence
//   the wait-for graph is acyclic.
//
//   Why FOR SHARE OF b linearises vs cancel/supersede: FOR SHARE conflicts
//   with the row lock taken by UPDATE batch_runs. Either
//     (A) the cancel/supersede UPDATE commits first: the job-side SELECT
//         blocks on b (or starts after), then READ COMMITTED re-evaluates its
//         WHERE against the committed row (EvalPlanQual) → b.status <>
//         'running' → 0 rows → write refused; or
//     (B) the job-side SELECT locks b first: the UPDATE blocks until the
//         job-side txn commits, so the write lands entirely BEFORE the cancel;
//         every later attempt to write then hits case (A).
//   There is no interleaving in which a write observes 'running' and the
//   cancel commits before that write does.
//
// ══ REVOCATION PATHS (in-process, non-authoritative fast path) ══════════════
//   #1 worker.ts JOB_TIMEOUT watchdog       → revokeAttempt("job_watchdog_timeout")
//   #2 pipeline.ts PIPELINE_TIMEOUT_MS      → revokeAttempt("pipeline_timeout")
//      (inside the withTimeout timer callback, at the timer instant)
//   #3 discovery.ts DISCOVERY_TIMEOUT_MS    → revokeAttempt("discovery_timeout")
//      (inside searchCompanyDocuments' timer callback, only if still unsettled)
//   Independent: none waits for another. All fire before the attempt's
//   failure result reaches failJob, i.e. before any retry/requeue. The SQL
//   deadline + ownership predicates remain the authority.
//
// ══ WRITE-CLASS RULES (separate, composed from the predicate helpers) ═══════
//   (i)   Score persistence  = owner ∧ batchRunning ∧ deadline   (scorePersistPredicate)
//   (ii)  Success completion = owner ∧ batchRunning ∧ deadline   (successCompletionPredicate)
//         completeJob + completeBatchRun: ownership-keyed, refused if the
//         batch is terminal or the attempt is stale; completeBatchRun refuses
//         cancelled/failed/completed atomically in its own WHERE.
//   (iii) Failure recording  = owner ONLY                        (failureRecordPredicate)
//         The owning attempt ALWAYS records its failure, even if the batch is
//         terminal. failJob writes ONLY analysis_jobs. Batch running → job
//         'pending' (retry) or 'failed' (attempts exhausted), as before.
//         Batch NOT running (cancelled/superseded/terminal) → job 'failed',
//         reported batchTerminal=true: never requeued, never counted into
//         failed_jobs, and batch_runs.status is never touched (so a cancelled
//         batch can never be resurrected to running/completed by a failure).
//   (iv)  Cancellation cleanup: idempotent; authoritative in PG
//         (cancelBatchRun / supersession UPDATE); Redis flag + BullMQ purge
//         are best-effort notifications whose failure is logged and ignored.
//
// This module is side-effect-free at import (no DB / Redis handles) so it can
// be imported by discovery/pipeline scripts and unit tests.
import { sql, type SQL } from "drizzle-orm";
import { getDiagContext, type DiagContext, type AttemptLifecycleState } from "./diag-context.js";

// ─── Cancellation error recognised by pipeline + worker ──────────────────────

export class LifecycleCancelledError extends Error {
  readonly reason: string;
  constructor(reason: string, where?: string) {
    super(`Cancelled (${reason}${where ? ` at ${where}` : ""})`);
    this.name = "LifecycleCancelledError";
    this.reason = reason;
  }
}

export function isLifecycleCancelledError(e: unknown): e is LifecycleCancelledError {
  return !!e && typeof e === "object" && (e as any).name === "LifecycleCancelledError";
}

// ─── Non-authoritative cancel notification source ────────────────────────────
// cancellation.ts registers isBatchCancelledCached here at load. Kept as an
// injectable registry so discovery does not have to import Redis.

export type BatchCancelSource = (batchId: number) => boolean;
let cancelSource: BatchCancelSource | null = null;

export function registerBatchCancelSource(fn: BatchCancelSource | null): void {
  cancelSource = fn;
}

export function isBatchCancelNoticed(batchId: number | null | undefined): boolean {
  if (batchId == null || !cancelSource) return false;
  try { return cancelSource(batchId); } catch { return false; }
}

// ─── Per-attempt in-process lifecycle state (lives in the diag context) ──────

export function createAttemptLifecycle(opts: {
  jobId: number;
  batchId: number;
  attemptNumber: number;
  deadlineAt: Date | null;
}): AttemptLifecycleState {
  return { ...opts, revoked: false, revokedReason: null, abort: new AbortController() };
}

/** Revoke this attempt's permission to dispatch/persist (idempotent). */
export function revokeAttempt(lc: AttemptLifecycleState | null | undefined, reason: string): void {
  if (!lc || lc.revoked) return;
  lc.revoked = true;
  lc.revokedReason = reason;
  try { lc.abort.abort(new LifecycleCancelledError(reason)); } catch { /* never throw */ }
  console.warn(`[LIFECYCLE-FENCE] attempt revoked reason=${reason} (job=${lc.jobId} attempt=${lc.attemptNumber} batch=${lc.batchId})`);
}

/**
 * Returns why the current attempt may no longer dispatch new work, or null.
 * Order: in-process revocation → attempt deadline → batch cancel notification.
 */
export function dispatchRevokedReason(ctx: DiagContext | undefined = getDiagContext(), now: number = Date.now()): string | null {
  if (!ctx) return null;
  const lc = ctx.lifecycle;
  if (lc?.revoked) return lc.revokedReason || "revoked";
  if (lc?.deadlineAt && now >= lc.deadlineAt.getTime()) return "deadline_elapsed";
  if (isBatchCancelNoticed(ctx.batchId ?? lc?.batchId)) return "batch_cancelled";
  return null;
}

/** Dispatch gate: throws LifecycleCancelledError when new work must not start. */
export function assertDispatchAllowed(where: string, ctx: DiagContext | undefined = getDiagContext()): void {
  const reason = dispatchRevokedReason(ctx);
  if (!reason) return;
  console.warn(`[LIFECYCLE-GATE] dispatch refused at ${where} reason=${reason} (batch=${ctx?.batchId ?? "-"} job=${ctx?.jobId ?? "-"} attempt=${ctx?.attemptNumber ?? "-"})`);
  throw new LifecycleCancelledError(reason, where);
}

/**
 * AbortSignal for one outbound request: aborts when the attempt is revoked
 * (watchdog/pipeline timeout) or a batch cancel is noticed (polled from the
 * in-memory cache — no network). Call dispose() in finally.
 */
export function requestAbortSignal(
  ctx: DiagContext | undefined = getDiagContext(),
  pollMs = 250,
): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const fire = (reason: string) => {
    if (!ac.signal.aborted) ac.abort(new LifecycleCancelledError(reason, "in-flight request"));
  };
  const parent = ctx?.lifecycle?.abort.signal;
  const onParent = () => fire(ctx?.lifecycle?.revokedReason || "revoked");
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  const timer = ctx ? setInterval(() => { const r = dispatchRevokedReason(ctx); if (r) fire(r); }, pollMs) : null;
  (timer as any)?.unref?.();
  return {
    signal: ac.signal,
    dispose: () => {
      if (timer) clearInterval(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

// ─── Durable ownership (SQL) ─────────────────────────────────────────────────

export interface AttemptOwnership {
  jobId: number;
  batchId: number;
  /** analysis_jobs.attempts value returned by this attempt's claimJob. */
  attemptNumber: number;
  /** Hard attempt deadline (claim time + JOB_TIMEOUT). null = no deadline check. */
  deadlineAt: Date | null;
  /** Diagnostic attempt UUID for log correlation only. */
  attemptId?: string | null;
}

/** Ownership derived from the current worker attempt context, or null outside one. */
export function ownershipFromContext(ctx: DiagContext | undefined = getDiagContext()): AttemptOwnership | null {
  const lc = ctx?.lifecycle;
  if (!lc) return null;
  return { jobId: lc.jobId, batchId: lc.batchId, attemptNumber: lc.attemptNumber, deadlineAt: lc.deadlineAt, attemptId: ctx?.attemptId ?? null };
}

// ─── Predicate helpers (aliases j = analysis_jobs, b = batch_runs) ───────────
// Small single-purpose predicates, composed per write class below. Keep them
// separate: the four write classes deliberately have DIFFERENT rules.

/** This attempt still owns the claimed job (attempt identity = attempts). */
export function ownerPredicate(o: Pick<AttemptOwnership, "jobId" | "attemptNumber">): SQL {
  return sql`(j.id = ${o.jobId} AND j.attempts = ${o.attemptNumber} AND j.status = 'claimed')`;
}

/** Batch is running (not cancelled / superseded / completed / failed / review). */
export function batchRunningPredicate(): SQL {
  return sql`(b.status = 'running')`;
}

/** Attempt deadline (claim + JOB_TIMEOUT) has not elapsed; null = unchecked. */
export function deadlinePredicate(o: Pick<AttemptOwnership, "deadlineAt">): SQL {
  const deadline = o.deadlineAt ? o.deadlineAt.toISOString() : null;
  return sql`(${deadline}::timestamptz IS NULL OR ${deadline}::timestamptz > NOW())`;
}

/** Rule (i): score persistence. */
export function scorePersistPredicate(o: AttemptOwnership): SQL {
  return sql`${ownerPredicate(o)} AND ${batchRunningPredicate()} AND ${deadlinePredicate(o)}`;
}

/** Rule (ii): success completion of the job (completeJob with ownership). */
export function successCompletionPredicate(o: AttemptOwnership): SQL {
  return sql`${ownerPredicate(o)} AND ${batchRunningPredicate()} AND ${deadlinePredicate(o)}`;
}

/** Rule (iii): failure recording — ownership only; batch status and deadline
 *  deliberately NOT required (the owner must be able to release its claim
 *  after a timeout/cancel). What failJob may then write depends on b.status. */
export function failureRecordPredicate(o: Pick<AttemptOwnership, "jobId" | "attemptNumber">): SQL {
  return ownerPredicate(o);
}

/** Claim: job claimable (pending, or claimed with retries left) ∧ batch running. */
export function claimPredicate(jobId: number): SQL {
  return sql`(j.id = ${jobId} AND (j.status = 'pending' OR (j.status = 'claimed' AND j.attempts < 3))) AND ${batchRunningPredicate()}`;
}

/** @deprecated alias kept for callers/tests: identical to rule (i). */
export function permissionPredicate(o: AttemptOwnership): SQL {
  return scorePersistPredicate(o);
}

/**
 * The single canonical job-side lock statement (see LOCK ORDER above):
 * locks the job row FOR UPDATE and the batch row FOR SHARE, filtered by
 * `predicate`. Returns the locked row (attempts, job status, batch status) or
 * null when the predicate matched nothing. Must run inside a transaction.
 */
export async function lockJobAndBatch(
  tx: { execute: (q: SQL) => Promise<any> },
  jobId: number,
  predicate: SQL,
): Promise<{ jobId: number; batchId: number; attempts: number; jobStatus: string; batchStatus: string } | null> {
  const r = await tx.execute(sql`
    SELECT j.id, j.batch_id, j.attempts, j.status AS job_status, b.status AS batch_status
    FROM analysis_jobs j JOIN batch_runs b ON b.id = j.batch_id
    WHERE j.id = ${jobId} AND ${predicate}
    FOR UPDATE OF j FOR SHARE OF b`);
  const row = ((r as any)?.rows ?? r)?.[0];
  if (!row) return null;
  return { jobId: Number(row.id), batchId: Number(row.batch_id), attempts: Number(row.attempts), jobStatus: String(row.job_status), batchStatus: String(row.batch_status) };
}

export function fenceLogScore(o: AttemptOwnership, extra = ""): void {
  console.warn(`[LIFECYCLE-FENCE] stale/cancelled score write fenced (job=${o.jobId} attempt=${o.attemptNumber}${o.attemptId ? `/${o.attemptId}` : ""} batch=${o.batchId})${extra ? " " + extra : ""}`);
}

export function fenceLogTerminal(jobId: number, attemptNumber: number | string, kind: string): void {
  console.warn(`[LIFECYCLE-FENCE] stale terminal write ignored (job=${jobId} attempt=${attemptNumber}) kind=${kind}`);
}

/** Minimal drizzle-compatible surface (works with drizzle NodePgDatabase or a tx). */
export interface FenceDb {
  transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
}

/**
 * Run `write(tx)` only if this attempt still holds permission for the given
 * write class (default rule (i), score persistence). One short DB-only
 * transaction: CANONICAL lock (lockJobAndBatch: FOR UPDATE OF j FOR SHARE OF b)
 * under the predicate, then the write, then COMMIT. No network calls inside.
 * Returns true when the write executed, false when fenced (and logs).
 */
export async function runFencedWrite(
  db: FenceDb,
  o: AttemptOwnership,
  write: (tx: any) => Promise<void>,
  opts: { predicate?: SQL; onFenced?: (reason: string) => void } = {},
): Promise<boolean> {
  let early: string | null = null;
  const ok = await db.transaction(async (tx) => {
    // Re-check the in-process revoke AFTER the pool connection was acquired: a
    // pipeline timeout can revoke this attempt while it queued for a connection
    // and before the SQL deadline elapses (non-authoritative, belt-and-braces).
    early = dispatchRevokedReason();
    if (early) return false;
    const locked = await lockJobAndBatch(tx, o.jobId, opts.predicate ?? scorePersistPredicate(o));
    if (!locked) return false;
    await write(tx);
    return true;
  });
  if (!ok) {
    const reason = early ? `reason=${early} (post-acquire)` : "reason=sql_permission_denied";
    if (opts.onFenced) opts.onFenced(reason);
    else fenceLogScore(o, reason);
  }
  return ok;
}

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

/**
 * Full permission-to-persist predicate over aliases `j` (analysis_jobs) and
 * `b` (batch_runs): this attempt still owns a claimed job, the batch is
 * running (not cancelled / superseded / terminal), and the deadline has not
 * elapsed.
 */
export function permissionPredicate(o: AttemptOwnership): SQL {
  const deadline = o.deadlineAt ? o.deadlineAt.toISOString() : null;
  return sql`j.id = ${o.jobId}
    AND j.attempts = ${o.attemptNumber}
    AND j.status = 'claimed'
    AND b.status = 'running'
    AND (${deadline}::timestamptz IS NULL OR ${deadline}::timestamptz > NOW())`;
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
 * Run `write(tx)` only if this attempt still holds permission to persist.
 * One short DB-only transaction:
 *   SELECT … FROM analysis_jobs j JOIN batch_runs b … WHERE <permission>
 *   FOR UPDATE OF j FOR SHARE OF b
 * then the write, then COMMIT. No network calls inside. Returns true when the
 * write executed, false when fenced (and logs the fence line).
 */
export async function runFencedWrite(
  db: FenceDb,
  o: AttemptOwnership,
  write: (tx: any) => Promise<void>,
): Promise<boolean> {
  let early: string | null = null;
  const ok = await db.transaction(async (tx) => {
    // Re-check the in-process revoke AFTER the pool connection was acquired: a
    // pipeline timeout can revoke this attempt while it queued for a connection
    // and before the SQL deadline elapses (non-authoritative, belt-and-braces).
    early = dispatchRevokedReason();
    if (early) return false;
    const r = await tx.execute(sql`
      SELECT j.id FROM analysis_jobs j JOIN batch_runs b ON b.id = j.batch_id
      WHERE ${permissionPredicate(o)}
      FOR UPDATE OF j FOR SHARE OF b`);
    const rows = (r as any)?.rows ?? r;
    if (!rows || rows.length === 0) return false;
    await write(tx);
    return true;
  });
  if (!ok) fenceLogScore(o, early ? `reason=${early} (post-acquire)` : "reason=sql_permission_denied");
  return ok;
}

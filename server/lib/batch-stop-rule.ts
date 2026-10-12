/**
 * Batch stop rule (validation plan deliverable 35, §7 rule S4):
 *   "≥ 2 jobs reach `failed`, or any job exhausts retries → stop/cancel".
 *
 * Why this exists: S4 was only ever applied by a human watching read-only
 * monitors. storage.failJob() parks a failed attempt back in `pending` until
 * attempts >= 3, so `batch_runs.failed_jobs` (and status='failed') only move at
 * retry EXHAUSTION — batch 1276 therefore let 13 jobs burn all 3 attempts each
 * before anything looked "failed". This module counts a job as failed at its
 * FIRST recorded failed attempt, so the worker itself can cancel the batch at
 * the agreed threshold before any further retry is enqueued.
 *
 * Opt-in and inert by default: BATCH_STOP_RULE_FAILED_JOBS unset/0/invalid →
 * disabled, worker behaviour byte-for-byte unchanged. Set it to 2 for the next
 * validation run to enforce S4 as agreed.
 */

export const STOP_RULE_ENV = "BATCH_STOP_RULE_FAILED_JOBS";

/** Errors recorded on a job that are NOT job failures for S4 purposes. */
const NON_FAILURE_ERROR_PREFIXES = ["Cancelled", "provider_paused:"] as const;

export function readStopRuleThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STOP_RULE_ENV];
  if (raw == null || raw.trim() === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function isStopRuleFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  return !NON_FAILURE_ERROR_PREFIXES.some((p) => error.startsWith(p));
}

export interface BatchFailureCounts {
  /** Distinct jobs in the batch with ≥1 recorded failed attempt that have not since completed. */
  failedAttemptJobs: number;
  /** Distinct jobs in the batch that reached terminal `failed` (retries exhausted / non-retriable). */
  retryExhaustedJobs: number;
}

export interface StopDecision {
  stop: boolean;
  reason: string;
}

export function decideBatchStop(counts: BatchFailureCounts, threshold: number): StopDecision {
  if (threshold <= 0) return { stop: false, reason: "disabled" };
  if (counts.retryExhaustedJobs >= 1) {
    return { stop: true, reason: `S4: ${counts.retryExhaustedJobs} job(s) exhausted retries` };
  }
  if (counts.failedAttemptJobs >= threshold) {
    return { stop: true, reason: `S4: ${counts.failedAttemptJobs} job(s) failed (threshold ${threshold})` };
  }
  return { stop: false, reason: `below threshold (${counts.failedAttemptJobs}/${threshold})` };
}

/**
 * Read-only replica-wide count. Called right after failJob() committed this
 * attempt's failure, so the current job is included. Cancellation and
 * provider-quota pauses are excluded (they are not job failures).
 */
export const COUNT_BATCH_FAILURES_SQL = `
  SELECT
    count(*) FILTER (WHERE status <> 'completed' AND last_error IS NOT NULL
                       AND last_error NOT LIKE 'Cancelled%' AND last_error NOT LIKE 'provider_paused:%')::int AS failed_attempt_jobs,
    count(*) FILTER (WHERE status = 'failed' AND last_error IS NOT NULL
                       AND last_error NOT LIKE 'Cancelled%' AND last_error NOT LIKE 'provider_paused:%')::int AS retry_exhausted_jobs
  FROM analysis_jobs WHERE batch_id = $1`;

export interface StopRuleDeps {
  threshold: number;
  countFailures: (batchId: number) => Promise<BatchFailureCounts>;
  /** Same sequence as POST /batch/cancel: flag + queue purge + snapshot + PG cancel. */
  cancelBatch: (batchId: number, reason: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Evaluate S4 after a job failure was recorded. Returns true when the batch was
 * stopped, in which case the caller MUST NOT re-enqueue a retry. Never throws:
 * a counting error leaves the legacy retry path in charge (fail-open to the
 * pre-existing behaviour, logged).
 */
export async function enforceBatchStopRule(
  batchId: number,
  jobId: number,
  error: string,
  deps: StopRuleDeps,
): Promise<boolean> {
  const log = deps.log ?? ((l: string) => console.warn(l));
  if (deps.threshold <= 0 || !isStopRuleFailure(error)) return false;
  let counts: BatchFailureCounts;
  try {
    counts = await deps.countFailures(batchId);
  } catch (e: any) {
    log(`[BATCH-STOP-RULE] batch=${batchId} job=${jobId} count failed (${e?.message ?? e}) — rule not evaluated`);
    return false;
  }
  const d = decideBatchStop(counts, deps.threshold);
  if (!d.stop) return false;
  log(`[BATCH-STOP-RULE] TRIPPED batch=${batchId} job=${jobId} failedAttemptJobs=${counts.failedAttemptJobs} retryExhaustedJobs=${counts.retryExhaustedJobs} threshold=${deps.threshold} — cancelling batch, no further retries (${d.reason})`);
  try {
    await deps.cancelBatch(batchId, `stop rule ${d.reason}`);
  } catch (e: any) {
    // The Redis/local cancel flag is set first inside cancelBatch, so even a
    // partial failure here stops further claims; still refuse the retry.
    log(`[BATCH-STOP-RULE] batch=${batchId} cancel sequence error (${e?.message ?? e}) — retry still suppressed`);
  }
  return true;
}

export interface CancelSequenceSteps {
  /** Local + Redis cancel flag (worker.cancelBatch) — first, so no new claim starts. */
  flag: (batchId: number) => void;
  /** Purge the batch's still-queued BullMQ jobs (queue.removeBatchJobs). */
  purge: (batchId: number) => Promise<void>;
  /** saveBatchSnapshot for the batch (non-fatal, as in POST /batch/cancel). */
  snapshot: (batchId: number) => Promise<void>;
  /** storage.cancelBatchRun: PG batch status → cancelled (claimJob fence). */
  pgCancel: (batchId: number, reason: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * The POST /batch/cancel sequence the stop rule runs when tripped:
 * flag → purge queue → snapshot → PG cancel. Purge and snapshot errors are
 * logged and do not prevent the PG cancel; a PG cancel error propagates (the
 * caller still suppresses the retry, see enforceBatchStopRule).
 */
export async function runStopRuleCancelSequence(batchId: number, reason: string, s: CancelSequenceSteps): Promise<void> {
  const log = s.log ?? ((l: string) => console.warn(l));
  s.flag(batchId);
  await s.purge(batchId).catch((e: any) => log(`[BATCH-STOP-RULE] removeBatchJobs failed: ${e?.message ?? e}`));
  await s.snapshot(batchId).catch((e: any) => log(`[BATCH-STOP-RULE] snapshot failed (non-fatal): ${e?.message ?? e}`));
  await s.pgCancel(batchId, reason);
}

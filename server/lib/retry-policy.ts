/**
 * Job retry classification — extracted VERBATIM from server/worker.ts (35884ee)
 * so the in-process path and the isolated path (job-isolation.ts) are
 * classified by one implementation and the table in
 * docs/worker-isolation/RESPONSIBILITY_TABLE.md can be tested directly.
 * Behaviour is unchanged: worker.ts calls these exactly where it used to inline them.
 */

/** Substrings that make a failure FINAL (no MAX_RETRY_ATTEMPTS re-enqueue). */
export const NON_RETRIABLE_ERRORS = [
  "Company not found",
  "Framework not found",
  "No measures in framework",
  "Could not claim job",
  // A watchdog timeout means the pipeline hung (typically un-fetchable company /
  // no domain). Retrying just hangs again for another full timeout window, so
  // treat it as a final failure to free the slot and let the batch close.
  "Job watchdog timeout",
  // R1 / auto-rerun: the pipeline itself owns the bounded re-run decision for
  // an incomplete/empty corpus. When it returns an "Insufficient corpus"
  // failure it has ALREADY decided not to (or exhausted its dedicated
  // MAX_ZERO_CORPUS_RERUNS budget / quarantined a deterministic class), so the
  // worker's generic MAX_RETRY_ATTEMPTS loop must NOT re-run it on top — that
  // would reuse the same corpus and burn the general budget. Eligible re-runs
  // are enqueued by the pipeline as their own re-examination batch.
  "Insufficient corpus",
] as const;

export function isRetriableError(error: string): boolean {
  return !NON_RETRIABLE_ERRORS.some((msg) => error.includes(msg));
}

/**
 * Lifecycle fence (worker.ts): a "Cancelled" result whose batch is NOT
 * cancelled means the attempt lost permission (deadline / revoked / ownership
 * lost). It is treated exactly like a watchdog timeout (non-retriable).
 */
export function fenceCancelledResult<R extends { success: boolean; error?: string }>(
  result: R, batchCancelled: boolean, why: string, jobTimeoutMs: number,
): R {
  if (!result.success && result.error === "Cancelled" && !batchCancelled) {
    return { ...result, error: "Job watchdog timeout after " + jobTimeoutMs + "ms (attempt revoked: " + why + ")" };
  }
  return result;
}

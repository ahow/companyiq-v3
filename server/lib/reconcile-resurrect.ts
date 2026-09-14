/**
 * Pure, DB-free predicates for the reconciler's "resurrect orphaned-failure"
 * sweep (§1.5). These are extracted into their own module so they can be unit
 * tested WITHOUT importing reconciler.ts (which imports db.ts, which throws at
 * module load when DATABASE_URL is unset). Keep this file free of any I/O or
 * database imports.
 *
 * Background: on a server restart, startup-cleanup.ts fails in-flight jobs with
 * a fixed last_error signature and cancels their batches with a specific
 * rejection_reason. Those failures are purely mechanical (the job was orphaned
 * by the restart, not by any analysis problem), so they are safe to resurrect.
 * User-cancelled batches carry a DIFFERENT rejection_reason and must NEVER be
 * touched. All predicates here are generic string/time checks — no framework,
 * company, or topic identifiers.
 */

/** Rejection reason stamped on batches cancelled by startup-cleanup (orphan). */
export const ORPHAN_REJECTION_REASON = "startup heartbeat timeout";

export type ResurrectConfig = {
  /** Only resurrect jobs whose last progress is within this many minutes of now. */
  windowMin: number;
};

/** Minimal shape of a candidate row the sweep evaluates (DB-agnostic). */
export type ResurrectRow = {
  /** analysis_jobs.status */
  status: string | null;
  /** analysis_jobs.last_error */
  lastError: string | null;
  /** batch_runs.rejection_reason */
  rejectionReason: string | null;
  /** analysis_jobs.last_progress_at (ISO string, Date, or epoch-ms) */
  lastProgressAt: string | Date | number | null;
};

/**
 * True when a job's last_error matches the orphaned-by-restart signature.
 *
 * startup-cleanup.ts sets last_error to exactly
 *   "Server restarted — job was orphaned"   (note the em-dash, U+2014)
 * We match on the stable, lower-cased "orphaned" token so a future wording
 * tweak to the same signature still matches, while genuine analysis/scoring
 * failures (which never contain that token) are excluded.
 */
export function isOrphanLastError(lastError: string | null | undefined): boolean {
  if (!lastError || typeof lastError !== "string") return false;
  return lastError.toLowerCase().includes("orphaned");
}

/** Coerce a timestamp-ish value to epoch-ms, or null if unparseable. */
function toEpochMs(v: string | Date | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isNaN(t) ? null : t; }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * True when a failed job is safe to resurrect:
 *   - the job is in status 'failed',
 *   - its last_error is the orphaned-by-restart signature,
 *   - its batch was cancelled by startup-cleanup (NOT by a user), and
 *   - its last progress is recent (within config.windowMin of `now`).
 *
 * Pure: no I/O. `now` is injected so tests are deterministic.
 */
export function isResurrectEligible(
  row: ResurrectRow,
  config: ResurrectConfig,
  now: Date | number,
): boolean {
  if (!row) return false;
  if (row.status !== "failed") return false;
  if (!isOrphanLastError(row.lastError)) return false;
  // Only orphan (startup-cleanup) batches — never user-cancelled ones.
  if (row.rejectionReason !== ORPHAN_REJECTION_REASON) return false;

  const nowMs = typeof now === "number" ? now : now.getTime();
  const progressMs = toEpochMs(row.lastProgressAt);
  if (progressMs == null) return false; // unknown recency => do not resurrect
  const windowMs = Math.max(0, config.windowMin) * 60_000;
  const age = nowMs - progressMs;
  if (age < 0) return false;          // future timestamp => treat as ineligible
  return age <= windowMs;
}

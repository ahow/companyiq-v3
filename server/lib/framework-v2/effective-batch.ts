// Effective-batch selection for the test-drive results view.
//
// The results dashboard shows proposals/robustness/flags/iterations computed from
// a scored batch. The NEWEST batch for a (framework, list, workspace) may not be
// completed — it could be running, cancelled, or failed (e.g. an auto-rescore that
// was cancelled). In that case the newest batch is still the right source for
// live-progress display, but the proposal/robustness computation should fall back
// to the most recent COMPLETED batch so the user keeps seeing their last good
// results instead of an empty dashboard.
//
// This rule is fully generic: it branches only on batch status, never on any
// framework / list / company / topic / measure id.

export interface BatchLike {
  status?: string | null;
  [k: string]: unknown;
}

/**
 * Choose the batch to use for the scoringComplete gate and proposal computation.
 *
 * - If the newest batch is itself completed, use it (normal case — unchanged).
 * - Otherwise, if a completed batch exists, use the latest completed one.
 * - Otherwise (no completed batch at all), fall back to the newest batch.
 *
 * The newest batch should still be used separately for live-progress display.
 */
export function pickEffectiveBatch<B extends BatchLike | null | undefined>(
  newest: B,
  latestCompleted: B,
): B {
  if (newest && newest.status === "completed") return newest;
  if (latestCompleted) return latestCompleted;
  return newest;
}

/**
 * TEST-DRIVE-ONLY batch completion routing (the single decision seam shared by
 * server/worker.ts and server/reconciler.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * When a batch finishes with terminal failures, normal (production) analysis
 * batches MUST pause in `pending_review` so the user can accept or retry the
 * failed companies. That behaviour is unchanged.
 *
 * A framework-builder TEST DRIVE, however, is a throwaway design-time sample
 * (~10-50 companies) used while iterating on a framework. If a test drive
 * finishes with even one failed company, the builder page hangs forever on
 * "still running": its scoringComplete gate is
 *     effectiveBatch?.status === "completed"
 * and `pending_review` never satisfies it. For a test drive ONLY we therefore
 * DROP the failed companies and finalise the batch as `completed`, so the
 * builder sees it as finished.
 *
 * GENERIC / AGNOSTIC
 * ------------------
 * "Drop failed" is purely by job status (`dropFailedJobs`): any job that is not
 * terminal-`completed` is excluded. It never looks at company identity, topic,
 * measure, or framework — fully topic- and company-agnostic.
 *
 * WHAT MARKS A TEST DRIVE
 * -----------------------
 * A batch is a test drive iff its `company_lists` row has `test_drive_labels`
 * set (see storage.isTestDriveBatch). `test_drive_labels` is written only by
 * POST /api/framework-builder/v2/test-drive/run — it is the unambiguous,
 * structured flag that distinguishes a builder test-drive list from a normal
 * user analysis list. Normal analyses run against lists where the column is
 * NULL and therefore always route to `pending-review` on failure.
 */

/** Terminal routing decision for a batch that finished with >=1 failure. */
export type FailedBatchRoute = "pending-review" | "test-drive-complete";

/**
 * Decide how to handle a batch that reached its terminal job count WITH at least
 * one failed job. This is the ONLY point at which the test-drive path diverges
 * from the normal analysis path.
 *
 * - Normal analysis (isTestDrive === false) -> "pending-review"  (UNCHANGED).
 * - Test drive      (isTestDrive === true)  -> "test-drive-complete"
 *   (drop the failed companies and finalise as completed).
 */
export function routeFailedBatch(input: { isTestDrive: boolean }): FailedBatchRoute {
  return input.isTestDrive ? "test-drive-complete" : "pending-review";
}

/**
 * Generic, identity-agnostic "drop failed": keep only the jobs that reached a
 * terminal `completed` status. Any other status (failed / pending / claimed /
 * cancelled) is dropped. Selection is by status alone — never by company name,
 * id, topic, measure or framework. This mirrors the status filter that
 * saveAnalysisResultsForBatch already applies when building the result set, so
 * a finalised test drive carries exactly the completed companies.
 */
export function dropFailedJobs<T extends { status: string }>(jobs: readonly T[]): T[] {
  return jobs.filter((j) => j.status === "completed");
}

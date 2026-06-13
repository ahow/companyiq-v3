/**
 * Startup Cleanup for CompanyIQ v3
 * 
 * On server startup (e.g., after a deploy), this module:
 * 1. Checks if there's a recently-created batch (within grace period) — if so, skips cleanup
 *    to avoid killing an active extraction that was running when the deploy happened
 * 2. Marks any "running" batch_runs as "cancelled" (they're orphaned from a previous session)
 * 3. Drains the BullMQ queue of any stale jobs from previous sessions
 * 4. Marks any "pending" or "claimed" analysis_jobs as "failed" (they won't be processed)
 * 
 * This ensures that analysis ONLY runs when the user explicitly clicks "Analyze",
 * and does NOT auto-resume from a previous server session — while protecting
 * active batches from being killed by rolling deploys.
 */

import { db } from "./db.js";
import { sql } from "drizzle-orm";
import { getQueue } from "./queue.js";

// Grace period: if a batch was created within this many seconds, skip cleanup entirely.
// This protects active extractions from being killed by deploys.
const GRACE_PERIOD_SECONDS = 300; // 5 minutes

export async function cleanupOnStartup(): Promise<void> {
  console.log("[Startup] Cleaning up stale jobs from previous server session...");

  try {
    // Check if there's a recently-created running batch within the grace period
    const recentBatchResult = await db.execute(sql`
      SELECT id, started_at 
      FROM batch_runs 
      WHERE status = 'running' 
        AND started_at > NOW() - INTERVAL '${sql.raw(String(GRACE_PERIOD_SECONDS))} seconds'
      LIMIT 1
    `);

    if (recentBatchResult.rows.length > 0) {
      const recentBatch = recentBatchResult.rows[0] as any;
      console.log(
        `[Startup] Found active batch ${recentBatch.id} started at ${recentBatch.started_at} ` +
        `(within ${GRACE_PERIOD_SECONDS}s grace period) — SKIPPING cleanup to preserve active extraction`
      );
      console.log("[Startup] The worker will resume processing the existing queue on reconnect");
      return;
    }

    // No recent batches — safe to clean up orphaned state from a previous session

    // 1. Mark all "running" batches as "cancelled"
    const batchResult = await db.execute(sql`
      UPDATE batch_runs 
      SET status = 'cancelled', completed_at = NOW() 
      WHERE status = 'running'
      RETURNING id
    `);
    const cancelledBatches = batchResult.rows.length;
    if (cancelledBatches > 0) {
      console.log(`[Startup] Cancelled ${cancelledBatches} stale batch run(s)`);
    }

    // 2. Mark any "pending" or "claimed" analysis_jobs as "failed" with a clear reason
    const jobResult = await db.execute(sql`
      UPDATE analysis_jobs 
      SET status = 'failed', last_error = 'Server restarted — job was orphaned'
      WHERE status IN ('pending', 'claimed')
      RETURNING id
    `);
    const failedJobs = jobResult.rows.length;
    if (failedJobs > 0) {
      console.log(`[Startup] Marked ${failedJobs} orphaned job(s) as failed`);
    }

    // 3. Reset any companies stuck in intermediate states (fetching/analyzing) back to idle
    const companyResult = await db.execute(sql`
      UPDATE companies 
      SET analysis_status = 'idle'
      WHERE analysis_status IN ('fetching', 'analyzing')
      RETURNING id
    `);
    const resetCompanies = companyResult.rows.length;
    if (resetCompanies > 0) {
      console.log(`[Startup] Reset ${resetCompanies} company(ies) from intermediate state to idle`);
    }

    // 4. Drain the BullMQ queue (remove all waiting/delayed jobs)
    try {
      const queue = getQueue();
      await queue.drain();
      console.log("[Startup] Drained BullMQ queue of stale jobs");
    } catch (queueErr: any) {
      // Queue drain is best-effort — if Redis isn't ready yet, that's OK
      console.warn(`[Startup] Could not drain queue (non-fatal): ${queueErr.message}`);
    }

    console.log("[Startup] Cleanup complete — analysis will only start on explicit user action");
  } catch (error: any) {
    console.error(`[Startup] Cleanup error (non-fatal): ${error.message}`);
    // Don't throw — startup cleanup is best-effort
  }
}

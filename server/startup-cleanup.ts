/**
 * Startup Cleanup for CompanyIQ v3
 * 
 * On server startup (e.g., after a deploy), this module:
 * 1. Marks any "running" batch_runs as "cancelled" (they're orphaned from a previous session)
 * 2. Drains the BullMQ queue of any stale jobs from previous sessions
 * 3. Marks any "pending" or "claimed" analysis_jobs as "failed" (they won't be processed)
 * 
 * This ensures that analysis ONLY runs when the user explicitly clicks "Analyze",
 * and does NOT auto-resume from a previous server session.
 */

import { db } from "./db.js";
import { sql } from "drizzle-orm";
import { getQueue } from "./queue.js";

export async function cleanupOnStartup(): Promise<void> {
  console.log("[Startup] Cleaning up stale jobs from previous server session...");

  try {
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

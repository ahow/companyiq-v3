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

// A running batch is preserved only when its persisted batch heartbeat and every
// active job's progress heartbeat are fresh. An unchanged aggregate snapshot is
// deliberately not part of this decision.
const ACTIVITY_WINDOW_SECONDS = parseInt(process.env.RELIABILITY_STALL_THRESHOLD_SECONDS || String(45 * 60), 10);

export async function cleanupOnStartup(): Promise<void> {
  console.log("[Startup] Cleaning up stale jobs from previous server session...");

  try {
    // A live run must have both a fresh batch heartbeat and fresh progress on all
    // currently active jobs. A single coarse unchanged snapshot cannot stall it.
    const activeBatchResult = await db.execute(sql`
      SELECT b.id,
             COALESCE(b.last_heartbeat_at, MAX(j.last_progress_at), 'epoch') AS last_heartbeat,
             COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) AS open_jobs,
             COUNT(*) FILTER (WHERE j.status = 'claimed' AND COALESCE(j.last_progress_at, 'epoch') <= NOW() - INTERVAL '${sql.raw(String(ACTIVITY_WINDOW_SECONDS))} seconds') AS stale_active_jobs
      FROM batch_runs b
      JOIN analysis_jobs j ON j.batch_id = b.id
      WHERE b.status = 'running'
      GROUP BY b.id, b.last_heartbeat_at
      HAVING COALESCE(b.last_heartbeat_at, MAX(j.last_progress_at), 'epoch') > NOW() - INTERVAL '${sql.raw(String(ACTIVITY_WINDOW_SECONDS))} seconds'
         AND COUNT(*) FILTER (WHERE j.status = 'claimed' AND COALESCE(j.last_progress_at, 'epoch') <= NOW() - INTERVAL '${sql.raw(String(ACTIVITY_WINDOW_SECONDS))} seconds') = 0
      ORDER BY b.id ASC
      LIMIT 1
    `);

    if (activeBatchResult.rows.length > 0) {
      const activeBatch = activeBatchResult.rows[0] as any;
      console.log(
        `[Startup] Preserving live batch ${activeBatch.id} (heartbeat ${activeBatch.last_heartbeat}, ` +
        `all active job heartbeats within ${ACTIVITY_WINDOW_SECONDS}s) — SKIPPING cleanup`
      );
      console.log("[Startup] The worker will resume processing the existing queue on reconnect");
      return;
    }

    // No batch has a fresh batch-and-job heartbeat — safe to quarantine stale state.

    // 1. Mark stale running batches as cancelled, preserving their provenance.
    const staleBatches = await db.execute(sql`
      SELECT id, workspace_id, reliability_run_id, run_key, status
      FROM batch_runs WHERE status = 'running' ORDER BY id ASC
    `);
    const batchResult = await db.execute(sql`
      UPDATE batch_runs
      SET status = 'cancelled', completed_at = NOW(), terminal_at = NOW(), acceptance_state = 'rejected', rejection_reason = 'startup heartbeat timeout'
      WHERE status = 'running'
      RETURNING id
    `);
    const cancelledBatches = batchResult.rows.length;
    if (cancelledBatches > 0) {
      console.log(`[Startup] Cancelled ${cancelledBatches} stale batch run(s)`);
      for (const stale of staleBatches.rows as any[]) {
        await db.execute(sql`UPDATE reliability_runs SET lifecycle_state = 'cancelled', acceptance_state = 'rejected', rejection_reason = 'startup heartbeat timeout', terminal_at = NOW() WHERE id = ${stale.reliability_run_id}`);
        await db.execute(sql`
          INSERT INTO reliability_audit_events (workspace_id, run_id, batch_id, artifact_id, event_type, from_state, to_state, reason, metadata)
          VALUES (${stale.workspace_id}, ${stale.reliability_run_id}, ${stale.id}, ${stale.run_key}, 'cancellation', ${stale.status}, 'cancelled', 'startup heartbeat timeout', ${JSON.stringify({ activityWindowSeconds: ACTIVITY_WINDOW_SECONDS })}::jsonb)
        `);
      }
    }

    // 2. Mark any "pending" or "claimed" analysis_jobs as "failed" with a clear reason
    const jobResult = await db.execute(sql`
      UPDATE analysis_jobs
      SET status = 'failed', last_error = 'Server restarted — job was orphaned', last_progress_at = NOW(), progress_detail = '{"reason":"startup heartbeat timeout"}'::jsonb
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

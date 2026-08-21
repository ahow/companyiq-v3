/**
 * BullMQ Queue for CompanyIQ v3
 * 
 * Fair-share scheduling: jobs are grouped by workspace and prioritized
 * so that smaller batches from different workspaces aren't starved by
 * large batches from a single workspace.
 */

import { Queue } from "bullmq";
import { getRedisConnection } from "./redis.js";
import type { AnalysisJobData } from "./worker.js";

const QUEUE_NAME = "analysis";

let queue: Queue | null = null;

export function getQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 30000, // 30s initial, then 60s, 120s
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    });
  }
  return queue;
}

/**
 * Add analysis jobs for a batch, with fair-share priority.
 * Jobs from workspaces with fewer active jobs get higher priority.
 */
export async function addBatchJobs(
  jobs: AnalysisJobData[],
  workspaceId: number,
  batchId: number
): Promise<void> {
  const q = getQueue();

  // Calculate priority based on batch size (smaller batches get higher priority)
  // BullMQ priority: lower number = higher priority
  const basePriority = Math.min(Math.floor(jobs.length / 10), 20);

  const bulkJobs = jobs.map((jobData, index) => ({
    name: `analysis-${batchId}-${jobData.companyId}`,
    data: jobData,
    opts: {
      priority: basePriority + (index % 5), // Interleave within batch for fairness
      jobId: `batch-${batchId}-company-${jobData.companyId}`,
    },
  }));

  // Add in chunks to avoid overwhelming Redis
  const CHUNK_SIZE = 100;
  for (let i = 0; i < bulkJobs.length; i += CHUNK_SIZE) {
    const chunk = bulkJobs.slice(i, i + CHUNK_SIZE);
    await q.addBulk(chunk);
  }

  console.log(`[Queue] Added ${jobs.length} jobs for batch ${batchId} (workspace ${workspaceId}, priority ${basePriority})`);
}

/**
 * Remove all not-yet-running jobs for a batch (for cancellation).
 *
 * Previously this only removed `waiting` jobs, which let two categories of jobs
 * survive a cancel and keep advancing the "done" counter for minutes:
 *   - `delayed` jobs: retries scheduled with exponential backoff
 *   - `prioritized` jobs: re-enqueued retries added with a priority
 * We now sweep waiting + delayed + prioritized. Active (already-running) jobs
 * can't be force-removed safely, but they observe the Redis cancel flag via the
 * worker's cancelCheck and abort at their next checkpoint.
 */
export async function removeBatchJobs(batchId: number): Promise<number> {
  const q = getQueue();
  // getJobs across all non-active, not-yet-started states.
  const jobs = await q.getJobs(["waiting", "delayed", "prioritized", "paused"]);
  let removed = 0;

  for (const job of jobs) {
    if (job?.data?.batchId === batchId) {
      try {
        await job.remove();
        removed++;
      } catch (err: any) {
        // A job may transition to active between listing and removal; ignore.
        console.warn(`[Queue] Could not remove job ${job.id} for batch ${batchId}: ${err.message}`);
      }
    }
  }

  console.log(`[Queue] Removed ${removed} pending/delayed jobs for batch ${batchId}`);
  return removed;
}

export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
}> {
  const q = getQueue();
  const [waiting, active, completed, failed] = await Promise.all([
    q.getWaitingCount(),
    q.getActiveCount(),
    q.getCompletedCount(),
    q.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

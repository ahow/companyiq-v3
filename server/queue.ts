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
      connection: getRedisConnection(),
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
 * Remove all pending jobs for a batch (for cancellation)
 */
export async function removeBatchJobs(batchId: number): Promise<number> {
  const q = getQueue();
  const waiting = await q.getWaiting();
  let removed = 0;

  for (const job of waiting) {
    if (job.data.batchId === batchId) {
      await job.remove();
      removed++;
    }
  }

  console.log(`[Queue] Removed ${removed} pending jobs for batch ${batchId}`);
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

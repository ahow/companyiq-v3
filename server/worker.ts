/**
 * BullMQ Worker for CompanyIQ v3
 * 
 * Implements fair-share scheduling across workspaces:
 * - Each workspace gets equal processing priority regardless of batch size
 * - Configurable concurrency per worker instance
 * - Automatic retry with exponential backoff (up to 3 attempts)
 * - Jobs that fail all 3 attempts are marked "failed" and batch progress updates
 * - Graceful shutdown handling
 */

import { Worker, Job } from "bullmq";
import { getRedisConnection } from "./redis.js";
import { runAnalysisPipeline, type PipelineResult } from "./lib/pipeline.js";
import * as storage from "./storage.js";
import crypto from "crypto";

const QUEUE_NAME = "analysis";
const MAX_CONCURRENT = parseInt(process.env.WORKER_CONCURRENCY || "10", 10);
const JOB_TIMEOUT = parseInt(process.env.JOB_TIMEOUT_MS || "600000", 10); // 10 min default
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30000; // 30 seconds between retries

// Track cancelled batches
const cancelledBatches = new Set<number>();

export interface AnalysisJobData {
  jobId: number;
  companyId: number;
  frameworkId: number;
  batchId: number;
  workspaceId: number;
  skipFetch?: boolean;
}

// ─── Retry Helper ──────────────────────────────────────────────────────────

/**
 * Re-enqueue a failed job for retry after a delay.
 * Uses increasing delay: 30s, 60s, 90s for attempts 1, 2, 3.
 */
async function reEnqueueForRetry(jobData: AnalysisJobData, attemptNumber: number): Promise<void> {
  const { getQueue } = await import("./queue.js");
  const q = getQueue();
  const delay = RETRY_DELAY_MS * attemptNumber; // 30s, 60s, 90s
  
  await q.add(
    `analysis-${jobData.batchId}-${jobData.companyId}-retry${attemptNumber}`,
    jobData,
    {
      delay,
      priority: 1, // High priority for retries
      jobId: `batch-${jobData.batchId}-company-${jobData.companyId}-attempt${attemptNumber + 1}`,
    }
  );
  console.log(`[Worker] Re-enqueued job ${jobData.jobId} for retry (attempt ${attemptNumber + 1}/${MAX_RETRY_ATTEMPTS}, delay ${delay}ms)`);
}

/**
 * Determine if an error is retriable (transient) vs permanent (non-retriable).
 * Non-retriable errors: missing data, configuration issues.
 * Retriable errors: timeouts, API rate limits, network errors, LLM failures.
 */
function isRetriableError(error: string): boolean {
  const nonRetriable = [
    "Company not found",
    "Framework not found",
    "No measures in framework",
    "Could not claim job",
    "Cancelled",
  ];
  return !nonRetriable.some(msg => error.includes(msg));
}

// ─── Job Processor ──────────────────────────────────────────────────────────

async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<PipelineResult> {
  const { jobId, companyId, frameworkId, batchId, workspaceId, skipFetch } = job.data;

  console.log(`[Worker] Processing job ${jobId}: company=${companyId}, framework=${frameworkId}, batch=${batchId}, workspace=${workspaceId}`);

  // Check if batch was cancelled
  if (cancelledBatches.has(batchId)) {
    return { success: false, error: "Cancelled", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  // Claim the job in our DB (increments attempts counter)
  const claimed = await storage.claimJob(jobId as number);
  if (!claimed) {
    console.warn(`[Worker] Job ${jobId} could not be claimed (already taken or max attempts reached)`);
    return { success: false, error: "Could not claim job", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const currentAttempt = (claimed as any).attempts || 1;
  console.log(`[Worker] Job ${jobId} claimed (attempt ${currentAttempt}/${MAX_RETRY_ATTEMPTS})`);

  // Load company, framework, and measures
  const company = await storage.getCompanyById(companyId, workspaceId);
  if (!company) {
    await storage.failJob(jobId, "Company not found");
    await handleFinalFailure(jobId, batchId, frameworkId, workspaceId, "Company not found");
    return { success: false, error: "Company not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const framework = await storage.getFrameworkById(frameworkId, workspaceId);
  if (!framework) {
    await storage.failJob(jobId, "Framework not found");
    await handleFinalFailure(jobId, batchId, frameworkId, workspaceId, "Framework not found");
    return { success: false, error: "Framework not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const measures = await storage.getFrameworkMeasures(frameworkId);
  if (measures.length === 0) {
    await storage.failJob(jobId, "No measures in framework");
    await handleFinalFailure(jobId, batchId, frameworkId, workspaceId, "No measures in framework");
    return { success: false, error: "No measures in framework", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  // Run the pipeline
  const cancelCheck = () => cancelledBatches.has(batchId);

  try {
    const result = await runAnalysisPipeline({
      company,
      framework,
      measures,
      workspaceId,
      cancelCheck,
      skipFetch,
    });

    if (result.success) {
      // ─── SUCCESS PATH ───
      await storage.completeJob(jobId);
      console.log(`[Worker] Job ${jobId} completed successfully (attempt ${currentAttempt})`);

      // Increment batch completed and check if batch is done
      const batchRow = await storage.incrementBatchCompleted(batchId) as any;
      if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
        console.log(`[Worker] Batch ${batchId} complete: ${batchRow.completed_jobs} completed, ${batchRow.failed_jobs} failed`);
        await storage.completeBatchRun(batchId);
        scheduleBatchResultsSave(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
      }
    } else if (result.error === "Cancelled") {
      console.log(`[Worker] Job ${jobId} cancelled`);
    } else {
      // ─── PIPELINE RETURNED FAILURE ───
      await handleJobFailure(job.data, currentAttempt, result.error || "Unknown pipeline error");
    }

    return result;
  } catch (error: any) {
    // ─── UNHANDLED EXCEPTION ───
    console.error(`[Worker] Job ${jobId} threw error (attempt ${currentAttempt}): ${error.message}`);
    await handleJobFailure(job.data, currentAttempt, error.message);
    return { success: false, error: error.message, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }
}

/**
 * Handle a job failure: either retry or mark as permanently failed.
 */
async function handleJobFailure(jobData: AnalysisJobData, currentAttempt: number, errorMessage: string): Promise<void> {
  const { jobId, batchId, frameworkId, workspaceId } = jobData;

  // Call failJob which sets status back to 'pending' if attempts < 3, or 'failed' if >= 3
  await storage.failJob(jobId, errorMessage);

  if (currentAttempt < MAX_RETRY_ATTEMPTS && isRetriableError(errorMessage)) {
    // ─── RETRY PATH: Re-enqueue the job ───
    console.log(`[Worker] Job ${jobId} will be retried (attempt ${currentAttempt}/${MAX_RETRY_ATTEMPTS}, error: ${errorMessage})`);
    await reEnqueueForRetry(jobData, currentAttempt);
  } else {
    // ─── FINAL FAILURE: Mark as failed and update batch progress ───
    console.warn(`[Worker] Job ${jobId} permanently failed after ${currentAttempt} attempt(s): ${errorMessage}`);
    await handleFinalFailure(jobId, batchId, frameworkId, workspaceId, errorMessage);
  }
}

/**
 * Handle the final failure of a job (all retries exhausted or non-retriable error).
 * Increments batch failed counter and checks if batch is complete.
 */
async function handleFinalFailure(jobId: number, batchId: number, frameworkId: number, workspaceId: number, errorMessage: string): Promise<void> {
  // Update company status to show failure in dashboard
  try {
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    // Get the company ID from the job
    const [jobRow] = await db.execute(sql`SELECT company_id FROM analysis_jobs WHERE id = ${jobId}`).then(r => r.rows) as any[];
    if (jobRow) {
      await db.execute(sql`
        UPDATE companies SET 
          analysis_status = 'failed',
          summary = ${`Analysis failed after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMessage}`}
        WHERE id = ${jobRow.company_id}
      `);
    }
  } catch (err: any) {
    console.error(`[Worker] Failed to update company status for job ${jobId}: ${err.message}`);
  }

  // Increment batch failed counter
  await storage.incrementBatchFailed(batchId);

  // Check if batch is now complete
  try {
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const [batchRow] = await db.execute(sql`SELECT * FROM batch_runs WHERE id = ${batchId}`).then(r => r.rows) as any[];
    if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
      console.log(`[Worker] Batch ${batchId} complete (with failures): ${batchRow.completed_jobs} completed, ${batchRow.failed_jobs} failed`);
      await storage.completeBatchRun(batchId);
      scheduleBatchResultsSave(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
    }
  } catch (checkErr: any) {
    console.error(`[Worker] Failed to check batch completion after final failure: ${checkErr.message}`);
  }
}

/**
 * Schedule batch results save with a delay to allow any in-flight jobs to complete.
 */
function scheduleBatchResultsSave(batchId: number, frameworkId: number, workspaceId: number, listId?: number): void {
  setTimeout(async () => {
    try {
      await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
    } catch (err: any) {
      console.error(`[Worker] Failed to save results for batch ${batchId}: ${err.message}`);
    }
  }, 60000);
}

// ─── Batch Results Saving ───────────────────────────────────────────────────

// Guard against concurrent saves for the same batch
const savingBatches = new Set<number>();

async function saveAnalysisResultsForBatch(batchId: number, frameworkId: number, workspaceId: number, listId?: number): Promise<void> {
  // Prevent duplicate saves
  if (savingBatches.has(batchId)) {
    console.log(`[Worker] Skipping duplicate save for batch ${batchId}`);
    return;
  }
  savingBatches.add(batchId);

  try {
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return;

    // Get companies from this specific batch's jobs
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const jobsResult = await db.execute(sql`
      SELECT company_id, company_name FROM analysis_jobs
      WHERE batch_id = ${batchId}
    `);

    if (jobsResult.rows.length === 0) return;

    // Gather results for each company that was successfully analyzed
    const resultsData: any[] = [];
    for (const row of jobsResult.rows as any[]) {
      const company = await storage.getCompanyById(row.company_id, workspaceId);
      if (!company) continue;
      if (company.analysisStatus !== "completed") continue;

      const scores = await storage.getMeasureScores(company.id, frameworkId);
      // Get source documents used in analysis
      const docs = await storage.getFetchedDocuments(company.id);
      const sourceDocuments = docs.map(d => ({ url: d.url, title: d.title || d.url }));
      resultsData.push({
        companyId: company.id,
        companyName: company.name,
        isin: company.isin || undefined,
        sector: company.sector || undefined,
        country: company.country || undefined,
        totalScore: company.totalScore || 0,
        measuresMetCount: company.measuresMetCount || 0,
        measuresTotalCount: company.measuresTotalCount || 0,
        summary: company.summary || undefined,
        sourceDocuments,
        measureScores: scores.map(s => ({
          measureId: s.measureId,
          title: s.title || "",
          category: s.category || "",
          score: s.score,
          verdict: s.verdict || undefined,
          evidenceSummary: s.evidenceSummary || undefined,
          quotes: s.quotes || [],
        })),
      });
    }

    if (resultsData.length === 0) return;
    // Get list name
    let listName: string | undefined;
    if (listId) {
      const list = await storage.getListById(listId, workspaceId);
      listName = list?.name;
    }
    // Fallback: if no listId stored, try to infer from company membership
    if (!listName) {
      try {
        const { db } = await import("./db.js");
        const { sql } = await import("drizzle-orm");
        const companyIds = resultsData.map(r => r.companyId);
        // Find lists where ALL companies in this batch are members
        const listResult = await db.execute(sql`
          SELECT cl.id, cl.name, COUNT(clm.company_id) as match_count
          FROM company_lists cl
          JOIN company_list_members clm ON clm.list_id = cl.id
          WHERE cl.workspace_id = ${workspaceId}
            AND clm.company_id = ANY(ARRAY[${sql.raw(companyIds.join(","))}]::int[])
          GROUP BY cl.id, cl.name
          HAVING COUNT(clm.company_id) = ${companyIds.length}
          ORDER BY cl.id DESC
          LIMIT 1
        `);
        if (listResult.rows.length > 0) {
          listName = (listResult.rows[0] as any).name;
        }
      } catch (err) {
        // Non-critical fallback, ignore errors
      }
    }

    // Calculate average score
    const avgScore = Math.round(
      resultsData.reduce((sum, r) => sum + r.totalScore, 0) / resultsData.length
    );

    const shareToken = crypto.randomUUID();

    await storage.saveAnalysisResults({
      workspaceId,
      batchId,
      frameworkId,
      frameworkName: framework.name,
      listName,
      resultsData,
      companiesCount: resultsData.length,
      averageScore: avgScore,
      shareToken,
    });

    console.log(`[Worker] Saved analysis results for batch ${batchId} (${resultsData.length} companies, avg ${avgScore}%)`);
  } catch (error: any) {
    console.error(`[Worker] Failed to save analysis results for batch ${batchId}: ${error.message}`);
  }
}

// ─── Worker Initialization ──────────────────────────────────────────────────

let worker: Worker | null = null;

export function startWorker(workerId?: string): Worker {
  const connection = getRedisConnection();

  worker = new Worker<AnalysisJobData>(
    QUEUE_NAME,
    processAnalysisJob,
    {
      connection,
      concurrency: MAX_CONCURRENT,
      lockDuration: JOB_TIMEOUT, // Must match queue lockDuration (10 min)
      settings: {
        stalledInterval: JOB_TIMEOUT,
      },
    }
  );

  worker.on("completed", (job) => {
    console.log(`[Worker] BullMQ job ${job.id} completed`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Worker] BullMQ job ${job?.id} failed: ${error.message}`);
  });

  worker.on("error", (error) => {
    console.error(`[Worker] Worker error: ${error.message}`);
  });

  worker.on("stalled", (jobId) => {
    console.warn(`[Worker] Job ${jobId} stalled — will be retried`);
  });

  // Health check: detect if worker becomes disconnected from Redis
  // BullMQ workers can silently lose their Redis connection while the Express
  // server continues responding to HTTP requests.
  let lastActivityTimestamp = Date.now();
  const HEALTH_CHECK_INTERVAL = 60_000; // Check every 60 seconds
  const MAX_IDLE_TIME = 180_000; // 3 minutes without activity = likely disconnected

  worker.on("active", () => { lastActivityTimestamp = Date.now(); });
  worker.on("completed", () => { lastActivityTimestamp = Date.now(); });
  worker.on("failed", () => { lastActivityTimestamp = Date.now(); });

  const healthCheckInterval = setInterval(async () => {
    if (!worker) { clearInterval(healthCheckInterval); return; }
    try {
      // Check if there are waiting jobs but worker hasn't been active
      const queue = (await import("./queue.js")).getQueue();
      const waitingCount = await queue.getWaitingCount();
      const timeSinceActivity = Date.now() - lastActivityTimestamp;

      if (waitingCount > 0 && timeSinceActivity > MAX_IDLE_TIME) {
        console.error(`[Worker] HEALTH CHECK FAILED: ${waitingCount} jobs waiting but no activity for ${Math.round(timeSinceActivity / 1000)}s — restarting worker`);
        // Close and restart the worker
        try {
          await worker.close();
        } catch (e) { /* ignore close errors */ }
        worker = null;
        // Restart after a brief pause
        setTimeout(() => {
          console.log("[Worker] Restarting after health check failure...");
          startWorker(workerId);
        }, 2000);
        clearInterval(healthCheckInterval);
      } else if (waitingCount > 0) {
        // Jobs are waiting but we've been active recently — normal
        console.log(`[Worker] Health OK: ${waitingCount} jobs waiting, last active ${Math.round(timeSinceActivity / 1000)}s ago`);
      }
    } catch (err: any) {
      console.warn(`[Worker] Health check error (non-fatal): ${err.message}`);
    }
  }, HEALTH_CHECK_INTERVAL);

  console.log(`[Worker] Started with concurrency=${MAX_CONCURRENT}, timeout=${JOB_TIMEOUT}ms, maxRetries=${MAX_RETRY_ATTEMPTS}`);
  return worker;
}

export function cancelBatch(batchId: number): void {
  cancelledBatches.add(batchId);
  // Clean up after 1 hour
  setTimeout(() => cancelledBatches.delete(batchId), 3600000);
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log("[Worker] Stopped");
  }
}

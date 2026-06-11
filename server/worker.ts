/**
 * BullMQ Worker for CompanyIQ v3
 * 
 * Implements fair-share scheduling across workspaces:
 * - Each workspace gets equal processing priority regardless of batch size
 * - Configurable concurrency per worker instance
 * - Automatic retry with exponential backoff (up to 3 attempts)
 * - Jobs that fail all retries are marked "failed" and batch progress updates
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

// ─── Retry Helpers ─────────────────────────────────────────────────────────

function isRetriableError(error: string): boolean {
  const nonRetriable = ["Company not found", "Framework not found", "No measures in framework", "Could not claim job"];
  return !nonRetriable.some(msg => error.includes(msg));
}

async function reEnqueueForRetry(jobData: AnalysisJobData, attemptNumber: number): Promise<void> {
  try {
    const { getQueue } = await import("./queue.js");
    const q = getQueue();
    const delay = RETRY_DELAY_MS * attemptNumber;
    const jobName = "analysis-" + jobData.batchId + "-" + jobData.companyId + "-retry" + attemptNumber;
    const jobIdStr = "batch-" + jobData.batchId + "-company-" + jobData.companyId + "-attempt" + (attemptNumber + 1);
    await q.add(jobName, jobData, { delay, priority: 1, jobId: jobIdStr });
    console.log("[Worker] Re-enqueued job " + jobData.jobId + " for retry (attempt " + (attemptNumber + 1) + "/" + MAX_RETRY_ATTEMPTS + ", delay " + delay + "ms)");
  } catch (err: any) {
    console.error("[Worker] Failed to re-enqueue job " + jobData.jobId + ": " + err.message);
  }
}

// ─── Job Processor ──────────────────────────────────────────────────────────

async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<PipelineResult> {
  const { jobId, companyId, frameworkId, batchId, workspaceId, skipFetch } = job.data;

  console.log("[Worker] Processing job " + jobId + ": company=" + companyId + ", framework=" + frameworkId + ", batch=" + batchId + ", workspace=" + workspaceId);

  // Check if batch was cancelled
  if (cancelledBatches.has(batchId)) {
    return { success: false, error: "Cancelled", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  // Claim the job in our DB (increments attempts counter)
  const claimed = await storage.claimJob(jobId as number);
  if (!claimed) {
    console.warn("[Worker] Job " + jobId + " could not be claimed (already taken or max attempts reached)");
    return { success: false, error: "Could not claim job", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const currentAttempt = (claimed as any).attempts || 1;
  console.log("[Worker] Job " + jobId + " claimed (attempt " + currentAttempt + "/" + MAX_RETRY_ATTEMPTS + ")");

  // Load company, framework, and measures
  const company = await storage.getCompanyById(companyId, workspaceId);
  if (!company) {
    await storage.failJob(jobId, "Company not found");
    await storage.incrementBatchFailed(batchId);
    return { success: false, error: "Company not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const framework = await storage.getFrameworkById(frameworkId, workspaceId);
  if (!framework) {
    await storage.failJob(jobId, "Framework not found");
    await storage.incrementBatchFailed(batchId);
    return { success: false, error: "Framework not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const measures = await storage.getFrameworkMeasures(frameworkId);
  if (measures.length === 0) {
    await storage.failJob(jobId, "No measures in framework");
    await storage.incrementBatchFailed(batchId);
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
      await storage.completeJob(jobId);
      console.log("[Worker] Job " + jobId + " completed successfully (attempt " + currentAttempt + ")");
    } else if (result.error === "Cancelled") {
      console.log("[Worker] Job " + jobId + " cancelled");
    } else {
      // Pipeline returned a failure result
      const errorMsg = result.error || "Unknown error";
      await storage.failJob(jobId, errorMsg);

      if (currentAttempt < MAX_RETRY_ATTEMPTS && isRetriableError(errorMsg)) {
        // Retry: re-enqueue without incrementing batch failed
        console.log("[Worker] Job " + jobId + " failed (attempt " + currentAttempt + "/" + MAX_RETRY_ATTEMPTS + "), will retry: " + errorMsg);
        await reEnqueueForRetry(job.data, currentAttempt);
      } else {
        // Final failure: increment batch failed counter
        console.warn("[Worker] Job " + jobId + " permanently failed: " + errorMsg);
        await storage.incrementBatchFailed(batchId);
      }
    }

    // Check if batch is complete
    if (result.success) {
      const batchRow = await storage.incrementBatchCompleted(batchId) as any;
      if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
        console.log("[Worker] Batch " + batchId + " complete: " + batchRow.completed_jobs + " completed, " + batchRow.failed_jobs + " failed");
        await storage.completeBatchRun(batchId);
        setTimeout(async () => {
          try {
            await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
          } catch (err: any) {
            console.error("[Worker] Failed to save results for batch " + batchId + ": " + err.message);
          }
        }, 60000);
      }
    } else if (result.error !== "Cancelled") {
      // For failed jobs (final failure only), check if batch is now complete
      if (currentAttempt >= MAX_RETRY_ATTEMPTS || !isRetriableError(result.error || "")) {
        try {
          const { db } = await import("./db.js");
          const { sql } = await import("drizzle-orm");
          const batchResult = await db.execute(sql`SELECT * FROM batch_runs WHERE id = ${batchId}`);
          const batchRow = batchResult.rows[0] as any;
          if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
            console.log("[Worker] Batch " + batchId + " complete: " + batchRow.completed_jobs + " completed, " + batchRow.failed_jobs + " failed");
            await storage.completeBatchRun(batchId);
            setTimeout(async () => {
              try {
                await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
              } catch (err: any) {
                console.error("[Worker] Failed to save results for batch " + batchId + ": " + err.message);
              }
            }, 60000);
          }
        } catch (checkErr: any) {
          console.error("[Worker] Failed to check batch completion: " + checkErr.message);
        }
      }
    }

    return result;
  } catch (error: any) {
    console.error("[Worker] Job " + jobId + " threw error (attempt " + currentAttempt + "): " + error.message);
    await storage.failJob(jobId, error.message);

    if (currentAttempt < MAX_RETRY_ATTEMPTS && isRetriableError(error.message)) {
      // Retry: re-enqueue without incrementing batch failed
      console.log("[Worker] Job " + jobId + " will retry after exception (attempt " + currentAttempt + "/" + MAX_RETRY_ATTEMPTS + ")");
      await reEnqueueForRetry(job.data, currentAttempt);
    } else {
      // Final failure
      await storage.incrementBatchFailed(batchId);
      // Check if batch is complete after this failure
      try {
        const { db } = await import("./db.js");
        const { sql } = await import("drizzle-orm");
        const batchResult = await db.execute(sql`SELECT * FROM batch_runs WHERE id = ${batchId}`);
        const batchRow = batchResult.rows[0] as any;
        if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
          console.log("[Worker] Batch " + batchId + " complete (from catch): " + batchRow.completed_jobs + " completed, " + batchRow.failed_jobs + " failed");
          await storage.completeBatchRun(batchId);
          setTimeout(async () => {
            try {
              await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
            } catch (err: any) {
              console.error("[Worker] Failed to save results for batch " + batchId + ": " + err.message);
            }
          }, 60000);
        }
      } catch (checkErr: any) {
        console.error("[Worker] Failed to check batch completion after error: " + checkErr.message);
      }
    }
    return { success: false, error: error.message, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }
}

// ─── Batch Results Saving ───────────────────────────────────────────────────

// Guard against concurrent saves for the same batch
const savingBatches = new Set<number>();

async function saveAnalysisResultsForBatch(batchId: number, frameworkId: number, workspaceId: number, listId?: number): Promise<void> {
  // Prevent duplicate saves
  if (savingBatches.has(batchId)) {
    console.log("[Worker] Skipping duplicate save for batch " + batchId);
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
      // Extract coverage level from discovery diagnostics
      const diagnostics = company.discoveryDiagnostics as any;
      const coverageLevel = diagnostics?.coverage?.coverageLevel || "unknown";
      const missingTier1 = diagnostics?.coverage?.missingTier1Types || [];

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
        coverageLevel,
        missingTier1,
        sourceDocuments,
        measureScores: scores.map(s => ({
          measureId: s.measureId,
          title: s.title || "",
          category: s.category || "",
          score: s.score,
          verdict: s.verdict || undefined,
          confidence: s.confidence || "Low",
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

    console.log("[Worker] Saved analysis results for batch " + batchId + " (" + resultsData.length + " companies, avg " + avgScore + "%)");
  } catch (error: any) {
    console.error("[Worker] Failed to save analysis results for batch " + batchId + ": " + error.message);
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
    console.log("[Worker] BullMQ job " + job.id + " completed");
  });

  worker.on("failed", (job, error) => {
    console.error("[Worker] BullMQ job " + (job?.id || "unknown") + " failed: " + error.message);
  });

  worker.on("error", (error) => {
    console.error("[Worker] Worker error: " + error.message);
  });

  worker.on("stalled", (jobId) => {
    console.warn("[Worker] Job " + jobId + " stalled - will be retried");
  });

  // Health check: detect if worker becomes disconnected from Redis
  let lastActivityTimestamp = Date.now();
  const HEALTH_CHECK_INTERVAL = 60_000; // Check every 60 seconds
  const MAX_IDLE_TIME = 180_000; // 3 minutes without activity = likely disconnected

  worker.on("active", () => { lastActivityTimestamp = Date.now(); });
  worker.on("completed", () => { lastActivityTimestamp = Date.now(); });
  worker.on("failed", () => { lastActivityTimestamp = Date.now(); });

  const healthCheckInterval = setInterval(async () => {
    if (!worker) { clearInterval(healthCheckInterval); return; }
    try {
      const queue = (await import("./queue.js")).getQueue();
      const waitingCount = await queue.getWaitingCount();
      const timeSinceActivity = Date.now() - lastActivityTimestamp;

      if (waitingCount > 0 && timeSinceActivity > MAX_IDLE_TIME) {
        console.error("[Worker] HEALTH CHECK FAILED: " + waitingCount + " jobs waiting but no activity for " + Math.round(timeSinceActivity / 1000) + "s - restarting worker");
        try {
          await worker.close();
        } catch (e) { /* ignore close errors */ }
        worker = null;
        setTimeout(() => {
          console.log("[Worker] Restarting after health check failure...");
          startWorker(workerId);
        }, 2000);
        clearInterval(healthCheckInterval);
      } else if (waitingCount > 0) {
        console.log("[Worker] Health OK: " + waitingCount + " jobs waiting, last active " + Math.round(timeSinceActivity / 1000) + "s ago");
      }
    } catch (err: any) {
      console.warn("[Worker] Health check error (non-fatal): " + err.message);
    }
  }, HEALTH_CHECK_INTERVAL);

  console.log("[Worker] Started with concurrency=" + MAX_CONCURRENT + ", timeout=" + JOB_TIMEOUT + "ms, maxRetries=" + MAX_RETRY_ATTEMPTS);
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

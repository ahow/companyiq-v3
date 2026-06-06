/**
 * BullMQ Worker for CompanyIQ v3
 * 
 * Implements fair-share scheduling across workspaces:
 * - Each workspace gets equal processing priority regardless of batch size
 * - Configurable concurrency per worker instance
 * - Automatic retry with exponential backoff
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

// ─── Job Processor ──────────────────────────────────────────────────────────

async function processAnalysisJob(job: Job<AnalysisJobData>): Promise<PipelineResult> {
  const { jobId, companyId, frameworkId, batchId, workspaceId, skipFetch } = job.data;

  console.log(`[Worker] Processing job ${jobId}: company=${companyId}, framework=${frameworkId}, batch=${batchId}, workspace=${workspaceId}`);

  // Claim the job in our DB
  const claimed = await storage.claimJob(jobId as number);
  if (!claimed) {
    console.warn(`[Worker] Job ${jobId} could not be claimed (already taken or not pending)`);
    return { success: false, error: "Could not claim job", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  // Load company, framework, and measures
  const company = await storage.getCompanyById(companyId, workspaceId);
  if (!company) {
    await storage.failJob(jobId, "Company not found");
    return { success: false, error: "Company not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const framework = await storage.getFrameworkById(frameworkId, workspaceId);
  if (!framework) {
    await storage.failJob(jobId, "Framework not found");
    return { success: false, error: "Framework not found", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  const measures = await storage.getFrameworkMeasures(frameworkId);
  if (measures.length === 0) {
    await storage.failJob(jobId, "No measures in framework");
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
      console.log(`[Worker] Job ${jobId} completed successfully`);
    } else if (result.error === "Cancelled") {
      console.log(`[Worker] Job ${jobId} cancelled`);
    } else {
      await storage.failJob(jobId, result.error || "Unknown error");
      await storage.incrementBatchFailed(batchId);
      console.warn(`[Worker] Job ${jobId} failed: ${result.error}`);
    }

    // Check if batch is complete
    // Increment the appropriate counter and then check totals
    if (result.success) {
      await storage.incrementBatchCompleted(batchId);
    }
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const [batchRow] = await db.execute(sql`SELECT * FROM batch_runs WHERE id = ${batchId}`).then(r => r.rows) as any[];
    if (batchRow && (Number(batchRow.completed_jobs) + Number(batchRow.failed_jobs) >= Number(batchRow.total_jobs))) {
      console.log(`[Worker] Batch ${batchId} complete: ${batchRow.completed_jobs} completed, ${batchRow.failed_jobs} failed`);
      await storage.completeBatchRun(batchId);
      // Save results after a delay to ensure all in-flight jobs finish persisting
      setTimeout(async () => {
        try {
          await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, batchRow.list_id ? Number(batchRow.list_id) : undefined);
        } catch (err: any) {
          console.error(`[Worker] Failed to save results for batch ${batchId}: ${err.message}`);
        }
      }, 60000); // 1 minute delay for in-flight jobs to finish persisting
    }

    return result;
  } catch (error: any) {
    console.error(`[Worker] Job ${jobId} threw error: ${error.message}`);
    await storage.failJob(jobId, error.message);
    await storage.incrementBatchFailed(batchId);
    return { success: false, error: error.message, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }
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
        measureScores: scores.map(s => ({
          measureId: s.measureId,
          title: s.title || "",
          category: s.category || "",
          score: s.score,
          verdict: s.verdict || undefined,
          evidenceSummary: s.evidenceSummary || undefined,
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

  console.log(`[Worker] Started with concurrency=${MAX_CONCURRENT}, timeout=${JOB_TIMEOUT}ms`);
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

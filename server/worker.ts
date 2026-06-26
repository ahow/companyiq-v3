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
import { isBatchCancelled, isBatchCancelledCached, markBatchCancelled, forgetBatchCancellation } from "./cancellation.js";
import { isCreditAlertActive } from "./lib/credit-breaker.js";

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
  const nonRetriable = [
    "Company not found",
    "Framework not found",
    "No measures in framework",
    "Could not claim job",
    // A watchdog timeout means the pipeline hung (typically un-fetchable company /
    // no domain). Retrying just hangs again for another full timeout window, so
    // treat it as a final failure to free the slot and let the batch close.
    "Job watchdog timeout",
  ];
  return !nonRetriable.some(msg => error.includes(msg));
}

async function reEnqueueForRetry(jobData: AnalysisJobData, attemptNumber: number): Promise<void> {
  // Never resurrect a cancelled batch via a retry.
  if (cancelledBatches.has(jobData.batchId) || isBatchCancelledCached(jobData.batchId)) {
    console.log("[Worker] Skipping retry re-enqueue for job " + jobData.jobId + " — batch " + jobData.batchId + " is cancelled");
    return;
  }
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

  // CREDIT BREAKER PAUSE: if a credit-exhaustion alert is active system-wide, do
  // NOT process (which would burn time/credits on 402s). Re-queue this job with a
  // delay so that once credit is topped up — and the breaker auto-clears on a
  // successful probe — the job resumes automatically. We DO NOT mark it failed or
  // claim it, so no progress/attempt is lost.
  if (process.env.CREDIT_PAUSE_ENABLED !== "false" && await isCreditAlertActive()) {
    if (!(cancelledBatches.has(batchId) || isBatchCancelledCached(batchId))) {
      const delayMs = parseInt(process.env.CREDIT_PAUSE_REQUEUE_MS || "60000", 10);
      try {
        const { getQueue } = await import("./queue.js");
        const q = getQueue();
        const jobIdStr = "batch-" + batchId + "-company-" + companyId + "-creditpause-" + Date.now();
        await q.add("analysis-creditpause-" + batchId + "-" + companyId, job.data, { delay: delayMs, priority: 1, jobId: jobIdStr });
        console.warn("[Worker] CREDIT PAUSE active — job " + jobId + " re-queued with " + delayMs + "ms delay (not processed, no credits spent)");
      } catch (err: any) {
        console.error("[Worker] Credit-pause re-enqueue failed for job " + jobId + ": " + err.message);
      }
    }
    return { success: false, error: "Paused: credit exhausted", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }

  // Check if batch was cancelled. Authoritative (async) check against Redis so
  // that a cancel issued on the web service is honored by every worker replica,
  // including jobs already pulled from the queue. This also seeds the local
  // synchronous cache used by the pipeline's cancelCheck below.
  if (cancelledBatches.has(batchId) || (await isBatchCancelled(batchId))) {
    cancelledBatches.add(batchId);
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

  // Run the pipeline. cancelCheck stays synchronous (the pipeline calls it at
  // many hot checkpoints) but is backed by a Redis-refreshed cache, so an
  // in-flight pipeline aborts within ~2s of a cancel on any replica.
  const cancelCheck = () => cancelledBatches.has(batchId) || isBatchCancelledCached(batchId);

  try {
    // Hard watchdog: the analysis pipeline can occasionally hang on a network
    // fetch/discovery step that has no inner socket timeout (e.g. companies with
    // no domain whose document discovery never returns). Without this race, such
    // a job awaits forever, permanently occupying a concurrency slot and freezing
    // the batch counter (BullMQ does NOT abort a still-running async function;
    // lockDuration/stalledInterval only trigger if the worker process dies).
    // Racing against JOB_TIMEOUT guarantees the slot is freed and the job is
    // marked failed so the batch can always reach completion.
    const result = await Promise.race([
      runAnalysisPipeline({
        company,
        framework,
        measures,
        workspaceId,
        cancelCheck,
        skipFetch,
      }),
      new Promise<PipelineResult>((_, reject) =>
        setTimeout(
          () => reject(new Error("Job watchdog timeout after " + JOB_TIMEOUT + "ms")),
          JOB_TIMEOUT
        )
      ),
    ]);

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
      await maybeHandleBatchCompletion(batchRow, batchId, frameworkId, workspaceId);
    } else if (result.error !== "Cancelled") {
      // For failed jobs (final failure only), check if batch is now complete
      if (currentAttempt >= MAX_RETRY_ATTEMPTS || !isRetriableError(result.error || "")) {
        try {
          const { db } = await import("./db.js");
          const { sql } = await import("drizzle-orm");
          const batchResult = await db.execute(sql`SELECT * FROM batch_runs WHERE id = ${batchId}`);
          const batchRow = batchResult.rows[0] as any;
          await maybeHandleBatchCompletion(batchRow, batchId, frameworkId, workspaceId);
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
        await maybeHandleBatchCompletion(batchRow, batchId, frameworkId, workspaceId);
      } catch (checkErr: any) {
        console.error("[Worker] Failed to check batch completion after error: " + checkErr.message);
      }
    }
    return { success: false, error: error.message, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  }
}

// ─── Batch Completion Review Gate ────────────────────────────────────────────
//
// When a batch finishes (all jobs terminal), we DO NOT auto-save results to the
// Results page if there are terminal failures. Instead the batch enters
// `pending_review` and a `batch_review` system alert is raised so the user can
// either re-examine the failed companies or discard them and finalise. Batches
// with zero terminal failures auto-finalise (save) exactly as before.
//
// This is invoked from all batch-completion sites. It is idempotent: it only
// acts when the batch has just reached the terminal job count and is still in a
// non-terminal status (running). Concurrent callers are guarded by
// `finalizingBatches`.
const finalizingBatches = new Set<number>();

async function maybeHandleBatchCompletion(
  batchRow: any,
  batchId: number,
  frameworkId: number,
  workspaceId: number,
): Promise<void> {
  if (!batchRow) return;
  const completed = Number(batchRow.completed_jobs);
  const failed = Number(batchRow.failed_jobs);
  const total = Number(batchRow.total_jobs);
  if (completed + failed < total) return; // not done yet

  // Only the first caller that observes a still-active batch proceeds.
  const status = String(batchRow.status || "");
  if (status === "completed" || status === "pending_review" || status === "cancelled") return;
  if (finalizingBatches.has(batchId)) return;
  finalizingBatches.add(batchId);

  try {
    const listId = batchRow.list_id ? Number(batchRow.list_id) : undefined;

    if (failed > 0) {
      // ── Option (a): pause for review, do NOT save ──
      console.log(
        "[Worker] Batch " + batchId + " finished with " + failed +
        " terminal failure(s) — entering pending_review (results NOT saved)",
      );
      await storage.setBatchRunStatus(batchId, "pending_review");

      // Build a concise failure list for the alert payload.
      let failedList: Array<{ companyId: number; companyName: string; error: string }> = [];
      try {
        failedList = await storage.getFailedJobsForBatch(batchId);
      } catch (e: any) {
        console.warn("[Worker] Could not load failed jobs for batch " + batchId + ": " + e.message);
      }
      const names = failedList.slice(0, 5).map(f => f.companyName).filter(Boolean);
      const more = failedList.length > names.length ? " +" + (failedList.length - names.length) + " more" : "";
      const msg =
        "Batch #" + batchId + " finished with " + failed + " failed compan" +
        (failed === 1 ? "y" : "ies") + " (" + completed + " succeeded). Review before saving to Results" +
        (names.length ? ": " + names.join(", ") + more : ".");
      try {
        await storage.setSystemAlert({
          kind: "batch_review",
          provider: String(batchId),
          message: msg,
        });
      } catch (e: any) {
        console.warn("[Worker] Could not raise batch_review alert: " + e.message);
      }
      return;
    }

    // ── Zero failures: finalise + save exactly as before ──
    console.log(
      "[Worker] Batch " + batchId + " complete with no failures: " + completed + " succeeded — finalising",
    );
    await storage.completeBatchRun(batchId);
    setTimeout(async () => {
      try {
        await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
      } catch (err: any) {
        console.error("[Worker] Failed to save results for batch " + batchId + ": " + err.message);
      }
    }, 60000);
  } finally {
    finalizingBatches.delete(batchId);
  }
}

/**
 * Explicit finalisation used by the review endpoints' "discard & finalise" path.
 * Marks the batch completed and saves results immediately (no 60s delay).
 */
export async function finalizeBatchAndSave(
  batchId: number,
  frameworkId: number,
  workspaceId: number,
  listId?: number,
): Promise<void> {
  await storage.completeBatchRun(batchId);
  await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
  try {
    await storage.clearSystemAlert("batch_review", String(batchId));
  } catch { /* non-fatal */ }
}

/**
 * Save a results snapshot for a batch WITHOUT changing its status. Used as a
 * safeguard when a batch is cancelled, so any completed companies are still
 * preserved on the Results page rather than discarded. Idempotent: skips if a
 * snapshot already exists for the batch.
 */
export async function saveBatchSnapshot(
  batchId: number,
  frameworkId: number,
  workspaceId: number,
  listId?: number,
): Promise<boolean> {
  try {
    const existing = await storage.getAnalysisResultsMeta(workspaceId);
    if (existing.some((r: any) => r.batchId === batchId)) return false;
    await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
    const after = await storage.getAnalysisResultsMeta(workspaceId);
    return after.some((r: any) => r.batchId === batchId);
  } catch (err: any) {
    console.error("[Worker] saveBatchSnapshot failed for batch " + batchId + ": " + err.message);
    return false;
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

    // Full list of framework measures, used to back-fill any measure that has no
    // measure_scores row for a company so EVERY company in the saved snapshot
    // carries ALL measures (missing ones explicitly score 0 / "No" / no evidence).
    const allMeasures = await storage.getFrameworkMeasures(frameworkId);
    const measureCount = allMeasures.length;

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
      // Fetch-coverage signal (how much discovered evidence was actually read).
      const fetchCoverage = diagnostics?.fetchCoverage || null;
      // v3l (CORPUS_DRIFT_REDESIGN_V3 §4): run manifest / ranker provenance so the
      // saved snapshot and shared link carry determinism evidence.
      const manifest = {
        pipelineVersion: "v3l-r1",
        gitSha: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || undefined,
        candidatePoolFingerprint: diagnostics?.candidatePoolFingerprint ?? undefined,
        finalCorpusFingerprint: diagnostics?.finalCorpusFingerprint ?? diagnostics?.candidateFingerprint ?? undefined,
        rankerDiagnostics: diagnostics?.rankerDiagnostics ?? undefined,
        nearDupCollapsedGroups: diagnostics?.nearDupCollapsedGroups ?? undefined,
        capUsed: diagnostics?.capUsed ?? undefined,
      };

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
        documentsFetched: fetchCoverage?.documentsFetched ?? undefined,
        documentsDiscovered: fetchCoverage?.documentsDiscovered ?? undefined,
        fetchRatio: fetchCoverage?.fetchRatio ?? undefined,
        lowEvidence: fetchCoverage?.lowEvidence ?? undefined,
        manifest,
        sourceDocuments,
        measureScores: buildFullMeasureScores(allMeasures, scores),
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

    // ── Reconciliation guarantee ──────────────────────────────────────────
    // Every company in the batch must be accounted for as either SAVED (in the
    // snapshot) or terminally FAILED. saved + failed must equal the batch total.
    // Also assert every saved company carries the full measure set.
    try {
      await reconcileBatchSave(batchId, resultsData, measureCount);
    } catch (e: any) {
      console.warn("[Worker] Reconciliation check error for batch " + batchId + ": " + e.message);
    }
  } catch (error: any) {
    console.error("[Worker] Failed to save analysis results for batch " + batchId + ": " + error.message);
  }
}

/**
 * Merge a company's measure_scores rows against the FULL framework measure list
 * so the saved record always contains EVERY measure. Measures with no score row
 * are emitted explicitly at score 0 / verdict "No" / no evidence, flagged with
 * `backfilled: true` for transparency. Never fabricates evidence.
 */
function buildFullMeasureScores(allMeasures: any[], scores: any[]): any[] {
  const byId = new Map<string, any>();
  for (const s of scores) byId.set(String(s.measureId), s);
  return allMeasures.map((m: any) => {
    const s = byId.get(String(m.measureId));
    if (s) {
      return {
        measureId: s.measureId,
        title: s.title || m.title || "",
        category: s.category || m.category || "",
        score: s.score,
        verdict: s.verdict || undefined,
        confidence: s.confidence || "Low",
        evidenceSummary: s.evidenceSummary || undefined,
        quotes: s.quotes || [],
      };
    }
    // Back-filled: measure was not scored for this company (no data) — include it
    // explicitly rather than silently dropping it.
    return {
      measureId: m.measureId,
      title: m.title || "",
      category: m.category || "",
      score: 0,
      verdict: "No",
      confidence: "Low",
      evidenceSummary: undefined,
      quotes: [],
      backfilled: true,
    };
  });
}

/**
 * Post-save reconciliation. Confirms saved + terminally-failed = total batch
 * jobs, and that every saved company has the full measure set. Records a
 * `batch_reconcile` system alert when the numbers don't add up so the
 * discrepancy is surfaced rather than hidden.
 */
async function reconcileBatchSave(batchId: number, resultsData: any[], measureCount: number): Promise<void> {
  const { db } = await import("./db.js");
  const { sql } = await import("drizzle-orm");
  const counts = await db.execute(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status NOT IN ('completed','failed'))::int AS open
    FROM analysis_jobs WHERE batch_id = ${batchId}
  `);
  const r: any = counts.rows[0] || {};
  const total = Number(r.total || 0);
  const completed = Number(r.completed || 0);
  const failed = Number(r.failed || 0);
  const open = Number(r.open || 0);
  const saved = resultsData.length;

  // Measure-completeness: every saved company must carry all framework measures.
  const incomplete = measureCount > 0
    ? resultsData.filter(c => !Array.isArray(c.measureScores) || c.measureScores.length !== measureCount)
    : [];

  const balanced = (saved + failed === total) && open === 0;
  const measuresOk = incomplete.length === 0;

  console.log(
    "[Reconcile] batch " + batchId + ": total=" + total + " saved=" + saved +
    " failed=" + failed + " open=" + open + " | saved+failed=" + (saved + failed) +
    (balanced ? " OK" : " MISMATCH") +
    " | measures/company=" + measureCount + " incomplete=" + incomplete.length +
    (measuresOk ? " OK" : " MISMATCH"),
  );

  if (!balanced || !measuresOk) {
    const parts: string[] = [];
    if (!balanced) parts.push("saved(" + saved + ")+failed(" + failed + ")!=total(" + total + ")" + (open ? ", open=" + open : ""));
    if (!measuresOk) parts.push(incomplete.length + " compan" + (incomplete.length === 1 ? "y" : "ies") + " missing measures");
    try {
      await storage.setSystemAlert({
        kind: "batch_reconcile",
        provider: String(batchId),
        message: "Batch #" + batchId + " reconciliation mismatch: " + parts.join("; "),
      });
    } catch { /* non-fatal */ }
  } else {
    try { await storage.clearSystemAlert("batch_reconcile", String(batchId)); } catch { /* non-fatal */ }
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
  // Local flag for this process (cheap fast-path)...
  cancelledBatches.add(batchId);
  // ...and a durable, cross-process signal in Redis so every worker replica
  // honors the cancel for jobs they have already pulled or have queued/delayed.
  void markBatchCancelled(batchId);
  // Clean up local memory after 1 hour (Redis key has its own TTL).
  setTimeout(() => {
    cancelledBatches.delete(batchId);
    forgetBatchCancellation(batchId);
  }, 3600000);
}

export async function stopWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
    console.log("[Worker] Stopped");
  }
  try {
    const { closeSharedBrowser } = await import("./lib/processor.js");
    await closeSharedBrowser();
  } catch {
    /* ignore */
  }
}

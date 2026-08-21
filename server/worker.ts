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
import { runAnalysisPipeline, type PipelineResult, type BatchFetchState, newBatchFetchState } from "./lib/pipeline.js";
import * as storage from "./storage.js";
import crypto from "crypto";
import { isBatchCancelled, isBatchCancelledCached, markBatchCancelled, forgetBatchCancellation } from "./cancellation.js";
import { detectScoreAnomalies } from "./lib/anomaly-detection.js";
import { isCreditAlertActive, ProviderScoringError } from "./lib/credit-breaker.js";
import {
  classifyProviderError,
  pauseProvider,
  resumeProvider,
  isProviderPaused,
  getAllPausedProviders,
  buildOperationalStatus,
  buildFailureRecord,
  type ProviderPauseState,
} from "./lib/provider-resilience.js";
import { buildGateReport, deploymentFingerprintFromEnvironment, fingerprintsEqual, type EvidenceSnapshot } from "./lib/reliability.js";

const QUEUE_NAME = "analysis";
const MAX_CONCURRENT = parseInt(process.env.WORKER_CONCURRENCY || "10", 10);
const JOB_TIMEOUT = parseInt(process.env.JOB_TIMEOUT_MS || "600000", 10); // 10 min default
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30000; // 30 seconds between retries

// Track cancelled batches
const cancelledBatches = new Set<number>();
// 42-F: Batch-scoped circuit-breaker state, keyed by batchId.
const batchFetchStates = new Map<number, BatchFetchState>();

export interface AnalysisJobData {
  kind?: "analysis";
  jobId: number;
  companyId: number;
  frameworkId: number;
  batchId: number;
  workspaceId: number;
  skipFetch?: boolean;
  sourceBatchId?: number; // Corpus replay: read corpus from this source batch
}

export interface ReliabilityFinalizerData {
  kind: "reliability_finalizer";
  testCycleId: string;
  workspaceId: number;
  expectedCompanyCount: number;
  deploymentFingerprint: ReturnType<typeof deploymentFingerprintFromEnvironment>;
}

export type QueueJobData = AnalysisJobData | ReliabilityFinalizerData;

async function finalizeReliabilityCycle(data: ReliabilityFinalizerData): Promise<PipelineResult> {
  const existing = await storage.getGateReport(data.testCycleId, data.workspaceId);
  if (existing) return { success: true, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };

  const snapshots = await storage.getAcceptedEvidenceSnapshots(data.testCycleId, data.workspaceId) as EvidenceSnapshot[];
  const selection = (await import("./lib/reliability.js")).selectValidEvidenceSnapshots(snapshots, {
    expectedCompanyCount: data.expectedCompanyCount,
    deploymentFingerprint: data.deploymentFingerprint,
    requiredSnapshotCount: 4,
  });
  for (const rejected of selection.rejected) {
    await storage.recordReliabilityAuditEvent({
      workspaceId: data.workspaceId,
      batchId: rejected.snapshot.batchId,
      artifactId: rejected.snapshot.runKey,
      eventType: "rejection",
      reason: rejected.reason,
      metadata: { testCycleId: data.testCycleId, finalizer: true },
    });
  }
  if (selection.accepted.length !== 4) {
    throw new Error(`Gate Report waiting for four valid accepted snapshots; found ${selection.accepted.length}`);
  }

  const report = buildGateReport(data.testCycleId, selection.accepted, data.deploymentFingerprint, data.expectedCompanyCount);
  if (report.gates.length !== 7 || report.gates.some((gate) => !gate.passed)) {
    throw new Error("Gate Report schema or gate validation failed");
  }
  const reportMarkdown = [
    `# Gate Report: ${data.testCycleId}`,
    "",
    `Source run keys: ${report.sourceRunKeys.join(", ")}`,
    "",
    "## Gates",
    ...report.gates.map((gate) => `- Gate ${gate.id} (${gate.name}): ${gate.passed ? "PASS" : "FAIL"} — ${gate.reason}`),
    "",
    "## Machine-readable report",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
  ].join("\\n");
  const saved = await storage.saveGateReportIdempotent({
    workspaceId: data.workspaceId,
    testCycleId: data.testCycleId,
    deploymentFingerprint: data.deploymentFingerprint,
    sourceRunKeys: report.sourceRunKeys,
    reportData: report,
    reportMarkdown,
  });
  if (!saved) throw new Error("Gate Report persistence returned no row");
  await storage.recordReliabilityAuditEvent({
    workspaceId: data.workspaceId,
    eventType: "finalization",
    reason: "idempotent Gate Report persisted after four accepted snapshots",
    metadata: { testCycleId: data.testCycleId, reportId: saved.id, sourceRunKeys: report.sourceRunKeys },
  });
  return { success: true, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
}

export async function enqueueReliabilityFinalizer(data: ReliabilityFinalizerData): Promise<void> {
  const { getQueue } = await import("./queue.js");
  const q = getQueue();
  const jobId = `reliability-finalizer-${data.testCycleId}`;
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "waiting" || state === "active" || state === "delayed") return;
    if (state === "failed") await existing.remove();
  }
  await q.add(`reliability-finalizer-${data.testCycleId}`, data, {
    priority: 0,
    jobId,
  });
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

/**
 * Detect if an error is a provider quota/auth failure that should trigger a
 * system-wide pause rather than a per-job retry. Returns the failure class
 * or null if it's a normal retriable/non-retriable error.
 */
function isProviderQuotaError(error: any): boolean {
  if (error instanceof ProviderScoringError) {
    return error.failureClass === "quota_exhausted" || error.failureClass === "authentication";
  }
  if (typeof error === "string") {
    return error.includes("quota_exhausted") || error.includes("ProviderScoringError");
  }
  return false;
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

async function processAnalysisJob(job: Job<QueueJobData>): Promise<PipelineResult> {
  if (job.data.kind === "reliability_finalizer") {
    return finalizeReliabilityCycle(job.data);
  }
  const { jobId, companyId, frameworkId, batchId, workspaceId, skipFetch, sourceBatchId } = job.data;

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

  // OFF-PEAK SCHEDULING GATE: If this batch is marked offPeakOnly and we are
  // currently in a DeepSeek peak hour (01:00-04:00 or 06:00-10:00 UTC), re-queue
  // the job with a delay until the next off-peak window starts. This halves API
  // costs by deferring processing to off-peak rates.
  if (process.env.OFFPEAK_GATE_ENABLED !== "false") {
    const hour = new Date().getUTCHours();
    const isPeak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
    if (isPeak) {
      // Check if this batch is off-peak-only
      try {
        const batchRow = await storage.getBatchRunById(batchId, workspaceId);
        if (batchRow && batchRow.offPeakOnly) {
          // Calculate delay until next off-peak window
          const now = new Date();
          let target: Date;
          if (hour >= 1 && hour < 4) {
            target = new Date(now); target.setUTCHours(4, 0, 0, 0);
          } else {
            target = new Date(now); target.setUTCHours(10, 0, 0, 0);
          }
          const delayMs = Math.max(target.getTime() - now.getTime(), 60000);
          const { getQueue } = await import("./queue.js");
          const q = getQueue();
          const jobIdStr = `batch-${batchId}-company-${companyId}-offpeak-${Date.now()}`;
          await q.add(`analysis-offpeak-${batchId}-${companyId}`, job.data, { delay: delayMs, priority: 2, jobId: jobIdStr });
          console.log(`[Worker] OFF-PEAK GATE: job ${jobId} deferred ${Math.round(delayMs / 60000)}min until off-peak (batch ${batchId} is offPeakOnly)`);
          return { success: false, error: "Deferred: peak hour", documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
        }
      } catch (err: any) {
        // Non-fatal: if we can't check, process normally
        console.warn(`[Worker] Off-peak gate check failed (non-fatal): ${err.message}`);
      }
    }
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

  const heartbeatIntervalMs = parseInt(process.env.JOB_HEARTBEAT_MS || "30000", 10);
  const heartbeatTimer = setInterval(() => {
    void storage.updateJobProgress(jobId, { stage: "pipeline", companyId, frameworkId }).catch((error: any) => {
      console.warn(`[Worker] heartbeat failed for job ${jobId}: ${error?.message || error}`);
    });
  }, heartbeatIntervalMs);

  try {
    // Hard watchdog: the analysis pipeline can occasionally hang on a network
    // fetch/discovery step that has no inner socket timeout. The heartbeat above
    // records genuine work even when aggregate counters remain unchanged.
    let result: PipelineResult;
    try {
      result = await Promise.race([
        runAnalysisPipeline({
          company,
          framework,
          measures,
          workspaceId,
          batchId,
          cancelCheck,
          skipFetch,
          sourceBatchId,
          // 42-F: Share circuit-breaker state across all companies in the batch
          batchFetchState: (() => {
            if (!batchFetchStates.has(batchId)) batchFetchStates.set(batchId, newBatchFetchState());
            return batchFetchStates.get(batchId)!;
          })(),
        }),
        new Promise<PipelineResult>((_, reject) =>
          setTimeout(
            () => reject(new Error("Job watchdog timeout after " + JOB_TIMEOUT + "ms")),
            JOB_TIMEOUT
          )
        ),
      ]);
    } finally {
      clearInterval(heartbeatTimer);
    }

    if (result.success) {
      await storage.completeJob(jobId);
      console.log("[Worker] Job " + jobId + " completed successfully (attempt " + currentAttempt + ")");

      // Fix B: Update priorBestScore if this run's total exceeds the stored value.
      // This enables the below-prior-best diagnostics path (Instruction 8).
      try {
        const scores = await storage.getMeasureScores(companyId, frameworkId);
        const runTotal = scores.reduce((sum: number, s: any) => sum + (s.score || 0), 0);
        const existing = (company as any).priorBestScore || 0;
        if (runTotal > existing) {
          await storage.updateCompany(companyId, workspaceId, {
            priorBestScore: runTotal,
          } as any);
        }
      } catch (e: any) {
        console.warn(`[${company.name}] priorBestScore update failed: ${e.message}`);
      }

      // Instruction 13: Multi-line diagnostics + DB dual-write for zero-score and
      // below-prior-best companies. Split into short prefixed lines so Railway's
      // log viewer doesn't truncate/filter the single JSON blob.
      try {
        const companyScores = await storage.getMeasureScores(companyId, frameworkId);
        const totalScore = companyScores.reduce((sum: number, s: any) => sum + (s.score || 0), 0);

        // I45: Log scoring diagnostics for every completed company so Gate Report
        // can aggregate fleet-level timeout/fallback/failure counts.
        if (result.analysis?.scoringDiagnostics) {
          const sd = result.analysis.scoringDiagnostics;
          console.log(`[Worker][I45-diag] company=${companyId} fw=${frameworkId} score=${totalScore} failures=${sd.scoringFailures} timeouts=${sd.timeouts} fallback=${sd.fallbackUsed} defaultScore=${sd.defaultScoreUsed} emptyEvidence=${sd.evidencePackCounts.empty}`);
        }

        // Instruction 21: No hardcoded company names. Use the company's own
        // historical best score as the threshold for below-prior-best diagnostics.
        const priorBestScore = (company as any).priorBestScore || 0;
        const isBelowPriorBest = priorBestScore > 0 && totalScore < priorBestScore && totalScore > 0;
        if (totalScore === 0 || isBelowPriorBest) {
          const allDocs = await storage.getAcceptedDocuments(companyId);
          const okDocs = allDocs.filter((d: any) => d.fetchStatus === "ok");
          const deadDocs = allDocs.filter((d: any) => d.fetchStatus === "dead");
          const pinnedDocs = (company.pinnedDocuments as string[]) || [];
          const pinnedOk = pinnedDocs.filter(url => okDocs.some((d: any) => d.url === url)).length;
          const deadByReason: Record<string, number> = {};
          for (const d of deadDocs) {
            const reason = (d as any).failureReason || "unknown";
            deadByReason[reason] = (deadByReason[reason] || 0) + 1;
          }
          const diag = (company as any).discoveryDiagnostics || {};
          const tag = isBelowPriorBest ? "below-prior-best-diag" : "zero-score-diag";
          const diagData = {
            tag,
            companyName: company.name,
            totalScore,
            priorBestThreshold: priorBestScore || null,
            frameworkId,
            documentsDiscovered: allDocs.length,
            documentsFetched: okDocs.length,
            fetchRatio: +(okDocs.length / Math.max(1, allDocs.length)).toFixed(2),
            pinnedDocumentsAttempted: pinnedDocs.length,
            pinnedDocumentsFetchedOk: pinnedOk,
            hasRequiredDataDoc: !(diag.corpusValidityWarning),
            corpusValidityWarning: diag.corpusValidityWarning || null,
            deadByReason,
          };
          // Multi-line prefixed output (Railway-friendly)
          const prefix = `[${tag}] ${company.name}`;
          console.log(`${prefix} score=${totalScore} fw=${frameworkId} docs=${allDocs.length} fetched=${okDocs.length} ratio=${diagData.fetchRatio}`);
          console.log(`${prefix} pinned=${pinnedDocs.length} pinnedOk=${pinnedOk} hasDataDoc=${diagData.hasRequiredDataDoc} warning=${diagData.corpusValidityWarning || "none"}`);
          console.log(`${prefix} deadByReason=${JSON.stringify(deadByReason)}`);
          // DB dual-write: persist to discoveryDiagnostics so it's accessible via API
          try {
            const existingDiag = (company as any).discoveryDiagnostics || {};
            existingDiag.lastZeroScoreDiag = diagData;
            await storage.updateCompany(companyId, workspaceId, { discoveryDiagnostics: existingDiag } as any);
          } catch (dbErr: any) {
            console.warn(`${prefix} DB dual-write failed: ${dbErr.message}`);
          }
        }
      } catch (diagErr: any) {
        console.warn("[Worker] Zero-score diagnostics failed: " + diagErr.message);
      }
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

    // PROVIDER QUOTA PAUSE: if the error is a provider quota/auth failure,
    // do NOT count this as a permanent failure or burn retries. Instead,
    // persist the failure class, re-enqueue with credit-pause delay, and
    // let the system-wide pause handle recovery. The job stays in the SAME
    // batch and will resume when the provider recovers.
    if (isProviderQuotaError(error)) {
      const failureClass = (error instanceof ProviderScoringError) ? error.failureClass : "quota_exhausted";
      const failedProvider = (error instanceof ProviderScoringError) ? error.provider : "unknown";
      console.warn(`[Worker] PROVIDER QUOTA PAUSE for job ${jobId} [${failureClass}] — re-enqueuing for resume (not counting as failure)`);
      // Record the failure class in job progress_detail for audit
      await storage.updateJobProgress(jobId, {
        stage: "provider_paused",
        failureClass,
        provider: failedProvider,
        pausedAt: new Date().toISOString(),
        message: error.message?.slice(0, 500),
      });
      // Persist durable failure event for auditability and status reporting
      try {
        const record = buildFailureRecord({
          provider: failedProvider,
          model: "unknown",
          error,
          jobId,
          batchId,
          measureId: undefined,
        });
        await storage.recordProviderFailureEvent(record);
      } catch (persistErr: any) {
        console.warn(`[Worker] Non-fatal: failed to persist provider failure event: ${persistErr.message}`);
      }
      // Reset job back to pending (not failed) so it can be resumed
      await storage.failJob(jobId, `provider_paused:${failureClass}:${error.message?.slice(0, 200)}`);
      // Re-enqueue with credit-pause delay for auto-resume
      const delayMs = parseInt(process.env.CREDIT_PAUSE_REQUEUE_MS || "60000", 10);
      try {
        const { getQueue } = await import("./queue.js");
        const q = getQueue();
        const jobIdStr = `batch-${batchId}-company-${companyId}-quotapause-${Date.now()}`;
        await q.add(`analysis-quotapause-${batchId}-${companyId}`, job.data, { delay: delayMs, priority: 1, jobId: jobIdStr });
      } catch (reqErr: any) {
        console.error(`[Worker] Quota-pause re-enqueue failed for job ${jobId}: ${reqErr.message}`);
      }
      return { success: false, error: `provider_paused:${failureClass}`, documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
    }

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
  // 42-F: Clean up batch-scoped circuit-breaker state
  batchFetchStates.delete(batchId);

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

    // Option A: suppress Results snapshot for single-company / re-exam batches.
    // These are typically auto-reexaminations or manual single-company analyses
    // that clutter the Results page with 1-company rows. The company's scores are
    // still updated live; they'll be included in the next full-run or consolidated
    // snapshot. Only suppress when there's no list_id (re-exams never have one)
    // AND total <= 1.
    if (total <= 1 && !listId) {
      console.log(
        "[Worker] Batch " + batchId + " is a single-company batch with no list — skipping Results snapshot",
      );
      return;
    }

    // Snapshot persistence fix: save synchronously (no setTimeout).
    // The 60s delay was a reliability hazard — a redeploy/crash in that window
    // silently lost the snapshot with no retry or persistence.
    try {
      await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
      await storage.markBatchSnapshotSaved(batchId);
    } catch (err: any) {
      console.error("[Worker] snapshot save failed for batch " + batchId + ": " + err.message);
      // Mark as pending so the self-heal on startup can retry
      try { await storage.markBatchSnapshotPending(batchId); } catch { /* best effort */ }
    }
    // Run anomaly detection after save
    try {
      const jobRows = await storage.getJobsForBatch(batchId);
      const companyIds = jobRows.filter((j: any) => j.status === "completed").map((j: any) => j.companyId || j.company_id);
      await detectScoreAnomalies({ batchId, workspaceId, frameworkId, companyIds });
    } catch (err: any) {
      console.warn("[Worker] Anomaly detection failed for batch " + batchId + ": " + err.message);
    }
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
  // Run anomaly detection after finalise
  try {
    const jobRows = await storage.getJobsForBatch(batchId);
    const companyIds = jobRows.filter((j: any) => j.status === "completed").map((j: any) => j.companyId || j.company_id);
    await detectScoreAnomalies({ batchId, workspaceId, frameworkId, companyIds });
  } catch (err: any) {
    console.warn("[Worker] Anomaly detection failed for batch " + batchId + ": " + err.message);
  }
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
    if (existing.some((r: any) => r.batchId === batchId)) {
      // Snapshot already exists — idempotent success
      return true;
    }
    await saveAnalysisResultsForBatch(batchId, frameworkId, workspaceId, listId);
    const after = await storage.getAnalysisResultsMeta(workspaceId);
    const saved = after.some((r: any) => r.batchId === batchId);
    if (!saved) {
      console.error("[Worker] saveBatchSnapshot: saveAnalysisResultsForBatch completed but no row found for batch " + batchId);
    }
    return saved;
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
    const reliabilityRun = await storage.getReliabilityRunForBatch(batchId);
    const framework = await storage.getFrameworkById(frameworkId, workspaceId);
    if (!framework) return;

    // Full list of framework measures, used to back-fill any measure that has no
    // measure_scores row for a company so EVERY company in the saved snapshot
    // carries ALL measures (missing ones explicitly score 0 / "No" / no evidence).
    const allMeasures = await storage.getFrameworkMeasures(frameworkId);
    const measureCount = allMeasures.length;

    // Get companies from this specific batch's jobs.
    // CRITICAL: Use the batch's own analysis_jobs status as the source of truth
    // for which companies completed successfully, NOT the live company.analysisStatus.
    // The live status can be overwritten by a concurrent batch (e.g. fw3-A resets
    // companies to 'idle' while fw8-A's snapshot is being built).
    const { db } = await import("./db.js");
    const { sql } = await import("drizzle-orm");
    const jobsResult = await db.execute(sql`
      SELECT id, company_id, company_name, status FROM analysis_jobs
      WHERE batch_id = ${batchId}
      ORDER BY id ASC
    `);

    if (jobsResult.rows.length === 0) return;

    // Gather results for each company that was successfully analyzed
    const resultsData: any[] = [];
    for (const row of jobsResult.rows as any[]) {
      // Use batch-scoped job status: only include companies whose job completed
      // in THIS batch. This is immune to concurrent batch resets.
      if (String(row.status) !== "completed") continue;
      const company = await storage.getCompanyById(row.company_id, workspaceId);
      if (!company) continue;

      // Framework-scoped score read: only retrieve scores for this framework
      // to prevent cross-framework contamination in the snapshot.
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
        // Instruction 50 — surface persisted retrieval diagnostics into the
        // snapshot manifest so gate reports can diagnose zero-scoring
        // companies without a re-run. Sourced from company.discoveryDiagnostics
        // (populated by pipeline.ts fetch-phase merge).
        retrievalDiagnostics: diagnostics?.retrievalDiagnostics ?? undefined,
        issuerProfileSummary: diagnostics?.issuerProfileSummary ?? undefined,
        // I51-B — per-measure passage-retrieval telemetry (diagnostic-only).
        // Compact top-3 chunks per measure showing what BM25 selected. Used to
        // diagnose the retrieval→scoring bridge (e.g. Barclays fw8 = 0 despite
        // MSS PDFs in corpus).
        passageRetrievalSummary: diagnostics?.passageRetrievalSummary ?? undefined,
        // I51-A — mass scoring-failure detection. Present when >50% of measures
        // returned _scoringFailure; downstream fleet metrics should exclude
        // these companies rather than treat the mass-zero as substantive.
        scoringFailureSummary: diagnostics?.scoringFailureSummary ?? undefined,
        analysisStatus: (company as any).analysisStatus ?? undefined,
      };

      // Compute coverage-adjusted score: exclude backfilled (not_assessed) measures
      const fullMeasureScores = buildFullMeasureScores(allMeasures, scores);
      const assessedMeasures = fullMeasureScores.filter(m => !m.backfilled);
      const assessedCount = assessedMeasures.length;
      const metCount = assessedMeasures.filter(m => m.score === 1).length;
      const partialCount = assessedMeasures.filter(m => m.score === 0.5).length;
      const coveragePct = measureCount > 0 ? Math.round((assessedCount / measureCount) * 100) : 100;
      // Score computed over assessed measures only (no downward bias from back-fill)
      const adjustedScore = assessedCount > 0
        ? Math.round(((metCount + partialCount * 0.5) / assessedCount) * 100)
        : (company.totalScore || 0);

      // Fix 2 (instrumentation): surface diagnostics so CI/harness can measure
      // corpus validity precision, determinism, and dead-fetch composition.
      const corpusValidityWarning = diagnostics?.corpusValidityWarning || null;
      const hasRequiredDataDoc = !corpusValidityWarning; // true if corpus passed validity check
      // Dead-fetch breakdown by reason (live documents — diagnostics only)
      const allAccepted = await storage.getAcceptedDocuments(company.id);
      const deadDocs = allAccepted.filter((d: any) => d.fetchStatus === "dead");
      const deadByReason: Record<string, number> = {};
      for (const d of deadDocs) {
        const reason = (d as any).failureReason || "unknown";
        deadByReason[reason] = (deadByReason[reason] || 0) + 1;
      }
      // FIX 3 (I44-FU): Compute corpusHash from the frozen batch_corpus snapshot
      // when a batchId exists, using deterministic ORDER BY document_id. This
      // ensures the hash reflects the immutable snapshot rather than the live
      // documents table (which may have been augmented by concurrent discovery).
      // Fallback to live accepted documents only for non-batch contexts.
      let corpusHash: string;
      if (batchId) {
        try {
          const batchCorpusRows = await db.execute(sql`
            SELECT document_id FROM batch_corpus
            WHERE batch_id = ${batchId} AND company_id = ${company.id}
            ORDER BY document_id ASC
          `);
          if (batchCorpusRows.rows.length > 0) {
            corpusHash = batchCorpusRows.rows.map((r: any) => r.document_id).join(",");
          } else {
            // No batch_corpus rows — fall back to live docs (should not happen for
            // properly snapshotted batches, but keeps backward compat)
            const acceptedOk = allAccepted.filter((d: any) => d.fetchStatus === "ok");
            corpusHash = acceptedOk.map((d: any) => d.id).sort((a: number, b: number) => a - b).join(",");
          }
        } catch (bcErr: any) {
          console.warn(`[Worker] batch_corpus hash failed for batch ${batchId}, company ${company.id}: ${bcErr.message}`);
          const acceptedOk = allAccepted.filter((d: any) => d.fetchStatus === "ok");
          corpusHash = acceptedOk.map((d: any) => d.id).sort((a: number, b: number) => a - b).join(",");
        }
      } else {
        const acceptedOk = allAccepted.filter((d: any) => d.fetchStatus === "ok");
        corpusHash = acceptedOk.map((d: any) => d.id).sort((a: number, b: number) => a - b).join(",");
      }

      resultsData.push({
        companyId: company.id,
        companyName: company.name,
        isin: company.isin || undefined,
        sector: company.sector || undefined,
        country: company.country || undefined,
        totalScore: adjustedScore,
        // Instruction 46 FU: Persist corpus hash for replay verification
        corpusHashSha: (() => {
          const ids = corpusHash.split(",").filter(Boolean).map(Number).sort((a: number, b: number) => a - b);
          return ids.length > 0 ? crypto.createHash("sha256").update(ids.join(",")).digest("hex") : "empty";
        })(),
        measuresMetCount: metCount,
        measuresTotalCount: assessedCount,
        measuresCoverage: coveragePct,
        summary: company.summary || undefined,
        coverageLevel,
        missingTier1,
        documentsFetched: fetchCoverage?.documentsFetched ?? undefined,
        documentsDiscovered: fetchCoverage?.documentsDiscovered ?? undefined,
        fetchRatio: fetchCoverage?.fetchRatio ?? undefined,
        lowEvidence: fetchCoverage?.lowEvidence ?? undefined,
        // Instrumentation (Fix 2): diagnostics for CI/harness measurement
        corpusValidityWarning,
        hasRequiredDataDoc,
        deadByReason: Object.keys(deadByReason).length > 0 ? deadByReason : undefined,
        corpusHash,
        manifest,
        sourceDocuments,
        measureScores: fullMeasureScores,
      });
    }

    const expectedCompanyCount = Number((await storage.getBatchRunById(batchId, workspaceId))?.totalJobs || jobsResult.rows.length);
    const snapshotIsComplete = resultsData.length === expectedCompanyCount && jobsResult.rows.length === expectedCompanyCount;

    // ── Instruction 46 FU: Strict replay corpus pinning — quarantine on hash divergence ──
    // When this batch is a corpus replay (sourceBatchId set), verify that every
    // company's corpus hash matches the source batch BEFORE KPI aggregation.
    let replayCorpusDivergence: { mismatchCount: number; mismatches: Array<{ companyId: number }> } | null = null;
    const batchRow = await storage.getBatchRunById(batchId, workspaceId);
    const isReplayBatch = !!(batchRow as any)?.sourceBatchId;
    if (isReplayBatch && snapshotIsComplete) {
      try {
        const sourceBId = (batchRow as any).sourceBatchId as number;
        // Load source batch corpus hashes
        const sourceCorpusRows = await db.execute(sql`
          SELECT company_id, array_agg(document_id ORDER BY document_id) as doc_ids
          FROM batch_corpus WHERE batch_id = ${sourceBId}
          GROUP BY company_id ORDER BY company_id
        `);
        const replayCorpusRows = await db.execute(sql`
          SELECT company_id, array_agg(document_id ORDER BY document_id) as doc_ids
          FROM batch_corpus WHERE batch_id = ${batchId}
          GROUP BY company_id ORDER BY company_id
        `);
        const sourceMap = new Map<number, string>();
        for (const r of sourceCorpusRows.rows as any[]) {
          sourceMap.set(Number(r.company_id), (r.doc_ids || []).join(","));
        }
        const mismatches: Array<{ companyId: number }> = [];
        for (const r of replayCorpusRows.rows as any[]) {
          const cid = Number(r.company_id);
          const replayIds = (r.doc_ids || []).join(",");
          const sourceIds = sourceMap.get(cid) || "";
          if (replayIds !== sourceIds) {
            mismatches.push({ companyId: cid });
          }
        }
        if (mismatches.length > 0) {
          replayCorpusDivergence = { mismatchCount: mismatches.length, mismatches };
          console.warn(`[Worker] REPLAY CORPUS DIVERGENCE: ${mismatches.length}/${expectedCompanyCount} companies have mismatched corpus hashes (batch ${batchId} vs source ${sourceBId})`);
        } else {
          console.log(`[Worker] Replay corpus verification PASSED: ${expectedCompanyCount}/${expectedCompanyCount} corpus hashes match (batch ${batchId} vs source ${sourceBId})`);
        }
      } catch (rcErr: any) {
        console.warn(`[Worker] Replay corpus verification failed (non-fatal): ${rcErr.message}`);
      }
    }

    // Quarantine: if replay divergence detected, reject the snapshot
    const quarantineReason = replayCorpusDivergence
      ? `corpus-hash-divergence: ${replayCorpusDivergence.mismatchCount}/${expectedCompanyCount} companies diverged`
      : null;
    const rejectionReason = quarantineReason
      || (snapshotIsComplete ? null : `snapshot company coverage ${resultsData.length}/${expectedCompanyCount}`);
    if (resultsData.length === 0 && !reliabilityRun) {
      console.warn(`[Worker] saveAnalysisResultsForBatch: no completed companies found for batch ${batchId} (${jobsResult.rows.length} jobs, 0 with completed status in this batch). Possible cause: concurrent batch reset company status.`);
      return;
    }
    if (resultsData.length === 0 && reliabilityRun) {
      // For reliability runs, an empty snapshot is a hard failure — do NOT silently skip.
      // This surfaces the root cause rather than leaving acceptanceState=pending forever.
      throw new Error(`Snapshot build failed: 0/${expectedCompanyCount} companies have scores for batch ${batchId}. Likely cause: concurrent batch overwrote company analysisStatus or measure_scores were cleared.`);
    }
    // Get list name
    let listName: string | undefined;
    if (listId) {
      const list = await storage.getListById(listId, workspaceId);
      listName = (list as any)?.name as string | undefined;
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

    // Calculate average score (exclude null/backfilled measures from per-company scores)
    // Each company's totalScore is already computed from assessed measures only (see below).
    const avgScore = resultsData.length > 0
      ? Math.round(resultsData.reduce((sum, r) => sum + (r.totalScore || 0), 0) / resultsData.length)
      : 0;

    const shareToken = reliabilityRun ? undefined : crypto.randomUUID();
    const artifactId = reliabilityRun ? `artifact-${reliabilityRun.runKey}` : null;
    const saved = await storage.saveAnalysisResults({
      workspaceId,
      batchId,
      runId: reliabilityRun?.id ?? null,
      runKey: reliabilityRun?.runKey ?? null,
      deploymentFingerprint: (reliabilityRun?.deploymentFingerprint as any) ?? null,
      frameworkId,
      frameworkName: framework.name,
      listName,
      resultsData,
      companiesCount: resultsData.length,
      averageScore: avgScore,
      shareToken,
      acceptanceState: reliabilityRun && (!snapshotIsComplete || quarantineReason) ? "rejected" : "pending",
      rejectionReason: rejectionReason || undefined,
    });

    // Explicit failure reporting: if saveAnalysisResults returned null, the
    // snapshot was rejected at the storage layer (empty data or zero companies).
    if (!saved) {
      const msg = `saveAnalysisResults returned null for batch ${batchId} (empty/invalid data rejected at storage layer)`;
      console.error(`[Worker] ${msg}`);
      if (reliabilityRun && artifactId) {
        await storage.markReliabilityRunRejected(reliabilityRun.id, batchId, msg, artifactId);
      }
      throw new Error(msg);
    }

    // Verify the persisted snapshot matches expectations: batchId must match
    // (durable upsert ensures this) and companiesCount must equal expected.
    const persistedBatchMatches = Number(saved.batchId) === batchId;
    const persistedCountMatches = Number(saved.companiesCount || 0) === expectedCompanyCount;
    const persistedSnapshotIsComplete = snapshotIsComplete && !quarantineReason && persistedBatchMatches && persistedCountMatches;

    if (!persistedBatchMatches) {
      console.error(`[Worker] Snapshot batchId mismatch for batch ${batchId}: persisted batchId=${saved.batchId}`);
    }
    if (!persistedCountMatches) {
      console.error(`[Worker] Snapshot companiesCount mismatch for batch ${batchId}: persisted=${saved.companiesCount} expected=${expectedCompanyCount}`);
    }

    if (reliabilityRun) {
      if (persistedSnapshotIsComplete && artifactId) {
        // Artifact-before-acceptance ordering: write artifactId to batch_runs
        // BEFORE attempting acceptance, so the batch_runs row always reflects
        // the artifact even if acceptance fails partway through.
        try {
          const { db: dbLocal } = await import("./db.js");
          const { sql: sqlLocal } = await import("drizzle-orm");
          await dbLocal.execute(sqlLocal`UPDATE batch_runs SET artifact_id = ${artifactId} WHERE id = ${batchId}`);
        } catch (artErr: any) {
          console.error(`[Worker] Failed to write artifactId to batch_runs for batch ${batchId}: ${artErr.message}`);
        }

        // Durable acceptance: verify the snapshot was actually persisted with a
        // non-null artifactId before flipping acceptance state. markReliabilityRunAccepted
        // also independently verifies the snapshot row exists.
        const accepted = await storage.markReliabilityRunAccepted(reliabilityRun.id, batchId, artifactId, "complete immutable snapshot accepted");
        if (accepted) {
          const acceptedSnapshots = await storage.getAcceptedEvidenceSnapshots(reliabilityRun.testCycleId, workspaceId);
          if (reliabilityRun.testCycleId !== "recovery" && acceptedSnapshots.length >= 4) {
            await enqueueReliabilityFinalizer({
              kind: "reliability_finalizer",
              testCycleId: reliabilityRun.testCycleId,
              workspaceId,
              expectedCompanyCount,
              deploymentFingerprint: reliabilityRun.deploymentFingerprint as any,
            });
          }
        } else {
          // Acceptance gate failed (snapshot row missing or artifactId invalid)
          console.error(`[Worker] Durable acceptance gate failed for batch ${batchId}: markReliabilityRunAccepted returned null`);
          await storage.markReliabilityRunRejected(reliabilityRun.id, batchId, "durable acceptance gate failed: snapshot row missing or artifactId invalid", artifactId);
        }
      } else {
        const failReason = !artifactId
          ? "artifactId is null"
          : !persistedBatchMatches
            ? `snapshot batchId mismatch: persisted=${saved.batchId} expected=${batchId}`
            : !persistedCountMatches
              ? `snapshot companiesCount mismatch: persisted=${saved.companiesCount} expected=${expectedCompanyCount}`
              : rejectionReason || "snapshot failed acceptance validation";
        await storage.markReliabilityRunRejected(reliabilityRun.id, batchId, failReason, artifactId);
      }
    }

    if (quarantineReason) {
      console.warn(`[Worker] QUARANTINED batch ${batchId}: ${quarantineReason}`);
    }
    console.log("[Worker] Saved analysis results for batch " + batchId + " (" + resultsData.length + " companies, avg " + avgScore + "%, acceptance=" + (persistedSnapshotIsComplete ? "accepted" : "rejected") + ")");

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
    // Rethrow so callers (finalizeBatchAndSave, saveBatchSnapshot, recover-results)
    // can detect the failure and surface it rather than silently returning saved=false.
    throw error;
  } finally {
    // Always release the guard so a failed save doesn't permanently block re-saving.
    savingBatches.delete(batchId);
  }
}

/**
 * Merge a company's measure_scores rows against the FULL framework measure list
 * so the saved record always contains EVERY measure. Measures with no score row
 * are emitted with score: null / verdict: "not_assessed" and flagged with
 * `backfilled: true`. These are EXCLUDED from the total_score denominator so
 * they don't create downward bias. Never fabricates evidence.
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
    // explicitly with null score / "not_assessed" verdict. These are excluded from
    // the total_score denominator so they don't create downward bias.
    return {
      measureId: m.measureId,
      title: m.title || "",
      category: m.category || "",
      score: null,
      verdict: "not_assessed",
      confidence: null,
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

  worker = new Worker<QueueJobData>(
    QUEUE_NAME,
    processAnalysisJob,
    {
      connection: connection as any,
      concurrency: MAX_CONCURRENT,
      lockDuration: JOB_TIMEOUT, // Must match queue lockDuration (10 min)
      stalledInterval: JOB_TIMEOUT,
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

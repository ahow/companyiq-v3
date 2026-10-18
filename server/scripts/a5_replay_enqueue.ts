/**
 * a5_replay_enqueue.ts — GATE5 corpus-replay enqueue (harness; NOT committed).
 *
 * Mirrors the production-canonical POST /api/analyze/replay storage sequence
 * (server/routes/api.ts) so the prod worker re-scores the EXACT frozen corpus of
 * a source batch with the CURRENT deployed code (A5 RECALL_EXPANSION_POLICY now
 * defaults to "on"). Re-scoring is forced by the worker (freshScoring = !!sourceBatchId),
 * and the frozen corpus is loaded from batch_corpus[sourceBatchId] (no live docs,
 * no discovery). This isolates the A5 retrieval effect from discovery variance.
 *
 * Usage:
 *   # Phase 1 (canary — create batch + all job rows, queue ONLY the first company):
 *   DATABASE_URL=... REDIS_URL=... SOURCE_SHA=<full sha> MODE=canary \
 *     node --import tsx server/scripts/a5_replay_enqueue.ts <sourceBatchId>
 *   # Phase 2 (release — queue all remaining pending jobs for the batch):
 *   DATABASE_URL=... REDIS_URL=... MODE=rest EXISTING_BATCH_ID=<id> \
 *     node --import tsx server/scripts/a5_replay_enqueue.ts
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";
import { deploymentFingerprintFromEnvironment } from "../lib/reliability.js";

const WORKSPACE_ID = 3;
const SOURCE_BATCH_ID = parseInt(process.argv[2] || "1284", 10);
const TEST_CYCLE_ID = process.env.A5_TEST_CYCLE || "a5-gate5-replay";
const BATTERY_LABEL = process.env.A5_BATTERY || "A5-recall-expansion-on";
const COMMIT_SHA = process.env.SOURCE_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown";
const MODE = process.env.MODE || "canary"; // canary | rest
const CANARY_COUNT = parseInt(process.env.CANARY_COUNT || "1", 10);
const EXISTING_BATCH_ID = parseInt(process.env.EXISTING_BATCH_ID || "0", 10);

// Phase 2: queue all remaining pending jobs for an already-created batch.
async function releaseRest() {
  const batch = await storage.getBatchRunById(EXISTING_BATCH_ID, WORKSPACE_ID);
  if (!batch) throw new Error(`Batch ${EXISTING_BATCH_ID} not found`);
  const allJobs = await storage.getJobsForBatch(batch.id);
  const pending = allJobs.filter((j: any) => j.status === "pending");
  const queueJobs = pending.map((j: any) => ({
    jobId: j.id,
    companyId: j.companyId,
    frameworkId: j.frameworkId,
    batchId: batch.id,
    workspaceId: WORKSPACE_ID,
    skipFetch: true,
    sourceBatchId: (batch as any).corpusReplaySourceBatchId ?? (batch as any).sourceBatchId ?? SOURCE_BATCH_ID,
  }));
  await addBatchJobs(queueJobs, WORKSPACE_ID, batch.id);
  console.log(JSON.stringify({ ok: true, mode: "rest", batchId: batch.id, released: queueJobs.length, jobIds: queueJobs.map((j) => j.jobId) }, null, 2));
  process.exit(0);
}

async function main() {
  if (MODE === "rest") return releaseRest();
  const sourceBatch = await storage.getBatchRunById(SOURCE_BATCH_ID, WORKSPACE_ID);
  if (!sourceBatch) throw new Error(`Source batch ${SOURCE_BATCH_ID} not found in workspace ${WORKSPACE_ID}`);
  if (!sourceBatch.frameworkId) throw new Error("Source batch has no framework");

  // Compute source corpus fingerprint from batch_corpus (same as the endpoint).
  const corpusRows = await db.execute(sql`
    SELECT DISTINCT company_id, document_id FROM batch_corpus
    WHERE batch_id = ${sourceBatch.id}
    ORDER BY company_id, document_id
  `);
  if (corpusRows.rows.length === 0) throw new Error("Source batch has no corpus snapshot (batch_corpus empty)");
  const sourceCorpusFingerprint = createHash("sha256")
    .update(corpusRows.rows.map((r: any) => `${r.company_id}:${r.document_id}`).join(","))
    .digest("hex");

  const sourceJobs = await storage.getJobsForBatch(sourceBatch.id);
  const sourceCompanyIds = sourceJobs.map((j: any) => j.companyId);
  const sourceRun = sourceBatch.reliabilityRunId ? await storage.getReliabilityRunForBatch(sourceBatch.id) : null;
  const sourceRunKey = sourceRun?.runKey ?? `batch-${sourceBatch.id}`;

  const liveFingerprint = deploymentFingerprintFromEnvironment();

  // Create reliability run (mirrors endpoint).
  const reliability = await storage.createOrAdoptReliabilityRun({
    workspaceId: WORKSPACE_ID,
    testCycleId: TEST_CYCLE_ID,
    commitSha: COMMIT_SHA,
    frameworkId: sourceBatch.frameworkId,
    listId: sourceBatch.listId ?? null,
    batteryLabel: BATTERY_LABEL,
    deploymentFingerprint: liveFingerprint,
    diagnosticRun: false,
  });
  await storage.updateReliabilityRunLifecycle(reliability.run.id, "running", { lastHeartbeatAt: new Date(), lastProgressAt: new Date() });

  // Create score-only replay batch with replay provenance.
  const batch = await storage.createBatchRun(
    WORKSPACE_ID,
    sourceBatch.frameworkId,
    sourceCompanyIds.length,
    sourceBatch.listId ?? undefined,
    false, // offPeakOnly
    true,  // scoreOnly
    { runId: reliability.run.id, runKey: reliability.run.runKey, testCycleId: TEST_CYCLE_ID, batteryLabel: BATTERY_LABEL, deploymentFingerprint: liveFingerprint },
    { sourceBatchId: sourceBatch.id, sourceRunKey, sourceCorpusFingerprint },
  );
  if (!batch) throw new Error("createBatchRun returned null");

  await storage.recordReliabilityAuditEvent({ workspaceId: WORKSPACE_ID, runId: reliability.run.id, batchId: batch.id, eventType: "corpus_replay", reason: `corpus replay from source batch ${sourceBatch.id}`, metadata: { sourceBatchId: sourceBatch.id, sourceCorpusFingerprint } });

  // Create jobs in the source company order.
  const companies: any[] = [];
  for (const cid of sourceCompanyIds) {
    const c = await storage.getCompanyById(cid, WORKSPACE_ID);
    if (c) companies.push(c);
  }
  const jobsData = companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: sourceBatch.frameworkId! }));
  await storage.createAnalysisJobs(jobsData);
  const allJobs = await storage.getJobsForBatch(batch.id);
  const pendingJobs = allJobs.filter((j: any) => j.status === "pending");
  // CANARY: queue only the first CANARY_COUNT jobs so we can verify the worker
  // is on the new code (snapshot gitSha == deployed SHA, i.e. policy=on) before
  // spending on the remaining 9. Release the rest with MODE=rest once confirmed.
  const canarySlice = pendingJobs.slice(0, CANARY_COUNT);
  const queueJobs = canarySlice.map((j: any) => ({
    jobId: j.id,
    companyId: j.companyId,
    frameworkId: j.frameworkId,
    batchId: batch.id,
    workspaceId: WORKSPACE_ID,
    skipFetch: true,
    sourceBatchId: sourceBatch.id,
  }));
  await addBatchJobs(queueJobs, WORKSPACE_ID, batch.id);

  console.log(JSON.stringify({
    ok: true,
    mode: "canary",
    replayBatchId: batch.id,
    sourceBatchId: sourceBatch.id,
    runKey: reliability.run.runKey,
    sourceCorpusFingerprint,
    canaryQueued: queueJobs.length,
    canaryJobIds: queueJobs.map((j) => j.jobId),
    canaryCompanyIds: canarySlice.map((j: any) => j.companyId),
    totalPendingJobs: pendingJobs.length,
    companyOrder: sourceCompanyIds,
    commitSha: COMMIT_SHA,
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error("ENQUEUE ERROR:", e?.message || e); process.exit(1); });

/**
 * programme_replay_run.ts — launch ONE score-only frozen-corpus replay batch for the
 * stabilisation programme. Re-scores the EXACT frozen corpus of a source batch
 * (batch_corpus[sourceBatchId]) with the CURRENTLY deployed code + flags. No discovery,
 * no live fetch (skipFetch=true, sourceBatchId forces freshScoring in the worker), so the
 * evidence is held constant across runs — only scoring determinism varies. This mirrors
 * the production-canonical POST /api/analyze/replay storage sequence (server/routes/api.ts)
 * and the committed a5_replay_enqueue.ts harness, but single-shot (queues ALL jobs) and
 * parameterised by CLI args. Batches are created as diagnostic reliability runs so they
 * never trip the interactive SINGLE_ACTIVE_BATCH guard.
 *
 * SAFETY: dry-run by default. Pass --confirm to actually create the batch + enqueue.
 * Prints the DB host first (deployment-target verification).
 *
 * Usage:
 *   DATABASE_URL=$(cat /home/ubuntu/.prod_db_url) REDIS_URL=$(cat /home/ubuntu/.prod_redis_url) \
 *     node --import tsx server/scripts/programme_replay_run.ts --ws 3 --source 2654 \
 *       --label fw25-stab-s0-r1 --cycle fw25-stabilisation [--confirm]
 *
 * On success prints a single JSON line: {"ok":true,"replayBatchId":N,"sourceBatchId":M,...}
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { createHash } from "crypto";
import { deploymentFingerprintFromEnvironment } from "../lib/reliability.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

(async () => {
  const workspaceId = parseInt(arg("ws", "3")!, 10);
  const sourceBatchId = parseInt(arg("source", "0")!, 10);
  const testCycleId = arg("cycle", "fw25-stabilisation")!;
  const batteryLabel = arg("label", `replay-${sourceBatchId}-${Date.now()}`)!;
  const confirm = process.argv.includes("--confirm");

  const dbUrl = process.env.DATABASE_URL || "";
  const host = dbUrl.replace(/^.*@/, "").replace(/\/.*$/, "");
  console.error(`[replay] DB host: ${host}`);
  console.error(`[replay] REDIS set: ${process.env.REDIS_URL ? "yes" : "NO"}`);
  console.error(`[replay] ws=${workspaceId} source=${sourceBatchId} cycle=${testCycleId} label=${batteryLabel} confirm=${confirm}`);

  if (!sourceBatchId) throw new Error("--source <batchId> is required");

  const sourceBatch = await storage.getBatchRunById(sourceBatchId, workspaceId);
  if (!sourceBatch) throw new Error(`source batch ${sourceBatchId} not found in ws ${workspaceId}`);
  if (!(sourceBatch as any).frameworkId) throw new Error("source batch has no framework");

  // Compute the source corpus fingerprint from batch_corpus (same scheme as the endpoint).
  const corpusRows = await db.execute(sql`
    SELECT DISTINCT company_id, document_id FROM batch_corpus
    WHERE batch_id = ${sourceBatch.id}
    ORDER BY company_id, document_id
  `);
  if (corpusRows.rows.length === 0) throw new Error("source batch has no corpus snapshot (batch_corpus empty)");
  const sourceCorpusFingerprint = createHash("sha256")
    .update(corpusRows.rows.map((r: any) => `${r.company_id}:${r.document_id}`).join(","))
    .digest("hex");
  const corpusCompanies = new Set(corpusRows.rows.map((r: any) => r.company_id)).size;

  const sourceJobs = await storage.getJobsForBatch(sourceBatch.id);
  const sourceCompanyIds = sourceJobs.map((j: any) => j.companyId);
  const sourceRun = (sourceBatch as any).reliabilityRunId ? await storage.getReliabilityRunForBatch(sourceBatch.id) : null;
  const sourceRunKey = (sourceRun as any)?.runKey ?? `batch-${sourceBatch.id}`;
  const liveFingerprint = deploymentFingerprintFromEnvironment();

  console.error(`[replay] source fw=${(sourceBatch as any).frameworkId} list=${(sourceBatch as any).listId} ` +
    `corpusDocs=${corpusRows.rows.length} corpusCompanies=${corpusCompanies} jobs=${sourceCompanyIds.length} ` +
    `fingerprint=${sourceCorpusFingerprint.slice(0, 12)}`);

  if (!confirm) {
    console.error(`[replay] DRY-RUN — would create a score-only replay batch over ${sourceCompanyIds.length} companies. Re-run with --confirm.`);
    console.log(JSON.stringify({ ok: true, dryRun: true, sourceBatchId: sourceBatch.id, companies: sourceCompanyIds.length, corpusCompanies }));
    process.exit(0);
  }

  // Create a diagnostic reliability run (does NOT trip the interactive single-active guard).
  const reliability = await storage.createOrAdoptReliabilityRun({
    workspaceId,
    testCycleId,
    commitSha: process.env.SOURCE_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || "unknown",
    frameworkId: (sourceBatch as any).frameworkId,
    listId: (sourceBatch as any).listId ?? null,
    batteryLabel,
    deploymentFingerprint: liveFingerprint,
    diagnosticRun: true,
  });
  await storage.updateReliabilityRunLifecycle(reliability.run.id, "running", { lastHeartbeatAt: new Date(), lastProgressAt: new Date() });

  // Create the score-only replay batch with replay provenance.
  const batch = await storage.createBatchRun(
    workspaceId,
    (sourceBatch as any).frameworkId,
    sourceCompanyIds.length,
    (sourceBatch as any).listId ?? undefined,
    false, // offPeakOnly
    true,  // scoreOnly (replay is always score-only)
    { runId: reliability.run.id, runKey: reliability.run.runKey, testCycleId, batteryLabel, deploymentFingerprint: liveFingerprint },
    { sourceBatchId: sourceBatch.id, sourceRunKey, sourceCorpusFingerprint },
  );
  if (!batch) throw new Error("createBatchRun returned null");

  await storage.recordReliabilityAuditEvent({
    workspaceId, runId: reliability.run.id, batchId: (batch as any).id, eventType: "corpus_replay",
    reason: `stabilisation corpus replay from source batch ${sourceBatch.id}`,
    metadata: { sourceBatchId: sourceBatch.id, sourceCorpusFingerprint },
  });

  // Create jobs in the source company order, then enqueue ALL of them (single-shot).
  const companies: any[] = [];
  for (const cid of sourceCompanyIds) {
    const c = await storage.getCompanyById(cid, workspaceId);
    if (c) companies.push(c);
  }
  const jobsData = companies.map((c) => ({ workspaceId, batchId: (batch as any).id, companyId: c.id, companyName: c.name, frameworkId: (sourceBatch as any).frameworkId! }));
  await storage.createAnalysisJobs(jobsData);
  const allJobs = await storage.getJobsForBatch((batch as any).id);
  const queueJobs = allJobs
    .filter((j: any) => j.status === "pending")
    .map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: (batch as any).id, workspaceId, skipFetch: true, sourceBatchId: sourceBatch.id }));
  await addBatchJobs(queueJobs, workspaceId, (batch as any).id);

  console.log(JSON.stringify({
    ok: true,
    replayBatchId: (batch as any).id,
    sourceBatchId: sourceBatch.id,
    runKey: reliability.run.runKey,
    sourceCorpusFingerprint,
    queued: queueJobs.length,
    companies: sourceCompanyIds.length,
  }));
  process.exit(0);
})().catch((e) => { console.error("[replay] ERR", e?.message || e); process.exit(1); });

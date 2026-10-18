/**
 * Issue 3 / Phase 3 part-2 — supervised paid diagnostic enqueue.
 *
 * Enqueues the frozen 25-company roster (company_lists id=7) as a single FULL
 * run (scoreOnly=false) against the production DB + Redis, mirroring the plain
 * /api/analyze sequence. Instrumentation (STAGE_INSTRUMENTATION_POLICY=on) is
 * armed on the worker so timed-out jobs leave durable heartbeat/stage telemetry.
 *
 * Run (from repo root, with prod proxy URLs sourced):
 *   source /tmp/.prodenv
 *   DATABASE_URL=$PROD_DATABASE_URL REDIS_URL=$PROD_REDIS_URL \
 *     node --import tsx server/scripts/issue3-diag-enqueue.ts
 *
 * This writes NO pipeline code; it only enqueues. Reversible (cancel batch).
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 18;
const LIST_ID = 7;

async function main() {
  const startedAt = new Date();
  console.log(`[Issue3Diag] start=${startedAt.toISOString()} ws=${WORKSPACE_ID} fw=${FRAMEWORK_ID} list=${LIST_ID}`);

  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error(`Framework ${FRAMEWORK_ID} not found in workspace ${WORKSPACE_ID}`);
  console.log(`[Issue3Diag] framework="${framework.name}"`);

  const rows = await storage.getListCompanies(LIST_ID);
  const companies = rows.map((r: any) => r.company).filter(Boolean);
  if (companies.length === 0) throw new Error(`List ${LIST_ID} resolved 0 companies`);
  const ids = companies.map((c: any) => c.id).sort((a: number, b: number) => a - b);
  console.log(`[Issue3Diag] resolved ${companies.length} companies: ${ids.join(",")}`);

  // Normal per-company reset (same as /api/analyze full run). No document purge:
  // preserve 1276/1277 conditions for faithful reproduction.
  for (const c of companies) {
    await storage.updateCompany(c.id, WORKSPACE_ID, {
      analysisStatus: "idle", totalScore: null, summary: null,
      measuresMetCount: null, measuresTotalCount: null,
    });
  }
  console.log(`[Issue3Diag] per-company status reset complete (no document purge)`);

  // Fire-and-forget platform-source detection (non-fatal), mirrors /api/analyze.
  try { await storage.detectAndUpsertPlatformSources(3); } catch (e) { console.warn(`[Issue3Diag] detectAndUpsertPlatformSources warn: ${(e as any)?.message}`); }

  // Plain batch run: list_id=7, offPeakOnly=false, scoreOnly=false (FULL run).
  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length, LIST_ID, false, false);
  console.log(`[Issue3Diag] created batch ${batch.id} (list_id=${LIST_ID}, scoreOnly=false)`);

  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c: any) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID }))
  );
  console.log(`[Issue3Diag] created ${dbJobs.length} analysis_jobs rows`);

  await addBatchJobs(
    dbJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID, skipFetch: false })),
    WORKSPACE_ID,
    batch.id
  );

  console.log(`[Issue3Diag] ENQUEUED ${dbJobs.length} jobs for batch ${batch.id}`);
  console.log(`[Issue3Diag] BATCH_ID=${batch.id} ENQUEUE_UTC=${startedAt.toISOString()}`);
  await new Promise((r) => setTimeout(r, 2500));
  process.exit(0);
}

main().catch((e) => { console.error("[Issue3Diag] FAILED", e); process.exit(1); });

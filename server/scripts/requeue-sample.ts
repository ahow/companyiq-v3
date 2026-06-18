/**
 * One-off validation re-run.
 *
 * Enqueues a small, deliberately heavy sample of companies (CJK financial /
 * industrial + multilingual European) that previously hit the 540s pipeline
 * timeout, so we can confirm the new worker tuning (concurrency 5, pipeline cap
 * 20m, fetch budget 13m, MAX_CONCURRENT_BROWSER=1) lets them complete.
 *
 * Usage (inside Railway worker env):
 *   node --import tsx server/scripts/requeue-sample.ts
 *
 * Optional env overrides:
 *   SAMPLE_WORKSPACE_ID (default 3)
 *   SAMPLE_FRAMEWORK_ID (default 7)
 *   SAMPLE_COMPANY_IDS  (comma-separated; default the validation set below)
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";

const WORKSPACE_ID = parseInt(process.env.SAMPLE_WORKSPACE_ID || "3", 10);
const FRAMEWORK_ID = parseInt(process.env.SAMPLE_FRAMEWORK_ID || "7", 10);
const DEFAULT_IDS = [1925, 1515, 1910, 1835, 1895, 1900, 1785, 44];
const COMPANY_IDS = (process.env.SAMPLE_COMPANY_IDS
  ? process.env.SAMPLE_COMPANY_IDS.split(",").map((s) => parseInt(s.trim(), 10))
  : DEFAULT_IDS
).filter((n) => Number.isFinite(n));

async function main() {
  console.log(`[Requeue] workspace=${WORKSPACE_ID} framework=${FRAMEWORK_ID} ids=${COMPANY_IDS.join(",")}`);

  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error(`Framework ${FRAMEWORK_ID} not found in workspace ${WORKSPACE_ID}`);

  const companies: any[] = [];
  for (const id of COMPANY_IDS) {
    const c = await storage.getCompanyById(id, WORKSPACE_ID);
    if (!c) {
      console.warn(`[Requeue] company ${id} not found — skipping`);
      continue;
    }
    companies.push(c);
  }
  if (companies.length === 0) throw new Error("No companies resolved");

  // Reset each company's status so the re-run is clean (same as /api/analyze).
  for (const c of companies) {
    await storage.updateCompany(c.id, WORKSPACE_ID, { analysisStatus: "idle", totalScore: null, summary: null });
  }

  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length);
  console.log(`[Requeue] created batch ${batch.id} for ${companies.length} companies`);

  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID }))
  );

  await addBatchJobs(
    dbJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID })),
    WORKSPACE_ID,
    batch.id
  );

  console.log(`[Requeue] enqueued ${dbJobs.length} jobs for batch ${batch.id}. DONE`);
  // Give the queue a moment to flush, then exit.
  await new Promise((r) => setTimeout(r, 2000));
  process.exit(0);
}

main().catch((e) => { console.error("[Requeue] FAILED", e); process.exit(1); });

/**
 * One-off recovery re-run for ACWI May 26 (list 4, framework 7).
 *
 * Re-enqueues the 129 companies that never produced a usable result in batch 667:
 *   - 70 failed (pipeline timeout)
 *   - 56 idle  (orphaned by server restarts)
 *   -  3 completed-but-no-measures (461 Sony Financial, 1066 Empire, 1981 WSP)
 *
 * Runs through the SAME native pipeline the dashboard uses (createBatchRun ->
 * createAnalysisJobs -> addBatchJobs), so the worker processes them and the
 * review-gate / finalize path handles saving on completion.
 *
 * Usage (inside Railway worker env):
 *   RERUN_COMPANY_IDS="28,63,..." node --import tsx server/scripts/rerun-acwi-129.ts
 *
 * Env:
 *   RERUN_WORKSPACE_ID (default 3)
 *   RERUN_FRAMEWORK_ID (default 7)
 *   RERUN_COMPANY_IDS  (comma-separated; REQUIRED)
 *   RERUN_FULL_RESET   ("1" = purge prior docs + measure scores for clean re-discovery; default 1)
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";

const WORKSPACE_ID = parseInt(process.env.RERUN_WORKSPACE_ID || "3", 10);
const FRAMEWORK_ID = parseInt(process.env.RERUN_FRAMEWORK_ID || "7", 10);
const COMPANY_IDS = (process.env.RERUN_COMPANY_IDS || "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n));

async function main() {
  if (COMPANY_IDS.length === 0) throw new Error("RERUN_COMPANY_IDS is required");
  console.log(`[Rerun129] workspace=${WORKSPACE_ID} framework=${FRAMEWORK_ID} count=${COMPANY_IDS.length}`);

  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error(`Framework ${FRAMEWORK_ID} not found in workspace ${WORKSPACE_ID}`);

  const companies: any[] = [];
  for (const id of COMPANY_IDS) {
    const c = await storage.getCompanyById(id, WORKSPACE_ID);
    if (!c) { console.warn(`[Rerun129] company ${id} not found — skipping`); continue; }
    companies.push(c);
  }
  if (companies.length === 0) throw new Error("No companies resolved");
  console.log(`[Rerun129] resolved ${companies.length} companies`);

  const fullReset = (process.env.RERUN_FULL_RESET ?? "1") === "1";
  for (const c of companies) {
    if (fullReset) {
      await storage.clearMeasureScores(c.id);
      await storage.fullResetCompanyDocuments(c.id);
    }
    await storage.updateCompany(c.id, WORKSPACE_ID, {
      analysisStatus: "idle", totalScore: null, summary: null,
      measuresMetCount: null, measuresTotalCount: null,
      ...(fullReset ? { discoveryDiagnostics: null as any } : {}),
    });
  }
  console.log(`[Rerun129] reset complete (fullReset=${fullReset})`);

  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length, 4);
  console.log(`[Rerun129] created batch ${batch.id} for ${companies.length} companies`);

  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID }))
  );

  await addBatchJobs(
    dbJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID })),
    WORKSPACE_ID,
    batch.id
  );

  console.log(`[Rerun129] enqueued ${dbJobs.length} jobs for batch ${batch.id}. DONE`);
  await new Promise((r) => setTimeout(r, 2500));
  process.exit(0);
}

main().catch((e) => { console.error("[Rerun129] FAILED", e); process.exit(1); });

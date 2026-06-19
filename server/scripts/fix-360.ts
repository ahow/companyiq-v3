/**
 * One-off: clear any stale BullMQ jobs for 360 (company 1914), reset its row,
 * and re-enqueue a single fresh job in a new batch (avoids jobId dedup collisions
 * from prior interrupted batches like batch-94/95/96 sharing company-1914 keys).
 *
 * Usage (from sandbox via public proxies):
 *   DATABASE_URL=... REDIS_URL=... node --import tsx server/scripts/fix-360.ts
 */
import * as storage from "../storage.js";
import { getQueue } from "../queue.js";

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 7;
const COMPANY_ID = 1914;

async function main() {
  const q = getQueue();

  // 1) Remove any jobs (any state) whose id targets company 1914.
  const states = ["waiting", "active", "delayed", "prioritized", "failed", "completed", "paused"] as const;
  let removed = 0;
  for (const st of states) {
    const jobs = await q.getJobs([st as any], 0, 1000);
    for (const j of jobs) {
      const cid = j?.data?.companyId;
      const idStr = String(j?.id || "");
      if (cid === COMPANY_ID || idStr.includes("company-1914")) {
        try { await j.remove(); removed++; } catch { /* may be locked/active */ }
      }
    }
  }
  console.log(`[Fix360] removed ${removed} stale jobs for company ${COMPANY_ID}`);

  // 2) Reset the company row to idle (keep its already-fetched docs incl. cninfo PDFs).
  await storage.clearMeasureScores(COMPANY_ID);
  await storage.updateCompany(COMPANY_ID, WORKSPACE_ID, {
    analysisStatus: "idle", totalScore: null, summary: null,
    measuresMetCount: null, measuresTotalCount: null,
  });
  console.log(`[Fix360] reset company ${COMPANY_ID} to idle (docs preserved)`);

  // 3) Fresh batch + single job with a unique jobId (timestamp-suffixed).
  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, 1);
  const company = await storage.getCompanyById(COMPANY_ID, WORKSPACE_ID);
  if (!company) throw new Error("company 1914 not found");
  const dbJobs = await storage.createAnalysisJobs([
    { workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: COMPANY_ID, companyName: company.name, frameworkId: FRAMEWORK_ID },
  ]);
  const j = dbJobs[0] as any;
  await q.add(
    `fix360-${batch.id}-${COMPANY_ID}`,
    { jobId: j.id, companyId: COMPANY_ID, frameworkId: FRAMEWORK_ID, batchId: batch.id, workspaceId: WORKSPACE_ID },
    { priority: 1, jobId: `fix360-${batch.id}-company-${COMPANY_ID}-${Date.now()}` }
  );
  console.log(`[Fix360] enqueued fresh job for company ${COMPANY_ID} in batch ${batch.id}`);

  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}

main().catch((e) => { console.error("[Fix360] FAILED", e); process.exit(1); });

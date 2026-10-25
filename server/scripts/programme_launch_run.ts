/**
 * programme_launch_run.ts — launch a fresh full batch run for the change programme.
 * Mirrors the /api/analyze route body (plain run, no reliability), bypassing the
 * HTTP session + SINGLE_ACTIVE_BATCH + pending-review guards via direct storage/queue.
 *
 * SAFETY: dry-run by default. Pass --confirm to actually create the batch + enqueue
 * (a paid production run). Prints the DB host first (deployment-target verification).
 *
 * Usage:
 *   DATABASE_URL=$(cat /home/ubuntu/.prod_db_url) REDIS_URL=$(cat /home/ubuntu/.prod_redis_url) \
 *     node --import tsx server/scripts/programme_launch_run.ts --ws 3 --fw 18 --list 9 [--confirm]
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

(async () => {
  const workspaceId = parseInt(arg("ws", "3")!, 10);
  const frameworkId = parseInt(arg("fw", "18")!, 10);
  const listId = parseInt(arg("list", "9")!, 10);
  const confirm = process.argv.includes("--confirm");

  const dbUrl = process.env.DATABASE_URL || "";
  const host = dbUrl.replace(/^.*@/, "").replace(/\/.*$/, "");
  console.log(`[launch] DB host: ${host}`);
  console.log(`[launch] REDIS set: ${process.env.REDIS_URL ? "yes" : "NO"}`);
  console.log(`[launch] ws=${workspaceId} fw=${frameworkId} list=${listId} confirm=${confirm}`);

  const framework = await storage.getFrameworkById(frameworkId, workspaceId);
  if (!framework) throw new Error(`framework ${frameworkId} not found in ws ${workspaceId}`);
  const listCompanies = await storage.getListCompanies(listId);
  const companies = listCompanies.map((c: any) => c.company).filter(Boolean);
  console.log(`[launch] framework="${(framework as any).name}" companies=${companies.length}`);

  if (!confirm) {
    console.log(`[launch] DRY-RUN — would create batch for ${companies.length} companies. Re-run with --confirm to enqueue.`);
    process.exit(0);
  }

  // reset companies to idle (mirror route)
  for (const c of companies) {
    await storage.updateCompany(c.id, workspaceId, { analysisStatus: "idle", totalScore: null, summary: null });
  }
  const batch = await storage.createBatchRun(workspaceId, frameworkId, companies.length, listId, false, false);
  const jobsData = companies.map((c: any) => ({ workspaceId, batchId: (batch as any).id, companyId: c.id, companyName: c.name, frameworkId }));
  await storage.createAnalysisJobs(jobsData);
  const allJobs = await storage.getJobsForBatch((batch as any).id);
  const queueJobs = allJobs
    .filter((j: any) => j.status === "pending")
    .map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: (batch as any).id, workspaceId, skipFetch: false }));
  await addBatchJobs(queueJobs, workspaceId, (batch as any).id);
  console.log(`[launch] CREATED batch ${(batch as any).id} with ${queueJobs.length} jobs enqueued.`);
  process.exit(0);
})().catch((e) => { console.error("[launch] ERR", e?.message || e); process.exit(1); });

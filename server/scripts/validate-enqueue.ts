/**
 * Validation enqueue + queue introspection harness.
 *
 * Unlike requeue-sample.ts (fair-share priority), this enqueues the given
 * companies at the HIGHEST priority (1) so they jump ahead of an existing
 * backlog for time-sensitive validation (determinism + mega-cap checks).
 *
 * Usage (inside Railway worker network, via `railway ssh`):
 *   VAL_COMPANY_IDS=553 VAL_FULL_RESET=1 node --import tsx server/scripts/validate-enqueue.ts
 *
 * Env:
 *   VAL_WORKSPACE_ID (default 3)
 *   VAL_FRAMEWORK_ID (default 7)
 *   VAL_COMPANY_IDS  (comma-separated, required)
 *   VAL_FULL_RESET   ("1" = purge prior docs + scores for a clean re-discovery)
 *   VAL_STATS_ONLY   ("1" = just print queue stats and exit, no enqueue)
 */
import * as storage from "../storage.js";
import { getQueue } from "../queue.js";

const WORKSPACE_ID = parseInt(process.env.VAL_WORKSPACE_ID || "3", 10);
const FRAMEWORK_ID = parseInt(process.env.VAL_FRAMEWORK_ID || "7", 10);
const IDS = (process.env.VAL_COMPANY_IDS || "").split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
const FULL_RESET = process.env.VAL_FULL_RESET === "1";
const STATS_ONLY = process.env.VAL_STATS_ONLY === "1";

async function printStats(label: string) {
  const q = getQueue();
  const counts = await q.getJobCounts("waiting", "active", "prioritized", "delayed", "completed", "failed", "paused");
  console.log(`[Stats:${label}]`, JSON.stringify(counts));
}

async function main() {
  await printStats("before");
  if (STATS_ONLY) { await new Promise((r) => setTimeout(r, 500)); process.exit(0); }
  if (IDS.length === 0) throw new Error("VAL_COMPANY_IDS required");

  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error(`Framework ${FRAMEWORK_ID} not found`);

  const companies: any[] = [];
  for (const id of IDS) {
    const c = await storage.getCompanyById(id, WORKSPACE_ID);
    if (!c) { console.warn(`[Validate] company ${id} not found — skipping`); continue; }
    companies.push(c);
  }
  if (companies.length === 0) throw new Error("No companies resolved");

  for (const c of companies) {
    if (FULL_RESET) {
      await storage.clearMeasureScores(c.id);
      await storage.fullResetCompanyDocuments(c.id);
    }
    await storage.updateCompany(c.id, WORKSPACE_ID, {
      analysisStatus: "idle", totalScore: null, summary: null,
      measuresMetCount: null, measuresTotalCount: null,
      ...(FULL_RESET ? { discoveryDiagnostics: null as any } : {}),
    });
  }
  console.log(`[Validate] reset complete (fullReset=${FULL_RESET}) for ${companies.map((c) => c.id).join(",")}`);

  // v3e job-ID guard: purge any lingering queue jobs for these company IDs across
  // all states BEFORE enqueuing, so a stale prior-batch job can never collide with
  // (or block) the fresh job and leave a company stuck in "analyzing".
  {
    const q0 = getQueue();
    const idset = new Set(companies.map((c) => c.id));
    const stale = await q0.getJobs(["waiting", "active", "prioritized", "delayed", "failed", "paused"]);
    let removed = 0;
    for (const job of stale) {
      const cid = (job?.data as any)?.companyId;
      if (idset.has(cid)) {
        try { await job.remove(); removed++; } catch { /* active jobs may refuse; best-effort */ }
      }
    }
    if (removed > 0) console.log(`[Validate] purged ${removed} lingering queue job(s) for target companies`);
  }

  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length);
  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID }))
  );

  // Enqueue at TOP priority (1 = highest meaningful priority in BullMQ; 0/none is
  // treated as lowest among prioritized). This makes validation jobs jump the
  // existing backlog without disturbing or removing any backlog jobs.
  const q = getQueue();
  const bulk = dbJobs.map((j: any) => ({
    name: `validate-${batch.id}-${j.companyId}`,
    data: { jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID },
    opts: { priority: 1, jobId: `batch-${batch.id}-company-${j.companyId}` },
  }));
  await q.addBulk(bulk);

  console.log(`[Validate] enqueued ${dbJobs.length} jobs at priority=1 for batch ${batch.id} (companies ${companies.map((c) => c.id).join(",")})`);
  await printStats("after");
  await new Promise((r) => setTimeout(r, 1500));
  process.exit(0);
}

main().catch((e) => { console.error("[Validate] FAILED", e); process.exit(1); });

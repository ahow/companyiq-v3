/**
 * Targeted completeness re-run selector.
 *
 * Selects the companies that need re-running after a batch because their
 * document discovery/fetch was incomplete (and therefore their scores are
 * under-stated — the "3M 1/37" case), OR because their latest analysis job
 * failed. Qualification is delegated to `selectCompletenessDeficitCompanies`
 * in server/lib/completeness-marker.ts, which uses BOTH live discovery
 * diagnostics AND the persisted `completenessFlag` written by the permanent
 * batch-completion marker (server/worker.ts -> markBatchCompleteness).
 *
 * A company qualifies if ANY of:
 *   - its latest job failed                         (failed_job)
 *   - fetchCoverage.budgetExceeded = true           (budget_exceeded)
 *   - fetchCoverage.fetchRatio < FETCH_RATIO_THRESHOLD (default 0.7)  (low_fetch_ratio)
 *   - fetchCoverage.deadPrimaryFiling = true         (dead_primary_filing)
 *   - coverage.coverageLevel in low/minimal/suspect  (coverage_*)
 *   - it has zero first_party documents              (zero_first_party_docs)
 *   - it carries a persisted completenessFlag.needsRerun (persisted_flag)
 *
 * SAFETY: defaults to DRY-RUN. It prints the DB host (deploy-target check) and
 * the selection (company ids + per-signal counts + total) and EXITS without
 * touching anything. It only resets company status and enqueues a batch when
 * run with --confirm.
 *
 * Usage (inside the worker env, AFTER deploying this branch):
 *   # dry run — just show what would be re-run:
 *   node --import tsx server/scripts/requeue-completeness.ts
 *   # staged re-run of the first 50 selected (standard reset: re-analyze):
 *   node --import tsx server/scripts/requeue-completeness.ts --confirm --limit 50
 *   # full reset (purge all prior docs so everything is re-discovered/fetched):
 *   node --import tsx server/scripts/requeue-completeness.ts --confirm --full-reset
 *
 * Env / CLI overrides:
 *   REQUEUE_WORKSPACE_ID   (default 3)
 *   REQUEUE_FRAMEWORK_ID   (default 21)
 *   FETCH_RATIO_THRESHOLD  (default 0.7)
 *   REQUEUE_COMPANY_IDS    (comma-separated; restrict the candidate pool)
 *   --limit N              (cap the number of companies re-run; staged rollout)
 *   --confirm              (actually reset + create batch + enqueue)
 *   --full-reset           (clearMeasureScores + fullResetCompanyDocuments)
 */
import * as storage from "../storage.js";
import { addBatchJobs } from "../queue.js";
import { selectCompletenessDeficitCompanies } from "../lib/completeness-marker.js";

const WORKSPACE_ID = parseInt(process.env.REQUEUE_WORKSPACE_ID || "3", 10);
const FRAMEWORK_ID = parseInt(process.env.REQUEUE_FRAMEWORK_ID || "21", 10);

const argv = process.argv.slice(2);
const CONFIRM = argv.includes("--confirm");
const FULL_RESET = argv.includes("--full-reset");
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=") : undefined;
}
const LIMIT_RAW = argValue("--limit");
const LIMIT = LIMIT_RAW ? parseInt(LIMIT_RAW, 10) : undefined;

const CANDIDATE_IDS = process.env.REQUEUE_COMPANY_IDS
  ? process.env.REQUEUE_COMPANY_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n))
  : undefined;

function dbHost(): string {
  try {
    const url = process.env.DATABASE_URL || "";
    if (!url) return "(DATABASE_URL unset)";
    return new URL(url).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main() {
  // 1. Deploy-target verification: always show which DB we are pointed at.
  console.log(`[Requeue-Completeness] DB host: ${dbHost()}`);
  console.log(
    `[Requeue-Completeness] workspace=${WORKSPACE_ID} framework=${FRAMEWORK_ID} ` +
      `fetchRatioThreshold=${process.env.FETCH_RATIO_THRESHOLD || "0.7"} ` +
      `limit=${LIMIT ?? "none"} confirm=${CONFIRM} fullReset=${FULL_RESET}` +
      (CANDIDATE_IDS ? ` candidatePool=${CANDIDATE_IDS.length}` : ""),
  );

  const framework = await storage.getFrameworkById(FRAMEWORK_ID, WORKSPACE_ID);
  if (!framework) throw new Error(`Framework ${FRAMEWORK_ID} not found in workspace ${WORKSPACE_ID}`);

  // 2. Select the deficit companies (read-only).
  const selection = await selectCompletenessDeficitCompanies({
    workspaceId: WORKSPACE_ID,
    frameworkId: FRAMEWORK_ID,
    thresholds: { fetchRatioThreshold: parseFloat(process.env.FETCH_RATIO_THRESHOLD || "0.7") },
    companyIds: CANDIDATE_IDS,
    limit: LIMIT,
  });

  console.log(`[Requeue-Completeness] total qualifying: ${selection.total}` +
    (LIMIT ? ` (re-running first ${selection.selected.length} after --limit)` : ""));
  console.log(`[Requeue-Completeness] per-signal counts (over all qualifying):`);
  for (const [signal, count] of Object.entries(selection.signalCounts)) {
    if (count > 0) console.log(`    ${signal.padEnd(22)} ${count}`);
  }

  const failedCount = selection.selected.filter((s) => s.category === "failed").length;
  const incompleteCount = selection.selected.filter((s) => s.category === "incomplete").length;
  console.log(`[Requeue-Completeness] selected ${selection.selected.length} ` +
    `(failed=${failedCount}, incomplete=${incompleteCount}):`);
  for (const s of selection.selected) {
    console.log(`    #${s.companyId} ${s.companyName}  [${s.category}] ${s.reasons.join(",")}` +
      (s.flagged ? " (persisted-flag)" : ""));
  }

  const companyIds = selection.selected.map((s) => s.companyId);
  if (companyIds.length === 0) {
    console.log("[Requeue-Completeness] nothing to re-run. DONE");
    process.exit(0);
  }

  // 3. DRY RUN by default: stop here unless --confirm.
  if (!CONFIRM) {
    console.log("[Requeue-Completeness] DRY RUN — no changes made. Re-run with --confirm to reset + enqueue.");
    process.exit(0);
  }

  // 4. Resolve the company rows (needed for names) and reset their status.
  //    Standard reset mirrors /api/analyze (status->idle, scores cleared). With
  //    --full-reset we also purge ALL prior documents so every document is
  //    re-discovered and re-fetched from scratch under the fixed fetch engine.
  const companies: any[] = [];
  for (const id of companyIds) {
    const c = await storage.getCompanyById(id, WORKSPACE_ID);
    if (!c) { console.warn(`[Requeue-Completeness] company ${id} not found — skipping`); continue; }
    companies.push(c);
  }
  if (companies.length === 0) throw new Error("No companies resolved for re-run");

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
  console.log(`[Requeue-Completeness] reset ${companies.length} companies (fullReset=${FULL_RESET})`);

  // 5. Create a batch and enqueue — bypasses SINGLE_ACTIVE_BATCH / pending-review
  //    guards by going straight through storage + queue, like requeue-sample.ts.
  const batch = await storage.createBatchRun(WORKSPACE_ID, FRAMEWORK_ID, companies.length);
  console.log(`[Requeue-Completeness] created batch ${batch.id} for ${companies.length} companies`);

  const dbJobs = await storage.createAnalysisJobs(
    companies.map((c) => ({ workspaceId: WORKSPACE_ID, batchId: batch.id, companyId: c.id, companyName: c.name, frameworkId: FRAMEWORK_ID })),
  );

  await addBatchJobs(
    dbJobs.map((j: any) => ({ jobId: j.id, companyId: j.companyId, frameworkId: j.frameworkId, batchId: batch.id, workspaceId: WORKSPACE_ID })),
    WORKSPACE_ID,
    batch.id,
  );

  console.log(`[Requeue-Completeness] enqueued ${dbJobs.length} jobs for batch ${batch.id}. DONE`);
  await new Promise((r) => setTimeout(r, 2000));
  process.exit(0);
}

main().catch((e) => { console.error("[Requeue-Completeness] FAILED", e); process.exit(1); });

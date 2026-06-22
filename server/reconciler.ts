/**
 * Stall Reconciler for CompanyIQ v3
 *
 * A periodic watchdog that prevents companies from silently stalling as
 * "incomplete" due to DB<->queue desync (worker restarts, lost status writes,
 * lock/timeout mismatches). It runs INSIDE the worker service (the only process
 * that consumes the queue) on a fixed interval.
 *
 * Behaviour (agreed with the product owner):
 *   - AUTO-RECOVER mechanical stalls (safe, idempotent):
 *       * A job stuck in `claimed` for longer than STUCK_THRESHOLD with NO live
 *         BullMQ job, OR a company stuck in `fetching`/`analyzing` with no live
 *         job, is reconciled:
 *           - If the company ALREADY has full results (measure_scores present)
 *             => this is a lost status-write. Mark job+company `completed`.
 *           - Else => genuinely incomplete. Re-enqueue via enqueueReexamination
 *             (fresh single-job batch, skipFetch=false), bounded to RECONCILE_MAX
 *             attempts tracked in discoveryDiagnostics.reconcile.count. When the
 *             budget is exhausted, mark the company `failed` and FLAG it for QA.
 *   - AUTO-RE-EXAMINE quality zeros (bounded), then FLAG residuals:
 *       * A company that COMPLETED cleanly but scored 0 with degraded evidence
 *         (lowEvidence + thin corpus < AUTO_REEXAM_MAX_CHARS) is a fetch-coverage
 *         artifact, not a legitimate zero. It is auto-re-examined up to
 *         AUTO_REEXAM_MAX times, REUSING the same discoveryDiagnostics.autoReexam
 *         .count the in-pipeline gate uses (one shared budget, so retries from
 *         either mechanism can never stack past the bound). Once the budget is
 *         exhausted the company is QA-flagged (qaFlag) and left as-is, surfacing
 *         in the QA worklist without ever looping. Legitimate large/clean zeros
 *         are never touched.
 *   - Reconcile batch_runs counters and close batches whose jobs are all terminal.
 *
 * All thresholds are env-overridable. The reconciler is strictly additive and
 * never deletes `ok` documents or alters analysis methodology.
 */

import { db } from "./db.js";
import { sql } from "drizzle-orm";
import * as storage from "./storage.js";
import { getQueue } from "./queue.js";

// ─── Tunables ────────────────────────────────────────────────────────────────
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || "300000", 10); // 5 min
// A job/company must be inactive for at least this long before it's considered
// orphaned. MUST exceed the worst-case pipeline runtime (≈35 min) to avoid
// reconciling a job that is simply slow-but-alive.
const STUCK_THRESHOLD_MIN = parseInt(process.env.RECONCILE_STUCK_MIN || "40", 10);
const RECONCILE_MAX = parseInt(process.env.RECONCILE_MAX || "3", 10);
// Quality-zero thresholds (mirror the in-pipeline auto-reexam gate exactly so
// the reconciler and the pipeline share ONE budget and ONE definition).
const QA_THIN_CHARS = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);
// Shared retry budget with the in-pipeline gate (pipeline.ts AUTO_REEXAM_MAX).
// The reconciler reuses discoveryDiagnostics.autoReexam.count so retries from
// either mechanism count toward the SAME bound and can never stack past it.
const AUTO_REEXAM_MAX = parseInt(process.env.AUTO_REEXAM_MAX || "3", 10);

let running = false;
let timer: NodeJS.Timeout | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Set of companyIds that currently have a live (waiting/active/delayed/prioritized) BullMQ job. */
async function liveQueueCompanyIds(): Promise<Set<number>> {
  const ids = new Set<number>();
  try {
    const q = getQueue();
    const jobs = await q.getJobs(["waiting", "active", "delayed", "prioritized", "paused"]);
    for (const j of jobs) {
      const cid = j?.data?.companyId;
      if (typeof cid === "number") ids.add(cid);
    }
  } catch (e: any) {
    console.warn(`[Reconciler] Could not read queue (treating as empty): ${e?.message}`);
  }
  return ids;
}

/** Does the company already have analysis results for this framework? */
async function hasMeasureScores(companyId: number, frameworkId: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM measure_scores WHERE company_id = ${companyId} AND framework_id = ${frameworkId} LIMIT 1
  `);
  return r.rows.length > 0;
}

function getDiag(company: any): any {
  const d = company?.discoveryDiagnostics;
  return d && typeof d === "object" ? { ...d } : {};
}

/** Mark a company completed (lost status-write recovery) and resolve its job rows. */
async function syncCompleted(companyId: number, jobId: number | null): Promise<void> {
  await db.execute(sql`
    UPDATE companies SET analysis_status = 'completed', updated_at = NOW()
    WHERE id = ${companyId} AND analysis_status <> 'completed'
  `);
  if (jobId != null) {
    await db.execute(sql`
      UPDATE analysis_jobs SET status = 'completed', completed_at = NOW()
      WHERE id = ${jobId} AND status NOT IN ('completed','failed')
    `);
  }
}

/** Record a QA flag in discoveryDiagnostics without changing scores/status. */
async function flagForQa(company: any, reason: string): Promise<void> {
  const diag = getDiag(company);
  diag.qaFlag = { flagged: true, reason, flaggedAt: new Date().toISOString() };
  await storage.updateCompany(company.id, company.workspaceId, { discoveryDiagnostics: diag } as any);
}

// ─── Core reconcile pass ─────────────────────────────────────────────────────

export async function reconcileOnce(): Promise<{
  syncedCompleted: number;
  recovered: number;
  exhaustedFailed: number;
  qaFlagged: number;
  batchesClosed: number;
}> {
  const stats = { syncedCompleted: 0, recovered: 0, exhaustedFailed: 0, qaFlagged: 0, batchesClosed: 0 };
  const live = await liveQueueCompanyIds();

  // ── 1) Orphaned jobs / companies: claimed jobs idle beyond threshold, OR
  //       companies stuck in fetching/analyzing beyond threshold, with NO live job.
  const orphans = await db.execute(sql`
    SELECT DISTINCT c.id AS company_id, c.workspace_id, c.name,
           j.id AS job_id, j.framework_id, j.batch_id
    FROM companies c
    JOIN analysis_jobs j ON j.company_id = c.id
    WHERE (
            (j.status = 'claimed' AND j.claimed_at < NOW() - INTERVAL '${sql.raw(String(STUCK_THRESHOLD_MIN))} minutes')
            OR
            (c.analysis_status IN ('fetching','analyzing') AND c.updated_at < NOW() - INTERVAL '${sql.raw(String(STUCK_THRESHOLD_MIN))} minutes')
          )
      AND j.id = (SELECT MAX(id) FROM analysis_jobs j2 WHERE j2.company_id = c.id)
  `);

  for (const row of orphans.rows as any[]) {
    const companyId = Number(row.company_id);
    const frameworkId = Number(row.framework_id);
    const jobId = row.job_id != null ? Number(row.job_id) : null;

    // Skip anything still genuinely in-flight on the queue.
    if (live.has(companyId)) continue;

    const company = await storage.getCompanyById(companyId, Number(row.workspace_id));
    if (!company) continue;

    // Lost status-write case: results already exist => just sync to completed.
    if (await hasMeasureScores(companyId, frameworkId)) {
      await syncCompleted(companyId, jobId);
      stats.syncedCompleted++;
      console.log(`[Reconciler] Synced company ${companyId} (${row.name}) to completed (results already present)`);
      continue;
    }

    // Genuinely incomplete => bounded auto-recovery.
    const diag = getDiag(company);
    const rec = diag.reconcile || { count: 0 };
    if ((rec.count || 0) >= RECONCILE_MAX) {
      // Budget exhausted: mark failed + flag for QA. Never loops.
      if (jobId != null) {
        await db.execute(sql`UPDATE analysis_jobs SET status='failed', last_error='reconcile budget exhausted', completed_at=NOW() WHERE id=${jobId} AND status NOT IN ('completed','failed')`);
      }
      await db.execute(sql`UPDATE companies SET analysis_status='failed', updated_at=NOW() WHERE id=${companyId}`);
      await flagForQa(company, `auto-recovery exhausted after ${rec.count} attempts (no results produced)`);
      stats.exhaustedFailed++;
      stats.qaFlagged++;
      console.log(`[Reconciler] Company ${companyId} (${row.name}) FAILED + QA-flagged: reconcile budget exhausted`);
      continue;
    }

    // Resolve the stale job row first so it can't be double-counted, then re-enqueue.
    if (jobId != null) {
      await db.execute(sql`UPDATE analysis_jobs SET status='failed', last_error='superseded by reconciler recovery', completed_at=NOW() WHERE id=${jobId} AND status NOT IN ('completed','failed')`);
    }
    // Persist the incremented reconcile counter BEFORE enqueue (enqueueReexamination
    // resets analysis_status to idle but preserves discoveryDiagnostics).
    diag.reconcile = {
      count: (rec.count || 0) + 1,
      lastAt: new Date().toISOString(),
      reason: "mechanical stall: orphaned job / lost worker",
    };
    await storage.updateCompany(companyId, company.workspaceId, { discoveryDiagnostics: diag } as any);

    const enq = await storage.enqueueReexamination({
      companyId,
      companyName: company.name,
      frameworkId,
      workspaceId: company.workspaceId,
    });
    if (enq) {
      stats.recovered++;
      console.log(`[Reconciler] Auto-recovered company ${companyId} (${row.name}) -> batch ${enq.batchId} (attempt ${diag.reconcile.count}/${RECONCILE_MAX})`);
    }
  }

  // ── 2) Quality-zeros: AUTO-RE-EXAMINE (bounded), then QA-FLAG residuals.
  //      A company that COMPLETED but scored 0 with degraded evidence
  //      (lowEvidence + thin corpus) is a fetch-coverage artifact, not a
  //      legitimate zero. We auto-re-examine it up to AUTO_REEXAM_MAX times,
  //      reusing the SAME discoveryDiagnostics.autoReexam.count the in-pipeline
  //      gate uses (so the two mechanisms share one budget). Once the budget is
  //      exhausted we QA-flag it (and stop), so it surfaces in the worklist
  //      without ever looping. Legitimate large/clean zeros are never touched.
  // NOTE: framework_id lives on analysis_jobs, not companies. Derive it from the
  // company's most recent job so we can re-enqueue against the right framework.
  const zeros = await db.execute(sql`
    SELECT c.id, c.workspace_id, c.name, c.discovery_diagnostics,
           (SELECT j.framework_id FROM analysis_jobs j
              WHERE j.company_id = c.id
              ORDER BY j.id DESC LIMIT 1) AS framework_id
    FROM companies c
    WHERE c.analysis_status = 'completed'
      AND COALESCE(c.total_score, 0) <= 0
  `);
  for (const row of zeros.rows as any[]) {
    const companyId = Number(row.id);
    if (live.has(companyId)) continue; // a re-exam is already in flight
    const diag = (row.discovery_diagnostics && typeof row.discovery_diagnostics === "object") ? { ...row.discovery_diagnostics } : {};
    if (diag?.qaFlag?.flagged) continue; // already exhausted + flagged
    const fc = diag?.fetchCoverage;
    const lowEvidence = fc?.lowEvidence === true;
    if (!lowEvidence) continue; // genuine zero (large/clean corpus) — leave alone
    let corpusChars = 0;
    try { corpusChars = await storage.getCorpusCharCount(companyId); } catch { /* ignore */ }
    if (corpusChars >= QA_THIN_CHARS) continue; // large corpus => legitimate zero

    const company = await storage.getCompanyById(companyId, Number(row.workspace_id));
    if (!company) continue;

    const reexam = diag.autoReexam || { count: 0 };
    if (row.framework_id == null) {
      // No job history => cannot determine framework; flag for QA rather than guess.
      await flagForQa(company, `quality zero with no analysis_job history (cannot determine framework)`);
      stats.qaFlagged++;
      console.log(`[Reconciler] QA-flagged company ${companyId} (${row.name}): quality zero, no job history`);
      continue;
    }
    const frameworkId = Number(row.framework_id);

    // Budget exhausted => QA-flag and stop retrying.
    if ((reexam.count || 0) >= AUTO_REEXAM_MAX) {
      await flagForQa(company, `quality zero unresolved after ${reexam.count} re-exam attempt(s): lowEvidence + thin corpus (${corpusChars} chars)`);
      stats.qaFlagged++;
      console.log(`[Reconciler] QA-flagged company ${companyId} (${row.name}): quality zero unresolved after ${reexam.count} attempts (${corpusChars} chars)`);
      continue;
    }

    // Budget remaining => auto-re-examine. Record the incremented shared counter
    // BEFORE enqueue (enqueueReexamination preserves discoveryDiagnostics).
    const nextCount = (reexam.count || 0) + 1;
    diag.autoReexam = {
      count: nextCount,
      lastTriggeredAt: new Date().toISOString(),
      reason: `reconciler quality-zero: lowEvidence + thin corpus (${corpusChars} chars), `
        + `dead ${fc?.documentsDead ?? "?"}/${fc?.documentsDiscovered ?? "?"}`,
    };
    await storage.updateCompany(companyId, company.workspaceId, { discoveryDiagnostics: diag } as any);

    const enq = await storage.enqueueReexamination({
      companyId,
      companyName: company.name,
      frameworkId,
      workspaceId: company.workspaceId,
    });
    if (enq) {
      stats.recovered++;
      console.log(`[Reconciler] Auto-re-examined quality-zero company ${companyId} (${row.name}) -> batch ${enq.batchId} (attempt ${nextCount}/${AUTO_REEXAM_MAX}, ${corpusChars} chars)`);
    }
  }

  // ── 3) Close batches whose jobs are all terminal but status is still 'running'.
  const openBatches = await db.execute(sql`
    SELECT b.id,
           COUNT(*) FILTER (WHERE j.status='completed') AS comp,
           COUNT(*) FILTER (WHERE j.status='failed') AS fail,
           COUNT(*) AS tot,
           COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) AS open_jobs
    FROM batch_runs b
    JOIN analysis_jobs j ON j.batch_id = b.id
    WHERE b.status = 'running'
    GROUP BY b.id
    HAVING COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) = 0
  `);
  for (const row of openBatches.rows as any[]) {
    await db.execute(sql`
      UPDATE batch_runs SET completed_jobs=${Number(row.comp)}, failed_jobs=${Number(row.fail)},
        status='completed', completed_at=NOW() WHERE id=${Number(row.id)}
    `);
    stats.batchesClosed++;
    console.log(`[Reconciler] Closed batch ${row.id}: ${row.comp} completed, ${row.fail} failed`);
  }

  return stats;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function startReconciler(): void {
  if (timer) return;
  console.log(`[Reconciler] Starting (interval=${RECONCILE_INTERVAL_MS}ms, stuckThreshold=${STUCK_THRESHOLD_MIN}min, maxAttempts=${RECONCILE_MAX})`);
  const tick = async () => {
    if (running) return; // never overlap passes
    running = true;
    try {
      const s = await reconcileOnce();
      const total = s.syncedCompleted + s.recovered + s.exhaustedFailed + s.qaFlagged + s.batchesClosed;
      if (total > 0) {
        console.log(`[Reconciler] pass done: synced=${s.syncedCompleted} recovered=${s.recovered} exhausted=${s.exhaustedFailed} qaFlagged=${s.qaFlagged} batchesClosed=${s.batchesClosed}`);
      }
    } catch (e: any) {
      console.error(`[Reconciler] pass error (non-fatal): ${e?.message}`);
    } finally {
      running = false;
    }
  };
  // First pass after a short delay so the worker finishes booting.
  timer = setInterval(() => { void tick(); }, RECONCILE_INTERVAL_MS);
  setTimeout(() => { void tick(); }, 30_000);
}

export function stopReconciler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

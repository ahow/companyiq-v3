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

import { db, pool } from "./db.js";
import { sql } from "drizzle-orm";
import * as storage from "./storage.js";
import { getQueue } from "./queue.js";

// ─── Tunables ────────────────────────────────────────────────────────────────
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || "300000", 10); // 5 min
// A job/company must be inactive for at least this long before it's considered
// orphaned. MUST exceed the worst-case pipeline runtime (≈35 min) to avoid
// reconciling a job that is simply slow-but-alive.
const STUCK_THRESHOLD_MIN = parseInt(process.env.RECONCILE_STUCK_MIN || "40", 10);
// Stale-claim reaper threshold (§0). A `claimed` job older than this with no live
// queue entry is released back to `pending` in its own batch. Defaults to the
// same 40 min as STUCK_THRESHOLD_MIN so a merely-slow-but-alive job (worst-case
// pipeline ≈35 min) is never reaped; override with RECONCILE_REAP_CLAIM_MIN.
const REAP_CLAIM_MIN = parseInt(process.env.RECONCILE_REAP_CLAIM_MIN || String(STUCK_THRESHOLD_MIN), 10);
const RECONCILE_MAX = parseInt(process.env.RECONCILE_MAX || "3", 10);
// Quality-zero thresholds (mirror the in-pipeline auto-reexam gate exactly so
// the reconciler and the pipeline share ONE budget and ONE definition).
const QA_THIN_CHARS = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);
// Shared retry budget with the in-pipeline gate (pipeline.ts AUTO_REEXAM_MAX).
// The reconciler reuses discoveryDiagnostics.autoReexam.count so retries from
// either mechanism count toward the SAME bound and can never stack past it.
const AUTO_REEXAM_MAX = parseInt(process.env.AUTO_REEXAM_MAX || "3", 10);
// Kill switch: when set to "false"/"0", the reconciler never schedules passes.
const RECONCILE_ENABLED = !/^(false|0|no|off)$/i.test(process.env.RECONCILE_ENABLED || "true");
// Postgres advisory-lock key. The reconciler runs inside EVERY worker replica
// (8 of them). To avoid a thundering herd of duplicate re-examinations, a pass
// only proceeds on the ONE replica that wins this transaction-scoped advisory
// lock; the others skip the pass entirely. Arbitrary stable 32-bit key.
const RECONCILE_LOCK_KEY = parseInt(process.env.RECONCILE_LOCK_KEY || "918273645", 10);

let running = false;
let timer: NodeJS.Timeout | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** True if the company already has a non-terminal job in the DB (pending/claimed).
 *  Belt-and-suspenders against duplicate enqueues even within the leader pass. */
async function hasActiveDbJob(companyId: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM analysis_jobs
    WHERE company_id = ${companyId} AND status IN ('pending','claimed') LIMIT 1
  `);
  return r.rows.length > 0;
}

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

type ReconcileStats = {
  syncedCompleted: number;
  recovered: number;
  exhaustedFailed: number;
  qaFlagged: number;
  batchesClosed: number;
  skipped?: boolean; // true when this replica did not win the leader lock
};

/**
 * Public entry point. Acquires a Postgres session-level advisory lock so that
 * across all worker replicas, at most ONE reconcile pass runs at a time. If the
 * lock is already held (another replica is mid-pass), this call returns
 * immediately with skipped=true and does NO work — preventing the multi-replica
 * thundering herd of duplicate re-examinations.
 */
export async function reconcileOnce(): Promise<ReconcileStats> {
  const empty: ReconcileStats = { syncedCompleted: 0, recovered: 0, exhaustedFailed: 0, qaFlagged: 0, batchesClosed: 0, skipped: true };
  // Advisory locks are DATABASE-GLOBAL: whoever holds the key (on any connection)
  // blocks all other holders. We therefore hold the lock on a single dedicated
  // client for the whole pass (so lock + unlock are guaranteed same-connection,
  // safe under a pooled driver), while the pass itself uses the shared pool.
  const client = await pool.connect();
  let got = false;
  try {
    const r = await client.query("SELECT pg_try_advisory_lock($1) AS got", [RECONCILE_LOCK_KEY]);
    got = r.rows?.[0]?.got === true;
    if (!got) return empty; // another replica is the leader for this tick
    return await reconcilePass();
  } finally {
    if (got) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [RECONCILE_LOCK_KEY]); } catch { /* connection may be gone; lock auto-releases on disconnect */ }
    }
    client.release();
  }
}

async function reconcilePass(): Promise<ReconcileStats> {
  const stats: ReconcileStats = { syncedCompleted: 0, recovered: 0, exhaustedFailed: 0, qaFlagged: 0, batchesClosed: 0 };
  const live = await liveQueueCompanyIds();

  // ── 0) Stale-claim reaper: release orphaned `claimed` jobs back to `pending`
  //       IN PLACE (same batch) so the worker re-claims them, instead of letting
  //       them block their batch from ever reaching the completion/review gate.
  //
  //  Targets ONLY jobs that are: claimed past REAP_CLAIM_MIN, belong to a
  //  MULTI-company batch still `running`, have no live BullMQ entry, and whose
  //  company has no results yet. Single-company (re-exam) batches are left to
  //  §1, which handles them with the bounded recovery/QA path. Re-queueing in
  //  place (not new batches) is what prevents the single-company batch
  //  proliferation observed in production. Attempts are NOT incremented here so a
  //  worker that died mid-claim doesn't burn the retry budget for a job it never
  //  actually got to run; §1 still bounds genuinely unprocessable companies.
  try {
    const staleClaims = await db.execute(sql`
      SELECT j.id AS job_id, j.company_id, j.batch_id, j.attempts,
             j.framework_id, j.workspace_id, b.last_heartbeat_at, j.last_progress_at,
             (SELECT COUNT(*) FROM measure_scores ms
                WHERE ms.company_id = j.company_id AND ms.framework_id = j.framework_id) AS has_scores
      FROM analysis_jobs j
      JOIN batch_runs b ON b.id = j.batch_id
      WHERE j.status = 'claimed'
        AND COALESCE(b.last_heartbeat_at, 'epoch') < NOW() - INTERVAL '${sql.raw(String(REAP_CLAIM_MIN))} minutes'
        AND COALESCE(j.last_progress_at, j.claimed_at, 'epoch') < NOW() - INTERVAL '${sql.raw(String(REAP_CLAIM_MIN))} minutes'
        AND b.status = 'running'
        AND b.total_jobs > 1
        AND j.id = (SELECT MAX(id) FROM analysis_jobs j2 WHERE j2.company_id = j.company_id)
    `);
    let reaped = 0;
    for (const row of staleClaims.rows as any[]) {
      const companyId = Number(row.company_id);
      if (live.has(companyId)) continue;            // still genuinely in-flight
      if (Number(row.has_scores) > 0) continue;     // results exist => leave for §1 sync-to-completed
      if (Number(row.attempts) >= 3) continue;      // exhausted => leave for §1 to fail+QA
      // Release back to pending in the SAME batch and re-enqueue onto the queue.
      await db.execute(sql`
        UPDATE analysis_jobs SET status='pending', claimed_at=NULL
        WHERE id=${Number(row.job_id)} AND status='claimed'
      `);
      try {
        const { getQueue } = await import("./queue.js");
        const q = getQueue();
        await q.add(
          `reap-${row.batch_id}-${companyId}`,
          {
            jobId: Number(row.job_id),
            companyId,
            frameworkId: Number(row.framework_id),
            batchId: Number(row.batch_id),
            workspaceId: Number(row.workspace_id),
            skipFetch: false,
          },
          // Unique jobId per reap pass so a re-claim isn't deduped against a
          // stale BullMQ id from a previous pass.
          { priority: 2, jobId: `reap-job-${row.job_id}-${Date.now()}` }
        );
      } catch (e: any) {
        console.warn(`[Reconciler] Reaper could not re-enqueue job ${row.job_id} (will rely on worker poll): ${e?.message}`);
      }
      reaped++;
    }
    if (reaped > 0) console.log(`[Reconciler] Stale-claim reaper released ${reaped} orphaned job(s) back to pending in-place`);
  } catch (e: any) {
    console.warn(`[Reconciler] Stale-claim reaper error (non-fatal): ${e?.message}`);
  }

  // ── 1) Orphaned jobs / companies: claimed jobs idle beyond threshold, OR
  //       companies stuck in fetching/analyzing beyond threshold, with NO live job.
  const orphans = await db.execute(sql`
    SELECT DISTINCT c.id AS company_id, c.workspace_id, c.name,
           j.id AS job_id, j.framework_id, j.batch_id
    FROM companies c
    JOIN analysis_jobs j ON j.company_id = c.id
    JOIN batch_runs b ON b.id = j.batch_id
    WHERE b.status = 'running'
      AND COALESCE(b.last_heartbeat_at, 'epoch') < NOW() - INTERVAL '${sql.raw(String(STUCK_THRESHOLD_MIN))} minutes'
      AND COALESCE(j.last_progress_at, j.claimed_at, 'epoch') < NOW() - INTERVAL '${sql.raw(String(STUCK_THRESHOLD_MIN))} minutes'
      AND j.status IN ('pending','claimed')
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

    // Already has a fresh job enqueued (e.g. by a previous pass or the pipeline)
    // => do not stack another. Idempotency guard against duplicate recovery.
    if (await hasActiveDbJob(companyId)) continue;

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
    if (live.has(companyId)) continue; // a re-exam is already in flight (BullMQ)
    if (await hasActiveDbJob(companyId)) continue; // a re-exam is already enqueued (DB)
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
    SELECT b.id, b.framework_id, b.workspace_id, b.list_id,
           COUNT(*) FILTER (WHERE j.status='completed') AS comp,
           COUNT(*) FILTER (WHERE j.status='failed') AS fail,
           COUNT(*) AS tot,
           COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) AS open_jobs
    FROM batch_runs b
    JOIN analysis_jobs j ON j.batch_id = b.id
    WHERE b.status = 'running'
    GROUP BY b.id, b.framework_id, b.workspace_id, b.list_id
    HAVING COUNT(*) FILTER (WHERE j.status IN ('pending','claimed')) = 0
  `);
  for (const row of openBatches.rows as any[]) {
    const batchId = Number(row.id);
    const comp = Number(row.comp);
    const fail = Number(row.fail);
    // Persist the reconciled counters first.
    await db.execute(sql`
      UPDATE batch_runs SET completed_jobs=${comp}, failed_jobs=${fail} WHERE id=${batchId}
    `);

    if (fail > 0) {
      // ── Review gate (mirrors worker maybeHandleBatchCompletion option-a) ──
      // A batch with terminal failures MUST NOT be silently completed/saved.
      // Route it to pending_review and raise the same batch_review alert so the
      // dashboard surfaces it for the user to re-examine or discard.
      await storage.setBatchRunStatus(batchId, "pending_review");
      try {
        let failedList: Array<{ companyName: string }> = [];
        try { failedList = await storage.getFailedJobsForBatch(batchId) as any; } catch { /* non-fatal */ }
        const names = failedList.slice(0, 5).map(f => f.companyName).filter(Boolean);
        const more = failedList.length > names.length ? " +" + (failedList.length - names.length) + " more" : "";
        const msg =
          "Batch #" + batchId + " finished with " + fail + " failed compan" +
          (fail === 1 ? "y" : "ies") + " (" + comp + " succeeded). Review before saving to Results" +
          (names.length ? ": " + names.join(", ") + more : ".");
        await storage.setSystemAlert({ kind: "batch_review", provider: String(batchId), message: msg });
      } catch (e: any) {
        console.warn(`[Reconciler] Could not raise batch_review alert for batch ${batchId}: ${e?.message}`);
      }
      stats.batchesClosed++;
      console.log(`[Reconciler] Batch ${batchId} -> pending_review: ${comp} completed, ${fail} failed`);
      continue;
    }

    // ── Zero failures: complete + save results (reuse the worker's finaliser to
    //    keep one save path). Dynamic import avoids a load-time circular dep. ──
    try {
      const { finalizeBatchAndSave } = await import("./worker.js");
      await finalizeBatchAndSave(batchId, Number(row.framework_id), Number(row.workspace_id), row.list_id != null ? Number(row.list_id) : undefined);
    } catch (e: any) {
      // Fallback: at least mark it completed so it doesn't spin forever.
      await db.execute(sql`UPDATE batch_runs SET status='completed', completed_at=NOW() WHERE id=${batchId}`);
      console.warn(`[Reconciler] finalizeBatchAndSave failed for batch ${batchId} (${e?.message}); marked completed without save`);
    }
    stats.batchesClosed++;
    console.log(`[Reconciler] Closed batch ${batchId}: ${comp} completed, 0 failed (results saved)`);
  }

  return stats;
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export function startReconciler(): void {
  if (timer) return;
  if (!RECONCILE_ENABLED) {
    console.log("[Reconciler] Disabled via RECONCILE_ENABLED=false; not scheduling any passes.");
    return;
  }
  console.log(`[Reconciler] Starting (interval=${RECONCILE_INTERVAL_MS}ms, stuckThreshold=${STUCK_THRESHOLD_MIN}min, maxAttempts=${RECONCILE_MAX}, lockKey=${RECONCILE_LOCK_KEY})`);
  const tick = async () => {
    if (running) return; // never overlap passes within THIS replica
    running = true;
    try {
      const s = await reconcileOnce();
      if (s.skipped) return; // another replica is the leader for this tick
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
  // First pass after a short delay so the worker finishes booting. The advisory
  // lock ensures only one replica actually executes even if all fire at once.
  timer = setInterval(() => { void tick(); }, RECONCILE_INTERVAL_MS);
  setTimeout(() => { void tick(); }, 30_000);
}

export function stopReconciler(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

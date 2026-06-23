/**
 * One-off: re-examine the quality-zero cohort under the new v3l-r2 ranker.
 *
 * Selection mirrors the reconciler's quality-zero criteria EXACTLY:
 *   analysis_status='completed' AND total_score<=0
 *   AND NOT qaFlag.flagged
 *   AND fetchCoverage.lowEvidence === true
 *   AND corpusChars < QA_THIN_CHARS (100000)
 *   AND framework_id resolvable from latest analysis_job
 *
 * Difference vs the reconciler: the user has asked to re-examine ALL eligible
 * companies regardless of prior attempt count, so we RESET the shared
 * discoveryDiagnostics.autoReexam.count to 0 before enqueue (fresh budget), then
 * enqueue via the SAME storage.enqueueReexamination path the dashboard/reconciler
 * use (creates a dedicated single-job batch, purges dead docs, pushes to BullMQ).
 *
 * Idempotent guards: skips companies that already have a live BullMQ job or a
 * pending/claimed DB job, so re-running this script never double-enqueues.
 */
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import * as storage from "../storage.js";
import { getQueue } from "../queue.js";

const QA_THIN_CHARS = parseInt(process.env.AUTO_REEXAM_MAX_CHARS || "100000", 10);
const THROTTLE_MS = parseInt(process.env.REEXAM_THROTTLE_MS || "150", 10);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

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
    console.warn(`[reexam226] Could not read queue (treating as empty): ${e?.message}`);
  }
  return ids;
}

async function hasActiveDbJob(companyId: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM analysis_jobs
    WHERE company_id = ${companyId} AND status IN ('pending','claimed') LIMIT 1
  `);
  return r.rows.length > 0;
}

(async () => {
  const zeros = await db.execute(sql`
    SELECT c.id, c.workspace_id, c.name, c.discovery_diagnostics AS diag,
           (SELECT j.framework_id FROM analysis_jobs j
              WHERE j.company_id = c.id ORDER BY j.id DESC LIMIT 1) AS framework_id
    FROM companies c
    WHERE c.analysis_status = 'completed'
      AND COALESCE(c.total_score, 0) <= 0
  `);

  const live = await liveQueueCompanyIds();

  let eligible = 0, enqueued = 0, skippedLive = 0, skippedFlag = 0,
      skippedNotLow = 0, skippedThick = 0, skippedNoFw = 0, failed = 0;
  const enqueuedRows: Array<{ id: number; name: string; batchId: number; jobId: number; prevCount: number }> = [];

  for (const row of zeros.rows as any[]) {
    const companyId = Number(row.id);
    const diag = (row.diag && typeof row.diag === "object") ? { ...row.diag } : {};
    if (diag?.qaFlag?.flagged) { skippedFlag++; continue; }
    if (diag?.fetchCoverage?.lowEvidence !== true) { skippedNotLow++; continue; }
    let corpusChars = 0;
    try { corpusChars = await storage.getCorpusCharCount(companyId); } catch { /* ignore */ }
    if (corpusChars >= QA_THIN_CHARS) { skippedThick++; continue; }
    if (row.framework_id == null) { skippedNoFw++; continue; }

    eligible++;

    if (live.has(companyId) || await hasActiveDbJob(companyId)) { skippedLive++; continue; }

    const frameworkId = Number(row.framework_id);
    const workspaceId = Number(row.workspace_id);
    const prevCount = diag?.autoReexam?.count || 0;

    if (DRY_RUN) {
      enqueuedRows.push({ id: companyId, name: row.name, batchId: -1, jobId: -1, prevCount });
      continue;
    }

    // Reset shared auto-reexam budget so this deliberate re-run gets a fresh budget.
    const company = await storage.getCompanyById(companyId, workspaceId);
    if (!company) { failed++; continue; }
    diag.autoReexam = {
      count: 0,
      lastTriggeredAt: new Date().toISOString(),
      reason: `manual cohort re-exam under v3l-r2 ranker (prev count=${prevCount})`,
    };
    await storage.updateCompany(companyId, workspaceId, { discoveryDiagnostics: diag } as any);

    try {
      const enq = await storage.enqueueReexamination({
        companyId, companyName: company.name, frameworkId, workspaceId,
      });
      if (enq) {
        enqueued++;
        enqueuedRows.push({ id: companyId, name: row.name, batchId: enq.batchId, jobId: enq.jobId, prevCount });
        if (enqueued % 20 === 0) console.log(`[reexam226] enqueued ${enqueued} so far...`);
      } else {
        failed++;
      }
    } catch (e: any) {
      failed++;
      console.error(`[reexam226] enqueue failed for ${companyId} (${row.name}): ${e?.message}`);
    }

    if (THROTTLE_MS > 0) await new Promise(r => setTimeout(r, THROTTLE_MS));
  }

  console.log("──────────────────────────────────────────────");
  console.log(`total completed zeros scanned : ${zeros.rows.length}`);
  console.log(`  skipped qaFlagged           : ${skippedFlag}`);
  console.log(`  skipped not-lowEvidence     : ${skippedNotLow}`);
  console.log(`  skipped thick corpus        : ${skippedThick}`);
  console.log(`  skipped no-framework        : ${skippedNoFw}`);
  console.log(`ELIGIBLE                      : ${eligible}`);
  console.log(`  skipped already-live/queued : ${skippedLive}`);
  console.log(`  ENQUEUED                    : ${enqueued}`);
  console.log(`  failed                      : ${failed}`);
  console.log(DRY_RUN ? "(DRY RUN — nothing enqueued)" : "");

  // Persist the audit trail.
  const fs = await import("fs");
  fs.writeFileSync("/tmp/reexam226_enqueued.json", JSON.stringify(enqueuedRows, null, 2));
  console.log(`audit written: /tmp/reexam226_enqueued.json (${enqueuedRows.length} rows)`);

  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });

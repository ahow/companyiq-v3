/**
 * ONE-OFF consolidation: build a single Results snapshot for framework 21
 * (AI Management) over the full MSCI_ACWI_011126 list (listId 20), from scores
 * already in production. Creates a synthetic COMPLETED batch whose jobs are every
 * list member that has fw21 measure_scores, then calls the app's own
 * saveBatchSnapshot so the snapshot uses the exact production build logic.
 *
 * NOT committed. Run against prod with DATABASE_URL set to the prod public URL.
 */
import { db } from "../db.js";
import { sql } from "drizzle-orm";
import { saveBatchSnapshot } from "../worker.js";

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 21;
const LIST_ID = 20;

async function main() {
  // 1. Count the faithful set: list members (workspace 3) with >=1 fw21 score.
  const cntRes = await db.execute(sql`
    SELECT count(DISTINCT c.id) AS n
    FROM company_list_members m
    JOIN companies c ON c.id = m.company_id
    WHERE m.list_id = ${LIST_ID}
      AND c.workspace_id = ${WORKSPACE_ID}
      AND EXISTS (SELECT 1 FROM measure_scores s WHERE s.company_id = c.id AND s.framework_id = ${FRAMEWORK_ID})
  `);
  const n = Number((cntRes.rows[0] as any).n);
  console.log(`[consolidate] companies to include: ${n}`);
  if (n === 0) { console.error("[consolidate] ABORT: zero companies"); process.exit(1); }

  // 2. Create the synthetic completed batch.
  const batchRes = await db.execute(sql`
    INSERT INTO batch_runs
      (workspace_id, framework_id, list_id, status, total_jobs, completed_jobs,
       failed_jobs, started_at, completed_at, snapshot_saved, acceptance_state)
    VALUES
      (${WORKSPACE_ID}, ${FRAMEWORK_ID}, ${LIST_ID}, 'completed', ${n}, ${n},
       0, now(), now(), false, 'pending')
    RETURNING id
  `);
  const batchId = Number((batchRes.rows[0] as any).id);
  console.log(`[consolidate] created synthetic batch_run id=${batchId}`);

  // 3. Insert one completed job per company (same faithful set).
  const jobRes = await db.execute(sql`
    INSERT INTO analysis_jobs
      (workspace_id, batch_id, company_id, company_name, framework_id, status, completed_at, created_at)
    SELECT ${WORKSPACE_ID}, ${batchId}, c.id, c.name, ${FRAMEWORK_ID}, 'completed', now(), now()
    FROM company_list_members m
    JOIN companies c ON c.id = m.company_id
    WHERE m.list_id = ${LIST_ID}
      AND c.workspace_id = ${WORKSPACE_ID}
      AND EXISTS (SELECT 1 FROM measure_scores s WHERE s.company_id = c.id AND s.framework_id = ${FRAMEWORK_ID})
  `);
  const inserted = (jobRes as any).rowCount ?? n;
  console.log(`[consolidate] inserted ${inserted} completed jobs`);

  // Keep total_jobs aligned with actual inserted count (snapshotIsComplete check).
  if (inserted !== n) {
    await db.execute(sql`UPDATE batch_runs SET total_jobs = ${inserted}, completed_jobs = ${inserted} WHERE id = ${batchId}`);
    console.log(`[consolidate] adjusted total_jobs to ${inserted}`);
  }

  // 4. Build the snapshot via the app's own logic.
  console.log(`[consolidate] building snapshot (this may take several minutes)...`);
  const ok = await saveBatchSnapshot(batchId, FRAMEWORK_ID, WORKSPACE_ID, LIST_ID);
  console.log(`[consolidate] saveBatchSnapshot returned: ${ok}`);

  // 5. Verify.
  const verify = await db.execute(sql`
    SELECT id, companies_count, list_name, framework_id, acceptance_state, rejection_reason,
           to_char(created_at,'YYYY-MM-DD HH24:MI') AS created
    FROM analysis_results WHERE batch_id = ${batchId}
  `);
  if (verify.rows.length > 0) {
    const r = verify.rows[0] as any;
    console.log(`[consolidate] SNAPSHOT SAVED: result id=${r.id} count=${r.companies_count} list=${r.list_name} acc=${r.acceptance_state} rej=${r.rejection_reason ?? "none"} created=${r.created}`);
  } else {
    console.error(`[consolidate] NO snapshot row for batch ${batchId} — mark batch snapshot_saved stays false`);
  }
  await db.execute(sql`UPDATE batch_runs SET snapshot_saved = true WHERE id = ${batchId} AND EXISTS (SELECT 1 FROM analysis_results WHERE batch_id = ${batchId})`);
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error("[consolidate] FATAL", e); process.exit(3); });

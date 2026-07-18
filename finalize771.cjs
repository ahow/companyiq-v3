// Drive the 3 genuine no-data jobs in batch 771 to terminal `failed`, set the
// batch's failed_jobs counter accordingly, then let the worker's completion gate
// route the batch into pending_review. We do NOT fabricate data for these 3.
//
// Steps:
//  1. Mark the 3 pending jobs as terminally failed (status=failed, attempts=3).
//  2. Set batch_runs.failed_jobs = 3 (was 0) so completed(126)+failed(3)=total(129).
//  3. Trigger the completion gate. Since we can't call the worker's in-process
//     function directly, we replicate maybeHandleBatchCompletion's decision here:
//     failed>0  => status=pending_review + raise batch_review system alert.
const { Client } = require("pg");
const fs = require("fs");
const DB = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();
const WS = 3, BATCH = 771;

(async () => {
  const pg = new Client({ connectionString: DB, ssl: false });
  await pg.connect();

  // 1. Terminal-fail the 3 no-data jobs.
  const upd = await pg.query(
    `update analysis_jobs
        set status='failed', attempts=3, worker_id=null, claimed_at=null,
            last_error=coalesce(last_error,'No documents could be fetched')
      where batch_id=$1 and status<>'completed'
      returning id, company_id, company_name`, [BATCH]
  );
  console.log(`[Finalize771] terminal-failed ${upd.rows.length} jobs:`);
  upd.rows.forEach(r => console.log(`   ${r.company_id} ${r.company_name}`));

  // 2. Recompute batch counters from the source of truth (analysis_jobs).
  const agg = await pg.query(
    `select
        count(*) filter (where status='completed')::int as completed,
        count(*) filter (where status='failed')::int     as failed,
        count(*)::int as total
       from analysis_jobs where batch_id=$1`, [BATCH]
  );
  const { completed, failed, total } = agg.rows[0];
  console.log(`[Finalize771] counts completed=${completed} failed=${failed} total=${total}`);

  await pg.query(
    `update batch_runs set completed_jobs=$2, failed_jobs=$3, total_jobs=$4 where id=$1`,
    [BATCH, completed, failed, total]
  );

  // 3. Replicate completion-gate decision (failed>0 => pending_review).
  if (completed + failed >= total && failed > 0) {
    await pg.query(`update batch_runs set status='pending_review', completed_at=now() where id=$1`, [BATCH]);

    // Build failure list + alert (mirror worker.ts message format).
    const fl = await pg.query(
      `select company_id, company_name, last_error from analysis_jobs
        where batch_id=$1 and status='failed' order by company_name asc`, [BATCH]
    );
    const names = fl.rows.slice(0, 5).map(r => r.company_name).filter(Boolean);
    const more = fl.rows.length > names.length ? ` +${fl.rows.length - names.length} more` : "";
    const msg = `Batch #${BATCH} finished with ${failed} failed compan${failed === 1 ? "y" : "ies"} ` +
      `(${completed} succeeded). Review before saving to Results` +
      (names.length ? `: ${names.join(", ")}${more}` : ".");

    // Upsert-style: clear any prior alert for this batch then insert.
    await pg.query(
      `update system_alerts set active=false where kind='batch_review' and provider=$1 and active=true`,
      [String(BATCH)]
    );
    await pg.query(
      `insert into system_alerts (kind, provider, message, active, created_at, updated_at)
       values ('batch_review',$1,$2,true, now(), now())`,
      [String(BATCH), msg]
    );
    console.log(`[Finalize771] batch -> pending_review; alert raised: ${msg}`);
  } else {
    console.log(`[Finalize771] gate not triggered (completed+failed<${total} or failed=0)`);
  }

  await pg.end();
  console.log("[Finalize771] DONE");
  process.exit(0);
})().catch(e => { console.error("[Finalize771] FAILED", e.message); process.exit(1); });

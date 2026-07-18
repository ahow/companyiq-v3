// Requeue the 3 orphaned jobs in batch 771 (Sony Financial, Empire, WSP Global).
// They were marked failed with attempts=0 "Server restarted — job was orphaned"
// during the bulk-delete deploy restart. Reset them to pending, reopen the batch,
// and re-enqueue to BullMQ so all 129 get a genuine analysis attempt.
//
//   DRY=1 node requeue3.cjs   -> validate only
//       node requeue3.cjs     -> reopen batch 771, reset 3 jobs, enqueue
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { Client } = require("pg");
const fs = require("fs");

const DRY = process.env.DRY === "1";
const WS = 3, FW = 7, BATCH = 771;
const DB = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();
const REDIS = fs.readFileSync("/tmp/redis_pub.txt", "utf8").trim();

(async () => {
  const pg = new Client({ connectionString: DB, ssl: false });
  await pg.connect();

  // The 3 orphaned jobs still in batch 771
  const { rows: jobs } = await pg.query(
    `select id, company_id, company_name, status, attempts, last_error
       from analysis_jobs
      where batch_id=$1 and status='failed' and attempts=0
        and last_error like 'Server restarted%'
      order by id`, [BATCH]
  );
  console.log(`[Requeue3] found ${jobs.length} orphaned jobs in batch ${BATCH}`);
  jobs.forEach(j => console.log(`  job ${j.id} company ${j.company_id} ${j.company_name}`));
  if (jobs.length === 0) { console.log("[Requeue3] nothing to do"); await pg.end(); process.exit(0); }

  if (DRY) { console.log("[Requeue3] DRY RUN — no writes."); await pg.end(); process.exit(0); }

  // Make sure no OTHER batch is running (createBatchRun semantics).
  await pg.query(
    `update batch_runs set status='cancelled', completed_at=now()
       where workspace_id=$1 and status='running' and id<>$2`, [WS, BATCH]
  );

  // Reopen batch 771 as running so the completion gate fires properly when these finish.
  await pg.query(
    `update batch_runs set status='running', completed_at=null where id=$1`, [BATCH]
  );

  // Reset the 3 jobs to pending and clear company state for clean re-discovery.
  for (const j of jobs) {
    await pg.query(`delete from measure_scores where company_id=$1 and framework_id=$2`, [j.company_id, FW]);
    try { await pg.query(`delete from documents where company_id=$1`, [j.company_id]); } catch (e) {}
    await pg.query(
      `update companies set analysis_status='idle', total_score=null, summary=null,
        measures_met_count=null, measures_total_count=null where id=$1`, [j.company_id]
    );
    await pg.query(
      `update analysis_jobs set status='pending', attempts=0, last_error=null,
        worker_id=null, claimed_at=null, completed_at=null where id=$1`, [j.id]
    );
  }
  console.log(`[Requeue3] reset ${jobs.length} jobs to pending, reopened batch ${BATCH}`);

  // Enqueue to BullMQ (mirror addBatchJobs)
  const connection = new IORedis(REDIS, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });

  // purge any stale queue jobs for these companies first
  try {
    const stale = await q.getJobs(["waiting","active","prioritized","delayed","failed","paused"]);
    const idset = new Set(jobs.map(j => j.company_id));
    let purged = 0;
    for (const sj of stale) { if (sj?.data?.companyId && idset.has(sj.data.companyId)) { try { await sj.remove(); purged++; } catch {} } }
    console.log(`[Requeue3] purged ${purged} stale queue jobs`);
  } catch (e) { console.warn("[Requeue3] stale purge warn:", e.message); }

  const bulk = jobs.map((j, index) => ({
    name: `analysis-${BATCH}-${j.company_id}`,
    data: { jobId: j.id, companyId: j.company_id, frameworkId: FW, batchId: BATCH, workspaceId: WS },
    opts: { priority: 1 + (index % 5), jobId: `batch-${BATCH}-company-${j.company_id}` },
  }));
  await q.addBulk(bulk);
  console.log(`[Requeue3] enqueued ${bulk.length} jobs to "analysis"`);

  await q.close();
  await connection.quit();
  await pg.end();
  console.log(`[Requeue3] DONE. batch=${BATCH}`);
  process.exit(0);
})().catch(e => { console.error("[Requeue3] FAILED", e); process.exit(1); });

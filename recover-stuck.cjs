// Recovery enqueue for the 8 genuinely-incomplete stuck companies.
// Creates a fresh dedicated batch (new batchId => collision-free jobIds),
// clears their pending/dead/rejected docs so the next run re-discovers + re-fetches,
// resets the company record, and pushes BullMQ jobs with skipFetch=false.
//
// Runs INSIDE the app container (has bullmq, ioredis, pg, REDIS_URL, DATABASE_URL).

const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { Client } = require("pg");

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 7;
const COMPANY_IDS = [2170, 2399, 1655, 902, 1696, 494, 2543, 2076];

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();

  // 1) Create a dedicated recovery batch_run.
  const batchRes = await pg.query(
    `insert into batch_runs (workspace_id, framework_id, list_id, status, total_jobs, completed_jobs, failed_jobs, started_at)
     values ($1, $2, null, 'running', $3, 0, 0, now()) returning id`,
    [WORKSPACE_ID, FRAMEWORK_ID, COMPANY_IDS.length]
  );
  const batchId = batchRes.rows[0].id;
  console.log("Created recovery batch_run id=" + batchId + " with " + COMPANY_IDS.length + " jobs");

  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });

  for (const companyId of COMPANY_IDS) {
    const nameRes = await pg.query("select name from companies where id=$1", [companyId]);
    const companyName = nameRes.rows[0] ? nameRes.rows[0].name : ("company-" + companyId);

    // Clear non-ok docs so re-discovery + re-fetch genuinely re-attempts them. Preserve 'ok' docs.
    const del = await pg.query(
      "delete from documents where company_id=$1 and fetch_status in ('pending','dead','rejected','needs_verify')",
      [companyId]
    );

    // Reset company record so it shows in-flight and old measure scores (none here) are cleared.
    await pg.query(
      "update companies set analysis_status='idle', total_score=null, updated_at=now() where id=$1",
      [companyId]
    );
    await pg.query("delete from measure_scores where company_id=$1 and framework_id=$2", [companyId, FRAMEWORK_ID]);

    // Create the analysis_jobs row.
    const jobRes = await pg.query(
      `insert into analysis_jobs (workspace_id, batch_id, company_id, company_name, framework_id, status, attempts, created_at)
       values ($1, $2, $3, $4, $5, 'pending', 0, now()) returning id`,
      [WORKSPACE_ID, batchId, companyId, companyName, FRAMEWORK_ID]
    );
    const jobId = jobRes.rows[0].id;

    // Push BullMQ job (skipFetch false => full re-fetch). Fresh batchId => unique jobId.
    await q.add(
      "analysis-" + batchId + "-" + companyId,
      { jobId, companyId, frameworkId: FRAMEWORK_ID, batchId, workspaceId: WORKSPACE_ID, skipFetch: false },
      { priority: 1, jobId: "batch-" + batchId + "-company-" + companyId }
    );
    console.log("  enqueued company=" + companyId + " (" + String(companyName).slice(0, 28) + ") job=" + jobId + " clearedDocs=" + del.rowCount);
  }

  const counts = await q.getJobCounts("waiting", "active", "delayed", "prioritized");
  console.log("QUEUE COUNTS after enqueue:", JSON.stringify(counts));
  console.log("RECOVERY_BATCH_ID=" + batchId);

  await q.close();
  await connection.quit();
  await pg.end();
  process.exit(0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });

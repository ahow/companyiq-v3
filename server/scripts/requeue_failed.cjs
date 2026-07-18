/**
 * Re-queue the 6 timed-out workspace-3 companies through the current pipeline.
 * Mirrors storage.enqueueReexamination() exactly:
 *   - dedicated single-job batch_runs row (totalJobs=1)
 *   - analysis_jobs row (status defaults to pending)
 *   - clear PENDING/DEAD/REJECTED docs (keep ok docs) so fetch re-discovers
 *   - clear measure_scores
 *   - set company.analysis_status='idle'
 *   - BullMQ add with skipFetch:false, deterministic jobId
 *
 * Uses the public Redis TCP proxy and the public Postgres URL.
 */
const { Pool } = require("pg");
const IORedis = require("ioredis");
const { Queue } = require("bullmq");
const fs = require("fs");

const DB_URL = fs.readFileSync("/tmp/dburl.txt", "utf8").trim();
const REDIS_URL = fs.readFileSync("/tmp/redisurl_pub.txt", "utf8").trim();

const WORKSPACE_ID = 3;
const FRAMEWORK_ID = 7; // active "AI Governance and Strategy Assessment Framework"
const COMPANY_IDS = [839, 1466, 1549, 1983, 2161, 2212];

(async () => {
  const pool = new Pool({ connectionString: DB_URL });
  const conn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue("analysis", { connection: conn });

  const results = [];
  for (const companyId of COMPANY_IDS) {
    const c = await pool.query(
      "SELECT id, name, workspace_id, analysis_status FROM companies WHERE id=$1",
      [companyId]
    );
    if (c.rowCount === 0) { console.log(`skip ${companyId}: not found`); continue; }
    const company = c.rows[0];
    if (company.workspace_id !== WORKSPACE_ID) { console.log(`skip ${companyId}: ws mismatch`); continue; }

    // Guard: don't double-enqueue if an active job already exists
    const active = await pool.query(
      "SELECT COUNT(*)::int n FROM analysis_jobs WHERE company_id=$1 AND status IN ('pending','claimed')",
      [companyId]
    );
    if (active.rows[0].n > 0) { console.log(`skip ${companyId} (${company.name}): already has active job`); continue; }

    // 1) dedicated single-job batch
    const b = await pool.query(
      "INSERT INTO batch_runs (workspace_id, framework_id, total_jobs, status) VALUES ($1,$2,1,'running') RETURNING id",
      [WORKSPACE_ID, FRAMEWORK_ID]
    );
    const batchId = b.rows[0].id;

    // 2) analysis_jobs row (pending)
    const j = await pool.query(
      "INSERT INTO analysis_jobs (workspace_id, batch_id, company_id, company_name, framework_id, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id",
      [WORKSPACE_ID, batchId, companyId, company.name, FRAMEWORK_ID]
    );
    const jobId = j.rows[0].id;

    // 3) clear pending/dead/rejected docs (keep ok), clear scores
    await pool.query(
      "DELETE FROM documents WHERE company_id=$1 AND (fetch_status IS NULL OR fetch_status IN ('pending','dead','rejected'))",
      [companyId]
    );
    await pool.query("DELETE FROM measure_scores WHERE company_id=$1", [companyId]);

    // 4) reset company status
    await pool.query(
      "UPDATE companies SET analysis_status='idle', total_score=NULL, summary=NULL WHERE id=$1",
      [companyId]
    );

    // 5) enqueue on BullMQ (skipFetch:false), deterministic id mirroring app
    await queue.add(
      `reexam-${batchId}-${companyId}`,
      { jobId, companyId, frameworkId: FRAMEWORK_ID, batchId, workspaceId: WORKSPACE_ID, skipFetch: false },
      { priority: 1, jobId: `reexam-company-${companyId}-batch-${batchId}` }
    );

    results.push({ companyId, name: company.name, batchId, jobId });
    console.log(`queued ${companyId} ${company.name} -> batch ${batchId} job ${jobId}`);
  }

  console.log("\nENQUEUED", results.length, "companies");
  await queue.close();
  conn.disconnect();
  await pool.end();
})().catch(e => { console.error("FATAL", e); process.exit(1); });

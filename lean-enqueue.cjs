// Lean enqueue: creates batch + analysis_job rows via direct SQL and adds a BullMQ
// job to the "analysis" queue, WITHOUT importing the heavy storage/app graph.
// Usage (inside worker via railway ssh):
//   CID=1914 WS=3 FW=7 node lean-enqueue.cjs
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { Client } = require("pg");

const CID = parseInt(process.env.CID || "1914", 10);
const WS = parseInt(process.env.WS || "3", 10);
const FW = parseInt(process.env.FW || "7", 10);

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL || process.env.PG });
  await pg.connect();
  const { rows: crows } = await pg.query("SELECT id, name FROM companies WHERE id=$1", [CID]);
  if (!crows.length) throw new Error("company not found");
  const name = crows[0].name;

  // reset company
  await pg.query("UPDATE companies SET analysis_status='idle', total_score=NULL, summary=NULL, measures_met_count=NULL, measures_total_count=NULL WHERE id=$1", [CID]);

  const { rows: brows } = await pg.query(
    "INSERT INTO batch_runs (workspace_id, framework_id, status, total_jobs) VALUES ($1,$2,'running',1) RETURNING id",
    [WS, FW]
  );
  const batchId = brows[0].id;
  const { rows: jrows } = await pg.query(
    "INSERT INTO analysis_jobs (workspace_id, batch_id, company_id, company_name, framework_id, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id",
    [WS, batchId, CID, name, FW]
  );
  const jobId = jrows[0].id;

  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });
  // purge any stale job for this company id
  try {
    const states = ["waiting", "active", "prioritized", "delayed", "failed", "paused"];
    const stale = await q.getJobs(states);
    for (const j of stale) { if (j?.data?.companyId === CID) { try { await j.remove(); } catch {} } }
  } catch {}
  await q.add(
    `validate-${batchId}-${CID}`,
    { jobId, companyId: CID, frameworkId: FW, batchId, workspaceId: WS },
    { priority: 1, jobId: `batch-${batchId}-company-${CID}` }
  );
  console.log(`ENQUEUED company=${CID} (${name}) batch=${batchId} job=${jobId}`);
  await q.close();
  await connection.quit();
  await pg.end();
  process.exit(0);
})().catch((e) => { console.error("LEAN_ENQUEUE_FAILED", e.message); process.exit(1); });

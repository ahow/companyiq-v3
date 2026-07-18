// Self-contained re-run enqueue for the 129 ACWI May 26 (list 4, fw 7) companies
// that never produced a usable result. Mirrors server/queue.ts addBatchJobs exactly.
//
//   DRY=1 node enqueue129.cjs   -> validate only
//       node enqueue129.cjs     -> create batch, reset companies, enqueue
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const { Client } = require("pg");
const fs = require("fs");

const DRY = process.env.DRY === "1";
const WS = 3, FW = 7, LIST = 4;
const DB = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();
const REDIS = fs.readFileSync("/tmp/redis_pub.txt", "utf8").trim();
const IDS = fs.readFileSync("/home/ubuntu/companyiq-v3/target_ids.txt", "utf8")
  .trim().split(",").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

(async () => {
  console.log(`[Enq129] DRY=${DRY} ids=${IDS.length} ws=${WS} fw=${FW} list=${LIST}`);
  if (IDS.length !== 129) console.warn(`[Enq129] WARNING expected 129, got ${IDS.length}`);

  const pg = new Client({ connectionString: DB, ssl: false });
  await pg.connect();

  // Resolve companies
  const { rows: comps } = await pg.query(
    `select id, name from companies where id = ANY($1::int[]) order by id`, [IDS]
  );
  console.log(`[Enq129] resolved ${comps.length} companies`);
  const missing = IDS.filter(id => !comps.find(c => c.id === id));
  if (missing.length) console.warn(`[Enq129] missing ids: ${missing.join(",")}`);

  if (DRY) {
    console.log("[Enq129] sample:", comps.slice(0, 5).map(c => `${c.id}:${c.name}`).join(" | "));
    console.log("[Enq129] DRY RUN — no writes. Done.");
    await pg.end();
    process.exit(0);
  }

  // 1) Create batch (running, list 4). createBatchRun also cancels other running batches,
  //    which is fine (none should be running).
  await pg.query(
    `update batch_runs set status='cancelled', completed_at=now() where workspace_id=$1 and status='running'`, [WS]
  );
  const { rows: brows } = await pg.query(
    `insert into batch_runs (workspace_id, framework_id, status, total_jobs, list_id, started_at)
     values ($1,$2,'running',$3,$4, now()) returning id`,
    [WS, FW, comps.length, LIST]
  );
  const batchId = brows[0].id;
  console.log(`[Enq129] created batch ${batchId}`);

  // 2) Reset each company + purge prior docs/measures for clean re-discovery
  for (const c of comps) {
    await pg.query(`delete from measure_scores where company_id=$1 and framework_id=$2`, [c.id, FW]);
    // documents table cleanup (best-effort; column names verified earlier)
    try { await pg.query(`delete from documents where company_id=$1`, [c.id]); } catch (e) { /* table may differ */ }
    await pg.query(
      `update companies set analysis_status='idle', total_score=null, summary=null,
        measures_met_count=null, measures_total_count=null where id=$1`, [c.id]
    );
  }
  console.log(`[Enq129] reset ${comps.length} companies (measures+docs purged)`);

  // 3) Insert analysis_jobs rows
  const jobIds = [];
  for (const c of comps) {
    const { rows } = await pg.query(
      `insert into analysis_jobs (workspace_id, batch_id, company_id, company_name, framework_id, status, attempts, created_at)
       values ($1,$2,$3,$4,$5,'pending',0, now()) returning id`,
      [WS, batchId, c.id, c.name, FW]
    );
    jobIds.push({ jobId: rows[0].id, companyId: c.id });
  }
  console.log(`[Enq129] inserted ${jobIds.length} analysis_jobs`);

  // 4) Enqueue to BullMQ (mirror addBatchJobs)
  const connection = new IORedis(REDIS, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });

  // purge any stale jobs for these companies first
  try {
    const stale = await q.getJobs(["waiting", "active", "prioritized", "delayed", "failed", "paused"]);
    const idset = new Set(comps.map(c => c.id));
    let purged = 0;
    for (const j of stale) { if (j?.data?.companyId && idset.has(j.data.companyId)) { try { await j.remove(); purged++; } catch {} } }
    console.log(`[Enq129] purged ${purged} stale queue jobs`);
  } catch (e) { console.warn("[Enq129] stale purge warn:", e.message); }

  const basePriority = Math.min(Math.floor(jobIds.length / 10), 20);
  const bulk = jobIds.map((j, index) => ({
    name: `analysis-${batchId}-${j.companyId}`,
    data: { jobId: j.jobId, companyId: j.companyId, frameworkId: FW, batchId, workspaceId: WS },
    opts: { priority: basePriority + (index % 5), jobId: `batch-${batchId}-company-${j.companyId}` },
  }));
  const CHUNK = 100;
  for (let i = 0; i < bulk.length; i += CHUNK) await q.addBulk(bulk.slice(i, i + CHUNK));
  console.log(`[Enq129] enqueued ${bulk.length} jobs to "analysis" (batch ${batchId}, priority ${basePriority})`);

  await q.close();
  await connection.quit();
  await pg.end();
  console.log(`[Enq129] DONE. batch=${batchId}`);
  process.exit(0);
})().catch(e => { console.error("[Enq129] FAILED", e); process.exit(1); });

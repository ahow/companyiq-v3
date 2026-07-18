// Inspect the BullMQ 'analysis' queue state and look for the stuck companies' jobs.
const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const stuckCompanies = [2170, 2399, 1655, 902, 1696, 494, 1722, 2076, 2301, 531, 2187, 2543, 2556];

(async () => {
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });
  const counts = await q.getJobCounts(
    "waiting", "active", "delayed", "prioritized", "paused", "completed", "failed", "waiting-children"
  );
  console.log("QUEUE COUNTS:", JSON.stringify(counts));

  const states = ["waiting", "active", "delayed", "prioritized", "paused"];
  const jobs = await q.getJobs(states, 0, 2000);
  console.log("Total non-terminal jobs found:", jobs.length);
  const mine = jobs.filter(j => j && j.data && stuckCompanies.includes(j.data.companyId));
  console.log("Stuck-company jobs present in queue:", mine.length);
  for (const j of mine) {
    const state = await j.getState();
    console.log(`  jobId=${j.id} company=${j.data.companyId} batch=${j.data.batchId} state=${state} attemptsMade=${j.attemptsMade}`);
  }
  // Also check by deterministic jobId whether a record lingers for each stuck company
  console.log("--- direct jobId lookups (batch-136/242) ---");
  for (const cid of stuckCompanies) {
    for (const bid of [136, 242]) {
      const jid = `batch-${bid}-company-${cid}`;
      const j = await q.getJob(jid);
      if (j) {
        const state = await j.getState().catch(() => "unknown");
        console.log(`  FOUND ${jid} state=${state}`);
      }
    }
  }
  await q.close();
  await connection.quit();
  process.exit(0);
})().catch(e => { console.error("ERR", e); process.exit(1); });

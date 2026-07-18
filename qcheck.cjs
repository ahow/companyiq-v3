const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const fs = require("fs");
const REDIS = fs.readFileSync("/tmp/redis_pub.txt", "utf8").trim();
(async () => {
  const connection = new IORedis(REDIS, { maxRetriesPerRequest: null });
  const q = new Queue("analysis", { connection });
  const counts = await q.getJobCounts("waiting","active","prioritized","delayed","failed","paused","completed");
  console.log("Queue counts:", JSON.stringify(counts));
  const jobs = await q.getJobs(["waiting","active","prioritized","delayed","failed","paused"]);
  const want = new Set([461,1066,1981]);
  const mine = jobs.filter(j => j?.data?.companyId && want.has(j.data.companyId));
  console.log("Our 3 jobs in queue:", mine.length);
  for (const j of mine) {
    const state = await j.getState();
    console.log(`  job ${j.id} company ${j.data.companyId} state=${state} attemptsMade=${j.attemptsMade}`);
  }
  // Show a few waiting/active overall
  console.log("Total non-completed jobs in queue:", jobs.length);
  await q.close(); await connection.quit();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });

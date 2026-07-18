const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4, FW = 7;

  // analysis_jobs columns
  const cols = await c.query("select column_name,data_type from information_schema.columns where table_name='analysis_jobs' order by ordinal_position");
  console.log("analysis_jobs cols:", cols.rows.map(r=>r.column_name).join(", "));

  // For idle companies: do they have ANY analysis_jobs row ever?
  const idle = await c.query(
    `select co.id, co.name,
        (select count(*) from analysis_jobs j where j.company_id=co.id) jobs_ever,
        (select count(*) from analysis_jobs j where j.company_id=co.id and j.status='pending') pend,
        (select count(*) from analysis_jobs j where j.company_id=co.id and j.status='claimed') claimed,
        (select count(*) from processing_errors pe where pe.company_id=co.id) errs
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status='idle' order by co.name`,
    [LIST]
  );
  const idleNoJob = idle.rows.filter(r=>Number(r.jobs_ever)===0).length;
  const idleWithJob = idle.rows.filter(r=>Number(r.jobs_ever)>0);
  console.log("\nIDLE total:", idle.rows.length, "| idle with NO job ever:", idleNoJob, "| idle with a job row:", idleWithJob.length);
  console.log("Idle-with-job sample:", JSON.stringify(idleWithJob.slice(0,8),null,1));

  // For failed companies: how many job rows / attempts, latest job status
  const failed = await c.query(
    `select co.id, co.name,
        (select count(*) from analysis_jobs j where j.company_id=co.id) jobs_ever,
        (select max(j.attempts) from analysis_jobs j where j.company_id=co.id) max_attempts,
        (select count(*) from analysis_jobs j where j.company_id=co.id and j.status='pending') pend,
        (select count(*) from analysis_jobs j where j.company_id=co.id and j.status='claimed') claimed
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status='failed' order by co.name`,
    [LIST]
  );
  console.log("\nFAILED total:", failed.rows.length);
  console.log("failed jobs_ever distribution:");
  const dist = {};
  failed.rows.forEach(r=>{const k=r.jobs_ever+"job/"+r.max_attempts+"att"; dist[k]=(dist[k]||0)+1;});
  console.log(JSON.stringify(dist,null,1));

  // Are there currently ANY pending/claimed jobs at all in the system?
  const open = await c.query("select status, count(*) n from analysis_jobs group by 1 order by 2 desc");
  console.log("\nAll analysis_jobs by status:", JSON.stringify(open.rows));

  // batch_runs for list 4 - history
  const runs = await c.query("select id,status,total_jobs,completed_jobs,failed_jobs,started_at,completed_at from batch_runs where list_id=$1 order by id desc limit 40",[LIST]);
  console.log("\nbatch_runs for list 4 (recent):");
  runs.rows.forEach(r=>console.log(`  #${r.id} ${r.status} tot=${r.total_jobs} ok=${r.completed_jobs} fail=${r.failed_jobs} ${r.started_at?new Date(r.started_at).toISOString().slice(0,16):''}`));

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

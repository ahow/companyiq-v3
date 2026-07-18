const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4;

  // For an idle company, show its analysis_jobs status breakdown across batches
  const sample = await c.query(
    `select j.batch_id, j.status, j.attempts, left(coalesce(j.last_error,''),50) err, j.created_at
     from analysis_jobs j
     where j.company_id = 818
     order by j.batch_id desc, j.id desc limit 40`
  );
  console.log("ABSA GROUP (818) job rows by batch:");
  sample.rows.forEach(r=>console.log(`  b${r.batch_id} ${r.status} att=${r.attempts} ${r.err}`));

  // Across all 56 idle companies: aggregate the status of their jobs in batch 667 specifically
  const in667 = await c.query(
    `select j.status, count(*) n
     from analysis_jobs j
     where j.batch_id = 667
       and j.company_id in (
         select co.id from company_list_members m join companies co on co.id=m.company_id
         where m.list_id=$1 and co.analysis_status='idle')
     group by 1 order by 2 desc`,
    [LIST]
  );
  console.log("\nIdle companies' job status WITHIN batch 667:", JSON.stringify(in667.rows));

  // failed companies' job status within 667
  const f667 = await c.query(
    `select j.status, count(*) n
     from analysis_jobs j
     where j.batch_id = 667
       and j.company_id in (
         select co.id from company_list_members m join companies co on co.id=m.company_id
         where m.list_id=$1 and co.analysis_status='failed')
     group by 1 order by 2 desc`,
    [LIST]
  );
  console.log("Failed companies' job status WITHIN batch 667:", JSON.stringify(f667.rows));

  // do idle companies even have a job in 667?
  const hasJob667 = await c.query(
    `select (co.analysis_status) st, count(distinct co.id) total,
        count(distinct co.id) filter (where exists (select 1 from analysis_jobs j where j.company_id=co.id and j.batch_id=667)) with_667_job
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status in ('idle','failed')
     group by 1`,
    [LIST]
  );
  console.log("\nidle/failed: how many had a job in batch 667?", JSON.stringify(hasJob667.rows,null,1));

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

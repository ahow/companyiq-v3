const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4;

  // Identify framework used by batch 667
  const b = await c.query("select id,framework_id,list_id,status,total_jobs,completed_jobs,failed_jobs from batch_runs where id=667");
  console.log("Batch 667:", JSON.stringify(b.rows[0]));
  const FW = b.rows[0].framework_id;
  const fm = await c.query("select count(*) n from framework_measures where framework_id=$1", [FW]);
  console.log("Framework", FW, "measure count:", fm.rows[0].n);

  // failed + idle companies for list 4
  const rows = await c.query(
    `select co.id, co.name, co.analysis_status, co.total_score,
            (select count(*) from measure_scores ms where ms.company_id=co.id and ms.framework_id=$2) as measure_rows
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status in ('failed','idle')
     order by co.analysis_status, co.name`,
    [LIST, FW]
  );
  const failed = rows.rows.filter(r => r.analysis_status === 'failed');
  const idle = rows.rows.filter(r => r.analysis_status === 'idle');
  console.log("\nFAILED:", failed.length, " IDLE:", idle.length);

  // write full lists to CSV
  const csv = ["company_id,name,analysis_status,total_score,measure_rows"];
  rows.rows.forEach(r => csv.push(`${r.id},"${(r.name||'').replace(/"/g,'""')}",${r.analysis_status},${r.total_score==null?'':r.total_score},${r.measure_rows}`));
  fs.writeFileSync("/home/ubuntu/companyiq-v3/non_snapshot_companies.csv", csv.join("\n"));
  console.log("Wrote non_snapshot_companies.csv");

  // processing_errors for the failed ones (last error per company)
  const cols = await c.query("select column_name from information_schema.columns where table_name='processing_errors' order by ordinal_position");
  console.log("\nprocessing_errors cols:", cols.rows.map(r=>r.column_name).join(", "));

  // measure completeness audit on COMPLETED companies in snapshot
  const audit = await c.query(
    `select count(*) total_completed,
            sum(case when mc.cnt = $2 then 1 else 0 end) full_measures,
            sum(case when mc.cnt = 0 then 1 else 0 end) zero_measures,
            min(mc.cnt) min_cnt, max(mc.cnt) max_cnt
     from (
        select co.id, (select count(*) from measure_scores ms where ms.company_id=co.id and ms.framework_id=$3) cnt
        from company_list_members m join companies co on co.id=m.company_id
        where m.list_id=$1 and co.analysis_status='completed'
     ) mc`,
    [LIST, fm.rows[0].n, FW]
  );
  console.log("\nMEASURE COMPLETENESS (completed companies):", JSON.stringify(audit.rows[0]));

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

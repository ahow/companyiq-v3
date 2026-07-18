const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4, FW = 7;

  // 3 completed companies with 0 measure rows
  const empty = await c.query(
    `select co.id, co.name, co.analysis_status, co.total_score
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status='completed'
       and (select count(*) from measure_scores ms where ms.company_id=co.id and ms.framework_id=$2)=0`,
    [LIST, FW]
  );
  console.log("COMPLETED but 0 measures:", JSON.stringify(empty.rows, null, 1));

  // failure reason summary: latest error per failed company, grouped by stage + short error
  const fr = await c.query(
    `with failed as (
       select co.id, co.name from company_list_members m join companies co on co.id=m.company_id
       where m.list_id=$1 and co.analysis_status='failed'
     ), last_err as (
       select distinct on (pe.company_id) pe.company_id, pe.stage, pe.error
       from processing_errors pe join failed f on f.id=pe.company_id
       order by pe.company_id, pe.created_at desc
     )
     select coalesce(stage,'(none)') stage,
            left(coalesce(error,'(no error row)'),60) short, count(*) n
     from failed f left join last_err le on le.company_id=f.id
     group by 1,2 order by 3 desc`,
    [LIST]
  );
  console.log("\nFAILED reason summary:");
  fr.rows.forEach(r => console.log("  "+String(r.n).padStart(3), "["+r.stage+"]", r.short));

  // How many failed have NO processing_errors row at all
  const noerr = await c.query(
    `select count(*) n from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 and co.analysis_status='failed'
       and not exists (select 1 from processing_errors pe where pe.company_id=co.id)`,
    [LIST]
  );
  console.log("\nFailed companies with NO processing_errors row:", noerr.rows[0].n);

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

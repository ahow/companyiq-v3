const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4, FW = 7;
  // failed + idle + completed-but-no-measures
  const r = await c.query(
    `select distinct co.id
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1
       and (
         co.analysis_status in ('failed','idle')
         or (co.analysis_status='completed' and (select count(*) from measure_scores ms where ms.company_id=co.id and ms.framework_id=$2)=0)
       )
     order by co.id`,
    [LIST, FW]
  );
  const ids = r.rows.map(x => x.id);
  console.log("TARGET count:", ids.length);
  console.log(ids.join(","));
  fs.writeFileSync("/home/ubuntu/companyiq-v3/target_ids.txt", ids.join(","));
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

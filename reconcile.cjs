const { Client } = require("pg");
const fs = require("fs");
const cs = fs.readFileSync("/tmp/dbu_pub.txt", "utf8").trim();

(async () => {
  const c = new Client({ connectionString: cs, ssl: false });
  await c.connect();
  const LIST = 4;

  const mem = await c.query("select count(*) n from company_list_members where list_id=$1", [LIST]);
  console.log("List 4 (ACWI May 26) members:", mem.rows[0].n);

  const br = await c.query(
    `select coalesce(co.analysis_status,'(null)') status, count(*) n
     from company_list_members m join companies co on co.id=m.company_id
     where m.list_id=$1 group by 1 order by 2 desc`,
    [LIST]
  );
  console.log("\nAnalysis status breakdown (members):");
  let tot = 0;
  br.rows.forEach((r) => { tot += Number(r.n); console.log("   " + String(r.status).padEnd(14), r.n); });
  console.log("   TOTAL:", tot);

  const sc = await c.query(
    "select count(*) n from company_list_members m join companies co on co.id=m.company_id where m.list_id=$1 and co.total_score is not null",
    [LIST]
  );
  console.log("\nMembers with total_score not null:", sc.rows[0].n);

  const ar = await c.query("select id,batch_id,companies_count,average_score,created_at from analysis_results where id=345");
  console.log("\nSnapshot 345:", JSON.stringify(ar.rows[0]));
  const cnt = await c.query("select jsonb_array_length(results_data) n from analysis_results where id=345");
  console.log("results_data array length:", cnt.rows[0].n);

  // Are the snapshot companies a subset of list 4 members? Check names not in list.
  // Pull distinct company names in snapshot
  const snapNames = await c.query(`select distinct (elem->>'companyName') nm from analysis_results, jsonb_array_elements(results_data) elem where id=345`);
  console.log("\nSnapshot distinct companyName count:", snapNames.rows.length);

  // members analyzed (completed) but NOT in snapshot, and snapshot rows not in members
  const memberNames = await c.query(`select co.name nm from company_list_members m join companies co on co.id=m.company_id where m.list_id=$1`, [LIST]);
  const memberSet = new Set(memberNames.rows.map(r => (r.nm||"").trim()));
  const snapSet = new Set(snapNames.rows.map(r => (r.nm||"").trim()));
  const inSnapNotMember = [...snapSet].filter(x => !memberSet.has(x));
  const memberNotSnap = [...memberSet].filter(x => !snapSet.has(x));
  console.log("\nIn snapshot but NOT a list member:", inSnapNotMember.length);
  console.log("List members NOT in snapshot:", memberNotSnap.length);
  console.log("Sample members not in snapshot:", memberNotSnap.slice(0, 25));

  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

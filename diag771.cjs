const { Client } = require('pg');
const https = require('https');
const RW = process.env.RAILWAY_API_KEY;
const PROJECT='db04e5b1-416b-4335-b3bc-056dd81e5bbf', ENV='c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b', APP='66371757-60e9-4da3-bdf1-b3d2ea96544f', PG='539abccb-fd45-4596-9437-392faddd7487';
function gql(q){return new Promise((res,rej)=>{const b=JSON.stringify({query:q});const r=https.request('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+RW,'Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});r.on('error',rej);r.write(b);r.end();});}
async function v(s){return (await gql(`query{variables(projectId:"${PROJECT}",environmentId:"${ENV}",serviceId:"${s}")}`)).data.variables;}
(async()=>{
  const a=await v(APP),p=await v(PG);let u=a.DATABASE_URL;
  if(p.RAILWAY_TCP_PROXY_DOMAIN)u=u.replace(/@[^:]+:\d+\//,`@${p.RAILWAY_TCP_PROXY_DOMAIN}:${p.RAILWAY_TCP_PROXY_PORT}/`);
  const c=new Client({connectionString:u,ssl:false});await c.connect();

  const failed = await c.query(`
    SELECT id, company_id, company_name, status, attempts, last_error, claimed_at, completed_at
    FROM analysis_jobs WHERE batch_id = 771 AND status = 'failed' ORDER BY id`);
  console.log('=== 3 failed jobs (batch 771) ===');
  console.log(JSON.stringify(failed.rows, null, 2));

  const jobAgg = await c.query(`SELECT status, COUNT(*)::int c FROM analysis_jobs WHERE batch_id=771 GROUP BY status ORDER BY status`);
  console.log('\n=== Job status counts ==='); console.log(JSON.stringify(jobAgg.rows));

  const ar = await c.query(`SELECT id, batch_id, list_name, framework_name, companies_count, average_score, created_at FROM analysis_results WHERE batch_id = 771 ORDER BY id`);
  console.log('\n=== analysis_results for batch 771 ==='); console.log(JSON.stringify(ar.rows, null, 2));

  const recent = await c.query(`SELECT id, batch_id, list_name, framework_name, companies_count, average_score, created_at FROM analysis_results ORDER BY id DESC LIMIT 8`);
  console.log('\n=== Recent analysis_results (top 8) ==='); console.log(JSON.stringify(recent.rows, null, 2));

  const pr = await c.query(`SELECT id, status, total_jobs, completed_jobs, failed_jobs, list_id, framework_id FROM batch_runs WHERE status='pending_review' ORDER BY id`);
  console.log('\n=== Batches in pending_review ==='); console.log(JSON.stringify(pr.rows, null, 2));

  await c.end();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});

const https=require('https');const{Client}=require('pg');
const KEY=process.env.RAILWAY_API_KEY;
const P='db04e5b1-416b-4335-b3bc-056dd81e5bbf',ENV='c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b',APP='66371757-60e9-4da3-bdf1-b3d2ea96544f',PG='539abccb-fd45-4596-9437-392faddd7487';
const BATCH=1286;const IDS=[9,10,11,12,13,14,15,16,17,18];
function q(query,v){return new Promise((res,rej)=>{const b=JSON.stringify({query,variables:v});const r=https.request('https://backboard.railway.app/graphql/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY,'Content-Length':Buffer.byteLength(b)}},(rp)=>{let d='';rp.on('data',c=>d+=c);rp.on('end',()=>res(JSON.parse(d)));});r.on('error',rej);r.write(b);r.end();});}
(async()=>{
  const appv=(await q(`query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}`,{p:P,e:ENV,s:APP})).data.variables;
  const pgv=(await q(`query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}`,{p:P,e:ENV,s:PG})).data.variables;
  const dburl=appv.DATABASE_URL.replace(/@[^/]+\//,`@${pgv.RAILWAY_TCP_PROXY_DOMAIN}:${pgv.RAILWAY_TCP_PROXY_PORT}/`);
  const cli=new Client({connectionString:dburl,ssl:false});await cli.connect();
  const b=await cli.query(`select id,status,total_jobs,started_at,completed_at from batch_runs where id=$1`,[BATCH]);
  console.log("BATCH:",JSON.stringify(b.rows[0]));
  const j=await cli.query(`select status,count(*) from analysis_jobs where batch_id=$1 group by status order by status`,[BATCH]);
  console.log("JOBS:",JSON.stringify(j.rows));
  const c=await cli.query(`select id,analysis_status,total_score,measures_met_count,
    (select count(*) from documents d where d.company_id=c.id) docs,
    (select count(*) from measure_scores m where m.company_id=c.id) ms
    from companies c where id=ANY($1::int[]) order by id`,[IDS]);
  console.log("COMPANIES (id:status score met docs ms):");
  for(const r of c.rows) console.log(`  ${r.id}: ${r.analysis_status} ${r.total_score} ${r.measures_met_count} docs=${r.docs} ms=${r.ms}`);
  await cli.end();
})().catch(e=>{console.error("ERR",e.message);process.exit(1);});

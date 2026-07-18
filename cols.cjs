const { Client } = require('pg'); const https = require('https');
const RW = process.env.RAILWAY_API_KEY;
const PROJECT='db04e5b1-416b-4335-b3bc-056dd81e5bbf', ENV='c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b', APP='66371757-60e9-4da3-bdf1-b3d2ea96544f', PG='539abccb-fd45-4596-9437-392faddd7487';
function gql(q){return new Promise((res,rej)=>{const b=JSON.stringify({query:q});const r=https.request('https://backboard.railway.com/graphql/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+RW,'Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});r.on('error',rej);r.write(b);r.end();});}
async function v(s){return (await gql(`query{variables(projectId:"${PROJECT}",environmentId:"${ENV}",serviceId:"${s}")}`)).data.variables;}
(async()=>{const a=await v(APP),p=await v(PG);let u=a.DATABASE_URL;if(p.RAILWAY_TCP_PROXY_DOMAIN)u=u.replace(/@[^:]+:\d+\//,`@${p.RAILWAY_TCP_PROXY_DOMAIN}:${p.RAILWAY_TCP_PROXY_PORT}/`);
const c=new Client({connectionString:u,ssl:false});await c.connect();
for(const t of ['analysis_jobs','analysis_results','batch_runs']){const r=await c.query(`SELECT column_name,data_type FROM information_schema.columns WHERE table_name='${t}' ORDER BY ordinal_position`);console.log('\n==='+t+'===');console.log(r.rows.map(x=>x.column_name).join(', '));}
await c.end();})().catch(e=>{console.error('ERR',e.message);process.exit(1)});

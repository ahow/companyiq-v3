const { Client } = require('pg');
const https = require('https');

const RW = process.env.RAILWAY_API_KEY;
const PROJECT = 'db04e5b1-416b-4335-b3bc-056dd81e5bbf';
const ENV = 'c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b';
const APP_SVC = '66371757-60e9-4da3-bdf1-b3d2ea96544f';
const PG_SVC = '539abccb-fd45-4596-9437-392faddd7487';

function gql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RW, 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d))}catch(e){reject(e)} }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function getVars(svc) {
  const r = await gql(`query{variables(projectId:"${PROJECT}",environmentId:"${ENV}",serviceId:"${svc}")}`);
  return r.data.variables;
}

(async () => {
  const appVars = await getVars(APP_SVC);
  const pgVars = await getVars(PG_SVC);
  let dbUrl = appVars.DATABASE_URL;
  // Build public URL via TCP proxy
  const proxyDomain = pgVars.RAILWAY_TCP_PROXY_DOMAIN;
  const proxyPort = pgVars.RAILWAY_TCP_PROXY_PORT;
  if (proxyDomain && proxyPort) {
    dbUrl = dbUrl.replace(/@[^:]+:\d+\//, `@${proxyDomain}:${proxyPort}/`);
  }
  const c = new Client({ connectionString: dbUrl, ssl: false });
  await c.connect();

  const b = await c.query(`SELECT id, status, total_jobs, completed_jobs, failed_jobs, started_at, completed_at FROM batch_runs WHERE id = 771`);
  console.log('Batch 771:', JSON.stringify(b.rows[0]));

  const j = await c.query(`SELECT status, COUNT(*)::int c FROM analysis_jobs WHERE batch_id = 771 GROUP BY status ORDER BY status`);
  console.log('Jobs 771:', JSON.stringify(j.rows));

  const alerts = await c.query(`SELECT kind, provider, message, active FROM system_alerts WHERE active = TRUE ORDER BY id DESC`);
  console.log('Active alerts:', JSON.stringify(alerts.rows));

  await c.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

const https = require("https");
function gql(query, variables) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.RAILWAY_API_KEY,
        "Content-Length": Buffer.byteLength(body),
      },
    }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { res({ raw: d }); } }); });
    req.on("error", rej); req.write(body); req.end();
  });
}
async function tryq(label, q, v) {
  const r = await gql(q, v || {});
  console.log("\n### " + label);
  if (r.errors) console.log("errors:", JSON.stringify(r.errors.map(e => e.message)).slice(0, 600));
  if (r.data) console.log(JSON.stringify(r.data).slice(0, 800));
  return r;
}
const PROJECT = "db04e5b1-416b-4335-b3bc-056dd81e5bbf";
const ENV = "c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b";
const WORKER = "27920e1f-3835-44be-98ac-2a40a43678cf";
const REPLICAS = parseInt(process.argv[2] || "8", 10);
const POOL = process.argv[3] || "10";
(async () => {
  // 1) Upsert PG_POOL_MAX env var on the worker service
  await tryq("set PG_POOL_MAX=" + POOL, `mutation($input: VariableUpsertInput!){ variableUpsert(input: $input) }`,
    { input: { projectId: PROJECT, environmentId: ENV, serviceId: WORKER, name: "PG_POOL_MAX", value: POOL } });
  // 2) Scale replicas via serviceInstanceUpdate
  await tryq("set numReplicas=" + REPLICAS, `mutation($e:String!,$s:String!,$input: ServiceInstanceUpdateInput!){ serviceInstanceUpdate(environmentId:$e, serviceId:$s, input:$input) }`,
    { e: ENV, s: WORKER, input: { numReplicas: REPLICAS } });
  // 3) Verify
  await tryq("verify serviceInstance", `query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ id numReplicas } }`, { e: ENV, s: WORKER });
})();

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
  if (r.errors) console.log("errors:", JSON.stringify(r.errors.map(e=>e.message)).slice(0, 600));
  if (r.data) console.log(JSON.stringify(r.data, null, 2).slice(0, 1500));
  return r;
}
const WS = "9360e6ed-39a4-4f0a-bd61-dbcd307e5638";
const PROJECT = "db04e5b1-416b-4335-b3bc-056dd81e5bbf";
const ENV = "c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b";
const WORKER = "27920e1f-3835-44be-98ac-2a40a43678cf";
(async () => {
  await tryq("workspace plan", `query($w:String!){ workspace(workspaceId:$w){ id name subscriptionModel subscriptionPlanLimit } }`, { w: WS });
  // serviceInstance correct signature
  await tryq("serviceInstance", `query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ id numReplicas region restartPolicyType } }`, { e: ENV, s: WORKER });
  await tryq("serviceInstance regions", `query($e:String!,$s:String!){ serviceInstance(environmentId:$e, serviceId:$s){ id multiRegionConfig } }`, { e: ENV, s: WORKER });
})();

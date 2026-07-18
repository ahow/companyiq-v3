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
const PROJECT = "db04e5b1-416b-4335-b3bc-056dd81e5bbf";
const ENV = "c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b";
const WORKER = "27920e1f-3835-44be-98ac-2a40a43678cf";
(async () => {
  // Find latest worker deployment
  const d = await gql(`query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status } } } }`,
    { p: PROJECT, e: ENV, s: WORKER });
  const node = d.data.deployments.edges[0].node;
  console.log("latest worker deploy:", node.id, node.status);
  // Redeploy it (restart on same/new image)
  const r = await gql(`mutation($id:String!){ deploymentRedeploy(id:$id){ id status } }`, { id: node.id });
  if (r.errors) console.log("redeploy errors:", JSON.stringify(r.errors.map(e => e.message)).slice(0, 400));
  else console.log("redeploy:", JSON.stringify(r.data));
})();

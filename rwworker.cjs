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
    }, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); });
    req.on("error", rej); req.write(body); req.end();
  });
}
const PROJECT = "db04e5b1-416b-4335-b3bc-056dd81e5bbf",
      ENV = "c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b",
      WORKER = "27920e1f-3835-44be-98ac-2a40a43678cf";
const mode = process.argv[2] || "vars";
(async () => {
  if (mode === "vars") {
    const q = `query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`;
    const r = await gql(q, { p: PROJECT, e: ENV, s: WORKER });
    if (r.errors) { console.log("ERR", JSON.stringify(r.errors).slice(0, 400)); return; }
    const v = r.data.variables || {};
    for (const k of Object.keys(v).sort()) {
      if (/REDIS|DATABASE|SECRET|KEY|PASSWORD|TOKEN|URL/i.test(k)) { console.log(k, "= <redacted>"); continue; }
      console.log(k, "=", String(v[k]).slice(0, 80));
    }
  } else if (mode === "logs") {
    const d = await gql(`query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status } } } }`,
      { p: PROJECT, e: ENV, s: WORKER });
    const node = d.data.deployments.edges[0].node;
    console.log("WORKER DEPLOY", node.id, node.status);
    const r = await gql(`query($id:String!){ deploymentLogs(deploymentId:$id, limit:400){ message timestamp } }`, { id: node.id });
    const logs = (r.data && r.data.deploymentLogs || []);
    for (const l of logs) console.log((l.timestamp || "").slice(11, 19), l.message.slice(0, 200));
  } else if (mode === "instances") {
    const d = await gql(`query($p:String!,$e:String!,$s:String!){ deployments(first:3, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status createdAt } } } }`,
      { p: PROJECT, e: ENV, s: WORKER });
    for (const e of d.data.deployments.edges) console.log(e.node.id, e.node.status, e.node.createdAt);
  }
})();

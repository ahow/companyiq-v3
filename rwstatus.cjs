const https = require("https");
function gql(query, variables) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(
      "https://backboard.railway.app/graphql/v2",
      { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.RAILWAY_API_KEY, "Content-Length": Buffer.byteLength(body) } },
      (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(JSON.parse(d))); }
    );
    req.on("error", rej); req.write(body); req.end();
  });
}

const WS = "9360e6ed-39a4-4f0a-bd61-dbcd307e5638";

(async () => {
  const q = `query($id:String!){
    workspace(workspaceId:$id){
      id name
      projects { edges { node {
        id name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      } } }
    }
  }`;
  const w = await gql(q, { id: WS });
  if (w.errors) { console.log("ERR", JSON.stringify(w.errors)); return; }
  const projects = w.data.workspace.projects.edges.map((e) => e.node);
  for (const p of projects) {
    console.log(`PROJECT ${p.name} ${p.id}`);
    const envs = p.environments.edges.map((e) => e.node);
    const svcs = p.services.edges.map((e) => e.node);
    envs.forEach((e) => console.log(`  ENV  ${e.name} ${e.id}`));
    svcs.forEach((s) => console.log(`  SVC  ${s.name} ${s.id}`));
    // show recent deployments per service for the first env
    const envId = envs[0]?.id;
    for (const s of svcs) {
      const dq = `query($p:String!,$e:String!,$s:String!){ deployments(first:3, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status createdAt } } } }`;
      const d = await gql(dq, { p: p.id, e: envId, s: s.id });
      const eds = d.data?.deployments?.edges || [];
      eds.forEach((x) => console.log(`    DEP[${s.name}] ${x.node.status} ${x.node.createdAt} ${x.node.id}`));
    }
  }
})();

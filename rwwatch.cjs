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
const P = "db04e5b1-416b-4335-b3bc-056dd81e5bbf";
const E = "c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b";
const SVCS = { worker: "27920e1f-3835-44be-98ac-2a40a43678cf", app: "66371757-60e9-4da3-bdf1-b3d2ea96544f" };
(async () => {
  for (const [name, sid] of Object.entries(SVCS)) {
    const dq = `query($p:String!,$e:String!,$s:String!){ deployments(first:4, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status createdAt meta } } } }`;
    const d = await gql(dq, { p: P, e: E, s: sid });
    const eds = d.data?.deployments?.edges || [];
    for (const x of eds) {
      const m = x.node.meta || {};
      const sha = (m.commitHash || m.commitSha || "").slice(0, 7);
      const msg = (m.commitMessage || "").split("\n")[0].slice(0, 50);
      console.log(`${name.padEnd(7)} ${x.node.status.padEnd(10)} ${x.node.createdAt} ${sha} ${msg}`);
    }
    console.log("");
  }
})();

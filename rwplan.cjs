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
  if (r.errors) console.log("errors:", JSON.stringify(r.errors).slice(0, 400));
  if (r.data) console.log(JSON.stringify(r.data, null, 2).slice(0, 1200));
  if (r.raw) console.log("raw:", r.raw.slice(0, 300));
  return r;
}
(async () => {
  await tryq("me.email", `query { me { id email } }`);
  await tryq("me.workspaces.plan", `query { me { workspaces { id name } } }`);
  // workspace via project
  await tryq("project.team.plan", `query($id:String!){ project(id:$id){ id name team { id name } } }`, { id: "db04e5b1-416b-4335-b3bc-056dd81e5bbf" });
})();

const https = require("https");
function gql(query, variables){
  return new Promise((res,rej)=>{
    const body = JSON.stringify({query, variables});
    const req = https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});
    req.on("error",rej); req.write(body); req.end();
  });
}
(async()=>{
  const proj = await gql(`{ projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }`);
  const node = proj.data.projects.edges[0].node;
  const projectId = node.id;
  const envId = node.environments.edges[0].node.id;
  const worker = node.services.edges.find(e=>e.node.name==="worker").node;
  console.log("project", node.name, projectId, "env", envId, "worker", worker.id);
  const deps = await gql(`query($p:String!,$e:String!,$s:String!){ deployments(first:5, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status createdAt meta } } } }`, {p:projectId,e:envId,s:worker.id});
  console.log(JSON.stringify(deps, null, 2).slice(0, 2500));
  // If REDEPLOY=1, restart the latest deployment
  if (process.env.REDEPLOY === "1") {
    const latest = deps.data.deployments.edges[0].node.id;
    const r = await gql(`mutation($id:String!){ deploymentRedeploy(id:$id){ id status } }`, {id: latest});
    console.log("REDEPLOY RESULT:", JSON.stringify(r));
  }
})();

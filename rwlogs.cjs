const https=require("https");
function gql(query,variables){return new Promise((res,rej)=>{const body=JSON.stringify({query,variables});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
const DEP="27920e1f-3835-44be-98ac-2a40a43678cf";
(async()=>{
  // get latest worker deployment id
  const d=await gql(`query($p:String!,$e:String!,$s:String!){ deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id } } } }`,{p:"db04e5b1-416b-4335-b3bc-056dd81e5bbf",e:"c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b",s:DEP});
  const id=d.data.deployments.edges[0].node.id;
  const r=await gql(`query($id:String!){ deploymentLogs(deploymentId:$id, limit:600){ message } }`,{id});
  const logs=(r.data&&r.data.deploymentLogs||[]).map(x=>x.message);
  for(const l of logs){ if(/WAF|prime|Akamai|_abck|tesla|Tesla|TransientFetch|cninfo|360/.test(l)) console.log(l.slice(0,200)); }
})();

const https=require("https");
function gql(query,variables){return new Promise((res,rej)=>{const body=JSON.stringify({query,variables});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
const PROJECT="db04e5b1-416b-4335-b3bc-056dd81e5bbf", ENV="c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b";
const services={worker:"27920e1f-3835-44be-98ac-2a40a43678cf",app:"66371757-60e9-4da3-bdf1-b3d2ea96544f"};
const q=`query($p:String!,$e:String!,$s:String!){ deployments(first:3, input:{projectId:$p, environmentId:$e, serviceId:$s}){ edges { node { id status createdAt meta } } } }`;
(async()=>{
  for(const [name,s] of Object.entries(services)){
    const r=await gql(q,{p:PROJECT,e:ENV,s});
    const edges=r.data&&r.data.deployments&&r.data.deployments.edges||[];
    console.log("\n=== "+name+" ===", r.errors?JSON.stringify(r.errors).slice(0,300):"");
    for(const e of edges){ const n=e.node; const sha=(n.meta&&(n.meta.commitHash||n.meta.commitSha))||""; console.log(n.status, n.createdAt, String(sha).slice(0,9), (n.meta&&n.meta.commitMessage||"").split("\n")[0].slice(0,60)); }
  }
})();

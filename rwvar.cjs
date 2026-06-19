const https=require("https");
function gql(query,variables){return new Promise((res,rej)=>{const body=JSON.stringify({query,variables});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
const PROJECT="db04e5b1-416b-4335-b3bc-056dd81e5bbf", ENV="c1166ef6-9f48-4397-9f16-3cd7ff0d6f3b", WORKER="27920e1f-3835-44be-98ac-2a40a43678cf";
(async()=>{
  const q=`query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }`;
  const r=await gql(q,{p:PROJECT,e:ENV,s:WORKER});
  if(r.errors){console.log("ERR",JSON.stringify(r.errors).slice(0,300));return;}
  const v=r.data.variables||{};
  for(const k of Object.keys(v)){ if(/REDIS|DATABASE/.test(k)) console.log(k,"=",String(v[k]).replace(/:[^:@/]+@/,":***@")); }
})();

const https=require("https");
function gql(query){return new Promise((res,rej)=>{const body=JSON.stringify({query});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
(async()=>{
  const q = `{ workspace(workspaceId:"9360e6ed-39a4-4f0a-bd61-dbcd307e5638"){ projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } } }`;
  console.log(JSON.stringify(await gql(q)));
})();

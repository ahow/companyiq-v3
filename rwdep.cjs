const https=require("https");
function gql(query,variables){return new Promise((res,rej)=>{const body=JSON.stringify({query,variables});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
(async()=>{
  // me query to understand token scope
  const me = await gql(`{ me { id email teams { edges { node { id name } } } } }`);
  console.log("ME", JSON.stringify(me).slice(0,600));
})();

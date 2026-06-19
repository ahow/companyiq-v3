const https=require("https");
function gql(query){return new Promise((res,rej)=>{const body=JSON.stringify({query});const req=https.request("https://backboard.railway.app/graphql/v2",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.RAILWAY_API_KEY,"Content-Length":Buffer.byteLength(body)}},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>res(JSON.parse(d)));});req.on("error",rej);req.write(body);req.end();});}
(async()=>{
  console.log("ME", JSON.stringify(await gql(`{ me { id name email } }`)).slice(0,300));
  console.log("WORKSPACES", JSON.stringify(await gql(`{ me { workspaces { id name } } }`)).slice(0,500));
})();

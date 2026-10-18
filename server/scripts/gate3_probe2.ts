import pg from "pg";
import { isPositiveVerdict } from "../lib/eligibility-flags.js";
const norm=(s:string)=>s.normalize("NFKC").replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4\u0060]/g,"'").replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g,'"').replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g,"-").replace(/\u2026/g,"...").replace(/[\u2022\u2023\u25E6\u2043\u00B7\u2219\u25CF\u25CB\u25AA]/g," ").replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g," ").replace(/\s+/g," ").trim().toLowerCase();
// anchor-based: split normalized quote into W-char windows at stride S; a doc "matches"
// if it contains >=1 window; assign quote to doc with most window hits.
function anchorHits(nq:string, nc:string, W=48, S=32):number{
  if(nq.length<=W) return nc.includes(nq)?1:0;
  let hits=0;
  for(let i=0;i+W<=nq.length;i+=S){ if(nc.includes(nq.slice(i,i+W))) hits++; }
  return hits;
}
(async()=>{
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:false,max:3});
  const batchId=1287; const companyIds=Array.from({length:10},(_,i)=>9+i);
  const snap=await pool.query(`SELECT results_data FROM analysis_results WHERE batch_id=$1 ORDER BY id DESC LIMIT 1`,[batchId]);
  const data=typeof snap.rows[0].results_data==="string"?JSON.parse(snap.rows[0].results_data):snap.rows[0].results_data;
  let total=0,rec=0,unrec=0,cells=0,cellsAll=0; const samples:string[]=[];
  for(const co of data){ const cid=Number(co.companyId); if(!companyIds.includes(cid))continue;
    const docs=await pool.query(`SELECT d.url url,dc.content content FROM batch_corpus bc JOIN documents d ON d.id=bc.document_id LEFT JOIN document_content dc ON dc.id=d.content_id WHERE bc.batch_id=$1 AND bc.company_id=$2`,[batchId,cid]);
    const corpus=docs.rows.map((r:any)=>({url:r.url,nc:norm(r.content||"")}));
    const measures=co.measureScores??co.measures??[];
    for(const m of measures){ if(!isPositiveVerdict(String(m.verdict??"")))continue;
      const quotes=(Array.isArray(m.quotes)?m.quotes:[]).filter((q:any)=>!String(q?.sourceUrl??"").startsWith("diag://"));
      if(!quotes.length)continue; cells++; let cres=0;
      for(const q of quotes){ const t=String(q?.text??""); if(!t.trim()){unrec++;continue;} total++;
        const nq=norm(t);
        let best=null,bestH=0;
        for(const c of corpus){ const h=anchorHits(nq,c.nc); if(h>bestH){bestH=h;best=c;} }
        if(best&&best.url&&bestH>0){rec++;cres++;}
        else{unrec++; if(samples.length<10)samples.push(`[co${cid} ${m.measureId}] ${t.slice(0,80)}`);}
      }
      if(cres===quotes.length)cellsAll++;
    }
  }
  console.log(JSON.stringify({total,rec,unrec,recoveryRate:((rec/total)*100).toFixed(2)+"%",cells,cellsAll,cellsAllPct:((cellsAll/cells)*100).toFixed(1)+"%"},null,2));
  for(const s of samples)console.log(" -",s);
  await pool.end();
})().catch(e=>{console.error(e);process.exit(1);});

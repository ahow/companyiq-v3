import pg from "pg";
import { chunkDocuments } from "../lib/passage-retrieval.js";

const DB = process.env.DATABASE_URL!;
const client = new pg.Client({ connectionString: DB, ssl: false });

const looksToc = (txt: string) => /\.{4,}\s*\d+\b/.test(txt) || (txt.match(/item\s+\d+[a-z]?\b/gi) || []).length >= 4;
const isItem1aBody = (c: any) => c.section === "item1a" && !looksToc(c.text) && c.text.length > 240;
const isAnnualFiling = (u: string, t: string) => {
  const s = `${u} ${t}`.toLowerCase();
  return /sec\.gov\/archives\/edgar/.test((u||"").toLowerCase()) || /\b(10-?k|20-?f|40-?f)\b/.test(s) || /-\d{8}\.htm/.test((u||"").toLowerCase());
};
const isEdgarPrimary = (u: string) => { const s=(u||"").toLowerCase(); return /sec\.gov\/archives\/edgar\/data\/\d+\//.test(s) && /\.htm/.test(s) && !/index\.htm/.test(s); };
const validYmd = (v: number): boolean => { if (v<19900101||v>20401231) return false; const mo=Math.floor((v%10000)/100), da=v%100; return mo>=1&&mo<=12&&da>=1&&da<=31; };
const dateOf = (s: string) => { const hay=(s||"").toLowerCase(); let b=0; for (const m of hay.matchAll(/[a-z]+-?(20\d{6})\.(?:htm|pdf)/g)){const v=parseInt(m[1],10);if(validYmd(v)&&v>b)b=v;} if(b===0)for(const m of hay.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)){const v=parseInt(m[1]+m[2]+m[3],10);if(validYmd(v)&&v>b)b=v;} if(b===0)for(const m of hay.matchAll(/(20\d{6})/g)){const v=parseInt(m[1],10);if(validYmd(v)&&v>b)b=v;} if(b===0)for(const m of hay.matchAll(/\b(20[12]\d)\b/g)){const v=parseInt(m[1]+"0000",10);if(v>b)b=v;} return b; };
const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|proxy card|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;

(async () => {
  await client.connect();
  const { rows } = await client.query(
    `SELECT d.id, d.content_id, d.url, COALESCE(d.title,'') AS title, dc.content
     FROM documents d JOIN document_content dc ON dc.id=d.content_id
     WHERE d.company_id=1312 AND d.fetch_status='ok' AND d.gate_verdict='accept'
     ORDER BY d.id`);
  let combined = "";
  for (const r of rows) combined += `\n\n--- DOCUMENT: ${r.title || "doc"} [${r.url}] ---\n\n` + (r.content || "");
  const docChunks = chunkDocuments(combined);
  console.log(`NVIDIA combined=${combined.length} chunks=${docChunks.length}`);
  const byDoc = new Map<number, { idxs: number[]; url: string; title: string }>();
  docChunks.forEach((c: any, i: number) => {
    if (!isItem1aBody(c)) return;
    if (!isAnnualFiling(c.docUrl || "", c.docTitle || "")) return;
    const e = byDoc.get(c.docIndex) || { idxs: [], url: c.docUrl || "", title: c.docTitle || "" };
    e.idxs.push(i); byDoc.set(c.docIndex, e);
  });
  const cands = [...byDoc.entries()].map(([di, e]) => {
    let proxyHits = 0; for (const ix of e.idxs) proxyHits += (docChunks[ix].text.match(strongProxyRe) || []).length;
    return { di, n: e.idxs.length, url: e.url, rec: dateOf(e.url + " " + e.title), edgar: isEdgarPrimary(e.url), proxyHits, proxyDom: proxyHits >= 10 };
  });
  const ord = (v: number): number => { if (v<=0) return 0; const y=Math.floor(v/10000), mo=Math.floor((v%10000)/100)||1, da=(v%100)||1; return y*365+mo*30+da; };
  cands.sort((a, b) => { const sp = Math.abs(ord(a.rec)-ord(b.rec))<=150; if(!sp) return b.rec-a.rec; if(a.edgar!==b.edgar) return a.edgar?-1:1; if(a.rec!==b.rec) return b.rec-a.rec; if(a.n!==b.n) return b.n-a.n; return a.di-b.di; });
  console.log("\n=== NVIDIA annual-filing item1a-body candidates (upstream sort, pre-proxy-filter) ===");
  for (const c of cands) console.log(`rec=${c.rec} edgar=${c.edgar} proxyDom=${c.proxyDom}(${c.proxyHits}) bodyChunks=${c.n} url=...${c.url.slice(-44)}`);
  const kept = cands.filter((c) => !c.proxyDom);
  console.log(`\nBEST (non-proxy) -> ${kept.length ? `rec=${kept[0].rec} url=...${kept[0].url.slice(-44)}` : "(none)"}`);
  await client.end();
})();

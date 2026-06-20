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
  // Pull Apple's accepted+ok docs in priority-ish order (regulatory first), build combined like analyzer.
  const { rows } = await client.query(
    `SELECT d.id, d.content_id, d.url, COALESCE(d.title,'') AS title, length(dc.content) AS chars, dc.content
     FROM documents d JOIN document_content dc ON dc.id=d.content_id
     WHERE d.company_id=866 AND d.fetch_status='ok' AND d.gate_verdict='accept'
     ORDER BY d.id`);
  let combined = "";
  for (const r of rows) {
    combined += `\n\n--- DOCUMENT: ${r.title || "doc"} [${r.url}] ---\n\n` + (r.content || "");
  }
  console.log(`Apple combined chars=${combined.length} across ${rows.length} docs`);
  const docChunks = chunkDocuments(combined);
  console.log(`chunked into ${docChunks.length} chunks`);
  // Group genuine item1a body chunks by doc, among annual filings.
  const byDoc = new Map<number, { idxs: number[]; url: string; title: string }>();
  docChunks.forEach((c: any, i: number) => {
    if (!isItem1aBody(c)) return;
    if (!isAnnualFiling(c.docUrl || "", c.docTitle || "")) return;
    const e = byDoc.get(c.docIndex) || { idxs: [], url: c.docUrl || "", title: c.docTitle || "" };
    e.idxs.push(i); byDoc.set(c.docIndex, e);
  });
  const cands = [...byDoc.entries()].map(([di, e]) => {
    let proxyHits = 0; for (const ix of e.idxs) proxyHits += (docChunks[ix].text.match(strongProxyRe) || []).length;
    return { di, n: e.idxs.length, url: e.url, rec: dateOf(e.url + " " + e.title), edgar: isEdgarPrimary(e.url), proxyDom: proxyHits >= 10, proxyHits };
  });
  cands.sort((a, b) => (b.rec - a.rec) || ((a.edgar?0:1)-(b.edgar?0:1)) || (b.n - a.n) || (a.di - b.di));
  console.log("\n=== annual-filing item1a-body candidates (sorted as upstream) ===");
  for (const c of cands.slice(0, 12)) {
    console.log(`rec=${c.rec} edgar=${c.edgar} proxyDom=${c.proxyDom}(${c.proxyHits}) bodyChunks=${c.n} url=...${c.url.slice(-46)}`);
  }
  const kept = cands.filter((c) => !c.proxyDom);
  console.log(`\nBEST (non-proxy) -> ${kept.length ? `rec=${kept[0].rec} url=...${kept[0].url.slice(-46)}` : "(none)"}`);
  await client.end();
})();

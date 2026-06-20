import pg from "pg";
import fs from "fs";
import { chunkDocuments, buildBM25Index, bm25Score } from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

type DocClass = "regulatory" | "proxy" | "ai-governance" | "sustainability" | "other";
const classifyDoc = (url: string, title: string): DocClass => {
  const u = (url || "").toLowerCase();
  const t = (title || "").toLowerCase();
  if (/sec\.gov\/archives\/edgar/.test(u) || /\b(10-?k|20-?f|40-?f)\b/.test(u + " " + t) || /-\d{8}\.htm/.test(u)) return "regulatory";
  if (/proxy|def.?14a/.test(u + " " + t)) return "proxy";
  if (/(responsible|trustworthy)[-_ ]?ai|ai[-_ ]?(governance|principles|ethics|policy|safety|framework)|\bai-governance\b/.test(u + " " + t)) return "ai-governance";
  if (/environment|sustainab|esg|csr|climate|carbon/.test(u + " " + t)) return "sustainability";
  return "other";
};
const CLASS_BOOST: Record<DocClass, number> = { regulatory: 100000, proxy: 90000, "ai-governance": 80000, other: 1000, sustainability: 500 };
const CAP_BY_CLASS: Record<DocClass, number> = { regulatory: 480000, proxy: 360000, "ai-governance": 160000, other: 120000, sustainability: 90000 };

const validYmd = (v: number): boolean => { if (v < 19900101 || v > 20401231) return false; const mo = Math.floor((v % 10000) / 100), da = v % 100; return mo >= 1 && mo <= 12 && da >= 1 && da <= 31; };
const dateOf = (s: string) => {
  const hay = (s || "").toLowerCase(); let best = 0;
  for (const m of hay.matchAll(/[a-z]+-?(20\d{6})\.(?:htm|pdf)/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
  if (best === 0) for (const m of hay.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)) { const v = parseInt(m[1] + m[2] + m[3], 10); if (validYmd(v) && v > best) best = v; }
  if (best === 0) for (const m of hay.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
  if (best === 0) for (const m of hay.matchAll(/\b(20[12]\d)\b/g)) { const v = parseInt(m[1] + "0000", 10); if (v > best) best = v; }
  return best;
};
const looksToc = (txt: string) => /\.{4,}\s*\d+\b/.test(txt) || (txt.match(/item\s+\d+[a-z]?\b/gi) || []).length >= 4;

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  const docs = JSON.parse(fs.readFileSync("/tmp/oracle_docs.json", "utf8")) as Array<{cid:number;url:string;title:string}>;

  // Load all content, build docEntries
  const documentTexts: string[] = [], documentUrls: string[] = [], documentTitles: string[] = [];
  for (const d of docs) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [d.cid]);
    if (!rows.length || !rows[0].content) continue;
    documentTexts.push(rows[0].content);
    documentUrls.push(d.url);
    documentTitles.push(d.title || d.url);
  }
  await client.end();

  const topicKeywords = ["ai","artificial","intelligence","risk","governance"];
  const aiKeywords = ["ai","artificial","intelligence","ethics","responsible","governance","transparency","accountability","risk","bias","fairness","privacy","workforce","training","security","algorithm","machine","learning","automated","decision","oversight","committee","policy","framework"];
  const allQueryTerms = [...new Set([...topicKeywords, ...aiKeywords])];

  const docEntries = documentTexts.map((text, idx) => {
    const lower = text.toLowerCase(); let density = 0;
    for (const term of allQueryTerms) { const m = lower.match(new RegExp(`\\b${term}\\b`, "gi")); density += Math.min(m?.length || 0, 10); }
    const url = documentUrls[idx] || ""; const title = documentTitles[idx] || ""; const cls = classifyDoc(url, title);
    const score = CLASS_BOOST[cls] + Math.min(density, 800) + (/ai|ethics|responsible|governance|policy/i.test(url) ? 200 : 0);
    return { text, url, score, idx, cls };
  });
  docEntries.sort((a, b) => b.score - a.score);

  let combined = "";
  for (const entry of docEntries) {
    const cap = CAP_BY_CLASS[entry.cls];
    const docTitle = documentTitles[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
  }
  console.log("combined length:", combined.length, "(>=600000 triggers BM25/reserve path:", combined.length >= 600000, ")");

  const docChunks = chunkDocuments(combined);
  console.log("total chunks:", docChunks.length);

  // Replicate item1a-reserve candidate selection
  const isEdgarPrimary = (u: string) => /sec\.gov\/archives\/edgar\/data\/\d+\//.test((u||"").toLowerCase()) && /\.htm/.test((u||"").toLowerCase());
  const isAnnualFiling = (u: string, t: string) => { const s = ((u||"") + " " + (t||"")).toLowerCase(); return /sec\.gov\/archives\/edgar/.test((u||"").toLowerCase()) || /\b(10-?k|20-?f|40-?f)\b/.test(s) || /-\d{8}\.htm/.test((u||"").toLowerCase()); };
  const isItem1aBody = (c: any) => c.section === "item1a" && !looksToc(c.text) && c.text.length > 240;
  const byDoc = new Map<number, { idxs: number[]; url: string; title: string }>();
  docChunks.forEach((c, i) => {
    if (!isItem1aBody(c)) return;
    if (!isAnnualFiling(c.docUrl || "", c.docTitle || "")) return;
    const e = byDoc.get(c.docIndex) || { idxs: [], url: c.docUrl || "", title: c.docTitle || "" };
    e.idxs.push(i); byDoc.set(c.docIndex, e);
  });
  console.log("\n=== item1a-body candidate docs ===");
  const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|proxy card|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
  const quarterlyRe = /quarterly report pursuant to section 13|for the quarterly period ended|\bform 10-q\b/gi;
  const annualRe = /annual report pursuant to section 13|for the fiscal year ended|\bform 10-k\b/gi;
  const strongQuarterlyCoverRe = /form 10-q[\s\S]{0,400}quarterly report pursuant to section 13|quarterly report pursuant to section 13[\s\S]{0,400}form 10-q/i;
  const strongAnnualCoverRe = /form 10-k[\s\S]{0,400}annual report pursuant to section 13|annual report pursuant to section 13[\s\S]{0,400}form 10-k/i;
  const allChunkIdxByDoc = new Map<number, number[]>();
  docChunks.forEach((c, i) => { const a = allChunkIdxByDoc.get(c.docIndex) || []; a.push(i); allChunkIdxByDoc.set(c.docIndex, a); });
  const isQuarterlyDoc = (di: number): boolean => { const joined=(allChunkIdxByDoc.get(di)||[]).map((ix)=>docChunks[ix].text).join("\n"); if(strongQuarterlyCoverRe.test(joined))return true; if(strongAnnualCoverRe.test(joined))return false; const q=(joined.match(quarterlyRe)||[]).length, a=(joined.match(annualRe)||[]).length; return q>0 && q>=a; };
  type C = { di:number; idxs:number[]; url:string; rec:number; edgar:boolean; proxyDom:boolean; quarterly:boolean };
  const cands: C[] = [];
  for (const [di, e] of byDoc) {
    let proxyHits = 0; for (const ix of e.idxs) proxyHits += (docChunks[ix].text.match(strongProxyRe) || []).length;
    const c = { di, idxs: e.idxs, url: e.url, rec: dateOf(e.url+" "+e.title), edgar: isEdgarPrimary(e.url), proxyDom: proxyHits>=10, quarterly: isQuarterlyDoc(di) };
    console.log(`  di=${di} body=${e.idxs.length} date=${c.rec} edgar=${c.edgar} proxyDom=${c.proxyDom} quarterly=${c.quarterly} url=${e.url.slice(0,80)}`);
    cands.push(c);
  }
  const filtered = cands.filter((c) => !c.proxyDom && !c.quarterly);
  const ord = (v:number)=>{ if(v<=0)return 0; const y=Math.floor(v/10000),mo=Math.floor((v%10000)/100)||1,da=(v%100)||1; return y*365+mo*30+da; };
  const SAME=150;
  filtered.sort((a,b)=>{ const ad=a.rec===0,bd=b.rec===0; if(ad!==bd)return ad?1:-1; const sp=Math.abs(ord(a.rec)-ord(b.rec))<=SAME||ad; if(!sp)return b.rec-a.rec; if(a.edgar!==b.edgar)return a.edgar?-1:1; if(a.rec!==b.rec)return b.rec-a.rec; if(a.idxs.length!==b.idxs.length)return b.idxs.length-a.idxs.length; return a.di-b.di; });
  console.log(`\n=== RESERVE WINNER: ${filtered.length ? filtered[0].url : "(none)"} ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });

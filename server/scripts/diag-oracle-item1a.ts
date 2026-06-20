import pg from "pg";
import { chunkDocuments } from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

const DOCS = [
  { cid: 205686, url: "https://www.sec.gov/Archives/edgar/data/1341439/000095017025087926/orcl-20250531.htm" },
  { cid: 235143, url: "https://www.sec.gov/Archives/edgar/data/1341439/000119312525200095/orcl-20250831.htm" },
  { cid: 110896, url: "https://stocklight.com/stocks/us/nyse-orcl/oracle-corporation/annual-reports/nyse-orcl-2024-10K-241056542.pdf" },
  { cid: 41019,  url: "https://stocklight.com/stocks/us/nyse-orcl/oracle-corporation/annual-reports/nyse-orcl-2025-10K-251057371.pdf" },
];

// replicate analyzer dateOf
const validYmd = (v: number): boolean => {
  if (v < 19900101 || v > 20401231) return false;
  const mo = Math.floor((v % 10000) / 100), da = v % 100;
  return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
};
const dateOf = (s: string) => {
  const hay = (s || "").toLowerCase();
  let best = 0;
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
  let combined = "";
  for (const d of DOCS) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [d.cid]);
    if (!rows.length) { console.log("MISSING", d.cid); continue; }
    combined += `\n\n--- DOCUMENT: 10-K [${d.url}] ---\n\n` + (rows[0].content || "");
  }
  const chunks = chunkDocuments(combined);
  // group by docUrl
  const byUrl = new Map<string, { total: number; item1a: number; item1aBody: number; titleSample: string }>();
  for (const c of chunks) {
    const u = c.docUrl || "(none)";
    const e = byUrl.get(u) || { total: 0, item1a: 0, item1aBody: 0, titleSample: c.docTitle || "" };
    e.total++;
    if (c.section === "item1a") {
      e.item1a++;
      if (!looksToc(c.text) && c.text.length > 240) e.item1aBody++;
    }
    byUrl.set(u, e);
  }
  console.log("\n=== Oracle per-doc chunk diagnostics ===");
  for (const [u, e] of byUrl) {
    console.log(`\nURL: ${u}`);
    console.log(`  dateOf(url+title) = ${dateOf(u + " " + e.titleSample)}`);
    console.log(`  total chunks=${e.total}  item1a-tagged=${e.item1a}  item1aBody(genuine)=${e.item1aBody}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

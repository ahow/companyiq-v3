import pg from "pg";
import { chunkDocuments } from "../lib/passage-retrieval.js";

const DB = process.env.DATABASE_URL!;
const client = new pg.Client({ connectionString: DB, ssl: false });

// Replicate the upstream detectors for offline analysis
const looksToc = (txt: string) => /\.{4,}\s*\d+\b/.test(txt) || (txt.match(/item\s+\d+[a-z]?\b/gi) || []).length >= 4;
const isItem1aBody = (c: any) => c.section === "item1a" && !looksToc(c.text) && c.text.length > 240;
const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|proxy card|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;

async function analyze(label: string, contentId: number, url: string, title: string) {
  const r = await client.query("SELECT content FROM document_content WHERE id=$1", [contentId]);
  const content: string = r.rows[0]?.content || "";
  const header = `\n\n--- DOCUMENT: ${title} [${url}] ---\n\n`;
  const chunks = chunkDocuments(header + content);
  const item1aAll = chunks.filter((c: any) => c.section === "item1a");
  const item1aBody = chunks.filter(isItem1aBody);
  // AI mentions inside item1a body
  let aiInBody = 0;
  for (const c of item1aBody) aiInBody += (c.text.match(/artificial intelligence|machine learning|\bA\.?I\.?\b|generative ai/gi) || []).length;
  // proxy density across all chunks of this doc
  let proxyHits = 0;
  for (const c of chunks) proxyHits += (c.text.match(strongProxyRe) || []).length;
  // raw item1a region AI check
  const lower = content.toLowerCase();
  const i1aPos = lower.indexOf("item 1a");
  const i1bPos = lower.indexOf("item 1b", i1aPos + 10);
  const region = i1aPos >= 0 ? content.slice(i1aPos, i1bPos > i1aPos ? i1bPos : i1aPos + 120000) : "";
  const aiInRegion = (region.match(/artificial intelligence|machine learning|generative ai/gi) || []).length;
  console.log(`\n===== ${label} (content ${contentId}) =====`);
  console.log(`url=${url}`);
  console.log(`chunks=${chunks.length} | item1a-tagged=${item1aAll.length} | item1a-BODY=${item1aBody.length}`);
  console.log(`AI mentions in item1a BODY chunks=${aiInBody}`);
  console.log(`AI mentions in raw Item 1A..1B region (${region.length} chars)=${aiInRegion}`);
  console.log(`strong-proxy hits across doc=${proxyHits} (proxyDom>=10? ${proxyHits >= 10})`);
  if (item1aBody.length > 0) console.log(`first body excerpt: ${item1aBody[0].text.slice(0, 160).replace(/\s+/g, " ")}`);
}

(async () => {
  await client.connect();
  // NVIDIA real 10-K vs proxy
  await analyze("NVIDIA real 10-K nvda-20260125", 207831, "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm", "nvda-20260125 - SEC.gov");
  await analyze("NVIDIA proxy nvda-20260512", 207834, "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000036/nvda-20260512.htm", "nvda-20260512 - SEC.gov");
  // Apple real 10-K
  await analyze("Apple real 10-K aapl-20250927", 197105, "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm", "aapl-20250927 - SEC.gov");
  await client.end();
})();

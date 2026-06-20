/**
 * Diagnostic using the REAL exported helpers to count genuine Item 1A body chunks
 * per NVIDIA document, so we can see whether the per-chunk proxy guard is enough
 * or a document-level proxy classifier is needed.
 */
import pg from "pg";
import { chunkDocuments, __testHooks } from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";
const CONTENT_IDS = [207834, 207831, 145440, 123581];

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  let combined = "";
  for (const cid of CONTENT_IDS) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
    if (!rows.length) continue;
    const drow = await client.query("SELECT url FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
    const url = drow.rows[0]?.url || `doc-${cid}`;
    combined += `\n\n--- DOCUMENT: 10-K [${url}] ---\n\n` + (rows[0].content || "");
  }
  const chunks = chunkDocuments(combined);
  const byUrl = new Map<string, { total: number; item1a: number; genuineBody: number }>();
  for (const ch of chunks) {
    const u = ch.docUrl || "(none)";
    const r = byUrl.get(u) || { total: 0, item1a: 0, genuineBody: 0 };
    r.total++;
    if (ch.section === "item1a") r.item1a++;
    if (__testHooks.isItem1aBodyChunk(ch)) r.genuineBody++;
    byUrl.set(u, r);
  }
  const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|board of directors recommends|proxy card|voting (instructions|your shares)|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
  const strong10kRe = /item\s*1a|item\s*7\.|management's discussion and analysis|consolidated (balance sheet|statements of operations)|item\s*8\./gi;
  const proxyByUrl = new Map<string, number>();
  const k10ByUrl = new Map<string, number>();
  for (const ch of chunks) {
    const u = ch.docUrl || "(none)";
    proxyByUrl.set(u, (proxyByUrl.get(u) || 0) + (ch.text.match(strongProxyRe) || []).length);
    k10ByUrl.set(u, (k10ByUrl.get(u) || 0) + (ch.text.match(strong10kRe) || []).length);
  }
  const dateOf = (u: string) => { let b = 0; for (const m of u.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1],10); if (v>b) b=v; } return b; };
  const isEdgar = (u: string) => /sec\.gov\/archives\/edgar\/data\/\d+\//.test(u) && /\.htm/.test(u);
  console.log("doc | recency | edgar | total | item1a | genuineBody | proxyHits | k10Hits | proxyDom");
  for (const [u, r] of byUrl) {
    const p = proxyByUrl.get(u) || 0; const k = k10ByUrl.get(u) || 0;
    const dom = p >= 10 && p > k * 2;
    console.log(`${u.split("/").pop()} | ${dateOf(u)} | ${isEdgar(u)} | ${r.total} | ${r.item1a} | ${r.genuineBody} | ${p} | ${k} | ${dom}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

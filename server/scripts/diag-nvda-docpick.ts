/**
 * Diagnostic: for NVIDIA, show per-document genuine-Item-1A-body chunk counts and
 * the recency token, to confirm which doc the recency-aware selector picks and that
 * the proxy-style nvda-20260512 does NOT beat the real 10-K on body-chunk grounds.
 */
import pg from "pg";
import { chunkDocuments } from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";
const CONTENT_IDS = [207834, 207831, 145440, 123581];

function isLikelyToc(text: string): boolean {
  const dotted = (text.match(/\.{3,}\s*\d+/g) || []).length;
  const itemRefs = (text.match(/item\s+\d+[a-z]?\b/gi) || []).length;
  return dotted >= 2 || itemRefs >= 4;
}

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  let combined = "";
  const urlByCid: Record<number, string> = {};
  for (const cid of CONTENT_IDS) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
    if (!rows.length) continue;
    const drow = await client.query("SELECT url FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
    const url = drow.rows[0]?.url || `doc-${cid}`;
    urlByCid[cid] = url;
    combined += `\n\n--- DOCUMENT: 10-K [${url}] ---\n\n` + (rows[0].content || "");
  }
  const chunks = chunkDocuments(combined);
  // group by docUrl
  const byUrl = new Map<string, { total: number; item1a: number; body: number }>();
  for (const ch of chunks) {
    const u = ch.docUrl || "(none)";
    const rec = byUrl.get(u) || { total: 0, item1a: 0, body: 0 };
    rec.total++;
    if (ch.section === "item1a") {
      rec.item1a++;
      const t = ch.text || "";
      const crossRef = /see\s+(item\s+1a|"?item\s+1a|risk factors)/i.test(t) && t.length < 400;
      if (t.length >= 200 && !isLikelyToc(t) && !crossRef) rec.body++;
    }
    byUrl.set(u, rec);
  }
  const dateOf = (u: string) => { let b = 0; for (const m of u.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1],10); if (v>b) b=v; } return b; };
  console.log("doc | recency | total | item1a | genuineBody");
  for (const [u, r] of byUrl) {
    console.log(`${u.split("/").pop()} | ${dateOf(u)} | ${r.total} | ${r.item1a} | ${r.body}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

import pg from "pg";
import { chunkDocuments, buildBM25Index, bm25Score, tokenize } from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

// content_id values to inspect: pass as argv (one or more)
const contentIds = process.argv.slice(2).map((s) => parseInt(s, 10));

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();

  for (const cid of contentIds) {
    const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
    if (!rows.length) {
      console.log(`content_id ${cid}: NOT FOUND`);
      continue;
    }
    const content: string = rows[0].content || "";
    // get url/title from documents
    const drow = await client.query("SELECT url FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
    const url = drow.rows[0]?.url || "";
    // Build a combinedText fragment exactly as analyzer does (with header)
    const combined = `\n\n--- DOCUMENT: 10-K [${url}] ---\n\n` + content;
    const chunks = chunkDocuments(combined);
    const total = chunks.length;
    const item1a = chunks.filter((c) => c.section === "item1a").length;
    const sectionCounts: Record<string, number> = {};
    for (const c of chunks) {
      const s = c.section || "(none)";
      sectionCounts[s] = (sectionCounts[s] || 0) + 1;
    }
    // Find chunks mentioning "Risk Factors" textually
    const riskFactorChunks = chunks.filter((c) => /risk\s+factors/i.test(c.text)).length;
    const aiRiskChunks = chunks.filter((c) => /\bai\b|artificial intelligence|machine learning/i.test(c.text) && /risk/i.test(c.text)).length;
    console.log(`\n=== content_id ${cid} | ${url.slice(0, 70)}`);
    console.log(`  content chars: ${content.length}, total chunks: ${total}`);
    console.log(`  item1a-tagged chunks: ${item1a}`);
    console.log(`  chunks textually containing "Risk Factors": ${riskFactorChunks}`);
    console.log(`  chunks with AI+risk: ${aiRiskChunks}`);
    console.log(`  section distribution: ${JSON.stringify(sectionCounts)}`);
    // Show first item1a chunk preview if any
    const firstItem1a = chunks.find((c) => c.section === "item1a");
    if (firstItem1a) {
      console.log(`  first item1a chunk preview: ${firstItem1a.text.slice(0, 160).replace(/\n/g, " ")}`);
    }
    // Does any chunk near "Item 1A. Risk Factors" exist textually?
    const headingIdx = content.search(/item[\s\u00a0]*1a\b[\.\:\s\-—]{0,3}\s*risk\s+factors/i);
    console.log(`  textual "Item 1A. Risk Factors" heading offset: ${headingIdx}`);
  }

  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

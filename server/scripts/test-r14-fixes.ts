/**
 * Offline validation of the v3k-r14 broadened soft floor, reproducing the LIVE
 * multi-document corpus (not a single 10-K) so section re-tagging / compression
 * competition is faithfully reproduced.
 *
 *   Fix A  — Microsoft 3.1a Board Q1 keeps its DEF 14A (proxy spec not dropped).
 *   Fix B' — Alphabet 1.1a strategic-priority surfaces the 10-K from ANY section
 *            (Item 1 / 1A / 7), not just Item 1A.
 *   Fix B' — Microsoft 7.1 (req=None) likewise gets the annual filing floor.
 *
 * The corpus is assembled the same way summarizeDocuments would pass it: every
 * document the company has, joined with a DOCUMENT header carrying its real URL.
 */
import pg from "pg";
import {
  chunkDocuments,
  buildBM25Index,
  buildEvidencePackForMeasure,
  computePreferredAnnualUrl,
} from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

const boardQ1 = {
  measureId: "3.1a-ai-board-discussion", title: "AI board discussion",
  definition: "Does the company disclose board-level discussion of AI in its proxy statement (DEF 14A) or annual regulatory filing?",
  category: "Governance", categoryNumber: 3, displayOrder: 31,
  evidenceKeywords: ["board", "artificial intelligence", "oversight"],
  requiredSourceTypes: ["proxy", "regulatory-filing-by-issuer"],
} as any;

const strategicPriority = {
  measureId: "1.1a-ai-strategic-priority", title: "AI strategic priority",
  definition: "Does the company identify AI as a strategic priority in its disclosures?",
  category: "Strategy", categoryNumber: 1, displayOrder: 11,
  evidenceKeywords: ["artificial intelligence", "strategy", "priority"],
  requiredSourceTypes: null,
} as any;

const partnerships = {
  measureId: "7.1-ai-partnerships", title: "AI partnerships",
  definition: "Does the company disclose AI-related partnerships, collaborations or ecosystem investments?",
  category: "Ecosystem", categoryNumber: 7, displayOrder: 71,
  evidenceKeywords: ["partnership", "collaboration", "artificial intelligence"],
  requiredSourceTypes: null,
} as any;

const TOPIC = ["artificial", "intelligence", "ai", "machine", "learning", "generative", "model",
  "board", "strategy", "oversight", "partnership", "collaboration"];

type Case = {
  companyId: number; name: string; measure: any; label: string;
  mustForceCount1: boolean; mustIncludeUrlSubstr?: string; mustForceUrlSubstr?: string;
};

const CASES: Case[] = [
  { companyId: 553, name: "MICROSOFT", measure: boardQ1, label: "Fix A: Board Q1 keeps DEF 14A",
    mustForceCount1: true, mustIncludeUrlSubstr: "def14a" },
  { companyId: 2063, name: "ALPHABET", measure: strategicPriority, label: "Fix B': 1.1a surfaces 10-K (any section)",
    mustForceCount1: true, mustForceUrlSubstr: "goog-2025" },
  { companyId: 553, name: "MICROSOFT", measure: partnerships, label: "Fix B': 7.1 surfaces annual filing",
    mustForceCount1: true },
];

async function loadCorpus(client: pg.Client, companyId: number): Promise<string> {
  // Load every document for the company, joined with a header carrying the URL.
  const { rows } = await client.query(
    `SELECT d.url, d.title, dc.content
       FROM documents d JOIN document_content dc ON dc.id = d.content_id
      WHERE d.company_id=$1 AND dc.content IS NOT NULL
      ORDER BY length(dc.content) DESC`, [companyId]);
  let combined = "";
  for (const r of rows) {
    combined += `\n\n--- DOCUMENT: ${r.title || "Document"} [${r.url || ""}] ---\n\n` + (r.content || "");
  }
  return combined;
}

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  let allPass = true;

  for (const c of CASES) {
    const combined = await loadCorpus(client, c.companyId);
    const chunks = chunkDocuments(combined);
    const bm25Index = buildBM25Index(chunks.map((ch) => ch.text));
    const preferredAnnualUrl = computePreferredAnnualUrl(chunks);
    const pack = buildEvidencePackForMeasure({
      measure: c.measure, chunks, bm25Index, topicTerms: TOPIC,
      companyId: c.companyId, frameworkId: 7, preferredAnnualUrl,
    });
    const fu = (pack.forceIncludedDocUrl || "").toLowerCase();
    const txt = (pack.text || "").toLowerCase();
    const countOk = !c.mustForceCount1 || pack.forceIncludedCount >= 1;
    const forceUrlOk = !c.mustForceUrlSubstr || fu.includes(c.mustForceUrlSubstr.toLowerCase());
    const inPackOk = !c.mustIncludeUrlSubstr || txt.includes(c.mustIncludeUrlSubstr.toLowerCase());
    const pass = countOk && forceUrlOk && inPackOk;
    allPass = allPass && pass;

    console.log(`\n=== ${c.name}: ${c.label} ===`);
    console.log(`  corpus chars: ${combined.length} | chunks: ${chunks.length}`);
    console.log(`  preferredAnnualUrl: ${preferredAnnualUrl || "(none)"}`);
    console.log(`  forceIncludedCount: ${pack.forceIncludedCount} | forceIncludedDocUrl: ${pack.forceIncludedDocUrl || "(none)"}`);
    console.log(`  assert count>=1:${countOk} forcedUrl~"${c.mustForceUrlSubstr||"-"}":${forceUrlOk} inPack~"${c.mustIncludeUrlSubstr||"-"}":${inPackOk}`);
    console.log(`  RESULT: ${pass ? "PASS" : "FAIL"}`);
  }

  await client.end();
  console.log(`\n==== R14 FIXES: ${allPass ? "ALL PASS" : "SOME FAILED"} ====`);
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });

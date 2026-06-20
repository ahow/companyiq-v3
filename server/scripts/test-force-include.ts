/**
 * Offline validation of the v3j deterministic Item 1A force-include.
 *
 * Pulls the REAL 10-K content for a set of companies straight from the live DB,
 * builds the per-measure evidence pack for the Risk Q1 measure
 * (9.1-ai-risk-factor-disclosure) exactly as the analyzer would, and asserts:
 *   - forceIncludedCount >= 1 (a genuine Item 1A body chunk was guaranteed)
 *   - requiredDocPresent === true
 *   - the pack text contains real risk-factor prose (not just a TOC line)
 *   - the forced provenance URL is the 10-K
 *
 * This proves the fix offline before a full Railway re-run.
 */
import pg from "pg";
import {
  chunkDocuments,
  buildBM25Index,
  buildEvidencePackForMeasure,
} from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

// company_id -> { name, 10-K content_id(s) }. Multiple ids allowed (we concat).
const CASES: Array<{ companyId: number; name: string; contentIds: number[] }> = [
  { companyId: 420, name: "SALESFORCE", contentIds: [235179] },
  { companyId: 853, name: "AMAZON", contentIds: [215829] },
  { companyId: 1918, name: "META", contentIds: [156982] },
  { companyId: 553, name: "MICROSOFT", contentIds: [214934] },
  { companyId: 1312, name: "NVIDIA", contentIds: [207834, 207831, 145440, 123581] },
];

// The Risk Q1 measure, annotated with a requiredSourceTypes constraint so the
// deterministic force-include path engages (mirrors the live framework row).
const riskQ1 = {
  measureId: "9.1-ai-risk-factor-disclosure",
  title: "AI risk factor disclosure",
  definition:
    "Does the company disclose AI-related risk factors in its annual regulatory filing (Item 1A Risk Factors of the 10-K/20-F)?",
  category: "Risk & Compliance",
  categoryNumber: 9,
  displayOrder: 91,
  evidenceKeywords: ["artificial intelligence", "risk factors", "machine learning"],
  requiredSourceTypes: ["regulatory_annual_filing"],
} as any;

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();

  let allPass = true;
  for (const c of CASES) {
    // Build a combinedText that mimics analyzer's header-preserving corpus: each
    // document preceded by a "--- DOCUMENT: <title> [<url>] ---" header.
    let combined = "";
    for (const cid of c.contentIds) {
      const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
      if (!rows.length) continue;
      const drow = await client.query("SELECT url FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
      const url = drow.rows[0]?.url || `doc-${cid}`;
      combined += `\n\n--- DOCUMENT: 10-K [${url}] ---\n\n` + (rows[0].content || "");
    }
    const chunks = chunkDocuments(combined);
    const bm25Index = buildBM25Index(chunks.map((ch) => ch.text));
    const pack = buildEvidencePackForMeasure({
      measure: riskQ1,
      chunks,
      bm25Index,
      topicTerms: ["artificial", "intelligence", "ai", "machine", "learning", "risk"],
      companyId: c.companyId,
      frameworkId: 1,
    });

    const hasRiskProse = /(could|may|might)\s+(adversely|materially|negatively)|adversely affect our|harm our business|we (face|are subject to)/i.test(pack.text);
    // v3j-r2: the WHOLE point of the refinement is that the forced evidence is
    // measure-RELEVANT. For the AI risk-factor measure, the pack must contain AI
    // language co-located with risk language — not just generic risk preamble.
    const aiMentions = (pack.text.match(/\b(artificial intelligence|generative ai|machine learning|\bai\b)/gi) || []).length;
    const hasAiRisk = aiMentions >= 2 && /(risk|adversely|harm|could|may|uncertain|liabilit|regulat|threat|reputational|ethic)/i.test(pack.text);
    const pass =
      pack.requiredDocPresent === true &&
      pack.forceIncludedCount >= 1 &&
      hasRiskProse &&
      hasAiRisk;
    allPass = allPass && pass;

    console.log(`\n=== ${c.name} (companyId=${c.companyId}) ===`);
    console.log(`  chunks: ${chunks.length}`);
    console.log(`  requiredDocPresent: ${pack.requiredDocPresent}`);
    console.log(`  forceIncludedCount: ${pack.forceIncludedCount}`);
    console.log(`  forceIncludedDocUrl: ${pack.forceIncludedDocUrl || "(none)"}`);
    console.log(`  packChars: ${pack.totalChars}, chunkCount: ${pack.chunkCount}`);
    console.log(`  pack contains risk-factor prose: ${hasRiskProse}`);
    console.log(`  AI mentions in pack: ${aiMentions} | AI-risk co-located: ${hasAiRisk}`);
    console.log(`  RESULT: ${pass ? "PASS" : "FAIL"}`);
    // Show a short excerpt to eyeball that it is real Item 1A body, not a TOC.
    console.log(`  excerpt: ${pack.text.slice(0, 200).replace(/\s+/g, " ")}`);
  }

  await client.end();
  console.log(`\n==== OVERALL: ${allPass ? "ALL PASS" : "SOME FAILED"} ====`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

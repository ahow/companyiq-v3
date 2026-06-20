/**
 * Offline validation of the v3k-r13 fixes:
 *   Fix A — proxy-required measures (e.g. 3.1a Board Q1) must KEEP their DEF 14A
 *           (the proxy-dominant drop is now item1a-spec-only).
 *   Fix B — non-proxy measures with NO hard requiredSourceTypes (e.g. 1.1a
 *           strategic priority) get a SOFT annual-filing floor: >=1 genuine Item
 *           1A body chunk from the preferred 10-K is guaranteed into the pack.
 *
 * Builds the per-measure pack from REAL live-DB document content, exactly as the
 * analyzer does, and asserts the fix-specific invariants.
 */
import pg from "pg";
import {
  chunkDocuments,
  buildBM25Index,
  buildEvidencePackForMeasure,
  computePreferredAnnualUrl,
} from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";

type Case = {
  companyId: number;
  name: string;
  contentIds: number[];
  measure: any;
  // assertions
  mustForceCount1: boolean;            // forceIncludedCount >= 1
  mustIncludeUrlSubstr?: string;       // a doc with this URL substring must be in pack text
  mustForceUrlSubstr?: string;         // forceIncludedDocUrl must contain this
  label: string;
};

const boardQ1 = {
  measureId: "3.1a-ai-board-discussion",
  title: "AI board discussion",
  definition:
    "Does the company disclose board-level discussion of AI in its proxy statement (DEF 14A) or annual regulatory filing?",
  category: "Governance",
  categoryNumber: 3,
  displayOrder: 31,
  evidenceKeywords: ["board", "artificial intelligence", "oversight"],
  requiredSourceTypes: ["proxy", "regulatory-filing-by-issuer"],
} as any;

const strategicPriority = {
  measureId: "1.1a-ai-strategic-priority",
  title: "AI strategic priority",
  definition:
    "Does the company identify AI as a strategic priority in its disclosures?",
  category: "Strategy",
  categoryNumber: 1,
  displayOrder: 11,
  evidenceKeywords: ["artificial intelligence", "strategy", "priority"],
  requiredSourceTypes: null,
} as any;

const CASES: Case[] = [
  // Fix A: Microsoft Board Q1 over BOTH the DEF 14A (164916) and the 10-K (214934).
  // The DEF 14A is the required proxy source; it must be force-included, NOT dropped
  // as "proxy-dominant".
  {
    companyId: 553, name: "MICROSOFT", contentIds: [164916, 214934], measure: boardQ1,
    mustForceCount1: true, mustIncludeUrlSubstr: "d908201ddef14a.htm",
    label: "Fix A: Board Q1 keeps DEF 14A in pack (proxy spec not dropped)",
  },
  // Fix B: Alphabet strategic priority over the FY2025 10-K (153171). No hard
  // requirement -> previously 0 forced. Soft floor must guarantee >=1 Item 1A body
  // chunk from goog-20251231.
  {
    companyId: 2063, name: "ALPHABET", contentIds: [153171], measure: strategicPriority,
    mustForceCount1: true, mustForceUrlSubstr: "goog-20251231",
    label: "Fix B: 1.1a soft annual-filing floor surfaces the 10-K",
  },
];

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();

  let allPass = true;
  for (const c of CASES) {
    let combined = "";
    for (const cid of c.contentIds) {
      const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
      if (!rows.length) continue;
      const drow = await client.query("SELECT url, title FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
      const url = drow.rows[0]?.url || `doc-${cid}`;
      const title = drow.rows[0]?.title || `Document ${cid}`;
      combined += `\n\n--- DOCUMENT: ${title} [${url}] ---\n\n` + (rows[0].content || "");
    }
    const chunks = chunkDocuments(combined);
    const bm25Index = buildBM25Index(chunks.map((ch) => ch.text));
    const preferredAnnualUrl = computePreferredAnnualUrl(chunks);
    const pack = buildEvidencePackForMeasure({
      measure: c.measure,
      chunks,
      bm25Index,
      topicTerms: ["artificial", "intelligence", "ai", "machine", "learning", "board", "strategy", "oversight"],
      companyId: c.companyId,
      frameworkId: 7,
      preferredAnnualUrl,
    });

    const fu = (pack.forceIncludedDocUrl || "").toLowerCase();
    const countOk = !c.mustForceCount1 || pack.forceIncludedCount >= 1;
    const forceUrlOk = !c.mustForceUrlSubstr || fu.includes(c.mustForceUrlSubstr.toLowerCase());
    const inPackOk = !c.mustIncludeUrlSubstr || (pack.text || "").toLowerCase().includes(c.mustIncludeUrlSubstr.toLowerCase());
    const pass = countOk && forceUrlOk && inPackOk;
    allPass = allPass && pass;

    console.log(`\n=== ${c.name}: ${c.label} ===`);
    console.log(`  chunks: ${chunks.length}`);
    console.log(`  preferredAnnualUrl: ${preferredAnnualUrl || "(none)"}`);
    console.log(`  requiredDocPresent: ${pack.requiredDocPresent}`);
    console.log(`  forceIncludedCount: ${pack.forceIncludedCount}`);
    console.log(`  forceIncludedDocUrl: ${pack.forceIncludedDocUrl || "(none)"}`);
    console.log(`  assert forceCount>=1: ${countOk} | forcedUrl~"${c.mustForceUrlSubstr || "-"}": ${forceUrlOk}`);
    console.log(`  RESULT: ${pass ? "PASS" : "FAIL"}`);
    console.log(`  excerpt: ${(pack.text || "").slice(0, 220).replace(/\s+/g, " ")}`);
  }

  await client.end();
  console.log(`\n==== R13 FIXES: ${allPass ? "ALL PASS" : "SOME FAILED"} ====`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

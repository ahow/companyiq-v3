/**
 * r14 EVIDENCE-PRESENCE PROOF.
 * For each reviewer-flagged measure, rebuild the per-measure evidence pack from the
 * live company corpus (the same way the analyzer does) and report:
 *   - whether the REQUIRED document (DEF 14A or the canonical 10-K) is present in the pack,
 *   - forceIncludedCount / forceIncludedDocUrl,
 * then pair it with the LIVE r14 grader verdict + evidence_summary from measure_scores.
 * This separates "retrieval fixed (doc in pack)" from "grader judgment (No on present evidence)".
 */
import pg from "pg";
import {
  chunkDocuments, buildBM25Index, buildEvidencePackForMeasure, computePreferredAnnualUrl,
} from "../lib/passage-retrieval.js";

const PG = process.env.PG || "";
const TOPIC = ["artificial","intelligence","ai","machine","learning","generative","model",
  "board","strategy","oversight","priority","partnership","collaboration","governance","risk"];

const M = {
  "3.1a": { measureId:"3.1a-ai-board-discussion", title:"AI board discussion",
    definition:"Board-level discussion/oversight of AI in proxy (DEF 14A) or annual filing?",
    category:"Governance", categoryNumber:3, displayOrder:31,
    evidenceKeywords:["board","artificial intelligence","oversight"],
    requiredSourceTypes:["proxy","regulatory-filing-by-issuer"] },
  "7.1": { measureId:"7.1-strategic-ai-partnerships", title:"Strategic AI partnerships",
    definition:"Disclosed strategic partnership with a foundation-model provider or hyperscaler?",
    category:"Ecosystem", categoryNumber:7, displayOrder:71,
    evidenceKeywords:["partnership","collaboration","artificial intelligence"],
    requiredSourceTypes:null },
  "1.1a": { measureId:"1.1a-ai-strategic-priority", title:"AI strategic priority",
    definition:"AI identified as a strategic priority (CEO/Chair/strategy section)?",
    category:"Strategy", categoryNumber:1, displayOrder:11,
    evidenceKeywords:["artificial intelligence","strategy","priority"],
    requiredSourceTypes:null },
  "2.1a": { measureId:"2.1a-ai-use-cases-qualitative", title:"AI use cases (qualitative)",
    definition:"Does the company describe specific qualitative AI use cases?",
    category:"Use Cases", categoryNumber:2, displayOrder:21,
    evidenceKeywords:["artificial intelligence","use case","application"],
    requiredSourceTypes:null },
  "2.2a": { measureId:"2.2a-ai-production-deployment", title:"AI production deployment",
    definition:"Does the company disclose AI deployed in production?",
    category:"Use Cases", categoryNumber:2, displayOrder:22,
    evidenceKeywords:["artificial intelligence","production","deploy"],
    requiredSourceTypes:null },
} as any;

const CASES = [
  { companyId:553, name:"Microsoft", key:"3.1a", reqDocSubstr:"def14a" },
  { companyId:553, name:"Microsoft", key:"7.1",  reqDocSubstr:"msft-2025" },
  { companyId:2063,name:"Alphabet",  key:"1.1a", reqDocSubstr:"goog-2025" },
  { companyId:2063,name:"Alphabet",  key:"2.1a", reqDocSubstr:"goog-2025" },
  { companyId:2063,name:"Alphabet",  key:"2.2a", reqDocSubstr:"goog-2025" },
];

async function loadCorpus(client: pg.Client, companyId: number): Promise<string> {
  const { rows } = await client.query(
    `SELECT d.url, d.title, dc.content FROM documents d JOIN document_content dc ON dc.id=d.content_id
      WHERE d.company_id=$1 AND dc.content IS NOT NULL ORDER BY length(dc.content) DESC`, [companyId]);
  return rows.map((r) => `\n\n--- DOCUMENT: ${r.title||"Document"} [${r.url||""}] ---\n\n${r.content||""}`).join("");
}

async function liveVerdict(client: pg.Client, companyId: number, prefix: string) {
  const { rows } = await client.query(
    `SELECT verdict, confidence, jsonb_array_length(quotes) AS q, evidence_summary
       FROM measure_scores WHERE company_id=$1 AND measure_id LIKE $2 ORDER BY created_at DESC LIMIT 1`,
    [companyId, prefix + "%"]);
  return rows[0];
}

async function main() {
  const client = new pg.Client({ connectionString: PG });
  await client.connect();
  for (const c of CASES) {
    const combined = await loadCorpus(client, c.companyId);
    const chunks = chunkDocuments(combined);
    const bm25Index = buildBM25Index(chunks.map((x) => x.text));
    const preferredAnnualUrl = computePreferredAnnualUrl(chunks);
    const pack = buildEvidencePackForMeasure({
      measure: M[c.key], chunks, bm25Index, topicTerms: TOPIC,
      companyId: c.companyId, frameworkId: 7, preferredAnnualUrl,
    });
    const inPack = (pack.text || "").toLowerCase().includes(c.reqDocSubstr.toLowerCase());
    const lv = await liveVerdict(client, c.companyId, c.key);
    console.log(`\n=== ${c.name} ${c.key} ===`);
    console.log(`  REQUIRED DOC ("${c.reqDocSubstr}") IN PACK: ${inPack ? "YES ✓" : "NO ✗"}`);
    console.log(`  forceIncludedCount=${pack.forceIncludedCount} forcedUrl=${(pack.forceIncludedDocUrl||"(none)").slice(0,80)}`);
    console.log(`  requiredDocPresent flag=${pack.requiredDocPresent}`);
    console.log(`  LIVE r14 verdict: ${lv?.verdict}/${lv?.confidence}/${lv?.q}q`);
    console.log(`  LIVE r14 evidence_summary: ${(lv?.evidence_summary||"").slice(0,400)}`);
  }
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });

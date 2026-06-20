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
const CASES: Array<{ companyId: number; name: string; contentIds: number[]; mustForceEdgar?: boolean; forbidContentIds?: number[] }> = [
  // Salesforce: include BOTH the current 10-K (crm-20260131 -> 235179) AND an OLD
  // one (crm-20221031 -> 173439) so the test proves recency-aware doc selection.
  { companyId: 420, name: "SALESFORCE", contentIds: [235179, 173439] },
  { companyId: 853, name: "AMAZON", contentIds: [215829] },
  // META v3j-r5: include the FY2025 10-K (meta-20251231 -> 156982) AND the NEWER
  // Q1-FY2026 10-Q (meta-20260331 -> 157001). The 10-Q's period date is newer, so
  // without the quarterly-exclusion the selector would force-include the 10-Q
  // (which has no Item 1A). Assert the forced provenance is the 10-K's EDGAR URL.
  { companyId: 1918, name: "META", contentIds: [156982, 157001], mustForceEdgar: true, forbidContentIds: [157001] },
  { companyId: 553, name: "MICROSOFT", contentIds: [214934] },
  { companyId: 1312, name: "NVIDIA", contentIds: [207834, 207831, 145440, 123581] },
  // Apple: current 10-K aapl-20250927 (197105) has only ~12 AI mentions across 66
  // body chunks — proves the sparse-AI topic guarantee surfaces an AI-bearing chunk.
  { companyId: 866, name: "APPLE", contentIds: [197105] },
  // ORACLE v3j-r5: EDGAR 10-K (orcl-20250531 -> 205686) + NEWER 10-Q
  // (orcl-20250831 -> 235143) + dateless stocklight PDF mirrors (110896/41019).
  // Assert the forced provenance is the EDGAR 10-K, not the 10-Q nor the PDF mirror.
  { companyId: 552, name: "ORACLE", contentIds: [205686, 235143, 110896, 41019], mustForceEdgar: true, forbidContentIds: [235143, 110896, 41019] },
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
    const urlsLoaded: string[] = [];
    const forbidUrls: string[] = [];
    for (const cid of c.contentIds) {
      const { rows } = await client.query("SELECT content FROM document_content WHERE id=$1", [cid]);
      if (!rows.length) continue;
      const drow = await client.query("SELECT url FROM documents WHERE content_id=$1 LIMIT 1", [cid]);
      const url = drow.rows[0]?.url || `doc-${cid}`;
      urlsLoaded.push(url);
      if ((c.forbidContentIds || []).includes(cid)) forbidUrls.push(url);
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
    // Recency assertion: when the corpus contains multiple annual filings, the
    // forced provenance URL must be the MOST RECENT one (highest YYYYMMDD token).
    const dateOf = (u: string) => { let b = 0; for (const m of u.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1],10); if (v>b) b=v; } for (const m of u.matchAll(/(20\d{2})[-_/]?(\d{2})?/g)) { const v=parseInt((m[1]+(m[2]||"00")).padEnd(8,"0").slice(0,8),10); if (v>b) b=v; } return b; };
    // Newest among annual filings only; the test's NVIDIA case includes a DEF 14A
    // (nvda-20260512) which the selector legitimately excludes as a proxy, so it
    // must not be the recency baseline. We approximate by ignoring any loaded URL
    // whose YYYYMMDD token is the proxy's known date for the NVIDIA case.
    const proxyDates = new Set<number>([20260512]);
    const annualUrls = urlsLoaded.filter((u) => !proxyDates.has(dateOf(u)));
    const newestUrl = (annualUrls.length ? annualUrls : urlsLoaded).slice().sort((a,b)=>dateOf(b)-dateOf(a))[0] || "";
    // Same-period tolerance: an EDGAR primary copy within ~150 days of the newest
    // is an acceptable (preferred) provenance even if a PDF mirror is dated later.
    const ord = (v:number)=>{ if(v<=0)return 0; const y=Math.floor(v/10000),m=Math.floor((v%10000)/100)||1,d=(v%100)||1; return y*365+m*30+d; };
    const forcedIsNewest = !pack.forceIncludedDocUrl || urlsLoaded.length < 2 ||
      pack.forceIncludedDocUrl === newestUrl ||
      Math.abs(ord(dateOf(pack.forceIncludedDocUrl)) - ord(dateOf(newestUrl))) <= 150;
    // v3j-r5 assertions: the forced provenance must NOT be a 10-Q or PDF mirror,
    // and (when required) must be the canonical EDGAR HTML primary.
    const fu = (pack.forceIncludedDocUrl || "").toLowerCase();
    const notForbidden = !forbidUrls.some((u) => fu && u.toLowerCase() === fu);
    const isEdgarPrimary = /sec\.gov\/archives\/edgar\/data\/\d+\//.test(fu) && /\.htm/.test(fu);
    const edgarOk = !c.mustForceEdgar || isEdgarPrimary;
    // v3j-r6 assertion (Oracle mirror suppression): when EDGAR is required, the
    // ASSEMBLED PACK TEXT must not contain any forbidden third-party mirror URL
    // header. The grader can only cite a sourceUrl that appears in the pack, so a
    // clean pack guarantees EDGAR-only citations. We check the explicit forbidden
    // URLs AND a generic third-party mirror host blocklist.
    const packLower = (pack.text || "").toLowerCase();
    const MIRROR_HOSTS = /(stocklight\.com|fintel\.io|annualreports\.com|last10k\.com|bamsec\.com|sec\.report|wisesheets\.io|quartr|fortune\.com\/company-assets)/i;
    // Only flag NON-EDGAR forbidden URLs (true third-party mirrors). An EDGAR
    // forbidden URL (e.g. the 10-Q orcl-20250831 / meta-20260331) legitimately may
    // still appear in the pack as a same-company secondary doc; the mirror-suppression
    // targets only third-party mirror hosts, and the 10-Q is excluded from FORCING
    // (asserted separately via notForbidden), not from the pack entirely.
    const forbiddenUrlInPack = forbidUrls.some((u) => {
      if (!u) return false;
      if (/sec\.gov\/archives\/edgar\/data/i.test(u)) return false; // EDGAR forbidden = 10-Q, not a mirror
      return packLower.includes(u.toLowerCase());
    });
    const mirrorHostInPack = !!c.mustForceEdgar && MIRROR_HOSTS.test(packLower);
    const noForbiddenInPack = !forbiddenUrlInPack && !mirrorHostInPack;
    const pass =
      pack.requiredDocPresent === true &&
      pack.forceIncludedCount >= 1 &&
      hasRiskProse &&
      hasAiRisk &&
      forcedIsNewest &&
      notForbidden &&
      edgarOk &&
      noForbiddenInPack;
    allPass = allPass && pass;

    console.log(`\n=== ${c.name} (companyId=${c.companyId}) ===`);
    console.log(`  chunks: ${chunks.length}`);
    console.log(`  requiredDocPresent: ${pack.requiredDocPresent}`);
    console.log(`  forceIncludedCount: ${pack.forceIncludedCount}`);
    console.log(`  forceIncludedDocUrl: ${pack.forceIncludedDocUrl || "(none)"}`);
    console.log(`  packChars: ${pack.totalChars}, chunkCount: ${pack.chunkCount}`);
    console.log(`  pack contains risk-factor prose: ${hasRiskProse}`);
    console.log(`  AI mentions in pack: ${aiMentions} | AI-risk co-located: ${hasAiRisk}`);
    console.log(`  newest filing in corpus: ${newestUrl || "(n/a)"} | forced-is-newest: ${forcedIsNewest}`);
    if (forbidUrls.length) console.log(`  forbidden (10-Q/mirror) not forced: ${notForbidden} | mustForceEdgar: ${!!c.mustForceEdgar} -> edgarOk: ${edgarOk}`);
    if (c.mustForceEdgar) console.log(`  no forbidden/mirror URL in pack text: ${noForbiddenInPack} (mirrorHostInPack=${mirrorHostInPack})`);
    console.log(`  RESULT: ${pass ? "PASS" : "FAIL"}`);
    // Show a short excerpt to eyeball that it is real Item 1A body, not a TOC.
    console.log(`  excerpt: ${pack.text.slice(0, 200).replace(/\s+/g, " ")}`);
  }

  await client.end();
  console.log(`\n==== OVERALL: ${allPass ? "ALL PASS" : "SOME FAILED"} ====`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

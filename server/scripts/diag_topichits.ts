/**
 * Diagnostic for the topicHits reserve-gate (user request #3).
 * For BOTH companies and ALL measures, replicate the exact blended scoring used
 * by buildEvidencePackForMeasure and report, per measure:
 *   - topKTopicHits  = sum of per-chunk topicHits over the top-EVIDENCE_TOP_K
 *                      chunks by blended score (i.e. what the pack would contain).
 *     This is the candidate gate signal: HIGH => topic path already covers the
 *     measure (reserve would only dilute); LOW => topic path is weak (reserve
 *     rescues genuinely-missed BM25 evidence).
 *   - also prints whether each measure is a known GAIN / REGRESSOR / TARGET so we
 *     can choose a threshold that keeps the reserve ON for the measures it fixes
 *     (esp. Nestlé 2.4) and OFF for the rich measures it regressed (Nestlé 1.4/2.7).
 * Uses B-arm corpus + improved lexicon (the go-forward state), W=1 (shipped).
 */
import { readFileSync } from "fs";
import {
  chunkDocuments, buildBM25Index, bm25Score, tokenize, countTopicHits, deriveTopicTerms,
} from "../lib/passage-retrieval.js";

const HOME = "/home/ubuntu";
const TOP_K = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "24", 10);
const TOPIC_RELEVANCE_WEIGHT = 3.0; // default in passage-retrieval
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const measures = JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8"));
const lex = JSON.parse(readFileSync(`${HOME}/lexicon_before_after.json`, "utf8"));
const termOf = (x: any): string => (typeof x === "string" ? x : (x.term || x.t));
const improvedTerms: string[] = (lex.improved as any[]).map(termOf).filter(Boolean);
const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
const topicTermsB = [...new Set([...improvedTerms, ...deterministicTerms])];

function buildCombined(docs: Array<{ url: string; title: string; text: string }>): string {
  return docs.map((d) => `\n\n--- DOCUMENT: ${d.title} [${d.url}] ---\n\n${d.text}`).join("");
}

// annotations from the validated matrix
const NOTE: Record<string, Record<string, string>> = {
  NESTLE: { "2.4-nature-opportunities": "TARGET(reserve fixes P->Y)", "2.6-business-model-resilience": "target(noise)", "1.5-stakeholder-engagement": "target(noise)", "1.4-integration-strategy": "REGRESSOR@r12", "2.7-strategic-response": "REGRESSOR@W2" },
  KERING: { "2.4-nature-opportunities": "GAIN(No->Yes)", "1.5-stakeholder-engagement": "GAIN(P->Yes)", "2.5-priority-locations": "GAIN(No->P/Y)" },
};

function analyze(label: string, corpusFile: string, newFile: string) {
  const existingCorpus = JSON.parse(readFileSync(`${HOME}/${corpusFile}`, "utf8"));
  const newDocs = JSON.parse(readFileSync(`${HOME}/${newFile}`, "utf8"));
  const chunks = chunkDocuments(buildCombined([...existingCorpus, ...newDocs]));
  const bm25Index = buildBM25Index(chunks.map((c) => c.text));
  console.log(`\n${"#".repeat(92)}\n# ${label}  (${chunks.length} chunks, TOP_K=${TOP_K})`);
  console.log(`# measure                        topKTopicHits  novelty  #ek   note`);
  const rows: Array<{ mid: string; tk: number }> = [];
  for (const measure of measures) {
    const qTerms = [...tokenize(measure.title), ...(measure.definition ? tokenize(measure.definition) : [])];
    if (measure.evidenceKeywords) for (const kw of measure.evidenceKeywords) qTerms.push(...tokenize(kw));
    const uniqueTerms = [...new Set(qTerms)];
    const scored = chunks.map((chunk, idx) => {
      const bm25 = bm25Score(uniqueTerms, idx, bm25Index);
      const hits = countTopicHits(chunk.text, topicTermsB);
      const topicBonus = hits > 0 ? TOPIC_RELEVANCE_WEIGHT * (1 + Math.log(hits)) : 0;
      return { idx, bm25, hits, score: bm25 + topicBonus };
    });
    // blended ranking (what the pack fills by)
    const byBlended = [...scored].sort((a, b) => b.score - a.score);
    const blendedRank = new Map<number, number>();
    byBlended.forEach((x, i) => blendedRank.set(x.idx, i));
    const topK = byBlended.slice(0, TOP_K);
    const topKTopicHits = topK.reduce((s, x) => s + x.hits, 0);
    // NOVELTY signal: of the pure-BM25 top-6, how many would be MISSED by the blend
    // (blended rank >= TOP_K)? High => reserve is doing real work (rescuing evidence
    // the topic-blend displaces). Zero => reserve only dilutes (blend already has them).
    const byBm25 = [...scored].sort((a, b) => b.bm25 - a.bm25).slice(0, 6);
    const reserveNovelty = byBm25.filter((x) => (blendedRank.get(x.idx) ?? 1e9) >= TOP_K).length;
    const note = NOTE[label]?.[measure.measureId] || "";
    rows.push({ mid: measure.measureId, tk: topKTopicHits });
    console.log(`  ${measure.measureId.padEnd(30)} ${String(topKTopicHits).padStart(11)} ${String(reserveNovelty).padStart(9)}/6 ${String(measure.evidenceKeywords?.length||0).padStart(6)}ek  ${note}`);
  }
  return rows;
}

analyze("NESTLE", "ab_nestle_corpus.json", "ab_nestle_new_docs.json");
analyze("KERING", "ab_kering_corpus.json", "ab_kering_new_docs.json");

/**
 * Diagnostic: for the Nestlé failing measures (2.6, 1.5, 2.4), reconstruct the
 * exact per-chunk scoring that buildEvidencePackForMeasure uses, and dump the
 * PURE-BM25 ranking of chunks with their doc URLs + BM25 scores. This confirms:
 *  - where the measure-specific evidence (e.g. annual review for 2.6) ranks by BM25
 *  - the absolute BM25 score distribution (to set a principled relevance floor)
 *  - which chunks the top-N reserve currently grabs vs what it misses
 */
import { readFileSync } from "fs";
import {
  chunkDocuments, buildBM25Index, bm25Score, tokenize, countTopicHits, deriveTopicTerms,
} from "../lib/passage-retrieval.js";

const HOME = "/home/ubuntu";
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const measures = JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8"));
const existingCorpus = JSON.parse(readFileSync(`${HOME}/ab_nestle_corpus.json`, "utf8"));
const newDocs = JSON.parse(readFileSync(`${HOME}/ab_nestle_new_docs.json`, "utf8"));
const lex = JSON.parse(readFileSync(`${HOME}/lexicon_before_after.json`, "utf8"));
const termOf = (x: any): string => (typeof x === "string" ? x : (x.term || x.t));
const improvedTerms: string[] = (lex.improved as any[]).map(termOf).filter(Boolean);
const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
const topicTermsB = [...new Set([...improvedTerms, ...deterministicTerms])];

function buildCombined(docs: Array<{ url: string; title: string; text: string }>): string {
  return docs.map((d) => `\n\n--- DOCUMENT: ${d.title} [${d.url}] ---\n\n${d.text}`).join("");
}
const combinedB = buildCombined([...existingCorpus, ...newDocs]);
const chunks = chunkDocuments(combinedB);
const bm25Index = buildBM25Index(chunks.map((c) => c.text));

const measuresById = new Map<string, any>(measures.map((m: any) => [m.measureId, m]));
const TARGETS = ["2.6-business-model-resilience", "1.5-stakeholder-engagement", "2.4-nature-opportunities", "2.5-priority-locations"];

function shortUrl(u?: string): string {
  if (!u) return "(no url)";
  return u.replace(/^https?:\/\//, "").split("/").pop() || u;
}

for (const mid of TARGETS) {
  const measure = measuresById.get(mid);
  const queryTerms: string[] = [
    ...tokenize(measure.title),
    ...(measure.definition ? tokenize(measure.definition) : []),
  ];
  if (measure.evidenceKeywords) for (const kw of measure.evidenceKeywords) queryTerms.push(...tokenize(kw));
  const uniqueTerms = [...new Set(queryTerms)];

  const scored = chunks.map((chunk, idx) => {
    const bm25 = bm25Score(uniqueTerms, idx, bm25Index);
    const hits = countTopicHits(chunk.text, topicTermsB);
    const topicBonus = hits > 0 ? 3.0 * (1 + Math.log(hits)) : 0; // TOPIC_RELEVANCE_WEIGHT default
    return { idx, docIndex: chunk.docIndex, bm25, topicHits: hits, blended: bm25 + topicBonus, url: chunk.docUrl };
  });

  const byBm25 = [...scored].sort((a, b) => b.bm25 - a.bm25);
  const byBlended = [...scored].sort((a, b) => b.blended - a.blended);

  console.log(`\n${"=".repeat(80)}\n${mid}   evidenceKeywords=${JSON.stringify(measure.evidenceKeywords||[])}`);
  console.log(`query terms (${uniqueTerms.length}): ${uniqueTerms.slice(0,25).join(" ")}${uniqueTerms.length>25?" …":""}`);
  console.log(`\n-- TOP 15 by PURE BM25 --`);
  console.log(`rank  bm25    topicHits  doc`);
  byBm25.slice(0, 15).forEach((s, i) => {
    console.log(`${String(i+1).padStart(3)}  ${s.bm25.toFixed(3).padStart(7)}  ${String(s.topicHits).padStart(6)}     ${shortUrl(s.url)}`);
  });

  console.log(`\n-- BM25 score distribution (all ${scored.length} chunks) --`);
  const sortedScores = byBm25.map(s=>s.bm25);
  const pct = (p: number) => sortedScores[Math.floor((p/100)*sortedScores.length)] ?? 0;
  console.log(`max=${sortedScores[0].toFixed(3)} p90=${pct(10).toFixed(3)} p75=${pct(25).toFixed(3)} p50=${pct(50).toFixed(3)} nonzero=${sortedScores.filter(x=>x>0).length}`);

  // Where does the top blended-ranked doc that is NOT in top-4 BM25 sit?
  const top4Bm25Idx = new Set(byBm25.slice(0,4).map(s=>s.idx));
  console.log(`\n-- Chunks in TOP 10 BLENDED but NOT in top-4 BM25 (topic-boosted intruders) --`);
  byBlended.slice(0,10).filter(s=>!top4Bm25Idx.has(s.idx)).forEach(s=>{
    const bm25Rank = byBm25.findIndex(x=>x.idx===s.idx)+1;
    console.log(`  blended=${s.blended.toFixed(2)} bm25=${s.bm25.toFixed(3)}(rank ${bm25Rank}) hits=${s.topicHits}  ${shortUrl(s.url)}`);
  });
}

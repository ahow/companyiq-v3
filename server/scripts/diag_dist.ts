/**
 * Generalized diagnostic: for BOTH companies and ALL measures, replicate the
 * exact up-weighted BM25 query used by buildEvidencePackForMeasure, then report
 * the per-measure BM25 distribution shape and how many chunks each candidate
 * RESERVE GATE would admit:
 *   - relFrac(0.45), relFrac(0.60): current fraction-of-max floor
 *   - absMedMult(2x/3x median): outlier gate relative to the measure's own median
 *   - gap: largest multiplicative gap in the sorted top-15 (cliff detection)
 * Goal: find a gate that reserves genuine outliers (recall gaps) without
 * over-reserving in evidence-rich pools.
 */
import { readFileSync } from "fs";
import {
  chunkDocuments, buildBM25Index, bm25Score, tokenize, deriveTopicTerms,
} from "../lib/passage-retrieval.js";

const HOME = "/home/ubuntu";
const W = parseInt(process.env.RETRIEVAL_EVIDENCE_KEYWORD_WEIGHT || "2", 10);
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

function pctOf(sorted: number[], p: number): number {
  return sorted[Math.floor((p / 100) * sorted.length)] ?? 0;
}

function analyzeCompany(label: string, corpusFile: string, newFile: string) {
  const existingCorpus = JSON.parse(readFileSync(`${HOME}/${corpusFile}`, "utf8"));
  const newDocs = JSON.parse(readFileSync(`${HOME}/${newFile}`, "utf8"));
  const combined = buildCombined([...existingCorpus, ...newDocs]);
  const chunks = chunkDocuments(combined);
  const bm25Index = buildBM25Index(chunks.map((c) => c.text));

  console.log(`\n${"#".repeat(90)}\n# ${label}  (W=${W}, ${chunks.length} chunks)`);
  console.log(`# measure                         max    p90    p75    med   relF.45 relF.60 med2x med3x  gap>=3x@`);
  for (const measure of measures) {
    const queryTerms: string[] = [...tokenize(measure.title), ...(measure.definition ? tokenize(measure.definition) : [])];
    const ekTok: string[] = [];
    if (measure.evidenceKeywords) for (const kw of measure.evidenceKeywords) ekTok.push(...tokenize(kw));
    queryTerms.push(...ekTok);
    const uniqueTerms = [...new Set(queryTerms)];
    for (let w = 0; w < Math.max(0, W - 1); w++) uniqueTerms.push(...ekTok);

    const scores = chunks.map((_, idx) => bm25Score(uniqueTerms, idx, bm25Index)).filter((x) => x > 0).sort((a, b) => b - a);
    if (scores.length === 0) { console.log(`  ${measure.measureId.padEnd(30)} (no bm25 signal)`); continue; }
    const max = scores[0], p90 = pctOf(scores, 10), p75 = pctOf(scores, 25), med = pctOf(scores, 50);
    const relF45 = scores.filter((x) => x >= max * 0.45).length;
    const relF60 = scores.filter((x) => x >= max * 0.60).length;
    const med2x = scores.filter((x) => x >= med * 2).length;
    const med3x = scores.filter((x) => x >= med * 3).length;
    // cliff: first index (in top 15) where score[i]/score[i+1] >= 3  => reserve i+1 chunks
    let gapAt = -1;
    for (let i = 0; i < Math.min(15, scores.length - 1); i++) {
      if (scores[i] / (scores[i + 1] || 1e-9) >= 3) { gapAt = i + 1; break; }
    }
    console.log(
      `  ${measure.measureId.padEnd(30)} ${max.toFixed(0).padStart(4)} ${p90.toFixed(0).padStart(6)} ${p75.toFixed(0).padStart(6)} ${med.toFixed(0).padStart(6)} ${String(relF45).padStart(7)} ${String(relF60).padStart(7)} ${String(med2x).padStart(5)} ${String(med3x).padStart(5)} ${(gapAt < 0 ? "none" : String(gapAt)).padStart(9)}`,
    );
  }
}

analyzeCompany("NESTLE", "ab_nestle_corpus.json", "ab_nestle_new_docs.json");
analyzeCompany("KERING", "ab_kering_corpus.json", "ab_kering_new_docs.json");

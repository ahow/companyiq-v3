/**
 * Stage 2 A/B retrieval harness (Kering, framework 3).
 * Drives the REAL buildEvidencePacksForCategory / deriveTopicTerms from
 * passage-retrieval.ts. Arm A = existing corpus + current lexicon topicTerms.
 * Arm B = existing+new corpus + improved lexicon topicTerms.
 * Both arms use identical measures, identical deterministicTerms, identical call
 * signature — the ONLY differences are (corpus, topicTerms), isolating the lexicon delta.
 */
import { readFileSync, writeFileSync } from "fs";
import { buildEvidencePacksForCategory, deriveTopicTerms, type EvidencePack } from "../lib/passage-retrieval.js";

const HOME = "/home/ubuntu";
const framework = JSON.parse(readFileSync(`${HOME}/ab_framework.json`, "utf8"));
const measures = JSON.parse(readFileSync(`${HOME}/ab_measures.json`, "utf8"));
const existingCorpus: Array<{ url: string; title: string; text: string }> = JSON.parse(readFileSync(`${HOME}/ab_kering_corpus.json`, "utf8"));
const newDocs: Array<{ url: string; title: string; text: string }> = JSON.parse(readFileSync(`${HOME}/ab_kering_new_docs.json`, "utf8"));
const lex = JSON.parse(readFileSync(`${HOME}/lexicon_before_after.json`, "utf8"));

const termOf = (x: any): string => (typeof x === "string" ? x : (x.term || x.t));
const currentTerms: string[] = (lex.current as any[]).map(termOf).filter(Boolean);
const improvedTerms: string[] = (lex.improved as any[]).map(termOf).filter(Boolean);

// --- corpus assembly (marker format identical to analyzer.ts BM25-skip raw path) ---
function buildCombined(docs: Array<{ url: string; title: string; text: string }>): string {
  return docs.map((d) => `\n\n--- DOCUMENT: ${d.title} [${d.url}] ---\n\n${d.text}`).join("");
}
const combinedA = buildCombined(existingCorpus);
const combinedB = buildCombined([...existingCorpus, ...newDocs]);

// --- topicTerms exactly as analyzer.ts: union(lexTerms, deterministicTerms) ---
const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
const topicTermsA = [...new Set([...currentTerms, ...deterministicTerms])];
const topicTermsB = [...new Set([...improvedTerms, ...deterministicTerms])];

const companyId = 13;
const frameworkId = framework.id;

function run(combinedText: string, topicTerms: string[]): EvidencePack[] {
  return buildEvidencePacksForCategory({
    measures,
    combinedText,
    terminology: undefined,
    topicTerms,
    companyId,
    frameworkId,
  });
}

console.error(`deterministicTerms (${deterministicTerms.length}): ${deterministicTerms.join(", ")}`);
console.error(`topicTermsA=${topicTermsA.length} topicTermsB=${topicTermsB.length}`);
console.error(`combinedA=${combinedA.length} chars, combinedB=${combinedB.length} chars`);

const packsA = run(combinedA, topicTermsA);
const packsB = run(combinedB, topicTermsB);

// --- parse doc URLs represented in each pack's text ---
function docUrlsInPack(text: string): string[] {
  const urls = new Set<string>();
  const re = /---\s*DOCUMENT:[\s\S]*?\[([^\]]+)\]\s*---/g;
  let m;
  while ((m = re.exec(text)) !== null) urls.add(m[1].trim());
  return [...urls];
}

const byIdA = new Map(packsA.map((p) => [p.measureId, p]));
const byIdB = new Map(packsB.map((p) => [p.measureId, p]));

const out = measures.map((meas: any) => {
  const a = byIdA.get(meas.measureId)!;
  const b = byIdB.get(meas.measureId)!;
  return {
    measureId: meas.measureId,
    title: meas.title,
    category: meas.category,
    A: { chunkCount: a.chunkCount, totalChars: a.totalChars, topicHits: a.topicHits, docUrls: docUrlsInPack(a.text), text: a.text },
    B: { chunkCount: b.chunkCount, totalChars: b.totalChars, topicHits: b.topicHits, docUrls: docUrlsInPack(b.text), text: b.text },
  };
});

writeFileSync(`${HOME}/ab_stage2_retrieval_patched.json`, JSON.stringify({
  meta: {
    deterministicTerms,
    topicTermsA_count: topicTermsA.length,
    topicTermsB_count: topicTermsB.length,
    currentTerms_count: currentTerms.length,
    improvedTerms_count: improvedTerms.length,
    combinedA_chars: combinedA.length,
    combinedB_chars: combinedB.length,
    existingDocs: existingCorpus.length,
    newDocs: newDocs.length,
  },
  measures: out,
}, null, 2));

// compact summary to stderr
for (const r of out) {
  console.error(`${r.measureId.padEnd(28)} A: ch=${r.A.chunkCount} hits=${r.A.topicHits} docs=${r.A.docUrls.length}  ->  B: ch=${r.B.chunkCount} hits=${r.B.topicHits} docs=${r.B.docUrls.length}`);
}
console.error("\nSAVED ab_stage2_retrieval_patched.json");

import type { FrameworkMeasure } from "../../shared/schema.js";
import type { TerminologyMap } from "./terminology-discovery.js";
import { flattenTerms } from "./terminology-discovery.js";

// ─── BM25 Implementation ─────────────────────────────────────────────────────

export interface BM25Index {
  documents: string[];
  docFreqs: Map<string, number>;
  docLengths: number[];
  avgDocLength: number;
  totalDocs: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function buildBM25Index(chunks: string[]): BM25Index {
  const docFreqs = new Map<string, number>();
  const docLengths: number[] = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk);
    docLengths.push(tokens.length);
    totalLength += tokens.length;

    const seen = new Set<string>();
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token);
        docFreqs.set(token, (docFreqs.get(token) || 0) + 1);
      }
    }
  }

  return {
    documents: chunks,
    docFreqs,
    docLengths,
    avgDocLength: totalLength / (chunks.length || 1),
    totalDocs: chunks.length,
  };
}

export function bm25Score(
  query: string[],
  docIndex: number,
  index: BM25Index,
  k1: number = 1.5,
  b: number = 0.75
): number {
  const docTokens = tokenize(index.documents[docIndex]);
  const docLength = index.docLengths[docIndex];
  let score = 0;

  // Count term frequencies in this document
  const termFreqs = new Map<string, number>();
  for (const token of docTokens) {
    termFreqs.set(token, (termFreqs.get(token) || 0) + 1);
  }

  for (const term of query) {
    const tf = termFreqs.get(term) || 0;
    if (tf === 0) continue;

    const df = index.docFreqs.get(term) || 0;
    const idf = Math.log((index.totalDocs - df + 0.5) / (df + 0.5) + 1);
    const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLength / index.avgDocLength)));
    score += idf * tfNorm;
  }

  return score;
}

// ─── Text Chunking ───────────────────────────────────────────────────────────

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      // Keep overlap
      const words = currentChunk.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(" ") + " " + sentence;
    } else {
      currentChunk += (currentChunk ? " " : "") + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

// ─── Evidence Pack Builder ───────────────────────────────────────────────────

export interface EvidencePack {
  measureId: string;
  text: string;
  chunkCount: number;
  totalChars: number;
}

export function buildEvidencePackForMeasure(opts: {
  measure: FrameworkMeasure;
  chunks: string[];
  bm25Index: BM25Index;
  terminology?: TerminologyMap;
  topK?: number;
  maxChars?: number;
}): EvidencePack {
  const { measure, chunks, bm25Index, terminology, topK = 10, maxChars = 8000 } = opts;

  // Build query terms from measure title + definition + evidence keywords + terminology
  const queryTerms: string[] = [
    ...tokenize(measure.title),
    ...(measure.definition ? tokenize(measure.definition) : []),
  ];

  // Add evidence keywords
  if (measure.evidenceKeywords) {
    for (const kw of measure.evidenceKeywords) {
      queryTerms.push(...tokenize(kw));
    }
  }

  // Add terminology terms relevant to this measure's category
  if (terminology) {
    const categoryLower = measure.category.toLowerCase();
    // Map terminology to categories
    if (categoryLower.includes("governance") || categoryLower.includes("oversight") || categoryLower.includes("board")) {
      queryTerms.push(...terminology.committees.flatMap(tokenize));
      queryTerms.push(...terminology.roles.flatMap(tokenize));
    }
    if (categoryLower.includes("strategy") || categoryLower.includes("policy") || categoryLower.includes("framework")) {
      queryTerms.push(...terminology.programmes.flatMap(tokenize));
      queryTerms.push(...terminology.productsAndPolicies.flatMap(tokenize));
    }
    // Always add all terms for broader coverage
    queryTerms.push(...terminology.otherTerms.flatMap(tokenize));
  }

  // Deduplicate query terms
  const uniqueTerms = [...new Set(queryTerms)];

  // Score all chunks
  const scored = chunks.map((chunk, idx) => ({
    idx,
    score: bm25Score(uniqueTerms, idx, bm25Index),
    text: chunk,
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top-K chunks up to maxChars
  let evidenceText = "";
  let chunkCount = 0;
  for (const item of scored.slice(0, topK)) {
    if (item.score <= 0) break;
    if (evidenceText.length + item.text.length > maxChars) break;
    evidenceText += item.text + "\n\n";
    chunkCount++;
  }

  return {
    measureId: measure.measureId,
    text: evidenceText.trim(),
    chunkCount,
    totalChars: evidenceText.length,
  };
}

// ─── Build Evidence Packs for All Measures in a Category ─────────────────────

export function buildEvidencePacksForCategory(opts: {
  measures: FrameworkMeasure[];
  combinedText: string;
  terminology?: TerminologyMap;
}): EvidencePack[] {
  const { measures, combinedText, terminology } = opts;

  const chunks = chunkText(combinedText);
  if (chunks.length === 0) return measures.map((m) => ({
    measureId: m.measureId,
    text: "",
    chunkCount: 0,
    totalChars: 0,
  }));

  const bm25Index = buildBM25Index(chunks);

  return measures.map((measure) =>
    buildEvidencePackForMeasure({
      measure,
      chunks,
      bm25Index,
      terminology,
    })
  );
}

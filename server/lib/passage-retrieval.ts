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

// ─── Topic-Relevance Signal (Layer B) ────────────────────────────────────────
// The core failure behind "full coverage / 0% score" was that a measure's
// evidence pack could be filled entirely with chunks that never mention the
// framework topic (e.g. AI). BM25 alone rewards generic governance/risk/strategy
// language, which is far more abundant in large historical filings than the
// sparse topic passages. We add an explicit topic-term signal so that, when the
// corpus DOES contain topic-relevant passages, they are preferred and guaranteed
// to reach the evidence pack.

// Default topic lexicon (AI / ML). Can be overridden per framework via
// `deriveTopicTerms`. Kept deliberately high-precision to avoid false matches.
const DEFAULT_AI_TOPIC_TERMS = [
  "ai", "a.i.", "artificial intelligence", "machine learning", "deep learning",
  "generative ai", "genai", "gen ai", "large language model", "llm", "llms",
  "neural network", "natural language processing", "nlp", "computer vision",
  "responsible ai", "ai governance", "ai strategy", "ai ethics", "ai risk",
  "ai model", "ai models", "ai system", "ai systems", "ai tool", "ai tools",
  "ai-powered", "ai powered", "ai-driven", "ai driven", "ai capabilities",
  "algorithmic", "automation", "predictive model", "foundation model",
  "chatbot", "copilot", "intelligent automation", "data science",
];

const TOPIC_TERM_PATTERN_CACHE = new Map<string, RegExp>();

function buildTopicRegex(terms: string[]): RegExp {
  const key = terms.join("|");
  const cached = TOPIC_TERM_PATTERN_CACHE.get(key);
  if (cached) return cached;
  // Escape and build a word-boundary-ish alternation. Multi-word terms allow
  // flexible whitespace; single tokens require boundaries to avoid "aid"→"ai".
  const parts = terms.map((t) => {
    const esc = t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    return /\s/.test(t) ? esc : `\\b${esc}\\b`;
  });
  const re = new RegExp(`(?:${parts.join("|")})`, "gi");
  TOPIC_TERM_PATTERN_CACHE.set(key, re);
  return re;
}

/**
 * Derive the topic lexicon for a framework. For AI-related frameworks we use the
 * AI lexicon (plus any framework search-term hints); otherwise we fall back to
 * tokens drawn from the topic description so the mechanism stays generic.
 */
export function deriveTopicTerms(topicDescription?: string, frameworkName?: string): string[] {
  const haystack = `${topicDescription || ""} ${frameworkName || ""}`.toLowerCase();
  const isAI = /artificial intelligence|\bai\b|machine learning|generative|responsible ai|ai governance|ai strategy|\bllm\b|\bgenai\b/.test(haystack);
  if (isAI || !topicDescription) return DEFAULT_AI_TOPIC_TERMS;
  // Generic fallback: use distinctive multi-char tokens from the topic description.
  const generic = [...new Set(tokenize(topicDescription))].filter((t) => t.length >= 4).slice(0, 40);
  return generic.length > 0 ? generic : DEFAULT_AI_TOPIC_TERMS;
}

/** Count topic-term occurrences in a piece of text. */
export function countTopicHits(text: string, topicTerms: string[]): number {
  if (!text) return 0;
  const re = buildTopicRegex(topicTerms);
  const m = text.match(re);
  return m ? m.length : 0;
}

// ─── Document-Aware Text Chunking (Layer C) ──────────────────────────────────

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

// The analyzer joins documents with headers of the form:
//   "\n\n--- DOCUMENT: <title> [<url>] ---\n\n<text>"
// We split on that marker so each chunk can be attributed to a source document,
// which enables per-document budgeting (no single huge filing can dominate).
const DOC_HEADER_RE = /\n*---\s*DOCUMENT:\s*([\s\S]*?)\s*---\n*/g;

export interface Chunk {
  text: string;
  docIndex: number; // which source document this chunk came from
}

function splitIntoDocuments(combinedText: string): Array<{ header: string; body: string }> {
  const segments: Array<{ header: string; body: string }> = [];
  let lastIndex = 0;
  let lastHeader = "Document 1";
  let match: RegExpExecArray | null;
  DOC_HEADER_RE.lastIndex = 0;
  let foundAny = false;

  while ((match = DOC_HEADER_RE.exec(combinedText)) !== null) {
    foundAny = true;
    const body = combinedText.slice(lastIndex, match.index);
    if (body.trim()) segments.push({ header: lastHeader, body });
    lastHeader = (match[1] || "").trim() || `Document ${segments.length + 1}`;
    lastIndex = DOC_HEADER_RE.lastIndex;
  }
  // Trailing body after the last header (or the whole text if no headers).
  const tail = combinedText.slice(lastIndex);
  if (tail.trim()) segments.push({ header: lastHeader, body: tail });

  if (!foundAny && segments.length === 0 && combinedText.trim()) {
    segments.push({ header: "Document 1", body: combinedText });
  }
  return segments;
}

/** Chunk a single text body (sentence-aware with overlap). */
function chunkBody(text: string): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      const words = currentChunk.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(" ") + " " + sentence;
    } else {
      currentChunk += (currentChunk ? " " : "") + sentence;
    }
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trim());
  return chunks;
}

/** Backward-compatible flat chunker (text only). */
export function chunkText(text: string): string[] {
  return chunkDocuments(text).map((c) => c.text);
}

/** Document-aware chunker: returns chunks tagged with their source doc index. */
export function chunkDocuments(combinedText: string): Chunk[] {
  const docs = splitIntoDocuments(combinedText);
  const out: Chunk[] = [];
  docs.forEach((doc, docIndex) => {
    for (const c of chunkBody(doc.body)) {
      out.push({ text: c, docIndex });
    }
  });
  return out;
}

// ─── Evidence Pack Builder ───────────────────────────────────────────────────

export interface EvidencePack {
  measureId: string;
  text: string;
  chunkCount: number;
  totalChars: number;
  topicHits: number; // Layer D: how many topic mentions actually reached the pack
}

// Tunables (env-overridable so behavior can be adjusted without a code change).
const TOPIC_RELEVANCE_WEIGHT = parseFloat(process.env.RETRIEVAL_TOPIC_WEIGHT || "2.0");
const MAX_CHUNKS_PER_DOC = parseInt(process.env.RETRIEVAL_MAX_CHUNKS_PER_DOC || "5", 10);
const GUARANTEED_TOPIC_CHUNKS = parseInt(process.env.RETRIEVAL_GUARANTEED_TOPIC_CHUNKS || "4", 10);

// Per-measure evidence budget. Previously hardcoded at topK=12 / maxChars=8000
// (~2K tokens), which capped how much of the fetched corpus each question could
// ever "see". Raising these lets the scorer examine substantially more evidence
// per measure. Env-overridable so it can be tuned without a redeploy.
const EVIDENCE_TOP_K = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "20", 10);
const EVIDENCE_MAX_CHARS = parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "20000", 10);

export function buildEvidencePackForMeasure(opts: {
  measure: FrameworkMeasure;
  chunks: Chunk[];
  bm25Index: BM25Index;
  terminology?: TerminologyMap;
  topicTerms?: string[];
  topK?: number;
  maxChars?: number;
  maxChunksPerDoc?: number;
}): EvidencePack {
  const {
    measure,
    chunks,
    bm25Index,
    terminology,
    topicTerms = DEFAULT_AI_TOPIC_TERMS,
    topK = EVIDENCE_TOP_K,
    maxChars = EVIDENCE_MAX_CHARS,
    maxChunksPerDoc = MAX_CHUNKS_PER_DOC,
  } = opts;

  // Build query terms from measure title + definition + evidence keywords + terminology
  const queryTerms: string[] = [
    ...tokenize(measure.title),
    ...(measure.definition ? tokenize(measure.definition) : []),
  ];

  if (measure.evidenceKeywords) {
    for (const kw of measure.evidenceKeywords) {
      queryTerms.push(...tokenize(kw));
    }
  }

  if (terminology) {
    const categoryLower = measure.category.toLowerCase();
    if (categoryLower.includes("governance") || categoryLower.includes("oversight") || categoryLower.includes("board")) {
      queryTerms.push(...terminology.committees.flatMap(tokenize));
      queryTerms.push(...terminology.roles.flatMap(tokenize));
    }
    if (categoryLower.includes("strategy") || categoryLower.includes("policy") || categoryLower.includes("framework")) {
      queryTerms.push(...terminology.programmes.flatMap(tokenize));
      queryTerms.push(...terminology.productsAndPolicies.flatMap(tokenize));
    }
    queryTerms.push(...terminology.otherTerms.flatMap(tokenize));
  }

  const uniqueTerms = [...new Set(queryTerms)];

  // Score all chunks: BM25 relevance + an explicit topic-relevance bonus (Layer B).
  // The topic bonus scales with the density of topic mentions in the chunk, so a
  // chunk that actually discusses AI is preferred over generic boilerplate that
  // merely shares query words. We compute a normalized topic signal per chunk.
  const scored = chunks.map((chunk, idx) => {
    const bm25 = bm25Score(uniqueTerms, idx, bm25Index);
    const hits = countTopicHits(chunk.text, topicTerms);
    // Diminishing-returns topic bonus so a chunk doesn't win purely by repetition.
    const topicBonus = hits > 0 ? TOPIC_RELEVANCE_WEIGHT * (1 + Math.log(hits)) : 0;
    return {
      idx,
      docIndex: chunk.docIndex,
      bm25,
      topicHits: hits,
      score: bm25 + topicBonus,
      text: chunk.text,
    };
  });

  // Primary ranking by blended score (desc).
  scored.sort((a, b) => b.score - a.score);

  // ─── Selection with per-document budgeting (Layer C) + topic floor (Layer B)
  const perDocCount = new Map<number, number>();
  const selected: typeof scored = [];
  let evidenceLen = 0;

  const tryAdd = (item: (typeof scored)[number]): boolean => {
    if (selected.includes(item)) return false;
    if (selected.length >= topK) return false;
    if (evidenceLen + item.text.length > maxChars) return false;
    const used = perDocCount.get(item.docIndex) || 0;
    if (used >= maxChunksPerDoc) return false;
    selected.push(item);
    perDocCount.set(item.docIndex, used + 1);
    evidenceLen += item.text.length + 2;
    return true;
  };

  // Step 1 — Topic floor: guarantee a few of the most topic-dense chunks are in
  // the pack whenever the corpus contains ANY topic-relevant passages. This is
  // the direct fix for "0% with full coverage": the model will always see the
  // available AI evidence instead of being starved by generic boilerplate.
  const topicChunks = scored
    .filter((s) => s.topicHits > 0)
    .sort((a, b) => (b.topicHits - a.topicHits) || (b.score - a.score));
  let topicAdded = 0;
  for (const item of topicChunks) {
    if (topicAdded >= GUARANTEED_TOPIC_CHUNKS) break;
    // Relax the per-doc cap slightly for the guaranteed topic floor so a single
    // AI-rich filing can still seed the pack, but never beyond maxChunksPerDoc+1.
    const used = perDocCount.get(item.docIndex) || 0;
    if (used >= maxChunksPerDoc + 1) continue;
    if (selected.length >= topK) break;
    if (evidenceLen + item.text.length > maxChars) continue;
    selected.push(item);
    perDocCount.set(item.docIndex, used + 1);
    evidenceLen += item.text.length + 2;
    topicAdded++;
  }

  // Step 2 — Fill remaining slots by blended score, respecting per-doc budget.
  for (const item of scored) {
    if (item.score <= 0 && item.topicHits === 0) continue;
    tryAdd(item);
    if (selected.length >= topK || evidenceLen >= maxChars) break;
  }

  // Preserve document order in the final text for readability.
  selected.sort((a, b) => (a.docIndex - b.docIndex) || (a.idx - b.idx));

  let evidenceText = "";
  let packTopicHits = 0;
  for (const item of selected) {
    evidenceText += item.text + "\n\n";
    packTopicHits += item.topicHits;
  }

  return {
    measureId: measure.measureId,
    text: evidenceText.trim(),
    chunkCount: selected.length,
    totalChars: evidenceText.length,
    topicHits: packTopicHits,
  };
}

// ─── Build Evidence Packs for All Measures in a Category ─────────────────────

export interface CategoryEvidenceResult {
  packs: EvidencePack[];
  corpusTopicChunks: number; // # chunks in the corpus containing topic terms
  corpusChunks: number;
}

export function buildEvidencePacksForCategory(opts: {
  measures: FrameworkMeasure[];
  combinedText: string;
  terminology?: TerminologyMap;
  topicTerms?: string[];
  topK?: number;
  maxChars?: number;
}): EvidencePack[] {
  const { measures, combinedText, terminology, topicTerms = DEFAULT_AI_TOPIC_TERMS, topK, maxChars } = opts;

  const chunks = chunkDocuments(combinedText);
  if (chunks.length === 0) {
    return measures.map((m) => ({
      measureId: m.measureId,
      text: "",
      chunkCount: 0,
      totalChars: 0,
      topicHits: 0,
    }));
  }

  const bm25Index = buildBM25Index(chunks.map((c) => c.text));

  return measures.map((measure) =>
    buildEvidencePackForMeasure({
      measure,
      chunks,
      bm25Index,
      terminology,
      topicTerms,
      topK,
      maxChars,
    })
  );
}

/**
 * Layer D helper — corpus-level topic statistics, used to compute an honest
 * coverage/evidence signal (topic evidence actually present, not document count).
 */
export function computeCorpusTopicStats(combinedText: string, topicTerms: string[] = DEFAULT_AI_TOPIC_TERMS): {
  totalChunks: number;
  topicChunks: number;
  topicHits: number;
} {
  const chunks = chunkDocuments(combinedText);
  let topicChunks = 0;
  let topicHits = 0;
  for (const c of chunks) {
    const h = countTopicHits(c.text, topicTerms);
    if (h > 0) topicChunks++;
    topicHits += h;
  }
  return { totalChunks: chunks.length, topicChunks, topicHits };
}

export { DEFAULT_AI_TOPIC_TERMS };

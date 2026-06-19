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

// CJK Unicode ranges: CJK Unified Ideographs, Extension A, Hiragana, Katakana,
// Hangul syllables, and CJK compatibility. Used to detect characters that have
// no whitespace word boundaries.
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/**
 * Tokenizer with CJK support.
 *
 * The previous tokenizer split on whitespace only, so a Chinese/Japanese/Korean
 * paragraph (which has no spaces) collapsed into ~1 token — BM25 term overlap with
 * an English/translated query was ~0, so no relevant CJK chunk could ever surface
 * (the root of the systematic zero-scoring of Chinese-listed issuers).
 *
 * We now: (1) keep ASCII word tokens (length > 2) as before, and (2) for every run
 * of CJK characters, emit overlapping character BIGRAMS (and the single chars as a
 * fallback for 1-char runs). Character n-grams are the standard, language-model-free
 * way to make BM25 work on unsegmented CJK text and restore query/document overlap.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // ASCII / Latin word tokens: replace CJK with spaces first so they don't glue
  // onto Latin tokens, then strip punctuation and split on whitespace.
  const asciiTokens = lower
    .replace(CJK_RUN, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // CJK character-bigram tokens.
  const cjkTokens: string[] = [];
  const runs = lower.match(CJK_RUN);
  if (runs) {
    for (const run of runs) {
      if (run.length === 1) {
        cjkTokens.push(run);
      } else {
        for (let i = 0; i < run.length - 1; i++) {
          cjkTokens.push(run.slice(i, i + 2));
        }
      }
    }
  }

  return asciiTokens.concat(cjkTokens);
}

/** True if the text contains any CJK characters. */
export function hasCJK(text: string): boolean {
  return CJK_CHAR.test(text);
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
  "frontier model", "transformer model", "diffusion model", "ai-enabled",
  "chatbot", "copilot", "intelligent automation", "data science",
  // Multilingual AI terms so foreign-language passages are recognized by the
  // topic floor (French, German, Spanish, Italian, Portuguese, Dutch, Nordic,
  // Japanese, Chinese, Korean). High-precision terms only.
  "intelligence artificielle", // FR
  "k\u00fcnstliche intelligenz", "ki-strategie", "ki-governance", // DE
  "inteligencia artificial", // ES
  "intelligenza artificiale", // IT
  "intelig\u00eancia artificial", // PT
  "kunstmatige intelligentie", // NL
  "artificiell intelligens", "teko\u00e4ly", "kunstig intelligens", // SV/FI/DA-NO
  "\u4eba\u5de5\u77e5\u80fd", "\u751f\u6210ai", // JA (artificial intelligence, generative AI)
  "\u4eba\u5de5\u667a\u80fd", "\u4eba\u5de5\u667a\u6167", // ZH-CN / ZH-TW
  "\uc778\uacf5\uc9c0\ub2a5", // KO
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
    // Multi-word terms: match as-is (flexible whitespace).
    if (/\s/.test(t)) return esc;
    // ASCII single tokens: use word boundaries to avoid "aid"→"ai".
    // Non-ASCII single tokens (e.g. CJK 人工知能) have no ASCII \b boundary,
    // so match them directly — \b would never fire and the term would be lost.
    if (/^[\x00-\x7f]+$/.test(t)) return `\\b${esc}\\b`;
    return esc;
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
  section?: string; // SEC item heading this chunk belongs to (e.g. "item1a"), if any
}

// ─── SEC Section Awareness ───────────────────────────────────────────────────
// A 10-K is one large blob; the chunker was section-blind, so risk-factor language
// in Item 1A competed with the whole filing under BM25 and was often crowded out
// for risk/oversight measures. We detect SEC item headings at the start of a line
// and tag every subsequent chunk with the current section until the next heading.
//
// Heading examples we match (case-insensitive, line-anchored):
//   "Item 1A. Risk Factors", "ITEM 7. Management's Discussion", "Item 7A."
// We normalize to a compact key like "item1a", "item7", "item7a".
const SEC_ITEM_HEADING_RE = /^\s*item\s+(\d{1,2}[a-c]?)\b[\.\:\s\-—]/i;

function normalizeSecItem(raw: string): string {
  return "item" + raw.toLowerCase().replace(/\s+/g, "");
}

/** Detect the SEC item heading at the start of a text block, if present. */
export function detectSecSection(block: string): string | undefined {
  // Inspect the first few lines only — headings appear at the top of a section.
  const head = block.split(/\n/, 6).join("\n");
  const lines = head.split(/\n/);
  for (const line of lines) {
    const m = SEC_ITEM_HEADING_RE.exec(line);
    if (m) return normalizeSecItem(m[1]);
  }
  return undefined;
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

/**
 * Chunk a single text body (sentence-aware with overlap), tracking the current
 * SEC item section. We split on sentence boundaries AND newlines so that
 * line-anchored item headings are detectable; whenever a fragment begins a new
 * SEC item, the active section flips and subsequent chunks inherit it.
 */
function chunkBody(text: string): Array<{ text: string; section?: string }> {
  const chunks: Array<{ text: string; section?: string }> = [];
  // Split on sentence boundaries while preserving newlines as their own break so
  // headings on their own line are seen as fragment starts.
  const fragments = text.split(/(?<=[.!?])\s+|\n+/);
  let currentChunk = "";
  let currentSection: string | undefined = undefined;
  let chunkStartSection: string | undefined = undefined;

  const flush = () => {
    if (currentChunk.trim()) {
      chunks.push({ text: currentChunk.trim(), section: chunkStartSection });
    }
  };

  for (const fragment of fragments) {
    if (!fragment) continue;
    // Detect a section heading at the start of this fragment.
    const m = SEC_ITEM_HEADING_RE.exec(fragment);
    if (m) currentSection = normalizeSecItem(m[1]);

    if (currentChunk.length + fragment.length > CHUNK_SIZE && currentChunk.length > 0) {
      flush();
      const words = currentChunk.split(/\s+/);
      const overlapWords = words.slice(-Math.floor(CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(" ") + " " + fragment;
      chunkStartSection = currentSection;
    } else {
      if (currentChunk.length === 0) chunkStartSection = currentSection;
      currentChunk += (currentChunk ? " " : "") + fragment;
    }
  }
  flush();
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
      out.push({ text: c.text, docIndex, section: c.section });
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

// ─── Per-Measure SEC Section Relevance ───────────────────────────────────────
// Map a measure to the SEC 10-K item sections most likely to contain its evidence,
// based on the measure's category/title. Chunks tagged with a relevant section get
// a BM25 bonus so risk-factor (Item 1A) / MD&A (Item 7/7A) / governance (Item 10/11)
// passages surface for the right questions instead of being crowded out by the
// undifferentiated filing blob. Returns an empty set when no section applies (so
// non-SEC corpora are unaffected).
function relevantSecSections(measure: FrameworkMeasure): Set<string> {
  const hay = `${measure.category} ${measure.title} ${measure.definition || ""}`.toLowerCase();
  const out = new Set<string>();
  // Hard-pin the 9.x family (AI risk disclosure & capital allocation) to the
  // filing sections it must come from, so the section boost + force-include below
  // always apply even if the title/definition wording is terse.
  if (/^9\./.test(measure.measureId)) {
    out.add("item1a");
    out.add("item7");
    out.add("item7a");
  }
  // Risk identification / risk factors / material risks → Item 1A (and 7/7A).
  if (/risk|threat|vulnerab|material|uncertaint|mitigat|exposure|incident|safety|harm/.test(hay)) {
    out.add("item1a");
    out.add("item7");
    out.add("item7a");
  }
  // Strategy / management discussion / operations / investment → Item 7 (MD&A) & 1.
  if (/strateg|management|operation|invest|deploy|adopt|business|opportunit|performance/.test(hay)) {
    out.add("item7");
    out.add("item1");
  }
  // Governance / board / oversight / committee / accountability → Item 10 & 11.
  if (/governance|board|oversight|committee|director|accountab|ethic|policy|responsib|compliance/.test(hay)) {
    out.add("item10");
    out.add("item11");
  }
  return out;
}

// True when a measure's definition specifically requires a regulatory annual
// filing (10-K / 20-F / annual report risk factors). Used to force-include the
// top Item 1A chunk so filing-specific measures (the 9.x family) can never be
// starved by keyword-dense non-regulatory documents.
function requiresRegulatoryFiling(measure: FrameworkMeasure): boolean {
  const hay = `${measure.measureId} ${measure.title} ${measure.definition || ""}`.toLowerCase();
  return /^9\.|10-?k|20-?f|form\s*10|annual report|risk-?factor|risk factor|regulatory filing|securities filing/.test(hay);
}

// Heuristic: does this chunk look like it came from a real 10-K/20-F risk-factor
// section? We require the Item 1A section tag OR explicit risk-factor language,
// AND at least one AI/ML topic term, so we never force in an irrelevant chunk.
function looksLike10KRiskChunk(chunkText: string, section: string | undefined, topicTerms: string[]): boolean {
  const t = chunkText.toLowerCase();
  const isRiskSection = section === "item1a" || /risk factors|item\s*1a/.test(t);
  if (!isRiskSection) return false;
  return countTopicHits(chunkText, topicTerms) > 0;
}

// Tunables (env-overridable so behavior can be adjusted without a code change).
const TOPIC_RELEVANCE_WEIGHT = parseFloat(process.env.RETRIEVAL_TOPIC_WEIGHT || "2.0");
// Additive bonus applied to a chunk's blended score when its SEC section matches
// one of the measure's relevant sections. Tuned to be comparable to the topic
// bonus so on-section evidence is preferred without overwhelming BM25 relevance.
const SEC_SECTION_BOOST = parseFloat(process.env.RETRIEVAL_SECTION_BOOST || "2.5");
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

  // SEC section relevance for this measure (empty for non-SEC corpora / measures).
  const measureSections = relevantSecSections(measure);

  // Score all chunks: BM25 relevance + an explicit topic-relevance bonus (Layer B)
  // + a SEC section bonus (Concern 2) when the chunk's tagged 10-K item matches one
  // of the measure's relevant sections (e.g. risk measures → Item 1A). The section
  // bonus only applies when (a) the chunk is section-tagged and (b) it is relevant,
  // so non-SEC documents and off-section chunks are unaffected.
  const scored = chunks.map((chunk, idx) => {
    const bm25 = bm25Score(uniqueTerms, idx, bm25Index);
    const hits = countTopicHits(chunk.text, topicTerms);
    // Diminishing-returns topic bonus so a chunk doesn't win purely by repetition.
    const topicBonus = hits > 0 ? TOPIC_RELEVANCE_WEIGHT * (1 + Math.log(hits)) : 0;
    const onSection = !!(chunk.section && measureSections.has(chunk.section));
    const sectionBonus = onSection ? SEC_SECTION_BOOST : 0;
    return {
      idx,
      docIndex: chunk.docIndex,
      bm25,
      topicHits: hits,
      score: bm25 + topicBonus + sectionBonus,
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

  // Step 0 — Regulatory-filing guarantee (Concern 2 residual fix).
  // For measures that explicitly require a 10-K/20-F (the 9.x family), force the
  // single best 10-K Item 1A risk chunk into the pack BEFORE anything else, so it
  // can never be displaced by keyword-dense sustainability/governance documents.
  if (requiresRegulatoryFiling(measure)) {
    const filingCandidate = scored
      .filter((s) => looksLike10KRiskChunk(s.text, chunks[s.idx].section, topicTerms))
      .sort((a, b) => b.score - a.score)[0];
    if (filingCandidate && evidenceLen + filingCandidate.text.length <= maxChars) {
      selected.push(filingCandidate);
      perDocCount.set(filingCandidate.docIndex, (perDocCount.get(filingCandidate.docIndex) || 0) + 1);
      evidenceLen += filingCandidate.text.length + 2;
    }
  }

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

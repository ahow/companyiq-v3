import type { FrameworkMeasure } from "../../shared/schema.js";
import { createHash } from "crypto";
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

// v3g (Bug 1): pull the [<url>] out of a document header label so each chunk can
// carry the stable source-document identity. Header label looks like
// "<title> [<url>]"; the URL is the last bracketed group.
function extractDocUrlFromHeader(headerLabel: string): string | undefined {
  const m = headerLabel.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1].trim() : undefined;
}

export interface Chunk {
  text: string;
  docIndex: number; // which source document this chunk came from
  docUrl?: string;  // v3g (Bug 1): stable source-document URL parsed from the
                    // "--- DOCUMENT: <title> [<url>] ---" header. Used to build a
                    // CONTENT-STABLE evidence fingerprint that does not collide
                    // across companies (positional docIndex/chunkIdx alone did).
  docTitle?: string; // v3g (quote sourceUrl fix): source-document title (sans the
                     // bracketed URL) so the evidence pack can re-emit a per-chunk
                     // "--- DOCUMENT: <title> [<url>] ---" header for provenance.
  seqInDoc?: number; // sequential index of this chunk WITHIN its source document.
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

// REVIEWER FIX (v3d, issue #1/#4): plain-text extraction of EDGAR HTML frequently
// renders item headings INLINE ("...the following risk factors. Item 1A. Risk
// Factors The Company...") rather than on their own line, and may use a
// non-breaking space ("Item\u00a01A") or no space ("Item1A"). The line-anchored
// regex above missed all of these, so Item 1A was never tagged for several
// large 10-Ks (Alphabet/Amazon/Oracle/Salesforce) and the force-include found no
// candidate. We add an INLINE detector that pairs the item number with its
// canonical section title, which is unambiguous and TOC-safe.
//
// Canonical 10-K item titles we anchor on (item number -> title regex):
const SEC_ITEM_TITLES: Array<{ item: string; re: RegExp }> = [
  { item: "item1a", re: /item[\s\u00a0]*1a\b[\.\:\s\-—]{0,3}\s*risk\s+factors/i },
  { item: "item1b", re: /item[\s\u00a0]*1b\b[\.\:\s\-—]{0,3}\s*unresolved\s+staff/i },
  { item: "item7a", re: /item[\s\u00a0]*7a\b[\.\:\s\-—]{0,3}\s*quantitative\s+and\s+qualitative/i },
  { item: "item7", re: /item[\s\u00a0]*7\b[\.\:\s\-—]{0,3}\s*management['’]?s\s+discussion/i },
  { item: "item1", re: /item[\s\u00a0]*1\b[\.\:\s\-—]{0,3}\s*business\b/i },
  { item: "item10", re: /item[\s\u00a0]*10\b[\.\:\s\-—]{0,3}\s*directors[,\s]/i },
  { item: "item11", re: /item[\s\u00a0]*11\b[\.\:\s\-—]{0,3}\s*executive\s+compensation/i },
];

// A line that is really a table-of-contents entry, e.g.
//   "Item 1A. Risk Factors .......... 23"  or  "Item 1A Risk Factors 23"
// ends in a (dotted) page number. We must NOT flip the active section on these,
// otherwise the section tag jumps to the TOC location, not the real section body.
const TOC_LINE_RE = /\.{2,}\s*\d+\s*$|\s\d{1,4}\s*$/;

function normalizeSecItem(raw: string): string {
  return "item" + raw.toLowerCase().replace(/\s+/g, "");
}

// Detect an SEC item heading inside an arbitrary text fragment. Prefers the
// unambiguous "item N + canonical title" inline match; falls back to a
// line-anchored "Item N." only when that line is NOT a TOC entry. Returns the
// FIRST (left-most) match so the active section reflects where the body begins.
// A fragment/line that lists 2+ "Item N" tokens is almost certainly a table of
// contents ("...Item 1 Business 4 Item 1A Risk Factors 23 Item 7..."), never a
// real section start. We must not flip the active section on these.
const MULTI_ITEM_RE = /item[\s\u00a0]*\d{1,2}[a-c]?\b/gi;
function isLikelyToc(fragment: string): boolean {
  const matches = fragment.match(MULTI_ITEM_RE);
  if (matches && matches.length >= 2) return true;
  return TOC_LINE_RE.test(fragment.trim());
}

function detectSecHeadingInFragment(fragment: string): string | undefined {
  // Guard: multi-item or page-numbered lines are TOC entries, not section starts.
  if (isLikelyToc(fragment)) return undefined;
  // Prefer the RIGHTMOST (last) title-anchored heading in the fragment, so a real
  // "Item 1A. Risk Factors" that follows earlier prose wins over an earlier item.
  let best: { item: string; idx: number } | undefined;
  for (const { item, re } of SEC_ITEM_TITLES) {
    const m = re.exec(fragment);
    if (m && /risk\s+factors|management|quantitative|business|directors|executive\s+compensation|unresolved/i.test(m[0])) {
      if (!best || m.index > best.idx) best = { item, idx: m.index };
    }
  }
  if (best) return best.item;
  // Fallback: a bare "Item N." heading (non-TOC, single item).
  const lm = SEC_ITEM_HEADING_RE.exec(fragment);
  if (lm) return normalizeSecItem(lm[1]);
  return undefined;
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

function extractDocTitleFromHeader(headerLabel: string): string {
  // Header label looks like "<title> [<url>]"; strip the trailing bracketed URL.
  return headerLabel.replace(/\s*\[[^\]]+\]\s*$/, "").trim() || headerLabel.trim();
}

function splitIntoDocuments(combinedText: string): Array<{ header: string; body: string; url?: string; title?: string }> {
  const segments: Array<{ header: string; body: string; url?: string; title?: string }> = [];
  let lastIndex = 0;
  let lastHeader = "Document 1";
  let match: RegExpExecArray | null;
  DOC_HEADER_RE.lastIndex = 0;
  let foundAny = false;

  while ((match = DOC_HEADER_RE.exec(combinedText)) !== null) {
    foundAny = true;
    const body = combinedText.slice(lastIndex, match.index);
    if (body.trim()) segments.push({ header: lastHeader, body, url: extractDocUrlFromHeader(lastHeader), title: extractDocTitleFromHeader(lastHeader) });
    lastHeader = (match[1] || "").trim() || `Document ${segments.length + 1}`;
    lastIndex = DOC_HEADER_RE.lastIndex;
  }
  // Trailing body after the last header (or the whole text if no headers).
  const tail = combinedText.slice(lastIndex);
  if (tail.trim()) segments.push({ header: lastHeader, body: tail, url: extractDocUrlFromHeader(lastHeader), title: extractDocTitleFromHeader(lastHeader) });

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
// v3e (Section 2): PDF section-recovery. Plain-text extracted from a 10-K PDF
// frequently loses the line structure the heading detectors rely on, so Item 1A
// (and 7/7A) headings sit mid-line and go untagged. When a body clearly looks like
// an SEC annual filing (canonical item titles present somewhere) but the normal
// fragment scan would miss them, we NORMALIZE the text by inserting a newline
// immediately before each canonical "Item NA. <Title>" heading. This makes the
// existing, well-tested line/fragment detectors fire without changing their logic.
// Topic-agnostic: it only restores SEC structural headings, never topic keywords.
function recoverSecHeadingNewlines(text: string): string {
  // Cheap pre-check: only do work if at least one canonical item title appears.
  let hasCanonical = false;
  for (const { re } of SEC_ITEM_TITLES) { if (re.test(text)) { hasCanonical = true; break; } }
  if (!hasCanonical) return text;
  let out = text;
  // Insert a break before each canonical heading occurrence so it starts a fragment.
  for (const { re } of SEC_ITEM_TITLES) {
    const g = new RegExp(re.source, "gi");
    out = out.replace(g, (m) => `\n${m}`);
  }
  // Also break before bare "Item NA." forms that are followed by capitalized prose
  // (covers titles we don't enumerate), but NOT inside an obvious TOC dotted line.
  out = out.replace(/([^\n])\s+(item[\s\u00a0]*\d{1,2}[a-c]?[\.\:][\s\u00a0]*[A-Z])/gi, "$1\n$2");
  return out;
}

function chunkBody(rawText: string): Array<{ text: string; section?: string }> {
  // v3e (Section 2): recover SEC item-heading line structure for PDF-extracted
  // filings so Item 1A is taggable even when extraction flattened the headings.
  const text = recoverSecHeadingNewlines(rawText);
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

  for (let fi = 0; fi < fragments.length; fi++) {
    const fragment = fragments[fi];
    if (!fragment) continue;
    // Detect a section heading anywhere in this fragment (inline or line-anchored,
    // TOC-suppressed). REVIEWER FIX v3d: previously only the start-of-fragment
    // line-anchored form was detected, which missed inline EDGAR headings. The
    // sentence splitter also separates "Item 1A." from its title "Risk Factors"
    // (two fragments), so we detect over a small look-ahead window that re-joins
    // this fragment with the next one before testing the title-anchored pattern.
    const lookAhead = (fragment + " " + (fragments[fi + 1] || "")).slice(0, 160);
    const detected = detectSecHeadingInFragment(fragment) || detectSecHeadingInFragment(lookAhead);
    if (detected && detected !== currentSection) {
      // A NEW section begins here. REVIEWER FIX v3d: start a fresh chunk at the
      // heading so each SEC item's body becomes its own retrievable, correctly
      // tagged unit (Item 1A indexed separately), instead of being merged into a
      // neighbouring section's chunk and mis-tagged by a later heading.
      if (currentChunk.trim()) flush();
      currentChunk = "";
      currentSection = detected;
      chunkStartSection = detected;
    } else if (detected) {
      currentSection = detected;
      if (!chunkStartSection) chunkStartSection = detected;
    }

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
    let seqInDoc = 0;
    for (const c of chunkBody(doc.body)) {
      out.push({ text: c.text, docIndex, docUrl: doc.url, docTitle: doc.title, seqInDoc, section: c.section });
      seqInDoc++;
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
  // v3g (Bug 1): SHA1 over an EXPLICIT, CONTENT-STABLE identity:
  //   companyId | frameworkId | measureId | sorted(docUrl#seqInDoc#sha1(chunkText))
  // This is unique per (company, measure) and identical only when the genuine
  // evidence pack is identical, eliminating the cross-company positional
  // collisions of the old (docIndex:chunkIdx) scheme.
  fingerprint: string;
  // v3g (Bug 1): false when the pack has zero chunks (empty/degenerate). Empty
  // packs get a per-(company,measure) sentinel fingerprint and are NOT eligible
  // for verdict-cache reuse.
  fingerprintEligible: boolean;
  // v3j (Bug 2 deterministic force-include): how many chunks in this pack were
  // GUARANTEED into it by the source-type-aware force-include path (e.g. genuine
  // Item 1A body chunks for a 10-K-bound measure), regardless of retriever score.
  // The worker uses this to assert the invariant: every filing-bound measure whose
  // required document is present in corpus MUST have forceIncludedCount >= 1.
  forceIncludedCount: number;
  // Provenance for QA: the source-document URL the forced chunks came from (if any).
  forceIncludedDocUrl?: string;
  // True when the corpus contained a document matching this measure's required
  // source type (so a missing force-include is a real failure, not "nothing to do").
  requiredDocPresent: boolean;
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
  // v3e (Section 5): TOPIC-AGNOSTIC. When a template marks a measure as requiring a
  // periodic regulatory filing (via requiredSourceTypes), pin it to the risk/MD&A
  // sections it must come from, so the section boost + force-include always apply
  // regardless of topic or terse wording. This replaces the old hard-coded `9.x`
  // (AI-shaped) pin with a declarative, framework-driven signal.
  const reqTypes = ((measure as any).requiredSourceTypes || []) as string[];
  const isFilingBound = reqTypes.some((t) =>
    /regulatory|filing|10-?k|20-?f|annual|periodic/i.test(String(t)),
  );
  if (isFilingBound || /^9\./.test(measure.measureId)) {
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
  // v3e (Section 5): prefer the declarative requiredSourceTypes signal (topic-agnostic,
  // template-driven). Fall back to the legacy text heuristic for measures that have not
  // yet been annotated, so behavior is unchanged for un-migrated frameworks.
  const reqTypes = ((measure as any).requiredSourceTypes || []) as string[];
  if (reqTypes.some((t) => /regulatory|filing|10-?k|20-?f|annual|periodic/i.test(String(t)))) {
    return true;
  }
  const hay = `${measure.measureId} ${measure.title} ${measure.definition || ""}`.toLowerCase();
  return /^9\.|10-?k|20-?f|form\s*10|annual report|risk-?factor|risk factor|regulatory filing|securities filing/.test(hay);
}

// v3g (Bug 2): does this document URL/title look like a regulatory ANNUAL filing
// (10-K / 20-F / 40-F / annual report) — i.e. one that should contain an Item 1A
// (or equivalent) risk-factors section? Topic-agnostic; URL/title shape only.
function isRegulatoryAnnualFilingDoc(url: string | undefined, title: string | undefined): boolean {
  const s = `${url || ""} ${title || ""}`.toLowerCase();
  if (!s.trim()) return false;
  // v3j-r3: a PROXY statement (DEF 14A) is NOT an annual filing, even though it is
  // an EDGAR primary HTML doc and the greedy section tagger may stamp parts of it
  // as "item1a" (it cross-references the 10-K's Item 1A and contains governance/
  // compensation risk prose). Excluding proxies here keeps the 10-K (Item 1A) and
  // DEF 14A (board/governance) force-include paths cleanly separated by source type.
  if (isProxyDoc(url, title)) return false;
  // EDGAR primary-document archive shape: /archives/edgar/data/<cik>/<accession>/...
  const isEdgarPrimary = /sec\.gov\/archives\/edgar\/data\/\d+\//.test(s) && /\.htm/.test(s) && !/index\.htm|-index\.htm/.test(s);
  const looksAnnual = /10-?k|20-?f|40-?f|annual.?report|年度报告|年度報告|年报|年報/.test(s);
  // <ticker>-YYYYMMDD.htm EDGAR primary docs carry no form token in the name; treat
  // an EDGAR primary HTML document as a candidate annual filing (the recency/type
  // layer disambiguates which period it is). This is the Bug 2/3/5 unifier.
  return looksAnnual || isEdgarPrimary;
}

// Heuristic: does this chunk look like it came from a real 10-K/20-F risk-factor
// section? We require the Item 1A section tag OR explicit risk-factor language,
// AND at least one AI/ML topic term, so we never force in an irrelevant chunk.
function looksLike10KRiskChunk(chunkText: string, section: string | undefined, topicTerms: string[]): boolean {
  const t = chunkText.toLowerCase();
  // v3e (Section 5): TOPIC-AGNOSTIC softening. A chunk that the chunker positively
  // tagged as Item 1A is, by definition, the regulatory risk-factor section we want
  // to force-include — so accept it even with zero topic hits (the topicTerms are
  // framework-derived and may legitimately miss an issuer's idiosyncratic wording,
  // e.g. "machine learning" vs the framework's "artificial intelligence"). For the
  // weaker, untagged heuristics (b)/(c) we still require at least one framework topic
  // term so we never force in an unrelated risk paragraph.
  if (section === "item1a") return true;
  if (countTopicHits(chunkText, topicTerms) === 0) return false;
  if (/risk factors|item\s*1a/.test(t)) return true;
  const hasRiskProse = /(could|may|might)\s+(adversely|materially|negatively)\s+(affect|impact|harm)|adversely affect our|harm our business|risks (related to|associated with|relating to)|subject us to|expose us to|regulatory.{0,30}(risk|scrutiny|uncertaint)/.test(t);
  return hasRiskProse;
}

// ___ v3j (Bug 2): DETERMINISTIC source-type-aware force-include helpers ___
//
// Root cause of the partial Bug-2 fix (validator v3i): the prior force-include
// chose the Item 1A chunk that ranked highest under the PER-MEASURE BM25 query.
// For Risk Q1 the highest-scoring item1a-tagged chunk was frequently the TABLE
// OF CONTENTS block or a CROSS-REFERENCE -- both tagged item1a and mentioning
// "Risk Factors" but containing no actual risk-factor body prose -- so the grader
// saw no real disclosure and returned No / 0 quotes even though the 10-K Item 1A
// body was in the corpus. We now force-include GENUINE Item 1A BODY chunks by
// document POSITION, independent of the measure's query, so every filing-bound
// measure sees the same real Risk Factors text regardless of its phrasing.

// A chunk is a genuine Item 1A BODY chunk when it is item1a-tagged AND is not a
// table-of-contents block AND is not merely a cross-reference to Item 1A.
function isItem1aBodyChunk(chunk: Chunk): boolean {
  if (chunk.section !== "item1a") return false;
  // v3j-r3: reject item1a-tagged chunks whose source doc is identifiable as a PROXY
  // by URL/title. (Proxies whose filename is a bare <ticker>-YYYYMMDD.htm are caught
  // instead by the DOCUMENT-LEVEL proxy classifier in buildEvidencePackForMeasure,
  // which is robust and avoids stripping genuine 10-K Item 1A chunks that merely
  // mention "proxy"/"nominee" in passing.)
  if (isProxyDoc(chunk.docUrl, chunk.docTitle)) return false;
  const t = chunk.text;
  if (!t || t.length < 200) return false;
  if (isLikelyToc(t)) return false;
  const isCrossRefOnly =
    /(see|refer to|described in|discussed in|set forth in|contained in)[^.]{0,60}item[\s\u00a0]*1a/i.test(t) &&
    !/(could|may|might|would)\s+(adversely|materially|negatively|significantly)?\s*(affect|impact|harm|reduce|impair)|adversely affect our|harm our (business|reputation)|subject us to|expose us to|we (face|are subject to|may be unable)/i.test(t);
  if (isCrossRefOnly) return false;
  return true;
}

// Does this measure require a regulatory ANNUAL filing (10-K/20-F -> Item 1A)?
function measureRequiresAnnualFiling(measure: FrameworkMeasure): boolean {
  return requiresRegulatoryFiling(measure);
}

// Does this measure require a PROXY statement (DEF 14A -> board/governance)?
function measureRequiresProxy(measure: FrameworkMeasure): boolean {
  const reqTypes = ((measure as any).requiredSourceTypes || []) as string[];
  if (reqTypes.some((t) => /proxy|def.?14a|14a/i.test(String(t)))) return true;
  const hay = `${measure.measureId} ${measure.title} ${measure.definition || ""}`.toLowerCase();
  return /def\s*14a|proxy statement|proxy circular/.test(hay);
}

// Is this document a proxy statement (DEF 14A)? URL/title shape only.
function isProxyDoc(url: string | undefined, title: string | undefined): boolean {
  const s = `${url || ""} ${title || ""}`.toLowerCase();
  if (!s.trim()) return false;
  return /def.?14a|\bproxy\b|proxy.?statement|notice of annual meeting/.test(s);
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

// REVIEWER FIX v3d rec #1 (augment-not-displace): for regulatory-filing measures
// (9.x / risk-factor), the forced Item 1A chunk(s) are added on a DEDICATED extra
// budget on top of the normal pack, so guaranteeing Item 1A never evicts other
// supporting evidence. Force up to N chunks within EXTRA_CHARS of headroom.
const REG_FILING_FORCE_CHUNKS = parseInt(process.env.RETRIEVAL_REG_FILING_FORCE_CHUNKS || "2", 10);
const REG_FILING_EXTRA_CHARS = parseInt(process.env.RETRIEVAL_REG_FILING_EXTRA_CHARS || "4000", 10);

// v3j (Bug 2 deterministic force-include): number of GENUINE Item 1A body chunks
// to guarantee into a 10-K-bound measure's pack by document position, and the
// dedicated extra character budget reserved for them (separate from the normal
// pack budget so the guarantee never evicts other supporting evidence). N=3 per
// the validator's Section 2.4 prescription.
const FORCE_INCLUDE_CHUNKS = parseInt(process.env.RETRIEVAL_FORCE_INCLUDE_CHUNKS || "4", 10);
const FORCE_INCLUDE_EXTRA_CHARS = parseInt(process.env.RETRIEVAL_FORCE_INCLUDE_EXTRA_CHARS || "9000", 10);

export function buildEvidencePackForMeasure(opts: {
  measure: FrameworkMeasure;
  chunks: Chunk[];
  bm25Index: BM25Index;
  terminology?: TerminologyMap;
  topicTerms?: string[];
  topK?: number;
  maxChars?: number;
  maxChunksPerDoc?: number;
  // v3g (Bug 1): explicit identity for a collision-free fingerprint.
  companyId?: number | string;
  frameworkId?: number | string;
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
    companyId,
    frameworkId,
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

  // Step 0 — v3j DETERMINISTIC, DOCUMENT-ANCHORED, POSITION-BASED force-include.
  //
  // (Replaces the v3g query-ranked recovery, which selected the highest-BM25
  // item1a-tagged chunk for the measure — frequently the TOC block or a
  // cross-reference — so Salesforce/Meta/Amazon Risk Q1 saw no real Item 1A body
  // and scored No / 0 quotes despite the 10-K being in the corpus.)
  //
  // The new contract (validator v3i Section 2.4): when a measure requires a given
  // source type AND the corpus contains a matching document, GUARANTEE the top-N
  // GENUINE body chunks from THE BEST matching document into the pack — chosen by
  // DOCUMENT POSITION (earliest body chunks first), independent of the measure's
  // BM25 query. This makes Risk Q1–Q4 all see the same real Risk Factors text
  // regardless of phrasing, and is topic-agnostic so it generalises to any future
  // measure with a hard requiredSourceTypes constraint (e.g. Board Q1 → DEF 14A).
  let forceIncludedCount = 0;
  let forceIncludedDocUrl: string | undefined;
  let requiredDocPresent = false;

  // Resolve which (document predicate, genuine-body predicate) applies to this
  // measure based on its required source type. Annual filing → Item 1A body;
  // proxy → any substantive proxy body chunk.
  type ForceSpec = {
    label: string;
    isReqDoc: (c: Chunk) => boolean;
    isGenuineBody: (c: Chunk) => boolean;
  };
  const forceSpecs: ForceSpec[] = [];
  if (measureRequiresAnnualFiling(measure)) {
    forceSpecs.push({
      label: "item1a",
      isReqDoc: (c) => isRegulatoryAnnualFilingDoc(c.docUrl, c.docTitle) || c.section === "item1a",
      isGenuineBody: (c) => isItem1aBodyChunk(c),
    });
  }
  if (measureRequiresProxy(measure)) {
    forceSpecs.push({
      label: "proxy",
      isReqDoc: (c) => isProxyDoc(c.docUrl, c.docTitle),
      isGenuineBody: (c) => isProxyDoc(c.docUrl, c.docTitle) && !!c.text && c.text.length >= 200 && !isLikelyToc(c.text),
    });
  }

  // v3j-r3: DOCUMENT-LEVEL proxy classifier, CALIBRATED on real filings. A DEF 14A
  // whose filename is a bare <ticker>-YYYYMMDD.htm (e.g. NVIDIA nvda-20260512)
  // passes neither URL/title nor a per-chunk proxy test reliably, yet the document
  // as a whole is unmistakably a proxy. We count PROXY-EXCLUSIVE strong markers vs
  // strong 10-K markers across each document's chunks. Measured separation:
  //   proxy nvda-20260512: strongProxy=86, strong10K~1
  //   real 10-Ks:          strongProxy 0-4, strong10K 23-58
  // A document is proxy-dominant when it has many proxy markers AND they outweigh
  // its 10-K markers. This is robust to filename shape and does not misclassify a
  // 10-K that merely references its proxy a handful of times.
  const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|board of directors recommends|proxy card|voting (instructions|your shares)|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
  const strong10kRe = /item\s*1a|item\s*7\.|management's discussion and analysis|consolidated (balance sheet|statements of operations)|item\s*8\./gi;
  const docProxyHits = new Map<number, number>();
  const doc10kHits = new Map<number, number>();
  for (const ch of chunks) {
    const p = (ch.text.match(strongProxyRe) || []).length;
    const k = (ch.text.match(strong10kRe) || []).length;
    if (p > 0) docProxyHits.set(ch.docIndex, (docProxyHits.get(ch.docIndex) || 0) + p);
    if (k > 0) doc10kHits.set(ch.docIndex, (doc10kHits.get(ch.docIndex) || 0) + k);
  }
  const isProxyDominantDoc = (docIndex: number) => {
    const p = docProxyHits.get(docIndex) || 0;
    const k = doc10kHits.get(docIndex) || 0;
    return p >= 10 && p > k * 2;
  };

  for (const spec of forceSpecs) {
    // All chunks whose source document matches the required type, indexed back to
    // their scored entry so we can place them with provenance + score metadata.
    // For the ANNUAL-FILING spec, exclude proxy-dominant documents at the doc level.
    const reqDocScored = scored.filter((s) => {
      const ch = chunks[s.idx];
      if (!spec.isReqDoc(ch)) return false;
      if (spec.label === "item1a" && isProxyDominantDoc(ch.docIndex)) return false;
      return true;
    });
    if (reqDocScored.length === 0) {
      console.log(`[force-include] ${measure.measureId}: no ${spec.label} document in corpus (nothing to force-include)`);
      continue;
    }
    requiredDocPresent = true;

    // Genuine body chunks only (TOC and cross-reference chunks excluded).
    const bodyScored = reqDocScored.filter((s) => spec.isGenuineBody(chunks[s.idx]));

    // Choose THE BEST matching document. v3j-r3 FIX: among documents that have a
    // SUFFICIENT number of genuine body chunks, prefer the MOST RECENT filing.
    //
    // Why: a company's corpus often contains several years of 10-Ks. The earlier
    // "max genuine-body-chunk count" rule could pick an OLDER 10-K (e.g. Salesforce
    // crm-20221031) over the current one (crm-20260131) merely because the older
    // filing chunked into more item1a pieces — causing the cited risk-factor quote
    // to come from a stale filing, which violates the "cite the most recent filing"
    // requirement. We still require a MINIMUM body-chunk count so a proxy-style doc
    // that only cross-references Item 1A (e.g. NVIDIA nvda-20260512, ~0-1 genuine
    // body chunks) cannot win on recency alone.
    const bodyByDoc = new Map<number, (typeof scored)[number][]>();
    for (const s of bodyScored) {
      const arr = bodyByDoc.get(s.docIndex) || [];
      arr.push(s);
      bodyByDoc.set(s.docIndex, arr);
    }
    // Recency key parsed from the doc URL/title (e.g. crm-20260131 -> 20260131,
    // EDGAR accession date, or a 4-8 digit date token). Higher = more recent.
    const recencyOf = (di: number): number => {
      const sample = (bodyByDoc.get(di) || [])[0];
      const ch = sample ? chunks[sample.idx] : undefined;
      const hay = `${ch?.docUrl || ""} ${ch?.docTitle || ""}`;
      let best = 0;
      // Prefer an 8-digit YYYYMMDD token (ticker-YYYYMMDD filenames, EDGAR dates).
      for (const m of hay.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1], 10); if (v > best) best = v; }
      if (best === 0) {
        for (const m of hay.matchAll(/(20\d{2})[-_/]?(\d{2})?/g)) {
          const v = parseInt((m[1] + (m[2] || "00")).padEnd(8, "0").slice(0, 8), 10);
          if (v > best) best = v;
        }
      }
      return best;
    };
    // A document qualifies if it has at least MIN_BODY genuine body chunks, OR (when
    // none reach that bar) it simply has the most body chunks available.
    const maxBodyCount = Math.max(...[...bodyByDoc.values()].map((a) => a.length), 0);
    const MIN_BODY = Math.min(FORCE_INCLUDE_CHUNKS, maxBodyCount);
    // Prefer the authoritative EDGAR primary HTML filing over third-party PDF
    // mirrors (e.g. fortune.com / investor-relations copies of the same 10-K),
    // which often carry no parseable date token. Used only as a tie-break so it
    // never overrides a genuinely more recent EDGAR filing.
    const isEdgarPrimaryDoc = (di: number): boolean => {
      const sample = (bodyByDoc.get(di) || [])[0];
      const ch = sample ? chunks[sample.idx] : undefined;
      const u = (ch?.docUrl || "").toLowerCase();
      return /sec\.gov\/archives\/edgar\/data\/\d+\//.test(u) && /\.htm/.test(u);
    };
    // Two filings count as the "same period" when their parsed dates fall within
    // this many days (coarse YYYYMMDD arithmetic). The authoritative EDGAR primary
    // HTML copy is preferred over a third-party PDF MIRROR of the SAME 10-K (e.g.
    // NVIDIA's EDGAR nvda-20260125 vs fortune.com .../2026-02-25 PDF, the same
    // FY2026 filing) so citations resolve to EDGAR. A genuinely newer filing
    // (outside the window) still wins outright on recency.
    const SAME_PERIOD_DAYS = 150;
    const ymdToOrdinal = (v: number): number => {
      if (v <= 0) return 0;
      const y = Math.floor(v / 10000), m = Math.floor((v % 10000) / 100) || 1, d = (v % 100) || 1;
      return y * 365 + m * 30 + d; // coarse day count; adequate for windowing
    };
    // Build the qualifying-document list, then pick deterministically via an
    // explicit comparator (order-independent, unlike a windowed greedy scan).
    type DocCand = { di: number; count: number; rec: number; ord: number; edgar: boolean };
    const cands: DocCand[] = [];
    for (const [di, arr] of bodyByDoc) {
      if (arr.length < MIN_BODY) continue;
      const rec = recencyOf(di);
      cands.push({ di, count: arr.length, rec, ord: ymdToOrdinal(rec), edgar: isEdgarPrimaryDoc(di) });
    }
    cands.sort((a, b) => {
      const samePeriod = Math.abs(a.ord - b.ord) <= SAME_PERIOD_DAYS;
      if (!samePeriod) return b.rec - a.rec;            // clearly newer wins
      if (a.edgar !== b.edgar) return a.edgar ? -1 : 1; // same period: EDGAR beats mirror
      if (a.rec !== b.rec) return b.rec - a.rec;        // then newer
      if (a.count !== b.count) return b.count - a.count;// then more body chunks
      return a.di - b.di;                               // then lowest docIndex
    });
    const bestDocIndex: number | undefined = cands.length ? cands[0].di : undefined;

    // Candidate body chunks from the best document. v3j-r2 FIX: select by TOPIC
    // RELEVANCE, not raw document position. The earlier position-based pick took
    // the OPENING of Item 1A (generic competitive/preamble risk), which for an
    // AI-specific measure (e.g. 9.1) does NOT contain the AI risk paragraphs that
    // appear deeper in a 100k+ char section — so the grader correctly returned
    // "No AI in risk factors" even though the section is full of AI risk language.
    //
    // New contract: from the best document's GENUINE body chunks, guarantee
    //   (a) ONE positional anchor — the earliest body chunk — for section context
    //       and stable provenance, PLUS
    //   (b) the top (N-1) body chunks by BLENDED RELEVANCE SCORE (BM25 + topic +
    //       section bonus), so the measure-relevant (e.g. AI) risk paragraphs are
    //       always force-included.
    // De-duplicated and capped at N. This is still deterministic (pure function of
    // the corpus + measure query) and topic-agnostic (works for any measure via
    // its own query terms), while actually surfacing on-topic evidence.
    let forceCandidates: (typeof scored)[number][] = [];
    if (bestDocIndex !== undefined && (bodyByDoc.get(bestDocIndex)?.length || 0) > 0) {
      const bodyChunks = (bodyByDoc.get(bestDocIndex) || []).slice();
      const byPosition = bodyChunks
        .slice()
        .sort((a, b) => (chunks[a.idx].seqInDoc ?? a.idx) - (chunks[b.idx].seqInDoc ?? b.idx));
      const byScore = bodyChunks
        .slice()
        .sort((a, b) => b.score - a.score || (chunks[a.idx].seqInDoc ?? a.idx) - (chunks[b.idx].seqInDoc ?? b.idx));
      const picked: (typeof scored)[number][] = [];
      const pushUnique = (c: (typeof scored)[number]) => {
        if (!picked.includes(c)) picked.push(c);
      };
      // (a) positional anchor: earliest genuine body chunk (section opening).
      if (byPosition.length > 0) pushUnique(byPosition[0]);
      // (b) fill remaining slots with the most measure-relevant body chunks.
      for (const c of byScore) {
        if (picked.length >= FORCE_INCLUDE_CHUNKS) break;
        pushUnique(c);
      }
      forceCandidates = picked.slice(0, FORCE_INCLUDE_CHUNKS);
    } else {
      // Fallback: no chunk passed the strict genuine-body test (rare). Take the
      // earliest item1a/required-doc chunks by position so SOMETHING from the
      // required document is guaranteed, but log it as a degraded path.
      const byDoc = new Map<number, (typeof scored)[number][]>();
      for (const s of reqDocScored) {
        const arr = byDoc.get(s.docIndex) || [];
        arr.push(s);
        byDoc.set(s.docIndex, arr);
      }
      let fbDoc: number | undefined; let fbCount = -1;
      for (const [di, arr] of byDoc) {
        if (arr.length > fbCount || (arr.length === fbCount && (fbDoc === undefined || di < fbDoc))) { fbCount = arr.length; fbDoc = di; }
      }
      if (fbDoc !== undefined) {
        forceCandidates = (byDoc.get(fbDoc) || [])
          .slice()
          .sort((a, b) => (chunks[a.idx].seqInDoc ?? a.idx) - (chunks[b.idx].seqInDoc ?? b.idx))
          .slice(0, FORCE_INCLUDE_CHUNKS);
        console.warn(`[force-include][DEGRADED] ${measure.measureId}: ${spec.label} doc present but no genuine body chunk passed filters; forcing ${forceCandidates.length} positional chunk(s) from docIndex=${fbDoc}`);
      }
    }

    // Place the forced chunks on a DEDICATED extra budget so the guarantee never
    // evicts other supporting evidence (augment, don't displace).
    let forcedChars = 0;
    for (const cand of forceCandidates) {
      if (selected.includes(cand)) { forceIncludedCount++; forceIncludedDocUrl = forceIncludedDocUrl || chunks[cand.idx].docUrl; continue; }
      if (forcedChars + cand.text.length > FORCE_INCLUDE_EXTRA_CHARS && forceIncludedCount > 0) continue;
      if (evidenceLen + cand.text.length > maxChars + FORCE_INCLUDE_EXTRA_CHARS) continue;
      selected.push(cand);
      perDocCount.set(cand.docIndex, (perDocCount.get(cand.docIndex) || 0) + 1);
      evidenceLen += cand.text.length + 2;
      forcedChars += cand.text.length;
      forceIncludedCount++;
      forceIncludedDocUrl = forceIncludedDocUrl || chunks[cand.idx].docUrl;
    }

    if (forceIncludedCount > 0) {
      console.log(`[force-include] ${measure.measureId}: GUARANTEED ${forceIncludedCount} genuine ${spec.label} body chunk(s) from ${forceIncludedDocUrl || "(doc)"} (1 positional anchor + top-by-relevance; deterministic)`);
    } else {
      // Required document present but we could not place any chunk — a real failure
      // the worker invariant will catch.
      console.warn(`[force-include][ASSERT] ${measure.measureId}: ${spec.label} doc present in corpus but NO body chunk placed (budget/dedup). Invariant should flag this run.`);
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

  // v3g (quote sourceUrl fix): emit a "--- DOCUMENT: <title> [<url>] ---" header
  // whenever the source document changes, so the assembled pack carries the same
  // provenance markers as the original corpus. Without this, normalizeQuoteSources
  // (which regex-scans for these headers) found none in the pack and could not
  // attach a sourceUrl, leaving quote.sourceUrl empty in the API export.
  let evidenceText = "";
  let packTopicHits = 0;
  let lastDocIndex: number | null = null;
  for (const item of selected) {
    const ch = chunks[item.idx];
    if (item.docIndex !== lastDocIndex) {
      const url = ch?.docUrl;
      const title = ch?.docTitle || `Document ${item.docIndex + 1}`;
      // Only emit a resolvable header when we have a URL; otherwise emit a
      // title-only header (still parseable, just without a bracketed URL).
      evidenceText += url
        ? `--- DOCUMENT: ${title} [${url}] ---\n\n`
        : `--- DOCUMENT: ${title} ---\n\n`;
      lastDocIndex = item.docIndex;
    }
    evidenceText += item.text + "\n\n";
    packTopicHits += item.topicHits;
  }

  // v3g (Bug 1): CONTENT-STABLE evidence fingerprint. The previous scheme hashed
  // only positional `docIndex:chunkIdx` pairs, which are local to each company's
  // corpus / category chunk array and carry NO company, framework, measure or
  // document identity. Two unrelated companies whose top evidence happened to land
  // on the same positional slots therefore produced an IDENTICAL hash (observed:
  // one hash repeated 98× across 5 companies and all 34 measures), making the
  // verdict cache unsafe.
  //
  // The new fingerprint hashes an EXPLICIT, deterministic identity:
  //   companyId | frameworkId | measureId | sorted(docUrl # seqInDoc # sha1(chunkText))
  // - companyId/frameworkId/measureId guarantee no cross-entity collision.
  // - per-chunk (docUrl, seqInDoc, content-hash) makes it identical ONLY when the
  //   genuine evidence pack is identical, independent of selection order.
  // Empty packs are handled by the caller path; here `selected` is non-empty.
  const ident = `c=${companyId ?? "?"}|f=${frameworkId ?? "?"}|m=${measure.measureId}`;
  const chunkIds = selected
    .map((s) => {
      const ch = chunks[s.idx];
      const docKey = ch?.docUrl || `docIndex:${s.docIndex}`;
      const seq = ch?.seqInDoc ?? s.idx;
      const contentHash = createHash("sha1").update(s.text).digest("hex").slice(0, 16);
      return `${docKey}#${seq}#${contentHash}`;
    })
    .sort();
  const fingerprint = createHash("sha1")
    .update(`${ident}||${chunkIds.join("|")}`)
    .digest("hex");

  return {
    measureId: measure.measureId,
    text: evidenceText.trim(),
    chunkCount: selected.length,
    totalChars: evidenceText.length,
    topicHits: packTopicHits,
    fingerprint,
    fingerprintEligible: selected.length > 0,
    forceIncludedCount,
    forceIncludedDocUrl,
    requiredDocPresent,
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
  // v3g (Bug 1): identity for a collision-free per-(company,measure) fingerprint.
  companyId?: number | string;
  frameworkId?: number | string;
}): EvidencePack[] {
  const { measures, combinedText, terminology, topicTerms = DEFAULT_AI_TOPIC_TERMS, topK, maxChars, companyId, frameworkId } = opts;

  const chunks = chunkDocuments(combinedText);
  if (chunks.length === 0) {
    // v3g (Bug 1): empty corpus -> per-(company,framework,measure) SENTINEL
    // fingerprint, explicitly marked cache-INELIGIBLE so an empty pack can never
    // satisfy a cache hit (and never collide with a real pack).
    return measures.map((m) => ({
      measureId: m.measureId,
      text: "",
      chunkCount: 0,
      totalChars: 0,
      topicHits: 0,
      fingerprint: createHash("sha1")
        .update(`EMPTY_PACK|c=${companyId ?? "?"}|f=${frameworkId ?? "?"}|m=${m.measureId}`)
        .digest("hex"),
      fingerprintEligible: false,
      forceIncludedCount: 0,
      requiredDocPresent: false,
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
      companyId,
      frameworkId,
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

// Exposed for offline diagnostics/tests only (not used by the analyzer).
export const __testHooks = {
  isItem1aBodyChunk,
  isRegulatoryAnnualFilingDoc,
  isProxyDoc,
};

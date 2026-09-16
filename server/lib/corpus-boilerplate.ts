// ─── Approach 3: remove boilerplate at CORPUS ASSEMBLY (generic, deterministic) ──
//
// Pure, framework-independent, single-pass helpers used by analyzer.summarize-
// Documents to improve the QUALITY of the fixed-budget corpus selection WITHOUT
// enlarging the budget. Repeated boilerplate (safe-harbour language, governance
// disclaimers, repeated headers/footers/legends, cross-reference tables) scores
// well on generic query tokens and is dense across every filing, so it wins the
// 560k budget competition and evicts near-unique discriminative passages. These
// helpers demote such content so discriminators win the budget they currently lose.
//
//   (3a) cross-document near-duplicate down-weighting  → computeAssemblyPenaltyFactors
//   (3b) within-corpus IDF penalty                     → computeAssemblyPenaltyFactors
//   (3c) structural repeated-block stripping           → stripRepeatedStructuralBlocks
//
// SAFETY INVARIANT (shared by all three): a chunk/line that carries a QUANTIFIED
// FIGURE or a CURATED DISCRIMINATOR is never penalised or stripped. Penalties are
// GENTLE multipliers (never zero), so they only re-order the budget competition —
// they can never on their own evict a protected chunk. Nothing here changes the
// budget, the chunk boundaries, or any downstream evidence gating.

/** Lowercase alphanumeric word tokens — stable, generic, no external state. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/**
 * Quantified-figure detector. Protects any text that carries a number, percent,
 * currency, or magnitude word so a penalty/strip can never remove a quantified
 * figure (the SAFETY INVARIANT above). Generic — no topic/company literals.
 */
const FIGURE_RE = /\d|%|\$|€|£|¥|\b(?:percent|million|billion|trillion|thousand)\b/i;
export function containsQuantifiedFigure(text: string): boolean {
  return FIGURE_RE.test(text);
}

/** FNV-1a 32-bit string hash — deterministic, fast, dependency-free. */
function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ─── (3c) Structural repeated-block stripping across documents ───────────────

// A line must recur in at least this many DISTINCT documents to count as
// structural boilerplate (header/footer/legend). Gentle default.
const DEFAULT_MIN_DISTINCT_DOCS = 3;
// Only short lines are eligible — real prose/evidence is longer.
const DEFAULT_MAX_LINE_LEN = 120;
const DEFAULT_MAX_WORDS = 15;
// Split the assembled corpus on its "--- DOCUMENT: ... ---" headers, keeping each
// header attached to the segment that follows it (lookahead split).
const DOC_SPLIT_RE = /(?=\n*---\s*DOCUMENT:)/;

export interface StripResult {
  text: string;
  strippedLines: number;
  patterns: number;
}

export interface StripOptions {
  minDistinctDocs?: number;
  maxLineLen?: number;
  maxWords?: number;
  /** Curated discriminators (tokenised) — a line containing any is never stripped. */
  protectTerms?: string[];
}

/**
 * (3c) Detect and drop EXACT repeated header/footer/legend lines that recur across
 * many distinct documents in the assembled corpus. Deterministic, single rebuild.
 * Returns the input UNCHANGED when the corpus has <2 document segments or no line
 * qualifies. Never strips a header line, a line with a quantified figure, a long
 * line, or a line containing a curated discriminator.
 */
export function stripRepeatedStructuralBlocks(combinedText: string, opts?: StripOptions): StripResult {
  const minDistinctDocs = opts?.minDistinctDocs ?? DEFAULT_MIN_DISTINCT_DOCS;
  const maxLineLen = opts?.maxLineLen ?? DEFAULT_MAX_LINE_LEN;
  const maxWords = opts?.maxWords ?? DEFAULT_MAX_WORDS;
  const protect = new Set((opts?.protectTerms || []).map((t) => (t || "").toLowerCase()).filter(Boolean));

  const segments = combinedText.split(DOC_SPLIT_RE);
  if (segments.length <= 1) return { text: combinedText, strippedLines: 0, patterns: 0 };

  const norm = (l: string) => l.trim().replace(/\s+/g, " ").toLowerCase();
  const isCandidate = (line: string): boolean => {
    const t = line.trim();
    if (t.length === 0 || t.length > maxLineLen) return false;
    if (t.startsWith("--- DOCUMENT:")) return false; // never a provenance header
    if (containsQuantifiedFigure(t)) return false; // protect quantified figures
    const toks = words(t);
    if (toks.length === 0 || toks.length > maxWords) return false; // keep prose/evidence
    if (protect.size > 0) {
      const wset = new Set(toks);
      for (const p of protect) if (wset.has(p)) return false; // protect discriminators
    }
    return true;
  };

  // Pass 1: count distinct-document occurrences of each candidate line.
  const docCount = new Map<string, Set<number>>();
  segments.forEach((seg, di) => {
    const seen = new Set<string>();
    for (const raw of seg.split("\n")) {
      if (!isCandidate(raw)) continue;
      const key = norm(raw);
      if (seen.has(key)) continue; // count each document once per distinct line
      seen.add(key);
      let set = docCount.get(key);
      if (!set) docCount.set(key, (set = new Set()));
      set.add(di);
    }
  });
  const boilerplate = new Set<string>();
  for (const [key, docs] of docCount) if (docs.size >= minDistinctDocs) boilerplate.add(key);
  if (boilerplate.size === 0) return { text: combinedText, strippedLines: 0, patterns: 0 };

  // Pass 2: drop boilerplate lines (single deterministic rebuild; provenance headers
  // and all non-candidate lines are preserved exactly).
  let strippedLines = 0;
  const rebuilt = segments
    .map((seg) =>
      seg
        .split("\n")
        .filter((raw) => {
          if (!isCandidate(raw)) return true;
          if (boilerplate.has(norm(raw))) {
            strippedLines++;
            return false;
          }
          return true;
        })
        .join("\n"),
    )
    .join("");
  return { text: rebuilt, strippedLines, patterns: boilerplate.size };
}

// ─── (3a)+(3b) Per-chunk assembly penalty factors ────────────────────────────

export interface ChunkLike {
  text: string;
  docIndex: number;
}

export interface AssemblyPenaltyOptions {
  /** Curated discriminators (tokenised) — a chunk containing any is never penalised. */
  protectTerms?: string[];
  /** Framework dataPattern regexes — a chunk matching any is treated as discriminative. */
  protectRegexes?: RegExp[];
  shingleK?: number; // (3a) shingle length in words
  minhashM?: number; // (3a) fingerprint size (M smallest shingle hashes)
  dupDocThreshold?: number; // (3a) distinct-doc count for a shingle to be "shared"
  maxDupPenalty?: number; // (3a) max fraction of BM25 score removed (gentle)
  highDfDocRatio?: number; // (3b) term DF / numDocs to be "corpus-common"
  maxIdfPenalty?: number; // (3b) max fraction of BM25 score removed (gentle)
  minDocsForIdf?: number; // (3b) need at least this many docs to judge corpus-common
}

const DEFAULTS = {
  shingleK: 8,
  minhashM: 24,
  dupDocThreshold: 3,
  maxDupPenalty: 0.3,
  highDfDocRatio: 0.6,
  maxIdfPenalty: 0.2,
  minDocsForIdf: 4,
};

/**
 * Compute a GENTLE multiplicative penalty factor in (0, 1] for each chunk, to be
 * applied to that chunk's BM25 score BEFORE the fixed-budget selection.
 *
 *   factor[i] = 1                              when chunk i is protected
 *             = dupFactor[i] * idfFactor[i]    otherwise
 *
 *   (3a) dupFactor  = 1 - maxDupPenalty * (fraction of the chunk's fingerprint
 *                     shingles that recur in >= dupDocThreshold DISTINCT documents)
 *   (3b) idfFactor  = 1 - maxIdfPenalty * (fraction of the chunk's tokens that are
 *                     "corpus-common": present in >= highDfDocRatio of the docs)
 *
 * A chunk is PROTECTED (factor 1) if it carries a quantified figure, contains a
 * curated discriminator token, or matches a framework dataPattern. Factors never
 * reach 0, so a protected/discriminative chunk can never be evicted by this alone.
 * Fully generic and deterministic; safe on tiny corpora (returns all-1 when there
 * are too few documents to judge). Never throws.
 */
export function computeAssemblyPenaltyFactors(chunks: ChunkLike[], opts?: AssemblyPenaltyOptions): number[] {
  const n = chunks.length;
  const factors = new Array<number>(n).fill(1);
  if (n === 0) return factors;

  const K = opts?.shingleK ?? DEFAULTS.shingleK;
  const M = opts?.minhashM ?? DEFAULTS.minhashM;
  const dupDocThreshold = opts?.dupDocThreshold ?? DEFAULTS.dupDocThreshold;
  const maxDupPenalty = opts?.maxDupPenalty ?? DEFAULTS.maxDupPenalty;
  const highDfDocRatio = opts?.highDfDocRatio ?? DEFAULTS.highDfDocRatio;
  const maxIdfPenalty = opts?.maxIdfPenalty ?? DEFAULTS.maxIdfPenalty;
  const minDocsForIdf = opts?.minDocsForIdf ?? DEFAULTS.minDocsForIdf;

  const protectTerms = new Set((opts?.protectTerms || []).map((t) => (t || "").toLowerCase()).filter(Boolean));
  const protectRegexes = opts?.protectRegexes || [];

  const numDocs = new Set(chunks.map((c) => c.docIndex)).size;

  // Precompute per-chunk word lists once (reused by protection, 3a, 3b).
  const chunkWords: string[][] = chunks.map((c) => words(c.text));

  // Protection predicate (SAFETY INVARIANT).
  const isProtected = (i: number): boolean => {
    const text = chunks[i].text;
    if (containsQuantifiedFigure(text)) return true;
    if (protectTerms.size > 0) {
      const wset = new Set(chunkWords[i]);
      for (const p of protectTerms) if (wset.has(p)) return true;
    }
    for (const rx of protectRegexes) {
      try {
        rx.lastIndex = 0;
        if (rx.test(text)) return true;
      } catch {
        /* ignore a bad regex */
      }
    }
    return false;
  };

  // ── (3a) shingle fingerprints + distinct-doc frequency ──
  const fingerprints: number[][] = chunkWords.map((w) => {
    if (w.length < K) return [];
    const hs = new Set<number>();
    for (let i = 0; i + K <= w.length; i++) hs.add(fnv1a(w.slice(i, i + K).join(" ")));
    return [...hs].sort((a, b) => a - b).slice(0, M);
  });
  const shingleDocs = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const di = chunks[i].docIndex;
    for (const h of fingerprints[i]) {
      let set = shingleDocs.get(h);
      if (!set) shingleDocs.set(h, (set = new Set()));
      set.add(di);
    }
  }

  // ── (3b) term document-frequency within this corpus ──
  const termDocs = new Map<string, Set<number>>();
  for (let i = 0; i < n; i++) {
    const di = chunks[i].docIndex;
    for (const w of new Set(chunkWords[i])) {
      let set = termDocs.get(w);
      if (!set) termDocs.set(w, (set = new Set()));
      set.add(di);
    }
  }
  const highDf = new Set<string>();
  if (numDocs >= minDocsForIdf) {
    for (const [t, ds] of termDocs) if (ds.size / numDocs >= highDfDocRatio) highDf.add(t);
  }

  for (let i = 0; i < n; i++) {
    if (isProtected(i)) {
      factors[i] = 1;
      continue;
    }
    // (3a)
    let dupFactor = 1;
    const fp = fingerprints[i];
    if (fp.length > 0) {
      let shared = 0;
      for (const h of fp) if ((shingleDocs.get(h)?.size ?? 0) >= dupDocThreshold) shared++;
      dupFactor = 1 - maxDupPenalty * (shared / fp.length);
    }
    // (3b)
    let idfFactor = 1;
    const w = chunkWords[i];
    if (highDf.size > 0 && w.length > 0) {
      let common = 0;
      for (const t of w) if (highDf.has(t)) common++;
      idfFactor = 1 - maxIdfPenalty * (common / w.length);
    }
    factors[i] = dupFactor * idfFactor;
  }
  return factors;
}

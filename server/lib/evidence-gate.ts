/**
 * Deterministic evidence-integrity gate — pure string logic, NO LLM.
 *
 * Applied to EVERY model output (primaries, extra votes, and the arbiter) right
 * after its JSON is parsed and BEFORE any cascade decision is reconstructed.
 *
 * For each quote {text, source} a model returns for a measure it runs three
 * independent checks; a quote is VALID only if it passes ALL three:
 *
 *   (1) PROVENANCE  — the quote text must actually appear in the assembled
 *       evidence-pack text the model was shown for that measure. Normalise both
 *       (lowercase, collapse whitespace, strip punctuation) and match by longest
 *       common SUBSTRING (contiguous run), requiring high overlap: LCS length
 *       >= 90% of the normalised quote length, OR LCS length >= 120 chars.
 *       (Plain substring containment is the LCS == quoteLen special case.)
 *
 *   (2) ANTI-ECHO   — if the quote shares a normalised verbatim run of >= 60
 *       chars with ANY injected positiveExample / negativeExample of that
 *       measure, it is a fabricated prompt-echo (the signature documented in
 *       echo_provenance_scan.py: mistral-or & claude-arbiter echo injected
 *       examples with invented sources). FAIL.
 *
 *   (3) SOURCE      — an empty / thin source (< 4 chars) or a self-declared-
 *       absent source (contains "no such" / "not found" / "n/a") = FAIL.
 *
 * Consequence (binary scoring preserved, 0/1 only):
 *   - A YES (score === 1) is sustained ONLY if at least one VALID quote remains,
 *     otherwise the score is downgraded to 0.
 *   - A NO (score === 0) stays 0.
 *
 * The normalise + longest-common-substring logic mirrors echo_provenance_scan.py
 * (Python SequenceMatcher.find_longest_match → longest common contiguous run).
 *
 * Synchronous and cheap: LCS is computed with a rolling 1-D DP array
 * (O(len(a)*len(b)) time, O(min) space). Pack ~20k chars × quote ~300 chars is a
 * few million cheap integer ops per quote — negligible.
 */

export type GateFailureReason =
  | "provenance"
  | "anti-echo"
  | "source"
  | "source-attribution";

export interface GateFailure {
  quoteText: string;
  source: string;
  reasons: GateFailureReason[];
}

/**
 * Optional per-document segment of the assembled pack (Task C). `id` is a
 * document identity (e.g. filename / title) that a quote.source may name; `text`
 * is that document's slice of the pack. When supplied, a quote whose source
 * resolves to a segment must have provenance against THAT segment's text.
 */
export interface DocumentSegment {
  id: string;
  text: string;
}

export interface EvidenceGateResult {
  quotesTotal: number;
  quotesValid: number;
  failures: GateFailure[];
  downgraded: boolean;
  originalScore: number;
}

export interface QuoteInput {
  text: string;
  source: string;
}

export interface GateParams {
  originalScore: number;
  quotes: QuoteInput[];
  packText: string;
  positiveExamples?: string[];
  negativeExamples?: string[];
  /**
   * Task B — strict-strip. When true (default), invalid quotes are dropped from
   * the returned `keptQuotes` so a flagged quote is never presented as support,
   * even when the YES survives on another valid quote. When false, `keptQuotes`
   * is the full input list (legacy behaviour).
   */
  strictStrip?: boolean;
  /**
   * Task C — optional per-document pack segments. If a quote.source resolves to
   * one of these, provenance is required against THAT document's text. Omit for
   * exactly-as-before behaviour.
   */
  documentSegments?: DocumentSegment[];
  /**
   * Task C — enable the source-attribution dimension. Default true, but only has
   * any effect when documentSegments are supplied.
   */
  sourceAttribution?: boolean;
}

// Thresholds (documented above).
const PROVENANCE_MIN_RATIO = 0.9; // >= 90% of normalised quote length
const PROVENANCE_MIN_LCS = 120; // OR absolute LCS >= 120 chars
const ANTI_ECHO_MIN_RUN = 60; // shared verbatim run >= 60 chars = echo
const SOURCE_MIN_LEN = 4; // source shorter than this = thin
const SOURCE_ABSENT_MARKERS = ["no such", "not found", "n/a"];
// Task C: how strongly a quote.source must overlap a segment id to be "attributed"
// to that document. Whole id, or an absolute run of this many chars.
const SOURCE_ATTRIBUTION_MIN_RATIO = 0.9;
const SOURCE_ATTRIBUTION_MIN_RUN = 12;

/** Normalise exactly like echo_provenance_scan.py:norm(). */
export function normaliseForGate(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Length of the longest common CONTIGUOUS substring of a and b.
 * Rolling 1-D DP over the shorter string to keep memory small.
 */
export function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  // Iterate rows over `a`, columns over `b`; keep `b` as the inner (array) axis.
  // Swap so the DP array spans the shorter string → O(min(len)) memory.
  let outer = a;
  let inner = b;
  if (inner.length > outer.length) {
    // keep inner as the shorter → smaller array
    const t = outer;
    outer = inner;
    inner = t;
  }
  const n = inner.length;
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  let best = 0;
  for (let i = 0; i < outer.length; i++) {
    const oc = outer.charCodeAt(i);
    for (let j = 0; j < n; j++) {
      if (oc === inner.charCodeAt(j)) {
        const v = prev[j] + 1;
        curr[j + 1] = v;
        if (v > best) best = v;
      } else {
        curr[j + 1] = 0;
      }
    }
    // swap prev/curr
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return best;
}

/** (1) PROVENANCE: quote must appear (fuzzily) in the pack text. */
export function checkProvenance(quoteText: string, packText: string): boolean {
  const q = normaliseForGate(quoteText);
  if (!q) return false;
  const p = normaliseForGate(packText);
  if (!p) return false;
  // Fast path: exact normalised substring containment.
  if (p.includes(q)) return true;
  const lcs = longestCommonSubstringLength(q, p);
  return lcs >= q.length * PROVENANCE_MIN_RATIO || lcs >= PROVENANCE_MIN_LCS;
}

/** (2) ANTI-ECHO: quote must NOT share a >=60-char run with any injected example. */
export function checkAntiEcho(quoteText: string, examples: string[]): boolean {
  const q = normaliseForGate(quoteText);
  if (!q) return true; // empty handled by provenance/source
  for (const ex of examples) {
    const e = normaliseForGate(ex);
    if (!e) continue;
    if (longestCommonSubstringLength(q, e) >= ANTI_ECHO_MIN_RUN) return false;
  }
  return true;
}

/** (3) SOURCE: non-empty, not thin, not self-declared-absent. */
export function checkSource(source: string): boolean {
  const s = (source || "").trim();
  if (s.length < SOURCE_MIN_LEN) return false;
  const lower = s.toLowerCase();
  for (const marker of SOURCE_ABSENT_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  return true;
}

/**
 * Task C — resolve a quote.source to one of the supplied per-document segments.
 * A segment matches when its normalised id shares a >= SOURCE_ATTRIBUTION_MIN_RUN
 * contiguous run with the normalised source (either direction), so a bare title
 * inside a longer citation still resolves. Returns the best (longest-run) match,
 * or null when nothing resolves (caller then falls back to pack-wide provenance).
 */
export function resolveDocumentSegment(
  source: string,
  segments: DocumentSegment[],
): DocumentSegment | null {
  const s = normaliseForGate(source);
  if (!s || !segments || segments.length === 0) return null;
  let best: DocumentSegment | null = null;
  let bestRun = 0;
  for (const seg of segments) {
    const id = normaliseForGate(seg.id || "");
    if (!id) continue;
    const run = longestCommonSubstringLength(s, id);
    // Require a meaningful overlap: the whole id, or >= threshold chars of it.
    const enough =
      run >= id.length * SOURCE_ATTRIBUTION_MIN_RATIO ||
      run >= SOURCE_ATTRIBUTION_MIN_RUN;
    if (enough && run > bestRun) {
      bestRun = run;
      best = seg;
    }
  }
  return best;
}

/**
 * Run the full gate on a model's output for a single measure.
 * Pure & synchronous. Returns the (possibly downgraded) binary score, a
 * per-llmResult gate record, and the quotes to keep (strict-strip aware).
 * Never mutates its inputs.
 */
export function gateEvidence<Q extends QuoteInput>(
  params: Omit<GateParams, "quotes"> & { quotes: Q[] },
): {
  score: number;
  gate: EvidenceGateResult;
  keptQuotes: Q[];
} {
  const { originalScore, quotes, packText } = params;
  const strictStrip = params.strictStrip !== false; // Task B: default true
  const sourceAttribution = params.sourceAttribution !== false; // Task C: default true
  const segments = params.documentSegments || [];
  const examples = [
    ...(params.positiveExamples || []),
    ...(params.negativeExamples || []),
  ];

  const failures: GateFailure[] = [];
  const keptQuotes: Q[] = [];
  let quotesValid = 0;

  for (const q of quotes || []) {
    const text = q?.text || "";
    const source = q?.source || "";
    const reasons: GateFailureReason[] = [];

    const packOk = checkProvenance(text, packText);
    if (!packOk) {
      reasons.push("provenance");
    } else if (sourceAttribution && segments.length > 0) {
      // Task C: pack-wide provenance passed — additionally require the quote to
      // trace to the SPECIFIC document its source names, when that document is
      // present as a segment. Unresolvable sources fall back to pack-wide (no
      // hard fail on attribution alone).
      const seg = resolveDocumentSegment(source, segments);
      if (seg && !checkProvenance(text, seg.text)) {
        reasons.push("source-attribution");
      }
    }

    if (!checkAntiEcho(text, examples)) reasons.push("anti-echo");
    if (!checkSource(source)) reasons.push("source");

    if (reasons.length === 0) {
      quotesValid++;
      keptQuotes.push(q);
    } else {
      failures.push({ quoteText: text, source, reasons });
      if (!strictStrip) keptQuotes.push(q); // legacy: keep flagged quotes too
    }
  }

  const quotesTotal = (quotes || []).length;
  // Binary scoring preserved: a YES survives only with >=1 VALID quote; NO stays 0.
  const sustained = originalScore === 1 && quotesValid >= 1;
  const score = sustained ? 1 : 0;
  const downgraded = originalScore === 1 && !sustained;

  return {
    score,
    gate: { quotesTotal, quotesValid, failures, downgraded, originalScore },
    keptQuotes,
  };
}

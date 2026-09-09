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

export type GateFailureReason = "provenance" | "anti-echo" | "source";

export interface GateFailure {
  quoteText: string;
  source: string;
  reasons: GateFailureReason[];
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
}

// Thresholds (documented above).
const PROVENANCE_MIN_RATIO = 0.9; // >= 90% of normalised quote length
const PROVENANCE_MIN_LCS = 120; // OR absolute LCS >= 120 chars
const ANTI_ECHO_MIN_RUN = 60; // shared verbatim run >= 60 chars = echo
const SOURCE_MIN_LEN = 4; // source shorter than this = thin
const SOURCE_ABSENT_MARKERS = ["no such", "not found", "n/a"];

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
 * Run the full gate on a model's output for a single measure.
 * Pure & synchronous. Returns the (possibly downgraded) binary score plus a
 * per-llmResult gate record. Never mutates its inputs.
 */
export function gateEvidence(params: GateParams): {
  score: number;
  gate: EvidenceGateResult;
} {
  const { originalScore, quotes, packText } = params;
  const examples = [
    ...(params.positiveExamples || []),
    ...(params.negativeExamples || []),
  ];

  const failures: GateFailure[] = [];
  let quotesValid = 0;

  for (const q of quotes || []) {
    const text = q?.text || "";
    const source = q?.source || "";
    const reasons: GateFailureReason[] = [];
    if (!checkProvenance(text, packText)) reasons.push("provenance");
    if (!checkAntiEcho(text, examples)) reasons.push("anti-echo");
    if (!checkSource(source)) reasons.push("source");
    if (reasons.length === 0) {
      quotesValid++;
    } else {
      failures.push({ quoteText: text, source, reasons });
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
  };
}

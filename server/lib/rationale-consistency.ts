// ─── Deterministic Rationale↔Score Consistency Detector ─────────────────────
//
// GENERIC, framework-agnostic, DETERMINISTIC (no LLM call) post-hoc detector.
// It replaces the previous live tie-breaker override (detectAndResolvContradiction)
// which fired a second LLM call and MUTATED the score/verdict when it saw one of
// five hardcoded phrases in a No verdict's rationale.
//
// This detector NEVER changes the score or verdict. It only DETECTS a mismatch
// between the emitted numeric score/verdict and the natural-language rationale,
// in BOTH directions, and returns flags for design-time re-adjudication:
//   (i)  affirmative / existence-confirming language in a NO verdict's rationale
//   (ii) negation / absence language in a YES verdict's rationale
//
// Detection combines two independent, generic signals:
//   1. The model's own in-completion self-check (Change C:
//      rationaleConsistencyCheck === "No").
//   2. A generic lexical-cue heuristic over the rationale text — cue FAMILIES,
//      not a fixed phrase list keyed to any measure/company/framework.
//
// It is intentionally conservative (favours precision): a Yes/Partial rationale
// that merely contains an incidental negation, or a No rationale that negates its
// own affirmative ("has no policy"), is NOT flagged.

export type RationaleConsistencyDirection =
  | "affirmative_on_no"
  | "negation_on_yes"
  | "model_self_check";

export interface RationaleConsistencyInput {
  /** Numeric score as emitted (0, 0.5, or 1). */
  score: number;
  /** Verdict as emitted. */
  verdict: string;
  /** The natural-language rationale (evidenceSummary). */
  rationale: string | null | undefined;
  /** The model's own in-completion self-check verdict, if present (Change C). */
  modelConsistencyCheck?: string | null;
  /** The model's one-line consistency note, if present (Change C). */
  consistencyNote?: string | null;
}

export interface RationaleConsistencyResult {
  inconsistent: boolean;
  /** Which direction(s) fired. Empty when consistent. */
  directions: RationaleConsistencyDirection[];
  /** Human-readable, generic explanation of what was detected. */
  reason: string;
  /** Diagnostic cue counts (for tests / telemetry). */
  signals: {
    affirmativeHits: number;
    absenceHits: number;
    modelSelfCheckFailed: boolean;
  };
}

// Existence / affirmation cue FAMILY: generic phrases that assert a thing EXISTS
// or is DISCLOSED. Deliberately multi-word where possible to reduce noise. These
// are lexical families, NOT a rubric-specific list — none reference a measure,
// company, or framework.
const AFFIRMATIVE_EXISTENCE_CUES: RegExp[] = [
  /\bhas (?:a |an |its |their |clear |specific |dedicated |formal |documented )?\w+/i,
  /\bhave (?:a |an |established |implemented |adopted )/i,
  /\b(?:the company|it|they|the (?:group|firm|organisation|organization|issuer)) (?:has|have|does|discloses?|provides?|maintains?|publishes?|reports?|confirms?|states?|describes?|outlines?|sets out|establishes?|demonstrates?)\b/i,
  /\bhas (?:implemented|established|adopted|published|developed|created|introduced|put in place|set out|disclosed|described|documented)\b/i,
  /\b(?:provides?|discloses?|describes?|outlines?|sets out|confirms?|demonstrates?|specifies|identifies|names)\b/i,
  /\bis (?:responsible for|in place|documented|disclosed|described|published)\b/i,
  /\bare (?:in place|documented|disclosed|described|published)\b/i,
  /\bthere (?:is|are) (?:a|an|clear|specific|evidence|explicit)\b/i,
  /\b(?:explicitly|clearly|specifically) (?:states?|describes?|discloses?|confirms?|addresses?|identifies|names)\b/i,
  /\bevidence (?:of|that|shows|supports|confirms|demonstrates)\b/i,
  /\b(?:policy|framework|committee|process|procedure|programme|program|governance structure|oversight) (?:is|are) (?:in place|established|disclosed|documented)\b/i,
  /\bcommit(?:s|ted|ment)?\b/i,
];

// Absence / negation cue FAMILY: generic phrases that assert a thing is MISSING,
// NOT disclosed, or insufficient. Used to detect a negative rationale under a Yes.
const ABSENCE_NEGATION_CUES: RegExp[] = [
  /\bno (?:evidence|disclosure|mention|reference|indication|information|specific|policy|framework|committee|process|detail)\b/i,
  /\b(?:does|do|did) not (?:disclose|provide|address|mention|describe|confirm|specify|identify|establish|have)\b/i,
  /\bnot (?:disclosed|provided|mentioned|described|addressed|found|present|available|specified|identified|confirmed|established)\b/i,
  /\b(?:insufficient|inadequate|lacking|absent|missing) (?:evidence|disclosure|detail|information)?\b/i,
  /\b(?:lacks|fails to|failed to|unable to|could not|cannot|couldn't)\b/i,
  /\bno (?:such|clear|specific|explicit)\b/i,
  /\bsilent on\b/i,
  /\b(?:not|no) (?:sufficient|enough)\b/i,
  /\bthere (?:is|are) no\b/i,
];

// Negated-affirmative scrubber: neutralises "has no", "provides no", "there is no",
// "does not have", etc. so an affirmative existence cue does NOT fire on a rationale
// that is actually saying the thing is ABSENT. Applied before affirmative counting.
const NEGATED_AFFIRMATIVE = /\b(?:has|have|had|provides?|disclos\w*|maintains?|includes?|establish\w*|report\w*|is|are|was|were|there (?:is|are))\s+(?:no|not|never|little|insufficient|inadequate|limited|scant|minimal)\b/gi;

function countCueHits(text: string, cues: RegExp[]): number {
  let hits = 0;
  for (const cue of cues) {
    if (cue.test(text)) hits++;
  }
  return hits;
}

/**
 * Deterministic, generic, bidirectional rationale↔score consistency detector.
 * NEVER mutates score/verdict — returns flags only.
 */
export function detectRationaleScoreInconsistency(
  input: RationaleConsistencyInput
): RationaleConsistencyResult {
  const rationale = (input.rationale || "").trim();
  const directions: RationaleConsistencyDirection[] = [];

  const modelSelfCheckFailed =
    typeof input.modelConsistencyCheck === "string" &&
    input.modelConsistencyCheck.trim().toLowerCase() === "no";

  // Classify the emitted verdict into a polarity we can reason about. Partial
  // (0.5) is intentionally treated as neither pure-positive nor pure-negative:
  // a "some but not all" rationale is expected to contain mixed language, so we
  // do not lexically flag it (the model self-check still applies).
  const isPositive = input.score >= 1 || /^yes$/i.test(input.verdict || "");
  const isNegative =
    (input.score === 0 && /^no$/i.test(input.verdict || "")) ||
    (input.score === 0 && (input.verdict || "").toLowerCase() === "insufficient evidence");

  // Scrub negated-affirmative constructions before counting affirmative cues so
  // "the company has no AI policy" does not read as an existence confirmation.
  const scrubbed = rationale.replace(NEGATED_AFFIRMATIVE, " __NEG__ ");
  const affirmativeHits = rationale.length > 0 ? countCueHits(scrubbed, AFFIRMATIVE_EXISTENCE_CUES) : 0;
  const absenceHits = rationale.length > 0 ? countCueHits(rationale, ABSENCE_NEGATION_CUES) : 0;

  // Direction (i): affirmative/existence language under a NO verdict, with no
  // countervailing absence language dominating it.
  if (isNegative && affirmativeHits > 0 && affirmativeHits > absenceHits) {
    directions.push("affirmative_on_no");
  }

  // Direction (ii): absence/negation language under a YES verdict, at least as
  // strong as any affirmative language present.
  if (isPositive && absenceHits > 0 && absenceHits >= affirmativeHits) {
    directions.push("negation_on_yes");
  }

  // The model's own self-check is an independent signal. It fires regardless of
  // verdict polarity (it can catch cases the lexical heuristic misses).
  if (modelSelfCheckFailed) {
    directions.push("model_self_check");
  }

  const inconsistent = directions.length > 0;

  let reason = "";
  if (inconsistent) {
    const parts: string[] = [];
    if (directions.includes("affirmative_on_no")) {
      parts.push(
        `rationale contains affirmative/existence language (${affirmativeHits} cue famil${affirmativeHits === 1 ? "y" : "ies"}) but the emitted verdict is No/absent`
      );
    }
    if (directions.includes("negation_on_yes")) {
      parts.push(
        `rationale contains negation/absence language (${absenceHits} cue famil${absenceHits === 1 ? "y" : "ies"}) but the emitted verdict is Yes`
      );
    }
    if (directions.includes("model_self_check")) {
      parts.push(
        `model self-check flagged rationale↔score disagreement${input.consistencyNote ? ` ("${input.consistencyNote}")` : ""}`
      );
    }
    reason = parts.join("; ");
  }

  return {
    inconsistent,
    directions,
    reason,
    signals: { affirmativeHits, absenceHits, modelSelfCheckFailed },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1.6 — READJUDICATION_PASS: a gated post-scoring pass that acts on the
// needs_readjudication / rationale_score_inconsistent flags the engine already
// writes but never consumes.
//
// For a flagged row the pass does NOT merely re-score the originally cited quote:
// it re-queries the company's EXTRACTED CORPUS for an ALTERNATIVE passage that
// could satisfy the measure's positive criteria (the rationale already asserts the
// elements exist, so the resolution is to find the passage that actually supports
// the verdict), re-grades on what it finds, and:
//   • moves the verdict to Yes when a qualifying passage is found, OR
//   • records No with a CLEARED flag and a recorded reason when none is found.
// It writes an auditable trace (original verdict/score, reason for the re-look, how
// many passages were searched, the passage found, the new verdict). It is
// idempotent and bounded — one re-look per row per run (a row that already carries
// a trace is skipped) — and deterministic (corpus-only, no LLM, stable across runs
// over the same corpus). When READJUDICATION_PASS is OFF, flagged rows are left
// exactly as first-pass scored. No company/framework/measure names are referenced.
// ─────────────────────────────────────────────────────────────────────────────

import {
  parsePackSegments,
  researchBestPassage,
  researchCandidatePassages,
  rescuePassageSatisfiesCriteria,
  resolveGatePolicy,
  type DocumentSegment,
  type GatePolicyVersion,
} from "./evidence-gate.js";
import { confidenceToNumber, decideReadjudicationByConfidence } from "./scoring-fix-flags.js";

/** Auditable record of a single re-adjudication. */
export interface ReadjudicationTrace {
  originalVerdict: string;
  originalScore: number;
  /** Why the row was re-looked (the detector's inconsistency reason, if any). */
  reason: string;
  /** How many candidate passages the re-query searched in the corpus. */
  passagesSearched: number;
  /** The best alternative passage found (verbatim-present), or null. */
  foundPassage: string | null;
  /** The source/segment the found passage came from, or null. */
  foundSource: string | null;
  newVerdict: string;
  /** True when the flag was resolved and cleared by this pass. */
  cleared: boolean;
  resolution: "moved-to-yes" | "confirmed-no" | "skipped";
}

/** The (subset of a) measure result the pass reads and mutates. */
export interface ReadjudicableResult {
  verdict?: string;
  score?: number;
  quotes?: Array<{ text: string; source: string }>;
  verdictNuance?: string | null;
  inconsistencyReason?: string | null;
  rationaleScoreInconsistent?: boolean;
  needsReadjudication?: boolean;
  readjudicationTrace?: ReadjudicationTrace | null;
  /** Textual confidence ("High"/"Medium"/"Low"), read by flag 10's threshold route. */
  confidence?: string | null;
}

/** A row is a re-adjudication candidate when it is flagged AND has not already
 *  been re-looked this run (idempotency: a trace means it was handled).
 *
 *  READJUDICATION_CONFIDENCE_THRESHOLD (flag 10): when a numeric `confidenceThreshold`
 *  is supplied (non-null), a row whose confidence maps below it is ALSO routed to
 *  re-adjudication, in addition to the existing flag-driven triggers. A null/absent
 *  threshold (flag unset) leaves candidacy exactly as before. */
export function shouldReadjudicate(
  result: ReadjudicableResult,
  opts?: { confidenceThreshold?: number | null },
): boolean {
  if (!result) return false;
  if (result.readjudicationTrace) return false;
  if (result.needsReadjudication === true || result.rationaleScoreInconsistent === true) {
    return true;
  }
  const threshold = opts?.confidenceThreshold ?? null;
  if (
    decideReadjudicationByConfidence({
      threshold,
      confidenceValue: confidenceToNumber(result.confidence),
    })
  ) {
    return true;
  }
  return false;
}

export interface ReadjudicateParams<T extends ReadjudicableResult> {
  result: T;
  /** The measure's positive criteria as free text (title / definition / target). */
  criteria: string[];
  /** The company's assembled evidence pack (extracted corpus the scorer reads). */
  packText: string;
  /** Pre-parsed segments; derived from packText when omitted. */
  segments?: DocumentSegment[];
  policyVersion?: GatePolicyVersion;
  /** Flag 10: numeric confidence threshold (null/absent = unchanged candidacy). */
  confidenceThreshold?: number | null;
}

/**
 * Re-adjudicate a single flagged measure result ONCE. Pure except for setting the
 * trace / flags on the passed result; deterministic and corpus-only. When the row
 * is not a candidate (unflagged, or already traced) the result is returned
 * unchanged, so unflagged rows are never touched and a second run is stable.
 */
export function readjudicateMeasure<T extends ReadjudicableResult>(params: ReadjudicateParams<T>): T {
  const { result, criteria, packText } = params;
  if (!shouldReadjudicate(result, { confidenceThreshold: params.confidenceThreshold })) return result;

  const policy = resolveGatePolicy(params.policyVersion);
  const segments = params.segments ?? parsePackSegments(packText || "");
  const passagesSearched = researchCandidatePassages(segments, packText || "").length;
  const originalVerdict = String(result.verdict ?? "");
  const originalScore = typeof result.score === "number" ? result.score : 0;
  const reason = String(result.inconsistencyReason ?? "").trim() || "flagged-inconsistent";

  const found = researchBestPassage(policy, criteria, segments, packText || "");
  const satisfied = found
    ? rescuePassageSatisfiesCriteria(policy, criteria, found.text).satisfied
    : false;

  let newVerdict: string;
  let resolution: ReadjudicationTrace["resolution"];
  if (found && satisfied) {
    // Alternative evidence in the corpus satisfies the criteria → the verdict moves.
    newVerdict = "Yes";
    result.verdict = "Yes";
    result.score = 1;
    result.quotes = [...(result.quotes ?? []), { text: found.text, source: found.source }];
    resolution = "moved-to-yes";
  } else {
    // No qualifying alternative passage → stay No, but CLEAR the flag with a reason.
    newVerdict = String(result.verdict ?? "No");
    resolution = "confirmed-no";
  }

  const trace: ReadjudicationTrace = {
    originalVerdict,
    originalScore,
    reason,
    passagesSearched,
    foundPassage: found ? found.text : null,
    foundSource: found ? found.source : null,
    newVerdict,
    cleared: true,
    resolution,
  };
  result.readjudicationTrace = trace;
  // The flag is now resolved (consumed) — clear it so a later run / the detector
  // does not re-process the same row.
  result.needsReadjudication = false;

  // Append a compact, deterministic audit note to the nuance so the re-look is
  // visible to a reader without inspecting the structured trace.
  const note =
    resolution === "moved-to-yes"
      ? `[Re-adjudication: ${passagesSearched} passages searched; alternative supporting evidence found → verdict moved to Yes.]`
      : `[Re-adjudication: ${passagesSearched} passages searched; no alternative passage satisfied the criteria → No confirmed, flag cleared (${reason}).]`;
  result.verdictNuance = `${result.verdictNuance ? `${result.verdictNuance} ` : ""}${note}`;

  return result;
}

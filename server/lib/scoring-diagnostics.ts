/**
 * Instruction 46 Follow-Up — Scoring Diagnostics (fw8 Calibration)
 * ─────────────────────────────────────────────────────────────────
 * Measure-level diagnostics exposing:
 *  - Candidate passage count per measure
 *  - Selected passage count and identifiers
 *  - Extraction validity (structured output parse success)
 *  - Fallback/default-score usage per measure
 *  - Per-measure score contributions to the total
 *  - Zero/near-zero classification: no-evidence vs retrieval-failure
 *    vs timeout vs extraction-failure vs legitimate-zero
 *
 * Framework-agnostic: works for any framework (fw3, fw8, or future).
 * All scoring behavior remains schema-driven.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ZeroScoreReason =
  | "no-evidence"
  | "retrieval-failure"
  | "timeout"
  | "extraction-failure"
  | "legitimate-zero"
  | "scoring-failure"
  | "abstained";

export interface MeasureScoringDiagnostic {
  measureId: string;
  category: string;
  categoryNumber: number;
  /** Number of candidate passages considered for this measure */
  candidatePassageCount: number;
  /** Number of passages actually selected for scoring context */
  selectedPassageCount: number;
  /** Whether structured output extraction was valid */
  extractionValid: boolean;
  /** Whether a fallback model was used */
  fallbackUsed: boolean;
  /** Whether the default score (0) was applied due to failure */
  defaultScoreUsed: boolean;
  /** The final score for this measure */
  score: number;
  /** Confidence level */
  confidence: string;
  /** Whether the measure was abstained */
  abstained: boolean;
  /** Classification of zero/near-zero scores */
  zeroReason: ZeroScoreReason | null;
  /** Self-consistency vote result (e.g. "3/3") */
  selfConsistencyResult: string | null;
}

export interface BatchScoringDiagnostics {
  companyId: number;
  companyName: string;
  frameworkId: number;
  totalMeasures: number;
  scoredMeasures: number;
  abstainedMeasures: number;
  /** Sum of all measure scores */
  rawScoreSum: number;
  /** Percentage score */
  scorePercentage: number;
  /** Per-measure diagnostics */
  measures: MeasureScoringDiagnostic[];
  /** Aggregate zero-reason breakdown */
  zeroReasonBreakdown: Record<ZeroScoreReason, number>;
  /** Timestamp */
  generatedAt: string;
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Classify why a measure received a zero score.
 * Uses evidence-pack metadata and scoring result metadata.
 * Framework-agnostic — works for any topic.
 */
export function classifyZeroScore(opts: {
  score: number;
  confidence: string;
  abstained: boolean;
  candidatePassageCount: number;
  selectedPassageCount: number;
  extractionValid: boolean;
  fallbackUsed: boolean;
  defaultScoreUsed: boolean;
  scoringFailure: string | null;
  coverage: string | null;
}): ZeroScoreReason | null {
  // Non-zero scores don't need classification
  if (opts.score > 0) return null;

  // Abstained measures
  if (opts.abstained) return "abstained";

  // Scoring failure (timeout or model error)
  if (opts.scoringFailure === "timeout") return "timeout";
  if (opts.scoringFailure) return "scoring-failure";

  // Default score applied due to extraction failure
  if (opts.defaultScoreUsed && !opts.extractionValid) return "extraction-failure";

  // No evidence available (empty evidence pack)
  if (opts.candidatePassageCount === 0 || opts.coverage === "none") return "no-evidence";

  // Evidence was found but retrieval produced nothing usable
  if (opts.selectedPassageCount === 0 && opts.candidatePassageCount > 0) return "retrieval-failure";

  // Evidence was found, extraction succeeded, but the answer is genuinely "No"
  if (opts.extractionValid && opts.selectedPassageCount > 0 && opts.confidence !== "Low") {
    return "legitimate-zero";
  }

  // Low confidence zero with some evidence — likely insufficient
  if (opts.confidence === "Low" && opts.selectedPassageCount > 0) {
    return "extraction-failure";
  }

  return "legitimate-zero";
}

// ─── Builder ────────────────────────────────────────────────────────────────

/**
 * Build scoring diagnostics for a company's analysis run.
 * Called after all measures have been scored.
 */
export function buildScoringDiagnostics(opts: {
  companyId: number;
  companyName: string;
  frameworkId: number;
  measures: MeasureScoringDiagnostic[];
  scorePercentage: number;
}): BatchScoringDiagnostics {
  const totalMeasures = opts.measures.length;
  const abstainedMeasures = opts.measures.filter(m => m.abstained).length;
  const scoredMeasures = totalMeasures - abstainedMeasures;
  const rawScoreSum = opts.measures.reduce((sum, m) => sum + m.score, 0);

  // Build zero-reason breakdown
  const zeroReasonBreakdown: Record<ZeroScoreReason, number> = {
    "no-evidence": 0,
    "retrieval-failure": 0,
    "timeout": 0,
    "extraction-failure": 0,
    "legitimate-zero": 0,
    "scoring-failure": 0,
    "abstained": 0,
  };

  for (const m of opts.measures) {
    if (m.zeroReason) {
      zeroReasonBreakdown[m.zeroReason]++;
    }
  }

  return {
    companyId: opts.companyId,
    companyName: opts.companyName,
    frameworkId: opts.frameworkId,
    totalMeasures,
    scoredMeasures,
    abstainedMeasures,
    rawScoreSum,
    scorePercentage: opts.scorePercentage,
    measures: opts.measures,
    zeroReasonBreakdown,
    generatedAt: new Date().toISOString(),
  };
}

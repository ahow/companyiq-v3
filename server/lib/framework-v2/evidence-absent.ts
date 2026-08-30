/**
 * Sprint 10 P3 — Evidence-absent tagging
 *
 * Ported from workspace Python (companyiq-runs/sprint9d_extensions.py:
 * classify_verdict_with_absence).
 *
 * Distinguishes "we couldn't find any relevant passage" (evidence_absent)
 * from a substantive "No" verdict. The pipeline's current requiredSourceTypes
 * mechanism already produces "Insufficient evidence" verdicts when a required
 * document type is missing from the corpus. This module extends that to also
 * flag evidence-absent when:
 *
 *   1. Per-measure retrieval returned empty evidence, AND
 *   2. No relevant hits were found across the URL manifest.
 *
 * The pipeline's downstream aggregation treats evidence_absent as 0 for
 * cell-level metrics (same as No for backward compatibility), but reporting
 * exposes the tag so analysts can distinguish "no policy" from "we couldn't
 * find the disclosure".
 */

export interface EvidenceAbsentClassifyInput {
  verdict: "Yes" | "No" | "Partial" | "Insufficient evidence";
  evidenceText: string;
  urlsWithHits: number;
  measureId: string;
}

export interface EvidenceAbsentClassifyOutput {
  verdict: "Yes" | "No" | "Partial" | "Insufficient evidence" | "Evidence absent";
  wasReclassified: boolean;
  reason?: string;
}

/**
 * If the primary verdict was No AND evidence was empty AND no URLs surfaced
 * relevant hits, reclassify as Evidence absent. Otherwise return the original
 * verdict.
 */
export function classifyVerdictWithAbsence(input: EvidenceAbsentClassifyInput): EvidenceAbsentClassifyOutput {
  if (input.verdict !== "No") {
    return { verdict: input.verdict, wasReclassified: false };
  }

  const evidenceIsEmpty = !input.evidenceText || input.evidenceText.trim().length < 50;
  const noHits = input.urlsWithHits === 0;

  if (evidenceIsEmpty && noHits) {
    return {
      verdict: "Evidence absent",
      wasReclassified: true,
      reason: `No relevant passage found in ${input.urlsWithHits} URLs and evidence text was empty.`,
    };
  }

  return { verdict: input.verdict, wasReclassified: false };
}

/**
 * For cell-level metrics aggregation, evidence_absent counts as 0 (same as No).
 * For coverage reporting, it may be excluded from denominators.
 * For analyst-facing UI, it should be surfaced explicitly.
 */
export function evidenceAbsentAsBinary(verdict: string): 0 | 1 {
  if (verdict === "Yes") return 1;
  // "No", "Partial", "Insufficient evidence", "Evidence absent" all score 0
  return 0;
}

/**
 * Canonical, topic-agnostic verdict normalization for binary (Yes/No) scoring.
 *
 * The product used to emit a tri-state verdict ("Yes" | "Partial" | "No"). The
 * "Partial" outcome has been collapsed to "No" everywhere: a Partial is recorded
 * and displayed exactly as a No, does not count as a met measure, and does not
 * contribute to the Total Score (%).
 *
 * This is the SINGLE shared source of truth. Import it wherever a verdict is
 * displayed, exported, aggregated, or produced so the behaviour stays consistent
 * across every framework. Do NOT scatter ad-hoc `verdict === "Partial"` string
 * checks around the codebase.
 *
 * IMPORTANT: only "Partial" is collapsed. Abstain / insufficient-evidence and
 * scoring-error sentinels (e.g. "Insufficient evidence", "Scoring error",
 * "not_assessed") are preserved unchanged — those are excluded from the
 * denominator elsewhere and must keep their distinct semantics.
 */

/**
 * Collapse a raw stored/produced verdict to its binary form. Only "Partial"
 * (case-insensitive) becomes "No"; every other value (including abstain/error
 * sentinels) is returned verbatim. Missing/blank verdicts become "No".
 */
export function normalizeVerdict(verdict?: string | null): string {
  if (typeof verdict !== "string") return "No";
  const t = verdict.trim();
  if (t === "") return "No";
  if (t.toLowerCase() === "partial") return "No";
  return verdict;
}

/**
 * Whether a measure counts as MET (a "Yes") under binary scoring.
 * - explicit "Yes" verdict => met
 * - if no verdict string is present, fall back to a numeric score of exactly 1
 * - "Partial", "No", abstain, error, or a fractional/zero score => not met
 */
export function isMet(verdict?: string | null, score?: number | null): boolean {
  const v = typeof verdict === "string" ? verdict.trim().toLowerCase() : "";
  if (v === "yes") return true;
  if (v === "") return score === 1;
  return false;
}

/**
 * The binary numeric score (1 for met, 0 otherwise). Use when persisting or
 * aggregating so a former Partial (0.5) never contributes fractionally.
 */
export function normalizedScore(verdict?: string | null, score?: number | null): number {
  return isMet(verdict, score) ? 1 : 0;
}

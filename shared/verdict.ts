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

export interface MeasureScoreLike {
  verdict?: string | null;
  score?: number | null;
  abstained?: boolean | null;
  backfilled?: boolean | null;
}

export interface CompanyScore {
  totalScorePct: number;   // HEADLINE: met / answered  (coverage-aware)
  measuresMet: number;     // # met (binary isMet)
  answeredCount: number;   // assessed AND not abstained
  assessedCount: number;   // not backfilled
  measureCount: number;    // all measures in the framework
  coveragePct: number;     // assessed / measureCount
  strictScorePct: number;  // met / measureCount  (Yes across ALL measures)
}

/**
 * The SINGLE source of truth for a company's aggregate score. Binary only
 * (Partial already collapses to No via isMet). The headline Total Score is
 * met / answered, where "answered" = measures that were assessed (not
 * backfilled) AND the model gave a real verdict (not abstained/insufficient).
 * Also returns coverage and the strict (Yes / all measures) figure so callers
 * can surface all three numbers. Use everywhere a company score is computed.
 */
export function computeCompanyScore(
  measures: MeasureScoreLike[],
  measureCount?: number,
): CompanyScore {
  const all = measures || [];
  const total = typeof measureCount === "number" && measureCount > 0 ? measureCount : all.length;
  const assessed = all.filter((m) => m.backfilled !== true);
  const answered = assessed.filter((m) => m.abstained !== true);
  const met = answered.filter((m) => isMet(m.verdict, m.score));
  const totalScorePct = answered.length > 0 ? Math.round((met.length / answered.length) * 100) : 0;
  const coveragePct = total > 0 ? Math.round((assessed.length / total) * 100) : 100;
  const strictScorePct = total > 0 ? Math.round((met.length / total) * 100) : 0;
  return {
    totalScorePct,
    measuresMet: met.length,
    answeredCount: answered.length,
    assessedCount: assessed.length,
    measureCount: total,
    coveragePct,
    strictScorePct,
  };
}

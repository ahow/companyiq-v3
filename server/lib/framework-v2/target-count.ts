/**
 * resolveTargetCount — normalise the framework size the user picked at intake.
 *
 * The intake LLM writes `targetMeasureCount` into the intake artefact, but its
 * formatting is not guaranteed: it can be a clean integer, a numeric string, a
 * range like "20-30" / "20–30", or a size label like "Balanced (20–30 measures)".
 * The drafter's routing (single-shot vs chunked) and its count clause depend on
 * a reliable integer, so ALL consumers must go through this normaliser rather
 * than reading the raw field.
 *
 * Mapping:
 *   - number                     → Math.round (only if > 0)
 *   - numeric string "25"        → 25
 *   - range "20-30" / "20–30"    → UPPER bound (30) — a user who chose the bigger
 *                                  option should not be silently shortchanged
 *   - size labels (case-insensitive; may also carry a range):
 *       compact       → 18   (upper end of Compact 12–18)
 *       balanced      → 30   (upper end of Balanced 20–30)
 *       comprehensive → 50   (upper end of Comprehensive 35–50)
 *     If a label ALSO carries an explicit number or range, the explicit
 *     number/range wins (e.g. "Comprehensive (35-50)" → 50; "Custom: 42" → 42).
 *   - anything unparseable / missing → undefined
 */
export function resolveTargetCount(intake: unknown): number | undefined {
  const raw = (intake as any)?.targetMeasureCount;
  return resolveTargetCountValue(raw);
}

/** Core normaliser operating on the raw field value (exported for testing). */
export function resolveTargetCountValue(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;

  // Clean number.
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return undefined;
    return Math.round(raw);
  }

  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (s === "") return undefined;

  // Explicit number/range anywhere in the string wins over a label word.
  // Match a range first (e.g. "20-30", "20 – 30", "35–50 measures").
  const rangeMatch = s.match(/(\d+)\s*[-–—]\s*(\d+)/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
    const upper = Math.max(lo, hi);
    return upper > 0 ? upper : undefined;
  }

  // Single number anywhere (e.g. "25", "Custom: 42", "about 30 measures").
  const numMatch = s.match(/\d+/);
  if (numMatch) {
    const n = parseInt(numMatch[0], 10);
    return n > 0 ? n : undefined;
  }

  // No digits — fall back to label words (upper end of each chip's range).
  const lower = s.toLowerCase();
  if (lower.includes("compact")) return 18;
  if (lower.includes("balanced")) return 30;
  if (lower.includes("comprehensive")) return 50;

  return undefined;
}

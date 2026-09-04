/**
 * Tri-state boolean parser for CSV/upload flag columns.
 *
 * Returns:
 *   true   \u2014 explicit truthy value ("true", "yes", "y", "1",
 *                                       plus context-specific aliases below)
 *   false  \u2014 explicit falsy  value ("false", "no", "n", "0",
 *                                       plus context-specific aliases below)
 *   null   \u2014 absent, empty, or unrecognised string
 *
 * The null case is deliberately distinct from `false` so callers can tell
 * "user typed something we didn't understand" apart from "user explicitly
 * said no". Callers deciding how to treat null (default to false, ignore,
 * warn) must make that choice explicitly.
 *
 * Aliases are chosen for spreadsheet ergonomics. Extend the arrays only
 * when adding new aliases for the same tri-state meaning \u2014 do NOT expand
 * the null case (unrecognised) to accept typo-tolerant matches, because
 * that would silently misclassify malformed inputs.
 */
export function parseBooleanFlag(raw: string | null | undefined): boolean | null {
  if (raw == null) return null;
  const t = String(raw).trim().toLowerCase();
  if (t === "") return null;
  if (["true", "yes", "y", "1", "unlisted", "private"].includes(t)) return true;
  if (["false", "no", "n", "0", "listed", "public"].includes(t)) return false;
  return null;
}

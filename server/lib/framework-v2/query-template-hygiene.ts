/**
 * Deterministic query-template hygiene (definition-of-good dimension 4).
 *
 * Search/query templates generated at build time can carry two classes of
 * retrieval-killing junk that the reviewer agent flags:
 *   - STALE HARDCODED YEARS ("… by 2025") — freeze the query to a single year,
 *     so evidence from other years is missed as the calendar moves on.
 *   - JUNK-VERB-ONLY templates (e.g. `"{company}" approve`) — a bare function
 *     verb with no topic anchor, which retrieves noise.
 *
 * Both are fixed DETERMINISTICALLY here (no LLM), before the framework is
 * validated: stale years are parameterised to the `{currentYear}` placeholder
 * (which discovery.ts already substitutes at query time), and junk-verb-only
 * templates are dropped. Nothing here emits a violation, so the repair loop is
 * never touched. Callers should log the returned `dropped`/`rewritten` lists.
 */

// Content verbs that, standing alone as a template's only topic token, carry no
// retrieval signal. Kept small and conservative so genuine topic terms survive.
const JUNK_VERBS = new Set([
  "approve", "approved", "approves", "approving",
  "review", "reviewed", "reviews", "reviewing",
  "consider", "considered", "considers", "considering",
  "note", "noted", "notes", "noting",
  "discuss", "discussed", "discusses", "discussing",
  "update", "updated", "updates", "updating",
]);

// Placeholders that are legitimate template variables, not content tokens.
const PLACEHOLDER_TOKENS = new Set([
  "{company}", "{currentyear}", "{lastyear}", "{yearrange}", "{vehicletype}",
]);

export interface QueryTemplateHygieneResult {
  cleaned: string[];
  dropped: string[];     // templates removed entirely (junk-verb-only / empty)
  rewritten: string[];   // "<before>  →  <after>" for year-parameterised templates
}

/**
 * Reduce a template to its meaningful content tokens: strip quotes, punctuation
 * and known placeholders. Used to decide whether a template is junk-verb-only.
 */
function contentTokens(template: string): string[] {
  return template
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !PLACEHOLDER_TOKENS.has(t))
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

/**
 * Sanitise a list of search/query templates in place-order-preserving fashion.
 * - Hardcoded 4-digit years (19xx / 20xx) are replaced with `{currentYear}`.
 * - Templates whose only content token is a junk verb (or that reduce to no
 *   content at all) are dropped.
 * Deduplicates while preserving first-seen order. Deterministic; no LLM.
 */
export function sanitizeSearchTemplates(templates: unknown): QueryTemplateHygieneResult {
  const cleaned: string[] = [];
  const dropped: string[] = [];
  const rewritten: string[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(templates)) return { cleaned, dropped, rewritten };

  for (const raw of templates) {
    if (typeof raw !== "string") continue;
    const original = raw;
    const trimmed = raw.trim();
    if (!trimmed) { dropped.push(original); continue; }

    // Parameterise stale hardcoded years → {currentYear} placeholder.
    const yearParameterised = trimmed.replace(/\b(?:19|20)\d{2}\b/g, "{currentYear}");
    if (yearParameterised !== trimmed) rewritten.push(`${trimmed}  →  ${yearParameterised}`);

    // Drop junk-verb-only / content-less templates.
    const content = contentTokens(yearParameterised);
    const nonPlaceholderContent = content.filter((t) => t !== "currentyear" && t !== "lastyear");
    const isJunkVerbOnly =
      nonPlaceholderContent.length === 0 ||
      (nonPlaceholderContent.length === 1 && JUNK_VERBS.has(nonPlaceholderContent[0]));
    if (isJunkVerbOnly) { dropped.push(original); continue; }

    const key = yearParameterised.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(yearParameterised);
  }

  return { cleaned, dropped, rewritten };
}

// Shared, PURE helpers for the opt-in completeness features:
//   E — deep second discovery pass (DISCOVERY_DEEP_SECOND_PASS)
//   G — mandatory completeness re-search before scoring (COMPLETENESS_MANDATORY_RESEARCH)
//
// All framework-required document types come from the framework definition
// (framework.requiredDocTypes) — NEVER hardcoded company/framework/measure
// names. This module is network-free, DB-free and LLM-free so it is unit
// testable in isolation; the pipeline wires it to the targeted-search primitive
// and a bounded worker pool.

export interface CandidateLike {
  title?: string | null;
  url?: string | null;
}

/**
 * Split a (possibly compound) required-doc-type label into the lowercase match
 * forms used to detect whether a candidate satisfies it. Mirrors the clause
 * splitting used by discovery's own matchesRequiredDocType so E/G stay
 * consistent with the doctype-aware discovery boost. Framework-agnostic: it only
 * ever operates on the operator/framework-authored label text.
 */
export function docTypeMatchForms(docType: string): string[] {
  if (!docType) return [];
  const clauses = String(docType)
    .split(/\s+(?:or|and|&)\s+|,\s+|\s*\/\s*/i)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3);
  const forms = Array.from(new Set([String(docType).trim().toLowerCase(), ...clauses]));
  return forms.filter((f) => f.length >= 3);
}

/** True when a single candidate's title/url satisfies a single required type. */
export function candidateMatchesDocType(candidate: CandidateLike, docType: string): boolean {
  const hay = `${candidate.title || ""} ${candidate.url || ""}`.toLowerCase();
  if (!hay.trim()) return false;
  for (const f of docTypeMatchForms(docType)) {
    // For multi-word clauses require ALL words to be present in any order
    // (per user steer 2026-11), which matches compound titles like "2023 TCFD
    // Disclosure and Report" against the "TCFD Report" required type.
    // For short/acronym clauses require a word-boundary-ish match to avoid
    // accidental substring hits.
    if (f.includes(" ")) {
      const words = f.split(/\s+/).filter(w => w.length >= 3);
      if (words.length > 0 && words.every(w => hay.includes(w))) return true;
    } else {
      const re = new RegExp(
        `(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
        "i",
      );
      if (re.test(hay)) return true;
    }
  }
  return false;
}

/**
 * Given the framework's required doc types and the CURRENT candidate corpus,
 * return the required types for which NO candidate currently matches — i.e. the
 * gaps still visible after the first discovery pass. De-duplicated, original
 * label text preserved. Empty input ⇒ empty output (nothing to research).
 */
export function computeMissingRequiredDocTypes(
  requiredDocTypes: readonly (string | null | undefined)[] | null | undefined,
  candidates: readonly CandidateLike[],
): string[] {
  if (!requiredDocTypes || requiredDocTypes.length === 0) return [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const raw of requiredDocTypes) {
    const dt = (raw || "").trim();
    if (!dt) continue;
    const key = dt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const present = candidates.some((c) => candidateMatchesDocType(c, dt));
    if (!present) missing.push(dt);
  }
  return missing;
}

/**
 * Plan which missing doc types to actually research this turn, after removing
 * any that have ALREADY been covered this turn — by an earlier pass (E) or by a
 * mechanism that will fetch the same gap (D / RC6 readiness retry). This is the
 * coordination point that prevents double-fetching the same gap.
 * Matching is case-insensitive on trimmed label text.
 */
export function planCompletenessResearch(opts: {
  missing: readonly string[];
  alreadyResearched?: Iterable<string>;
}): string[] {
  const covered = new Set<string>();
  for (const t of opts.alreadyResearched || []) {
    const k = (t || "").trim().toLowerCase();
    if (k) covered.add(k);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of opts.missing) {
    const dt = (raw || "").trim();
    if (!dt) continue;
    const key = dt.toLowerCase();
    if (covered.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(dt);
  }
  return out;
}

/**
 * Build a single framework-agnostic targeted search query for a missing doc
 * type. Uses only the company name and the operator/framework-authored doc-type
 * label — no hardcoded company/framework/measure names.
 */
export function buildDocTypeResearchQuery(companyName: string, docType: string): string {
  const name = (companyName || "").trim();
  const dt = (docType || "").trim();
  return `${name} ${dt}`.trim();
}

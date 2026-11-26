// Shared, dependency-free company-name normalization. Kept as a LEAF module (no
// DB / network imports) so pure-logic callers and their unit tests can use it
// without pulling in the DB layer. Both issuer-resolver.ts (deriveAliases) and
// scoring-fix-flags.ts (resolvePerCompanyEntities key matching) reuse THIS single
// canonical set rather than maintaining divergent copies.

/** Canonical corporate-form / generic / industry / geo words that carry no
 *  distinctive identity on their own. */
export const GENERIC_WORDS = new Set([
  "the", "and", "for", "of", "group", "holding", "holdings", "company", "companies",
  "corp", "corporation", "incorporated", "inc", "ltd", "limited", "llc", "plc",
  "co", "sa", "se", "ag", "nv", "spa", "oyj", "asa", "ab", "as", "bv", "kg",
  "international", "global", "worldwide", "industries", "industrial", "enterprise",
  "enterprises", "technologies", "technology", "systems", "solutions", "services",
  "products", "bank", "banking", "capital", "partners", "resources", "materials",
  "energy", "power", "motors", "financial", "pharmaceutical", "pharmaceuticals",
  "chemical", "chemicals", "insurance", "asset", "management", "trust",
  "australia", "america", "american", "national", "japan", "china", "korea",
  "hong", "kong", "india", "indian", "canada", "canadian", "uk", "british",
]);

/** Normalise a company/config name to its set of distinctive (non-generic) word
 *  tokens. Lowercases, replaces punctuation with spaces, splits on whitespace,
 *  and drops single-char tokens and GENERIC_WORDS. Framework- and
 *  company-agnostic — purely data-driven. */
export function distinctiveWordSet(name: string): Set<string> {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[/\\,.'()&]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !GENERIC_WORDS.has(w))
  );
}

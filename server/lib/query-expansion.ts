/**
 * Instruction 46 — Framework-Driven Query Expansion
 * ──────────────────────────────────────────────────
 * Generates deterministic search queries from issuer aliases + framework schema.
 * Replaces empty or legacy-only prioritisation with:
 *  - Framework evidenceKeywords
 *  - Report-type synonyms
 *  - Disclosure-standard terms
 *  - Local-language variants
 *  - Year variants
 *
 * No topic-specific logic in code — all behaviour driven by framework schema.
 */

import type { IssuerProfile } from "./issuer-profile.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExpandedQuery {
  query: string;
  source: "evidence-keyword" | "report-type" | "disclosure-standard" | "local-language" | "year-variant" | "alias-cross" | "registry" | "qualifying-instance";
  priority: number; // lower = higher priority
}

export interface QueryExpansionResult {
  queries: ExpandedQuery[];
  diagnostics: {
    evidenceKeywordQueries: number;
    reportTypeQueries: number;
    localLanguageQueries: number;
    yearVariantQueries: number;
    aliasCrossQueries: number;
    qualifyingInstanceQueries: number;
    totalGenerated: number;
  };
}

// ─── Evidence Keyword Expansion ─────────────────────────────────────────────

/**
 * Generate queries from framework measure evidenceKeywords.
 * These are the most targeted queries — they use the exact vocabulary
 * that the scoring engine looks for in passages.
 */
function expandFromEvidenceKeywords(
  profile: IssuerProfile,
  evidenceKeywords: string[],
  maxQueries: number = 12,
): ExpandedQuery[] {
  if (!evidenceKeywords || evidenceKeywords.length === 0) return [];

  const queries: ExpandedQuery[] = [];
  const primaryName = profile.figiName || profile.legalName;

  // Use the top evidence keywords paired with the primary issuer name
  const topKeywords = evidenceKeywords.slice(0, maxQueries);
  for (const kw of topKeywords) {
    queries.push({
      query: `"${primaryName}" ${kw}`,
      source: "evidence-keyword",
      priority: -20,
    });
  }

  // Cross with secondary aliases for broader recall
  const secondaryAliases = profile.queryAliases
    .filter(a => a !== primaryName.toLowerCase() && a.length >= 4)
    .slice(0, 3);
  for (const alias of secondaryAliases) {
    for (const kw of evidenceKeywords.slice(0, 3)) {
      queries.push({
        query: `"${alias}" ${kw}`,
        source: "alias-cross",
        priority: -10,
      });
    }
  }

  return queries;
}

// ─── Report-Type Synonym Expansion ──────────────────────────────────────────

/** Universal report-type synonyms that apply across all frameworks. */
const REPORT_TYPE_SYNONYMS: Record<string, string[]> = {
  "annual report": ["annual report", "integrated report", "yearly report"],
  "sustainability report": ["sustainability report", "ESG report", "CSR report", "responsible business report"],
  "modern slavery statement": ["modern slavery statement", "modern slavery act statement", "transparency in supply chains statement", "forced labour statement"],
  "climate report": ["climate report", "TCFD report", "climate-related financial disclosure", "transition plan"],
  "proxy statement": ["proxy statement", "DEF 14A", "notice of annual meeting"],
  "governance report": ["governance report", "corporate governance statement", "board governance"],
};

function expandFromReportTypes(
  profile: IssuerProfile,
  requiredDocTypes: string[],
): ExpandedQuery[] {
  if (!requiredDocTypes || requiredDocTypes.length === 0) return [];

  const queries: ExpandedQuery[] = [];
  const primaryName = profile.figiName || profile.legalName;
  const currentYear = new Date().getFullYear();

  for (const docType of requiredDocTypes.slice(0, 5)) {
    const docTypeLower = docType.toLowerCase();
    // Find synonyms for this doc type
    let synonyms: string[] = [docType];
    for (const [key, syns] of Object.entries(REPORT_TYPE_SYNONYMS)) {
      if (docTypeLower.includes(key) || key.includes(docTypeLower)) {
        synonyms = [...new Set([docType, ...syns])];
        break;
      }
    }

    for (const syn of synonyms.slice(0, 3)) {
      queries.push({
        query: `"${primaryName}" "${syn}" ${currentYear} OR ${currentYear - 1}`,
        source: "report-type",
        priority: -15,
      });
    }
  }

  return queries;
}

// ─── Local-Language Expansion ───────────────────────────────────────────────

/**
 * Generate local-language query variants when the issuer operates in a
 * non-English market. Uses the profile's supported languages to determine
 * which variants to generate.
 */
function expandLocalLanguage(
  profile: IssuerProfile,
  topicPhrases: string[],
): ExpandedQuery[] {
  if (profile.supportedLanguages.length <= 1) return []; // English-only
  if (!topicPhrases || topicPhrases.length === 0) return [];

  const queries: ExpandedQuery[] = [];
  const primaryName = profile.figiName || profile.legalName;

  // Find topic phrases that appear to be in non-English languages
  const nonEnglishPhrases = topicPhrases.filter(p => {
    // CJK characters
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(p)) return true;
    // Non-ASCII Latin (accented characters)
    if (/[àâçéèêëîïôùûüÿñæœäöüß]/i.test(p)) return true;
    return false;
  });

  for (const phrase of nonEnglishPhrases.slice(0, 4)) {
    queries.push({
      query: `"${primaryName}" ${phrase}`,
      source: "local-language",
      priority: -8,
    });
  }

  // Also try local-language names if available
  for (const localName of profile.localLanguageNames.slice(0, 2)) {
    for (const phrase of topicPhrases.slice(0, 2)) {
      queries.push({
        query: `"${localName}" ${phrase}`,
        source: "local-language",
        priority: -8,
      });
    }
  }

  return queries;
}

// ─── Year-Variant Expansion ─────────────────────────────────────────────────

function expandYearVariants(
  profile: IssuerProfile,
  topicPhrases: string[],
): ExpandedQuery[] {
  const queries: ExpandedQuery[] = [];
  const primaryName = profile.figiName || profile.legalName;
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear - 1, currentYear - 2];

  // Only generate year variants for the top 2 topic phrases
  for (const phrase of (topicPhrases || []).slice(0, 2)) {
    for (const year of years) {
      queries.push({
        query: `"${primaryName}" ${phrase} ${year}`,
        source: "year-variant",
        priority: -5,
      });
    }
  }

  // Disclosure-year variants: FY/CY format for annual filings
  for (const year of [currentYear, currentYear - 1]) {
    queries.push({
      query: `"${primaryName}" annual report FY${year}`,
      source: "year-variant",
      priority: -4,
    });
  }

  return queries;
}

// ─── Transliteration Expansion ──────────────────────────────────────────────

/**
 * Generate transliterated query variants for issuers with local-language names.
 * Uses the profile's local-language names and supported languages to build
 * queries that combine transliterated names with framework topic terms.
 * Framework-agnostic: works for any topic.
 */
function expandTransliterations(
  profile: IssuerProfile,
  topicPhrases: string[],
  evidenceKeywords: string[],
): ExpandedQuery[] {
  if (profile.localLanguageNames.length === 0 && profile.supportedLanguages.length <= 1) return [];
  const queries: ExpandedQuery[] = [];

  // Use local-language names with evidence keywords
  for (const localName of profile.localLanguageNames.slice(0, 2)) {
    for (const kw of evidenceKeywords.slice(0, 3)) {
      queries.push({
        query: `"${localName}" ${kw}`,
        source: "local-language",
        priority: -12,
      });
    }
    // Also pair with top topic phrases
    for (const phrase of topicPhrases.slice(0, 2)) {
      queries.push({
        query: `"${localName}" ${phrase}`,
        source: "local-language",
        priority: -10,
      });
    }
  }

  return queries;
}

// ─── Qualifying-Instance Expansion (B4) ─────────────────────────────────────

/**
 * B4 — Generate queries from each measure's authored `qualifyingInstance` (the
 * positive definition of what actually counts as a Yes: a named programme/policy/
 * system, a quantified commitment, or a dated milestone). These are the most
 * targeted retrieval queries because they describe the specific evidence a Yes
 * requires, not just the topic. UNIONed with the generic queries in expandQueries;
 * when no structured guidance is present the array is empty and retrieval falls
 * back to the generic query set unchanged.
 *
 * GENERIC: the qualifyingInstance strings are framework-authored (stored per
 * measure in the DB) — this code hardcodes no framework/measure/company specifics.
 * Deterministic: same inputs → same output.
 */
function expandFromQualifyingInstances(
  profile: IssuerProfile,
  qualifyingInstances: string[],
  maxQueries: number = 12,
): ExpandedQuery[] {
  if (!qualifyingInstances || qualifyingInstances.length === 0) return [];

  const queries: ExpandedQuery[] = [];
  const primaryName = profile.figiName || profile.legalName;

  // Normalize + de-duplicate the qualifying-instance phrases. Collapse whitespace,
  // strip embedded quotes (they would break the quoted issuer-name query), and cap
  // length so a long definition still forms a usable search phrase.
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of qualifyingInstances) {
    if (typeof raw !== "string") continue;
    const phrase = raw.replace(/["""]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
    if (phrase.length < 4) continue;
    const key = phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(phrase);
  }

  for (const phrase of cleaned.slice(0, maxQueries)) {
    queries.push({
      query: `"${primaryName}" ${phrase}`,
      source: "qualifying-instance",
      // Highest priority: the qualifying instance is the exact evidence a Yes needs.
      priority: -22,
    });
  }

  return queries;
}

// ─── Main Expansion Function ────────────────────────────────────────────────

/**
 * Generate all expanded queries from the issuer profile and framework schema.
 * Returns queries sorted by priority (most important first).
 * Deterministic: same inputs → same output.
 */
export function expandQueries(opts: {
  profile: IssuerProfile;
  evidenceKeywords: string[];
  requiredDocTypes: string[];
  topicPhrases: string[];
  // B4: per-measure authored qualifyingInstance phrases (aggregated across the
  // framework). Optional — when absent/empty, the query set is exactly the generic
  // set (backward compatible with prose-only / un-tightened frameworks).
  qualifyingInstances?: string[];
  maxTotal?: number;
}): QueryExpansionResult {
  const maxTotal = opts.maxTotal || 40;

  const evidenceKwQueries = expandFromEvidenceKeywords(opts.profile, opts.evidenceKeywords);
  const reportTypeQueries = expandFromReportTypes(opts.profile, opts.requiredDocTypes);
  const localLangQueries = expandLocalLanguage(opts.profile, opts.topicPhrases);
  const yearVariantQueries = expandYearVariants(opts.profile, opts.topicPhrases);
  const translitQueries = expandTransliterations(opts.profile, opts.topicPhrases, opts.evidenceKeywords);
  // B4: UNION the qualifyingInstance-derived queries with the generic set above.
  const qualifyingInstanceQueries = expandFromQualifyingInstances(opts.profile, opts.qualifyingInstances || []);

  // Combine all, sort by priority, deduplicate, and cap
  const allQueries = [
    ...qualifyingInstanceQueries,
    ...evidenceKwQueries,
    ...reportTypeQueries,
    ...localLangQueries,
    ...yearVariantQueries,
    ...translitQueries,
  ];

  // Deduplicate by normalized query string
  const seen = new Set<string>();
  const deduped = allQueries.filter(q => {
    const key = q.query.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by priority (lower = higher priority)
  deduped.sort((a, b) => a.priority - b.priority);

  const final = deduped.slice(0, maxTotal);

  return {
    queries: final,
    diagnostics: {
      evidenceKeywordQueries: evidenceKwQueries.length,
      reportTypeQueries: reportTypeQueries.length,
      localLanguageQueries: localLangQueries.length,
      yearVariantQueries: yearVariantQueries.length,
      aliasCrossQueries: evidenceKwQueries.filter(q => q.source === "alias-cross").length,
      qualifyingInstanceQueries: qualifyingInstanceQueries.length,
      totalGenerated: final.length,
    },
  };
}

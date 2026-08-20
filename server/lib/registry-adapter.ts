/**
 * Instruction 46 — Registry Adapters
 * ────────────────────────────────────
 * Generic, schema-driven authoritative registry retrieval. Supports registry
 * search by legal name, stable registry identifier, and approved aliases.
 *
 * Records: registry name, query variant, result URL, entity-match evidence,
 * and retrieval status.
 *
 * Australian-style modern-slavery registries are supported through
 * configuration (framework.authoritativeRegistries) rather than
 * jurisdiction-specific branches.
 *
 * Design:
 *  - No hardcoded registry URLs, domains, or jurisdictions in logic.
 *  - Registry list comes from framework.authoritativeRegistries (data).
 *  - Search strategy is generic: site:<domain> "<term>" for each term.
 *  - Entity verification uses the issuer profile's alias set.
 */

import type { IssuerProfile } from "./issuer-profile.js";
import { scoreEntityMatch } from "./issuer-profile.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RegistrySearchResult {
  registryDomain: string;
  queryVariant: string;
  resultUrl: string;
  resultTitle: string;
  entityMatchScore: number;
  entityMatchSignals: string[];
  status: "matched" | "ambiguous" | "no-match" | "error";
}

export interface RegistrySearchSummary {
  registriesSearched: string[];
  totalQueries: number;
  totalResults: number;
  matchedResults: number;
  ambiguousResults: number;
  noMatchResults: number;
  errorCount: number;
  results: RegistrySearchResult[];
}

// ─── Registry Search ────────────────────────────────────────────────────────

/**
 * Build search terms for registry lookup from the issuer profile.
 * Uses: legal name, FIGI name, ISIN, high-confidence aliases.
 * Deterministic ordering.
 */
export function buildRegistrySearchTerms(profile: IssuerProfile): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const add = (t: string) => {
    const norm = t.trim();
    if (norm.length < 2 || seen.has(norm.toLowerCase())) return;
    seen.add(norm.toLowerCase());
    terms.push(norm);
  };

  // Priority order: legal name > FIGI name > ISIN > high-confidence aliases
  add(profile.legalName);
  if (profile.figiName && profile.figiName !== profile.legalName) {
    add(profile.figiName);
  }
  if (profile.isin) add(profile.isin);

  // Add high-confidence aliases that are long enough to be distinctive
  for (const alias of profile.aliases) {
    if (alias.confidence === "high" && alias.value.length >= 4 && alias.type !== "isin") {
      add(alias.value);
    }
  }

  // Cap to avoid excessive queries
  return terms.slice(0, 6);
}

/**
 * Score a registry search result against the issuer profile to determine
 * if it actually belongs to this issuer.
 */
export function scoreRegistryResult(
  result: { url: string; title: string; snippet?: string },
  profile: IssuerProfile,
  relatedDomains: string[] = [],
): { score: number; signals: string[]; status: "matched" | "ambiguous" | "no-match" } {
  const entityScore = scoreEntityMatch(
    { url: result.url, title: result.title, snippet: result.snippet },
    profile,
    relatedDomains,
  );

  let status: "matched" | "ambiguous" | "no-match";
  if (entityScore.score >= 50) {
    status = "matched";
  } else if (entityScore.score >= 25) {
    status = "ambiguous";
  } else {
    status = "no-match";
  }

  return {
    score: entityScore.score,
    signals: entityScore.signals,
    status,
  };
}

/**
 * Process raw search results from a registry domain and score them.
 * Returns structured RegistrySearchResult entries.
 */
export function processRegistryResults(
  registryDomain: string,
  queryVariant: string,
  rawResults: Array<{ url: string; title: string; snippet?: string }>,
  profile: IssuerProfile,
  relatedDomains: string[] = [],
): RegistrySearchResult[] {
  const results: RegistrySearchResult[] = [];

  for (const raw of rawResults) {
    const { score, signals, status } = scoreRegistryResult(raw, profile, relatedDomains);
    results.push({
      registryDomain,
      queryVariant,
      resultUrl: raw.url,
      resultTitle: raw.title,
      entityMatchScore: score,
      entityMatchSignals: signals,
      status,
    });
  }

  return results;
}

/**
 * Create an empty registry search summary (for when no registries are configured).
 */
export function emptyRegistrySummary(): RegistrySearchSummary {
  return {
    registriesSearched: [],
    totalQueries: 0,
    totalResults: 0,
    matchedResults: 0,
    ambiguousResults: 0,
    noMatchResults: 0,
    errorCount: 0,
    results: [],
  };
}

/**
 * Aggregate individual registry results into a summary.
 */
export function aggregateRegistryResults(
  registriesSearched: string[],
  totalQueries: number,
  results: RegistrySearchResult[],
): RegistrySearchSummary {
  return {
    registriesSearched,
    totalQueries,
    totalResults: results.length,
    matchedResults: results.filter(r => r.status === "matched").length,
    ambiguousResults: results.filter(r => r.status === "ambiguous").length,
    noMatchResults: results.filter(r => r.status === "no-match").length,
    errorCount: results.filter(r => r.status === "error").length,
    results,
  };
}

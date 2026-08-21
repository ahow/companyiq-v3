/**
 * Instruction 46 Follow-Up — Disclosure-Platform Crosswalks
 * ──────────────────────────────────────────────────────────
 * Generic source crosswalks for regulator/exchange/official registries
 * and issuer disclosure platforms.
 *
 * Records:
 *  - Which identity variants, domains, registries, and framework terms were searched
 *  - Result counts per source
 *  - Entity-verification outcomes
 *  - Authority scores and temporal eligibility
 *  - Reason-coded zero/low-evidence outcomes
 *
 * Does NOT turn CCB/HDFC legitimate thin-disclosure cases into retrieval failures.
 *
 * Design:
 *  - No hardcoded company names, topics, jurisdictions, or domains
 *  - All registry/platform configuration from framework.authoritativeRegistries
 *  - Generic search strategy: site:<domain> "<term>" for each term
 *  - Entity verification uses the issuer profile's alias set
 */

import type { IssuerProfile } from "./issuer-profile.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PlatformSearchRecord {
  platform: string;
  searchTermsUsed: string[];
  resultCount: number;
  matchedCount: number;
  ambiguousCount: number;
  noMatchCount: number;
  /** Authority score for this platform (from framework config) */
  authorityScore: number;
  /** Whether results are temporally eligible (within evidence window) */
  temporallyEligible: boolean;
}

export interface DisclosurePlatformSummary {
  platformsSearched: PlatformSearchRecord[];
  totalPlatforms: number;
  totalResults: number;
  totalMatched: number;
  /** Reason code for zero/low evidence from platform search */
  zeroEvidenceReason: ZeroPlatformEvidenceReason | null;
  generatedAt: string;
}

export type ZeroPlatformEvidenceReason =
  | "no-registries-configured"
  | "all-registries-empty"
  | "entity-mismatch-all"
  | "temporal-ineligible"
  | "legitimate-thin-disclosure"
  | null;

// ─── Platform Search Term Generation ────────────────────────────────────────

/**
 * Generate search terms for disclosure-platform lookup from issuer profile.
 * Includes: legal name, FIGI name, ISIN, local-language names, high-confidence aliases.
 * Deterministic ordering.
 */
export function buildPlatformSearchTerms(profile: IssuerProfile): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const add = (t: string) => {
    const norm = t.trim();
    if (norm.length < 2 || seen.has(norm.toLowerCase())) return;
    seen.add(norm.toLowerCase());
    terms.push(norm);
  };

  // Priority order: legal name > FIGI name > local-language names > ISIN > aliases
  add(profile.legalName);
  if (profile.figiName && profile.figiName !== profile.legalName) {
    add(profile.figiName);
  }
  for (const localName of profile.localLanguageNames) {
    add(localName);
  }
  if (profile.isin) add(profile.isin);

  // High-confidence aliases that are distinctive enough
  for (const alias of profile.aliases) {
    if (alias.confidence === "high" && alias.value.length >= 4 && alias.type !== "isin") {
      add(alias.value);
    }
  }

  // Cap to avoid excessive queries
  return terms.slice(0, 8);
}

// ─── Evidence Reason Classification ─────────────────────────────────────────

/**
 * Classify why platform search produced zero/low evidence.
 * Framework-agnostic — works for any topic.
 *
 * IMPORTANT: Does NOT classify legitimate thin-disclosure issuers (e.g. CCB, HDFC)
 * as retrieval failures. A zero result from a properly-configured registry search
 * with valid entity resolution is classified as "legitimate-thin-disclosure".
 */
export function classifyPlatformZeroEvidence(opts: {
  registriesConfigured: number;
  totalResults: number;
  matchedResults: number;
  entityMismatchRate: number;
  temporallyEligibleCount: number;
  profileHasVerifiedDomain: boolean;
  profileAliasCount: number;
}): ZeroPlatformEvidenceReason {
  // No registries configured for this framework
  if (opts.registriesConfigured === 0) return "no-registries-configured";

  // Registries searched but returned nothing
  if (opts.totalResults === 0) {
    // If the profile is well-resolved (has verified domain and aliases),
    // this is likely a legitimate thin-disclosure case
    if (opts.profileHasVerifiedDomain && opts.profileAliasCount >= 3) {
      return "legitimate-thin-disclosure";
    }
    return "all-registries-empty";
  }

  // Results found but all failed entity verification
  if (opts.matchedResults === 0 && opts.entityMismatchRate > 0.8) {
    return "entity-mismatch-all";
  }

  // Results found and matched but all are temporally ineligible
  if (opts.matchedResults > 0 && opts.temporallyEligibleCount === 0) {
    return "temporal-ineligible";
  }

  // Results found, matched, and eligible — but still zero evidence in scoring
  // This is the legitimate thin-disclosure case
  return "legitimate-thin-disclosure";
}

// ─── Summary Builder ────────────────────────────────────────────────────────

/**
 * Build a disclosure-platform search summary from individual platform records.
 */
export function buildPlatformSummary(
  records: PlatformSearchRecord[],
): DisclosurePlatformSummary {
  const totalResults = records.reduce((sum, r) => sum + r.resultCount, 0);
  const totalMatched = records.reduce((sum, r) => sum + r.matchedCount, 0);

  let zeroEvidenceReason: ZeroPlatformEvidenceReason = null;
  if (records.length === 0) {
    zeroEvidenceReason = "no-registries-configured";
  } else if (totalResults === 0) {
    zeroEvidenceReason = "all-registries-empty";
  } else if (totalMatched === 0) {
    zeroEvidenceReason = "entity-mismatch-all";
  }

  return {
    platformsSearched: records,
    totalPlatforms: records.length,
    totalResults,
    totalMatched,
    zeroEvidenceReason,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Empty summary for when no platform search is performed.
 */
export function emptyPlatformSummary(): DisclosurePlatformSummary {
  return {
    platformsSearched: [],
    totalPlatforms: 0,
    totalResults: 0,
    totalMatched: 0,
    zeroEvidenceReason: null,
    generatedAt: new Date().toISOString(),
  };
}

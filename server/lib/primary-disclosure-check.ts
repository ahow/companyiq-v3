/**
 * Primary-disclosure verification (PR 1 · Change 1a)
 *
 * On the iteration-8 10-cell audit, 4 of 5 misretrieval errors were caused
 * by the corpus citing stale or subsidiary documents when the correct
 * primary regulatory disclosure existed and was findable (Unilever plc →
 * Hindustan Unilever, Kering → 2020 EP&L, Nestlé → 2021 web page instead
 * of 2025 Non-Financial Statement).
 *
 * This module answers a single question against the already-discovered
 * corpus for a company: "Does it contain the LATEST primary regulatory
 * disclosure this issuer is required to publish?" If not, we surface a
 * ready-to-fire search query for each missing requirement so the caller
 * (pipeline.ts) can re-search and merge the results back into the corpus.
 *
 * The logic is intentionally jurisdiction-routed (US / EU+UK / APAC /
 * default) rather than framework-routed: primary regulatory disclosures
 * are a function of where the issuer is listed, not of what topic we are
 * scoring against.
 */

import { detectFilingYear, classifyDocumentTier, type DiscoveryCandidate } from "./discovery.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PrimaryDisclosureRequirement {
  /** Stable identifier, e.g. "us-10k-current". */
  id: string;
  /** Human-readable label for logs / diagnostics. */
  label: string;
  /** ANY match against title OR url satisfies the title-match test. */
  titleRegex: RegExp[];
  /** Documents with detected year < minYear do NOT satisfy the requirement. */
  minYear: number;
  /**
   * If set, the document must classify at least this tier (i.e. the tier
   * number returned by classifyDocumentTier must be ≤ tierRequired).
   * Tier 1 = mandatory filings, 2 = priority disclosures, 3 = supplementary.
   */
  tierRequired?: 1 | 2 | 3;
}

export interface PrimaryDisclosureCheckResult {
  present: PrimaryDisclosureRequirement[];
  missing: PrimaryDisclosureRequirement[];
  /** One targeted query per missing requirement, in the same order. */
  targetedQueries: string[];
}

// ─── Jurisdiction routing ───────────────────────────────────────────────────

const EU_UK_COUNTRIES = new Set([
  "GB", "IE", "FR", "DE", "NL", "BE", "ES", "IT",
  "SE", "DK", "NO", "FI", "AT", "PT", "LU", "PL", "CZ",
]);

const APAC_COUNTRIES = new Set([
  "JP", "AU", "SG", "HK", "KR", "IN", "CN", "TW", "NZ",
]);

const US_EXCHANGE_RX = /\b(NYSE|NASDAQ|AMEX)\b/i;
const EU_UK_EXCHANGE_RX = /\b(LSE|Euronext|XETRA|SIX)\b/i;

/**
 * Determine the primary-disclosure requirements for a company based on
 * jurisdiction (country + exchange). Returns an ordered list where the
 * FIRST requirement is the highest priority.
 *
 * Cascade order (first match wins):
 *   1. US    — country === "US" OR exchange contains NYSE/NASDAQ/AMEX
 *   2. EU+UK — country ∈ EU_UK_COUNTRIES OR exchange contains LSE/Euronext/XETRA/SIX
 *   3. APAC  — country ∈ APAC_COUNTRIES
 *   4. default (anywhere else)
 */
export function getRequirementsForJurisdiction(
  country: string | null,
  exchange: string | null,
  currentYear: number,
): PrimaryDisclosureRequirement[] {
  const countryUpper = country ? country.trim().toUpperCase() : null;
  const exchangeStr = exchange ?? "";

  const isUS =
    countryUpper === "US" ||
    US_EXCHANGE_RX.test(exchangeStr);

  const isEuUk =
    (countryUpper !== null && EU_UK_COUNTRIES.has(countryUpper)) ||
    EU_UK_EXCHANGE_RX.test(exchangeStr);

  const isApac =
    countryUpper !== null && APAC_COUNTRIES.has(countryUpper);

  if (isUS) {
    return [
      {
        id: "us-10k-current",
        label: "Latest 10-K or 20-F (US-listed)",
        titleRegex: [/10-?k\b/i, /\b20-?f\b/i, /annual report on form 10-?k/i],
        minYear: currentYear - 1,
        tierRequired: 1,
      },
      {
        id: "us-sustainability-current",
        label: "Latest sustainability / ESG report (US-listed)",
        titleRegex: [/sustainability report/i, /esg report/i, /impact report/i],
        minYear: currentYear - 1,
        tierRequired: 2,
      },
    ];
  }

  if (isEuUk) {
    return [
      {
        id: "eu-csrd-current",
        label: "CSRD / ESRS sustainability statement (EU+UK)",
        titleRegex: [/sustainability statement/i, /\bESRS\b/i, /\bCSRD\b/i, /non-?financial statement/i],
        minYear: 2024,
        tierRequired: 2,
      },
      {
        id: "eu-annual-current",
        label: "Latest annual or integrated report (EU+UK)",
        titleRegex: [/annual report/i, /integrated report/i, /universal registration document/i],
        minYear: currentYear - 1,
        tierRequired: 1,
      },
    ];
  }

  if (isApac) {
    return [
      {
        id: "apac-annual-current",
        label: "Latest annual or integrated report (APAC)",
        titleRegex: [/annual report/i, /integrated report/i],
        minYear: currentYear - 1,
        tierRequired: 1,
      },
      {
        id: "apac-sustainability-current",
        label: "Latest sustainability report (APAC)",
        titleRegex: [/sustainability report/i, /esg report/i],
        minYear: currentYear - 1,
        tierRequired: 2,
      },
    ];
  }

  // Default — no confident jurisdiction routing.
  return [
    {
      id: "default-annual-current",
      label: "Latest annual report",
      titleRegex: [/annual report/i],
      minYear: currentYear - 1,
      tierRequired: 1,
    },
    {
      id: "default-sustainability-current",
      label: "Latest sustainability report",
      titleRegex: [/sustainability report/i],
      minYear: currentYear - 1,
      tierRequired: 2,
    },
  ];
}

// ─── Corpus check ───────────────────────────────────────────────────────────

/**
 * Check whether the discovered corpus already contains each required
 * primary disclosure. A requirement is satisfied when at least one
 * document matches ALL of:
 *   - any regex in requirement.titleRegex matches title OR url
 *   - detectFilingYear(url, title) is not null AND ≥ requirement.minYear
 *   - if tierRequired is set, classifyDocumentTier(url, title) ≤ tierRequired
 *
 * Returns present/missing lists plus one Sonar-ready targeted query per
 * missing requirement, in the same order as `missing`.
 */
export function verifyLatestPrimaryDisclosure(
  documents: DiscoveryCandidate[],
  requirements: PrimaryDisclosureRequirement[],
  companyName: string,
): PrimaryDisclosureCheckResult {
  const present: PrimaryDisclosureRequirement[] = [];
  const missing: PrimaryDisclosureRequirement[] = [];

  for (const req of requirements) {
    let satisfied = false;

    for (const doc of documents) {
      const title = doc.title || "";
      const url = doc.url || "";
      const haystack = `${title} ${url}`;

      // 1) Title/URL regex match (ANY hit is enough).
      const titleMatch = req.titleRegex.some((rx) => rx.test(haystack));
      if (!titleMatch) continue;

      // 2) Year gate.
      const year = detectFilingYear(url, title);
      if (year === null || year < req.minYear) continue;

      // 3) Tier gate (if set) — lower tier number = higher authority.
      if (req.tierRequired !== undefined) {
        const tier = classifyDocumentTier(url, title);
        if (tier > req.tierRequired) continue;
      }

      satisfied = true;
      break;
    }

    if (satisfied) present.push(req);
    else missing.push(req);
  }

  const targetedQueries = missing.map((req) => buildTargetedQuery(companyName, req));

  return { present, missing, targetedQueries };
}

// ─── Targeted query composition ─────────────────────────────────────────────

/**
 * Doc-type strings appended to targeted queries, keyed by requirement id.
 * Kept in sync with the requirement ids emitted by
 * getRequirementsForJurisdiction.
 */
const DOC_TYPE_BY_REQUIREMENT_ID: Record<string, string> = {
  "us-10k-current": "10-K annual report",
  "us-sustainability-current": "sustainability report",
  "eu-csrd-current": "CSRD sustainability statement ESRS",
  "eu-annual-current": "annual report integrated report",
  "apac-annual-current": "annual report integrated report",
  "apac-sustainability-current": "sustainability report ESG report",
  "default-annual-current": "annual report",
  "default-sustainability-current": "sustainability report",
};

/**
 * Build one Sonar-ready query for a missing primary-disclosure
 * requirement. Format matches the brief:
 *
 *   "<companyName>" <docType> <minYear> filetype:pdf
 */
export function buildTargetedQuery(
  companyName: string,
  requirement: PrimaryDisclosureRequirement,
): string {
  const docType = DOC_TYPE_BY_REQUIREMENT_ID[requirement.id] ?? "annual report";
  return `"${companyName}" ${docType} ${requirement.minYear} filetype:pdf`;
}

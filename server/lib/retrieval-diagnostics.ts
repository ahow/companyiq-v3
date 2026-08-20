/**
 * Instruction 46 — Retrieval Diagnostics
 * ────────────────────────────────────────
 * For every company/framework/run, reports:
 *  - Identity variants queried
 *  - Domains and registries searched
 *  - Query counts and result counts
 *  - Entity-verification counts
 *  - Documents surviving authority/temporal filters
 *  - Timeout counts
 *  - Rejected-domain reasons
 *  - Zero/low score root-cause classification
 *
 * Designed to survive into the Gate Report without leaking company-specific
 * logic into production branches.
 */

import type { IssuerProfile, ProfileDiagnostics } from "./issuer-profile.js";
import type { RegistrySearchSummary } from "./registry-adapter.js";
import type { QueryExpansionResult } from "./query-expansion.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LowScoreReason =
  | "legitimate-thin-disclosure"
  | "no-verified-source"
  | "timeout"
  | "entity-mismatch"
  | "scoring-failure"
  | "insufficient-evidence"
  | "unknown";

export interface RetrievalDiagnostics {
  /** Issuer profile summary */
  issuerProfile: {
    legalName: string;
    figiName: string | null;
    aliasCount: number;
    queryAliasCount: number;
    verifiedDomainCount: number;
    identifiersAvailable: string[];
    resolutionPath: string[];
  };

  /** Query generation stats */
  queryExpansion: {
    evidenceKeywordQueries: number;
    reportTypeQueries: number;
    localLanguageQueries: number;
    yearVariantQueries: number;
    aliasCrossQueries: number;
    totalGenerated: number;
  } | null;

  /** Domain search stats */
  domainSearch: {
    domainsSearched: string[];
    domainQueryCount: number;
    domainResultCount: number;
    rejectedDomains: Array<{ domain: string; reason: string }>;
  };

  /** Registry search stats */
  registrySearch: {
    registriesSearched: string[];
    totalQueries: number;
    totalResults: number;
    matchedResults: number;
    ambiguousResults: number;
    noMatchResults: number;
  };

  /** Entity verification stats */
  entityVerification: {
    totalDocumentsVerified: number;
    matchCount: number;
    differentCompanyCount: number;
    genericCount: number;
    errorCount: number;
    ambiguousAcronymCount: number;
  };

  /** Filtering pipeline stats */
  filteringPipeline: {
    totalCandidates: number;
    preGateFiltered: number;
    gateAccepted: number;
    recencyDropped: number;
    finalCorpusSize: number;
    timeoutCount: number;
  };

  /** Low/zero score root cause (populated post-scoring) */
  lowScoreClassification: LowScoreReason | null;

  /** Timestamp */
  generatedAt: string;
}

// ─── Builder ────────────────────────────────────────────────────────────────

export class RetrievalDiagnosticsBuilder {
  private data: RetrievalDiagnostics;

  constructor() {
    this.data = {
      issuerProfile: {
        legalName: "",
        figiName: null,
        aliasCount: 0,
        queryAliasCount: 0,
        verifiedDomainCount: 0,
        identifiersAvailable: [],
        resolutionPath: [],
      },
      queryExpansion: null,
      domainSearch: {
        domainsSearched: [],
        domainQueryCount: 0,
        domainResultCount: 0,
        rejectedDomains: [],
      },
      registrySearch: {
        registriesSearched: [],
        totalQueries: 0,
        totalResults: 0,
        matchedResults: 0,
        ambiguousResults: 0,
        noMatchResults: 0,
      },
      entityVerification: {
        totalDocumentsVerified: 0,
        matchCount: 0,
        differentCompanyCount: 0,
        genericCount: 0,
        errorCount: 0,
        ambiguousAcronymCount: 0,
      },
      filteringPipeline: {
        totalCandidates: 0,
        preGateFiltered: 0,
        gateAccepted: 0,
        recencyDropped: 0,
        finalCorpusSize: 0,
        timeoutCount: 0,
      },
      lowScoreClassification: null,
      generatedAt: new Date().toISOString(),
    };
  }

  setIssuerProfile(profile: IssuerProfile, diagnostics: ProfileDiagnostics): this {
    this.data.issuerProfile = {
      legalName: profile.legalName,
      figiName: profile.figiName,
      aliasCount: diagnostics.aliasCount,
      queryAliasCount: profile.queryAliases.length,
      verifiedDomainCount: diagnostics.verifiedDomainCount,
      identifiersAvailable: diagnostics.identifiersAvailable,
      resolutionPath: diagnostics.resolutionPath,
    };
    return this;
  }

  setQueryExpansion(result: QueryExpansionResult): this {
    this.data.queryExpansion = result.diagnostics;
    return this;
  }

  setDomainSearch(opts: {
    domainsSearched: string[];
    domainQueryCount: number;
    domainResultCount: number;
    rejectedDomains?: Array<{ domain: string; reason: string }>;
  }): this {
    this.data.domainSearch = {
      domainsSearched: opts.domainsSearched,
      domainQueryCount: opts.domainQueryCount,
      domainResultCount: opts.domainResultCount,
      rejectedDomains: opts.rejectedDomains || [],
    };
    return this;
  }

  setRegistrySearch(summary: RegistrySearchSummary): this {
    this.data.registrySearch = {
      registriesSearched: summary.registriesSearched,
      totalQueries: summary.totalQueries,
      totalResults: summary.totalResults,
      matchedResults: summary.matchedResults,
      ambiguousResults: summary.ambiguousResults,
      noMatchResults: summary.noMatchResults,
    };
    return this;
  }

  addEntityVerification(verdict: "match" | "different_company" | "generic" | "error", isAmbiguousAcronym: boolean = false): this {
    this.data.entityVerification.totalDocumentsVerified++;
    switch (verdict) {
      case "match": this.data.entityVerification.matchCount++; break;
      case "different_company": this.data.entityVerification.differentCompanyCount++; break;
      case "generic": this.data.entityVerification.genericCount++; break;
      case "error": this.data.entityVerification.errorCount++; break;
    }
    if (isAmbiguousAcronym) {
      this.data.entityVerification.ambiguousAcronymCount++;
    }
    return this;
  }

  setFilteringPipeline(opts: {
    totalCandidates: number;
    preGateFiltered: number;
    gateAccepted: number;
    recencyDropped: number;
    finalCorpusSize: number;
    timeoutCount?: number;
  }): this {
    this.data.filteringPipeline = {
      totalCandidates: opts.totalCandidates,
      preGateFiltered: opts.preGateFiltered,
      gateAccepted: opts.gateAccepted,
      recencyDropped: opts.recencyDropped,
      finalCorpusSize: opts.finalCorpusSize,
      timeoutCount: opts.timeoutCount || 0,
    };
    return this;
  }

  setLowScoreClassification(reason: LowScoreReason): this {
    this.data.lowScoreClassification = reason;
    return this;
  }

  build(): RetrievalDiagnostics {
    this.data.generatedAt = new Date().toISOString();
    return { ...this.data };
  }
}

// ─── Root-Cause Classification ──────────────────────────────────────────────

/**
 * Classify why a company received a zero or low score.
 * Uses the retrieval diagnostics to determine the root cause.
 * Framework-agnostic — works for any topic.
 */
export function classifyLowScoreReason(
  diagnostics: RetrievalDiagnostics,
  totalScore: number | null,
  measuresMetCount: number | null,
): LowScoreReason {
  // If there was a timeout, that's the primary cause
  if (diagnostics.filteringPipeline.timeoutCount > 0) {
    return "timeout";
  }

  // If entity verification rejected most documents
  const verif = diagnostics.entityVerification;
  if (verif.totalDocumentsVerified > 0) {
    const mismatchRate = verif.differentCompanyCount / verif.totalDocumentsVerified;
    if (mismatchRate > 0.5) {
      return "entity-mismatch";
    }
  }

  // If no verified sources were found
  if (diagnostics.domainSearch.domainsSearched.length === 0 &&
      diagnostics.issuerProfile.verifiedDomainCount === 0) {
    return "no-verified-source";
  }

  // If the corpus is very small after filtering
  if (diagnostics.filteringPipeline.finalCorpusSize <= 3) {
    // Check if it's because there's genuinely thin disclosure
    if (diagnostics.filteringPipeline.totalCandidates > 20 &&
        diagnostics.filteringPipeline.gateAccepted < 5) {
      return "entity-mismatch";
    }
    if (diagnostics.filteringPipeline.totalCandidates < 10) {
      return "legitimate-thin-disclosure";
    }
  }

  // If scoring produced results but they're all zero
  if (totalScore !== null && totalScore === 0 && measuresMetCount === 0) {
    if (diagnostics.filteringPipeline.finalCorpusSize > 10) {
      return "insufficient-evidence";
    }
    return "legitimate-thin-disclosure";
  }

  return "unknown";
}

// ─── Merge with Existing Discovery Diagnostics ──────────────────────────────

/**
 * Merge retrieval diagnostics into the existing discoveryDiagnostics JSONB
 * field on the company row. Additive — never removes existing fields.
 */
export function mergeRetrievalDiagnostics(
  existing: Record<string, any> | null,
  retrieval: RetrievalDiagnostics,
): Record<string, any> {
  const base = existing || {};
  return {
    ...base,
    retrievalDiagnostics: retrieval,
  };
}

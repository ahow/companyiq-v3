/**
 * Evidence funnel (display-only, additive) — §3 of the 3M corpus investigation.
 *
 * Builds the per-stage counts (Discovered → Fetched → Dead → Gate-accepted →
 * First-party / Third-party → Scored evidence) plus the provenance-health signal
 * that flags issuer-domain documents sitting in the third-party bucket (the 3M
 * signature). Pure computation: no I/O, no scoring effect. The funnel augments
 * the existing "Documents: N" tile; it never changes any verdict or score.
 *
 * Stage definitions (match the §3 contract):
 *   - discovered:  surfaced by discovery (documentsDiscovered from fetchCoverage,
 *                  falling back to the stored document row count).
 *   - fetched:     downloaded + extracted (documentsFetched from fetchCoverage,
 *                  falling back to rows with fetch_status='ok').
 *   - dead:        TRUE dead links only (documentsDead from fetchCoverage; a row
 *                  carrying an informational budget_exceeded note while
 *                  extraction_state='complete' and fetch_status='ok' is NOT dead).
 *   - gateAccepted: rows with gate_verdict <> 'reject'.
 *   - firstParty:  gate-accepted rows with source_type='first_party' (scoring-eligible).
 *   - thirdParty:  gate-accepted rows with source_type='third_party'.
 *   - scoredEvidence: source_type='first_party' AND gate_verdict<>'reject' — what
 *                  the score is actually based on (== firstParty here).
 */

import { deriveFmpAnchors, registrableDomain } from "./fmp-resolver.js";

export interface FunnelDocument {
  id?: number;
  url: string | null;
  type?: string | null;
  gateVerdict?: string | null;
  fetchStatus?: string | null;
  failureReason?: string | null;
  sourceType?: string | null;
  extractionState?: string | null;
}

export interface FunnelCompany {
  name?: string | null;
  domain?: string | null;
  ticker?: string | null;
  relatedDomains?: string[] | null;
  fmpWebsite?: string | null;
  fmpSymbol?: string | null;
}

export interface FetchCoverageLike {
  documentsDiscovered?: number | null;
  documentsFetched?: number | null;
  documentsDead?: number | null;
  fetchRatio?: number | null;
  budgetExceeded?: boolean | null;
  deadPrimaryFiling?: boolean | null;
  corpusChars?: number | null;
}

export interface ProvenanceHealth {
  /** Issuer registrable domain used for same-domain detection (may be null). */
  issuerDomain: string | null;
  /** Count of third-party documents whose host is on the issuer's own domain. */
  sameDomainThirdPartyCount: number;
  /** Distinct issuer-domain hosts found in the third-party bucket (for the tooltip). */
  sameDomainThirdPartyHosts: string[];
  /** True when first-party is low AND same-domain third-party rows exist. */
  warning: boolean;
}

export interface EvidenceFunnel {
  discovered: number;
  fetched: number;
  dead: number;
  gateAccepted: number;
  firstParty: number;
  thirdParty: number;
  scoredEvidence: number;
  /** Fetched-ok rows carrying an informational budget_exceeded note (NOT dead). */
  budgetNoted: number;
  provenanceHealth: ProvenanceHealth;
}

/** Low-first-party threshold for the provenance-health warning (display-only). */
export const FUNNEL_LOW_FIRST_PARTY = 2;

function host(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function isRejected(d: FunnelDocument): boolean {
  return (d.gateVerdict || "").toLowerCase() === "reject";
}

function isBudgetNoted(d: FunnelDocument): boolean {
  // Informational budget note: fetched ok + extraction complete, NOT a dead link.
  const note = (d.failureReason || "").toLowerCase();
  return (
    note.includes("budget_exceeded") &&
    (d.fetchStatus || "").toLowerCase() === "ok" &&
    (d.extractionState || "").toLowerCase() === "complete"
  );
}

/**
 * Derive the issuer registrable domain from the native domain, else the FMP
 * website (reusing deriveFmpAnchors / registrableDomain rather than duplicating
 * logic). Mirrors the anchor resolution the provenance classifier now relies on.
 */
export function resolveIssuerDomain(company: FunnelCompany): string | null {
  const native = registrableDomain(company.domain || null);
  if (native) return native;
  const anchors = deriveFmpAnchors({
    nativeDomain: company.domain ?? null,
    nativeTicker: company.ticker ?? null,
    relatedDomains: company.relatedDomains ?? null,
    fmpWebsite: company.fmpWebsite ?? null,
    fmpSymbol: company.fmpSymbol ?? null,
  });
  return anchors.domain ? registrableDomain(anchors.domain) : null;
}

export function buildEvidenceFunnel(
  documents: FunnelDocument[],
  company: FunnelCompany,
  fetchCoverage?: FetchCoverageLike | null
): EvidenceFunnel {
  const docs = Array.isArray(documents) ? documents : [];

  const gateAcceptedDocs = docs.filter((d) => !isRejected(d));
  const firstPartyDocs = gateAcceptedDocs.filter(
    (d) => (d.sourceType || "").toLowerCase() === "first_party"
  );
  const thirdPartyDocs = gateAcceptedDocs.filter(
    (d) => (d.sourceType || "").toLowerCase() === "third_party"
  );

  const firstParty = firstPartyDocs.length;
  const thirdParty = thirdPartyDocs.length;
  const gateAccepted = gateAcceptedDocs.length;
  // Scored evidence == first-party AND gate-accepted (the scoring-eligible set).
  const scoredEvidence = firstParty;

  const rowFetched = docs.filter((d) => (d.fetchStatus || "").toLowerCase() === "ok").length;
  const budgetNoted = docs.filter(isBudgetNoted).length;

  // Prefer the authoritative fetchCoverage snapshot; fall back to row counts.
  const discovered =
    typeof fetchCoverage?.documentsDiscovered === "number"
      ? fetchCoverage.documentsDiscovered
      : docs.length;
  const fetched =
    typeof fetchCoverage?.documentsFetched === "number"
      ? fetchCoverage.documentsFetched
      : rowFetched;
  // dead = TRUE dead links only; budget-noted rows are explicitly excluded.
  const dead =
    typeof fetchCoverage?.documentsDead === "number" ? fetchCoverage.documentsDead : 0;

  // Provenance health: issuer-domain docs sitting in the third-party bucket.
  const issuerDomain = resolveIssuerDomain(company);
  const sameHostsSet = new Set<string>();
  if (issuerDomain) {
    for (const d of thirdPartyDocs) {
      const h = host(d.url);
      if (h && registrableDomain(h) === issuerDomain) sameHostsSet.add(h);
    }
  }
  const sameDomainThirdPartyCount = issuerDomain
    ? thirdPartyDocs.filter((d) => {
        const h = host(d.url);
        return h != null && registrableDomain(h) === issuerDomain;
      }).length
    : 0;

  // Rule 3: warn when issuer-domain docs are stuck in the third-party bucket AND
  // first-party is "low" — either in absolute terms (<= floor) OR relative to the
  // misclassified same-domain docs (at least as many issuer-domain docs sit in
  // third-party as are correctly classified first-party). The relative test keeps
  // the 3M signature detectable even after a partial anchor-fix lifts some docs to
  // first-party, while the absolute floor avoids firing on healthy companies where
  // same-domain third-party rows are effectively absent.
  const firstPartyLow =
    firstParty <= FUNNEL_LOW_FIRST_PARTY || sameDomainThirdPartyCount >= firstParty;

  const provenanceHealth: ProvenanceHealth = {
    issuerDomain,
    sameDomainThirdPartyCount,
    sameDomainThirdPartyHosts: Array.from(sameHostsSet).sort(),
    warning: sameDomainThirdPartyCount > 0 && firstPartyLow,
  };

  return {
    discovered,
    fetched,
    dead,
    gateAccepted,
    firstParty,
    thirdParty,
    scoredEvidence,
    budgetNoted,
    provenanceHealth,
  };
}

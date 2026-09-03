/**
 * U17 Fix B — Scoring-time provenance gate.
 *
 * U17 Fix A filters third-party documents at CORPUS-BUILD time so the
 * evidence pack the LLM sees is already provenance-clean. Fix B is the
 * SAFETY NET at scoring time: after the LLM has produced a Yes / Partial
 * verdict, we re-classify each of its cited quotes and downgrade the
 * verdict to No when every supporting quote is third-party (i.e. the
 * corpus-build filter missed something, or a stray third-party doc slipped
 * through because it lives on a regulator/CDN pattern we don't yet handle).
 *
 * Behaviour rules:
 *  - Applies only to Yes and Partial verdicts. No / Insufficient evidence
 *    are returned unchanged.
 *  - Skips entirely when `company.isUnlisted === true` (private/unlisted
 *    issuers by design have no ISIN and often lean on third-party
 *    coverage; the gate would over-fire).
 *  - Requires at least one quote to be first-party OR regulator-filed-by-
 *    issuer to keep a Yes. If ALL quotes are third-party, downgrade.
 *  - Quotes without a resolvable sourceUrl are treated as third-party for
 *    the purposes of the gate — an unresolvable citation is not evidence.
 *  - Downgrade records the original verdict, the reason class, and the
 *    per-quote provenance decisions in `verdictNuance` for audit.
 *
 * Interaction with U9 Layer 1 (verbatim re-fetch): they share the "resolve
 * quote to a sourceUrl, then act on it" backbone but the actions differ.
 * Fix B here treats provenance as an attribute of the URL; Layer 1 will
 * additionally verify the quote text is actually present at that URL.
 * Both gates run on the same MeasureResult in sequence — Fix B first
 * (cheaper, no I/O), then Layer 1 (needs a network fetch).
 */

import type { MeasureResult } from "./analyzer.js";
import { classifyProvenance, type ProvenanceClass } from "./provenance.js";

// Flag toggle. Default off per the roadmap decision — iter-13 showed Fix A
// (corpus-build filter) is doing most of the work; Fix B is a safety net
// worth having available but not the default until measured.
export function isScoringTimeGateEnabled(): boolean {
  return (process.env.U17_SCORING_TIME_GATE || "").toLowerCase() === "true";
}

/** Provenance decision for a single quote. */
export interface QuoteProvenanceDecision {
  quoteText: string;      // truncated for audit clarity; not used for logic
  sourceUrl: string | null;
  provenance: ProvenanceClass;
  reason: string;
  regulatorHost: string | null;
}

/** Return value carrying the maybe-modified result plus an audit trace. */
export interface ProvenanceGateOutcome {
  result: MeasureResult;
  action: "unchanged" | "skipped_no_company" | "skipped_unlisted"
        | "skipped_wrong_verdict" | "downgraded" | "preserved_first_party"
        | "preserved_regulator";
  decisions: QuoteProvenanceDecision[];
}

/**
 * Apply the U17 Fix B scoring-time provenance gate to a single measure
 * result. Never throws; on error, returns `{ result: input, action: "unchanged" }`.
 */
export function applyProvenanceGate(
  result: MeasureResult,
  company: { domain?: string | null; relatedDomains?: string[] | null; isUnlisted?: boolean } | null | undefined,
): ProvenanceGateOutcome {
  // Skip when no company context (should never happen in the pipeline but
  // callers may exist without threading it — fail-open, do not downgrade).
  if (!company) {
    return { result, action: "skipped_no_company", decisions: [] };
  }
  // Skip explicitly-unlisted companies: their disclosure profile legitimately
  // depends more heavily on third-party coverage (analyst notes, press,
  // filings-by-parent), so gating them would over-fire.
  if (company.isUnlisted === true) {
    return { result, action: "skipped_unlisted", decisions: [] };
  }
  // Only Yes / Partial verdicts are candidates. No and Insufficient evidence
  // pass through unchanged.
  if (result.verdict !== "Yes" && result.verdict !== "Partial") {
    return { result, action: "skipped_wrong_verdict", decisions: [] };
  }
  // No quotes → nothing to gate. Leave as-is; other gates (evidence-absent,
  // ML filter etc.) are responsible for that class.
  if (!Array.isArray(result.quotes) || result.quotes.length === 0) {
    return { result, action: "unchanged", decisions: [] };
  }

  // Classify every quote's URL.
  const decisions: QuoteProvenanceDecision[] = result.quotes.map(q => {
    const url = q.sourceUrl || "";
    if (!url) {
      return {
        quoteText: q.text.slice(0, 80),
        sourceUrl: null,
        provenance: "third_party" as ProvenanceClass,
        reason: "no sourceUrl on quote",
        regulatorHost: null,
      };
    }
    const prov = classifyProvenance({
      url,
      title: q.source || null,
      content: null,
      companyDomain: company.domain ?? null,
      relatedDomains: company.relatedDomains ?? null,
      companyName: null,
      companyTicker: null,
      companyAliases: null,
    });
    return {
      quoteText: q.text.slice(0, 80),
      sourceUrl: url,
      provenance: prov.provenance,
      reason: prov.reason,
      regulatorHost: prov.regulatorHost,
    };
  });

  // Count first-party (issuer) support. Regulator-filed-by-issuer counts as
  // first-party in classifyProvenance already — it returns "issuer" for that
  // class — so a single check on `provenance === "issuer"` suffices.
  const issuerCount = decisions.filter(d => d.provenance === "issuer").length;
  const thirdPartyCount = decisions.length - issuerCount;

  // A Yes/Partial with at least one issuer-provenance quote is preserved.
  if (issuerCount > 0) {
    // Distinguish regulator-preserved from direct-domain-preserved for the
    // audit action label; both keep the verdict.
    const anyRegulator = decisions.some(d => d.provenance === "issuer" && d.regulatorHost);
    return {
      result,
      action: anyRegulator ? "preserved_regulator" : "preserved_first_party",
      decisions,
    };
  }

  // All third-party → downgrade to No.
  const originalVerdict = result.verdict;
  const trace = decisions
    .map((d, i) => `q${i + 1}: ${d.provenance} (${d.sourceUrl ?? "no-url"})`)
    .join(" | ");
  const nuance = [
    result.verdictNuance || "",
    `[U17 Fix B] Original ${originalVerdict} downgraded to No: all ${thirdPartyCount} supporting quotes are third-party (no issuer-provenance corroboration). Provenance trace: ${trace}`,
  ].filter(Boolean).join(" ");

  return {
    result: {
      ...result,
      verdict: "No",
      score: 0,
      // Preserve original confidence for the downgrade audit; the LLM's
      // original confidence in a Yes is still useful signal even after we
      // reject its provenance basis.
      verdictNuance: nuance,
    },
    action: "downgraded",
    decisions,
  };
}

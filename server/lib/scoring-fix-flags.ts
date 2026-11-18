// Central env-tunable flags for the 2026-11-17 scoring-integrity remediation
// (SCORING_FIXES_PLAN_20261117.md, RC1–RC7). Each flag has a default-sensible
// value; all are read here so the behaviour is discoverable in one place and so
// shared/ modules never need to read process.env directly.
//
// Convention (matches the rest of the codebase):
//   default-ON  flag → (process.env.X || "true").toLowerCase() !== "false"
//   default-OFF flag → (process.env.X || "").toLowerCase() is one of 1/true/on/yes

function envOnDefaultTrue(name: string): boolean {
  return (process.env[name] || "true").toLowerCase() !== "false";
}

function envOnDefaultFalse(name: string): boolean {
  const v = (process.env[name] || "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

function envFloat(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return dflt;
  const n = Number(raw);
  return Number.isFinite(n) ? n : dflt;
}

// ── RC1 — checklist embedding content check ──────────────────────────────────
/** When on (default), an embeddable thematic disclosure is only marked `embedded`
 *  when the umbrella report's BODY contains the required type's own terms. */
export function rc1EmbeddingContentCheckEnabled(): boolean {
  return envOnDefaultTrue("CHECKLIST_EMBEDDING_CONTENT_CHECK");
}
/** Per-document character cap when fetching umbrella content for the check. */
export function rc1ChecklistContentFetchChars(): number {
  return envInt("CHECKLIST_CONTENT_FETCH_CHARS", 500_000);
}

// ── RC6 — corpus readiness retry + low-value-page filter ─────────────────────
export function rc6CorpusReadinessRetryEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_READINESS_RETRY");
}
/** Max targeted retrieval attempts for missing essential primaries. */
export function rc6CorpusReadinessRetryBudget(): number {
  return envInt("CORPUS_READINESS_RETRY_BUDGET", 6);
}
/** When on (default), non-substantive pages (terms-of-use, cookie/privacy, login
 *  walls, 404/empty) are excluded from backing a verdict via a generic
 *  page-nature filter. */
export function rc6LowValuePageFilterEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_LOW_VALUE_PAGE_FILTER");
}

// ── RC4 — attribution keyed off document class (filing provenance) ───────────
/** When on (default), a verified primary/statutory filing on the issuer's own
 *  domain (or a trusted filing repository whose title names the issuer) is
 *  attributed first-party by provenance alone — no in-span pronoun required. */
export function rc4FilingProvenanceEnabled(): boolean {
  return envOnDefaultTrue("ATTRIBUTION_FILING_PROVENANCE");
}

// ── RC5 — subsidiary/affiliate disambiguation (attribution precision) ────────
/** When on (default), a passage that names a more-specific reporting entity than
 *  the target (target core name + adjacent geographic/subsidiary qualifier) and
 *  does not establish the target itself as the actor is NOT attributed. */
export function rc5SubsidiaryDisambiguationEnabled(): boolean {
  return envOnDefaultTrue("ATTRIBUTION_SUBSIDIARY_DISAMBIGUATION");
}

// ── RC3 — one quote → one measure reconciliation ─────────────────────────────
export function rc3OneQuotePerMeasureEnabled(): boolean {
  return envOnDefaultTrue("SCORING_ONE_QUOTE_PER_MEASURE");
}

// ── RC2 — coverage suspect from per-measure sourcing ─────────────────────────
/** Minimum share of measures that must have ≥1 eligible source before coverage
 *  is left at its document-tier level; below this it is downgraded to suspect. */
export function rc2CoverageSuspectMinSourcedRatio(): number {
  return envFloat("COVERAGE_SUSPECT_MIN_SOURCED_RATIO", 0.8);
}

// ── RC7 — corpus reuse across runs + cross-run majority ──────────────────────
/** Default ON: a re-run of an already-researched company reuses its frozen
 *  accepted-document set instead of re-searching (unless a refresh is forced). */
export function rc7CorpusReuseAcrossRunsEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_REUSE_ACROSS_RUNS");
}
/** Default OFF: run the assessment 3× and score Yes only at ≥2/3 agreement. */
export function rc7CrossRunMajorityEnabled(): boolean {
  return envOnDefaultFalse("SCORING_CROSS_RUN_MAJORITY");
}

/**
 * RC7 Layer 1 — decide whether a re-run should REUSE the frozen corpus (skip
 * discovery) instead of re-searching. Pure and deterministic for unit testing.
 * Reuse when: the feature is enabled, a frozen corpus exists, the operator has NOT
 * forced a refresh (forceRefresh/recheck), and we are not already skipping
 * discovery (retry resume already set it). A genuine first analysis has no frozen
 * corpus → discovers normally.
 */
export function shouldReuseCorpusForRerun(opts: {
  reuseEnabled: boolean;
  hasFrozenCorpus: boolean;
  alreadySkippingDiscovery: boolean;
  forceRefresh?: boolean;
  recheck?: boolean;
}): boolean {
  if (opts.alreadySkippingDiscovery) return true; // retry resume already decided
  if (!opts.reuseEnabled) return false;
  if (opts.forceRefresh || opts.recheck) return false; // operator forced a refresh
  return opts.hasFrozenCorpus;
}

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
 * forced a refresh (forceRefresh/forceRediscover, or recheck when recheck is NOT
 * configured to reuse), and we are not already skipping discovery (retry resume
 * already set it). A genuine first analysis has no frozen corpus → discovers
 * normally.
 *
 * P1.3 — split `recheck` from re-discovery. The dashboard "Re-examine Failures"
 * button enqueues failed companies with `recheck:true`, which historically forced
 * a fresh discovery and therefore a DIFFERENT document set for exactly the
 * companies most likely to be compared across runs (a consistency regression).
 * When `recheckReusesCorpus` is true, a plain `recheck` re-SCORES against the
 * frozen corpus instead of re-discovering; only an EXPLICIT `forceRefresh` /
 * `forceRediscover` rebuilds the set. `recheckReusesCorpus` defaults to the
 * legacy behaviour (recheck re-discovers) so this is opt-in via
 * CORPUS_REUSE_ON_RECHECK — see p1RecheckReusesCorpusEnabled().
 */
export function shouldReuseCorpusForRerun(opts: {
  reuseEnabled: boolean;
  hasFrozenCorpus: boolean;
  alreadySkippingDiscovery: boolean;
  forceRefresh?: boolean;
  forceRediscover?: boolean;
  recheck?: boolean;
  recheckReusesCorpus?: boolean;
}): boolean {
  if (opts.alreadySkippingDiscovery) return true; // retry resume already decided
  if (!opts.reuseEnabled) return false;
  // An explicit operator refresh ALWAYS re-discovers, regardless of recheck mode.
  if (opts.forceRefresh || opts.forceRediscover) return false;
  // A plain recheck re-discovers UNLESS recheck is configured to reuse (P1.3).
  if (opts.recheck && !opts.recheckReusesCorpus) return false;
  return opts.hasFrozenCorpus;
}

// ── P1.3 — recheck re-scores against the frozen corpus (does not re-discover) ──
/** Default OFF (documented): when ON, the "Re-examine Failures" / recheck path
 *  reuses the frozen corpus and only re-scores, instead of forcing a fresh
 *  discovery. Kept OFF until the framework-scoped frozen-corpus snapshot (P1.1/
 *  P1.2) lands, because today's reuse set is the global per-company accepted set;
 *  an explicit `forceRediscover` is always honoured either way. */
export function p1RecheckReusesCorpusEnabled(): boolean {
  return envOnDefaultFalse("CORPUS_REUSE_ON_RECHECK");
}

// ── P2.1 — own-document provenance wins over subsidiary/cross-entity rejects ──
/** Default ON: in reviewQuoteAttribution, the own-domain / own-filing / own-brand
 *  provenance acceptance paths (RC4 + own-domain + own-brand) run BEFORE the RC5
 *  subsidiary-disambiguation reject, so a quote lifted from the issuer's own
 *  domain or a verified statutory filing is never knocked out by a third-person
 *  regional phrase (fixes the 8 own-doc false rejects: MAA, ING, Smiths, Gerdau). */
export function p2OwnDocBeforeSubsidiaryEnabled(): boolean {
  return envOnDefaultTrue("ATTRIBUTION_OWNDOC_BEFORE_SUBSIDIARY");
}

// ── P2.2 — narrow RC5 to the workspace entity list ───────────────────────────
/** Default ON: RC5 additionally fires when "target-core + adjacent qualifier"
 *  matches ANOTHER entity in the workspace company list (threaded as
 *  company.peerEntities), so a genuinely distinct listed reporting entity is
 *  caught even without a geographic qualifier. Additive to the existing
 *  geographic/subsidiary-noun triggers — never removes a trigger, so it cannot
 *  introduce new own-doc false rejects. */
export function p2Rc5EntityListScopedEnabled(): boolean {
  return envOnDefaultTrue("ATTRIBUTION_RC5_ENTITY_LIST_SCOPED");
}

// ── P2.3 — competitor-dominance admission (the Vodafone-in-Iberdrola fix) ────
/** Default ON: at corpus admission (cache-linked reuse + fetch), a document whose
 *  body is dominated by another LISTED workspace company (peer hits ≫ target hits,
 *  target not anchored in the opening) is HARD-rejected, so a shared-CDN PDF
 *  cannot be silently linked to the wrong issuer. Conservative: it only fires when
 *  the dominating entity is a known listed peer, not any org-shaped string. */
export function p2CompetitorDominanceAdmissionEnabled(): boolean {
  return envOnDefaultTrue("ADMISSION_COMPETITOR_DOMINANCE");
}
/** Minimum peer:target mention ratio for the competitor-dominance hard reject. */
export function p2CompetitorDominanceMinRatio(): number {
  return envFloat("ADMISSION_COMPETITOR_DOMINANCE_MIN_RATIO", 4);
}

// ── P2.4 — third-party analyst/news/ratings host attribution gate ────────────
/** Default ON: the entity-attribution review refuses to attribute a quote whose
 *  host is a known third-party analyst/news/ratings domain EVEN WHEN it mentions
 *  the target, so e.g. a Morningstar report about a subsidiary cannot support a
 *  "Yes". Keys on host nature, never on a company name. */
export function p2ThirdPartyHostAttributionGateEnabled(): boolean {
  return envOnDefaultTrue("ATTRIBUTION_THIRD_PARTY_HOST_GATE");
}

// ── R1 — checklist content-map must not fail closed for everyone ─────────────
/** Default ON: when the RC1 checklist content map comes back empty for EVERY
 *  accepted document (the systematic all-or-nothing failure that flipped
 *  "report found" 50/50 → 0/50), fall back to the title/type checklist signal for
 *  that run instead of forcing not_found for all documents. A per-run telemetry
 *  line logs how many entries degraded for lack of content. */
export function r1ChecklistContentFallbackEnabled(): boolean {
  return envOnDefaultTrue("CHECKLIST_CONTENT_MAP_FALLBACK");
}

// ── R2 — suspect threshold must not punish correct "No"s ─────────────────────
/** Default ON: coverage is judged "suspect" from measures where a source was
 *  EXPECTED — i.e. positive verdicts (Yes/Partial, score>0) that lack an eligible
 *  supporting quote — rather than the blanket share of all answered measures with
 *  a quote. A correct "No" with no disclosure no longer counts as a coverage gap,
 *  so solid, mostly-"No" companies stop being swept into the suspect bucket. */
export function r2SuspectExpectedSourcingEnabled(): boolean {
  return envOnDefaultTrue("COVERAGE_SUSPECT_EXPECTED_SOURCING");
}


// ─────────────────────────────────────────────────────────────────────────────
// DEFERRED WORKSTREAMS (SCORING_REMEDIATION_PLAN_20261118.md) — NOT shipped here.
// Documented so the next implementer has the full map; each requires the plan §7
// preview-batch verification that cannot be run safely from a code-only change.
//
//  • P1.1 / P1.2 — framework-scoped frozen-corpus snapshot. Today's reuse set is
//    the GLOBAL per-company accepted-document set (storage.getAcceptedDocuments is
//    not framework-filtered), so a true "lock the corpus per framework run" needs a
//    new snapshot table + write path at run start and a reader that prefers it.
//    P1.3 (recheckReusesCorpus) is wired and ships OFF (CORPUS_REUSE_ON_RECHECK)
//    precisely because it should only flip ON once this framework-scoped snapshot
//    exists — otherwise a recheck would re-score against the wrong (global) set.
//  • P1.4 — operator "refresh corpus" endpoint that rebuilds the frozen snapshot
//    on demand (the forceRefresh path already re-discovers; this is the explicit
//    UI/endpoint surface for it).
//  • Z1 — within-document passage-retrieval re-weighting: boost chunks from the
//    section of an umbrella document matching the framework's own thematic
//    vocabulary and down-weight boilerplate governance/ethics/terms chunks when a
//    thematically-matching chunk exists in the same document. A per-measure
//    retrieval lever that must be A/B'd against keystone recall before shipping.
//  • Z2 / Z3 — do NOT force non-zero scores; genuinely unassessable companies
//    already surface as suspect/low-coverage via the coverage flag (now always
//    carrying a reason, R2). The fund-entity item (e.g. asset managers whose
//    disclosures live under individual fund names) needs a DATA input — the fund
//    name list — which is NOT built here. TODO: thread a per-company fund-entity
//    alias list into CompanyIdentity.peerEntities / aliases when that data source
//    exists; until then those companies correctly read as low-coverage, not a
//    confident 0%.
// ─────────────────────────────────────────────────────────────────────────────

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
/** D — concurrency cap for the RC6 readiness re-fetch worker pool. Default 1 =
 *  strictly serial, so the readiness re-fetch behaves byte-for-byte as before.
 *  When set >1, up to that many dead-primary re-fetches run concurrently via a
 *  bounded worker pool (never unbounded). Floored at 1. */
export function rc6CorpusReadinessRetryConcurrency(): number {
  return Math.max(1, envInt("CORPUS_READINESS_RETRY_CONCURRENCY", 1));
}
// ── E — deep second discovery pass (opt-in, concurrency-capped) ──────────────
/** When ON (default OFF — doubles discovery cost), after the first discovery
 *  pass + gating a second pass runs aimed only at framework-required doc types
 *  still missing. */
export function eDeepSecondPassEnabled(): boolean {
  return envOnDefaultFalse("DISCOVERY_DEEP_SECOND_PASS");
}
/** Concurrency cap for the E second pass. Default small (2), floored at 1 —
 *  never unbounded parallelism (peak-load guard for the 502/OOM class). */
export function eDeepSecondPassConcurrency(): number {
  return Math.max(1, envInt("DISCOVERY_DEEP_SECOND_PASS_CONCURRENCY", 2));
}

// ── G — mandatory completeness re-search before scoring (opt-in) ─────────────
/** When ON (default OFF), each framework-required doc type still missing after
 *  discovery/fetch forces a targeted re-search before scoring proceeds. */
export function gMandatoryCompletenessResearchEnabled(): boolean {
  return envOnDefaultFalse("COMPLETENESS_MANDATORY_RESEARCH");
}
/** Concurrency cap for the G mandatory re-search. Default small (2), floored at
 *  1 — bounded worker pool, never unbounded parallelism. */
export function gMandatoryCompletenessResearchConcurrency(): number {
  return Math.max(1, envInt("COMPLETENESS_MANDATORY_RESEARCH_CONCURRENCY", 2));
}

// ── F — PROTOTYPE: admission-gate loosening paired with attribution tightening ─
/** When ON (default OFF), a self-contained prototype that does BOTH together in
 *  reviewQuoteAttribution: (1) LOOSENS admission — the blunt case-study
 *  pre-rejection no longer gates a quote out before attribution; AND (2) TIGHTENS
 *  attribution — a bare identity-token (name-mention) alone no longer attributes;
 *  a stronger co-signal (own-document provenance OR a first-party possessive) is
 *  additionally required. When OFF, attribution behaviour is exactly as today. */
export function fAdmissionGatePrototypeEnabled(): boolean {
  return envOnDefaultFalse("ADMISSION_GATE_PROTOTYPE");
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

// ── P1.1/P1.2 — framework-scoped frozen-corpus snapshot ──────────────────────
/** Default ON: the corpus-reuse decision keys the frozen set on
 *  (company_id, framework_id) via the frozen_corpus_snapshot table instead of the
 *  GLOBAL per-company accepted-document set (storage.getAcceptedDocuments, which is
 *  not framework-filtered and drifts as other runs touch the same company). The
 *  first successful assessment of a (company, framework) pair discovers normally
 *  and WRITES the snapshot; every later run of that pair reuses it byte-for-byte,
 *  which is the single biggest run-to-run consistency lever (plan §3). When OFF the
 *  legacy global reuse set is used. OOM-safe: the snapshot references content by
 *  document_id and never stores body text (see storage.writeFrozenCorpus). */
export function p1FrameworkScopedCorpusEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_FRAMEWORK_SCOPED_SNAPSHOT");
}

// ── P1.3 — recheck re-scores against the frozen corpus (does not re-discover) ──
/** Default ON (flipped once P1.1/P1.2 framework-scoped snapshot landed): the
 *  "Re-examine Failures" / recheck path reuses the frozen corpus and only
 *  re-scores, instead of forcing a fresh discovery that gave the re-examined
 *  companies a DIFFERENT document set (a consistency regression). An explicit
 *  `forceRefresh` / `forceRediscover` (the P1.4 operator refresh action) always
 *  re-discovers regardless. Safe to default ON now because the reuse set is the
 *  framework-scoped snapshot, not the drifting global accepted set. */
export function p1RecheckReusesCorpusEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_REUSE_ON_RECHECK");
}

// ── P1.4 — operator "refresh corpus" endpoint ────────────────────────────────
/** Default ON: enables the POST /api/corpus/refresh effect that purges the
 *  framework-scoped frozen snapshot for a (company, framework) pair — or a whole
 *  framework — so the next run re-discovers cleanly and re-freezes. The route is
 *  additive (always mounted); this flag only gates whether the purge is performed,
 *  so it can be switched OFF in Railway to lock out refreshes without a redeploy.
 *  Deleting snapshot rows never touches documents, scores or results. */
export function p1CorpusRefreshEndpointEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_REFRESH_ENDPOINT");
}

// ── P1.6 — orphaned frozen-snapshot self-heal guard ──────────────────────────
/** Default ON: before reusing a framework-scoped frozen corpus, verify the
 *  snapshot still resolves to live gate-accepted `documents` rows. The frozen
 *  snapshot references evidence by `document_id`, but the `documents` table is
 *  mutated by reset/clear operations (clearDiscoveredDocuments, fullReset*) that
 *  do NOT cascade to frozen_corpus_snapshot. When every snapshot row is orphaned
 *  (its document_id no longer exists in the accepted set), the reuse path loads an
 *  EMPTY corpus → every measure abstains → an all-zero score that looks like a
 *  real assessment. This guard detects a fully-orphaned snapshot, purges it so the
 *  immutable first-wins freeze can be rebuilt, and lets the run re-discover from
 *  scratch (then re-freeze). Self-healing and framework/company-agnostic — it
 *  reads only live table state, never any hardcoded company/framework/measure.
 *  Switch OFF (CORPUS_ORPHAN_REDISCOVER=false) to restore the prior reuse-always
 *  behaviour. */
export function frozenCorpusOrphanGuardEnabled(): boolean {
  return envOnDefaultTrue("CORPUS_ORPHAN_REDISCOVER");
}

// ── Z1 — within-document passage-retrieval re-weighting ──────────────────────
/** Default ON: during passage retrieval, boost chunks drawn from the SECTION of
 *  an umbrella document whose text matches the framework's OWN thematic vocabulary
 *  (derived from framework_measures.evidenceKeywords / the framework definition —
 *  never a company list) and down-weight boilerplate governance/ethics/terms-of-use
 *  chunks WHEN a thematically-matching chunk exists in the same document. This only
 *  reorders which passages are selected (the Michelin "climate chapter loses to the
 *  Code of Ethics" case, plan §6 Z1); it NEVER forces or changes a score and keeps
 *  binary scoring intact. Generic per-measure lever — helps any issuer whose
 *  relevant disclosure is buried in a large registration document. */
export function z1WithinDocReweightEnabled(): boolean {
  return envOnDefaultTrue("PASSAGE_WITHIN_DOC_REWEIGHT");
}
/** Multiplicative boost applied to a passage from a thematically-matching section
 *  of an umbrella document (Z1). >1 lifts on-theme chunks. */
export function z1ThematicBoost(): number {
  return envFloat("PASSAGE_THEMATIC_BOOST", 1.5);
}
/** Multiplicative penalty applied to a boilerplate governance/ethics/terms chunk
 *  (Z1) WHEN an on-theme chunk exists in the SAME document. <1 pushes boilerplate
 *  down. Never zeroes a chunk out (so it can still be selected if nothing else
 *  exists), it only reorders. */
export function z1BoilerplatePenalty(): number {
  return envFloat("PASSAGE_BOILERPLATE_PENALTY", 0.6);
}

// ── Z3 — fund/product entity disambiguation plumbing ─────────────────────────
/** Default ON: when a per-company fund/product alias list is PRESENT (threaded
 *  via company.peerEntities / aliases — see the entity-attribution path), a named
 *  fund/product is treated as a DISTINCT reporting entity from its manager during
 *  entity attribution (plan §6 Z3 — the T. Rowe Price fund-document case). This is
 *  GENERALISED plumbing only: it invents NO fund names and hardcodes nothing; with
 *  no alias data present it is a pure no-op. The fund-name data source is still
 *  required (see the TODO in entity-attribution / RC5) before this changes any
 *  real verdict. */
export function z3FundEntityDisambiguationEnabled(): boolean {
  return envOnDefaultTrue("ENTITY_FUND_DISAMBIGUATION");
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
// Priority 1 — verdict-correctness remediation (companyiq-code-changes-plan.md
// §1.1–1.6). Every flag below defaults OFF / default-preserving: with none set,
// behaviour is byte-identical to today. No company/framework/measure names are
// referenced — all per-framework data (trusted sources etc.) is read from config.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1.1 — re-grade rescued verdicts (harden the latent search-and-repair path) ─
/** Default OFF. Only has any effect in combination with RETRIEVAL_EVIDENCE_REPAIR.
 *  When ON, a YES rescued by the corpus re-search (evidence-gate Option C step 3)
 *  is NOT carried over on a single shared keyword: the replacement passage must
 *  satisfy the measure's FULL positive-criteria predicate (all required
 *  conditions present). If it does not reach Yes on the real replacement text, the
 *  verdict is recorded as No with a `rescue-failed` audit reason. When OFF, the
 *  rescue keeps the YES exactly as today. */
export function evidenceRepairRegradeEnabled(): boolean {
  return envOnDefaultFalse("EVIDENCE_REPAIR_REGRADE");
}

// ── 1.2 — retire the expected-Yes-rate prior (route behind an explicit allow) ──
/** Default OFF. The legacy SCORING_BASE_RATE_PRIOR variable can no longer, on its
 *  own, let the expected-Yes-rate prior influence the verdict-cache salt: the
 *  prior is only honoured when BOTH this allow-flag is ON and
 *  SCORING_BASE_RATE_PRIOR === "true". With the allow-flag OFF (the compiled
 *  default) the salt is byte-identical to today's production (prior off → "br0"),
 *  so a stray SCORING_BASE_RATE_PRIOR cannot silently re-enable it. */
export function scoringBaseRatePriorAllowEnabled(): boolean {
  return envOnDefaultFalse("SCORING_BASE_RATE_PRIOR_ALLOW");
}

// ── 1.3 — finish publisher-based attribution + wire the trusted-source list ────
/** Default OFF. When ON, reviewQuoteAttribution additionally resolves first-party
 *  status by PROVENANCE from framework data: a document on the company's own
 *  domain OR on a framework-registered trusted-source domain (frameworks.
 *  trustedSourceIds → trusted_sources.domain, threaded as
 *  company.frameworkTrustedDomains) is first-party regardless of the quote text,
 *  and publisher provenance is authoritative — a name/brand mention can never
 *  upgrade a document whose host is a known third party. All inputs are framework
 *  config; nothing is hardcoded. When OFF, attribution behaves exactly as today. */
export function attributionTrustedSourceResolveEnabled(): boolean {
  return envOnDefaultFalse("ATTRIBUTION_TRUSTED_SOURCE_RESOLVE");
}

// ── 1.3b — fail OPEN when attribution cannot be positively determined ──────────
/** Default OFF. When ON, reviewQuoteAttribution fails OPEN (attributes the quote
 *  to the target) at the two terminal points where it could NOT make a positive
 *  determination AND has NO contrary signal to justify a rejection:
 *    (a) the F-prototype "bare name-mention without own-doc provenance" reject, and
 *    (b) the final fallthrough (no own-domain / trusted-source / identity / rationale
 *        match was found).
 *  It does NOT touch the positive NEGATIVE-signal rejections (low-value page,
 *  case-study, third-party analyst/news host, more-specific subsidiary, distinct
 *  fund entity) — those remain rejects, so a genuine third-party document is still
 *  rejected. This protects a company's OWN published documents from being wrongly
 *  rejected (and the downstream entity-attribution gate from downgrading them) when
 *  no per-company trusted/own-domain data was available to positively confirm
 *  provenance — mirroring how the other strictness flags fail open rather than
 *  closed. Keys only off the resolver's own decision state; hardcodes NO company,
 *  framework, domain, or measure name. When OFF, attribution behaves exactly as
 *  today (fail closed). */
export function attributionFailOpenWhenNoTrustedDataEnabled(): boolean {
  return envOnDefaultFalse("ATTRIBUTION_FAIL_OPEN_WHEN_NO_TRUSTED_DATA");
}

// ── 1.5 — keep rationale and verdict self-consistent on a gate/rule override ───
/** Default OFF. When ON, any gate/rule that overrides the model's verdict writes
 *  the controlling reason into a dedicated, never-truncated field
 *  (verdictOverrideReason) surfaced in both the screen and the CSV, AND reconciles
 *  the stale affirmative prose by PREFIXING the rationale with the controlling
 *  reason so the displayed narrative no longer asserts the opposite of the
 *  verdict. Display/consistency only — it NEVER moves a verdict. The
 *  detectRationaleScoreInconsistency detector stays in place as a safety net. When
 *  OFF, the legacy append-then-truncate behaviour is unchanged. */
export function gateRationaleSyncEnabled(): boolean {
  return envOnDefaultFalse("GATE_RATIONALE_SYNC");
}

// ── 1.6 — act on needs_readjudication (gated re-adjudication pass) ─────────────
/** Default OFF. When ON, a gated post-scoring pass selects rows flagged
 *  needsReadjudication / rationaleScoreInconsistent and resolves each ONCE: it
 *  re-queries the company's extracted corpus for ALTERNATIVE evidence that
 *  satisfies the measure's positive criteria and re-scores on what it finds. If a
 *  qualifying passage is found the verdict moves to Yes; otherwise the row records
 *  No with a cleared flag and a recorded reason. It writes an auditable trace,
 *  touches only flagged rows, is idempotent (one re-look per row per run) and
 *  deterministic (stable across runs over the same corpus). When OFF, flagged rows
 *  behave exactly as today (remain first-pass scored). */
export function readjudicationPassEnabled(): boolean {
  return envOnDefaultFalse("READJUDICATION_PASS");
}

// ─────────────────────────────────────────────────────────────────────────────
// SHIPPED in this workstream (SCORING_REMEDIATION_PLAN_20261118.md §3/§6) — each
// behind its own env flag above; all default ON per the user's "push so I can
// retest" instruction and independently disablable in Railway:
//
//  • P1.1 / P1.2 — framework-scoped immutable frozen-corpus snapshot. New table
//    frozen_corpus_snapshot (db.ts), storage.getFrozenCorpus / writeFrozenCorpus /
//    purgeFrozenCorpus(ForFramework), worker.ts reuse decision now keys on
//    (company, framework) and freezes after first success, pipeline.ts reuse loads
//    EXACTLY the snapshot document ids. OOM-safe: references content by id, never
//    copies body text. Flag CORPUS_FRAMEWORK_SCOPED_SNAPSHOT (p1FrameworkScopedCorpusEnabled).
//  • P1.3 — CORPUS_REUSE_ON_RECHECK flipped DEFAULT ON (now that the framework-
//    scoped snapshot exists): "Re-examine Failures" / recheck re-SCORES against the
//    frozen set instead of re-discovering. forceRefresh / forceRediscover still
//    always re-discovers.
//  • P1.4 — operator "refresh corpus" action: POST /api/corpus/refresh purges the
//    snapshot for a (company, framework) pair or a whole framework and forces clean
//    re-discovery on the next run. Flag CORPUS_REFRESH_ENDPOINT (p1CorpusRefreshEndpointEnabled).
//  • P1.5 — verified (read-only + unit test): the verdict cache key embeds
//    evidenceHash (SHA-256 of the evidence pack text), which is corpus-derived, so
//    a locked corpus → identical evidence → identical verdict. No schema change
//    needed; see analyzer verdict-cache key test.
//  • Z1 — within-document passage-retrieval re-weighting (passage-retrieval.ts),
//    flag PASSAGE_WITHIN_DOC_REWEIGHT (z1WithinDocReweightEnabled). Reorders
//    passages only; never forces a score.
//  • Z3 — fund/product entity disambiguation PLUMBING threaded through the
//    entity-attribution path, flag ENTITY_FUND_DISAMBIGUATION
//    (z3FundEntityDisambiguationEnabled). Generalised: no-op unless a per-company
//    fund/product alias list is present.
//
// STILL DEFERRED / requires a data input (NOT code):
//  • Z2 — do NOT force non-zero scores; genuinely unassessable companies already
//    surface as suspect/low-coverage via the coverage flag (always carries a
//    reason, R2). No code change — confirmed, nothing to ship.
//  • Z3 DATA INPUT — the actual per-company fund/product-name list does NOT exist
//    yet. The plumbing above consumes it when present (company.peerEntities /
//    aliases), but NO fund names are invented or hardcoded. TODO: feed a real
//    fund-name data source into the alias path; until then asset managers whose
//    disclosures live under individual fund names correctly read as low-coverage,
//    not a confident 0%. See the TODO in entity-attribution.
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// Priority 2 — execute the framework's OWN rules (read from framework config).
// All DEFAULT-OFF: with every flag unset, every measure applies, coverage is
// narrated as before, no reporting-period window is enforced, and entity scope is
// not restricted — i.e. behaviour is byte-for-byte the current production path.
// ═════════════════════════════════════════════════════════════════════════════

/** 2.1 — evaluate a structured `applicabilityRule` from the company profile
 *  BEFORE any Yes/No verdict. A non-applicable measure is marked
 *  "not applicable" (auditable rationale) and REMOVED FROM THE DENOMINATOR
 *  (computeCompanyScore already distinguishes assessed/answered via backfilled).
 *  Off = all measures apply. */
export function applicabilityRulesExecuted(): boolean {
  return envOnDefaultFalse("APPLICABILITY_RULES_EXECUTED");
}

/** 2.2 — add structured `coverageRule` + `coverageWhitelist` evaluation so a
 *  coverage verdict is COMPUTED, not narrated; an undisclosed denominator cannot
 *  pass. Off = coverage handled by the existing narrated path. */
export function coverageRulesExecuted(): boolean {
  return envOnDefaultFalse("COVERAGE_RULES_EXECUTED");
}

/** 2.3 — consume a framework-level `reportingPeriod` window; evidence older than
 *  the window cannot support a Yes. Window comes from framework data (no dates
 *  hardcoded). Off = no recency enforcement. */
export function reportingPeriodEnforced(): boolean {
  return envOnDefaultFalse("REPORTING_PERIOD_ENFORCED");
}

/** 2.4 — consume `entityType`/`universe` to apply a parent/subsidiary rule
 *  (group/parent disclosures only; subsidiary docs excluded unless consolidated).
 *  Integrates with the 1.3 trusted-source resolution. Off = no scope restriction. */
export function entityScopeEnforced(): boolean {
  return envOnDefaultFalse("ENTITY_SCOPE_ENFORCED");
}

// ═════════════════════════════════════════════════════════════════════════════
// Priority 3 — retrieval robustness + first-run comprehensiveness. All DEFAULT-OFF
// except the shipped CORPUS_ORPHAN_REDISCOVER safety net (unchanged).
// ═════════════════════════════════════════════════════════════════════════════

/** 3.1 — on frozen-corpus reuse, resolve frozen content by content_hash/url
 *  against document_content (not just documents.id) so a snapshot survives a
 *  documents-table reset; cascade-invalidate snapshots on a documents purge. */
export function frozenCorpusContentHashReuse(): boolean {
  return envOnDefaultFalse("FROZEN_CORPUS_CONTENT_HASH_REUSE");
}

/** 3.2a — seed `knownDisclosureUrls` per company from framework data. */
export function retrievalKnownUrlsSeed(): boolean {
  return envOnDefaultFalse("RETRIEVAL_KNOWN_URLS_SEED");
}
/** 3.2b — rebuild retrieval as two lexical families + a performance family and
 *  make `requiredSourceTypes` NON-BLOCKING so material evidence isn't excluded
 *  by vehicle. */
export function retrievalVehicleAgnostic(): boolean {
  return envOnDefaultFalse("RETRIEVAL_VEHICLE_AGNOSTIC");
}
/** 3.2c — make transition-risk exclusion keywords relaxable so
 *  sustainability/TCFD/CDP docs aren't down-ranked. */
export function retrievalExclusionKeywordsRelaxed(): boolean {
  return envOnDefaultFalse("RETRIEVAL_EXCLUSION_KEYWORDS_RELAXED");
}

/** 3.3a — count each quote toward ONE measure unless the measure explicitly
 *  allows sharing (`allowQuoteSharing`). */
export function evidenceQuoteSingleUse(): boolean {
  return envOnDefaultFalse("EVIDENCE_QUOTE_SINGLE_USE");
}
/** 3.3b — allow conditions to be met across two ADJACENT passages of the same
 *  document (or raise `minQuoteContextChars`). */
export function evidenceAdjacentPassageSpan(): boolean {
  return envOnDefaultFalse("EVIDENCE_ADJACENT_PASSAGE_SPAN");
}
/** Max char gap between two passages for them to count as "adjacent". */
export function evidenceAdjacentPassageMaxGap(): number {
  return Math.max(0, envInt("EVIDENCE_ADJACENT_PASSAGE_MAX_GAP", 400));
}

/** 3.4b — bounded extraction-retry + fallback for dominant failure vehicles
 *  (PDF-behind-link). MUST be bounded; cannot loop or inflate cost. */
export function extractionRetryFallback(): boolean {
  return envOnDefaultFalse("EXTRACTION_RETRY_FALLBACK");
}
/** Hard upper bound on extraction retries per document (floored at 0). */
export function extractionRetryBudget(): number {
  return Math.max(0, envInt("EXTRACTION_RETRY_BUDGET", 1));
}
/** 3.4a — ADDITIVE discovery→extraction→in-evidence funnel instrumentation.
 *  Pure counting + logging; never changes a verdict. Default OFF (log only when
 *  explicitly enabled to avoid log noise). */
export function retrievalFunnelInstrumentation(): boolean {
  return envOnDefaultFalse("RETRIEVAL_FUNNEL_INSTRUMENTATION");
}

// ═════════════════════════════════════════════════════════════════════════════
// Score-Only Replay harness — HOLD EVIDENCE CONSTANT across runs so a scoring /
// flag / config delta becomes measurable.
//
// WHY: framework 25 (and others) swing run-to-run because the document set per
// company is re-discovered + re-retrieved + re-extracted on every run (Yes-match
// consistency across consecutive runs was only ~49%). No code/flag/config delta
// can be attributed while the evidence moves underneath. This harness pins ONE
// accepted document set per (company, framework) — the IMMUTABLE
// frozen_corpus_snapshot already frozen on the first successful assessment of the
// pair (storage.writeFrozenCorpus) — and, on later runs, bypasses
// discovery + retrieval(fetch) + extraction entirely, feeding that exact pinned
// corpus's already-extracted content straight to scoring. Scoring then runs
// NORMALLY (all other scoring flags still apply), so the ONLY thing held constant
// is the evidence set.
//
// This is DISTINCT from CORPUS_REUSE_ACROSS_RUNS / FROZEN_CORPUS_CONTENT_HASH_REUSE
// (which skip only the discovery SEARCH but still fetch/extract the persisted
// corpus, and still fall back to re-discovery in several paths). Score-only replay
// additionally skips fetch + extraction and NEVER re-discovers: a company with no
// pinned set is SKIPPED with a logged reason rather than silently re-discovered
// (which would defeat the purpose).
//
// The replay source is keyed by (company_id, framework_id) via the immutable
// frozen_corpus_snapshot — there is exactly one golden set per pair (first-wins),
// so no run/snapshot id needs to be supplied. Nothing is hardcoded: company,
// framework and measure are all resolved from live DB/config at run time.
// ═════════════════════════════════════════════════════════════════════════════

/** Default OFF. When ON, a run of a (company, framework) pair that has a pinned
 *  frozen_corpus_snapshot replays score-only against that exact evidence set
 *  (discovery + fetch + extraction bypassed); a pair with no pinned set is
 *  skipped with a logged reason (never re-discovered). With the flag OFF the
 *  pipeline behaves byte-for-byte as today. */
export function scoreOnlyReplayEnabled(): boolean {
  return envOnDefaultFalse("SCORE_ONLY_REPLAY");
}

/** Default OFF. Cold-start fallback for SCORE_ONLY_REPLAY. When ON, a
 *  (company, framework) pair that has NO pinned frozen_corpus_snapshot is NOT
 *  skipped — it falls through to a normal discovery + score run, which then
 *  freezes the golden snapshot (first-wins). The next run of that pair finds the
 *  snapshot and replays against it (evidence held constant). This lets a fresh
 *  set of companies / a new framework produce complete results in ONE run
 *  without a prior "golden" run, while preserving hold-evidence-constant for
 *  every subsequent run. A pair that already has a snapshot still replays — this
 *  flag only changes the no-snapshot case, from "skip" to "discover+freeze".
 *  With it OFF (compiled default) the no-snapshot case skips exactly as before. */
export function scoreOnlyReplayColdStartDiscoversEnabled(): boolean {
  return envOnDefaultFalse("SCORE_ONLY_REPLAY_COLD_START_DISCOVERS");
}

// ═════════════════════════════════════════════════════════════════════════════
// FRAMEWORK_SCOPE_CONFIG_ENRICH — generic scope-config enrichment carrier.
//
// WHY: the Priority-2 strictness flags REPORTING_PERIOD_ENFORCED and
// ENTITY_SCOPE_ENFORCED are enabled in production, but they fail OPEN because the
// analyzer reads fw.entityType / fw.reportingPeriodMonths / fw.universe /
// fw.subsidiaryDomains and NONE of those are columns on the frameworks Drizzle
// table — they are always undefined, so the strictness never engages. This flag
// lets a framework carry those scope fields in its existing `metadata` jsonb
// column under `metadata.scopeConfig`, and enrichFrameworkScopeConfig
// (framework-scope-config.ts) back-fills them onto the framework object returned by
// getFrameworkById — exactly where the analyzer reads them.
//
// Mechanism ONLY: this flag does NOT populate any framework's metadata and is NOT
// enabled anywhere. With it OFF (the compiled default) the framework object is
// returned byte-for-byte as today, so evidence is held constant. Completely
// generic — no company/framework/measure name is referenced.
// ═════════════════════════════════════════════════════════════════════════════

/** Default OFF. When ON, getFrameworkById back-fills entityType / universe /
 *  reportingPeriodMonths / subsidiaryDomains from `framework.metadata.scopeConfig`
 *  onto the framework object (only when present there AND not already set), so the
 *  already-enabled REPORTING_PERIOD_ENFORCED / ENTITY_SCOPE_ENFORCED strictness
 *  flags can actually engage. When OFF, the framework is returned unchanged. */
export function frameworkScopeConfigEnrichEnabled(): boolean {
  return envOnDefaultFalse("FRAMEWORK_SCOPE_CONFIG_ENRICH");
}

/**
 * Pure, deterministic decision used by the pipeline to choose the Score-Only
 * Replay branch. Kept side-effect-free so it is directly unit-testable and so the
 * replay/skip/off contract is discoverable in one place.
 *
 *   mode "off"    → harness disabled (or a batch_corpus replay is already active):
 *                   run the pipeline exactly as today.
 *   mode "replay" → harness ON and a pinned corpus exists for (company,framework):
 *                   bypass discovery/retrieval/extraction, score the pinned set.
 *   mode "skip"   → harness ON but NO pinned corpus for this pair: SKIP the
 *                   company with a reason — explicitly do NOT re-discover (that
 *                   would move the evidence and defeat the harness).
 *
 * `sourceBatchIdPresent` yields "off" so this never double-engages with the
 * existing batch_corpus (`sourceBatchId`) replay path.
 */
export function decideScoreOnlyReplay(opts: {
  enabled: boolean;
  sourceBatchIdPresent: boolean;
  pinnedDocCount: number;
  /** SCORE_ONLY_REPLAY_COLD_START_DISCOVERS. When true, a pair with no pinned
   *  corpus returns "discover" (normal discovery + freeze this run) instead of
   *  "skip". Defaults false → unchanged skip behaviour. */
  coldStartDiscovers?: boolean;
}): { mode: "off" | "replay" | "skip" | "discover"; reason: string } {
  if (!opts.enabled) return { mode: "off", reason: "flag-off" };
  if (opts.sourceBatchIdPresent) return { mode: "off", reason: "source-batch-replay-active" };
  if (opts.pinnedDocCount > 0) {
    return { mode: "replay", reason: `pinned-corpus-present:${opts.pinnedDocCount}` };
  }
  if (opts.coldStartDiscovers) {
    // Cold start: nothing frozen yet for this pair. Do a normal discovery+score
    // run (the worker freezes the golden snapshot on success); later runs replay
    // it. "Hold evidence constant" is preserved — there is no evidence to hold.
    return { mode: "discover", reason: "cold-start-discovery:no-pinned-corpus" };
  }
  return { mode: "skip", reason: "no-pinned-corpus" };
}



// ═════════════════════════════════════════════════════════════════════════════
// 2026-11-20 scoring-reproducibility remediation (F1–F6).
//
// Every flag below is DEFAULT-OFF: with none set, the pipeline, analyzer and CSV
// export behave byte-for-byte as before. Nothing hardcodes a company, framework
// or measure — every such value is resolved from live DB rows / framework config
// / CSV input at run time. The pure decision helpers are kept side-effect-free so
// they are directly unit-testable.
// ═════════════════════════════════════════════════════════════════════════════

// ── F1 — FRAMEWORK_LINEAGE_FREEZE ────────────────────────────────────────────
/** Default OFF. When ON, the frozen-corpus lookup/write key uses the framework's
 *  stable `frameworkLineageId` (the id of the lineage root framework, carried
 *  forward across /v2/import re-imports) instead of the per-import framework id.
 *  This makes the golden corpus survive a re-import that mints a new framework id
 *  (RC#1). When OFF, the key is the framework id exactly as today. */
export function frameworkLineageFreezeEnabled(): boolean {
  return envOnDefaultFalse("FRAMEWORK_LINEAGE_FREEZE");
}

/** Pure freeze-key selector. Returns the lineage id when the flag is ON and a
 *  non-null lineage id is available, otherwise the framework id. Used at every
 *  frozen_corpus_snapshot call site so lookup and write always agree. */
export function freezeFrameworkKey(opts: {
  flagOn: boolean;
  frameworkId: number;
  frameworkLineageId?: number | null;
}): number {
  if (opts.flagOn && opts.frameworkLineageId != null) {
    return opts.frameworkLineageId;
  }
  return opts.frameworkId;
}

// ── F2 — VERDICT_CACHE_DURABLE ───────────────────────────────────────────────
/** Default OFF. When ON, the analyzer's in-memory `verdictCache` Map is backed by
 *  a durable `verdict_cache` DB table keyed on (company id, measure id, evidence
 *  hash, prompt hash) so a verdict already computed in a prior run is reused on
 *  replay instead of re-calling the model. When OFF, only the in-memory Map is
 *  used — exactly as today. */
export function verdictCacheDurableEnabled(): boolean {
  return envOnDefaultFalse("VERDICT_CACHE_DURABLE");
}

// ── F3 — ATTRIBUTION_MANUAL_DOMAINS_AT_GATE ──────────────────────────────────
/** Default OFF. When ON, the attribution gate call sites pass the UNION of
 *  company.related_domains + company.related_domains_manual (deduped/normalized)
 *  instead of related_domains alone, so manually-curated domains reach the gate
 *  under replay (RC#3). When OFF, only related_domains is passed, as today. */
export function attributionManualDomainsAtGateEnabled(): boolean {
  return envOnDefaultFalse("ATTRIBUTION_MANUAL_DOMAINS_AT_GATE");
}

/** Normalize a single domain-ish string to a bare lowercase host: strip scheme,
 *  leading www., any path/query, surrounding whitespace and a trailing dot/slash.
 *  Returns "" for anything that does not look like a host (caller filters). */
export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let d = raw.trim().toLowerCase();
  if (d === "") return "";
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme://
  d = d.replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("#")[0]; // drop path/query/fragment
  d = d.replace(/\.+$/, "").trim();
  return d;
}

/** Pure union of the two domain lists, normalized and deduped, preserving the
 *  order in which distinct hosts first appear (related_domains first, then the
 *  manual list). Non-string / empty / malformed entries are dropped. */
export function unionOwnDomains(
  relatedDomains: unknown,
  relatedDomainsManual: unknown,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const d = normalizeDomain(entry);
      if (d && !seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  };
  push(relatedDomains);
  push(relatedDomainsManual);
  return out;
}

// ── F4 — CSV_RUN_MANIFEST_EXPORT ─────────────────────────────────────────────
/** Default OFF. When ON, the CSV export gains a run-header section (git commit,
 *  framework id + content hash, run mode, non-default flag snapshot, framework
 *  version) and per-company corpus columns (Corpus Hash, Docs In Corpus, Corpus
 *  Frozen At, Replay Y/N), sourced from the stored run manifest + frozen-corpus
 *  records. When OFF, the CSV is byte-for-byte unchanged. */
export function csvRunManifestExportEnabled(): boolean {
  return envOnDefaultFalse("CSV_RUN_MANIFEST_EXPORT");
}

// ── F5 — PINNED_DOCUMENTS_ENABLED ────────────────────────────────────────────
/** Default OFF. Completeness flag for pinned-document pipeline consumption. The
 *  pipeline already consumes company.pinnedDocuments unconditionally (a no-op
 *  when the list is empty), so this flag does NOT gate that existing behaviour;
 *  it exists so any NEW pinned-document behaviour can be gated consistently and
 *  so the capability is discoverable. The CSV import column and single-company
 *  route that SET pinnedDocuments are always available (input plumbing). */
export function pinnedDocumentsEnabled(): boolean {
  return envOnDefaultFalse("PINNED_DOCUMENTS_ENABLED");
}

// ── F6 — SCORING_VOTE_EXPORT + SCORING_TIEBREAK_RETRY ────────────────────────
/** Default OFF. When ON, the CSV export adds a per-measure self-consistency vote
 *  column (e.g. "2/3"). Verdicts are NOT changed. When OFF, the column is absent
 *  and the CSV is unchanged. */
export function scoringVoteExportEnabled(): boolean {
  return envOnDefaultFalse("SCORING_VOTE_EXPORT");
}

/** Default OFF. When ON, if the self-consistency passes split evenly because a
 *  pass FAILED (rather than returning a verdict), the analyzer retries the failed
 *  pass once before falling back to the current default-up tie-break. When OFF,
 *  the tie-break behaves exactly as today. */
export function scoringTiebreakRetryEnabled(): boolean {
  return envOnDefaultFalse("SCORING_TIEBREAK_RETRY");
}

/** Pure formatter for the self-consistency vote string, e.g. (2, 3) → "2/3".
 *  Returns "" when the inputs are not usable (no substantive passes), so the
 *  export can leave the cell blank rather than print "0/0" or "NaN". */
export function formatVoteString(
  winningCount: unknown,
  substantiveCount: unknown,
): string {
  const w = Number(winningCount);
  const s = Number(substantiveCount);
  if (!Number.isFinite(w) || !Number.isFinite(s) || s <= 0) return "";
  if (w < 0 || w > s) return "";
  return `${w}/${s}`;
}

/** Pure tie-break decision. Returns true when the failed pass should be retried
 *  instead of defaulting up. Conditions: flag ON, at least one pass failed, and
 *  the substantive (non-failed) passes are split evenly (a true tie that the
 *  failed pass would otherwise have broken). When the substantive passes already
 *  have a majority, or no pass failed, or the flag is OFF, returns false (no
 *  retry — current behaviour stands). */
export function decideTiebreakRetry(opts: {
  flagOn: boolean;
  /** Numeric score bucket per substantive (non-failed) pass. */
  substantiveScores: number[];
  /** How many passes FAILED (returned no verdict) this round. */
  failedPassCount: number;
}): boolean {
  if (!opts.flagOn) return false;
  if (opts.failedPassCount <= 0) return false;
  const scores = opts.substantiveScores ?? [];
  if (scores.length === 0) return false;
  // Tally the substantive buckets; a retry only helps when they are tied.
  const tally = new Map<number, number>();
  for (const s of scores) tally.set(s, (tally.get(s) ?? 0) + 1);
  const counts = [...tally.values()].sort((a, b) => b - a);
  if (counts.length < 2) return false; // all substantive passes agree → no tie
  return counts[0] === counts[1]; // top two buckets equal → even split
}

// ═════════════════════════════════════════════════════════════════════════════
// 2026-11-21 "Run 8 Review" remediation (CHANGE 1–8). Every flag below is
// DEFAULT-OFF (CHANGE 6 reuses the existing SCORING_VOTE_EXPORT flag and adds no
// new flag): with none set, the pipeline, analyzer, storage, export and checklist
// behave byte-for-byte as before. Nothing hardcodes a company, framework or
// measure name — the physical-hazard VOCABULARY is generic domain vocabulary,
// supplied as a default list and overridable by env. The pure decision helpers
// are side-effect-free so they are directly unit-testable.
// ═════════════════════════════════════════════════════════════════════════════

// ── CHANGE 1 — FROZEN_CORPUS_FRAMEWORK_SCOPED ────────────────────────────────
/** Default OFF. When ON, storage.writeFrozenCorpus restricts the frozen document
 *  set to documents that were accepted FOR THIS FRAMEWORK (resolved via
 *  batch_corpus → batch_runs on framework_id, across every framework id sharing
 *  the same framework_lineage_id — falling back to the framework's own id when the
 *  lineage is null). When OFF, the frozen set is the current per-company
 *  accepted-document set (no framework filter), byte-for-byte as today. */
export function frozenCorpusFrameworkScopedEnabled(): boolean {
  return envOnDefaultFalse("FROZEN_CORPUS_FRAMEWORK_SCOPED");
}

// ── CHANGE 2 — RUN_HEADER_FULL_FLAG_SNAPSHOT ─────────────────────────────────
/** Default OFF. When ON: (a) the export freeze-key lookup logs a warning instead
 *  of swallowing the error silently; (b) the run/corpus header prints the freeze
 *  key and a "Replay: N of total" line; and (c) snapshotNonDefaultScoringFixFlags
 *  emits EVERY boolean flag whose effective value differs from its compiled
 *  default (computed dynamically from the registry below), instead of the fixed
 *  10-name list. When OFF, all three behave exactly as today. */
export function runHeaderFullFlagSnapshotEnabled(): boolean {
  return envOnDefaultFalse("RUN_HEADER_FULL_FLAG_SNAPSHOT");
}

// ── CHANGE 3 — REPORTING_PERIOD_WEBPAGE_FETCHDATE_FALLBACK ────────────────────
/** Default OFF. Only has any effect when REPORTING_PERIOD_ENFORCED is also ON.
 *  When both are ON, an UNDATED web page (not a dated PDF) whose own text yields
 *  no extractable year falls back to the document's fetchedAt date for
 *  reporting-period-window membership. When OFF, an undated document fails closed
 *  (excluded) exactly as today. */
export function reportingPeriodWebpageFetchdateFallbackEnabled(): boolean {
  return envOnDefaultFalse("REPORTING_PERIOD_WEBPAGE_FETCHDATE_FALLBACK");
}

// ── CHANGE 4 — CORPUS_LOW_VALUE_PAGE_FILTER_EXTENDED ─────────────────────────
/** Default OFF. When ON, isLowValuePageSource ALSO excludes careers/jobs pages,
 *  linkedin.com and wikipedia.org (in addition to the base low-value patterns).
 *  When OFF, only the base patterns apply, exactly as today. */
export function corpusLowValuePageFilterExtendedEnabled(): boolean {
  return envOnDefaultFalse("CORPUS_LOW_VALUE_PAGE_FILTER_EXTENDED");
}

// ── CHANGE 5 — SCORING_PHYSICAL_HAZARD_TERM_REQUIRED ─────────────────────────
/** Default OFF. When ON, a "Yes" on a physical-climate-track measure is
 *  downgraded to "No" unless its supporting/lead evidence contains a concrete
 *  physical-hazard term (a generic "climate-related" mention alone does NOT
 *  satisfy the gate). When OFF, verdicts are untouched. */
export function scoringPhysicalHazardTermRequiredEnabled(): boolean {
  return envOnDefaultFalse("SCORING_PHYSICAL_HAZARD_TERM_REQUIRED");
}

const DEFAULT_PHYSICAL_HAZARD_TERMS = [
  "flood",
  "heat",
  "heatwave",
  "storm",
  "cyclone",
  "hurricane",
  "typhoon",
  "drought",
  "wildfire",
  "sea-level",
  "sea level",
  "water stress",
  "water scarcity",
  "acute",
  "chronic",
  "extreme weather",
  "physical risk",
  "physical climate risk",
  "landslide",
  "subsidence",
  "precipitation",
];

const DEFAULT_PHYSICAL_HAZARD_TRACK_TOKENS = [
  "physical_climate",
  "physical climate",
  "physical risk",
  "physical resilience",
  "business continuity",
];

/** Generic physical-hazard vocabulary. Default list above (none of which is a
 *  substring of "climate-related"), overridable wholesale via the comma-separated
 *  SCORING_PHYSICAL_HAZARD_TERMS env var. Not a company/framework/measure name. */
export function physicalHazardTerms(): string[] {
  const raw = process.env["SCORING_PHYSICAL_HAZARD_TERMS"];
  if (raw != null && raw.trim() !== "") {
    const list = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (list.length > 0) return list;
  }
  return DEFAULT_PHYSICAL_HAZARD_TERMS.slice();
}

/** Generic tokens that identify a physical-climate / physical-resilience track,
 *  overridable via comma-separated SCORING_PHYSICAL_HAZARD_TRACKS. */
export function physicalHazardTrackTokens(): string[] {
  const raw = process.env["SCORING_PHYSICAL_HAZARD_TRACKS"];
  if (raw != null && raw.trim() !== "") {
    const list = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
    if (list.length > 0) return list;
  }
  return DEFAULT_PHYSICAL_HAZARD_TRACK_TOKENS.slice();
}

/** Pure: true when any of the provided free-text signals (framework name/track,
 *  measure category, etc.) contains any physical-hazard track token. */
export function matchesPhysicalHazardTrack(
  signals: Array<string | null | undefined>,
  tokens?: string[],
): boolean {
  const toks = tokens && tokens.length > 0 ? tokens : physicalHazardTrackTokens();
  const hay = signals
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase();
  if (hay === "") return false;
  return toks.some((t) => hay.includes(t.toLowerCase()));
}

/** Pure: true when the evidence text mentions a concrete physical-hazard term. */
export function evidenceHasPhysicalHazardTerm(
  evidenceText: string,
  hazardTerms?: string[],
): boolean {
  const terms = hazardTerms && hazardTerms.length > 0 ? hazardTerms : physicalHazardTerms();
  const hay = (evidenceText || "").toLowerCase();
  if (hay === "") return false;
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/**
 * Pure, side-effect-free decision for the physical-hazard-term gate (CHANGE 5).
 * Returns whether a "Yes" should be downgraded and a human-readable reason.
 *   flag off                → no downgrade
 *   not a physical track     → no downgrade
 *   verdict is not "Yes"     → no downgrade
 *   hazard term present       → no downgrade
 *   otherwise                → downgrade ("physical-hazard-term-missing")
 */
export function decidePhysicalHazardGate(opts: {
  flagOn: boolean;
  isPhysicalTrack: boolean;
  verdict: string | null | undefined;
  evidenceText: string;
  hazardTerms?: string[];
}): { downgrade: boolean; reason: string } {
  if (!opts.flagOn) return { downgrade: false, reason: "flag-off" };
  if (!opts.isPhysicalTrack) return { downgrade: false, reason: "not-physical-track" };
  if ((opts.verdict || "").trim().toLowerCase() !== "yes") {
    return { downgrade: false, reason: "verdict-not-yes" };
  }
  if (evidenceHasPhysicalHazardTerm(opts.evidenceText, opts.hazardTerms)) {
    return { downgrade: false, reason: "physical-hazard-term-present" };
  }
  return { downgrade: true, reason: "physical-hazard-term-missing" };
}

// ── CHANGE 6 — self-consistency vote persisted in decision_trace jsonb ────────
// (reuses the existing SCORING_VOTE_EXPORT flag — scoringVoteExportEnabled())
/**
 * Pure: merge a self-consistency vote string into a decision_trace jsonb value
 * WITHOUT overwriting any existing trace data. Returns the (possibly new) trace
 * object. A no-op (returns the trace unchanged) when the flag is off or the vote
 * is empty. Tolerant of a null/undefined/non-object trace (starts a fresh object).
 */
export function withSelfConsistencyVoteInTrace(
  trace: unknown,
  vote: unknown,
  flagOn: boolean,
): unknown {
  if (!flagOn) return trace;
  const v = typeof vote === "string" ? vote.trim() : "";
  if (v === "") return trace;
  const base: Record<string, unknown> =
    trace && typeof trace === "object" && !Array.isArray(trace)
      ? { ...(trace as Record<string, unknown>) }
      : {};
  base.selfConsistencyVote = v;
  return base;
}

/** Pure: read a self-consistency vote string previously merged into a
 *  decision_trace jsonb value. Returns "" when absent or unusable. */
export function readSelfConsistencyVoteFromTrace(trace: unknown): string {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) return "";
  const v = (trace as Record<string, unknown>)["selfConsistencyVote"];
  return typeof v === "string" ? v : "";
}

// ── CHANGE 7 — CHECKLIST_SOURCE_TYPE_CLASSIFY ────────────────────────────────
/** Default OFF. When ON, the document checklist classifies each item using the
 *  same source-type classifier the scorer uses, so e.g. "Sustainability/ESG
 *  Report: found" reflects reality, and allows the "Comprehensive" status ONLY
 *  when BOTH an annual report AND a sustainability-or-climate report are present
 *  in the classified set. When OFF, the current checklist labels are kept. */
export function checklistSourceTypeClassifyEnabled(): boolean {
  return envOnDefaultFalse("CHECKLIST_SOURCE_TYPE_CLASSIFY");
}

// ── CHANGE 8 — EVIDENCE_QUOTE_OVERLAP_MATCH ──────────────────────────────────
/** Default OFF. Extends the existing EVIDENCE_QUOTE_SINGLE_USE dedupe: when ON,
 *  two quotes are treated as the same when they reference the same passage id OR
 *  share ≥ (threshold) of their tokens (Jaccard on normalized lowercased word
 *  sets). When OFF, only exact-text matching is used, exactly as today. */
export function evidenceQuoteOverlapMatchEnabled(): boolean {
  return envOnDefaultFalse("EVIDENCE_QUOTE_OVERLAP_MATCH");
}
/** Jaccard token-overlap threshold for CHANGE 8 (default 0.6). */
export function evidenceQuoteOverlapThreshold(): number {
  const t = envFloat("EVIDENCE_QUOTE_OVERLAP_THRESHOLD", 0.6);
  if (!(t > 0) || t > 1) return 0.6;
  return t;
}

/** Pure: Jaccard token overlap of two quote strings on normalized lowercased
 *  word sets (punctuation stripped). Returns 0 when either side has no tokens. */
export function quoteTokenOverlap(a: string, b: string): number {
  const toks = (s: string): Set<string> =>
    new Set(
      (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 0),
    );
  const sa = toks(a);
  const sb = toks(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boolean-flag default registry (CHANGE 2c). Maps every boolean scoring-fix flag
// env name to its COMPILED default (true for default-ON, false for default-OFF).
// Used by snapshotNonDefaultScoringFixFlags when RUN_HEADER_FULL_FLAG_SNAPSHOT is
// on to emit every flag whose EFFECTIVE value differs from its default. Kept here
// so the one place that enumerates flags stays in sync with the helpers above.
// ─────────────────────────────────────────────────────────────────────────────
const BOOLEAN_FLAG_DEFAULTS: Record<string, boolean> = {
  // default-ON flags
  CHECKLIST_EMBEDDING_CONTENT_CHECK: true,
  CORPUS_READINESS_RETRY: true,
  CORPUS_LOW_VALUE_PAGE_FILTER: true,
  ATTRIBUTION_FILING_PROVENANCE: true,
  ATTRIBUTION_SUBSIDIARY_DISAMBIGUATION: true,
  SCORING_ONE_QUOTE_PER_MEASURE: true,
  CORPUS_REUSE_ACROSS_RUNS: true,
  CORPUS_FRAMEWORK_SCOPED_SNAPSHOT: true,
  CORPUS_REUSE_ON_RECHECK: true,
  CORPUS_REFRESH_ENDPOINT: true,
  CORPUS_ORPHAN_REDISCOVER: true,
  PASSAGE_WITHIN_DOC_REWEIGHT: true,
  ENTITY_FUND_DISAMBIGUATION: true,
  ATTRIBUTION_OWNDOC_BEFORE_SUBSIDIARY: true,
  ATTRIBUTION_RC5_ENTITY_LIST_SCOPED: true,
  ADMISSION_COMPETITOR_DOMINANCE: true,
  ATTRIBUTION_THIRD_PARTY_HOST_GATE: true,
  CHECKLIST_CONTENT_MAP_FALLBACK: true,
  COVERAGE_SUSPECT_EXPECTED_SOURCING: true,
  // default-OFF flags
  DISCOVERY_DEEP_SECOND_PASS: false,
  COMPLETENESS_MANDATORY_RESEARCH: false,
  ADMISSION_GATE_PROTOTYPE: false,
  SCORING_CROSS_RUN_MAJORITY: false,
  EVIDENCE_REPAIR_REGRADE: false,
  SCORING_BASE_RATE_PRIOR_ALLOW: false,
  ATTRIBUTION_TRUSTED_SOURCE_RESOLVE: false,
  ATTRIBUTION_FAIL_OPEN_WHEN_NO_TRUSTED_DATA: false,
  GATE_RATIONALE_SYNC: false,
  READJUDICATION_PASS: false,
  APPLICABILITY_RULES_EXECUTED: false,
  COVERAGE_RULES_EXECUTED: false,
  REPORTING_PERIOD_ENFORCED: false,
  ENTITY_SCOPE_ENFORCED: false,
  FROZEN_CORPUS_CONTENT_HASH_REUSE: false,
  RETRIEVAL_KNOWN_URLS_SEED: false,
  RETRIEVAL_VEHICLE_AGNOSTIC: false,
  RETRIEVAL_EXCLUSION_KEYWORDS_RELAXED: false,
  EVIDENCE_QUOTE_SINGLE_USE: false,
  EVIDENCE_ADJACENT_PASSAGE_SPAN: false,
  EXTRACTION_RETRY_FALLBACK: false,
  RETRIEVAL_FUNNEL_INSTRUMENTATION: false,
  SCORE_ONLY_REPLAY: false,
  SCORE_ONLY_REPLAY_COLD_START_DISCOVERS: false,
  FRAMEWORK_SCOPE_CONFIG_ENRICH: false,
  FRAMEWORK_LINEAGE_FREEZE: false,
  VERDICT_CACHE_DURABLE: false,
  ATTRIBUTION_MANUAL_DOMAINS_AT_GATE: false,
  CSV_RUN_MANIFEST_EXPORT: false,
  PINNED_DOCUMENTS_ENABLED: false,
  SCORING_VOTE_EXPORT: false,
  SCORING_TIEBREAK_RETRY: false,
  // CHANGE 1–8 flags (all default-OFF; CHANGE 6 reuses SCORING_VOTE_EXPORT above)
  FROZEN_CORPUS_FRAMEWORK_SCOPED: false,
  RUN_HEADER_FULL_FLAG_SNAPSHOT: false,
  REPORTING_PERIOD_WEBPAGE_FETCHDATE_FALLBACK: false,
  CORPUS_LOW_VALUE_PAGE_FILTER_EXTENDED: false,
  SCORING_PHYSICAL_HAZARD_TERM_REQUIRED: false,
  CHECKLIST_SOURCE_TYPE_CLASSIFY: false,
  EVIDENCE_QUOTE_OVERLAP_MATCH: false,
};

/** Pure: effective boolean value of a flag given its compiled default, using the
 *  same env-parsing convention as the per-flag helpers above. */
function effectiveFlag(name: string, dflt: boolean): boolean {
  return dflt ? envOnDefaultTrue(name) : envOnDefaultFalse(name);
}

/**
 * Snapshot of scoring-fix flags for the CSV/run header. Intentionally NOT part of
 * the hashed run-manifest body (adding fields there would break the manifest-hash
 * stability test RP01) — it reflects the environment of the EXPORTING process,
 * which for a replay export is normally the same deployment that produced the run.
 * Returns a stable comma-separated list (sorted) or "" when none apply.
 *
 * CHANGE 2c: when RUN_HEADER_FULL_FLAG_SNAPSHOT is ON, every boolean flag whose
 * EFFECTIVE value differs from its compiled default is emitted dynamically from
 * BOOLEAN_FLAG_DEFAULTS (so a newly-added flag is covered automatically and a
 * default-ON flag turned OFF is visible too). When OFF, the legacy fixed list of
 * default-OFF flags turned ON is returned byte-for-byte as before.
 */
export function snapshotNonDefaultScoringFixFlags(): string {
  if (runHeaderFullFlagSnapshotEnabled()) {
    const out: string[] = [];
    for (const [name, dflt] of Object.entries(BOOLEAN_FLAG_DEFAULTS)) {
      const eff = effectiveFlag(name, dflt);
      if (eff !== dflt) out.push(`${name}=${eff ? "on" : "off"}`);
    }
    return out.sort().join(",");
  }
  const names = [
    "FRAMEWORK_LINEAGE_FREEZE",
    "VERDICT_CACHE_DURABLE",
    "ATTRIBUTION_MANUAL_DOMAINS_AT_GATE",
    "CSV_RUN_MANIFEST_EXPORT",
    "PINNED_DOCUMENTS_ENABLED",
    "SCORING_VOTE_EXPORT",
    "SCORING_TIEBREAK_RETRY",
    "SCORE_ONLY_REPLAY",
    "SCORE_ONLY_REPLAY_COLD_START_DISCOVERS",
    "FRAMEWORK_SCOPE_CONFIG_ENRICH",
  ];
  const on: string[] = [];
  for (const n of names) {
    const v = (process.env[n] || "").toLowerCase();
    if (v === "1" || v === "true" || v === "on" || v === "yes") {
      on.push(`${n}=on`);
    }
  }
  return on.sort().join(",");
}

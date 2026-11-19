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

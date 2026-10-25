import * as storage from "../storage.js";
import { completeWithFallback, completeScoring, getProvider, getIndependentTieBreakerProvider } from "./ai-providers.js";
import { ProviderScoringError } from "./credit-breaker.js";
import { classifyProviderError, type ProviderFailureClass } from "./provider-resilience.js";
import { assertDispatchAllowed, isLifecycleCancelledError } from "./lifecycle-fence.js";
import { buildEvidencePacksForCategory, buildEvidencePackForMeasure, computePreferredAnnualUrl, chunkDocuments, tokenize, buildBM25Index, bm25Score, deriveTopicTerms, computeCorpusTopicStats, applyChunkSanityGate, setShortTokenAllowlist, type EvidencePack, type Chunk, type ChunkSanityResult } from "./passage-retrieval.js";
import type { IssuerProfile } from "./issuer-profile.js";
// A6 / WP07 (framework-contract governance). Wired at the end of
// analyzeCompanyMeasures: attaches a verdict-invariant governance pass to the
// result. At the shipped default (FRAMEWORK_CONTRACT_POLICY=shadow) this is a
// pure passthrough — publishedScoresMutated is always false by construction, so
// no published score is ever changed.
import { runContractGovernance, resolveFrameworkContractPolicy, type GovernanceResult } from "./framework-contract.js";
// Approach 3: assembly-time boilerplate removal (generic, deterministic, no budget change).
import { stripRepeatedStructuralBlocks, computeAssemblyPenaltyFactors, containsQuantifiedFigure } from "./corpus-boilerplate.js";
// Approach 4: semantic candidate generation (embed + cosine rerank) at corpus assembly.
import { isSemanticHybridEnabled, isEmbeddingConfigured, embedTextsCached, cosineSim, hybridRankScores } from "./corpus-semantic.js";
// PR 1 · Change 4: auto re-retrieval on Low-confidence cells (behind autoReretrieval flag).
import { runTargetedReretrieval, type RetrievalReviewQueue, type ReretrievalResult } from "./retrieval-review-queue.js";
import type { Company, TrustedSource } from "../../shared/schema.js";
import { normalizeVerdict, normalizedScore } from "../../shared/verdict.js";
import { discoverCompanyTerminology, flattenTerms, type TerminologyMap } from "./terminology-discovery.js";
import { deriveTopicLexicon } from "./topic-lexicon.js";
import { generateDocumentHash, generateContentStableHash, type ExtractionCompleteness } from "./processor.js";
import {
  cacheRetrievalIndex,
  cacheEligibilityDecision,
  cacheEvidencePack,
  cacheMeasureScore,
  sha256Hex,
} from "./pipeline-cache.js";
import { translateDocumentsToEnglish } from "./translation.js";
import { corpusSourceTypes } from "./discovery.js";
import { isCorpusHygieneEnabled, applyCorpusHygiene, type HygieneDoc } from "./corpus-hygiene.js";
import { composeAntiInferenceRules } from "./anti-inference.js";
import { applyProvenanceGate, isScoringTimeGateEnabled } from "./provenance-gate.js";
import { describeDowngrade, type DowngradeDecision } from "./framework-v2/scoring-contract.js";
import { buildCanonicalRuleTrace, buildCanonicalRule, type CanonicalRuleTrace } from "./framework-v2/reliability/canonical-rule.js";
import { PASSAGE_LEVEL_EQUIVALENCE_CLAUSE } from "./framework-v2/structured-guidance.js";
import { computeEligibilityFlags, isPositiveVerdict, type EligibilityFlag } from "./eligibility-flags.js";
// A3 / WP04: end-to-end entity/provenance/temporal eligibility composition guardrail.
// Attached per measure in SHADOW mode by default (observability only); verdict-
// mutating enforcement is gated behind ELIGIBILITY_ENFORCE (see runProvenanceGate).
import {
  composeCellEligibility,
  composeEligibilityDecision,
  type EligibilityDecision,
  type EligibilityStatus,
} from "./eligibility-decision.js";
// A5 / WP04 (WP06): bounded, A3-composing, append-only evidence-pack recall
// expansion. Kill-switch RECALL_EXPANSION_POLICY DEFAULTS to "on" post-GATE5
// (standing production behaviour); set =off to restore the byte-identical pre-A5
// pack, or =shadow for telemetry-only. See server/lib/evidence-recall.ts.
import {
  resolveRecallExpansionPolicy,
  computeDecisivePassages,
  measurePackRecall,
  planBoundedExpansion,
  formatExpansionAppend,
  stablePassageId,
} from "./evidence-recall.js";
// B5 / WP13-C: model-cost context-trim. Kill-switch CONTEXT_COST_POLICY
// DEFAULTS to "shadow" (Issue-4 fix) — at the default this block DROPS NOTHING;
// it only logs what it WOULD trim. =on trims ONLY genuine >=90% near-duplicates
// of an already-kept passage (never a decisive or unique passage). =off SKIPS the
// block entirely, restoring the byte-identical pre-B5 pack with no redeploy
// (rollback path). See server/lib/model-cost.ts.
import {
  resolveContextCostPolicy,
  applyContextTrimPolicy,
  stablePrefixOrder,
  routeModel,
  type PromptSegment,
} from "./model-cost.js";
import type { IrTenantBinding } from "./provenance.js";
import { gateEvidence, gateEvidenceWithRepair, parsePackSegments, type EvidenceGateResult, type DocumentSegment } from "./evidence-gate.js";
import { detectRationaleScoreInconsistency } from "./rationale-consistency.js";
import { extractGuidanceObject, stripStructuredGuidanceBlock } from "./framework-guidance-audit.js";
import { createHash } from "crypto";
import { jsonrepair } from "jsonrepair";
import type { Framework, FrameworkMeasure } from "../../shared/schema.js";

// ─── Methodology Stamping ───────────────────────────────────────────────────
// Computed once at module load; changes only when the scoring prompt template
// or pipeline code changes (i.e. on deploy).
const PIPELINE_VERSION = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || "dev";

// Hash the scoring prompt TEMPLATE (the static parts, not per-company evidence).
// This changes when prompt logic changes, enabling drift detection.
const BINARY_PROMPT_HASH = createHash("sha256")
  .update("binary-v1:" + buildBinaryScoringPrompt.toString().slice(0, 500))
  .digest("hex")
  .slice(0, 16);
const PARTIAL_PROMPT_HASH = createHash("sha256")
  .update("partial-v1:" + buildPartialScoringPrompt.toString().slice(0, 500))
  .digest("hex")
  .slice(0, 16);

export function getPromptHash(mode: string): string {
  return mode === "partial" ? PARTIAL_PROMPT_HASH : BINARY_PROMPT_HASH;
}
export function getPipelineVersion(): string {
  return PIPELINE_VERSION;
}

// I81: When CSRD/ESRS Non-Financial Statements are flattened by pdf-parse,
// the IRO summary tables lose column alignment. Row-level time-horizon
// indicators — typically drawn as filled circles or bullets ("•", "••",
// "•••") — end up on their own lines detached from the header row that
// defined "Short term / Medium term / Long term". Our PDF post-processor
// (table-horizon-normaliser.ts) inlines a "[horizon: ...]" annotation next to
// each such line, but for chunks that miss the annotation (older cached
// content, non-standard notations, or documents where the header is too
// distant), we also tell the scorer directly. This prevents the scorer
// from mistakenly concluding "no time horizons disclosed" when the source
// clearly has an ESRS-standard IRO table with horizon columns.
const CSRD_TABLE_NOTATION_NOTE = `CSRD/ESRS TABLE NOTATION:
European CSRD/ESRS Non-Financial Statements often present impacts, risks and
opportunities (IROs) in tables with three time-horizon columns: Short term,
Medium term, Long term. In flattened PDF text, these columns are drawn as
filled circles or bullets (e.g. "•", "••", "•••", or "●●○") on their own
lines next to each risk description. Treat these bullet-only lines as
legitimate horizon indicators when a table header referencing Short/Medium/
Long term is present nearby (may be many lines away). A "•••" or "●●●" run
next to a risk description means all three horizons (short, medium and long
term) are marked for that row. Do not require explicit written "short-term"
/ "medium-term" / "long-term" wording on each row if the standard column-
marker notation is present.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MeasureResult {
  measureId: string;
  title: string;
  definition: string | null;
  category: string;
  categoryNumber: number;
  score: number;
  coverage: string | null;
  confidence: string;
  evidenceSummary: string;
  quotes: Array<{ text: string; source: string; sourceUrl?: string; page?: number }>;
  verdict: "Yes" | "No" | "Partial" | "Insufficient evidence" | "Scoring error";
  verdictNuance: string | null;
  displayOrder: number;
  // v3e (Section 3): true when the measure was abstained because a required
  // source type was absent from the corpus (excluded from the denominator).
  abstained?: boolean;
  // v3e (Section 4): SHA1 of the sorted evidence-chunk ids used for this verdict.
  evidenceFingerprint?: string | null;
  // v3j (Bug 2): force-include provenance, used for the run-level invariant that
  // every filing-bound measure whose required document is present in corpus must
  // have had at least one genuine body chunk force-included. Transient (not
  // persisted to measure_scores).
  forceIncludedCount?: number;
  requiredDocPresent?: boolean;
  forceIncludedDocUrl?: string;
  // I51-B: passage-retrieval telemetry, propagated from EvidencePack for offline analysis
  // of the retrieval→scoring bridge. Diagnostic-only; not consumed by scoring.
  passageDiagnostics?: {
    topChunks: Array<{ docUrl: string | null; docTitle: string | null; seqInDoc: number | null; score: number; textPreview: string; forced: boolean }>;
    docBreakdown: Array<{ docUrl: string | null; chunkCount: number }>;
    queryTermCount: number;
  };
  // Task A: compact outcome of the deterministic evidence-integrity gate applied
  // to the winning model's output for this measure. Persisted with the per-cell
  // result (see pipeline.ts). Present only when the gate ran (RETRIEVAL_EVIDENCE_GATE).
  gateResult?: {
    quotesTotal: number;
    quotesValid: number;
    downgraded: boolean;
    failures: EvidenceGateResult["failures"];
    // Option C (search-and-repair) audit — present only when the repair path ran
    // (RETRIEVAL_EVIDENCE_REPAIR) and performed a relabel / corpus re-search.
    repairs?: EvidenceGateResult["repairs"];
    researched?: EvidenceGateResult["researched"];
  };
  // Change C: in-completion bidirectional self-check emitted by the model within
  // the SAME scoring completion (no extra live LLM call). "Yes" = the model
  // affirms its rationale/evidenceSummary supports the emitted numeric score.
  rationaleConsistencyCheck?: "Yes" | "No" | null;
  consistencyNote?: string | null;
  // Change D: deterministic, generic, bidirectional post-hoc consistency flags.
  // Set when the rationale and the emitted score/verdict disagree. These NEVER
  // alter the score/verdict — they route the cell to DESIGN-TIME re-adjudication.
  rationaleScoreInconsistent?: boolean;
  inconsistencyReason?: string | null;
  needsReadjudication?: boolean;
  // Change #4 (single scoring contract): explicit, NAMED record of any
  // confidence-downgrade that converted a proposed positive verdict to Partial.
  // Surfaced in cell output so the conversion is reported, never silent. When a
  // rationale meets the Yes bar and no named rule fired, `applied` is false and
  // the verdict stands as Yes. See scoring-contract.ts.
  downgradeDecision?: DowngradeDecision | null;
  // Change #3 (advisory eligibility flags): the five non-blocking, dismissible
  // evidence-integrity flags computed for a positive cell. ADVISORY ONLY — these
  // never change the verdict/score and never block a run or save. See
  // eligibility-flags.ts.
  eligibilityFlags?: EligibilityFlag[] | null;
  // WS4 (canonical decision rule): the identity, version, source field and clauses
  // of the canonical rule that governed THIS decision. Populated on every scored
  // measure so the authoritative Yes-bar is auditable on the live scoring path.
  // Back-compat optional field; never changes verdict/score.
  canonicalRuleTrace?: CanonicalRuleTrace | null;
  // A3 / WP04: the single IMMUTABLE eligibility decision composed for THIS
  // (measure's winning source, target) pair. Carries entity-relation, source
  // class, temporal/scope status and the monotonic-exclusion audit end to end.
  // Attached in SHADOW mode (observability only) by default; it only alters the
  // verdict when ELIGIBILITY_ENFORCE=on. Back-compat optional field.
  eligibilityDecision?: EligibilityDecision | null;
  // A3 / WP04 (full-quote-set redesign): one eligibility decision per supporting
  // quote (A3's basis now EQUALS the verdict's basis), plus the composed
  // cell-level status over the whole set. Observability / GATE3 label-set fields;
  // never change the verdict unless ELIGIBILITY_ENFORCE=on. Back-compat optional.
  eligibilityDecisions?: EligibilityDecision[] | null;
  eligibilityCellStatus?: EligibilityStatus | null;
}

export interface AnalysisResult {
  totalScore: number;
  scorePercentage: number;
  summary: string;
  // v3e (Section 3): answered-measures accounting. answeredCount excludes
  // abstained measures; scorePercentage uses answeredCount as the denominator.
  answeredCount: number;
  abstainedCount: number;
  measuresTotal: number;
  categories: Array<{
    category: string;
    categoryNumber: number;
    measures: MeasureResult[];
  }>;
  // v3j (Bug 2): run-level force-include invariant result. ok=false means at
  // least one filing-bound measure whose required document was present in the
  // corpus failed to receive any genuine forced body chunk — a real regression
  // the portfolio run should gate on.
  forceIncludeInvariant?: {
    ok: boolean;
    checked: number;
    violations: Array<{ measureId: string; reason: string }>;
  };
  // I45: Scoring diagnostics for fleet-score regression investigation.
  // Exposes per-run counts of evidence passages, model responses, timeouts,
  // fallback/default-score usage, and scoring failures by framework and measure.
  scoringDiagnostics?: {
    totalMeasures: number;
    scoredMeasures: number;
    scoringFailures: number;
    timeouts: number;
    fallbackUsed: number;
    defaultScoreUsed: number;
    evidencePackCounts: { total: number; empty: number; lowTopic: number };
    modelResponseValidity: { valid: number; repaired: number; failed: number };
    selfConsistencyPasses: number;
  };
  // R4 (2026-09): LOUD empty-corpus signal, surfaced as a queryable
  // end-of-pipeline field. isEmpty=true means EVERY evidence pack across ALL
  // measures came back as an empty-corpus sentinel (0 usable chunks) — an
  // OPERATIONAL "insufficient evidence" state, distinct from the substantive
  // "topic absent in a non-empty corpus" case (which leaves this undefined /
  // isEmpty=false). This is the auto-rerun trigger consumed by pipeline.ts.
  // Absent when the LOUD_EMPTY_CORPUS flag is off.
  emptyCorpus?: {
    isEmpty: boolean;
    reason: string;
    measuresChecked: number;
  };
  // A6 / WP07: framework-contract governance pass. Verdict-invariant metadata
  // only — at the default `shadow` policy this is a pure passthrough and
  // `publishedScoresMutated` is always false (no published score is changed).
  // Absent only if the governance pass could not be computed.
  governance?: GovernanceResult;
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface AnalysisSettings {
  ensembleScoring: boolean;
  ensembleIterations: number;
  pipelineLlm1: string;
  pipelineLlm2: string;
  pipelineLlm3: string;
  scoringProvider: string;
  useBm25Retrieval: boolean;
  bm25SkipSummarizationBelowChars: number;
  terminologyDiscoveryEnabled: boolean;
  twoPromptExtractionEnabled: boolean;
  crossVerifyEnabled: boolean;
  scoringMode: string;
  lowConfidenceHandling: string; // "keep" | "downgrade" | "flag"
  // v3e (Section 4): verdict cache is OPT-IN BY DEFAULT (ON). Set
  // verdict_cache_enabled="false" to force fresh scoring for variability studies.
  verdictCacheEnabled: boolean;
  // I80: Cross-architecture cascade (DeepSeek → GLM → Claude arbiter)
  scoringCascade: boolean;
  cascadePrimary: string;
  cascadeSecondary: string;
  cascadeArbiter: string;
  // Cascade resilience (I81): per-stage model fallback + a per-stage timeout.
  // If a stage's provider throws OR exceeds cascadeStageTimeoutMs, the cascade
  // retries that ONE stage on a same-model/independent-network-path provider so a
  // single provider outage or hang can never freeze a measure to the 2100s
  // pipeline timeout again. Same-model fallbacks ⇒ no accuracy/architecture change.
  // All three are env-reversible + workspace-overridable; empty string disables a
  // given fallback (stage then fails-loud as before, still bounded by the timeout).
  cascadePrimaryFallback: string;
  cascadeSecondaryFallback: string;
  // Arbiter resilience: the disagreement arbiter (default gpt5-arbiter = GPT-5-mini
  // via OpenRouter) previously ran with NO fallback — an arbiter outage/hang froze
  // the measure to the pipeline timeout. It now self-heals onto this provider on a
  // throw OR a >cascadeStageTimeoutMs hang, exactly like primary/secondary. Default
  // "openrouter" (DeepSeek-V3.1 via OpenRouter) so every cascade stage has an
  // OpenRouter failure route. Env-reversible (CASCADE_ARBITER_FALLBACK) and
  // workspace-overridable (cascade_arbiter_fallback); ""/"none"/"off" disables it.
  // Point it at a non-OpenRouter provider (e.g. mistral-arbiter) for coverage of a
  // total OpenRouter outage, since the arbiter's own primary route is via OpenRouter.
  cascadeArbiterFallback: string;
  cascadeStageTimeoutMs: number;
  // PR 1 · Change 1a: gates the retrieval-hardening pass (latest-primary-disclosure
  // verification + targeted follow-up queries in pipeline.ts). Default OFF so
  // iteration-8 behaviour is preserved until we opt individual workspaces in.
  retrievalV2: boolean;
  // PR 1 · Change 4: gates the per-measure auto re-retrieval that fires a
  // targeted `searchCompanyDocuments` query for Low-confidence cells and
  // re-scores on the augmented corpus. Default OFF — inert unless the caller
  // also passes a reviewQueue AND retrievalV2 is on.
  autoReretrieval: boolean;
  // Cascade v2 — DEFAULT ON (env-reversible via CASCADE_V2=0). When on, the
  // arbiter defaults to gpt5-arbiter (OpenAI GPT-5 via OpenRouter) instead of
  // claude-arbiter AND the post-cascade auto-downgrade rule is suppressed while
  // cascade is active. Iteration 8 audit showed (a) Claude deferred 92% to
  // DeepSeek producing no independent tiebreaking value, and (b) the
  // auto-downgrade rule pushed 37% of cells to Low confidence post-cascade,
  // double-counting the diversity signal the cascade already provides. Setting
  // CASCADE_V2=0 (or workspace cascade_v2="false") reverts to claude-arbiter and
  // re-enables the auto-downgrade. Inert when scoringCascade=false.
  cascadeV2: boolean;
}

async function loadAnalysisSettings(workspaceId?: number): Promise<AnalysisSettings> {
  const settings = await storage.getSettings(workspaceId || 1);
  // Cascade v2 default-on resolution (single source of truth, env-reversible).
  // Used for both the cascadeV2 field and the default arbiter selection below.
  // Precedence: workspace force-off ("false") → off; workspace force-on
  // ("true") → on; otherwise env CASCADE_V2 (default "1"; set "0" to revert to
  // claude-arbiter + re-enable the post-cascade auto-downgrade). No topic- or
  // company-specific logic — a single global default.
  const cascadeV2On = settings.cascade_v2 === "false"
    ? false
    : (settings.cascade_v2 === "true" ? true : ((process.env.CASCADE_V2 ?? "1") !== "0"));
  // Group F: retrieval-hardening, auto re-retrieval and verdict cache are now
  // DEFAULT ON (env-reversible), mirroring the cascadeV2On resolution above.
  // Precedence: workspace force-off ("false") → off; workspace force-on ("true")
  // → on; otherwise the env var (default "1"; set "0" to revert).
  const retrievalV2On = settings.retrieval_v2 === "false"
    ? false
    : (settings.retrieval_v2 === "true" ? true : ((process.env.RETRIEVAL_V2 ?? "1") !== "0"));
  const autoReretrievalOn = settings.auto_reretrieval === "false"
    ? false
    : (settings.auto_reretrieval === "true" ? true : ((process.env.AUTO_RERETRIEVAL ?? "1") !== "0"));
  const verdictCacheEnabledOn = settings.verdict_cache_enabled === "false"
    ? false
    : (settings.verdict_cache_enabled === "true" ? true : ((process.env.VERDICT_CACHE_ENABLED ?? "1") !== "0"));
  return {
    ensembleScoring: settings.ensemble_scoring === "true",
    ensembleIterations: parseInt(settings.ensemble_iterations || "3"),
    pipelineLlm1: settings.pipeline_llm_1 || "deepseek",
    pipelineLlm2: settings.pipeline_llm_2 || "claude",
    pipelineLlm3: settings.pipeline_llm_3 || "openrouter", // V3.1 (independent route); replaces gemini which rate-limits under batch load
    scoringProvider: settings.scoring_provider || "deepseek",
    useBm25Retrieval: settings.use_bm25_retrieval !== "false",
    bm25SkipSummarizationBelowChars: parseInt(settings.bm25_skip_summarization_below_chars || "600000"),
    terminologyDiscoveryEnabled: settings.terminology_discovery_enabled !== "false",
    twoPromptExtractionEnabled: settings.two_prompt_extraction_enabled === "true",
    crossVerifyEnabled: settings.cross_verify_enabled === "true",
    scoringMode: settings.scoring_mode || "binary",
    lowConfidenceHandling: settings.low_confidence_handling || "downgrade",
    // DEFAULT ON (framework-agnostic): the cross-architecture cascade (two
    // primary LLMs + a third arbiter only on disagreement) is now the default
    // scoring path for every workspace, topic and company. Precedence:
    //   - workspace force-off: scoring_cascade="false"  → disabled
    //   - global kill-switch:  SCORING_CASCADE=0        → disabled
    //   - workspace force-on:  scoring_cascade="true"   → enabled
    //   - otherwise                                      → enabled (default)
    // There is NO topic- or company-specific logic here; this is a single
    // global default toggled purely by env + per-workspace settings.
    scoringCascade: settings.scoring_cascade === "false"
      ? false
      : ((process.env.SCORING_CASCADE ?? "1") !== "0" || settings.scoring_cascade === "true"),
    cascadePrimary: settings.cascade_primary || "deepseek",
    // Cascade secondary defaults to glm-4.6-zai (z.ai NATIVE API) rather than the
    // OpenRouter-routed "glm-4.6" provider. When 6cbc2cd made the cascade the
    // global default scoring path, the OpenRouter glm-4.6 route became the hot
    // path for every workspace — and it truncates (finish_reason=length) and
    // retries 4×/call (p50 ~60s, up to 207s), so with both cascade stages awaited
    // together every measure stalled until the 2100s pipeline timeout (0 batch
    // completions). The z.ai native provider (GLM_THINKING=disabled) returns clean
    // JSON at p50 ~5s with 0 truncations, restoring the two-LLM + arbiter cascade
    // instead of disabling it. Env-reversible (CASCADE_SECONDARY=glm-4.6 restores
    // the OpenRouter route) and workspace-overridable (cascade_secondary setting).
    // No topic- or company-specific logic — a single global default.
    cascadeSecondary: settings.cascade_secondary || process.env.CASCADE_SECONDARY || "glm-4.6-zai",
    // Cascade resilience (I81) — per-stage model fallback. Defaults are SAME-MODEL,
    // independent-network-path siblings of the hot-path providers, so a fallback
    // never changes the scoring architecture or accuracy, only the route:
    //   - primary   deepseek      (direct api.deepseek.com) → "openrouter"
    //                                            (DeepSeek V3.1 via OpenRouter)
    //   - secondary glm-4.6-zai   (z.ai native)             → "glm-4.6"
    //                                            (GLM-4.6 via OpenRouter)
    // Env-reversible (CASCADE_PRIMARY_FALLBACK / CASCADE_SECONDARY_FALLBACK) and
    // workspace-overridable (cascade_primary_fallback / cascade_secondary_fallback).
    // Set to "" (or "none"/"off") to disable a fallback — the stage then fails-loud
    // as it did pre-I81, still bounded by the per-stage timeout below.
    // No topic- or company-specific logic — a single global default.
    cascadePrimaryFallback: settings.cascade_primary_fallback ?? process.env.CASCADE_PRIMARY_FALLBACK ?? "openrouter",
    cascadeSecondaryFallback: settings.cascade_secondary_fallback ?? process.env.CASCADE_SECONDARY_FALLBACK ?? "glm-4.6",
    // Arbiter fallback (see interface note). Default "openrouter" so the arbiter
    // stage — previously fallback-less — gets the same OpenRouter failure route as
    // primary/secondary. ""/"none"/"off" restores the pre-change fail-loud arbiter.
    cascadeArbiterFallback: settings.cascade_arbiter_fallback ?? process.env.CASCADE_ARBITER_FALLBACK ?? "openrouter",
    // Per-stage wall-clock cap (ms). A stage that exceeds it is treated as failed
    // and falls back (the 2100s freeze was caused by hangs, which a throw-only
    // fallback would miss). Default 180s ≈ 36× the p50 (~5s) so it never false-
    // triggers on a healthy call, but bounds a hung provider to 180s not 2100s.
    // Env-tunable via CASCADE_STAGE_TIMEOUT_MS; 0 disables the timeout.
    cascadeStageTimeoutMs: Math.max(0, parseInt(process.env.CASCADE_STAGE_TIMEOUT_MS || "180000", 10) || 0),
    // Cascade v2 is now ON by default (env-reversible), so the arbiter defaults
    // to gpt5-arbiter (OpenAI GPT-5 via OpenRouter) and the post-cascade
    // auto-downgrade is suppressed. Precedence for cascade_v2 (see cascadeV2
    // below): cascade_v2="false" → off; cascade_v2="true" → on; else env
    // CASCADE_V2 (default "1", set "0" to revert to claude-arbiter + downgrade).
    // An explicit cascade_arbiter override always wins. mistral-arbiter remains
    // selectable via an explicit cascade_arbiter override.
    cascadeArbiter: settings.cascade_arbiter
      || (cascadeV2On ? "gpt5-arbiter" : "claude-arbiter"),
    // PR 1 · Change 1a / Group F: default ON (env-reversible via RETRIEVAL_V2=0).
    // Force-off with workspace_settings.retrieval_v2="false"; force-on with "true".
    retrievalV2: retrievalV2On,
    // PR 1 · Change 4 / Group F: default ON (env-reversible via AUTO_RERETRIEVAL=0).
    // Force-off with workspace_settings.auto_reretrieval="false"; force-on with "true".
    // Requires retrievalV2 AND a reviewQueue plumbed from pipeline.ts to have any effect.
    autoReretrieval: autoReretrievalOn,
    cascadeV2: cascadeV2On,
    // v3g (Bug 1 §3 action 5) / Group F: verdict cache is now DEFAULT ON
    // (env-reversible via VERDICT_CACHE_ENABLED=0). Force-off with
    // workspace_settings.verdict_cache_enabled="false"; force-on with "true".
    // Content-stable fingerprints gate reuse, so cross-company verdict reuse is
    // prevented while re-runs reuse identical-evidence verdicts for reproducibility.
    verdictCacheEnabled: verdictCacheEnabledOn,
  };
}

// ─── Prompt Builders ─────────────────────────────────────────────────────────

// Sprint 10 P2 helper: build the v2 guidance block shared by binary + partial prompts.
// Returns { guidanceBlock, quoteContextInstr }. Both empty for v1 measures (all v2
// fields null), which makes v1 behaviour byte-identical to pre-P2.
// Exported for regression testing of the canonical-rule governance of the prompt
// (SCORING_CANONICAL_RULE_GOVERNS). Pure function: no DB / LLM / network access.
export function buildV2GuidanceBlock(measure: FrameworkMeasure, framework: Framework | undefined, topicDescription: string): { guidanceBlock: string; quoteContextInstr: string } {
  const m: any = measure;
  const fw: any = framework;
  let v2Block = "";

  // C10: framework-level topic anchoring — synonyms
  if (Array.isArray(fw?.topicSynonyms) && fw.topicSynonyms.length > 0) {
    v2Block += `\n\nTOPIC TERM AND SYNONYMS:\nCanonical: "${fw.topicTerm || topicDescription}"\nSynonyms (treat as equivalent for scoring): ${fw.topicSynonyms.map((s: string) => `"${s}"`).join(", ")}`;
  }

  // C5: adjacent-topic exclusion drawn from intake
  const adjacent = Array.isArray(fw?.adjacentTopics) ? fw.adjacentTopics : [];
  if (adjacent.length > 0) {
    const lines = adjacent.map((a: any) => {
      const phrases = Array.isArray(a?.example_phrases) && a.example_phrases.length > 0
        ? ` (example phrases: ${a.example_phrases.map((p: string) => `"${p}"`).join(", ")})`
        : "";
      return `- ${a.name}${phrases}`;
    }).join("\n");
    v2Block += `\n\nADJACENT-TOPIC EXCLUSION (C5): Evidence attributed to any of the following ADJACENT topics does NOT satisfy this measure, even if language overlaps:\n${lines}\n\nBefore scoring Yes, verify the evidence attributes the disclosed position specifically to the framework's topic, not to an adjacent topic listed above.`;
  }

  // C1: per-measure achievement-implies-commitment guidance
  if (m.c1AchievementGuidance && typeof m.c1AchievementGuidance === "object") {
    const g = m.c1AchievementGuidance;
    const yesCases = Array.isArray(g.yes_cases) ? g.yes_cases : [];
    const noCases = Array.isArray(g.no_cases) ? g.no_cases : [];
    if (yesCases.length > 0 || noCases.length > 0) {
      v2Block += `\n\nACHIEVEMENT-CLAIMS GUIDANCE (C1):`;
      if (g.distinguishing_test) v2Block += `\nDistinguishing test: ${g.distinguishing_test}`;
      if (yesCases.length > 0) {
        v2Block += `\nACHIEVEMENT CLAIMS THAT COUNT AS EVIDENCE OF A POSITION (Yes cases):\n${yesCases.map((c: string) => `- ${c}`).join("\n")}`;
      }
      if (noCases.length > 0) {
        v2Block += `\nFACTUAL OUTCOMES WITHOUT TARGET-STATE LANGUAGE (do NOT count):\n${noCases.map((c: string) => `- ${c}`).join("\n")}`;
      }
    }
  }

  // C5/C8: substantive_definition as authoritative semantic anchor
  if (typeof m.substantiveDefinition === "string" && m.substantiveDefinition.trim().length > 0) {
    v2Block += `\n\nSUBSTANTIVE DEFINITION (authoritative — vocabulary variants that substantively match this definition satisfy the measure):\n${m.substantiveDefinition}`;
  }

  // C6: negative_examples as adversarial anchors
  if (Array.isArray(m.negativeExamples) && m.negativeExamples.length > 0) {
    v2Block += `\n\nADVERSARIAL NEGATIVE EXAMPLES (SUPERFICIALLY plausible but SHOULD NOT score Yes):\n${m.negativeExamples.map((e: string) => `- ${e}`).join("\n")}`;
  }

  // C6: positive_examples via top-level column (fallback if scoringGuidance JSON didn't include them)
  // Q3 move 3: fence positive examples as ILLUSTRATIVE-ONLY. These strings are the ones that get
  // echoed back verbatim as fabricated quotes (the anti-echo gate exists because of this), so they
  // are explicitly marked never-quotable. Evidence quotes must come from the retrieved pack only.
  if (Array.isArray(m.positiveExamples) && m.positiveExamples.length > 0) {
    v2Block += `\n\nILLUSTRATIVE POSITIVE PATTERNS (for calibration ONLY — these are NOT source evidence; NEVER quote, paraphrase, or cite them as a company's disclosure. Any quote you return must be a verbatim span copied from the provided evidence pack):\n${m.positiveExamples.map((e: string) => `- ${e}`).join("\n")}`;
  }

  // C2: whatDoesNotConstituteEvidence via top-level column
  if (typeof m.whatDoesNotConstituteEvidence === "string" && m.whatDoesNotConstituteEvidence.trim().length > 0) {
    v2Block += `\n\nSUBSTANTIVE EXCLUSIONS (do NOT score Yes on these grounds):\n${m.whatDoesNotConstituteEvidence}`;
  }

  // C7: coverage whitelist for coverage measures
  if (m.r31ExceptionCoverage && Array.isArray(m.coverageWhitelist) && m.coverageWhitelist.length > 0) {
    v2Block += `\n\nCOVERAGE WHITELIST (these plain-language phrases SATISFY the coverage threshold; do not require a numerical %):\n${m.coverageWhitelist.map((p: string) => `- "${p}"`).join("\n")}`;
  }

  // C4: topic-anchored fallback
  if (typeof m.fallbackYesCriterion === "string" && m.fallbackYesCriterion.trim().length > 0) {
    // WS4: canonical rule governs the runtime prompt. When SCORING_CANONICAL_RULE_GOVERNS
    // is ON and this measure has a SUBSTANTIVE (or qualifying) canonical bar, the strict
    // fallbackYesCriterion must NOT reach the scorer as an independent, co-equal "ANY
    // numbered condition triggers Yes" instruction — that is precisely the contradictory-
    // rule mechanism the reviewer flagged (e.g. a substantive positive example rejected
    // for lacking a second attribution token). We demote it to clearly-subordinate context
    // that only applies when the substantive bar cannot be assessed. When the canonical bar
    // is itself fallback-derived (no substantive criterion exists), behaviour is unchanged.
    // Flag default OFF preserves current live behaviour until validated in prod.
    let fallbackGoverned = false;
    if (process.env.SCORING_CANONICAL_RULE_GOVERNS === "1" || process.env.SCORING_CANONICAL_RULE_GOVERNS === "true") {
      try {
        const canon = buildCanonicalRule(m);
        fallbackGoverned = canon.provenance === "substantive" || canon.provenance === "qualifying";
      } catch { /* fail-open to current behaviour */ }
    }
    if (fallbackGoverned) {
      v2Block += `\n\nFALLBACK CRITERION (SUBORDINATE — this measure has an authoritative substantive/qualifying bar above, which is the sole basis for a Yes. The text below is a LAST-RESORT tie-breaker ONLY when the substantive bar genuinely cannot be assessed from the evidence; it does NOT, on its own, trigger a Yes, and it must NEVER override or add requirements to the substantive bar):\n${m.fallbackYesCriterion}`;
    } else {
      v2Block += `\n\nFALLBACK YES CRITERION (if primary evidence is weak, fall back to this — ANY numbered condition below being satisfied triggers Yes):\n${m.fallbackYesCriterion}`;
    }
  }

  // Change A: GENERIC exclusion-precedence rule. Applies to EVERY measure of
  // EVERY framework (never gated on a measure/framework id). Resolves the class
  // of rubric conflict where the substantive definition / what-constitutes-
  // evidence WHITELISTS a qualifying instance while an exclusion could ALSO match
  // generic/aspirational language in the same evidence, and the rubric gives no
  // precedence. The anchor is per-measure content (the blocks assembled above);
  // this rule only tells the scorer HOW to reconcile them.
  v2Block += `\n\nPRECEDENCE (how to reconcile the guidance above): An exclusion disqualifies a Yes ONLY when its disqualifying condition holds AND no specific, named, on-topic qualifying instance (as defined by this measure's substantive definition / what-constitutes-evidence) is present in the evidence. A specific, named qualifying instance is NOT defeated by generic, aspirational, or general-policy language appearing elsewhere in the same evidence. Assess whether a qualifying instance exists FIRST; apply exclusions only to the residual.`;

  // ─── Rubric tightening (A1/A2/A3) — per-measure STRUCTURED guidance ─────────
  // GENERIC. The framework builder authors, per measure, a positive definition of
  // what counts (qualifyingInstance), the generic/aspirational mentions that do
  // NOT count (disqualifiers), exactly one canonical Yes + one canonical No worked
  // example (anchors), and (optionally) the Yes-requires-a-verbatim-quote rule
  // line (yesRequiresQuote). These live INSIDE this measure's scoring_guidance —
  // pure JSON, a ```json fence appended to prose, or a trailing {...} blob — so we
  // parse them the same tolerant way the audit does. Absent fields are simply
  // omitted, keeping prose-only / legacy measures byte-identical to before. NOTHING
  // here is framework/measure/company-specific; all content comes from the DB.
  const sgObj = extractGuidanceObject(m.scoringGuidance);
  const qualifyingInstance = sgObj && typeof sgObj.qualifyingInstance === "string" && sgObj.qualifyingInstance.trim().length > 0
    ? sgObj.qualifyingInstance.trim()
    : "";
  const disqualifiers = sgObj && Array.isArray(sgObj.disqualifiers)
    ? sgObj.disqualifiers.filter((d: any) => typeof d === "string" && d.trim().length > 0).map((d: string) => d.trim())
    : [];
  const anchorYes = sgObj && sgObj.anchors && typeof sgObj.anchors === "object" && typeof sgObj.anchors.yes === "string"
    ? sgObj.anchors.yes.trim()
    : "";
  const anchorNo = sgObj && sgObj.anchors && typeof sgObj.anchors === "object" && typeof sgObj.anchors.no === "string"
    ? sgObj.anchors.no.trim()
    : "";
  const authoredYesRule = sgObj && typeof sgObj.yesRequiresQuote === "string" && sgObj.yesRequiresQuote.trim().length > 0
    ? sgObj.yesRequiresQuote.trim()
    : "";

  if (qualifyingInstance) {
    v2Block += `\n\nQUALIFYING INSTANCE (what specifically counts as satisfying THIS measure — a Yes REQUIRES a concrete instance of this kind, evidenced in the corpus):\n${qualifyingInstance}`;
  }
  if (disqualifiers.length > 0) {
    v2Block += `\n\nDISQUALIFIERS (these do NOT satisfy the measure on their own — generic, aspirational, or forward-looking mentions; the topic named without a specific qualifying instance):\n${disqualifiers.map((d: string) => `- ${d}`).join("\n")}`;
  }
  // A3: render ONLY the canonical Yes and canonical No worked examples. Never a
  // Partial anchor. Fenced as illustrative-only so they cannot be echoed as quotes.
  if (anchorYes || anchorNo) {
    v2Block += `\n\nWORKED EXAMPLES (calibration anchors — ILLUSTRATIVE ONLY; NEVER quote, paraphrase, or cite these as a company's disclosure):`;
    if (anchorYes) v2Block += `\n- Canonical YES: ${anchorYes}`;
    if (anchorNo) v2Block += `\n- Canonical NO: ${anchorNo}`;
  }

  // A2: Yes-requires-a-verbatim-quote PRECONDITION. Rendered as prompt text only —
  // NO post-hoc override, NO extra LLM call. ALWAYS emitted (generic), so it binds
  // even on prose-only / legacy measures. Precedence for the qualifying basis
  // named in the precondition: authored qualifyingInstance → substantive
  // definition → a generic on-topic-instance clause.
  const yesQuoteBasis = qualifyingInstance
    || (typeof m.substantiveDefinition === "string" && m.substantiveDefinition.trim().length > 0 ? m.substantiveDefinition.trim() : "")
    || "a specific, named, on-topic instance that satisfies this measure";
  const yesRuleLine = authoredYesRule
    || `A "Yes" is permissible ONLY when at least one VERBATIM quote copied from the supplied evidence contains ${yesQuoteBasis}. If the evidence contains no such verbatim quote, you MUST NOT score Yes. Generic, aspirational, or forward-looking language — or the topic being named without a specific qualifying instance — does NOT meet this bar.`;
  v2Block += `\n\nYES REQUIRES A VERBATIM QUOTE (precondition — evaluate this BEFORE assigning any Yes):\n${yesRuleLine}`;

  // WS-A: runtime reinforcement of passage-level co-location + semantic/non-English
  // equivalence. ALWAYS emitted and fully GENERIC (topic-agnostic; no framework/
  // measure/topic literals) so it binds on every measure — including prose-only and
  // legacy measures whose stored definitions predate the builder-side authoring of
  // this clause. It relaxes multi-element Yes-bars from "all tokens in ONE verbatim
  // span, exact lexical match" to passage-level co-location with per-element verbatim
  // anchors and semantic matching, WITHOUT loosening to "anywhere in the document"
  // (the clause explicitly rejects cross-context evidence). This is additive prompt
  // text — no post-hoc override and no extra LLM call — so it does not disturb the
  // SCORING_CANONICAL_RULE_GOVERNS demotion semantics above.
  v2Block += `\n\n${PASSAGE_LEVEL_EQUIVALENCE_CLAUSE}`;

  // C3: quote-context requirement
  const minCtx = typeof m.minQuoteContextChars === "number" ? m.minQuoteContextChars : null;
  const quoteContextInstr = minCtx && minCtx >= 100
    ? `\n\nQUOTE CONTEXT REQUIREMENT (C3): For every quote you return, provide a verbatim excerpt of at least ${minCtx} characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context. Do not truncate at the topic term.`
    : "";

  return { guidanceBlock: v2Block, quoteContextInstr };
}

// U2: Base-rate prior injection. The framework author sets expected_yes_rate
// per measure (validated by C9). Injecting it as a scoring-prompt calibration
// line reduces systematic under-scoring on high-disclosure topics and over-
// scoring on sparse ones. Sprint 9 v3→v4 measured this at fw3 recall +0.029 /
// F1 +0.019 with zero marginal inference cost. Guarded because the prior
// nudges Yes upward — recall/correlation gains, some precision cost.
function buildBaseRatePriorBlock(measure: FrameworkMeasure): string {
  if (process.env.SCORING_BASE_RATE_PRIOR !== "true") return "";
  const rate = (measure as any).expectedYesRate;
  if (typeof rate !== "number" || rate <= 0 || rate >= 1) return "";
  const pct = Math.round(rate * 100);
  // Framing avoids telling the LLM to change its verdict. It tells the LLM
  // what the disclosure landscape looks like so "present evidence" and "absent
  // evidence" get the same standard of proof regardless of base rate.
  return `\n\nCALIBRATION — DISCLOSURE BASE RATE:
Across the universe of large-cap listed companies to which this framework applies, approximately ${pct}% would score Yes on this measure. This reflects current disclosure practice on the topic, not an aspiration. Use it to calibrate the evidentiary bar: apply the same evidentiary standard whether disclosure on this topic is common (higher base rate) or rare (lower). Do not default to No when concrete evidence is present just because you expect the answer to usually be No; do not lower the bar for evidence quality just because you expect the answer to usually be Yes.`;
}

// Change C: in-completion bidirectional self-check. Emitted INSIDE the same
// scoring completion — NO extra live LLM call. Framework/measure-agnostic.
const SELF_CHECK_INSTRUCTION = `SELF-CHECK BEFORE RETURNING (do this within this single response — do not make another call):
After deciding your score, verdict, and evidenceSummary, verify that your rationale and your numeric score agree in BOTH directions:
- An affirmative rationale (stating that the required thing exists / is disclosed / is in place) must NOT accompany a No/0 score.
- A negative or absent-evidence rationale (stating the required thing is missing / not disclosed / insufficient) must NOT accompany a Yes/1 score.
If they disagree, correct whichever is wrong so that the final score, verdict, and evidenceSummary you emit are mutually consistent.
Then set "rationaleConsistencyCheck" to "Yes" if (after any correction) they agree, or "No" if a residual disagreement remains, and give a one-line "consistencyNote".`;

// Topic-derived scoring-analyst persona. Pure, deterministic, topic/company-
// agnostic: the opening sentence of the scoring system prompt used to be a
// single hardcoded domain persona. It is now derived from the framework's OWN
// topic so the scorer frames itself as an expert in whatever the framework is
// actually about.
// Precedence:
//   1. framework.scoringPersona (builder-generated, polished) — returned verbatim.
//   2. else derive from framework.topicTerm || topicDescription || name:
//      "You are an expert <topic> analyst scoring corporate disclosures against
//       a structured assessment framework."
//   3. else (no topic info at all) a neutral generic persona (no topic literal).
// The derived topic is trimmed, internal whitespace collapsed, and capped so a
// pathological topic string can't blow up or distort the prompt.
const PERSONA_SUFFIX = "analyst scoring corporate disclosures against a structured assessment framework.";
const GENERIC_SCORING_PERSONA = `You are an expert ${PERSONA_SUFFIX}`;
const MAX_PERSONA_TOPIC_CHARS = 120;

export function buildScoringPersona(framework: Framework | undefined): string {
  const stored = typeof framework?.scoringPersona === "string" ? framework.scoringPersona.trim() : "";
  if (stored) return stored;

  const rawTopic =
    (typeof framework?.topicTerm === "string" && framework.topicTerm) ||
    (typeof framework?.topicDescription === "string" && framework.topicDescription) ||
    (typeof framework?.name === "string" && framework.name) ||
    "";
  const topic = rawTopic.replace(/\s+/g, " ").trim().slice(0, MAX_PERSONA_TOPIC_CHARS).trim();
  if (!topic) return GENERIC_SCORING_PERSONA;
  return `You are an expert ${topic} ${PERSONA_SUFFIX}`;
}

export function buildBinaryScoringPrompt(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  temporalWarning?: string | null;
  framework?: Framework;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework } = opts;

  let terminologyBlock = "";
  if (terminology && flattenTerms(terminology).length > 0) {
    terminologyBlock = `\nCOMPANY TERMINOLOGY NOTE:
This company uses the following specific terms for this topic. Treat these as equivalent to the framework's canonical terms when evaluating evidence:
- Committees: ${terminology.committees.join(", ") || "None identified"}
- Roles: ${terminology.roles.join(", ") || "None identified"}
- Programmes: ${terminology.programmes.join(", ") || "None identified"}
- Products/Policies: ${terminology.productsAndPolicies.join(", ") || "None identified"}
- Other terms: ${terminology.otherTerms.join(", ") || "None identified"}
Do not penalise evidence for using these terms instead of the framework's language.\n`;
  }

  const baseRateBlock = buildBaseRatePriorBlock(measure);

  const system = `${buildScoringPersona(framework)}

Topic: ${topicDescription}${baseRateBlock}

SCORING RULES (Binary Mode — Yes/No ONLY):
- Score 1 (Yes): The company provides clear, specific evidence that directly addresses this measure. At least one verbatim quote from the source documents must support the score.
- Score 0 (No): No evidence found, OR evidence is too vague/generic to confirm the specific requirement, OR some evidence exists but does not FULLY satisfy the measure. Anything short of a clear Yes is a No.
- There is NO "Partial" outcome. Do NOT return "Partial". Evidence that only partially satisfies the measure scores 0 (No).

CONFIDENCE LEVELS:
- High: Clear evidence found (for Yes) or thorough search with no evidence (for No)
- Medium: Evidence is ambiguous or indirect
- Low: Document corpus may be incomplete or in a language not fully analyzed

CRITICAL ANTI-INFERENCE RULES:
${composeAntiInferenceRules(measure.measureId, measure.title || "", (framework as any)?.antiInferenceRules, (framework as any)?.topicTerm)}

${CSRD_TABLE_NOTATION_NOTE}

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
CRITICAL: For the "source" field in quotes, you MUST use the EXACT document title as it appears in the "--- DOCUMENT: <title> [<url>] ---" headers in the evidence text. Use the title portion (before the [url]), not an invented or paraphrased name.
${terminologyBlock}`;

  let scoringGuidance = "";
  if (measure.scoringGuidance) {
    // Change B: scoring_guidance is stored as text — it may be structured JSON
    // (an object with yes/no/partial buckets) or PLAIN PROSE. Previously, plain
    // prose was mis-assigned to sg.yes, which dumped potentially No-triggering
    // prose under the "- Yes:" bullet. Now: parse to a usable object OR render the
    // prose verbatim under a NEUTRAL heading with no Yes/No/Partial bucketing.
    let sg: any = null;
    let plainProse: string | null = null;
    try {
      const parsed = typeof measure.scoringGuidance === "string"
        ? JSON.parse(measure.scoringGuidance)
        : measure.scoringGuidance;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        sg = parsed;
      } else {
        // Parsed to a bare string/number/array — not a usable guidance object.
        plainProse = String(measure.scoringGuidance);
      }
    } catch {
      // Not valid JSON → treat as plain prose (do NOT bucket under Yes).
      plainProse = typeof measure.scoringGuidance === "string"
        ? measure.scoringGuidance
        : String(measure.scoringGuidance);
    }
    if (plainProse !== null) {
      // Change B + rubric-tightening: prose may have an appended structured block
      // (a ```json fence or trailing {...}) carrying the qualifyingInstance /
      // disqualifiers / anchors / yesRequiresQuote. Those render via
      // buildV2GuidanceBlock — strip them here so raw JSON is not dumped into the
      // human-readable "Scoring guidance" prose. If only the block was present,
      // omit the prose heading entirely.
      const cleaned = stripStructuredGuidanceBlock(plainProse);
      if (cleaned.length > 0) {
        scoringGuidance = `\nScoring guidance:\n${cleaned}`;
      }
    }
    if (sg) {
    // BINARY SCORING: only Yes / No buckets are surfaced. Any "partial" guidance
    // bucket is folded into No (evidence that is merely partial does not meet the
    // measure).
    scoringGuidance = `\nScoring guidance:\n- Yes: ${sg.yes || "Clear evidence present"}\n- No: ${sg.no || "No evidence found"}${sg.partial ? `\n- Note (does NOT meet the measure — score No): ${sg.partial}` : ""}`;
    // Add explicit exclusions if present in the template
    if (sg.explicit_exclusions && Array.isArray(sg.explicit_exclusions) && sg.explicit_exclusions.length > 0) {
      scoringGuidance += `\n\nEXPLICIT EXCLUSIONS (do NOT score Yes if only this evidence exists):\n${sg.explicit_exclusions.map((e: string) => `- ${e}`).join("\n")}`;
    }
    // Add required evidence type if present
    if (sg.required_evidence_type) {
      scoringGuidance += `\n\nREQUIRED EVIDENCE TYPE: ${sg.required_evidence_type}`;
    }
    // Add temporal note if present
    if (sg.temporal_note) {
      scoringGuidance += `\n\nTEMPORAL NOTE: ${sg.temporal_note}`;
    }
    // I76: positive_examples give the scorer concrete calibration anchors of
    // what SHOULD score Yes / Partial. Empirical truth-baseline audit showed
    // scorer over-conservatism on qualitative measures where the guidance's
    // required_evidence_type was interpreted more strictly than the truth
    // rubric intended (e.g. rejecting "AI-driven cost savings" for 5.1a
    // because no number was disclosed, when the truth rubric accepts named-
    // but-unquantified metric references). Examples shift the calibration by
    // showing the scorer the shape of an acceptable positive rather than
    // relying on abstract policy language.
    if (sg.positive_examples && Array.isArray(sg.positive_examples) && sg.positive_examples.length > 0) {
      scoringGuidance += `\n\nILLUSTRATIVE POSITIVE PATTERNS (for calibration ONLY — NOT source evidence; NEVER quote, paraphrase, or cite these as a disclosure. Any quote returned must be a verbatim span from the provided evidence pack):\n${sg.positive_examples.map((e: string) => `- ${e}`).join("\n")}`;
    }
    // BINARY SCORING: former "partial" examples are disclosures that do NOT fully
    // meet the measure, so under binary scoring they are examples of a No.
    if (sg.partial_examples && Array.isArray(sg.partial_examples) && sg.partial_examples.length > 0) {
      scoringGuidance += `\n\nEXAMPLES THAT DO NOT MEET THE MEASURE (score No — evidence is only partial):\n${sg.partial_examples.map((e: string) => `- ${e}`).join("\n")}`;
    }
    }
  }

  // Sprint 10 P2: v2 field integration (framework-measure-level and framework-level)
  const { guidanceBlock: v2Block, quoteContextInstr } = buildV2GuidanceBlock(measure, framework, topicDescription);

  const temporalBlock = temporalWarning ? `\n${temporalWarning}\n` : "";

  const prompt = `Company: ${companyName}
${temporalBlock}
MEASURE TO EVALUATE:
Title: ${measure.title}
Definition: ${measure.definition || measure.title}
${scoringGuidance}${v2Block}${quoteContextInstr}

EVIDENCE TEXT:
${evidenceText || "[No relevant evidence found in the document corpus]"}

${SELF_CHECK_INSTRUCTION}

Evaluate this measure and return a JSON object with exactly these fields:
{
  "score": 0 or 1,
  "verdict": "Yes" | "No",
  "confidence": "High" | "Medium" | "Low",
  "evidenceSummary": "One paragraph explaining your assessment",
  "quotes": [{"text": "verbatim quote from evidence", "source": "exact document title from --- DOCUMENT: <title> [url] --- header"}],
  "verdictNuance": "optional caveats or notes" or null,
  "rationaleConsistencyCheck": "Yes" | "No",
  "consistencyNote": "one line: how you verified rationale and score agree"
}`;

  return { system, prompt };
}

// ─── Partial Scoring Prompt ─────────────────────────────────────────────────

export function buildPartialScoringPrompt(opts: {
  companyName: string;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  temporalWarning?: string | null;
  framework?: Framework;
}): { system: string; prompt: string } {
  const { companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework } = opts;

  let terminologyBlock = "";
  if (terminology) {
    terminologyBlock = `\nCOMPANY TERMINOLOGY NOTE:
This company uses the following specific terms for this topic. Treat these as equivalent to the framework's canonical terms when evaluating evidence:
- Committees: ${terminology.committees.join(", ") || "None identified"}
- Roles: ${terminology.roles.join(", ") || "None identified"}
- Programmes: ${terminology.programmes.join(", ") || "None identified"}
- Products/Policies: ${terminology.productsAndPolicies.join(", ") || "None identified"}
- Other terms: ${terminology.otherTerms.join(", ") || "None identified"}
Do not penalise evidence for using these terms instead of the framework's language.\n`;
  }

  const baseRateBlock = buildBaseRatePriorBlock(measure);

  const system = `${buildScoringPersona(framework)}

Topic: ${topicDescription}${baseRateBlock}

SCORING RULES (Binary Mode — Yes/No ONLY):
- Score 1 (Yes): The company provides clear, specific evidence that FULLY addresses this measure. At least one verbatim quote from the source documents must support the score.
- Score 0 (No): Anything short of a clear, full Yes. This includes: no evidence found; evidence too vague/generic; evidence that only PARTIALLY addresses the measure (incomplete, indirect, or not satisfying all aspects); evidence for some but not all components of a multi-part measure; a related initiative that implies but does not explicitly confirm the requirement; a policy or commitment lacking specificity, metrics, or implementation details; or outdated/superseded evidence with no current replacement.
- There is NO "Partial" outcome and NO 0.5 score. Do NOT return "Partial". Evidence that only partially satisfies the measure scores 0 (No).

CONFIDENCE LEVELS:
- High: Clear evidence found (for Yes) or thorough search with no evidence (for No)
- Medium: Evidence is ambiguous or indirect
- Low: Document corpus may be incomplete or in a language not fully analyzed

CRITICAL ANTI-INFERENCE RULES:
${composeAntiInferenceRules(measure.measureId, measure.title || "", (framework as any)?.antiInferenceRules, (framework as any)?.topicTerm)}

${CSRD_TABLE_NOTATION_NOTE}

CRITICAL: Every quote MUST be a verbatim excerpt from the provided evidence text. Do not paraphrase or fabricate quotes.
CRITICAL: For the "source" field in quotes, you MUST use the EXACT document title as it appears in the "--- DOCUMENT: <title> [<url>] ---" headers in the evidence text.
${terminologyBlock}`;

  let scoringGuidance = "";
  if (measure.scoringGuidance) {
    // Change B: parse to a usable guidance object OR render plain prose verbatim
    // under a NEUTRAL heading (never mis-bucketed under "- Yes"). Same logic as
    // the binary path.
    let sg: any = null;
    let plainProse: string | null = null;
    try {
      const parsed = typeof measure.scoringGuidance === "string"
        ? JSON.parse(measure.scoringGuidance)
        : measure.scoringGuidance;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        sg = parsed;
      } else {
        plainProse = String(measure.scoringGuidance);
      }
    } catch {
      plainProse = typeof measure.scoringGuidance === "string"
        ? measure.scoringGuidance
        : String(measure.scoringGuidance);
    }
    if (plainProse !== null) {
      // Change B + rubric-tightening: strip any appended structured block from the
      // prose (rendered via buildV2GuidanceBlock) so raw JSON is not dumped here.
      const cleaned = stripStructuredGuidanceBlock(plainProse);
      if (cleaned.length > 0) {
        scoringGuidance = `\nScoring guidance:\n${cleaned}`;
      }
    }
    if (sg) {
    // BINARY SCORING: Yes / No buckets only. Any "partial" guidance bucket folds
    // into No (partial evidence does not meet the measure).
    scoringGuidance = `\nScoring guidance:\n- Yes (1): ${sg.yes || "Clear evidence fully satisfying the requirement"}\n- No (0): ${sg.no || "No evidence found"}${sg.partial ? `\n- Note (does NOT meet the measure — score No): ${sg.partial}` : ""}`;
    if (sg.explicit_exclusions && Array.isArray(sg.explicit_exclusions) && sg.explicit_exclusions.length > 0) {
      scoringGuidance += `\n\nEXPLICIT EXCLUSIONS (do NOT score Yes if only this evidence exists):\n${sg.explicit_exclusions.map((e: string) => `- ${e}`).join("\n")}`;
    }
    if (sg.required_evidence_type) {
      scoringGuidance += `\n\nREQUIRED EVIDENCE TYPE: ${sg.required_evidence_type}`;
    }
    if (sg.temporal_note) {
      scoringGuidance += `\n\nTEMPORAL NOTE: ${sg.temporal_note}`;
    }
    // I76: positive_examples give the scorer concrete calibration anchors of
    // what SHOULD score Yes / Partial (same rationale as the other prompt path).
    if (sg.positive_examples && Array.isArray(sg.positive_examples) && sg.positive_examples.length > 0) {
      scoringGuidance += `\n\nILLUSTRATIVE POSITIVE PATTERNS (for calibration ONLY — NOT source evidence; NEVER quote, paraphrase, or cite these as a disclosure. Any quote returned must be a verbatim span from the provided evidence pack):\n${sg.positive_examples.map((e: string) => `- ${e}`).join("\n")}`;
    }
    // BINARY SCORING: former "partial" examples are disclosures that do NOT fully
    // meet the measure, so under binary scoring they are examples of a No.
    if (sg.partial_examples && Array.isArray(sg.partial_examples) && sg.partial_examples.length > 0) {
      scoringGuidance += `\n\nEXAMPLES THAT DO NOT MEET THE MEASURE (score No — evidence is only partial):\n${sg.partial_examples.map((e: string) => `- ${e}`).join("\n")}`;
    }
    }
  }

  // Sprint 10 P2: v2 field integration (identical to binary path).
  const { guidanceBlock: v2Block, quoteContextInstr } = buildV2GuidanceBlock(measure, framework, topicDescription);

  const temporalBlock = temporalWarning ? `\n${temporalWarning}\n` : "";

  const prompt = `Company: ${companyName}
${temporalBlock}
MEASURE TO EVALUATE:
Title: ${measure.title}
Definition: ${measure.definition || measure.title}
${scoringGuidance}${v2Block}${quoteContextInstr}

EVIDENCE TEXT:
${evidenceText || "[No relevant evidence found in the document corpus]"}

${SELF_CHECK_INSTRUCTION}

Evaluate this measure and return a JSON object with exactly these fields:
{
  "score": 0 or 1,
  "verdict": "Yes" | "No",
  "confidence": "High" | "Medium" | "Low",
  "evidenceSummary": "One paragraph explaining your assessment",
  "quotes": [{"text": "verbatim quote from evidence", "source": "exact document title from --- DOCUMENT: <title> [url] --- header"}],
  "verdictNuance": "optional caveats or notes" or null,
  "rationaleConsistencyCheck": "Yes" | "No",
  "consistencyNote": "one line: how you verified rationale and score agree"
}`;

  return { system, prompt };
}

// ─── JSON Parsing with Repair ────────────────────────────────────────────────

// Exported so the variability harness (server/scripts/variability_run.ts) shares
// the IDENTICAL parse+repair logic instead of maintaining a divergent copy.
//
// Root cause this repairs: some LLMs (observed on claude-sonnet-4.5 as the arbiter,
// ~20% of calls) emit verbatim quotes that embed a LITERAL control character
// (newline/carriage-return/tab) or an UNESCAPED inner double-quote inside a JSON
// string value (e.g. a quote containing `"Science Based Targets"`), producing
// structurally invalid JSON. finish_reason is `stop` — this is NOT truncation.
// The repair below is model-agnostic: it fixes the invalid JSON structurally
// rather than patching any one provider.
export function extractAndParseJSON(text: string): any {
  // Strategy 1: Direct parse (fast path — ALREADY-VALID JSON is returned here,
  // byte-for-byte identical to the previous behaviour, no repair applied).
  try {
    return JSON.parse(text);
  } catch {}

  // Strategy 2: Strip code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  // Strategy 3: Find JSON object boundaries
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  // Strategy 4: Structural repair on the best candidate string. This handles the
  // two proven failure modes generally:
  //   (a) literal control chars (\n, \r, \t) inside string values → escaped;
  //   (b) unescaped double-quotes inside string values → escaped.
  // Candidate preference: fence content > first-brace..last-brace substring > raw.
  let candidate: string;
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  } else if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidate = text.slice(firstBrace, lastBrace + 1);
  } else {
    candidate = text;
  }
  try {
    return JSON.parse(jsonrepair(candidate));
  } catch {}

  // Total failure — log a truncated diagnostic (first 300 + last 300 chars) so
  // future failures are inspectable. Do NOT log secrets (this is raw model output).
  const head = text.slice(0, 300);
  const tail = text.length > 600 ? text.slice(-300) : "";
  console.error(
    `[analyzer] extractAndParseJSON: all strategies failed (len=${text.length}). ` +
    `head=${JSON.stringify(head)}` + (tail ? ` tail=${JSON.stringify(tail)}` : ""),
  );
  throw new Error("Failed to parse JSON from LLM response");
}

// ─── Provenance Check ────────────────────────────────────────────────────────

export function verifyQuoteProvenance(
  quote: string,
  evidenceText: string
): { found: boolean; similarity: number } {
  if (!quote || !evidenceText) return { found: false, similarity: 0 };

  // REVIEWER FIX v3d (issue #2): strict whitespace-only normalization punished
  // companies that paraphrase or whose quotes differ only by punctuation
  // (curly vs straight quotes, em-dashes, commas) — e.g. NVIDIA 1.1 got 3/3 Yes
  // but was auto-downgraded because the quote didn't match verbatim. We now
  // normalize punctuation AND whitespace, then accept a fuzzy match: an exact
  // normalized substring, OR a longest-contiguous-substring covering >= 90% of
  // the quote, OR (final fallback) a strong consecutive-word window.
  const normalize = (s: string): string =>
    s
      .replace(/[\u2018\u2019\u201b\u2032]/g, "'")      // smart single quotes -> '
      .replace(/[\u201c\u201d\u201f\u2033]/g, '"')      // smart double quotes -> "
      .replace(/[\u2010-\u2015\u2212]/g, "-")           // various dashes -> -
      .replace(/[\u00a0]/g, " ")                          // nbsp -> space
      .replace(/[.,;:!?()\[\]{}"'\-—–]/g, " ")           // drop punctuation
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const normalizedQuote = normalize(quote);
  const normalizedEvidence = normalize(evidenceText);
  if (!normalizedQuote) return { found: false, similarity: 0 };

  // 1) Exact normalized substring.
  if (normalizedEvidence.includes(normalizedQuote)) {
    return { found: true, similarity: 1.0 };
  }

  // 2) Longest contiguous substring of the quote that appears in the evidence,
  //    measured at the character level. If it covers >= 90% of the quote, accept.
  //    We grow a candidate window from each space-aligned start to stay O(n*m)-ish
  //    in practice (quotes are short).
  const qLen = normalizedQuote.length;
  let longest = 0;
  // Try progressively shorter prefixes/suffixes via word boundaries for speed.
  const qWords = normalizedQuote.split(" ");
  for (let start = 0; start < qWords.length; start++) {
    // Extend the window as far right as still found in evidence.
    let lo = start, hi = qWords.length;
    let bestEnd = start;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const cand = qWords.slice(start, mid).join(" ");
      if (normalizedEvidence.includes(cand)) { bestEnd = mid; lo = mid; }
      else { hi = mid - 1; }
      if (lo === hi) break;
    }
    const candStr = qWords.slice(start, Math.max(bestEnd, start + 1)).join(" ");
    if (normalizedEvidence.includes(candStr)) longest = Math.max(longest, candStr.length);
  }
  const coverage = qLen > 0 ? longest / qLen : 0;
  if (coverage >= 0.9) {
    return { found: true, similarity: coverage };
  }

  // 3) Final fallback: a strong consecutive-word window (>= 60% of words, min 5).
  if (qWords.length >= 5) {
    const windowSize = Math.max(5, Math.floor(qWords.length * 0.6));
    for (let i = 0; i <= qWords.length - windowSize; i++) {
      const window = qWords.slice(i, i + windowSize).join(" ");
      if (normalizedEvidence.includes(window)) {
        return { found: true, similarity: Math.max(0.8, coverage) };
      }
    }
  }

  return { found: false, similarity: coverage };
}

// ─── Source Normalization ────────────────────────────────────────────────────

/**
 * Normalize quote sources to match actual document titles from the evidence text.
 * The evidence text contains headers like: --- DOCUMENT: <title> [<url>] ---
 * If the LLM returned a source that doesn't match any document title, find the
 * best match or fall back to the document where the quote text was found.
 */
export function normalizeQuoteSources(
  quotes: Array<{ text: string; source: string; sourceUrl?: string; page?: number }>,
  evidenceText: string
): Array<{ text: string; source: string; sourceUrl?: string; page?: number }> {
  // Extract all document titles from the evidence text headers
  const headerPattern = /--- DOCUMENT: (.+?) \[(.+?)\] ---/g;
  const documentHeaders: Array<{ title: string; url: string; startIdx: number }> = [];
  let match;
  while ((match = headerPattern.exec(evidenceText)) !== null) {
    documentHeaders.push({ title: match[1].trim(), url: match[2].trim(), startIdx: match.index });
  }

  if (documentHeaders.length === 0) return quotes;

  // Build a set of valid document titles + a title->url map for quick lookup
  const validTitles = new Set(documentHeaders.map(h => h.title.toLowerCase()));
  const urlByTitle = new Map<string, string>();
  for (const h of documentHeaders) {
    // First header wins for a given title (avoids later duplicates overwriting)
    if (!urlByTitle.has(h.title.toLowerCase())) urlByTitle.set(h.title.toLowerCase(), h.url);
  }
  const resolveUrl = (title: string): string | undefined =>
    title ? urlByTitle.get(title.toLowerCase()) : undefined;

  return quotes.map(quote => {
    // Check if the source already matches a valid document title
    if (quote.source && validTitles.has(quote.source.toLowerCase())) {
      return { ...quote, sourceUrl: resolveUrl(quote.source) ?? quote.sourceUrl };
    }

    // Source doesn't match any document title — try to find the correct one
    let bestSource = quote.source;

    // Strategy 1: Find which document contains the quote text
    if (quote.text) {
      const normalizedQuote = quote.text.replace(/\s+/g, " ").trim().toLowerCase();
      const normalizedEvidence = evidenceText.toLowerCase();
      const quoteIdx = normalizedEvidence.indexOf(normalizedQuote.slice(0, 80));

      if (quoteIdx >= 0) {
        // Find the document header that precedes this quote position
        let containingDoc = documentHeaders[0];
        for (const header of documentHeaders) {
          if (header.startIdx <= quoteIdx) {
            containingDoc = header;
          } else {
            break;
          }
        }
        bestSource = containingDoc.title;
        // Capture the authoritative URL from the containing document header
        return { ...quote, source: bestSource, sourceUrl: containingDoc.url };
      }
    }

    // Strategy 2: Fuzzy match the source string against document titles
    if (bestSource === quote.source && quote.source) {
      const sourceLower = quote.source.toLowerCase();
      let bestSimilarity = 0;
      let bestMatch = "";

      for (const header of documentHeaders) {
        const titleLower = header.title.toLowerCase();
        // Check if source is a substring of a title or vice versa
        if (titleLower.includes(sourceLower) || sourceLower.includes(titleLower)) {
          bestSource = header.title;
          break;
        }
        // Simple word overlap similarity
        const sourceWords = new Set(sourceLower.split(/\s+/));
        const titleWords = titleLower.split(/\s+/);
        const overlap = titleWords.filter(w => sourceWords.has(w)).length;
        const similarity = overlap / Math.max(sourceWords.size, titleWords.length);
        if (similarity > bestSimilarity && similarity > 0.3) {
          bestSimilarity = similarity;
          bestMatch = header.title;
        }
      }
      if (bestMatch && bestSource === quote.source) {
        bestSource = bestMatch;
      }
    }

    // Strategy 3: If still no match, use the first document as fallback
    if (bestSource === quote.source || !bestSource) {
      bestSource = documentHeaders[0].title;
    }

    return { ...quote, source: bestSource, sourceUrl: resolveUrl(bestSource) ?? quote.sourceUrl };
  });
}

// ─── Contradiction Detection + Tie-Breaker ───────────────────────────────────

// Change D: DETERMINISTIC, GENERIC, BIDIRECTIONAL post-hoc consistency detector.
//
// This REPLACES the former live tie-breaker override. The old behaviour fired a
// SECOND live LLM call on a No verdict whose rationale matched one of five
// hardcoded phrases and then OVERRODE the score→1 / verdict→Yes. That coupled a
// design-time rubric defect to a live, per-cell, non-deterministic mutation.
//
// The new behaviour:
//   • Makes NO LLM call (fully deterministic; safe for the seeded scoring path).
//   • Detects rationale↔score disagreement in BOTH directions, using generic
//     lexical cue families + the model's own in-completion self-check (Change C).
//   • NEVER changes the score or verdict — it only sets flags that route the cell
//     to DESIGN-TIME re-adjudication (rationaleScoreInconsistent /
//     inconsistencyReason / needsReadjudication).
function applyRationaleConsistencyFlags(opts: {
  measure: FrameworkMeasure;
  result: MeasureResult;
}): MeasureResult {
  const { measure, result } = opts;

  const detection = detectRationaleScoreInconsistency({
    score: result.score,
    verdict: result.verdict,
    rationale: result.evidenceSummary,
    modelConsistencyCheck: result.rationaleConsistencyCheck ?? null,
    consistencyNote: result.consistencyNote ?? null,
  });

  if (!detection.inconsistent) {
    return { ...result, rationaleScoreInconsistent: false, needsReadjudication: false };
  }

  console.log(
    `[ConsistencyFlag] ${measure.measureId}: rationale↔score inconsistency (${detection.directions.join(",")}) — flagged for design-time re-adjudication (score/verdict UNCHANGED)`
  );

  return {
    ...result,
    // Score and verdict are intentionally left UNCHANGED.
    rationaleScoreInconsistent: true,
    inconsistencyReason: detection.reason,
    needsReadjudication: true,
  };
}

// ─── Document Summarization ──────────────────────────────────────────────────

// Exported for the variability-experiment harness (server/scripts/variability_run.ts).
// This is the REAL, deterministic (no-LLM) retrieval-corpus builder used by the
// production pipeline for corpora above the BM25-skip threshold. Exporting it lets
// the harness reproduce production's exact combinedText rather than reimplementing
// (and drifting from) the doc-prioritisation + chunk-sanity + capping logic.
// Behaviour-preserving change: only the `export` keyword is added.
/**
 * Topic identity salt for the retrieval-corpus cache key (index seam + summary
 * cache). RATIONALE: `summarizeDocumentsCompute` trims a company's document pool
 * down to the retrieval budget in a TOPIC-AWARE way (priority ordering + BM25
 * pre-filter keyed off `topicDescription`). The document pool is per-company and
 * SHARED across frameworks, but the trimmed corpus that comes out is a function
 * of the topic. The cache key must therefore carry the topic, or a large-corpus
 * company's corpus built under framework A (topic A) could be served to
 * framework B (topic B) for the same documents — a cross-topic leak that can
 * change which sources/passages reach topic B's scorer. Folding this salt into
 * the key segregates entries per topic so such a hit is impossible BY
 * CONSTRUCTION. Framework-level (derived from framework.topicDescription ||
 * framework.name); not company- or topic-specific. The value is normalised
 * (trim + lowercase + whitespace-collapse) so cosmetic edits don't needlessly
 * invalidate, then hashed. Small corpora below the BM25-skip threshold never
 * reach this seam, so they are unaffected either way.
 */
export function topicCacheSalt(topicDescription: string | null | undefined): string {
  const norm = String(topicDescription ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/**
 * B4/WP12 index seam — public entry point. Wraps the deterministic BM25 corpus
 * build (summarizeDocumentsCompute) in the content-hash cache layer, STRICTLY
 * GATED by CACHE_LAYER_POLICY. Under the shipped default ("off"), cacheRetrieval-
 * Index runs the compute directly and returns its result byte-for-byte — this
 * wrapper is a provable pass-through and the pipeline is identical to today. The
 * key is tenant-isolated by companyId and derived from the content-stable hash of
 * the document-set texts, salted by PIPELINE_VERSION so a retrieval/code change
 * invalidates the entry, AND by a topic salt (topicCacheSalt) so a different
 * framework/topic can never be served another topic's topic-aware trimmed corpus
 * for the same documents. (The corpus is a pure function of the doc texts + topic
 * — the model tag is "bm25-headers-*", no model call — so a hit is byte-identical
 * to a cold build, satisfying deterministic equivalence.)
 */
export async function summarizeDocuments(
  opts: Parameters<typeof summarizeDocumentsCompute>[0],
): ReturnType<typeof summarizeDocumentsCompute> {
  return cacheRetrievalIndex({
    workspaceId: opts.companyId,
    dependencyHashes: [generateContentStableHash(opts.documentTexts)],
    extra: { corpus: PIPELINE_VERSION, topic: topicCacheSalt(opts.topicDescription) },
    compute: () => summarizeDocumentsCompute(opts),
  });
}

async function summarizeDocumentsCompute(opts: {
  companyName: string;
  companyId: number;
  documentTexts: string[];
  documentUrls: string[];
  documentTitles?: string[];
  topicDescription: string;
  framework: Framework;
  // PR 1 · Change 1c: threaded through so the sanity gate (below) can run
  // BEFORE the BM25 candidate pool is built. Both are required for the gate
  // to fire; if either is missing the pool is built exactly as before (the
  // backward-compat invariant tested in passage-retrieval.test.ts).
  retrievalV2?: boolean;
  issuerProfile?: IssuerProfile;
}): Promise<{ text: string; model: string; reservedAnnualUrl?: string; corpusTopicWarning?: string; topicPrimaryDocUrls?: string[]; chunkSanityDiagnostics?: ChunkSanityResult }> {
  const { companyName, companyId, documentTexts, documentUrls, documentTitles, topicDescription, framework, retrievalV2, issuerProfile } = opts;

  // Check summary cache. v3g: salt the cache key so the OLD header-lossy LLM
  // summaries (which dropped document URLs) are never reused; only the new
  // header-preserving retrieval corpus is served from cache going forward.
  // I59c: derive the salt from PIPELINE_VERSION (git commit SHA on Railway) so
  // every commit that changes summarizer or retrieval logic automatically
  // invalidates the summary cache without a manual salt rotation. This closes
  // the class of bugs where a code change to the summarizer ships to prod but
  // scored batches silently use stale cached summaries.
  // CHANGE 3 — content-stable summary cache key. Default-on: hash the document
  // TEXT (whitespace/order-normalized, no volatile URL/timestamp fields) so the
  // same corpus content reuses its summary regardless of URL or fetch order, and
  // silently-changed content invalidates the entry. CONTENT_STABLE_HASH=0 (or
  // =false) restores the prior URL-set hashing exactly. The `:corpus-${VERSION}`
  // salt is preserved in both modes so a code change still invalidates the cache.
  const contentStableHashEnabled =
    (process.env.CONTENT_STABLE_HASH || "").toLowerCase() !== "0" &&
    (process.env.CONTENT_STABLE_HASH || "").toLowerCase() !== "false";
  const hashBasis = contentStableHashEnabled
    ? generateContentStableHash(documentTexts)
    : generateDocumentHash(documentUrls);
  // TOPIC-SALT (Option 2): fold the framework/topic identity into the summary
  // cache key too. The summary IS the topic-aware trimmed corpus, so without
  // this salt a large company (> bm25SkipSummarizationBelowChars) scored under
  // framework A could serve its A-trimmed corpus to framework B on the identical
  // document set. Deriving the salt from topicDescription (= framework.topic-
  // Description || framework.name) segregates the entry per framework/topic.
  const docHash = createHash("sha256")
    .update(hashBasis + `:corpus-${PIPELINE_VERSION}` + `:topic-${topicCacheSalt(topicDescription)}`)
    .digest("hex")
    .slice(0, 16);
  const cached = await storage.getCachedSummary(companyId, docHash);
  if (cached) {
    console.log(`[${companyName}] Using cached summary`);
    return { text: cached, model: "cached" };
  }

  // ─── PRIORITY-BASED DOCUMENT ORDERING ───────────────────────────────────────
  // Sort documents by relevance to the topic BEFORE combining, so AI-specific
  // content appears first and doesn't get truncated.
  const topicKeywords = tokenize(topicDescription);
  // Instruction 25: Use framework-aware topic-term derivation instead of hardcoded
  // AI keywords. deriveTopicTerms produces distinctive tokens from the topic
  // description and framework name. dataPatternTokens add the exact strings the
  // framework author declared as topic-defining.
  const derivedTerms = deriveTopicTerms(topicDescription, undefined);
  const dataPatternTokens = (framework as any).dataPatterns
    ? ((framework as any).dataPatterns as string[])
        .flatMap((p: string) => p.replace(/[\\^$.|?*+()\[\]{}]/g, " ").split(/\s+/))
        .filter((t: string) => t.length >= 4)
    : [];

  // Instruction 34 REVERTED (Instruction 35): the universal governance vocabulary
  // hurt Stage-1 retrieval on document-rich corpora. Long compliance/annual-report
  // documents saturated in governance language (HSBC AR 2025 etc.) dominated the
  // ~560k character corpus pool and pushed topic-specific-evidence chunks out of
  // the top-K. Battery on 610893a: fw3 HSBC 56 → 7 (18 of 27 measures cite the
  // same weak sentence from AR-2025 vs 21 diverse quotes from Sustainability/TCFD
  // reports prior). Reverted; see Instruction 33 (semantic embedding rerank) for
  // the durable replacement.

  // ─── Approach 2b/2c: curated corpus-selection discriminators ────────────────
  // The framework's own DF-validated retrievalQueryTerms (generated at framework
  // creation) are the discriminative vocabulary a relevant passage would contain.
  // Historically they were injected ONLY into the scoring prompt, never into
  // corpus selection, so the 560k budget was won by generic business/stop words
  // dense in every filing. We now feed them into allQueryTerms, WEIGHTED above the
  // free-text tokens: bm25Score() (and the density scan below) sum a term's
  // contribution once per occurrence in the query array, so repeating each curated
  // token CURATED_QUERY_TERM_WEIGHT times up-weights the framework's discriminators
  // without dominating (prevents the iDEA-style regression). Fully generic and
  // backward-compatible: when retrievalQueryTerms is empty, allQueryTerms is
  // exactly the previous set.
  const CURATED_QUERY_TERM_WEIGHT = 3; // framework-independent constant
  const curatedRaw = ((framework as any).retrievalQueryTerms as string[] | null | undefined) || [];
  // 2c: seed the short-token allowlist from the curated vocab BEFORE tokenizing so
  // that short discriminators (e.g. "ai", "ml", "5g") survive tokenize()'s length
  // filter in BOTH the query and the BM25 index built below.
  setShortTokenAllowlist(curatedRaw);
  const freeTextTerms = [...new Set([...topicKeywords, ...derivedTerms, ...dataPatternTokens])];
  const freeTextSet = new Set(freeTextTerms);
  // Tokenise the curated terms the same way documents are tokenised (so they match
  // the BM25 index), dedup within the curated set, then repeat for weighting.
  const curatedTokens = [...new Set(curatedRaw.flatMap((t) => tokenize(t)))];
  const weightedCurated = curatedTokens.flatMap((t) =>
    // A curated token that is ALSO a free-text token gets (WEIGHT - 1) extra copies
    // (it already appears once via freeTextTerms); a purely-curated token gets WEIGHT.
    Array(freeTextSet.has(t) ? CURATED_QUERY_TERM_WEIGHT - 1 : CURATED_QUERY_TERM_WEIGHT).fill(t),
  );
  const allQueryTerms = [...freeTextTerms, ...weightedCurated];

  // v3g-fix: TYPE-AWARE document prioritisation. The previous pure keyword-density
  // ranking let a long, AI-keyword-dense ESG/sustainability PDF (e.g. Apple's
  // Environmental Progress Report) dominate the top slots and consume the corpus
  // budget, pushing the 10-K and proxy — where the actual AI governance/strategy
  // evidence lives — out of the pool. We classify each document by TYPE and give a
  // strong structural priority to authoritative filings and dedicated AI/governance
  // pages, while CAPPING the keyword-density contribution so no single long PDF can
  // crowd out the primary disclosures.
  // Instruction 26: Framework-declared topic-primary classification.
  // No hardcoded topic categories — recognises universal doc types (regulatory, proxy)
  // plus framework-declared requiredDocTypes as the topic-primary class.
  type DocClass = "regulatory" | "proxy" | "topic-primary" | "other";
  const classifyDoc = (url: string, title: string): DocClass => {
    const u = (url || "").toLowerCase();
    const t = (title || "").toLowerCase();
    const haystack = u + " " + t;
    // Universal: SEC primary filings
    if (/sec\.gov\/archives\/edgar/.test(u) || /\b(10-?k|20-?f|40-?f)\b/.test(haystack) || /-\d{8}\.htm/.test(u)) return "regulatory";
    // Universal: proxy statements
    if (/proxy|def.?14a/.test(haystack)) return "proxy";
    // Framework-driven: does the doc's title/URL match any of the framework's requiredDocTypes?
    const requiredDocTypes = ((framework as any).requiredDocTypes as string[] | null) || [];
    for (const docType of requiredDocTypes) {
      const words = docType.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3);
      if (words.length === 0) continue;
      const matched = words.filter((w: string) => haystack.includes(w)).length;
      if (matched >= Math.min(2, words.length)) return "topic-primary";
    }
    return "other";
  };
  // Structural priority weights (dominate keyword density, which is capped below).
  const CLASS_BOOST: Record<DocClass, number> = {
    regulatory: 100000,
    proxy: 90000,
    "topic-primary": 80000,
    other: 1000,
  };
  interface DocEntry { text: string; url: string; score: number; precision: number; idx: number; cls: DocClass }

  // 37-B.1: topic-precision score using framework dataPatterns.
  // dataPatterns are framework-declared regexes that fire only on topic-specific text.
  // This differentiates documents that mention the topic generically from documents
  // that materially discuss it.
  const dataPatterns = ((framework as any).dataPatterns as string[] | null) || [];
  const dataPatternRegexes = dataPatterns.map((p: string) => {
    try { return new RegExp(p, "gi"); } catch { return null; }
  }).filter((r): r is RegExp => r !== null);

  const docEntries: DocEntry[] = documentTexts.map((text, idx) => {
    const lower = text.toLowerCase();
    let density = 0;
    for (const term of allQueryTerms) {
      const regex = new RegExp(`\\b${term}\\b`, "gi");
      const matches = lower.match(regex);
      density += Math.min(matches?.length || 0, 10);
    }
    // 37-B.1: topic precision — hits on framework's dataPatterns, uncapped.
    // These regex are framework-declared and topic-specific by design; more hits
    // means the document is materially about the framework's actual subject.
    let precision = 0;
    for (const rx of dataPatternRegexes) {
      rx.lastIndex = 0;
      const matches = lower.match(rx);
      precision += matches?.length || 0;
    }
    const url = documentUrls[idx] || "";
    const title = documentTitles?.[idx] || "";
    let cls = classifyDoc(url, title);
    // I59c: CONTENT-BASED topic-primary promotion. A document whose text fires
    // the framework's dataPatterns (regexes authored by the framework itself)
    // at high density is materially about the framework topic — regardless of
    // whether its URL or title happens to contain the requiredDocTypes tokens.
    // Example: JPM's Modern Slavery Statement PDFs live at
    // modernslaveryregister.gov.au/statements/<id>/pdf (URL has no spaces, title
    // is generic '2024 JPM statement'), so the URL/title classifier never sees
    // 'modern' + 'slavery' + 'statement' as separate tokens and defaults to
    // 'other'. But the doc's TEXT hits 'modern.?slavery.?(?:act|statement)'
    // dozens of times — authoritative content evidence. Promote such docs to
    // 'topic-primary' so they get the topic-primary class cap AND the I59
    // topic-primary chunk reserve downstream. Threshold is intentionally high
    // to avoid promoting a passing mention in a bulk filing.
    //
    // Framework-agnostic: dataPatterns are declared by the framework author.
    // Only fires when the framework provides them; falls through cleanly for
    // frameworks without patterns.
    const CONTENT_PROMOTION_THRESHOLD = 10;
    if (cls === "other" && precision >= CONTENT_PROMOTION_THRESHOLD) {
      cls = "topic-primary";
    }
    // Keyword density is CAPPED so it only breaks ties WITHIN a class, never
    // overrides the structural class priority above.
    const requiredDocSlugs = ((framework as any).requiredDocTypes as string[] | null) || [];
    const slugWords = requiredDocSlugs.flatMap((s: string) => s.toLowerCase().split(/\s+/).filter((w: string) => w.length >= 3));
    const slugRe = slugWords.length > 0 ? new RegExp(slugWords.join("|"), "i") : null;
    const slugBonus = slugRe && slugRe.test(url) ? 200 : 0;
    const score = CLASS_BOOST[cls] + Math.min(density, 800) + slugBonus;
    return { text, url, score, precision, idx, cls };
  });

  // 37-B.1: sort by (class-score DESC, precision DESC, idx ASC).
  // idx ASC breaks final ties deterministically (37-A guarantees stable idx).
  docEntries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.precision !== a.precision) return b.precision - a.precision;
    return a.idx - b.idx;
  });

  console.log(`[${companyName}] Document priority ordering (top 5):`);
  for (const d of docEntries.slice(0, 5)) {
    console.log(`  [${d.cls}] score=${d.score} ${d.url.slice(0, 60)}`);
  }

  // Combine documents in priority order with CLASS-AWARE caps. Regulatory filings
  // and proxies (where the primary AI disclosures live) get the largest cap so
  // Item 1A / governance sections survive; sustainability PDFs get a smaller cap so
  // a single long ESG report cannot consume the budget at the expense of filings.
  // v3k: the regulatory cap was 260k, but a current 10-K can exceed that
  // (Amazon FY2025 = 307k chars). Truncating at 260k could cut the Item 1A AI
  // risk paragraphs that appear deep in the filing, which is the upstream half of
  // Bug 2 (the per-measure force-include can only recover what survives here).
  // Raise the regulatory cap so a single primary annual filing is never truncated;
  // proxy similarly raised. Sustainability stays small so one long ESG PDF cannot
  // crowd out the filings.
  const CAP_BY_CLASS: Record<DocClass, number> = {
    regulatory: 480000,
    proxy: 360000,
    "topic-primary": 160000,
    other: 120000,
  };

  // 38: uncapped reserve for high-precision documents.
  // Documents with >= HIGH_PRECISION_THRESHOLD dataPattern hits are materially about
  // the framework topic. Include ALL of them in the first pass in precision-DESC order,
  // each at its full class-cap. This eliminates the "which one wins reservation"
  // non-determinism when multiple documents in the same class share high precision.
  //
  // Design note: this is not unbounded — the total corpus is capped by
  // MAX_DOCS_RETURNED (90) upstream, and the summariser's downstream 600k skip
  // threshold + 560k BM25 pool cap the total content that reaches the scorer.
  // Reserving more high-precision documents just changes which ones get full-cap
  // allocation vs which ones get second-pass class-cap fill.
  const HIGH_PRECISION_THRESHOLD = 3;
  const highPrecisionEntries = docEntries.filter(e => e.precision >= HIGH_PRECISION_THRESHOLD);

  let combined = "";
  const includedIndexes = new Set<number>();
  // First pass: include ALL high-precision documents at their full class-cap,
  // in the existing (class-score DESC, precision DESC, idx ASC) sort order.
  for (const entry of highPrecisionEntries) {
    const cap = CAP_BY_CLASS[entry.cls];
    const docTitle = documentTitles?.[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
    includedIndexes.add(entry.idx);
  }
  // Second pass: remaining documents in sort order.
  for (const entry of docEntries) {
    if (includedIndexes.has(entry.idx)) continue;
    const cap = CAP_BY_CLASS[entry.cls];
    const docTitle = documentTitles?.[entry.idx] || entry.url;
    combined += `\n\n--- DOCUMENT: ${docTitle} [${entry.url}] ---\n\n` + entry.text.slice(0, cap);
    includedIndexes.add(entry.idx);
  }

  // 37-B.3: emit warning when the assembled corpus fires zero dataPattern hits.
  // This is a diagnostic signal, not a hard block.
  const totalPrecision = docEntries.reduce((sum, e) => sum + (includedIndexes.has(e.idx) ? e.precision : 0), 0);
  const corpusTopicWarning = totalPrecision === 0 && dataPatternRegexes.length > 0
    ? `Corpus contains zero hits on framework dataPatterns (${dataPatterns.slice(0,3).join(", ")}...). Retrieval may have failed to surface topic-material evidence.`
    : undefined;
  if (corpusTopicWarning) {
    console.warn(`[${companyName}] 37-B.3: ${corpusTopicWarning}`);
  }

  // I60: Expose the set of topic-primary doc URLs so downstream per-measure
  // passage retrieval can force-include chunks from these docs (analogous to
  // Item 1A reserve for SEC filings). Docs are topic-primary if they were
  // classified by either the URL/title token match (framework.requiredDocTypes)
  // OR the content-based promotion (framework.dataPatterns ≥ threshold). Both
  // are framework-authored data — no topic/company literals in code.
  const topicPrimaryDocUrls = docEntries
    .filter((e) => e.cls === "topic-primary" && !!e.url)
    .map((e) => e.url);
  console.log(`[${companyName}] topic-primary docs: ${topicPrimaryDocUrls.length} URLs (fed to per-measure retrieval)`);

  // If total is small enough, skip summarization and use BM25 directly
  if (combined.length < 600000) {
    return { text: combined, model: "raw-pass", corpusTopicWarning, topicPrimaryDocUrls };
  }

  // ─── HEADER-PRESERVING BM25 PRE-FILTER (v3g quote sourceUrl fix) ─────────────
  // The corpus is too large to pass whole. PREVIOUSLY we BM25-filtered then ran an
  // LLM "summarizer" whose output became the scoring corpus. That summary DROPPED
  // the "--- DOCUMENT: <title> [<url>] ---" headers and paraphrased the text, which
  // (a) made quote.sourceUrl impossible to resolve (no URL survived) and
  // (b) degraded verbatim quote fidelity. We now select the most relevant chunks
  // with BM25 and rebuild a corpus that RE-EMITS the document header (with URL)
  // whenever the source document changes — preserving provenance AND verbatim text.
  // The document-aware chunker carries docUrl/docTitle on every chunk.
  //
  // ─── Approach 3c: strip exact repeated structural boilerplate blocks ─────────
  // Before chunking, drop short header/footer/legend lines that recur identically
  // across many DISTINCT documents (repeated disclaimers, page furniture, legends).
  // This reclaims budget deterministically without touching scoring. Fully generic
  // and SAFE: provenance headers, lines with a quantified figure, longer prose, and
  // lines containing a curated discriminator are never stripped. Only runs on the
  // large-corpus path (this branch), where the budget competition actually bites.
  {
    const strip = stripRepeatedStructuralBlocks(combined, { protectTerms: curatedTokens });
    if (strip.strippedLines > 0) {
      console.log(`[${companyName}] Approach 3c: stripped ${strip.strippedLines} repeated structural line(s) across ${strip.patterns} pattern(s)`);
      combined = strip.text;
    }
  }
  let docChunks = chunkDocuments(combined);
  let chunkSanityDiagnostics: ChunkSanityResult | null = null;

  // ─── PR 1 · Change 1c: sanity gate ──────────────────────────────────────────
  // Hard-filter chunks whose parent document is deep-vintage or a wrong-entity
  // match BEFORE they enter the BM25 candidate pool. Only fires when BOTH the
  // retrievalV2 flag is on AND an issuerProfile is available; otherwise
  // `docChunks` is untouched (backward-compat invariant).
  if (retrievalV2 && issuerProfile) {
    const gate = applyChunkSanityGate(docChunks, {
      issuerProfile,
      currentYear: new Date().getUTCFullYear(),
      // CHANGE 2: preserve the only available source rather than letting the
      // gate hand retrieval an empty corpus. Effective only when
      // CHUNK_GATE_FAIL_OPEN is on (default); a no-op when the flag is off.
      preserveIfOnlySource: true,
    });
    if (gate.rejected.length > 0) {
      const totalRejected = gate.rejected.reduce((a, r) => a + r.chunkCount, 0);
      console.log(`[${companyName}] Change 1c gate: ${totalRejected} chunks rejected across ${gate.rejected.length} docs (${gate.rejected.map(r => `${r.reason}:${r.docTitle || r.docUrl}`).join(", ")})`);
    }
    if (gate.softFlagged.length > 0) {
      console.log(`[${companyName}] Change 1c gate: ${gate.softFlagged.length} doc(s) soft-flagged (${gate.softFlagged.map(f => `${f.reason}:${f.docTitle || f.docUrl}`).join(", ")})`);
    }
    docChunks = gate.keep;
    chunkSanityDiagnostics = gate;
  }

  const bm25Index = buildBM25Index(docChunks.map((c) => c.text));

  // ─── Approach 3a+3b: gentle assembly penalties before budget selection ───────
  // (3a) down-weight chunks whose k=8 word-shingle fingerprint recurs across many
  // DISTINCT documents (near-duplicate boilerplate repeated in every filing), and
  // (3b) demote chunks dominated by terms with very high document-frequency WITHIN
  // THIS company's own corpus. Both are GENTLE multiplicative factors in (0,1]
  // applied to the BM25 score BEFORE the 560k selection, so near-unique
  // discriminative passages win budget they currently lose to boilerplate. SAFE:
  // a chunk carrying a quantified figure, a curated discriminator, or a framework
  // dataPattern match is PROTECTED (factor 1) and can never be evicted by this.
  // Budget, chunk boundaries, and downstream gating are unchanged.
  const penaltyFactors = computeAssemblyPenaltyFactors(docChunks, {
    protectTerms: curatedTokens,
    protectRegexes: dataPatternRegexes,
  });

  const scoredChunks = docChunks.map((chunk, idx) => ({
    idx,
    score: bm25Score(allQueryTerms, idx, bm25Index) * (penaltyFactors[idx] ?? 1),
    rank: 0,
    chunk,
  }));
  // Default rank = BM25 (Approach 2/3) score, so the disabled/degraded path is
  // byte-for-byte the existing behavior (the sort below is then equivalent to the
  // prior `b.score - a.score`, with an explicit idx tiebreak that preserves the
  // original stable ordering).
  for (const sc of scoredChunks) sc.rank = sc.score;

  // ─── Approach 4: semantic hybrid rerank (OPT-IN, graceful degrade) ─────────
  // Augments — never replaces — the BM25 (Approach 2/3) ranking above. Behind
  // RETRIEVAL_HYBRID_SEMANTIC=1 and only when an embeddings key is configured.
  // Reuses the app's existing OpenAI-compatible provider config. Single embedding
  // pass; deterministic (on-disk cache keyed by chunk-text hash). If embeddings
  // are unavailable or error, ranks stay = BM25 so scoring never breaks. Does NOT
  // change scoredChunks[].score (downstream reserves read .score as a BM25
  // tiebreak), the budget, chunk boundaries, or any downstream evidence-gating.
  if (isSemanticHybridEnabled() && isEmbeddingConfigured() && docChunks.length > 0) {
    try {
      // Bounded, single-pass candidate set: embed only the top-BM25 chunks (the
      // ones that can realistically win budget on huge filers); the remainder
      // keep cosine=null and fall back to their BM25 rank.
      const MAX_EMBED_CHUNKS = Math.max(1, parseInt(process.env.RETRIEVAL_EMBED_MAX_CHUNKS || "6000", 10));
      const byBm25 = [...scoredChunks].sort((a, b) => (b.score - a.score) || (a.idx - b.idx));
      const embedPick = byBm25.slice(0, MAX_EMBED_CHUNKS);

      // Query vector text = topic description + curated discriminators + measure
      // vocabulary (all framework-independent inputs already computed above).
      const queryVectorText = [topicDescription, ...curatedRaw, ...dataPatternTokens]
        .filter(Boolean)
        .join(" \n ")
        .slice(0, 8000);

      const chunkTexts = embedPick.map((sc) => sc.chunk.text);
      const vecs = await embedTextsCached([queryVectorText, ...chunkTexts]);
      const queryVec = vecs[0];

      if (queryVec) {
        const cosineByIdx = new Map<number, number | null>();
        for (let i = 0; i < embedPick.length; i++) {
          cosineByIdx.set(embedPick[i].idx, cosineSim(queryVec, vecs[i + 1]));
        }

        // FLOOR (guardrail 4c): any chunk carrying a curated discriminator token
        // OR a quantified figure is retained regardless of cosine.
        const curatedFloorRe = curatedTokens.length
          ? new RegExp("\\b(?:" + curatedTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "i")
          : null;
        const bm25Arr = scoredChunks.map((sc) => sc.score);
        const cosineArr = scoredChunks.map((sc) => (cosineByIdx.has(sc.idx) ? cosineByIdx.get(sc.idx)! : null));
        const floorArr = scoredChunks.map((sc) => {
          const text = sc.chunk.text;
          return containsQuantifiedFigure(text) || (curatedFloorRe ? curatedFloorRe.test(text) : false);
        });
        const hybrid = hybridRankScores({ bm25: bm25Arr, cosine: cosineArr, floor: floorArr });
        for (let i = 0; i < scoredChunks.length; i++) scoredChunks[i].rank = hybrid[i];
        const embedded = [...cosineByIdx.values()].filter((v) => v !== null).length;
        console.log(`[${companyName}] Approach 4: hybrid semantic rerank applied (embedded ${embedded}/${embedPick.length} candidate chunks, floor=${floorArr.filter(Boolean).length}/${scoredChunks.length})`);
      } else {
        console.log(`[${companyName}] Approach 4: embeddings unavailable; using BM25 (Approach 2/3) ranking`);
      }
    } catch (e) {
      console.warn(`[${companyName}] Approach 4: hybrid rerank skipped (${(e as Error).message}); using BM25 ranking`);
    }
  }

  scoredChunks.sort((a, b) => (b.rank - a.rank) || (a.idx - b.idx));

  // v3g-fix: this is the CANDIDATE POOL for the downstream per-measure BM25 packs
  // (buildEvidencePacksForCategory), NOT the text sent to the grader. The grader
  // only ever sees ~20k-char per-measure packs selected from this pool. The prior
  // 200k cap was too small for the largest filers (Amazon/Apple/Alphabet): relevant
  // AI passages for some measures fell outside the window and never reached the
  // per-measure BM25, producing spurious "No / 0 quotes". Because enlarging the pool
  // does NOT enlarge the grading prompt, we set it close to the whole-corpus
  // threshold (600k) so coverage matches the old LLM-summary path while keeping the
  // header-preserving, verbatim output. Env-tunable.
  const MAX_RETRIEVAL_INPUT = parseInt(process.env.RETRIEVAL_CORPUS_MAX_CHARS || "560000", 10);
  // Select winning chunk indices up to the budget, then RESTORE document order so
  // the re-emitted headers group each document's chunks contiguously.
  // v3g-fix: PRIORITISE high-BM25 chunks, but do NOT stop the pool at the first
  // zero-score chunk. Many measures' evidence lives in prose that lacks the AI
  // query terms (governance/committee/proxy boilerplate), which scores 0 on BM25;
  // discarding it starved measures on large filers. Instead we fill the (generous)
  // budget with the remaining chunks in document order, so the candidate pool stays
  // broad. The downstream per-measure BM25 then picks the right ~20k for each
  // question. Use a Set to avoid double-adding.
  const selectedSet = new Set<number>();
  let budget = 0;

  // ─── v3k UPSTREAM GUARANTEE: reserve the current annual filing's Item 1A ──────
  // The per-measure force-include (passage-retrieval.ts) can only recover Item 1A
  // chunks that EXIST in this retrieval corpus. For the largest filers (e.g.
  // Amazon: 3.6M chars across 82 docs) the 10-K's risk-factor chunks could lose
  // the 560k BM25 budget competition and never reach the per-measure stage, so the
  // grader saw "no 10-K in evidence" and returned No/0 quotes. Here we RESERVE the
  // genuine Item 1A body chunks of the single best (most recent, EDGAR-primary,
  // non-proxy) annual filing FIRST, with a dedicated sub-budget, regardless of
  // BM25 score or document order. This guarantees Item 1A always reaches the pool.
  const ITEM1A_RESERVE_CHARS = parseInt(process.env.RETRIEVAL_ITEM1A_RESERVE_CHARS || "90000", 10);
  // v3j-r12 FIX (NVIDIA): the URL of the annual filing chosen by THIS reserve is the
  // single source of truth for which document the per-measure force-include should
  // anchor on. The category builder otherwise re-derives it on the COMPRESSED corpus
  // (where the proxy's DEF 14A cover page may not survive, defeating content guards)
  // and can pick the wrong doc. We capture it here and thread it downstream.
  let reservedAnnualUrl: string | undefined;
  try {
    const isEdgarPrimary = (u: string) => /sec\.gov\/archives\/edgar\/data\/\d+\//.test((u||"").toLowerCase()) && /\.htm/.test((u||"").toLowerCase());
    const isAnnualFiling = (u: string, t: string) => {
      const s = ((u||"") + " " + (t||"")).toLowerCase();
      return /sec\.gov\/archives\/edgar/.test((u||"").toLowerCase()) || /\b(10-?k|20-?f|40-?f)\b/.test(s) || /-\d{8}\.htm/.test((u||"").toLowerCase());
    };
    // A chunk is a genuine Item 1A BODY chunk if section-tagged item1a and it is
    // neither a table-of-contents line nor a pure cross-reference.
    const looksToc = (txt: string) => /\.{4,}\s*\d+\b/.test(txt) || (txt.match(/item\s+\d+[a-z]?\b/gi) || []).length >= 4;
    const isItem1aBody = (c: Chunk) => c.section === "item1a" && !looksToc(c.text) && c.text.length > 240;
    // Group candidate body chunks by source document.
    const byDoc = new Map<number, { idxs: number[]; url: string; title: string }>();
    docChunks.forEach((c, i) => {
      if (!isItem1aBody(c)) return;
      if (!isAnnualFiling(c.docUrl || "", c.docTitle || "")) return;
      const e = byDoc.get(c.docIndex) || { idxs: [], url: c.docUrl || "", title: c.docTitle || "" };
      e.idxs.push(i);
      byDoc.set(c.docIndex, e);
    });
    // Pick the best annual filing: prefer non-proxy, most recent (YYYYMMDD token),
    // then EDGAR-primary, then most body chunks.
    // v3k-r3 FIX: derive the filing date ROBUSTLY. The prior regex matched any
    // "20\d{2}" substring, so Apple's 2016 10-K filename a201610-k9242016.htm with
    // accession folder ...016020309 produced a SPURIOUS 2030 date that beat the
    // real aapl-20250927, and the grader received the 8-year-old filing. We now:
    //   1) prefer the canonical EDGAR/IR document-name date <name>-YYYYMMDD.(htm|pdf)
    //      or a yyyy-mm-dd token in the path (the true period-end / filing date);
    //   2) only then fall back to a VALIDATED 8-digit YYYYMMDD (month<=12, day<=31)
    //      to reject accession-number garbage like 20300000.
    const validYmd = (v: number): boolean => {
      if (v < 19900101 || v > 20401231) return false;
      const mo = Math.floor((v % 10000) / 100), da = v % 100;
      return mo >= 1 && mo <= 12 && da >= 1 && da <= 31;
    };
    const dateOf = (s: string) => {
      const hay = (s || "").toLowerCase();
      // (1) canonical filing-document name: ...-YYYYMMDD.htm/.pdf
      let best = 0;
      for (const m of hay.matchAll(/[a-z]+-?(20\d{6})\.(?:htm|pdf)/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
      // (1b) yyyy-mm-dd anywhere in the path (IR PDF mirrors)
      if (best === 0) for (const m of hay.matchAll(/(20\d{2})-(\d{2})-(\d{2})/g)) { const v = parseInt(m[1] + m[2] + m[3], 10); if (validYmd(v) && v > best) best = v; }
      // (2) validated bare 8-digit token
      if (best === 0) for (const m of hay.matchAll(/(20\d{6})/g)) { const v = parseInt(m[1], 10); if (validYmd(v) && v > best) best = v; }
      // (3) last-resort year only (avoids accession garbage by capping month/day to 00)
      if (best === 0) for (const m of hay.matchAll(/\b(20[12]\d)\b/g)) { const v = parseInt(m[1] + "0000", 10); if (v > best) best = v; }
      return best;
    };
    const strongProxyRe = /stockholder proposal|say-on-pay|notice of (the )?annual meeting|proxy card|broker non-votes|nominees? for (election|director)|compensation discussion and analysis/gi;
    // v3j-r5 FIX (Meta/Oracle): EXCLUDE 10-Q / quarterly reports from annual-filing
    // selection. A 10-Q's EDGAR URL (e.g. meta-20260331.htm, period 2026-03-31)
    // matches the -YYYYMMDD.htm / edgar-archive shape just like a 10-K, and its
    // period date is NEWER than the most recent 10-K (meta-20251231), so the
    // recency sort picked the QUARTERLY filing and the grader narrated a 10-Q as
    // "the most recent annual filing" -- Item 1A risk factors live in the 10-K, not
    // the 10-Q. URL/title alone cannot distinguish them for issuers whose EDGAR
    // titles are a bare "meta-YYYYMMDD - SEC.gov", so we detect the form type from
    // the COVER-PAGE language carried in the document's own chunks: a 10-Q says
    // "QUARTERLY REPORT PURSUANT TO SECTION 13" / "for the quarterly period ended",
    // a 10-K says "ANNUAL REPORT PURSUANT TO SECTION 13" / "for the fiscal year
    // ended". We aggregate these markers across ALL of a candidate document's
    // chunks (the cover page is its own chunk, distinct from the Item 1A body) and
    // drop any document whose QUARTERLY markers are present without a stronger
    // ANNUAL marker.
    const quarterlyRe = /quarterly report pursuant to section 13|for the quarterly period ended|\bform 10-q\b/gi;
    const annualRe = /annual report pursuant to section 13|for the fiscal year ended|\bform 10-k\b/gi;
    // v3j-r7 FIX (Oracle 10-Q): the DEFINITIVE cover page of an SEC periodic filing
    // co-locates the form token with its statutory caption. ONLY a 10-Q carries
    // "FORM 10-Q" next to "QUARTERLY REPORT PURSUANT TO SECTION 13"; ONLY a 10-K
    // carries "FORM 10-K" next to "ANNUAL REPORT PURSUANT TO SECTION 13". These
    // cover markers are authoritative and immune to body cross-references (a 10-Q's
    // body cites "our Annual Report on Form 10-K for the fiscal year ended ..." many
    // times, which previously inflated the annual-marker count and let Oracle's
    // orcl-20250831 10-Q masquerade as an annual filing). We evaluate the cover
    // markers over the JOINED document text so a chunk split between the form token
    // and its caption does not defeat detection.
    const strongQuarterlyCoverRe = /form 10-q[\s\S]{0,400}quarterly report pursuant to section 13|quarterly report pursuant to section 13[\s\S]{0,400}form 10-q/i;
    const strongAnnualCoverRe = /form 10-k[\s\S]{0,400}annual report pursuant to section 13|annual report pursuant to section 13[\s\S]{0,400}form 10-k/i;
    // Map every chunk index to its document so we can scan the WHOLE document
    // (cover page included), not just the reserved Item 1A body chunks.
    const allChunkIdxByDoc = new Map<number, number[]>();
    docChunks.forEach((c, i) => { const a = allChunkIdxByDoc.get(c.docIndex) || []; a.push(i); allChunkIdxByDoc.set(c.docIndex, a); });
    // v3j-r11 FIX (NVIDIA): EXCLUDE DEF 14A proxy statements from annual-filing
    // selection. A proxy (e.g. nvda-20260512.htm) has an EDGAR -YYYYMMDD.htm URL
    // that matches the annual shape, a period date NEWER than the latest 10-K
    // (nvda-20260125), and 20+ "annual report"/"form 10-k" cross-references (a proxy
    // discusses the fiscal year and incorporates the 10-K by reference), so it beat
    // the genuine 10-K on recency and the reserve guaranteed proxy chunks that have
    // only a HEADER reference to Item 1A, never the risk-factor body -> grader
    // returned No/0 quotes. The prior `proxyDom` guard counted boilerplate only over
    // the doc's Item 1A body chunks, of which a proxy has ~none, so it never tripped.
    // The DEFINITIVE proxy signal is the cover/EDGAR form line "DEF 14A" or the
    // statutory caption "Proxy Statement Pursuant to Section 14(a)"; we scan the
    // WHOLE joined document text (cover page included).
    const strongProxyCoverRe = /\bdef[\s\u00a0]*14a\b|proxy statement pursuant to section 14\(a\)|notice of (?:20\d{2} )?annual meeting of (?:stockholders|shareholders)/i;
    const isProxyDoc = (di: number): boolean => {
      const joined = (allChunkIdxByDoc.get(di) || []).map((ix) => docChunks[ix].text).join("\n");
      // A genuine 10-K never carries the DEF 14A cover/caption; if a strong 10-K
      // cover is present, trust it over an incidental proxy cross-reference.
      if (strongAnnualCoverRe.test(joined)) return false;
      return strongProxyCoverRe.test(joined);
    };
    const isQuarterlyDoc = (di: number): boolean => {
      const joined = (allChunkIdxByDoc.get(di) || []).map((ix) => docChunks[ix].text).join("\n");
      // 1) Definitive 10-Q cover page => quarterly outright.
      if (strongQuarterlyCoverRe.test(joined)) return true;
      // 2) Definitive 10-K cover page => annual outright (never exclude).
      if (strongAnnualCoverRe.test(joined)) return false;
      // 3) Fallback marker balance for filings whose cover caption did not survive
      //    (quarterly present and not dominated by annual markers).
      const q = (joined.match(quarterlyRe) || []).length;
      const a = (joined.match(annualRe) || []).length;
      return q > 0 && q >= a;
    };
    const cands = [...byDoc.entries()].map(([di, e]) => {
      let proxyHits = 0;
      for (const ix of e.idxs) proxyHits += (docChunks[ix].text.match(strongProxyRe) || []).length;
      return { di, idxs: e.idxs, url: e.url, title: e.title, rec: dateOf(e.url + " " + e.title), edgar: isEdgarPrimary(e.url), proxyDom: proxyHits >= 10, proxy: isProxyDoc(di), quarterly: isQuarterlyDoc(di) };
    }).filter((c) => {
      if (c.proxyDom) return false;
      if (c.proxy) { console.log(`[${companyName}] [item1a-reserve] excluded DEF 14A proxy doc ${c.url.slice(0,60)} from annual-filing candidates`); return false; }
      if (c.quarterly) { console.log(`[${companyName}] [item1a-reserve] excluded 10-Q/quarterly doc ${c.url.slice(0,60)} from annual-filing candidates`); return false; }
      return true;
    });
    // v3k-r4 FIX (NVIDIA): when two filings fall in the SAME period (<=150 days
    // apart) they are the same annual filing in different sources (e.g. the EDGAR
    // primary nvda-20260125.htm vs the fortune.com .../2026-02-25 PDF mirror of the
    // SAME FY2026 10-K). Prefer the canonical EDGAR-primary HTML so the reserved
    // Item 1A and downstream citations resolve to EDGAR, not a third-party mirror.
    // A genuinely newer filing (outside the window) still wins outright on recency.
    const SAME_PERIOD_DAYS = 150;
    const ord = (v: number): number => { if (v <= 0) return 0; const y = Math.floor(v/10000), mo = Math.floor((v%10000)/100)||1, da = (v%100)||1; return y*365 + mo*30 + da; };
    cands.sort((a, b) => {
      // v3j-r5 FIX (Oracle): a DATELESS third-party mirror (rec=0) must never outrank
      // a DATED filing of the SAME annual report, so citations resolve to the
      // canonical EDGAR HTML rather than a PDF mirror (e.g. stocklight.com).
      const aDateless = a.rec === 0, bDateless = b.rec === 0;
      if (aDateless !== bDateless) return aDateless ? 1 : -1;
      const samePeriod = Math.abs(ord(a.rec) - ord(b.rec)) <= SAME_PERIOD_DAYS || aDateless;
      if (!samePeriod) return b.rec - a.rec;             // clearly newer wins
      if (a.edgar !== b.edgar) return a.edgar ? -1 : 1;  // same period: EDGAR beats mirror
      if (a.rec !== b.rec) return b.rec - a.rec;         // then newer
      if (a.idxs.length !== b.idxs.length) return b.idxs.length - a.idxs.length; // then more body chunks
      return a.di - b.di;
    });
    if (cands.length > 0) {
      const best = cands[0];
      // Reserve earliest body chunks (document order) up to the Item 1A sub-budget.
      const ordered = best.idxs.slice().sort((x, y) => (docChunks[x].seqInDoc ?? x) - (docChunks[y].seqInDoc ?? y));
      let reserved = 0;
      for (const ix of ordered) {
        if (reserved + docChunks[ix].text.length > ITEM1A_RESERVE_CHARS) continue;
        if (!selectedSet.has(ix)) { selectedSet.add(ix); budget += docChunks[ix].text.length; reserved += docChunks[ix].text.length; }
      }
      reservedAnnualUrl = best.url || undefined;
      console.log(`[${companyName}] [item1a-reserve] reserved ${reserved} chars (${ordered.length} body chunks avail) from ${best.url.slice(0,70)}`);
    } else {
      console.log(`[${companyName}] [item1a-reserve] no genuine Item 1A body chunks found among annual filings`);
    }
  } catch (e) {
    console.warn(`[${companyName}] [item1a-reserve] skipped: ${(e as Error).message}`);
  }

  // ─── I59 UPSTREAM GUARANTEE: reserve framework topic-primary chunks ──────────
  // Root cause diagnosed on batch 1098 (JPM fw8 pinned replay): JPM's 6 Modern
  // Slavery Statement PDFs are correctly classified as `topic-primary` (they
  // match framework.requiredDocTypes 'Modern Slavery Statement' etc.) but their
  // chunks lose the 560K-char BM25 pool competition against SEC 10-K chunks and
  // never reach the per-measure BM25 stage. The Item 1A reserve above guarantees
  // SEC filings survive; this reserve does the analogous job for whatever the
  // FRAMEWORK declares as required doc types.
  //
  // Framework-agnostic: driven entirely by framework.requiredDocTypes (data);
  // no topic/company/framework literals in code. Selection is BM25-scored within
  // topic-primary chunks so the most relevant chunks in the highest-precision
  // docs win the sub-budget deterministically.
  //
  // Env-tunable so this can be adjusted per deployment without a code change.
  const TOPIC_PRIMARY_RESERVE_CHARS = parseInt(
    process.env.RETRIEVAL_TOPIC_PRIMARY_RESERVE_CHARS || "120000",
    10,
  );
  try {
    if (TOPIC_PRIMARY_RESERVE_CHARS > 0) {
      // A chunk qualifies for the topic-primary reserve iff its source document
      // is classified as `topic-primary` by EITHER the URL/title classifier
      // (framework.requiredDocTypes token match) OR the content-based promotion
      // (framework.dataPatterns hit density on the doc's aggregated chunk text).
      // The content-based signal catches docs like JPM's Modern Slavery Statement
      // PDFs whose URL+title don't tokenise cleanly against 'Modern Slavery
      // Statement' but whose text fires the framework's dataPatterns dozens of times.
      //
      // Framework-agnostic: dataPatterns are declared by the framework author.
      // Falls through cleanly for frameworks without dataPatterns.
      const CHUNK_LEVEL_CONTENT_PROMOTION_THRESHOLD = 10;
      const perDocText = new Map<number, string>();
      for (const c of docChunks) {
        const prior = perDocText.get(c.docIndex) || "";
        // Cap per-doc aggregated text to keep this cheap; 60k is plenty for pattern hits.
        if (prior.length < 60000) perDocText.set(c.docIndex, prior + " " + c.text);
      }
      const promotedDocIndexes = new Set<number>();
      for (const [dIdx, txt] of perDocText) {
        let hits = 0;
        for (const rx of dataPatternRegexes) {
          rx.lastIndex = 0;
          const m = txt.toLowerCase().match(rx);
          hits += m?.length || 0;
          if (hits >= CHUNK_LEVEL_CONTENT_PROMOTION_THRESHOLD) break;
        }
        if (hits >= CHUNK_LEVEL_CONTENT_PROMOTION_THRESHOLD) promotedDocIndexes.add(dIdx);
      }
      const chunkIsTopicPrimary = (c: Chunk) => {
        if (promotedDocIndexes.has(c.docIndex)) return true;
        return classifyDoc(c.docUrl || "", c.docTitle || "") === "topic-primary";
      };
      // Build a per-doc list of eligible chunk indices with their BM25 scores.
      // Cap the number of chunks per doc so the reserve keeps diversity across
      // multiple topic-primary docs (e.g. 6 MSS PDFs across FY19-FY24 rather than
      // 6 chunks all from the same doc).
      const MAX_CHUNKS_PER_TP_DOC = 4;
      type TpEntry = { idx: number; score: number; len: number; docIndex: number };
      const tpByDoc = new Map<number, TpEntry[]>();
      for (let i = 0; i < docChunks.length; i++) {
        const c = docChunks[i];
        if (!chunkIsTopicPrimary(c)) continue;
        const s = scoredChunks.find((sc) => sc.idx === i);
        const score = s ? s.score : 0;
        const arr = tpByDoc.get(c.docIndex) || [];
        arr.push({ idx: i, score, len: c.text.length, docIndex: c.docIndex });
        tpByDoc.set(c.docIndex, arr);
      }
      // Within each doc, sort by BM25 DESC (deterministic tiebreak by document
      // position) and keep only the top-MAX_CHUNKS_PER_TP_DOC.
      const tpPool: TpEntry[] = [];
      for (const [, list] of tpByDoc) {
        list.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return (docChunks[a.idx].seqInDoc ?? a.idx) - (docChunks[b.idx].seqInDoc ?? b.idx);
        });
        for (const e of list.slice(0, MAX_CHUNKS_PER_TP_DOC)) tpPool.push(e);
      }
      // Global fill order: BM25 DESC, deterministic tiebreak by (docIndex, seqInDoc).
      tpPool.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.docIndex !== b.docIndex) return a.docIndex - b.docIndex;
        return (docChunks[a.idx].seqInDoc ?? a.idx) - (docChunks[b.idx].seqInDoc ?? b.idx);
      });
      let tpReserved = 0;
      const tpDocsUsed = new Set<number>();
      for (const e of tpPool) {
        if (tpReserved + e.len > TOPIC_PRIMARY_RESERVE_CHARS) continue;
        if (selectedSet.has(e.idx)) continue;
        selectedSet.add(e.idx);
        budget += e.len;
        tpReserved += e.len;
        tpDocsUsed.add(e.docIndex);
      }
      if (tpReserved > 0) {
        console.log(`[${companyName}] [topic-primary-reserve] reserved ${tpReserved} chars across ${tpDocsUsed.size} doc(s) (of ${tpPool.length} candidate chunks in ${tpByDoc.size} topic-primary docs)`);
      } else if (tpByDoc.size > 0) {
        console.log(`[${companyName}] [topic-primary-reserve] ${tpByDoc.size} topic-primary docs available but reserve budget=0 (RETRIEVAL_TOPIC_PRIMARY_RESERVE_CHARS=${TOPIC_PRIMARY_RESERVE_CHARS})`);
      } else {
        console.log(`[${companyName}] [topic-primary-reserve] no topic-primary docs available (framework.requiredDocTypes did not match any doc URL/title)`);
      }
    }
  } catch (e) {
    console.warn(`[${companyName}] [topic-primary-reserve] skipped: ${(e as Error).message}`);
  }

  for (const sc of scoredChunks) {
    // Degraded/disabled path: rank == score, so this is identical to the prior
    // `sc.score <= 0` gate. Hybrid path: rank is a positive RRF value, so all
    // chunks are admitted in hybrid order up to the (unchanged) budget.
    if (sc.rank <= 0) continue;
    if (budget + sc.chunk.text.length > MAX_RETRIEVAL_INPUT) break;
    if (selectedSet.has(sc.idx)) continue;
    selectedSet.add(sc.idx);
    budget += sc.chunk.text.length;
  }
  // Fill remaining budget with any not-yet-selected chunks in document order so the
  // pool covers low/zero-BM25 passages too (coverage parity with the old summary).
  if (budget < MAX_RETRIEVAL_INPUT) {
    for (let i = 0; i < docChunks.length; i++) {
      if (selectedSet.has(i)) continue;
      if (budget + docChunks[i].text.length > MAX_RETRIEVAL_INPUT) continue;
      selectedSet.add(i);
      budget += docChunks[i].text.length;
    }
  }
  const selectedIdx: number[] = [...selectedSet].sort((a, b) => a - b); // document/sequence order

  let relevantText = "";
  let lastDocIndex = -1;
  for (const i of selectedIdx) {
    const ch = docChunks[i];
    if (ch.docIndex !== lastDocIndex) {
      const title = ch.docTitle || `Document ${ch.docIndex + 1}`;
      relevantText += ch.docUrl
        ? `\n\n--- DOCUMENT: ${title} [${ch.docUrl}] ---\n\n`
        : `\n\n--- DOCUMENT: ${title} ---\n\n`;
      lastDocIndex = ch.docIndex;
    }
    relevantText += ch.text + "\n\n";
  }

  console.log(`[${companyName}] Header-preserving retrieval corpus: ${relevantText.length} chars (BM25-selected from ${combined.length} total, ${selectedIdx.length} chunks)`);

  // Cache the retrieval corpus (versioned key so old header-lossy summaries are
  // never reused). The model tag documents the new provenance-preserving path.
  await storage.cacheSummary({
    companyId,
    documentHash: docHash,
    summary: relevantText,
    summarizerModel: "bm25-headers-v3l-topicaware",
  });

  return {
    text: relevantText,
    model: "bm25-headers-v3l-topicaware",
    reservedAnnualUrl,
    corpusTopicWarning,
    topicPrimaryDocUrls,
    // PR 1 · Change 1c: surface gate telemetry to the caller when it fired.
    chunkSanityDiagnostics: chunkSanityDiagnostics || undefined,
  };
}

// ─── EX04: document-level completeness re-retrieval ──────────────────────────
// Reserved pseudo-measureId for the document-level (whole-corpus) re-retrieval
// that EX04 fires when a PDF's extraction is a confirmed failed-read. It shares
// the SAME per-batch dedupe registry (RetrievalReviewQueue) as the cell-level
// re-retrieval but under a key that can never equal a real measureId, so the two
// paths never double-fire for the same company and each stays independently
// bounded to one fire per company per batch.
export const DOC_COMPLETENESS_RERETRIEVAL_KEY = "__ex04_doc_completeness__";

/**
 * Pick a representative measure to seed the whole-corpus targeted query.
 * Framework-level and deterministic: the measure with the richest definition
 * text, else the first. Never keyed on company/topic.
 */
function pickRepresentativeMeasure(measures: FrameworkMeasure[]): FrameworkMeasure | undefined {
  if (!measures || measures.length === 0) return undefined;
  const defLen = (m: FrameworkMeasure): number => {
    const mm = m as { substantiveDefinition?: string | null; definition?: string | null; title?: string | null };
    return (mm.substantiveDefinition || mm.definition || mm.title || "").length;
  };
  let best = measures[0];
  let bestLen = defLen(best);
  for (const m of measures) {
    const len = defLen(m);
    if (len > bestLen) { best = m; bestLen = len; }
  }
  return best;
}

/**
 * EX04 — decide whether a company's extraction results warrant ONE document-level
 * targeted re-retrieval, and if so fire it. A confirmed failed-read ('unknown' or
 * 'partial') means absence of evidence is NOT confirmed, so we recover via the
 * SAME runTargetedReretrieval path the cell-level handler uses, bounded by the
 * SAME reviewQueue registry under DOC_COMPLETENESS_RERETRIEVAL_KEY.
 *
 * Invariants (mirrors the cell-level guards exactly):
 *   - skipFetch/replay                                   → never fires.
 *   - retrievalV2/autoReretrieval off, no queue/company  → never fires.
 *   - every doc 'complete'/'empty'                       → never fires (verdict-invariant).
 *   - at most ONE fire per company per batch             → dedupe key + markFired.
 *
 * Exported and dependency-injectable (reretrievalFn) so the behaviour is testable
 * without live discovery/network.
 */
export async function maybeFireDocumentCompletenessReretrieval(
  args: {
    documentCompleteness?: ExtractionCompleteness[];
    reviewQueue?: RetrievalReviewQueue;
    company?: Company;
    framework: Framework;
    measures: FrameworkMeasure[];
    trustedSources?: TrustedSource[];
    issuerProfile?: IssuerProfile;
    existingCorpusText: string;
    existingDocUrls: Set<string>;
    retrievalV2: boolean;
    autoReretrieval: boolean;
    skipFetch?: boolean;
  },
  reretrievalFn: typeof runTargetedReretrieval = runTargetedReretrieval,
): Promise<{ fired: boolean; reason: string; result?: ReretrievalResult }> {
  // (1) Replay / skip-fetch suppression — FIRST, exactly like the cell-level path.
  if (args.skipFetch) return { fired: false, reason: "skipFetch" };
  // (2) Feature + dependency gating — identical to the cell-level eligibility set.
  if (!args.retrievalV2 || !args.autoReretrieval) return { fired: false, reason: "flag-off" };
  if (!args.reviewQueue || !args.company) return { fired: false, reason: "no-queue-or-company" };
  // (3) Only a CONFIRMED failed-read warrants a re-fetch. 'complete'/'empty' never do.
  const needsReretrieval = (args.documentCompleteness ?? []).some(
    (c) => c === "unknown" || c === "partial",
  );
  if (!needsReretrieval) return { fired: false, reason: "no-failed-extraction" };
  // (4) Bound: one fire per company per batch for THIS reason.
  if (args.reviewQueue.hasFired(args.company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY)) {
    return { fired: false, reason: "already-fired" };
  }
  const measure = pickRepresentativeMeasure(args.measures);
  if (!measure) return { fired: false, reason: "no-measure" };
  const company = args.company;
  const result = await reretrievalFn(
    {
      company: {
        id: company.id,
        name: company.name,
        domain: company.domain,
        isin: company.isin,
        ticker: company.ticker,
        sector: company.sector,
        country: company.country,
      },
      measure,
      framework: args.framework,
      trustedSources: args.trustedSources || [],
      issuerProfile: args.issuerProfile,
      existingCorpusText: args.existingCorpusText,
      existingDocUrls: args.existingDocUrls,
      fingerprintKey: `${company.id}:${DOC_COMPLETENESS_RERETRIEVAL_KEY}`,
    },
    args.reviewQueue.getFiredSet(),
  );
  // Belt-and-braces bound: runTargetedReretrieval already adds the fingerprintKey
  // to the shared set, but mark explicitly too so the one-per-company guard holds
  // regardless of the injected fn's behaviour.
  args.reviewQueue.markFired(company.id, DOC_COMPLETENESS_RERETRIEVAL_KEY);
  return { fired: true, reason: "fired", result };
}

// ─── Main Analysis Entry Point ───────────────────────────────────────────────

export async function analyzeCompanyMeasures(opts: {
  workspaceId: number;
  companyName: string;
  companyId: number;
  documentTexts: string[];
  documentUrls: string[];
  documentTitles?: string[];
  // Opt2 corpus hygiene: optional DB document ids, positionally aligned with
  // documentTexts/Urls/Titles. Threaded from callers so dropped near-duplicate /
  // stale documents can be logged by id (falls back to url when absent).
  documentIds?: number[];
  framework: Framework;
  measures: FrameworkMeasure[];
  temporalContext?: { withdrawals: Array<{ type: string; description: string; affectedTopics: string[]; detectedDate: string | null; confidence: string }>; temporalWarning: string | null };
  // v3e (Section 4): per-run opt-out of the verdict cache for variability studies.
  freshScoring?: boolean;
  // PR 1 · Change 1c: threaded from pipeline.ts (discoveryResult.issuerProfile) so
  // the pre-BM25 chunk sanity gate inside summarizeDocuments can drop wrong-
  // entity / deep-vintage doc chunks before they reach the candidate pool.
  // Optional — gate is inert when absent.
  issuerProfile?: IssuerProfile;
  // PR 1 · Change 4: per-batch dedupe registry for auto re-retrieval. When
  // absent, re-retrieval is disabled regardless of the autoReretrieval flag.
  // Instantiated ONCE at runAnalysisPipeline scope; caps re-retrieval at 1
  // per (companyId, measureId) per batch.
  reviewQueue?: RetrievalReviewQueue;
  // PR 1 · Change 4: full company row for the targeted query — discovery
  // needs id/name/domain/isin/ticker/sector/country to rank + verify. Optional;
  // when absent, re-retrieval is skipped (falls back to legacy Low-confidence
  // handling).
  company?: Company;
  // PR 1 · Change 4: trusted-source list, threaded through so re-retrieval
  // uses the same discovery configuration as the original fetch phase.
  trustedSources?: TrustedSource[];
  // PR 1 · Change 4: signals a replay / cached-corpus run — network calls on
  // replay would defeat determinism, so re-retrieval is suppressed regardless
  // of flags.
  skipFetch?: boolean;
  // EX04: completeness labels for the company's accepted documents (from
  // extraction_state, threaded by the pipeline). A confirmed failed-read
  // ('unknown'/'partial') anywhere in this list routes the company to ONE
  // document-level targeted re-retrieval. Order-independent (only presence of a
  // failed-read matters). Absent on replay/skip-fetch; re-retrieval is suppressed
  // there regardless. Framework-level — never keyed on company/topic/measure.
  documentCompleteness?: ExtractionCompleteness[];
}): Promise<AnalysisResult> {
  const { workspaceId, companyName, companyId, documentIds, framework, measures, temporalContext, freshScoring, issuerProfile, reviewQueue, company, trustedSources, skipFetch, documentCompleteness } = opts;
  // Opt2 hygiene may reassign these three, so bind them mutably (positionally aligned).
  let { documentTexts, documentUrls, documentTitles } = opts;

  // Load settings fresh for every analysis call
  const settings = await loadAnalysisSettings(workspaceId);

  console.log(`[${companyName}] Starting analysis: ${measures.length} measures, ${documentTexts.length} documents`);

  // ─── Opt2: Corpus hygiene (near-duplicate dedup + recency filter) ───────────
  // Generic, jurisdiction-agnostic cleanup of the loaded corpus BEFORE chunking,
  // translation, terminology, summarization and pack assembly consume it. Removes
  // near-duplicate copies (e.g. the same ESEF/iXBRL year-package under several
  // URLs) and stale versions of the same versioned report, keeping the newest.
  // Corpus-input only: does NOT touch scoring, the rubric, provenance filtering
  // or the DB. Conservative by design (never drops the single most-recent primary
  // of a type). Default ON; disable with CORPUS_HYGIENE="false".
  if (isCorpusHygieneEnabled()) {
    const beforeCount = documentTexts.length;
    const inputDocs: HygieneDoc[] = documentTexts.map((text, i) => ({
      id: documentIds?.[i],
      url: documentUrls[i] || "",
      title: documentTitles?.[i] || documentUrls[i] || "",
      text: text || "",
    }));
    const { kept, dropped } = applyCorpusHygiene(inputDocs);
    if (dropped.length > 0) {
      for (const d of dropped) {
        console.log(
          `[${companyName}] corpus-hygiene dropped id=${d.id ?? "n/a"} url=${d.url} reason=${d.reason}`
        );
      }
      documentTexts = kept.map((d) => d.text);
      documentUrls = kept.map((d) => d.url);
      documentTitles = kept.map((d) => d.title);
      const nearDup = dropped.filter((d) => d.reason === "near-duplicate").length;
      const stale = dropped.filter((d) => d.reason === "stale-version").length;
      console.log(
        `[${companyName}] corpus-hygiene: ${beforeCount} -> ${documentTexts.length} documents ` +
        `(dropped ${dropped.length}: ${nearDup} near-duplicate, ${stale} stale-version)`
      );
    } else {
      console.log(`[${companyName}] corpus-hygiene: no documents dropped (${beforeCount} documents)`);
    }
  }

  // v3e (Section 3): determine which broad SOURCE TYPES the corpus actually
  // contains (topic-agnostic). Measures that declare requiredSourceTypes none of
  // which are present will be ABSTAINED ("Insufficient evidence") rather than
  // scored a hard "No", and excluded from the answered-measures denominator.
  const declaredSourceTypes = Array.from(new Set(
    measures.flatMap((measure) => ((measure as any).requiredSourceTypes || []) as string[])
  ));
  const availableSourceTypes = corpusSourceTypes(
    (documentUrls || []).map((url, idx) => ({ url, title: documentTitles?.[idx] || "" })),
    declaredSourceTypes,
  );
  console.log(`[${companyName}] Corpus source types: [${Array.from(availableSourceTypes).join(", ") || "none"}]`);

  // v3e (Section 4): verdict cache (opt-in, ON by default). When enabled and not
  // explicitly bypassed via freshScoring, load any prior verdicts so measures with
  // an IDENTICAL evidence fingerprint can reuse the prior verdict (reproducibility).
  const verdictCacheEnabled = settings.verdictCacheEnabled && !freshScoring;
  let priorScoresByMeasure: Map<string, any> | null = null;
  if (verdictCacheEnabled) {
    try {
      const prior = await storage.getMeasureScores(companyId, framework.id);
      if (prior && prior.length > 0) {
        priorScoresByMeasure = new Map(prior.map((p: any) => [p.measureId, p]));
        console.log(`[${companyName}] Verdict cache: loaded ${prior.length} prior verdict(s) for fingerprint comparison`);
      }
    } catch (e: any) {
      console.warn(`[${companyName}] Verdict cache: could not load prior scores: ${e?.message}`);
    }
  } else {
    console.log(`[${companyName}] Verdict cache: DISABLED (${freshScoring ? "freshScoring opt-out" : "setting off"}) — fresh scoring`);
  }

  // Stage: Multilingual translation (DeepSeek). Translate only the foreign-
  // language portions of fetched documents to English BEFORE terminology,
  // summarization, BM25 retrieval, and the English topic-floor run — so the
  // whole downstream pipeline operates over English while originals are
  // preserved inline for audit. English documents pass through untouched.
  let workingTexts = documentTexts;
  try {
    const tr = await translateDocumentsToEnglish(documentTexts);
    workingTexts = tr.texts;
    if (tr.translatedCount > 0) {
      console.log(`[${companyName}] Multilingual: translated ${tr.translatedCount}/${documentTexts.length} document(s) to English (${tr.charsTranslated} chars via DeepSeek)`);
    }
  } catch (trErr: any) {
    console.warn(`[${companyName}] Multilingual translation skipped: ${trErr?.message}`);
  }

  // Stage: Terminology discovery
  let terminology: TerminologyMap | undefined;
  if (settings.terminologyDiscoveryEnabled) {
    terminology = await discoverCompanyTerminology({
      companyName,
      companyId,
      frameworkId: framework.id,
      topicDescription: framework.topicDescription || framework.name,
      documentTexts: workingTexts,
    });
  }

  // Stage: Summarization / raw-pass (operates over translated workingTexts)
  const totalChars = workingTexts.reduce((sum, t) => sum + t.length, 0);
  let combinedText: string;
  let summarizerModel: string;
  // v3j-r12 FIX (NVIDIA): the annual-filing URL chosen by the upstream item1a-reserve
  // (over the full uncompressed corpus). Threaded into the category/deep pack builders
  // so the per-measure force-include anchors on the SAME doc, not a compressed-view
  // re-derivation that a DEF 14A proxy could win.
  let reservedAnnualUrl: string | undefined;
  // I60: URLs of docs classified as topic-primary by the summarizer (via
  // framework.requiredDocTypes URL/title match or framework.dataPatterns content
  // hits). Threaded to buildEvidencePacksForCategory so per-measure retrieval
  // can force-include chunks from these docs (analogous to Item 1A reserve).
  let topicPrimaryDocUrls: string[] | undefined;

  if (settings.useBm25Retrieval && totalChars <= settings.bm25SkipSummarizationBelowChars) {
    // BM25-skip path: use raw text directly with document title headers
    combinedText = workingTexts.map((text, idx) => {
      const title = documentTitles?.[idx] || documentUrls[idx] || `Document ${idx + 1}`;
      const url = documentUrls[idx] || "";
      return `\n\n--- DOCUMENT: ${title} [${url}] ---\n\n${text}`;
    }).join("");
    summarizerModel = "bm25-direct";
    // BM25-skip path: no summarizer classifier ran. Compute a lightweight
    // topic-primary URL set here so per-measure force-include still works for
    // small corpora. Uses the SAME classifyDoc heuristic as the summarizer, plus
    // content-based promotion via dataPatterns.
    try {
      const dataPatterns = ((framework as any).dataPatterns as string[] | null) || [];
      const dataPatternRegexes = dataPatterns
        .map((p: string) => { try { return new RegExp(p, "gi"); } catch { return null; } })
        .filter((r): r is RegExp => r !== null);
      const requiredDocTypes = ((framework as any).requiredDocTypes as string[] | null) || [];
      const CONTENT_PROMOTION_THRESHOLD = 10;
      const tpUrls: string[] = [];
      for (let i = 0; i < documentUrls.length; i++) {
        const url = documentUrls[i] || "";
        const title = documentTitles?.[i] || "";
        const text = workingTexts[i] || "";
        const haystack = (url + " " + title).toLowerCase();
        let isPrimary = false;
        // URL/title token match against requiredDocTypes.
        for (const docType of requiredDocTypes) {
          const words = docType.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
          if (words.length === 0) continue;
          const matched = words.filter((w) => haystack.includes(w)).length;
          if (matched >= Math.min(2, words.length)) { isPrimary = true; break; }
        }
        // Content-based promotion via dataPatterns.
        if (!isPrimary && dataPatternRegexes.length > 0) {
          let hits = 0;
          const lower = text.toLowerCase();
          for (const rx of dataPatternRegexes) {
            rx.lastIndex = 0;
            const m = lower.match(rx);
            hits += m?.length || 0;
            if (hits >= CONTENT_PROMOTION_THRESHOLD) { isPrimary = true; break; }
          }
        }
        if (isPrimary && url) tpUrls.push(url);
      }
      topicPrimaryDocUrls = tpUrls;
    } catch (e) {
      console.warn(`[${companyName}] topic-primary URL derivation (bm25-skip) failed: ${(e as Error).message}`);
    }
    console.log(`[${companyName}] BM25-skip path (${totalChars} chars < ${settings.bm25SkipSummarizationBelowChars}) topicPrimary=${topicPrimaryDocUrls?.length ?? 0}`);
  } else {
    const result = await summarizeDocuments({
      companyName,
      companyId,
      documentTexts: workingTexts,
      documentUrls,
      documentTitles,
      topicDescription: framework.topicDescription || framework.name,
      framework,
      // PR 1 · Change 1c: enable the pre-BM25 sanity gate when both the retrieval
      // feature flag is on and an issuerProfile is available. Backward-compat:
      // when either is missing the gate is inert and docChunks is untouched.
      retrievalV2: settings.retrievalV2,
      issuerProfile,
    });
    combinedText = result.text;
    summarizerModel = result.model;
    reservedAnnualUrl = result.reservedAnnualUrl;
    topicPrimaryDocUrls = result.topicPrimaryDocUrls;
    // PR 1 · Change 1c: log a per-company gate summary (or absence) alongside the
    // existing summarizer log. Diagnostic-only; not persisted to a new column.
    if (result.chunkSanityDiagnostics) {
      const g = result.chunkSanityDiagnostics;
      const rejectedChunks = g.rejected.reduce((a, r) => a + r.chunkCount, 0);
      const softChunks = g.softFlagged.reduce((a, r) => a + r.chunkCount, 0);
      const byReason: Record<string, number> = {};
      for (const r of g.rejected) byReason[r.reason] = (byReason[r.reason] || 0) + r.chunkCount;
      for (const r of g.softFlagged) byReason[r.reason] = (byReason[r.reason] || 0) + r.chunkCount;
      console.log(`[${companyName}] Change 1c gate summary: rejected=${rejectedChunks} chunks / ${g.rejected.length} docs, softFlagged=${softChunks} chunks / ${g.softFlagged.length} docs, byReason=${JSON.stringify(byReason)}`);
    }
    console.log(`[${companyName}] Summarized via ${summarizerModel} (${combinedText.length} chars)${reservedAnnualUrl ? ` reservedAnnual=${reservedAnnualUrl.slice(0,70)}` : ""} topicPrimary=${topicPrimaryDocUrls?.length ?? 0}`);
  }

  // Layer B/D — derive the framework's topic lexicon and measure how much
  // topic-relevant evidence the corpus actually contains. TOPIC-AGNOSTIC: the
  // lexicon is expanded from the framework's own topic description + measure
  // wording (LLM-backed, cached per framework), so retrieval works for ANY topic
  // and catches issuers that use adjacent vocabulary (e.g. "machine learning" /
  // "generative AI" for an AI framework). Falls back to deterministic tokens.
  const deterministicTerms = deriveTopicTerms(framework.topicDescription || undefined, framework.name);
  let topicTerms = deterministicTerms;
  try {
    const lex = await deriveTopicLexicon({
      frameworkId: framework.id,
      workspaceId,
      topicDescription: framework.topicDescription,
      frameworkName: framework.name,
      measureTitles: measures.map((m) => `${m.title}${m.definition ? " — " + m.definition : ""}`),
    });
    if (lex.terms.length > 0) {
      topicTerms = [...new Set([...lex.terms, ...deterministicTerms])];
      console.log(`[${companyName}] Topic lexicon (${lex.source}): ${lex.terms.length} framework terms + ${deterministicTerms.length} deterministic -> ${topicTerms.length} total`);
    }
  } catch (lexErr: any) {
    console.warn(`[${companyName}] Topic lexicon derivation failed, using deterministic terms: ${lexErr?.message}`);
  }
  const corpusTopicStats = computeCorpusTopicStats(combinedText, topicTerms);
  console.log(`[${companyName}] Corpus topic evidence: ${corpusTopicStats.topicChunks}/${corpusTopicStats.totalChunks} chunks contain topic terms (${corpusTopicStats.topicHits} hits)`);

  // PR 1 · Change 4: dedupe set of URLs already in the analyzed corpus. Built
  // ONCE per call (not per measure) and passed into every runTargetedReretrieval
  // invocation so newly-discovered candidates whose URL matches an existing doc
  // are dropped without a fetch. Undefined URLs are skipped (guard for exotic
  // corpus rows lacking a stable URL).
  const existingDocUrlSet = new Set<string>();
  for (const u of documentUrls) {
    if (u) existingDocUrlSet.add(u);
  }

  // ─── EX04: document-level completeness re-retrieval ─────────────────────────
  // A confirmed failed-read PDF (completeness 'unknown'/'partial') means the
  // absence of evidence is NOT confirmed. Fire ONE targeted re-retrieval for the
  // company (bounded via the same reviewQueue registry under a reserved key) and
  // merge any recovered documents into the corpus BEFORE per-measure scoring, so
  // every measure sees the recovered evidence. 'complete'/'empty' never fire, and
  // skipFetch/replay is fully suppressed inside the helper. Framework-level.
  try {
    const ex04 = await maybeFireDocumentCompletenessReretrieval({
      documentCompleteness,
      reviewQueue,
      company,
      framework,
      measures,
      trustedSources,
      issuerProfile,
      existingCorpusText: combinedText,
      existingDocUrls: existingDocUrlSet,
      retrievalV2: settings.retrievalV2,
      autoReretrieval: settings.autoReretrieval,
      skipFetch,
    });
    if (
      ex04.fired &&
      ex04.result?.reason === "success" &&
      ex04.result.augmentedCorpusText &&
      ex04.result.newDocsAdded > 0
    ) {
      combinedText = ex04.result.augmentedCorpusText;
      for (const d of ex04.result.newDocs ?? []) {
        if (d.url) existingDocUrlSet.add(d.url);
      }
      console.log(`[${companyName}] EX04 doc-completeness re-retrieval merged ${ex04.result.newDocsAdded} recovered doc(s) into corpus`);
    }
  } catch (ex04Err: unknown) {
    if (isLifecycleCancelledError(ex04Err)) throw ex04Err;
    console.warn(`[${companyName}] EX04 doc-completeness re-retrieval error: ${ex04Err instanceof Error ? ex04Err.message : String(ex04Err)}`);
  }

  // A3 / R5c: ONE IR-platform tenant-propagation cache per company, created
  // outside the per-measure loop and shared across every measure's cell-level
  // eligibility composition. Effect: once ANY source (on ANY measure) confirms
  // this issuer's IR-platform tenant (via title/URL/content/full-name identity),
  // sibling URLs on the same tenant — on this or any OTHER measure — are accepted
  // without re-establishing identity. Framework-level and company-agnostic: it
  // holds only tenant bindings earned at runtime from the sources themselves,
  // never any per-company seed data.
  const companyIrTenantCache = new Map<string, IrTenantBinding>();

  // Group measures by category
  const categoryMap = new Map<string, FrameworkMeasure[]>();
  for (const measure of measures) {
    const key = measure.category;
    if (!categoryMap.has(key)) categoryMap.set(key, []);
    categoryMap.get(key)!.push(measure);
  }

  // Stage: Score each category
  const allResults: MeasureResult[] = [];
  const scoringProvider = settings.scoringProvider;

  // R4 (2026-09): run-level empty-corpus accounting. Every category's packs
  // are inspected; the run is flagged emptyCorpus.isEmpty only when EVERY pack
  // across ALL measures is an empty-corpus sentinel (0 usable chunks). This is
  // the LOUD signal consumed by the pipeline / auto-rerun.
  const loudEmptyCorpusEnabled = process.env.LOUD_EMPTY_CORPUS !== "false";
  let r4TotalPacks = 0;
  let r4EmptyCorpusPacks = 0;
  let r4EmptyCorpusReason = "";

  for (const [category, categoryMeasures] of categoryMap) {
    console.log(`[${companyName}] Scoring category: ${category} (${categoryMeasures.length} measures)`);

    // Build evidence packs via BM25
    let evidencePacks: Array<{ measureId: string; text: string; topicHits?: number; fingerprint?: string; fingerprintEligible?: boolean; forceIncludedCount?: number; requiredDocPresent?: boolean; forceIncludedDocUrl?: string; passageDiagnostics?: { topChunks: Array<{ docUrl: string | null; docTitle: string | null; seqInDoc: number | null; score: number; textPreview: string; forced: boolean }>; docBreakdown: Array<{ docUrl: string | null; chunkCount: number }>; queryTermCount: number } }>;
    if (settings.useBm25Retrieval) {
      evidencePacks = buildEvidencePacksForCategory({
        measures: categoryMeasures,
        combinedText,
        terminology,
        topicTerms,
        companyId,          // v3g (Bug 1): collision-free fingerprint identity
        frameworkId: framework.id,
        // v3j-r12 FIX (NVIDIA): anchor the per-measure annual-filing force-include on
        // the SAME document the upstream item1a-reserve chose, instead of re-deriving
        // it on the compressed corpus (where a DEF 14A proxy could win).
        reservedAnnualUrl,
        // I60: URLs of docs the summarizer classified as topic-primary (framework
        // requiredDocTypes URL/title match OR dataPatterns content promotion).
        // Per-measure retrieval force-includes chunks from these docs so the LLM
        // sees framework-authoritative content instead of only bulk filings.
        topicPrimaryDocUrls,
      });

      // I69: Optional LLM passage rescoring layered on top of BM25. Env-gated.
      // Truth-baseline validation (2026-08-24) showed 100% precision / 26% recall
      // on fw9 batch 1109 — the definitive-evidence passages are in the corpus
      // but lose BM25 to keyword-dense-but-content-thin chunks. LLM rescoring
      // re-ranks the top-30 BM25 candidates by evidentiary relevance to each
      // measure's YES rule, blending back into a final pack. Framework-agnostic:
      // uses only measure.title/definition/scoringGuidance. See passage-rescore.ts.
      const { rescorePacksForCategory, isRescoreEnabled } = await import("./passage-rescore.js");
      if (isRescoreEnabled()) {
        console.log(`[${companyName}] LLM rescoring: ON for ${categoryMeasures.length} measures in category '${category}'`);
        // I74: pass through env-driven budgets rather than hardcoding, so
        // RETRIEVAL_EVIDENCE_MAX_CHARS / RETRIEVAL_EVIDENCE_TOP_K govern both
        // the initial pack builder and the rescorer.
        // B3 (retrieval recall): defaults raised (top-k 30→45, max-chars 30000→45000)
        // to favour recall so genuinely on-topic evidence is less likely to be cut
        // before scoring. Still env-overridable.
        const _rescBudgetChars = parseInt(process.env.RETRIEVAL_EVIDENCE_MAX_CHARS || "45000", 10);
        const _rescBudgetChunks = parseInt(process.env.RETRIEVAL_EVIDENCE_TOP_K || "45", 10);
        evidencePacks = await rescorePacksForCategory(evidencePacks as any, categoryMeasures, combinedText, _rescBudgetChars, _rescBudgetChunks, topicPrimaryDocUrls);
      }
    } else {
      // No BM25: use full text for all measures
      const fullSlice = combinedText.slice(0, 10000);
      const sliceHits = computeCorpusTopicStats(fullSlice, topicTerms).topicHits;
      evidencePacks = categoryMeasures.map((m) => ({
        measureId: m.measureId,
        text: fullSlice,
        topicHits: sliceHits,
      }));
    }

    // R4: tally empty-corpus sentinel packs for this category into the
    // run-level accumulator (a sentinel pack carries passageDiagnostics.emptyCorpus).
    if (loudEmptyCorpusEnabled) {
      for (const ep of evidencePacks) {
        r4TotalPacks++;
        const pd: any = (ep as any).passageDiagnostics;
        if (pd?.emptyCorpus === true) {
          r4EmptyCorpusPacks++;
          if (!r4EmptyCorpusReason) r4EmptyCorpusReason = pd.emptyCorpusReason || "empty_corpus";
        }
      }
    }

    // Shared corpus index for the targeted deep-read second pass (built once per
    // category, reused across measures). Only built when BM25 retrieval is on.
    let deepChunks: Chunk[] | null = null;
    let deepBm25Index: ReturnType<typeof buildBM25Index> | null = null;
    const buildDeepIndex = () => {
      if (deepChunks === null) {
        deepChunks = chunkDocuments(combinedText);
        deepBm25Index = buildBM25Index(deepChunks.map((c) => c.text));
      }
    };

    // Deep-read budget (env-tunable). Much larger than the normal per-measure
    // budget; used only for measures that came back under-evidenced.
    const DEEP_TOP_K = parseInt(process.env.RETRIEVAL_DEEPREAD_TOP_K || "40", 10);
    const DEEP_MAX_CHARS = parseInt(process.env.RETRIEVAL_DEEPREAD_MAX_CHARS || "40000", 10);
    const DEEPREAD_ENABLED = (process.env.RETRIEVAL_DEEPREAD_ENABLED || "true").toLowerCase() !== "false";

    // Score measures in parallel (batch of 5 concurrent)
    const MEASURE_CONCURRENCY = 5;
    const scoreMeasure = async (measure: FrameworkMeasure): Promise<MeasureResult> => {
      const evidencePack = evidencePacks.find((e) => e.measureId === measure.measureId);
      const evidenceText = evidencePack?.text || "";

      // v3e (Section 3): ABSTAIN GATE. If this measure declares requiredSourceTypes
      // and NONE of them are present in the corpus, we cannot answer it — emit an
      // "Insufficient evidence" verdict (abstained) instead of a misleading hard
      // "No". Abstained measures are excluded from the answered-measures denominator
      // downstream. TOPIC-AGNOSTIC: requiredSourceTypes are framework-authored
      // document categories, so this behaves correctly for any framework.
      const required = ((measure as any).requiredSourceTypes as string[] | null | undefined) || [];
      if (Array.isArray(required) && required.length > 0) {
        const satisfied = required.some((t) => availableSourceTypes.has(t));
        if (!satisfied) {
          console.log(`[${companyName}] ABSTAIN ${measure.measureId}: requires [${required.join(", ")}], corpus has none`);
          return {
            measureId: measure.measureId,
            title: measure.title,
            definition: measure.definition,
            category: measure.category,
            categoryNumber: measure.categoryNumber,
            score: 0,
            coverage: "none",
            confidence: "Low",
            evidenceSummary: `Insufficient evidence: this measure requires source type(s) [${required.join(", ")}], none of which were found in the company's available documents. Excluded from the answered-measures denominator rather than scored "No".`,
            quotes: [],
            verdict: "Insufficient evidence",
            verdictNuance: "Abstained — required source type absent from corpus (not a substantive No).",
            displayOrder: measure.displayOrder,
            abstained: true,
            evidenceFingerprint: null,
          };
        }
      }

      // Fallback: if BM25 retrieval returns < 1000 chars, do NOT dump generic
      // corpus text. The old approach (combinedText.slice(0, 10000)) fed non-topic
      // text to the scorer, causing false positives when general governance language
      // was conflated with topic-specific evidence. Instead, keep the thin evidence
      // as-is — the scorer will see insufficient evidence and score accordingly.
      // The deep-read second pass (below) handles the genuine under-evidenced case
      // where topic content exists in the corpus but wasn't surfaced by normal BM25.
      // ── Group C (B4): cache the assembled evidence pack (A5 expansion + B5 trim) ──
      // DEFAULT CACHE_LAYER_POLICY "off" ⇒ provable pass-through: cacheEvidencePack
      // just awaits the compute closure, so the A5/B5 result is byte-identical to
      // before. Under "on" an identical {company, measure, base-pack, policies} key
      // serves the stored pack. The compute closure holds the ENTIRE A5+B5 logic
      // unchanged (only the local pack variable is renamed from finalEvidence).
      let finalEvidence = await cacheEvidencePack<string>({
        workspaceId: company?.id ?? companyId ?? "shared",
        dependencyHashes: [sha256Hex(evidenceText)],
        extra: {
          measureId: measure.measureId,
          recallPolicy: resolveRecallExpansionPolicy(),
          contextCostPolicy: resolveContextCostPolicy(),
        },
        compute: async (): Promise<string> => {
          let pack = evidenceText;

      // ── A5 / WP06: bounded evidence-pack recall expansion (kill-switch gated) ──
      // DEFAULT = "on" (post-GATE5): this block runs and APPENDS a BOUNDED set of
      // eligible decisive passages that the corpus contains but the budgeted pack
      // missed — append-only (never shrinks top-k or pack length, never reorders),
      // composes with A3 (excluded material is never reintroduced), and
      // framework-level (zero per-company/per-topic logic). Override via env:
      // "off" skips this entire block (byte-identical pre-A5 pack, no extra work);
      // "shadow" computes recall telemetry WITHOUT changing the pack (verdict-invariant).
      const recallPolicy = resolveRecallExpansionPolicy();
      if (recallPolicy !== "off" && settings.useBm25Retrieval && evidenceText) {
        try {
          buildDeepIndex();
          const corpusChunks: Chunk[] = deepChunks || [];
          // Membership: which full-corpus chunks actually reached THIS pack. The
          // pack text is assembled verbatim from selected chunk texts, so a chunk
          // is in the pack iff its exact text is a substring of the pack text.
          const packChunks = corpusChunks.filter((c) => c.text && evidenceText.includes(c.text));
          const packIds = new Set(packChunks.map((c) => stablePassageId(c)));
          const decisive = computeDecisivePassages({ measure, chunks: corpusChunks });
          const recall = measurePackRecall({ decisive, packPassageIds: packIds });
          // A3-COMPOSING eligibility predicate: a candidate chunk is eligible unless
          // A3 marks its (url,title,content) source EXCLUDED for this company — so
          // expansion can NEVER reintroduce what A3 excluded (RT04). Fail-open on
          // predicate error so a defect can only reduce to current behaviour.
          //
          // Group C (B4): the A3 decision for each candidate is routed through the
          // eligibility layer cache (cacheEligibilityDecision). DEFAULT "off" ⇒
          // pass-through (composeEligibilityDecision runs exactly as before); under
          // "on" an identical {company, source} decision is served. Decisions are
          // precomputed for the exact miss-chunks planBoundedExpansion evaluates,
          // then read by the SYNCHRONOUS predicate the planner requires.
          const corpusById = new Map<string, Chunk>();
          for (const c of corpusChunks) corpusById.set(stablePassageId(c), c);
          const eligibilityByChunkId = new Map<string, boolean>();
          for (const miss of recall.misses) {
            const chunk = corpusById.get(miss.id);
            if (!chunk) continue;
            const eligInput = {
              target: {
                id: company?.id ?? companyId ?? null,
                name: company?.name || companyName,
                ticker: company?.ticker ?? null,
                domain: company?.domain ?? null,
                relatedDomains: company?.relatedDomains ?? null,
                isin: company?.isin ?? null,
              },
              source: {
                url: chunk.docUrl ?? null,
                title: chunk.docTitle ?? null,
                content: chunk.text ?? null,
              },
              knownIrTenants: companyIrTenantCache,
            };
            let eligible = true;
            try {
              const d = await cacheEligibilityDecision<EligibilityDecision>({
                workspaceId: company?.id ?? companyId ?? "shared",
                dependencyHashes: [sha256Hex(miss.id)],
                extra: eligInput,
                compute: () => composeEligibilityDecision(eligInput),
              });
              eligible = d.status !== "excluded";
            } catch {
              eligible = true;
            }
            eligibilityByChunkId.set(miss.id, eligible);
          }
          const isEligible = (chunk: Chunk): boolean =>
            eligibilityByChunkId.get(stablePassageId(chunk)) ?? true;
          const plan = planBoundedExpansion({
            misses: recall.misses,
            chunks: corpusChunks,
            packPassageIds: packIds,
            packChunks,
            measure,
            isEligible,
          });
          if (recallPolicy === "on" && plan.fired) {
            // ENFORCE: append-only. pack grows; the original pack is intact.
            pack = evidenceText + formatExpansionAppend(plan);
            console.log(
              `[${companyName}] A5-EXPAND ${measure.measureId}: recall ${(recall.recall * 100).toFixed(0)}% ` +
                `(+${plan.added.length} passage(s), +${plan.addedChars} chars) ${plan.reason}`,
            );
          } else {
            // SHADOW (or "on" with nothing eligible to add): telemetry only, the
            // pack is NOT modified — verdict surface unchanged.
            console.log(
              `[${companyName}] A5-SHADOW ${measure.measureId}: recall ${(recall.recall * 100).toFixed(0)}% ` +
                `misses=${recall.misses.length} recoverable=${plan.added.length} policy=${recallPolicy}`,
            );
          }
        } catch (err) {
          console.warn(
            `[${companyName}] A5 recall-expansion ${measure.measureId}: skipped (${(err as Error)?.message ?? "error"}) — pack unchanged`,
          );
        }
      }

      // ── B5 / WP13-C: bounded context-trim (true near-duplicates only) ──────────
      // Issue-4 fix: DEFAULT = "shadow" — this block DROPS NOTHING out of the box;
      // it computes and logs only what it WOULD trim. "on" trims ONLY genuine
      // >=90% word-shingle near-duplicates of an already-KEPT passage
      // (applyContextTrimPolicy/planContextTrim's hard invariant: a passage that is
      // NOT a near-duplicate is NEVER trimmed — regardless of keyword hits or
      // whether its source document is already cited — and no decisive passage is
      // ever trimmed, so recall is preserved exactly). "off": this entire block is
      // SKIPPED, so pack is BYTE-IDENTICAL to the A5-settled pack (rollback
      // path, no redeploy). Framework-level: the decisive set is the reused A5
      // oracle — zero per-company/per-topic logic. Fail-open: any error leaves
      // pack unchanged.
      const contextCostPolicy = resolveContextCostPolicy();
      if (contextCostPolicy !== "off" && settings.useBm25Retrieval && pack) {
        try {
          buildDeepIndex();
          const corpusChunks: Chunk[] = deepChunks || [];
          // Pack membership against the A5-settled pack (same seam rule as
          // A5): a corpus chunk is in the pack iff its exact text is present. Order
          // is the pack order so the trim preserves a stable kept-order.
          const trimPackChunks = corpusChunks.filter((c) => c.text && pack.includes(c.text));
          const outcome = applyContextTrimPolicy({
            policy: contextCostPolicy,
            measure,
            packChunks: trimPackChunks,
            corpusChunks,
          });
          if (outcome.applied) {
            // APPLY (policy "on"): drop ONLY the trimmed near-duplicate passages'
            // text. The decisive set is a subset of keptIds by construction, so
            // recall is preserved exactly. Remove each trimmed chunk's verbatim text.
            const keptSet = new Set(outcome.plan.keptIds);
            let trimmed = pack;
            for (const c of trimPackChunks) {
              if (!c.text) continue;
              if (keptSet.has(stablePassageId(c))) continue;
              trimmed = trimmed.split(c.text).join("");
            }
            pack = trimmed;
            console.log(
              `[${companyName}] B5-TRIM ${measure.measureId}: ${outcome.plan.reason}`,
            );
          } else if (outcome.logLine) {
            // SHADOW (default) or "on" with nothing trimmable: telemetry only — the
            // pack is NOT modified, so the verdict surface is unchanged.
            console.log(
              `[${companyName}] ${outcome.logLine} measure=${measure.measureId} ` +
                `decisiveKept=${outcome.plan.decisivePackCount} policy=${contextCostPolicy}`,
            );
          }
        } catch (err) {
          console.warn(
            `[${companyName}] B5 context-trim ${measure.measureId}: skipped (${(err as Error)?.message ?? "error"}) — pack unchanged`,
          );
        }
      }

          return pack;
        },
      });

      let measureResult: MeasureResult;

      // Get temporal warning if available
      const tw = temporalContext?.temporalWarning || null;

      // ── Group C (B5 lever D): stablePrefixOrder — reorder prompt segments so the
      // invariant/boilerplate prefix (identical across companies) precedes the
      // volatile per-company evidence, maximising a provider prompt-cache hit.
      // apply=only under CONTEXT_COST_POLICY "on"; at the default this returns the
      // ORIGINAL order byte-identical, so the prompt sent to the LLM is unchanged.
      const _promptSegments: PromptSegment[] = [
        { kind: "stable", text: framework.topicDescription || framework.name || "" },
        { kind: "volatile", text: finalEvidence },
      ];
      const _orderedSegments = stablePrefixOrder(
        _promptSegments,
        resolveContextCostPolicy() === "on",
      );
      // The reordered evidence segment (volatile) is what the scorer consumes; at
      // the default this is byte-identical to finalEvidence.
      const scoringEvidence =
        _orderedSegments.find((s) => s.kind === "volatile")?.text ?? finalEvidence;

      // ── Group C (B5 lever E): routeModel — choose the model tier for the scoring
      // pass. apply=only under CONTEXT_COST_POLICY "on"; at the default it ALWAYS
      // returns the strong tier, so model selection is unchanged. Verification
      // stages (self-consistency / arbiter inside the cascade) remain on the strong
      // model by the routeModel contract.
      const _scoringRoute = routeModel({
        stage: "scoring",
        uncertaintySignals: null,
        apply: resolveContextCostPolicy() === "on",
      });
      if (_scoringRoute.model === "cheap") {
        console.log(
          `[${companyName}] B5-ROUTE ${measure.measureId}: ${_scoringRoute.reason}`,
        );
      }

      // ── Group C (B4): cache the derived score. DEFAULT CACHE_LAYER_POLICY "off"
      // ⇒ provable pass-through: the compute closure runs the exact scoring path
      // below. Under "on" an identical {company, measure, pack, route} key serves a
      // STORED verdict (see cacheMeasureScore note: the LLM path is non-deterministic
      // across cold runs, so enable deliberately).
      measureResult = await cacheMeasureScore<MeasureResult>({
        workspaceId: companyId ?? "shared",
        dependencyHashes: [sha256Hex(scoringEvidence)],
        extra: {
          measureId: measure.measureId,
          modelTier: _scoringRoute.model,
          cascade: settings.ensembleScoring || settings.scoringCascade,
        },
        compute: async (): Promise<MeasureResult> => {
          // Route into scoreWithEnsemble when EITHER classic ensemble OR the
          // cross-architecture cascade is enabled. scoringCascade is now ON by
          // default (see loadAnalysisSettings), so this is the default scoring path;
          // scoreWithEnsemble dispatches to scoreWithCascade when scoringCascade is
          // true. Falls back to single-pass only when both are off
          // (SCORING_CASCADE=0 and ensemble_scoring!="true").
          if (settings.ensembleScoring || settings.scoringCascade) {
            // Ensemble/cascade: run multiple passes (or the cascade)
            return await scoreWithEnsemble({
              companyName,
              companyId,
              measure,
              evidenceText: scoringEvidence,
              terminology,
              topicDescription: framework.topicDescription || framework.name,
              settings,
              temporalWarning: tw,
              framework,
            });
          }
          // Single pass
          return await scoreSingleMeasure({
            companyName,
            companyId,
            measure,
            evidenceText: scoringEvidence,
            terminology,
            topicDescription: framework.topicDescription || framework.name,
            provider: scoringProvider,
            temporalWarning: tw,
            scoringMode: settings.scoringMode,
            framework,
          });
        },
      });

      // Provenance check
      if (measureResult.score > 0 && measureResult.quotes.length > 0) {
        const allVerified = measureResult.quotes.every(
          (q) => verifyQuoteProvenance(q.text, finalEvidence).found
        );
        if (!allVerified) {
          // Demote to Low confidence instead of zeroing (fix for Known Issue #5)
          measureResult.confidence = "Low";
          measureResult.verdictNuance = (measureResult.verdictNuance || "") +
            " [Note: Some quotes could not be verified verbatim in source text]";
        }
      }

      // Low-confidence positive handling
      //
      // PR 2 — Cascade v2: when scoringCascade AND cascadeV2 are BOTH on, the
      // auto-downgrade rule is suppressed. Rationale from iteration 8 audit:
      // the cascade already provides diversity via 3 independent models voting;
      // the verbatim-quote rule then double-counts by penalising paraphrased
      // quotes as an additional Low-confidence downgrade, pushing 37% of cells
      // to Low post-cascade. Suppressing lets the cascade's own verdict stand.
      // In non-cascade mode, or when cascadeV2 is off, legacy behaviour applies.
      const cascadeV2DowngradeSuppressed =
        settings.scoringCascade && settings.cascadeV2;

      if (measureResult.score > 0 && measureResult.confidence === "Low") {
        // ─── PR 1 · Change 4: auto re-retrieval BEFORE downgrade ─────────────
        // Guard order matters — skip the whole block unless every dependency is
        // present. When any guard fails, existing downgrade/flag behaviour runs
        // unchanged, preserving the backward-compat invariant.
        let reretrievalAdopted = false;
        const reretrievalEligible =
          settings.retrievalV2 &&
          settings.autoReretrieval &&
          !skipFetch &&
          !!reviewQueue &&
          !!company &&
          !reviewQueue.hasFired(company.id, measure.measureId);
        if (reretrievalEligible && reviewQueue && company) {
          try {
            const reretrievalResult = await runTargetedReretrieval({
              company: {
                id: company.id,
                name: company.name,
                domain: company.domain,
                isin: company.isin,
                ticker: company.ticker,
                sector: company.sector,
                country: company.country,
              },
              measure,
              framework,
              trustedSources: trustedSources || [],
              issuerProfile,
              existingCorpusText: combinedText,
              existingDocUrls: existingDocUrlSet,
              fingerprintKey: `${company.id}:${measure.measureId}`,
            }, reviewQueue.getFiredSet());

            if (
              reretrievalResult.fired &&
              reretrievalResult.newEvidencePack &&
              reretrievalResult.newDocsAdded > 0
            ) {
              // Re-score on the augmented evidence pack for THIS measure only.
              const newMeasureResult = await scoreWithEnsemble({
                companyName,
                companyId,
                measure,
                evidenceText: reretrievalResult.newEvidencePack.text,
                terminology,
                topicDescription: framework.topicDescription || framework.name,
                settings,
                temporalWarning: tw,
                framework,
              });

              // Adopt only if the augmented result is at least as strong — same
              // never-lower invariant as the deep-read pass below.
              if (newMeasureResult.score >= measureResult.score) {
                console.log(`[${companyName}] Change 4 re-retrieval adopted for ${measure.measureId}: score ${measureResult.score}→${newMeasureResult.score}, confidence ${measureResult.confidence}→${newMeasureResult.confidence}`);
                const deltaScore = newMeasureResult.score - measureResult.score;
                const priorConfidence = measureResult.confidence;
                measureResult = newMeasureResult;
                measureResult.verdictNuance = (measureResult.verdictNuance || "") +
                  ` [Re-retrieval: ${reretrievalResult.newDocsAdded} new doc(s) added, re-scored]`;
                (measureResult as MeasureResult & { _reretrieval?: unknown })._reretrieval = {
                  fired: true,
                  deltaScore,
                  newDocsAdded: reretrievalResult.newDocsAdded,
                  targetedQuery: reretrievalResult.targetedQuery,
                  priorConfidence,
                };
                reretrievalAdopted = true;
              } else {
                console.log(`[${companyName}] Change 4 re-retrieval NOT adopted for ${measure.measureId}: new score ${newMeasureResult.score} < ${measureResult.score}`);
              }
            } else if (reretrievalResult.reason === "search-failed") {
              console.warn(`[${companyName}] Change 4 re-retrieval search failed for ${measure.measureId}: ${reretrievalResult.detail || "unknown"}`);
            }
          } catch (rrErr: unknown) {
            // Attempt cancellation must propagate, never be swallowed as a
            // "keep the original result" soft failure.
            if (isLifecycleCancelledError(rrErr)) throw rrErr;
            const msg = rrErr instanceof Error ? rrErr.message : String(rrErr);
            console.warn(`[${companyName}] Change 4 re-retrieval error for ${measure.measureId}: ${msg}`);
          }
        } else if (settings.retrievalV2 && settings.autoReretrieval && skipFetch) {
          console.log(`[change 4] skipped for ${companyName}:${measure.measureId} (skipFetch=true)`);
        }

        // Existing downgrade / flag behaviour runs ONLY if re-retrieval did not
        // upgrade the cell out of Low-confidence. When flags/reviewQueue/company
        // are missing, `reretrievalAdopted` stays false and the original branches
        // run byte-identical to pre-change.
        //
        // PR 2: if cascadeV2 flag is on AND the cascade produced this verdict,
        // suppress the auto-downgrade path entirely — the cascade's diversity
        // signal already provides the check the verbatim-quote rule was
        // duplicating.
        if (!reretrievalAdopted && measureResult.score > 0 && measureResult.confidence === "Low") {
          if (cascadeV2DowngradeSuppressed) {
            // PR 2: cascade already provided diversity via 3 models; keep the
            // verdict as-is. Annotate for telemetry so post-run analysis can
            // attribute confidence-distribution shifts to this change.
            measureResult.verdictNuance = (measureResult.verdictNuance || "") +
              " [Cascade v2: auto-downgrade suppressed — cascade already provides diversity]";
            const withTelemetry = measureResult as MeasureResult & { _cascade?: any };
            withTelemetry._cascade = {
              ...(withTelemetry._cascade || {}),
              downgradeSuppressed: true,
            };
          } else if (settings.lowConfidenceHandling === "downgrade") {
            // BINARY SCORING: a Low-confidence positive is downgraded straight to
            // "No" (score 0) rather than the former "Partial" (0.5). Scoring is now
            // binary — a Partial no longer exists as a distinct outcome, so a
            // low-confidence positive that does not clear the bar counts exactly as
            // a No and contributes nothing to the score.
            // Change #4: the conversion is still recorded as an EXPLICIT, NAMED
            // decision (rule id, proposed verdict, final verdict, reason) on the
            // cell output so it is reported rather than silently rewritten. The
            // verdict is only changed when the named rule actually fires; a Yes that
            // clears the bar and is not Low-confidence stands as Yes.
            const proposed = measureResult.verdict;
            const decision = describeDowngrade(proposed, measureResult.confidence, "downgrade", measureResult.score);
            if (decision.applied && measureResult.score === 1) {
              measureResult.score = 0;
              measureResult.verdict = "No";
              measureResult.verdictNuance = (measureResult.verdictNuance || "") +
                ` [${decision.ruleId}: ${proposed}→No (binary; low-confidence positive not counted as met) — ${decision.reason}]`;
            }
            measureResult.downgradeDecision = decision;
          } else if (settings.lowConfidenceHandling === "flag") {
            // Flag for review — keep score but mark in nuance
            measureResult.verdictNuance = (measureResult.verdictNuance || "") +
              " [NEEDS REVIEW: Low confidence positive — manual verification recommended]";
          }
          // "keep" = do nothing, accept the score as-is
        }
      }

      // Source normalization: ensure quote sources match actual document titles
      if (measureResult.quotes.length > 0) {
        measureResult.quotes = normalizeQuoteSources(measureResult.quotes, finalEvidence);
      }

      // Change D: deterministic bidirectional rationale↔score consistency check.
      // No LLM call, no score/verdict override — sets flags for design-time
      // re-adjudication only.
      measureResult = applyRationaleConsistencyFlags({
        measure,
        result: measureResult,
      });

      // Layer D — Honest coverage signal. Previously hardcoded to null, which let
      // a 0% score coexist with a "full coverage" label. We now base coverage on
      // whether topic-relevant evidence actually reached this measure's pack and
      // whether the corpus contained any topic evidence at all. This flags the
      // genuine "under-evidenced" cases for review instead of mislabeling them.
      const packTopicHits = (evidencePack as EvidencePack | undefined)?.topicHits ?? 0;
      let coverageLabel: string;
      if (packTopicHits >= 3) coverageLabel = "full";
      else if (packTopicHits >= 1) coverageLabel = "partial";
      else if (corpusTopicStats.topicChunks === 0) coverageLabel = "none"; // corpus genuinely has no topic content
      else coverageLabel = "low"; // topic evidence exists in corpus but did not reach this pack
      measureResult.coverage = coverageLabel;

      // ─── Targeted deep-read second pass (under-evidenced measures only) ──────
      // When a measure scored 0/Partial AND coverage is "low" — meaning the
      // corpus DOES contain topic-relevant evidence but the normal-budget pack
      // failed to surface enough of it for this specific question — re-retrieve
      // this one measure with a much larger, topic-biased budget and re-score.
      // This spends extra effort precisely where evidence was thin, directly
      // attacking the "0% / under-evidenced" pattern without lowering standards
      // or wasting compute on measures that are already well-evidenced or that
      // genuinely have no topic content in the corpus ("none").
      const eligibleForDeepRead =
        DEEPREAD_ENABLED &&
        settings.useBm25Retrieval &&
        coverageLabel === "low" &&
        measureResult.score < 1;

      if (eligibleForDeepRead) {
        try {
          buildDeepIndex();
          if (deepChunks && deepBm25Index) {
            const deepPack = buildEvidencePackForMeasure({
              measure,
              chunks: deepChunks,
              bm25Index: deepBm25Index,
              terminology,
              topicTerms,
              topK: DEEP_TOP_K,
              maxChars: DEEP_MAX_CHARS,
              companyId,            // v3g (Bug 1): collision-free fingerprint identity
              frameworkId: framework.id,
              // v3j-r7 FIX (Oracle): keep the deep-read pass anchored on the same
              // canonical EDGAR annual filing as the category pass.
              // v3j-r12 FIX (NVIDIA): prefer the upstream-reserved URL when available.
              preferredAnnualUrl: reservedAnnualUrl || computePreferredAnnualUrl(deepChunks),
            });
            // Only re-score if the deep pass actually surfaced more topic evidence
            // than the original pack (otherwise re-scoring adds cost for no gain).
            if (deepPack.topicHits > packTopicHits && deepPack.text.length > 0) {
              console.log(`[${companyName}] Deep-read re-score for ${measure.measureId}: topicHits ${packTopicHits}→${deepPack.topicHits}, evidence ${finalEvidence.length}→${deepPack.text.length} chars`);
              let deepResult: MeasureResult;
              // Same gate as the main scoring path: cascade (default ON) or
              // classic ensemble both route through scoreWithEnsemble.
              if (settings.ensembleScoring || settings.scoringCascade) {
                deepResult = await scoreWithEnsemble({
                  companyName,
                  companyId,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  settings,
                  temporalWarning: tw,
                  framework,
                });
              } else {
                deepResult = await scoreSingleMeasure({
                  companyName,
                  companyId,
                  measure,
                  evidenceText: deepPack.text,
                  terminology,
                  topicDescription: framework.topicDescription || framework.name,
                  provider: scoringProvider,
                  temporalWarning: tw,
                  scoringMode: settings.scoringMode,
                  framework,
                });
              }
              // Verify provenance of any quotes against the deep evidence.
              if (deepResult.score > 0 && deepResult.quotes.length > 0) {
                const allVerified = deepResult.quotes.every(
                  (q) => verifyQuoteProvenance(q.text, deepPack.text).found
                );
                if (!allVerified) {
                  deepResult.confidence = "Low";
                  deepResult.verdictNuance = (deepResult.verdictNuance || "") +
                    " [Note: Some quotes could not be verified verbatim in source text]";
                }
                deepResult.quotes = normalizeQuoteSources(deepResult.quotes, deepPack.text);
              }
              // Adopt the deep result only if it is at least as strong (we never
              // lower a score via the deep pass — it can only recover missed
              // evidence, consistent with not inflating or deflating standards).
              if (deepResult.score >= measureResult.score) {
                deepResult.coverage = deepPack.topicHits >= 3 ? "full" : deepPack.topicHits >= 1 ? "partial" : coverageLabel;
                deepResult.verdictNuance = (deepResult.verdictNuance || "") +
                  " [Deep-read pass: re-scored on expanded evidence]";
                // v3j: the adopted deep pack ran its own force-include; use its
                // provenance so the invariant reflects what actually scored.
                deepResult.forceIncludedCount = (deepPack as any).forceIncludedCount ?? 0;
                deepResult.requiredDocPresent = (deepPack as any).requiredDocPresent ?? false;
                deepResult.forceIncludedDocUrl = (deepPack as any).forceIncludedDocUrl;
                measureResult = deepResult;
              }
            }
          }
        } catch (deepErr: any) {
          if (isLifecycleCancelledError(deepErr)) throw deepErr;
          console.warn(`[${companyName}] Deep-read pass failed for ${measure.measureId}: ${deepErr.message}`);
          // Keep the original result on any failure.
        }
      }

      // B3 (evidence-vs-qualification signal): distinguish a "No" reached with
      // essentially ZERO on-topic evidence from a "No" reached against evidence
      // that WAS retrieved but did not qualify. Both are legitimately scored "No",
      // but they mean very different things to a reviewer: the former is an
      // evidence-gap (the corpus surfaced no topic content for this measure), the
      // latter is a genuine substantive judgement. We surface this ONLY through the
      // existing verdictNuance mechanism — NO score change, NO verdict change, NO
      // extra LLM call. Abstained cells already carry their own nuance and are
      // excluded from the denominator, so we skip them here. GENERIC: keyed purely
      // on the coverage label + verdict, never on any framework/measure specifics.
      if (
        measureResult.verdict === "No" &&
        !measureResult.abstained &&
        measureResult.coverage === "none"
      ) {
        const gapNote = "[Evidence gap: No reached with essentially zero on-topic evidence retrieved — the corpus surfaced no topic-relevant content for this measure, so this is a data-availability No rather than a substantive No against qualifying evidence.]";
        if (!(measureResult.verdictNuance || "").includes("Evidence gap:")) {
          measureResult.verdictNuance = ((measureResult.verdictNuance || "").trim() + " " + gapNote).trim();
        }
      }

      // v3e (Section 4): stamp the evidence fingerprint onto the result so it is
      // persisted and can be compared across runs for drift detection / caching.
      measureResult.evidenceFingerprint = evidencePack?.fingerprint || null;
      measureResult.abstained = false;

      // v3j (Bug 2): carry force-include provenance for the run-level invariant.
      // If the deep-read pass adopted its own pack, prefer that pack's numbers
      // (set on the deepPack above); otherwise use the normal pack's.
      if (measureResult.forceIncludedCount === undefined) {
        measureResult.forceIncludedCount = (evidencePack as any)?.forceIncludedCount ?? 0;
        measureResult.requiredDocPresent = (evidencePack as any)?.requiredDocPresent ?? false;
        measureResult.forceIncludedDocUrl = (evidencePack as any)?.forceIncludedDocUrl;
      }

      // v3g (Bug 1): an empty/degenerate pack is NOT cache-eligible — its sentinel
      // fingerprint must never satisfy a cache hit.
      const fingerprintEligible = (evidencePack as any)?.fingerprintEligible !== false;

      // I51-B/I58: attach passage-retrieval telemetry (diagnostic-only). Enriched
      // with pack-level metrics (chunkCount/totalChars/topicHits/forceIncludedCount/
      // requiredDocPresent) so downstream persistence layer can emit a single
      // per-measure diagnostic sidecar to the results JSON. Attached BEFORE the
      // verdict-cache short-circuit so that even cache hits carry the retrieval
      // diagnostic — otherwise cached fw8 measures returned to callers without
      // the sidecar and offline debugging saw an empty diag stream.
      if (evidencePack?.passageDiagnostics) {
        const epAny = evidencePack as any;
        (measureResult as MeasureResult).passageDiagnostics = {
          ...evidencePack.passageDiagnostics,
          chunkCount: epAny.chunkCount,
          totalChars: epAny.totalChars,
          topicHits: epAny.topicHits,
          forceIncludedCount: epAny.forceIncludedCount,
          requiredDocPresent: epAny.requiredDocPresent,
        } as any;
      }

      // v3e (Section 4) / v3g (Bug 1): VERDICT CACHE (now OPT-IN, default OFF — see
      // loadAnalysisSettings). When enabled and a prior verdict exists for this
      // company+measure with an IDENTICAL, cache-eligible evidence fingerprint,
      // reuse it for reproducibility. The freshly-computed fingerprint is always
      // persisted; drift is logged.
      if (verdictCacheEnabled && fingerprintEligible && priorScoresByMeasure) {
        const prior = priorScoresByMeasure.get(measure.measureId);
        const fp = measureResult.evidenceFingerprint;
        if (prior && fp && prior.evidenceFingerprint && prior.evidenceFingerprint === fp) {
          // v3g (Bug 1 §3 action 4): explicit, auditable cache-hit log including the
          // matching fingerprint and the prior verdict being reused, so silent
          // cross-entity reuse is impossible to miss in production.
          console.log(`[${companyName}] CACHE-HIT ${measure.measureId}: fingerprint=${fp.slice(0, 12)} reusing prior verdict="${prior.verdict}" (priorScore=${prior.score})`);
          const cachedResult: MeasureResult = {
            ...measureResult,
            score: typeof prior.score === "number" ? prior.score : measureResult.score,
            verdict: (prior.verdict as MeasureResult["verdict"]) || measureResult.verdict,
            confidence: prior.confidence || measureResult.confidence,
            evidenceSummary: prior.evidenceSummary || measureResult.evidenceSummary,
            verdictNuance: (prior.verdictNuance || measureResult.verdictNuance || "") + " [Reused: identical evidence fingerprint]",
            // I58: preserve retrieval diagnostic even on cache hits.
            passageDiagnostics: (measureResult as MeasureResult).passageDiagnostics,
          };
          // U17 Fix B (T1.2): apply scoring-time provenance gate on cache hits
          // too. A cached verdict may have been produced when the flag was off;
          // running the gate here makes flag toggles retroactive without
          // requiring a full re-score. No-op when flag is off.
          return runProvenanceGate(cachedResult);
        } else if (prior && fp && prior.evidenceFingerprint && prior.evidenceFingerprint !== fp) {
          console.log(`[${companyName}] EVIDENCE-DRIFT ${measure.measureId}: fingerprint changed ${prior.evidenceFingerprint.slice(0, 8)} -> ${fp.slice(0, 8)} (re-scored)`);
        }
      }

      // U17 Fix B (T1.2): scoring-time provenance gate. Downgrades Yes/Partial
      // to No when every supporting quote is third-party. Skipped for unlisted
      // companies and gated by the U17_SCORING_TIME_GATE flag (default off).
      // No-op when flag is off, so the diff is zero for existing runs until
      // the flag is turned on for measurement.
      return runProvenanceGate(measureResult);
    };

    // Helper closure that captures the company context and applies the U17
    // Fix B gate. Kept as a closure over the outer analyzeCompanyMeasures
    // scope so we don't have to thread the company row through every return.
    function runProvenanceGate(mr: MeasureResult): MeasureResult {
      let result = mr;
      if (isScoringTimeGateEnabled()) {
        const outcome = applyProvenanceGate(mr, company ?? null);
        if (outcome.action === "downgraded") {
          console.log(`[${companyName}] U17-FIX-B DOWNGRADE ${mr.measureId}: ${mr.verdict} → No (all ${outcome.decisions.length} quotes third-party)`);
        }
        result = outcome.result;
      }
      // Change #3: compute the advisory eligibility flags on the FINAL verdict
      // (after any provenance-gate downgrade), for positive cells only. ADVISORY
      // ONLY — this attaches non-blocking, dismissible flags and NEVER changes the
      // verdict/score or blocks the run/save. computeEligibilityFlags never throws.
      try {
        if (isPositiveVerdict(result.verdict)) {
          const { flags, triggeredCount } = computeEligibilityFlags({
            verdict: result.verdict,
            quotes: result.quotes || [],
            evidenceSummary: result.evidenceSummary,
            company: {
              name: company?.name || companyName,
              ticker: company?.ticker ?? null,
              domain: company?.domain ?? null,
              relatedDomains: company?.relatedDomains ?? null,
            },
          });
          result.eligibilityFlags = flags;
          if (triggeredCount > 0) {
            console.log(`[${companyName}] eligibility-flags ${result.measureId}: ${triggeredCount} advisory flag(s) — ${flags.filter((f) => f.triggered).map((f) => f.id).join(", ")} (non-blocking)`);
          }
        }
      } catch (err) {
        console.warn(`[${companyName}] eligibility-flags ${result.measureId}: computation skipped (${(err as Error)?.message ?? "error"}) — advisory only, not blocking`);
      }

      // A3 / WP04: compose the single immutable eligibility decision for this
      // measure's PRIMARY supporting source and the assessed target, then carry
      // it end to end. Pure/total (never throws). SHADOW by default — the
      // decision is attached for observability/export only and does NOT change
      // the verdict. Verdict-mutating enforcement is opt-in via
      // ELIGIBILITY_ENFORCE=on (mirrors the A2 kill-switch precedent), so the
      // live batch stays baseline-stable until a measurement run explicitly
      // turns it on. The composition policy itself is versioned via
      // ELIGIBILITY_POLICY (v2 default / v1 kill-switch) inside the module.
      try {
        // A3 BASIS = VERDICT BASIS: compose one decision for EVERY supporting
        // quote (not a single-quote sample), so the eligibility picture covers
        // the same evidence the verdict was computed from. Per-target recompute
        // (I1) is applied to each quote inside composeCellEligibility.
        // Exclude non-scoring diagnostic sidecar quotes (sourceUrl scheme
        // `diag://`, e.g. diag://retrieval-v1, diag://evidence-gate-v1) from the
        // eligibility basis. These are telemetry blobs appended at persistence
        // time (pipeline.ts), not real supporting evidence, and must never become
        // the representative / cited quote. Defensive at runtime (live quotes
        // carry no sidecars yet) and the exact basis the offline GATE3 label
        // script uses, so shadow labels equal live behaviour.
        const evidenceQuotes = (result.quotes || []).filter(
          (q) => !String(q?.sourceUrl ?? "").startsWith("diag://"),
        );
        const sources = evidenceQuotes.map((q) => ({
          url: q?.sourceUrl ?? null,
          title: q?.source ?? null,
          content: q?.text ?? null,
        }));
        const cell = composeCellEligibility({
          target: {
            id: company?.id ?? null,
            name: company?.name || companyName,
            ticker: company?.ticker ?? null,
            domain: company?.domain ?? null,
            relatedDomains: company?.relatedDomains ?? null,
            isin: company?.isin ?? null,
          },
          sources,
          // R5c: per-company tenant cache shared across all measures (see above).
          knownIrTenants: companyIrTenantCache,
          // Framework scope defaults (entity_only, no current-state/issuer
          // requirement) keep the guardrail from over-firing on undated
          // evidence; stricter per-framework scope can be threaded later.
        });

        // Observability / GATE3 label-set carry-through (never mutates verdict).
        result.eligibilityDecision = cell.representative;
        result.eligibilityDecisions = cell.decisions as EligibilityDecision[];
        result.eligibilityCellStatus = cell.status;

        // Enforcement is DEFAULT-ON (2026-10). Unset/empty enforces; an explicit
        // ELIGIBILITY_ENFORCE=off is the kill switch that restores shadow mode.
        // (The ELIGIBILITY_POLICY=v1 kill switch inside composeEligibilityDecision
        // remains independent: v1 passes every source through as eligible, so even
        // with enforce ON there are no downgrades under v1.)
        const rawEnforce = (process.env.ELIGIBILITY_ENFORCE || "").trim().toLowerCase();
        const enforce = rawEnforce === "" ? true : rawEnforce === "on";

        if (!enforce) {
          // SHADOW: no output mutation. Log only when there is observable churn —
          // the cell is not cleanly eligible, OR the eligible representative is
          // not already the cited (first) quote.
          if (cell.status !== "eligible" || cell.representativeIndex > 0) {
            const rep = cell.representative;
            console.log(
              `[${companyName}] A3-SHADOW ${result.measureId}: cell=${cell.status} eligible=${cell.decisions.filter((d) => d.status === "eligible").length}/${cell.sourceCount} (rep ${rep?.entityRelation ?? "none"}/${rep?.sourceClass ?? "none"})`,
            );
          }
        } else if (isPositiveVerdict(result.verdict)) {
          if (cell.anyEligible) {
            // PRIMARY REMEDY — quote correction. Keep verdict & score; make the
            // cited (first) quote the eligible one so the citation is accurate.
            // representativeIndex indexes the FILTERED evidence set, so resolve
            // the quote object and move it by identity in result.quotes (robust
            // to interleaved diagnostic sidecars).
            if (cell.representativeIndex > 0 && Array.isArray(result.quotes)) {
              const eligibleQuote = evidenceQuotes[cell.representativeIndex];
              const actualIndex = result.quotes.indexOf(eligibleQuote);
              if (actualIndex > 0) {
                result.quotes.splice(actualIndex, 1);
                result.quotes.unshift(eligibleQuote);
                console.log(
                  `[${companyName}] A3-CORRECT ${result.measureId}: cited quote ${actualIndex} -> 0 (eligible ${cell.representative?.entityRelation}/${cell.representative?.sourceClass}); verdict unchanged`,
                );
              }
            }
            result.eligibilityDecision = cell.representative;
          } else if (cell.allExcluded) {
            // LAST RESORT — every supporting quote is hard-excluded. Downgrade.
            console.log(
              `[${companyName}] A3-ENFORCE DOWNGRADE ${result.measureId}: ${result.verdict} -> No (all ${cell.sourceCount} quotes ineligible)`,
            );
            result = {
              ...result,
              verdict: "No",
              score: 0,
              eligibilityDecision: cell.representative,
              eligibilityDecisions: cell.decisions as EligibilityDecision[],
              eligibilityCellStatus: cell.status,
              verdictNuance: `A3: all supporting evidence ineligible (${cell.representative?.reasons.slice(-1)[0] || "excluded"})`,
            };
          } else {
            // None eligible but some under review — unknown provenance only.
            // Do NOT flip the verdict on unknown-provenance alone; flag it.
            result.verdictNuance = "A3: supporting evidence pending provenance review";
            result.eligibilityCellStatus = "review";
            console.log(
              `[${companyName}] A3-REVIEW ${result.measureId}: provenance incomplete on all quotes — flagged for review, verdict unchanged`,
            );
          }
        }
      } catch (err) {
        console.warn(`[${companyName}] A3 eligibility-decision ${result.measureId}: composition skipped (${(err as Error)?.message ?? "error"}) — shadow only, not blocking`);
      }
      return result;
    }

    // Process measures in concurrent batches
    for (let i = 0; i < categoryMeasures.length; i += MEASURE_CONCURRENCY) {
      const batch = categoryMeasures.slice(i, i + MEASURE_CONCURRENCY);
      // Refuse to start another sibling batch once the attempt is revoked.
      // Inert (no-op) when no attempt lifecycle is in context.
      assertDispatchAllowed("scoring:measure-batch");
      const batchResults = await Promise.all(batch.map(scoreMeasure));
      // BINARY SCORING: collapse any residual "Partial" verdict/0.5 score to a
      // "No"/0 at the single collection chokepoint so every downstream rollup
      // (totalScore, measuresMet, summary counts) and persisted result is binary.
      // Abstained results ("Insufficient evidence") are left untouched so they
      // stay excluded from the answered-measures denominator. This is the safety
      // net; new runs should already avoid Partial via the scoring prompt/schema.
      const normalizedBatch = batchResults.map((r) =>
        r.abstained
          ? r
          : {
              ...r,
              verdict: normalizeVerdict(r.verdict) as MeasureResult["verdict"],
              score: normalizedScore(r.verdict, r.score),
            }
      );
      allResults.push(...normalizedBatch);
    }
  }

  // Roll up scores (works for both binary and partial mode since partial gives 0.5).
  // v3e (Section 3): ANSWERED-MEASURES DENOMINATOR. Abstained measures
  // ("Insufficient evidence") are excluded from BOTH numerator and denominator so
  // a missing required source no longer drags the score down as if it were a
  // substantive "No". scorePercentage is computed over answered measures only.
  const abstainedResults = allResults.filter((r) => r.abstained);
  const answeredResults = allResults.filter((r) => !r.abstained);
  const abstainedCount = abstainedResults.length;
  const answeredCount = answeredResults.length;
  const measuresTotal = measures.length;
  const totalScore = answeredResults.reduce((sum, r) => sum + r.score, 0);
  const denominator = answeredCount > 0 ? answeredCount : 1; // avoid /0 when all abstained
  const scorePercentage = Math.round((totalScore / denominator) * 100);
  if (abstainedCount > 0) {
    console.log(`[${companyName}] Answered-measures denominator: ${answeredCount}/${measuresTotal} answered, ${abstainedCount} abstained (insufficient evidence)`);
  }

  // ─── v3j (Bug 2): RUN-LEVEL FORCE-INCLUDE INVARIANT ─────────────────────────
  // For every NON-abstained measure whose required document WAS present in the
  // corpus, at least one genuine body chunk MUST have been force-included. If a
  // required document is present but nothing was forced, the deterministic
  // guarantee failed (the exact Bug-2 regression). We collect violations, log
  // them loudly, and surface them so the worker can gate the portfolio run.
  const fiViolations: Array<{ measureId: string; reason: string }> = [];
  let fiChecked = 0;
  for (const r of allResults) {
    if (r.abstained) continue;
    if (r.requiredDocPresent) {
      fiChecked++;
      if (!r.forceIncludedCount || r.forceIncludedCount < 1) {
        fiViolations.push({
          measureId: r.measureId,
          reason: `required document present in corpus but forceIncludedCount=${r.forceIncludedCount ?? 0}`,
        });
      }
    }
  }
  const forceIncludeInvariant = { ok: fiViolations.length === 0, checked: fiChecked, violations: fiViolations };
  if (!forceIncludeInvariant.ok) {
    console.error(`[${companyName}][invariant][FAIL] force-include invariant violated for ${fiViolations.length} measure(s): ${fiViolations.map((v) => v.measureId).join(", ")}`);
  } else {
    console.log(`[${companyName}][invariant][OK] force-include invariant satisfied (${fiChecked} filing-bound measure(s) with required doc present all received forced body chunks)`);
  }

  // Generate summary narrative
  let summary = await generateSummaryNarrative(companyName, allResults, scorePercentage, framework);

  // 41-H: Guard against contradictory 0-score summaries.
  // If measuresMet === 0 but the summary claims robustness/completeness, replace with deterministic fallback.
  const measuresMet = allResults.filter(r => r.verdict === "Yes").length;
  if (measuresMet === 0 && scorePercentage === 0) {
    const positiveClaims = /\b(robust|comprehensive|fully meet|fully meets|full alignment|strong|leading)\b/i;
    if (positiveClaims.test(summary)) {
      summary = `${companyName} scored 0% on the ${framework.name}, failing to meet any of the ${measuresTotal} assessment measures. The evidence pack did not contain material that satisfied the framework's criteria; retrieval or scoring conditions for this issuer should be reviewed before treating the zero as legitimate.`;
    }
  }

  // Group results by category for output
  const categoryResults = Array.from(categoryMap.entries()).map(([category, categoryMeasures]) => ({
    category,
    categoryNumber: categoryMeasures[0].categoryNumber,
    measures: allResults.filter((r) => r.category === category),
  }));

  // I45: Compute scoring diagnostics for fleet-score regression investigation.
  // These are persisted alongside the analysis result so Gate Report diagnostics
  // can expose score-stage input counts, evidence passage counts, model response
  // validity, timeout counts, and fallback/default-score usage.
  const allMeasureResultsFlat = allResults;
  const scoringFailures = allMeasureResultsFlat.filter((r) => (r as any)._scoringFailure).length;
  const timeoutFailures = allMeasureResultsFlat.filter((r) => (r as any)._scoringFailure === "timeout").length;
  const fallbackUsed = allMeasureResultsFlat.filter((r) => {
    const gradedBy = (r as any)._gradedBy || "";
    return gradedBy && gradedBy !== scoringProvider && !gradedBy.includes("+");
  }).length;
  const defaultScoreUsed = allMeasureResultsFlat.filter((r) => r.score === 0 && r.confidence === "Low" && !r.abstained).length;
  const selfConsistencyPasses = Math.max(1, parseInt(process.env.SCORING_SELF_CONSISTENCY || "3", 10));

  const scoringDiagnostics = {
    totalMeasures: measuresTotal,
    scoredMeasures: answeredCount,
    scoringFailures,
    timeouts: timeoutFailures,
    fallbackUsed,
    defaultScoreUsed,
    evidencePackCounts: {
      total: allMeasureResultsFlat.length,
      empty: allMeasureResultsFlat.filter((r) => r.coverage === "none").length,
      lowTopic: allMeasureResultsFlat.filter((r) => r.coverage === "low").length,
    },
    modelResponseValidity: {
      valid: allMeasureResultsFlat.filter((r) => !(r as any)._scoringFailure && r.confidence !== "Low").length,
      repaired: allMeasureResultsFlat.filter((r) => r.verdictNuance?.includes("[Note: Some quotes could not be verified")).length,
      failed: scoringFailures,
    },
    selfConsistencyPasses,
  };

  console.log(`[${companyName}] Scoring diagnostics: failures=${scoringFailures}, timeouts=${timeoutFailures}, fallback=${fallbackUsed}, defaultScore=${defaultScoreUsed}, emptyEvidence=${scoringDiagnostics.evidencePackCounts.empty}`);
  console.log(`[${companyName}] Analysis complete: ${scorePercentage}% (${totalScore}/${answeredCount} answered; ${abstainedCount} abstained of ${measuresTotal} total)`);

  // R4: derive the run-level empty-corpus signal. isEmpty is true only when the
  // corpus yielded ZERO usable chunks for EVERY measure (all packs were
  // empty-corpus sentinels) — an operational "insufficient evidence" state,
  // distinct from a non-empty corpus in which the topic is genuinely absent.
  let emptyCorpus: AnalysisResult["emptyCorpus"] | undefined = undefined;
  if (loudEmptyCorpusEnabled && r4TotalPacks > 0) {
    const isEmpty = r4EmptyCorpusPacks === r4TotalPacks;
    emptyCorpus = {
      isEmpty,
      reason: isEmpty ? (r4EmptyCorpusReason || "empty_corpus") : "corpus_non_empty",
      measuresChecked: r4TotalPacks,
    };
    if (isEmpty) {
      console.error(
        `[${companyName}] R4 EMPTY CORPUS SIGNAL: all ${r4TotalPacks} evidence packs are empty-corpus sentinels ` +
        `(reason=${emptyCorpus.reason}). Marking run as operationally empty (auto-rerun trigger).`
      );
    }
  }

  // A6 / WP07: run the framework-contract governance pass over the framework and
  // its measures. Verdict-invariant by construction — at the default `shadow`
  // policy this attaches contract metadata only and mutates NO published score
  // (publishedScoresMutated is always false). Best-effort: a governance failure
  // must never fail an otherwise-complete analysis, so it is caught and omitted.
  let governance: GovernanceResult | undefined = undefined;
  try {
    governance = runContractGovernance(
      { framework: framework as any, measures: measures as any[] },
      resolveFrameworkContractPolicy(),
    );
  } catch (govErr: any) {
    console.warn(`[${companyName}] A6 contract governance pass skipped: ${govErr?.message || govErr}`);
  }

  return {
    totalScore,
    scorePercentage,
    summary,
    answeredCount,
    abstainedCount,
    measuresTotal,
    categories: categoryResults.sort((a, b) => a.categoryNumber - b.categoryNumber),
    forceIncludeInvariant,
    scoringDiagnostics,
    emptyCorpus,
    governance,
  };
}

// ─── Single Measure Scoring ──────────────────────────────────────────────────

// I36-B: Verdict cache — identical evidence + measure + provider = identical result.
// Eliminates scorer non-determinism from provider-side sampling noise.
const VERDICT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const verdictCache = new Map<string, { result: MeasureResult; ts: number }>();

// I45: Include companyId in verdict cache key to prevent cross-company cache
// contamination when the same measureId+evidence hash collides across companies.
function verdictCacheKey(measureId: string, evidenceText: string, provider: string, scoringMode: string, promptText?: string, companyId?: number): string {
  const evidenceHash = createHash("sha256").update(evidenceText).digest("hex").slice(0, 16);
  // 36-B.2: Include prompt hash so cache auto-invalidates on prompt template changes
  const promptHash = promptText ? createHash("sha256").update(promptText).digest("hex").slice(0, 8) : "noprompt";
  const companyKey = companyId != null ? String(companyId) : "nocompany";
  return `${companyKey}:${measureId}:${provider}:${scoringMode}:${evidenceHash}:${promptHash}`;
}

// 36-B.1: Deterministic seed per (measureId, companyId, providerIndex).
// Gives each measure a unique seed, reducing systematic bias across measures.
function deterministicSeed(measureId: string, companyId: number, providerIndex: number): number {
  const h = createHash("sha256")
    .update(`${measureId}:${companyId}:${providerIndex}`)
    .digest();
  return h.readUInt32BE(0);
}

async function scoreSingleMeasure(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  temporalWarning?: string | null;
  scoringMode?: string;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, measure, scoringMode } = opts;
  const usePartial = scoringMode === "partial";

  // I36-B: Check verdict cache — identical evidence + measure + provider = identical result
  // The cache salt (bumped on prompt changes) is included as the promptText proxy
  // I45: companyId included to prevent cross-company cache contamination
  // U2: include base-rate prior state + expected_yes_rate value in the salt.
  //     A cached verdict from a run with the prior OFF must not be reused when
  //     the prior is ON (or vice versa), and a change to expected_yes_rate on
  //     the measure must invalidate too. Rate is rounded to 2 dp for stability.
  const baseRateOn = process.env.SCORING_BASE_RATE_PRIOR === "true";
  const rateVal = (measure as any).expectedYesRate;
  const rateTag = baseRateOn && typeof rateVal === "number" && rateVal > 0 && rateVal < 1
    ? `br${Math.round(rateVal * 100)}`
    : "br0";
  const promptSalt = `v3n-no-govterms-${rateTag}`;
  const vKey = verdictCacheKey(measure.measureId, opts.evidenceText, opts.provider, scoringMode || "binary", promptSalt, opts.companyId);
  const cachedVerdict = verdictCache.get(vKey);
  if (cachedVerdict && (Date.now() - cachedVerdict.ts) < VERDICT_CACHE_TTL_MS) {
    return { ...cachedVerdict.result };
  }

  // Self-consistency: run N passes on the SAME provider (no silent cross-model
  // fallback) and take the majority verdict. This bounds the residual best-effort
  // -seed noise that drives cross-run volatility. N is env-tunable; default 3.
  // Set SCORING_SELF_CONSISTENCY=1 to disable (single pass).
  const passes = Math.max(1, parseInt(process.env.SCORING_SELF_CONSISTENCY || "3", 10));

  // WS4: attach the canonical-rule trace to every scored result (identity,
  // version, source field, clauses used, decision basis). Pure/deterministic;
  // never changes verdict/score. See framework-v2/reliability/canonical-rule.ts.
  const withCanonicalTrace = (r: MeasureResult): MeasureResult => ({
    ...r,
    canonicalRuleTrace: buildCanonicalRuleTrace(measure, { finalVerdict: r.verdict }),
  });

  if (passes === 1) {
    return withCanonicalTrace(await scoreSingleMeasurePass({ ...opts, providerIndex: 0 }));
  }

  const passResults: MeasureResult[] = [];
  const gradedBy = new Set<string>();
  for (let i = 0; i < passes; i++) {
    const r = await scoreSingleMeasurePass({ ...opts, providerIndex: i });
    passResults.push(r);
    if ((r as any)._gradedBy) gradedBy.add((r as any)._gradedBy);
  }

  // Content-crash passes (abstained "Scoring error" from scoreSingleMeasurePass
  // after its bounded retries) are NOT substantive votes: exclude them from the
  // majority tally so a transient model/network crash can never tip or override a
  // genuine verdict. If EVERY pass crashed, propagate the abstained sentinel so
  // the cell is EXCLUDED from totals (fail-loud), never folded into a fake "No".
  const substantivePasses = passResults.filter((r) => !(r as any)._scoringFailure);
  if (substantivePasses.length === 0) {
    console.error(`[${companyName}] All ${passes} scoring passes crashed for ${measure.measureId} — abstaining (excluded from totals), NOT emitting a substantive zero`);
    return withCanonicalTrace(passResults[0]);
  }

  // Majority verdict by score bucket (0 / 0.5 / 1). Ties resolve toward the
  // HIGHER-evidence pass that has quotes, never inflating beyond what a pass found.
  const tally = new Map<number, MeasureResult[]>();
  for (const r of substantivePasses) {
    const bucket = r.score;
    if (!tally.has(bucket)) tally.set(bucket, []);
    tally.get(bucket)!.push(r);
  }
  let winningBucket = substantivePasses[0].score;
  let winningCount = 0;
  for (const [bucket, rs] of tally) {
    if (rs.length > winningCount || (rs.length === winningCount && bucket > winningBucket)) {
      winningBucket = bucket;
      winningCount = rs.length;
    }
  }
  const winners = tally.get(winningBucket)!;
  // Pick the winner with the richest quotes/evidence as the representative result.
  // I36-B: Deterministic tie-break: sort by (quotes.length DESC, evidenceSummary.length DESC,
  // evidenceSummary text ASC) so identical-quality results always pick the same one.
  winners.sort((a, b) => {
    const aq = a.quotes.length, bq = b.quotes.length;
    if (aq !== bq) return bq - aq;
    const ae = a.evidenceSummary?.length || 0, be = b.evidenceSummary?.length || 0;
    if (ae !== be) return be - ae;
    return (a.evidenceSummary || "").localeCompare(b.evidenceSummary || "");
  });
  const chosen = winners[0];
  // Self-consistency is measured over the SUBSTANTIVE passes only (crashed passes
  // were excluded above), so the confidence denominator reflects real votes.
  const substantiveCount = substantivePasses.length;
  const unanimous = winningCount === substantiveCount;
  const gradedByLabel = Array.from(gradedBy).join("+") || "unknown";
  chosen.confidence = unanimous ? "High" : winningCount >= Math.ceil(substantiveCount / 2) ? "Medium" : "Low";
  chosen.verdictNuance = (chosen.verdictNuance ? chosen.verdictNuance + " " : "") +
    `[Self-consistency ${winningCount}/${substantiveCount} on ${gradedByLabel}]`;
  // Propagate model identity for methodology stamping
  (chosen as any)._gradedBy = gradedByLabel;

  // WS4: attach the canonical-rule trace before caching so cached hits carry it too.
  chosen.canonicalRuleTrace = buildCanonicalRuleTrace(measure, { finalVerdict: chosen.verdict });

  // I36-B: Store in verdict cache
  verdictCache.set(vKey, { result: { ...chosen }, ts: Date.now() });
  if (verdictCache.size > 10000) {
    const now = Date.now();
    for (const [k, v] of verdictCache) {
      if (now - v.ts > VERDICT_CACHE_TTL_MS) verdictCache.delete(k);
    }
  }
  return chosen;
}

// Single scoring pass (one LLM call). Kept separate so the N-pass vote above can
// reuse it. Uses completeScoring (strict same-provider retry) rather than the
// silent cross-model fallback path.
async function scoreSingleMeasurePass(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  provider: string;
  providerIndex?: number;
  temporalWarning?: string | null;
  scoringMode?: string;
  framework?: Framework;
  // Bounded content-crash retry budget, threaded through recursive re-attempts.
  // Undefined on the first call → seeded from SCORING_CONTENT_RETRIES (default 2).
  _contentRetriesLeft?: number;
}): Promise<MeasureResult> {
  const { companyName, companyId, measure, evidenceText, terminology, topicDescription, provider, providerIndex, temporalWarning, scoringMode, framework } = opts;

  // Sprint 10 P3: opt-in two-step verifier. Fires when the measure's
  // scoringGuidance JSON declares scoring_strategy="two_step_named_entity_quantum"
  // AND entity_role is one of the supported values. Env flag
  // FRAMEWORK_V2_TWO_STEP=1 must also be set (default OFF) so v1 frameworks
  // never accidentally take this path.
  if (process.env.FRAMEWORK_V2_TWO_STEP === "1") {
    try {
      const sgRaw = (measure as any).scoringGuidance;
      let sgParsed: any = null;
      if (typeof sgRaw === "string") { try { sgParsed = JSON.parse(sgRaw); } catch {} }
      else if (sgRaw && typeof sgRaw === "object") sgParsed = sgRaw;
      const strategy = sgParsed?.scoring_strategy;
      const role = sgParsed?.entity_role;
      if (
        strategy === "two_step_named_entity_quantum" &&
        (role === "revenue_line" || role === "cost_claim")
      ) {
        const fw: any = framework;
        const topicTerm = fw?.topicTerm || topicDescription || "the topic";
        const { verifyTwoStep } = await import("./framework-v2/two-step-verifier.js");
        const twoStep = await verifyTwoStep({
          companyName,
          evidenceText,
          topicTerm,
          entityRole: role,
          providerName: provider,
        });
        // Map two-step verdict to MeasureResult
        const twoStepScore = twoStep.verdict === "Yes" ? 1 : (twoStep.verdict === "Partial" ? 0.5 : 0);
        return {
          measureId: measure.measureId,
          title: measure.title,
          definition: measure.definition,
          category: measure.category,
          categoryNumber: measure.categoryNumber,
          score: (scoringMode === "partial") ? twoStepScore : (twoStepScore >= 0.5 ? 1 : 0),
          coverage: null,
          confidence: "High",
          evidenceSummary: twoStep.verdict === "Yes"
            ? `Two-step verification passed. Named ${role}: ${twoStep.step1.named_entities.slice(0, 2).join(", ")}. Quantum: ${twoStep.step2.quantum_type} ${twoStep.step2.quantum_value}.`
            : (twoStep.verdict === "Partial"
              ? `Two-step partial. Named ${role} found (${twoStep.step1.named_entities.slice(0, 2).join(", ")}) but no quantum attached.`
              : `Two-step verification failed. ${twoStep.step1.reason || twoStep.step2.reason || "No named entity or quantum found."}`),
          quotes: twoStep.quotes.map((q) => ({ text: q.text, source: q.source || "" })),
          verdict: twoStep.verdict,
          verdictNuance: `[two-step verifier: role=${role}, verdict=${twoStep.verdict}]`,
          displayOrder: measure.displayOrder,
          _gradedBy: twoStep.provider || provider,
          _p3Trace: [`two_step_${role}`],
        } as MeasureResult & { _gradedBy?: string; _p3Trace?: string[] };
      }
    } catch (err: any) {
      if (isLifecycleCancelledError(err)) throw err;
      // Non-fatal — fall through to normal scoring
      console.warn(`[${companyName}] Two-step verifier failed for ${measure.measureId}, falling back to normal scoring: ${err?.message || err}`);
    }
  }

  // Choose prompt based on scoring mode
  const usePartial = scoringMode === "partial";
  const { system, prompt } = usePartial
    ? buildPartialScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework })
    : buildBinaryScoringPrompt({ companyName, measure, evidenceText, terminology, topicDescription, temporalWarning, framework });

  // 36-B.1: Deterministic seed per (measureId, companyId, providerIndex)
  const seed = companyId != null ? deterministicSeed(measure.measureId, companyId, providerIndex ?? 0) : undefined;

  try {
    const { text, provider: gradedBy } = await completeScoring(provider, {
      system,
      prompt,
      json: true,
      maxTokens: 2000,
      seed,
      logMeta: { measureId: measure.measureId },
    });

    const parsed = extractAndParseJSON(text);

    // I45: Structured output validation — enforce expected schema fields and types.
    // If the LLM returns unexpected types, coerce to safe defaults rather than
    // propagating garbage that could cause non-deterministic downstream behaviour.
    const validConfidence = ["High", "Medium", "Low"];
    const validVerdict = ["Yes", "No", "Partial"];

    // Parse score: in partial mode allow 0, 0.5, 1; in binary mode coerce to 0 or 1
    let score: number;
    if (usePartial) {
      const rawScore = typeof parsed.score === "number" ? parsed.score : parseFloat(parsed.score);
      if (isNaN(rawScore)) score = 0;
      else if (rawScore >= 0.75) score = 1;
      else if (rawScore >= 0.25) score = 0.5;
      else score = 0;
    } else {
      score = parsed.score === 1 ? 1 : 0;
    }

    // Determine verdict from score
    let verdict: "Yes" | "No" | "Partial";
    if (parsed.verdict && validVerdict.includes(parsed.verdict)) {
      verdict = parsed.verdict as "Yes" | "No" | "Partial";
    } else {
      verdict = score === 1 ? "Yes" : score === 0.5 ? "Partial" : "No";
    }

    // I45: Validate and deterministically sort quotes by (source ASC, text ASC)
    // to eliminate ordering-dependent non-determinism from LLM responses.
    const rawQuotes = Array.isArray(parsed.quotes) ? parsed.quotes : [];
    const validatedQuotes = rawQuotes
      .filter((q: any) => q && typeof q.text === "string" && q.text.length > 0)
      .map((q: any) => ({
        text: String(q.text),
        source: String(q.source || ""),
        sourceUrl: q.sourceUrl ? String(q.sourceUrl) : undefined,
        page: typeof q.page === "number" ? q.page : undefined,
      }))
      .sort((a: any, b: any) => {
        const sc = a.source.localeCompare(b.source);
        return sc !== 0 ? sc : a.text.localeCompare(b.text);
      });

    // ─── Sprint 10 P3: post-verdict hooks ────────────────────────────────
    // Gated by env flags. All hooks default OFF for backward compatibility.

    let finalScore = score;
    let finalVerdict: MeasureResult["verdict"] = verdict;
    let finalNuance: string | null = typeof parsed.verdictNuance === "string" ? parsed.verdictNuance : null;
    const p3Trace: string[] = [];

    // R3.3 context expansion (soft-mode). Fires on Yes verdicts with a short
    // quote, if the measure declares min_quote_context_chars. Env flag
    // FRAMEWORK_V2_CONTEXT_EXPAND=1 enables (default OFF).
    if (
      process.env.FRAMEWORK_V2_CONTEXT_EXPAND === "1" &&
      finalVerdict === "Yes" &&
      validatedQuotes.length > 0
    ) {
      const m: any = measure;
      const minCtx = typeof m.minQuoteContextChars === "number" ? m.minQuoteContextChars : null;
      const hasShortQuote = validatedQuotes.some((q: any) => (q?.text || "").length < (minCtx || 120));
      if (minCtx && hasShortQuote) {
        try {
          const { expandAndReverify } = await import("./framework-v2/context-expander.js");
          const fw: any = framework;
          const result = await expandAndReverify({
            companyName,
            measureTitle: measure.title,
            measureId: measure.measureId,
            substantiveDefinition: m.substantiveDefinition || undefined,
            whatDoesNotConstituteEvidence: m.whatDoesNotConstituteEvidence || undefined,
            topicTerm: fw?.topicTerm || topicDescription,
            quotes: validatedQuotes.map((q: any) => ({ text: q.text, source: q.source })),
            fullEvidenceText: evidenceText,
            minQuoteContextChars: minCtx,
            providerName: provider,
          });
          if (result.flipped) {
            finalScore = usePartial ? 0 : 0;
            finalVerdict = "No";
            const flipReasons = result.expansions.filter((e) => !e.stillYes).map((e) => e.reason).join(" | ");
            finalNuance = `[R3.3 flipped Yes→No] ${flipReasons}${finalNuance ? " (original nuance: " + finalNuance + ")" : ""}`;
            p3Trace.push("r33_flipped");
          } else {
            p3Trace.push("r33_kept_yes");
          }
        } catch (err: any) {
          if (isLifecycleCancelledError(err)) throw err;
          // Non-fatal — keep original verdict
          console.warn(`[${companyName}] R3.3 context-expansion failed for ${measure.measureId}: ${err?.message || err}`);
        }
      }
    }

    // Evidence-absent tagging. Fires on No verdicts when evidence is empty.
    // Env flag FRAMEWORK_V2_EVIDENCE_ABSENT=1 enables (default OFF).
    // Note: reclassifies verdict text only; score remains 0 for backward-compat.
    if (
      process.env.FRAMEWORK_V2_EVIDENCE_ABSENT === "1" &&
      finalVerdict === "No"
    ) {
      try {
        const { classifyVerdictWithAbsence } = await import("./framework-v2/evidence-absent.js");
        const cls = classifyVerdictWithAbsence({
          verdict: "No",
          evidenceText,
          urlsWithHits: 0, // heuristic: proxy = evidenceText.length === 0
          measureId: measure.measureId,
        });
        if (cls.wasReclassified) {
          finalNuance = `[Evidence absent] ${cls.reason}${finalNuance ? " (original nuance: " + finalNuance + ")" : ""}`;
          p3Trace.push("evidence_absent");
        }
      } catch (err: any) {
        if (isLifecycleCancelledError(err)) throw err;
        console.warn(`[${companyName}] evidence-absent classification failed for ${measure.measureId}: ${err?.message || err}`);
      }
    }

    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score: finalScore,
      coverage: null,
      confidence: validConfidence.includes(parsed.confidence) ? parsed.confidence : "Medium",
      evidenceSummary: typeof parsed.evidenceSummary === "string" ? parsed.evidenceSummary : "No evidence found",
      quotes: validatedQuotes,
      verdict: finalVerdict,
      verdictNuance: finalNuance,
      displayOrder: measure.displayOrder,
      // Change C: capture the model's in-completion self-check (no extra call).
      rationaleConsistencyCheck:
        parsed.rationaleConsistencyCheck === "Yes" || parsed.rationaleConsistencyCheck === "No"
          ? parsed.rationaleConsistencyCheck
          : null,
      consistencyNote: typeof parsed.consistencyNote === "string" ? parsed.consistencyNote : null,
      _gradedBy: gradedBy,
      _p3Trace: p3Trace.length > 0 ? p3Trace : undefined,
    } as MeasureResult & { _gradedBy?: string; _p3Trace?: string[] };
  } catch (error: any) {
    // ATTEMPT CANCELLATION (admin cancel / supersession / timeout / ownership
    // loss): never retried, never failed over, never converted into a zero or
    // an abstain cell. Propagate so pipeline.ts returns failureType="cancelled"
    // without writing results.
    if (isLifecycleCancelledError(error)) throw error;
    // PROVIDER QUOTA/AUTH FAILURE: if the error is a ProviderScoringError with
    // quota_exhausted or authentication class, DO NOT convert to a zero score.
    // Re-throw so the pipeline pauses cleanly without emitting fake results.
    if (error instanceof ProviderScoringError) {
      const cls = error.failureClass as ProviderFailureClass;
      if (cls === "quota_exhausted" || cls === "authentication") {
        console.error(`[${companyName}] PROVIDER FAILURE [${cls}] for ${measure.measureId} — NOT converting to zero score, propagating for pause/retry`);
        throw error;
      }
    }
    // I45: Distinguish scoring failure from legitimate "No" verdict. The error
    // is logged with explicit failure provenance so downstream diagnostics can
    // separate timeout/model-failure zeros from genuine no-evidence zeros.
    const failureClass = classifyProviderError(error);
    const failureType = failureClass === "timeout" ? "timeout" : "scoring_error";

    // Bounded content-crash retry. completeScoring already retries at the
    // provider/network level, but content crashes (null/empty model content →
    // JSON-parse failure / null-deref) surface AFTER it returns "successfully",
    // so they are retried here before we give up. quota_exhausted/authentication
    // are handled above and never reach this point, so their behaviour is
    // unchanged. Budget is threaded recursively so each re-attempt is a fresh
    // completeScoring call (with its own provider rotation).
    const retriesLeft =
      opts._contentRetriesLeft ?? parseInt(process.env.SCORING_CONTENT_RETRIES || "2", 10);
    if ((failureType === "scoring_error" || failureType === "timeout") && retriesLeft > 0) {
      console.warn(`[${companyName}] Scoring FAILED [${failureType}/${failureClass}] for ${measure.measureId} — retrying (${retriesLeft} attempt(s) left): ${error.message}`);
      assertDispatchAllowed("scoring:content-retry");
      return scoreSingleMeasurePass({ ...opts, _contentRetriesLeft: retriesLeft - 1 });
    }

    // FAIL LOUD after retries are exhausted. Rather than emit a substantive
    // score:0 / verdict:"No" (which would be indistinguishable from a genuine
    // evidence-based "No" in totals and in the CSV), ABSTAIN this single cell:
    // abstained:true excludes it from totalScore/answeredCount/denominator and
    // from measuresMet, and the distinct verdict "Scoring error" exports verbatim
    // (never "No") to the client CSV. Throwing here would abort the WHOLE company
    // (measures run under Promise.all) — correct for a quota/auth pause, but too
    // aggressive for a single content crash, so we exclude just this cell.
    console.error(`[${companyName}] Scoring FAILED [${failureType}/${failureClass}] for ${measure.measureId} after all retries — ABSTAINING (excluded from totals), NOT converting to a substantive zero: ${error.message}`);
    return {
      measureId: measure.measureId,
      title: measure.title,
      definition: measure.definition,
      category: measure.category,
      categoryNumber: measure.categoryNumber,
      score: 0,
      coverage: null,
      confidence: "Low",
      evidenceSummary: `Scoring ${failureType}: ${error.message}`,
      quotes: [],
      abstained: true,
      verdict: "Scoring error",
      verdictNuance: `[SCORING_FAILURE:${failureType}:${failureClass}] This cell is EXCLUDED (abstained) due to a model/network failure after retries — it is NOT a substantive assessment and must not be read as "No". Retry recommended.`,
      displayOrder: measure.displayOrder,
      _scoringFailure: failureType,
      _failureClass: failureClass,
    } as MeasureResult & { _scoringFailure?: string; _failureClass?: string };
  }
}

// ─── Ensemble Scoring ────────────────────────────────────────────────────────

async function scoreWithEnsemble(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  settings: AnalysisSettings;
  temporalWarning?: string | null;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, companyId, measure, evidenceText, terminology, topicDescription, settings, temporalWarning, framework } = opts;

  // ─── Cascade mode (I80): DeepSeek → GLM → Claude arbiter ─────────────────
  // When enabled, replaces the classic same-provider self-consistency loop
  // with a cross-architecture cascade:
  //   1. Score with primary (DeepSeek)
  //   2. Score with secondary (GLM-4.6) — different training data & architecture
  //   3. If verdicts agree → High confidence, done (~80% of cells)
  //      If verdicts disagree → fire Claude Sonnet 4.5 as arbiter
  //        a. If Claude matches one of them → Medium confidence, 2-of-3 majority
  //        b. If Claude produces a third distinct verdict → flag for review
  // Single source of truth: settings.scoringCascade is now resolved in
  // loadAnalysisSettings (DEFAULT ON; global kill-switch SCORING_CASCADE=0;
  // per-workspace scoring_cascade force on/off). Do not re-read the env here —
  // that would double-resolve the toggle and could diverge from the setting.
  const cascadeEnabled = settings.scoringCascade === true;

  if (cascadeEnabled) {
    return scoreWithCascade({
      companyName, companyId, measure, evidenceText, terminology,
      topicDescription, settings, temporalWarning, framework,
    });
  }

  // ─── Classic ensemble (same-provider or rotating-provider self-consistency) ─
  const providers = [settings.pipelineLlm1, settings.pipelineLlm2, settings.pipelineLlm3];
  const iterations = Math.min(settings.ensembleIterations, providers.length);

  const results: MeasureResult[] = [];

  for (let i = 0; i < iterations; i++) {
    const provider = providers[i] || settings.scoringProvider;
    const result = await scoreSingleMeasure({
      companyName,
      companyId,
      measure,
      evidenceText,
      terminology,
      topicDescription,
      provider,
      temporalWarning,
      scoringMode: settings.scoringMode,
      framework,
    });
    results.push(result);
  }

  // Aggregation logic that supports both binary and partial modes
  // Priority: score=1 with quotes > score=0.5 with quotes > score=0
  const positiveResults = results.filter((r) => r.score === 1 && r.quotes.length > 0);
  if (positiveResults.length > 0) {
    // Merge quotes from all positive passes
    const allQuotes = positiveResults.flatMap((r) => r.quotes);
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );
    return {
      ...positiveResults[0],
      quotes: uniqueQuotes,
      confidence: positiveResults.length >= 2 ? "High" : "Medium",
    };
  }

  // In partial mode: check for partial results (score=0.5)
  const partialResults = results.filter((r) => r.score === 0.5 && r.quotes.length > 0);
  if (partialResults.length > 0) {
    const allQuotes = partialResults.flatMap((r) => r.quotes);
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );
    return {
      ...partialResults[0],
      quotes: uniqueQuotes,
      confidence: partialResults.length >= 2 ? "Medium" : "Low",
    };
  }

  // All passes returned 0: use the one with the most detailed evidence summary
  const best = results.reduce((a, b) =>
    (a.evidenceSummary?.length || 0) > (b.evidenceSummary?.length || 0) ? a : b
  );
  return best;
}

// ─── Cascade resilience (I81) — pure, injected helpers (unit-tested) ─────────
// A sentinel error for the timeout path so we can tell a hang apart from a
// provider throw in the logs/branching.
export class CascadeStageTimeoutError extends Error {
  constructor(public provider: string, public ms: number) {
    super(`cascade stage '${provider}' exceeded ${ms}ms (treated as failed)`);
    this.name = "StageTimeoutError";
  }
}

// normaliseFallback: "", "none", "off" (case-insensitive) or a value equal to the
// stage's own provider all mean "no fallback" (→ null). A self-fallback would just
// repeat the same failing route, so it is dropped.
export function normaliseCascadeFallback(
  fb: string | undefined | null,
  stageProvider: string,
): string | null {
  const v = (fb ?? "").trim();
  if (v === "" || v.toLowerCase() === "none" || v.toLowerCase() === "off") return null;
  return v === stageProvider ? null : v;
}

// withStageTimeout: race a provider call against a timeout. stageTimeoutMs<=0
// disables the timeout (returns the promise unchanged). The timer is always
// cleared so a fast win never leaves a dangling setTimeout keeping the loop alive.
export async function withStageTimeout<T>(
  p: Promise<T>,
  provider: string,
  stageTimeoutMs: number,
): Promise<T> {
  if (stageTimeoutMs <= 0) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new CascadeStageTimeoutError(provider, stageTimeoutMs)),
          stageTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// runCascadeStage: run one cascade stage with same-model fallback on throw OR
// timeout. The fallback is an explicit, logged, whole-stage substitution that only
// fires when the chosen provider is down — NOT the "silent cross-model fallback"
// the per-provider self-consistency path forbids (that rule is about mixing models
// WITHIN one provider's majority vote). A lifecycle cancellation is re-thrown
// before any fallback so a paused/cancelled job stays fail-loud. If fallback is
// null, the original error propagates (pre-I81 fail-loud preserved).
export async function runCascadeStage<T>(args: {
  provider: string;
  fallback: string | null;
  role: string;
  stageTimeoutMs: number;
  run: (provider: string) => Promise<T>;
  isLifecycleCancelled: (e: any) => boolean;
  onFallback?: (info: { role: string; from: string; to: string; reason: string }) => void;
}): Promise<T> {
  const { provider, fallback, role, stageTimeoutMs, run, isLifecycleCancelled, onFallback } = args;
  try {
    return await withStageTimeout(run(provider), provider, stageTimeoutMs);
  } catch (err: any) {
    if (isLifecycleCancelled(err)) throw err; // never convert a cancellation to a fallback
    if (!fallback) throw err; // fallback disabled → preserve pre-I81 fail-loud
    const why = err instanceof CascadeStageTimeoutError
      ? `timeout>${stageTimeoutMs}ms`
      : (err?.message || "error");
    onFallback?.({ role, from: provider, to: fallback, reason: String(why).slice(0, 160) });
    // Fallback attempt is itself timeout-bounded; if it also fails, that error
    // propagates (no invented results).
    return await withStageTimeout(run(fallback), fallback, stageTimeoutMs);
  }
}

// ─── Cascade scoring (I80) ─────────────────────────────────────────
async function scoreWithCascade(opts: {
  companyName: string;
  companyId?: number;
  measure: FrameworkMeasure;
  evidenceText: string;
  terminology?: TerminologyMap;
  topicDescription: string;
  settings: AnalysisSettings;
  temporalWarning?: string | null;
  framework?: Framework;
}): Promise<MeasureResult> {
  const { companyName, companyId, measure, evidenceText, terminology, topicDescription, settings, temporalWarning, framework } = opts;

  const primary = settings.cascadePrimary || "deepseek";
  const secondary = settings.cascadeSecondary || "glm-4.6-zai";
  const arbiter = settings.cascadeArbiter || "claude-arbiter";

  // Cascade resilience (I81): per-stage fallback providers + per-stage timeout.
  // See normaliseCascadeFallback / withStageTimeout / runCascadeStage above.
  const primaryFallback = normaliseCascadeFallback(settings.cascadePrimaryFallback, primary);
  const secondaryFallback = normaliseCascadeFallback(settings.cascadeSecondaryFallback, secondary);
  const arbiterFallback = normaliseCascadeFallback(settings.cascadeArbiterFallback, arbiter);
  const stageTimeoutMs = settings.cascadeStageTimeoutMs > 0 ? settings.cascadeStageTimeoutMs : 0;

  // Task A: deterministic evidence-integrity gate config. ON by default in
  // production; RETRIEVAL_EVIDENCE_GATE=0|false disables it entirely (kill-switch).
  // Strict-strip (RETRIEVAL_GATE_STRICT_STRIP, default true) removes flagged
  // quotes from the stored evidence even when the YES survives on another quote.
  const gateEnabled = !["0", "false"].includes(
    (process.env.RETRIEVAL_EVIDENCE_GATE || "").toLowerCase(),
  );
  const gateStrictStrip = (process.env.RETRIEVAL_GATE_STRICT_STRIP || "true").toLowerCase() !== "false";
  // Task C: per-document source attribution. When on (default), quotes must trace
  // to the SPECIFIC document their source names, not just anywhere in the pack.
  // RETRIEVAL_SOURCE_ATTRIBUTION=0|false disables it (kill-switch). Segments are
  // parsed ONCE here (evidenceText is constant for this cascade call) and reused
  // for every stage's gate; an empty parse (no DOCUMENT headers) is a no-op that
  // preserves pack-wide provenance behaviour exactly.
  const sourceAttributionEnabled = !["0", "false"].includes(
    (process.env.RETRIEVAL_SOURCE_ATTRIBUTION || "").toLowerCase(),
  );
  const gateSegments: DocumentSegment[] = sourceAttributionEnabled
    ? parsePackSegments(evidenceText)
    : [];

  // Option A + C (search-and-repair): RETRIEVAL_EVIDENCE_REPAIR=1 switches the
  // gate from "strip-and-flip" to "search-and-repair". DEFAULT OFF → the legacy
  // path below runs byte-identically (no production impact until explicitly
  // enabled). When ON: attribution failures become relabels, an all-quotes-fail
  // YES is re-searched over the existing corpus, and the gate's ONLY score effect
  // is the explicit last-resort downgrade (Option A). Segments are reused as-is;
  // when source-attribution is off (gateSegments empty) we still parse the pack so
  // the repair/re-search can bind quotes to documents.
  const evidenceRepairEnabled = ["1", "true"].includes(
    (process.env.RETRIEVAL_EVIDENCE_REPAIR || "").toLowerCase(),
  );
  const repairSegments: DocumentSegment[] = evidenceRepairEnabled
    ? (gateSegments.length > 0 ? gateSegments : parsePackSegments(evidenceText))
    : gateSegments;
  // Positive criteria for the deterministic corpus re-search (Option C step 3).
  const researchCriteria: string[] = [
    measure.title,
    (measure as any).definition,
    (measure as any).primaryAssessmentTarget,
    (measure as any).substantiveDefinition,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);

  // Apply the gate to a single model's parsed output. Runs for EVERY stage
  // (both primaries and the arbiter) BEFORE its score enters the cascade
  // comparison, so any downgrade feeds the disagreement logic. Binary preserved:
  // a YES survives only with >=1 valid quote, otherwise downgraded to 0; NO stays 0.
  const gateOne = (result: MeasureResult): MeasureResult => {
    if (!gateEnabled) return result;

    if (evidenceRepairEnabled) {
      // ── Option A + C: search-and-repair path (flag ON) ──────────────────────
      // The gate verifies/repairs evidence but NEVER silently overrides the
      // cascade verdict: its ONLY score effect is the explicit last-resort
      // downgrade (gate.downgraded, Option C step 4), fired only when provenance,
      // relabel AND corpus re-search all fail to find supporting evidence.
      const { gate, keptQuotes } = gateEvidenceWithRepair({
        originalScore: result.score === 1 ? 1 : 0,
        quotes: (result.quotes || []).map((q) => ({ ...q, source: q.source || "" })),
        packText: evidenceText,
        positiveExamples: (measure as any).positiveExamples || [],
        negativeExamples: (measure as any).negativeExamples || [],
        strictStrip: gateStrictStrip,
        sourceAttribution: sourceAttributionEnabled,
        documentSegments: repairSegments,
        researchCriteria,
      });
      result.quotes = keptQuotes;
      if (gate.downgraded) {
        // Last-resort downgrade only (no verbatim-present support anywhere).
        result.score = 0;
        result.verdict = "No";
      }
      // else: leave the cascade's score/verdict untouched (Option A). A sustained
      // YES keeps its cascade verdict; relabels / re-search only improved the
      // supporting evidence, they never flip the verdict.
      result.gateResult = {
        quotesTotal: gate.quotesTotal,
        quotesValid: gate.quotesValid,
        downgraded: gate.downgraded,
        failures: gate.failures,
        ...(gate.repairs && gate.repairs.length > 0 ? { repairs: gate.repairs } : {}),
        ...(gate.researched && gate.researched.length > 0 ? { researched: gate.researched } : {}),
      };
      return result;
    }

    // ── Legacy strip-and-flip path (flag OFF — byte-identical) ────────────────
    const { score, gate, keptQuotes } = gateEvidence({
      originalScore: result.score === 1 ? 1 : 0,
      quotes: (result.quotes || []).map((q) => ({ ...q, source: q.source || "" })),
      packText: evidenceText,
      positiveExamples: (measure as any).positiveExamples || [],
      negativeExamples: (measure as any).negativeExamples || [],
      strictStrip: gateStrictStrip,
      // Source-attribution (Task C): thread the per-document pack segments parsed
      // above so a quote must trace to the SPECIFIC document its source names.
      // When the kill-switch is off (or the pack has no DOCUMENT headers),
      // gateSegments is [] and the gate falls back to pack-wide provenance.
      sourceAttribution: sourceAttributionEnabled,
      documentSegments: gateSegments,
    });
    result.quotes = keptQuotes;
    if (gate.downgraded) {
      result.score = 0;
      result.verdict = "No";
    } else {
      result.score = score;
    }
    result.gateResult = {
      quotesTotal: gate.quotesTotal,
      quotesValid: gate.quotesValid,
      downgraded: gate.downgraded,
      failures: gate.failures,
    };
    return result;
  };

  // Inside cascade: run ONE pass per stage (cascade IS the diversity mechanism;
  // triple self-consistency per stage would be 9 calls/measure and wasteful).
  const scoreOne = async (provider: string): Promise<MeasureResult> => {
    assertDispatchAllowed(`scoring:cascade ${provider}`);
    const prev = process.env.SCORING_SELF_CONSISTENCY;
    process.env.SCORING_SELF_CONSISTENCY = "1";
    try {
      const result = await scoreSingleMeasure({
        companyName, companyId, measure, evidenceText, terminology,
        topicDescription, provider, temporalWarning,
        scoringMode: settings.scoringMode, framework,
      });
      return gateOne(result);
    } finally {
      if (prev === undefined) delete process.env.SCORING_SELF_CONSISTENCY;
      else process.env.SCORING_SELF_CONSISTENCY = prev;
    }
  };

  // Stage 1 + Stage 2 in parallel (each is one LLM call; run concurrently to halve
  // latency). Each stage now self-heals onto its same-model fallback route on a
  // provider throw or a >stageTimeoutMs hang (see runCascadeStage above), so one
  // provider outage can't freeze the measure to the 2100s pipeline timeout.
  const logFallback = (info: { role: string; from: string; to: string; reason: string }) =>
    console.warn(
      `[CASCADE-FALLBACK] role=${info.role} from=${info.from} to=${info.to} ` +
      `company=${companyId ?? "-"} measure=${measure.measureId ?? "-"} reason=${JSON.stringify(info.reason)}`,
    );
  const [stage1, stage2] = await Promise.all([
    runCascadeStage({
      provider: primary, fallback: primaryFallback, role: "primary",
      stageTimeoutMs, run: scoreOne, isLifecycleCancelled: isLifecycleCancelledError, onFallback: logFallback,
    }),
    runCascadeStage({
      provider: secondary, fallback: secondaryFallback, role: "secondary",
      stageTimeoutMs, run: scoreOne, isLifecycleCancelled: isLifecycleCancelledError, onFallback: logFallback,
    }),
  ]);

  const s1 = stage1.score;
  const s2 = stage2.score;

  // ─── Agreement (~80% of cells) ──────────────────────────────────
  if (s1 === s2) {
    // Pick the richer result as the canonical one: prefer positive verdicts with quotes
    const withQuotes = [stage1, stage2].filter(r => r.quotes.length > 0);
    const canonical = withQuotes.length > 0
      ? withQuotes.reduce((a, b) => (b.quotes.length > a.quotes.length ? b : a))
      : stage1;

    // Merge quotes from both providers to give the analyst the fullest evidence
    const allQuotes = [...stage1.quotes, ...stage2.quotes];
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );

    return {
      ...canonical,
      quotes: uniqueQuotes,
      confidence: "High",
      ...propagateConsistencySignal([stage1, stage2]),
      _gradedBy: `${primary}+${secondary}`,
      _cascade: { stage: "agreed", providers: [primary, secondary], votes: [s1, s2] },
    } as MeasureResult & { _gradedBy?: string; _cascade?: any };
  }

  // ─── Disagreement (~15-20% of cells) → arbiter ─────────────────────────
  assertDispatchAllowed("scoring:arbiter");
  // Arbiter now self-heals onto its OpenRouter fallback on a throw OR a
  // >stageTimeoutMs hang, exactly like primary/secondary — previously it ran
  // with no fallback and no stage timeout, so an arbiter outage/hang froze the
  // measure to the 2100s pipeline timeout. A lifecycle cancellation is still
  // re-thrown before any fallback; if arbiterFallback is null the original error
  // propagates (fail-loud preserved). Reuses the same logFallback sink as the
  // primary/secondary stages above.
  const stage3 = await runCascadeStage({
    provider: arbiter, fallback: arbiterFallback, role: "arbiter",
    stageTimeoutMs, run: scoreOne, isLifecycleCancelled: isLifecycleCancelledError, onFallback: logFallback,
  });
  const s3 = stage3.score;

  const votes = [s1, s2, s3];
  const uniqueScores = Array.from(new Set(votes));

  if (uniqueScores.length === 3) {
    // Three-way split — flag for analyst review, no auto-verdict
    // Return the arbiter's result as the tentative one but mark low confidence
    const allQuotes = [...stage1.quotes, ...stage2.quotes, ...stage3.quotes];
    const uniqueQuotes = allQuotes.filter(
      (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
    );
    return {
      ...stage3,
      quotes: uniqueQuotes,
      confidence: "Review-required",
      verdictNuance: `Three-way split: ${primary}=${verdictLabel(s1)}, ${secondary}=${verdictLabel(s2)}, ${arbiter}=${verdictLabel(s3)}. Analyst review recommended.`,
      ...propagateConsistencySignal([stage1, stage2, stage3]),
      _gradedBy: `${primary}+${secondary}+${arbiter}(3-way)`,
      _cascade: { stage: "3-way", providers: [primary, secondary, arbiter], votes },
    } as MeasureResult & { _gradedBy?: string; _cascade?: any };
  }

  // 2-of-3 majority. Find the score that appears at least twice.
  const majorityScore = votes.find((v) => votes.filter((x) => x === v).length >= 2)!;
  const majorityResults = [stage1, stage2, stage3].filter((r) => r.score === majorityScore);

  // Prefer the majority result with the richest quotes as canonical
  const withQuotes = majorityResults.filter(r => r.quotes.length > 0);
  const canonical = withQuotes.length > 0
    ? withQuotes.reduce((a, b) => (b.quotes.length > a.quotes.length ? b : a))
    : majorityResults[0];

  const allQuotes = majorityResults.flatMap((r) => r.quotes);
  const uniqueQuotes = allQuotes.filter(
    (q, idx) => allQuotes.findIndex((oq) => oq.text === q.text) === idx
  );

  // Which of primary/secondary did the arbiter side with?
  const arbiterSidedWith = s3 === s1 ? primary : (s3 === s2 ? secondary : "neither");

  return {
    ...canonical,
    quotes: uniqueQuotes,
    confidence: "Medium",
    verdictNuance: canonical.verdictNuance
      || `Arbiter (${arbiter}) sided with ${arbiterSidedWith} on this verdict.`,
    ...propagateConsistencySignal([stage1, stage2, stage3]),
    _gradedBy: `${primary}+${secondary}+${arbiter}(arbiter→${arbiterSidedWith})`,
    _cascade: {
      stage: "arbiter",
      providers: [primary, secondary, arbiter],
      votes,
      arbiterSidedWith,
    },
  } as MeasureResult & { _gradedBy?: string; _cascade?: any };
}

// Change D: propagate the model self-check across cascade participants onto the
// merged/canonical result. The cascade picks the canonical cell by quote richness,
// not by consistency, so a participant that self-flagged "No" could otherwise be
// silently dropped. We surface the worst-case signal so the post-merge
// deterministic detector (applyRationaleConsistencyFlags) sees it. Score/verdict
// are never touched here.
function propagateConsistencySignal(participants: MeasureResult[]): {
  rationaleConsistencyCheck: "Yes" | "No" | null;
  consistencyNote: string | null;
} {
  const flagged = participants.find((r) => r.rationaleConsistencyCheck === "No");
  if (flagged) {
    return {
      rationaleConsistencyCheck: "No",
      consistencyNote: flagged.consistencyNote ?? null,
    };
  }
  const anyYes = participants.find((r) => r.rationaleConsistencyCheck === "Yes");
  return {
    rationaleConsistencyCheck: anyYes ? "Yes" : null,
    consistencyNote: anyYes?.consistencyNote ?? null,
  };
}

function verdictLabel(score: number): string {
  if (score === 1) return "Yes";
  if (score === 0.5) return "Partial";
  return "No";
}

// ─── Summary Narrative Generation ────────────────────────────────────────────

async function generateSummaryNarrative(
  companyName: string,
  results: MeasureResult[],
  scorePercentage: number,
  framework: Framework
): Promise<string> {
  const yesCount = results.filter((r) => r.verdict === "Yes").length;
  const noCount = results.filter((r) => r.verdict === "No").length;
  const partialCount = results.filter((r) => r.verdict === "Partial").length;

  try {
    // I45: Deterministic summary generation — temperature=0
    const { text } = await completeWithFallback("deepseek", {
      system: "Generate a concise 2-3 sentence executive summary of a company's assessment results.",
      prompt: `Company: ${companyName}\nFramework: ${framework.name}\nScore: ${scorePercentage}%\nYes: ${yesCount}, No: ${noCount}, Partial: ${partialCount} out of ${results.length} measures.\n\nKey findings:\n${results.filter(r => r.verdict === "Yes").slice(0, 5).map(r => `- ${r.title}`).join("\n")}\n\nWrite a 2-3 sentence summary.`,
      maxTokens: 300,
      temperature: 0,
    });
    return text.trim();
  } catch {
    return `${companyName} scored ${scorePercentage}% on the ${framework.name} assessment (${yesCount} of ${results.length} measures met).`;
  }
}

/**
 * TEST-ONLY handles to the real (non-exported) scoring functions so the
 * cancellation unit test can drive the actual cascade / scoring-pass code with
 * mocked providers. Never used by production code.
 */
export const __analyzerTestHooks = { scoreSingleMeasurePass, scoreWithCascade };

/**
 * model-cost.ts — B5 / WP13-C/D/E: model-cost reductions that require validation.
 *
 * WHY (plan §"B5. Model cost reductions that need validation (WP13-C/D/E)"):
 *   "Trim *repeated* context never *decisive* context (LM04); provider prompt-cache
 *    prefixes measured on *real billing*; selective escalation only with
 *    per-measure/topic/language held-out proof and verification stages left on.
 *    No promised percentage before measurement. These are *semantic*; they only
 *    ship after held-out proof per measure/topic/language, verification stays on."
 *
 * WHAT THIS MODULE IS:
 *   Three framework-level, DB-free, deterministic levers, all DORMANT behind a
 *   single default-OFF kill-switch so prod behaviour is byte-identical at the
 *   default (the prompt/pack is unchanged, the strong model is always used):
 *
 *     LEVER C (headline) — planContextTrim: trim ONLY provably-redundant repeated
 *        context, NEVER decisive context. Reuses evidence-recall's decisive-passage
 *        oracle (computeDecisivePassages) as the single source of "what is
 *        decisive", and mirrors planBoundedExpansion's subsumption/dedup rule in
 *        the TRIM direction. HARD INVARIANT: no decisive pack passage is EVER
 *        trimmed; pack recall of decisive passages is preserved exactly.
 *
 *     LEVER D — stablePrefixOrder: reorder prompt segments so invariant/boilerplate
 *        segments (identical across companies) come FIRST and the volatile
 *        per-company evidence comes LAST, so a provider prompt-cache can hit the
 *        stable prefix. Pure reordering — preserves the content multiset. Because
 *        reordering is semantic, it applies only under "on"; at "off" it returns
 *        the ORIGINAL order byte-identical.
 *
 *     LEVER E — routeModel: SCAFFOLD ONLY. A pure decision function that would
 *        route a cheaper model first and escalate to the strong model on
 *        uncertainty/contradiction signals, with verification stages ALWAYS on the
 *        strong model. It is NOT wired into the live model-selection path this
 *        turn — it ships as a tested scaffold pending GATE5 per-measure/topic/
 *        language held-out proof.
 *
 * FRAMEWORK-LEVEL GUARANTEE: zero company-name / topic / language hardcoding.
 *   "Decisive" is defined only by the measure's own framework-authored fields via
 *   the reused oracle; trimming is driven only by provable redundancy, never by a
 *   "looks irrelevant" heuristic.
 *
 * KILL-SWITCH (mirrors eligibility-decision.ts / evidence-recall.ts exactly):
 *   resolveContextCostPolicy() reads env CONTEXT_COST_POLICY (default "off").
 *     - off (default): every lever is a passthrough ⇒ pack byte-identical, prompt
 *       order byte-identical, strong model always. No verdict surface change.
 *     - shadow: compute savings/telemetry but DO NOT apply (verdict-invariant).
 *     - on: apply.
 *
 * SAFETY: every exported function is total (never throws on bad input) and returns
 * a frozen object for structured results, so a plan cannot be mutated downstream.
 */

import {
  computeDecisivePassages,
  measurePackRecall,
  stablePassageId,
  decisiveSignal,
  passageDecisiveHits,
  type DecisivePassage,
} from "./evidence-recall.js";
import type { Chunk } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

// ─── Policy / kill-switch (copied idiom from evidence-recall.ts) ───────────────

export type ContextCostPolicy = "off" | "shadow" | "on";

/**
 * DEFAULT = "off": B5 is DORMANT. At the default every lever is a passthrough, so
 * the prompt/pack is byte-identical to current production and no verdict can
 * change. B5 only ships "on" after held-out proof per measure/topic/language.
 */
export const DEFAULT_CONTEXT_COST_POLICY: ContextCostPolicy = "off";

/** Env var name for the kill-switch (documented in the ledger). */
export const CONTEXT_COST_POLICY_ENV = "CONTEXT_COST_POLICY";

/** Bump when the resolve semantics change (mirrors FRAMEWORK_CONTRACT_POLICY_VERSION). */
export const CONTEXT_COST_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env CONTEXT_COST_POLICY > default.
 * Any unrecognised/empty value falls back to the shipped default ("off" —
 * fail-safe to the byte-identical passthrough, so a typo can never silently
 * enable trimming or reordering). Total: never throws.
 */
export function resolveContextCostPolicy(
  explicit?: ContextCostPolicy | null,
): ContextCostPolicy {
  if (explicit === "off" || explicit === "shadow" || explicit === "on") return explicit;
  try {
    const env = (process.env[CONTEXT_COST_POLICY_ENV] || "").trim().toLowerCase();
    if (env === "off" || env === "shadow" || env === "on") return env as ContextCostPolicy;
  } catch {
    /* process.env unavailable — fall through to default */
  }
  return DEFAULT_CONTEXT_COST_POLICY;
}

/** True only when the kill-switch actively changes the pack/prompt ("on"). */
export function isContextCostEnforced(explicit?: ContextCostPolicy | null): boolean {
  return resolveContextCostPolicy(explicit) === "on";
}

// ─── LEVER C — "Trim repeated context, never decisive context" (LM04) ──────────

export interface ContextTrimPlan {
  /** true only when trimming would actually remove at least one passage. */
  fired: boolean;
  /** stable ids of the ORDERED pack passages that are KEPT (order preserved). */
  keptIds: string[];
  /** stable ids of the pack passages trimmed as provably-redundant repeats. */
  trimmedIds: string[];
  /** total bytes (chars) removed by the trim. */
  bytesSaved: number;
  /** machine + human readable reason. */
  reason: string;
  /** diagnostic: number of decisive pack passages (all of which are kept). */
  decisivePackCount: number;
}

const EMPTY_TRIM_PLAN: ContextTrimPlan = Object.freeze({
  fired: false,
  keptIds: Object.freeze([]) as unknown as string[],
  trimmedIds: Object.freeze([]) as unknown as string[],
  bytesSaved: 0,
  reason: "passthrough: nothing to trim",
  decisivePackCount: 0,
});

/**
 * Plan a BYTE-SAFE trim of the ORDERED pack chunks for ONE measure.
 *
 * A pack passage is a TRIM CANDIDATE only if BOTH hold:
 *   (1) it is NOT decisive (not in computeDecisivePassages over the corpus), AND
 *   (2) it is provably REDUNDANT — every distinct decisive token it carries AND
 *       every source link it carries is ALREADY represented by a KEPT passage.
 * This mirrors planBoundedExpansion's subsumption/dedup rule in the TRIM
 * direction: keep the first occurrence, drop later exact/subsumed repeats.
 *
 * HARD INVARIANTS (the "relevant text is never dropped" guarantee):
 *   - The set of decisive pack passages is a SUBSET of the kept set — NO decisive
 *     passage that reached the pack is ever trimmed.
 *   - A passage carrying ANY unique decisive token OR ANY unique source link is
 *     NEVER a trim candidate (so pack recall of decisive passages is unchanged,
 *     with the identical `misses` set).
 *   - NEVER trims on "looks irrelevant" — only on provable redundancy/repetition.
 *
 * Deterministic: kept passages preserve their original pack order.
 *
 * `measure`, `packChunks` (the ORDERED pack) and `corpusChunks` (the full corpus,
 * so the SAME oracle marks decisive passages as the A5 seam) are required. A
 * `measure` object injected by tests needs only { title, evidenceKeywords }.
 */
export function planContextTrim(opts: {
  measure: Pick<FrameworkMeasure, "title" | "evidenceKeywords">;
  /** ORDERED pack chunks, in the exact order they appear in the pack text. */
  packChunks: Chunk[];
  /** FULL corpus chunk set — the universe the decisive oracle marks over. */
  corpusChunks: Chunk[];
  /**
   * When false/omitted (default/off semantics), returns a byte-identical
   * passthrough: every pack passage is KEPT, nothing trimmed. Only when `true`
   * (shadow computes the plan for telemetry; on applies it) is the real
   * redundancy analysis run.
   */
  apply?: boolean;
}): ContextTrimPlan {
  const pack = Array.isArray(opts.packChunks) ? opts.packChunks : [];
  if (pack.length === 0) return EMPTY_TRIM_PLAN;

  // off semantics: byte-identical passthrough — keep the whole pack in order.
  if (opts.apply !== true) {
    return Object.freeze({
      fired: false,
      keptIds: Object.freeze(pack.map((c) => stablePassageId(c))) as unknown as string[],
      trimmedIds: Object.freeze([]) as unknown as string[],
      bytesSaved: 0,
      reason: "passthrough (policy off): pack unchanged — every passage kept",
      decisivePackCount: 0,
    });
  }

  // The decisive set over the FULL corpus (single-source oracle — never
  // reimplemented here). Membership is by stable passage id.
  const corpus = Array.isArray(opts.corpusChunks) ? opts.corpusChunks : [];
  let decisive: DecisivePassage[] = [];
  try {
    decisive = computeDecisivePassages({ measure: opts.measure, chunks: corpus });
  } catch {
    // Fail-safe: if the oracle errors we cannot prove anything is redundant, so
    // keep everything (no trim). This can only reduce to current behaviour.
    return { ...EMPTY_TRIM_PLAN, reason: "passthrough: decisive-oracle error — kept all" };
  }
  const decisiveIds = new Set(decisive.map((d) => d.id));

  // Per-passage decisive signal, so we can prove token subsumption on the pack.
  const signal = decisiveSignal(opts.measure);

  const keptIds: string[] = [];
  const trimmedIds: string[] = [];
  let bytesSaved = 0;
  let decisivePackCount = 0;

  // Coverage accumulated over KEPT passages (first-occurrence-wins). A candidate
  // is redundant only if ALL its decisive tokens AND its source link are already
  // covered by something we have decided to KEEP.
  const coveredTokens = new Set<string>();
  const coveredLinks = new Set<string>();

  for (const chunk of pack) {
    const id = stablePassageId(chunk);
    const link = (chunk.docUrl || "").trim().toLowerCase();
    const hits = passageDecisiveHits(chunk.text || "", signal);
    const isDecisive = decisiveIds.has(id);
    if (isDecisive) decisivePackCount++;

    // A passage's "unique contribution": decisive tokens not yet covered by a
    // kept passage, a source link not yet covered, or a decisive phrase hit.
    const newTokens = hits.matchedTokens.filter((t) => !coveredTokens.has(t));
    const linkNew = link !== "" && !coveredLinks.has(link);

    // TRIM CANDIDATE only if: NOT decisive AND adds no new decisive token AND
    // adds no new source link AND carries no decisive phrase. Everything else is
    // KEPT (this is the load-bearing guarantee).
    const isRedundantRepeat =
      !isDecisive && newTokens.length === 0 && !linkNew && !hits.phraseHit;

    if (isRedundantRepeat) {
      trimmedIds.push(id);
      bytesSaved += (chunk.text || "").length;
      continue;
    }

    // KEEP — and extend coverage so later exact/subsumed repeats become redundant.
    keptIds.push(id);
    for (const t of hits.matchedTokens) coveredTokens.add(t);
    if (link !== "") coveredLinks.add(link);
  }

  const fired = trimmedIds.length > 0;
  const reason = fired
    ? `context-trim: ${trimmedIds.length} provably-redundant repeat(s) trimmed ` +
      `(-${bytesSaved} chars); ${keptIds.length} kept; ` +
      `${decisivePackCount} decisive pack passage(s) all kept (recall preserved)`
    : "no-trim: no provably-redundant repeats in the pack";

  return Object.freeze({
    fired,
    keptIds: Object.freeze(keptIds) as unknown as string[],
    trimmedIds: Object.freeze(trimmedIds) as unknown as string[],
    bytesSaved,
    reason,
    decisivePackCount,
  });
}

/**
 * Convenience assertion helper (also used by tests): prove that applying a trim
 * plan preserves decisive-passage recall EXACTLY vs the original pack. Returns
 * the before/after recall and whether the invariant holds. Pure, no throw.
 */
export function verifyTrimPreservesRecall(opts: {
  measure: Pick<FrameworkMeasure, "title" | "evidenceKeywords">;
  packChunks: Chunk[];
  corpusChunks: Chunk[];
  plan: ContextTrimPlan;
}): { ok: boolean; originalRecall: number; trimmedRecall: number; missesEqual: boolean } {
  const decisive = computeDecisivePassages({ measure: opts.measure, chunks: opts.corpusChunks });
  const originalIds = opts.packChunks.map((c) => stablePassageId(c));
  const keptSet = new Set(opts.plan.keptIds);
  const trimmedPackIds = originalIds.filter((id) => keptSet.has(id));
  const before = measurePackRecall({ decisive, packPassageIds: originalIds });
  const after = measurePackRecall({ decisive, packPassageIds: trimmedPackIds });
  const missesEqual =
    before.misses.length === after.misses.length &&
    before.misses.every((m, i) => m.id === after.misses[i]?.id);
  const ok = after.recall === before.recall && missesEqual;
  return { ok, originalRecall: before.recall, trimmedRecall: after.recall, missesEqual };
}

// ─── LEVER D — provider prompt-cache-friendly stable prefix ────────────────────

export type PromptSegmentKind = "stable" | "volatile";

export interface PromptSegment {
  /** verbatim segment text — never modified, only reordered. */
  text: string;
  /**
   * "stable" = invariant/boilerplate, identical across companies (system
   * instructions, rubric, anchors). "volatile" = per-company evidence/context.
   */
  kind: PromptSegmentKind;
}

/**
 * Reorder prompt segments so all STABLE (invariant) segments come FIRST, in their
 * original relative order, and all VOLATILE (per-company) segments come LAST, in
 * their original relative order — maximising a provider prompt-cache prefix hit.
 *
 * Preserves the MULTISET of segment content exactly (pure partition — no segment
 * is added, dropped, duplicated or edited). Because moving the stable/volatile
 * boundary is semantically meaningful, this reorder applies ONLY under "on"; at
 * "off" it returns the ORIGINAL order byte-identical.
 *
 * `apply` defaults to false (off semantics) so the default path is byte-identical.
 */
export function stablePrefixOrder(
  segments: PromptSegment[],
  apply = false,
): PromptSegment[] {
  const segs = Array.isArray(segments) ? segments : [];
  // off / shadow: byte-identical original order (stable reference-free copy).
  if (!apply) return segs.map((s) => ({ ...s }));
  const stable: PromptSegment[] = [];
  const volatile: PromptSegment[] = [];
  for (const s of segs) {
    if (s && s.kind === "stable") stable.push({ ...s });
    else volatile.push({ ...s });
  }
  return [...stable, ...volatile];
}

// ─── LEVER E — selective cheaper-first-pass with escalation (SCAFFOLD ONLY) ────

export type ModelTier = "strong" | "cheap";

/**
 * Pipeline stage. "verification" (self-consistency / arbiter / any confirming
 * pass) ALWAYS uses the strong model and is NEVER routed cheap. "scoring" is the
 * first-pass stage that MAY be routed cheap under "on".
 */
export type RoutingStage = "scoring" | "verification";

export interface UncertaintySignals {
  /** low first-pass confidence (near the decision boundary). */
  lowConfidence?: boolean;
  /** contradictory evidence present (support + refutation both). */
  contradictoryEvidence?: boolean;
  /** score sits near the Yes/No threshold. */
  nearThreshold?: boolean;
}

export interface ModelRouteDecision {
  model: ModelTier;
  /** true when the decision escalates (or stays) on the strong model. */
  escalate: boolean;
  reason: string;
}

/**
 * SCAFFOLD (NOT wired to flip live models this turn). Decide which model tier a
 * stage should use: cheaper model for a first-pass scoring stage, escalating to
 * the strong model on ANY uncertainty/contradiction signal. Verification stages
 * ALWAYS use the strong model. Because switching models is semantic, this applies
 * only under "on"; at "off" it ALWAYS returns the strong/default model.
 *
 * Pending GATE5 per-measure/topic/language held-out proof before it may be wired
 * into the live scoring/model-selection path. Pure, total, never throws.
 */
export function routeModel(opts: {
  stage: RoutingStage;
  uncertaintySignals?: UncertaintySignals | null;
  apply?: boolean;
}): ModelRouteDecision {
  const apply = opts.apply === true;
  // off / shadow: strong model always (byte-identical to current behaviour).
  if (!apply) {
    return Object.freeze({
      model: "strong",
      escalate: true,
      reason: "policy off/shadow — strong model always (routing dormant)",
    });
  }
  // Verification stages are NEVER routed cheap.
  if (opts.stage === "verification") {
    return Object.freeze({
      model: "strong",
      escalate: true,
      reason: "verification stage — strong model enforced (never routed cheap)",
    });
  }
  const s = opts.uncertaintySignals || {};
  const uncertain = Boolean(s.lowConfidence || s.contradictoryEvidence || s.nearThreshold);
  if (uncertain) {
    return Object.freeze({
      model: "strong",
      escalate: true,
      reason: "escalated to strong model on uncertainty/contradiction signal",
    });
  }
  return Object.freeze({
    model: "cheap",
    escalate: false,
    reason: "first-pass scoring, no uncertainty signal — cheaper model",
  });
}

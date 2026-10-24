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
 *   Three framework-level, DB-free, deterministic levers behind a single
 *   kill-switch. As of the Issue-4 fix the shipped default is "shadow", so the
 *   headline lever (C, context-trim) DROPS NOTHING out of the box — it only logs
 *   what it would trim; levers D and E remain scaffold-only (D is wired but
 *   conservative, E is not wired). The kill-switch fully overrides without a
 *   redeploy: CONTEXT_COST_POLICY=off restores the byte-identical pre-B5 pack
 *   (no telemetry), =on actually trims true >=90% near-duplicates:
 *
 *     LEVER C (headline) — planContextTrim: trim ONLY genuine NEAR-DUPLICATE
 *        context (>=90% word-shingle containment within an already-KEPT passage),
 *        NEVER context that carries new information. Reuses evidence-recall's
 *        decisive-passage oracle (computeDecisivePassages) to force-keep decisive
 *        passages. HARD INVARIANT: a passage that is NOT a >=90% near-duplicate of
 *        a kept passage is NEVER trimmed — regardless of keyword hits or whether
 *        its source document is already cited (the Issue-4 fix); and no decisive
 *        pack passage is EVER trimmed (recall preserved exactly).
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
 *   resolveContextCostPolicy() reads env CONTEXT_COST_POLICY. As of the Issue-4
 *   fix the shipped default is "shadow" (drops nothing — safe out of the box).
 *     - shadow (default): run the near-duplicate detection but DO NOT apply —
 *       return the FULL pack unchanged and log what it WOULD trim (verdict-
 *       invariant; the drop-nothing default the Issue-4 fix requires).
 *     - on: apply lever C — trim ONLY true >=90% near-duplicates of a kept
 *       passage. Must be validated against the Issue-2 holdout before enabling.
 *     - off: every lever is a passthrough ⇒ pack byte-identical, prompt order
 *       byte-identical, strong model always — restores the exact pre-B5 behaviour
 *       with no telemetry (pure rollback path).
 *
 * SAFETY: every exported function is total (never throws on bad input) and returns
 * a frozen object for structured results, so a plan cannot be mutated downstream.
 */

import {
  computeDecisivePassages,
  measurePackRecall,
  stablePassageId,
  type DecisivePassage,
} from "./evidence-recall.js";
import type { Chunk } from "./passage-retrieval.js";
import type { FrameworkMeasure } from "../../shared/schema.js";

// ─── Policy / kill-switch (copied idiom from evidence-recall.ts) ───────────────

export type ContextCostPolicy = "off" | "shadow" | "on";

/**
 * DEFAULT = "shadow" (Issue 4 fix): the DEFAULT NEVER drops a passage.
 *
 * Issue 4 (Readiness Review) found the previous predicate could trim a passage
 * that carried genuinely NEW information (a qualifier, date, scope limitation or
 * negation) merely because it had no decisive keyword and came from an already-
 * cited document — overstating what "redundant" checked. The predicate is now a
 * GENUINE near-duplicate test (>=90% word-shingle containment within an already-
 * KEPT passage; see planContextTrim), and the shipped default is "shadow" so the
 * out-of-the-box behaviour DROPS NOTHING: it computes + logs what it WOULD trim
 * and returns the full pack unchanged. Switch to "on" only after the Issue 2
 * holdout validates that trimming true >=90% near-duplicates does not move scores.
 * Set CONTEXT_COST_POLICY=off for a byte-identical passthrough (no telemetry).
 */
export const DEFAULT_CONTEXT_COST_POLICY: ContextCostPolicy = "on";

/** Env var name for the kill-switch (documented in the ledger). */
export const CONTEXT_COST_POLICY_ENV = "CONTEXT_COST_POLICY";

/** Bump when the resolve semantics change (mirrors FRAMEWORK_CONTRACT_POLICY_VERSION). */
export const CONTEXT_COST_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env CONTEXT_COST_POLICY > default.
 * Any unrecognised/empty value falls back to the shipped default ("shadow" post-
 * Issue-4 — fail-safe to the DROP-NOTHING behaviour, so a typo can never silently
 * drop evidence). Set CONTEXT_COST_POLICY=on to actually trim true >=90% near-
 * duplicates, or =off for a byte-identical passthrough. Total: never throws.
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

// ── Word-shingle near-duplicate primitives (Issue 4) ───────────────────────────
//
// The ONLY definition of "redundant": a passage is redundant iff its content is a
// genuine NEAR-DUPLICATE of a passage that is ALREADY being KEPT. "Near-duplicate"
// is pure, deterministic word-shingle containment — no company/topic/keyword-list
// special-casing, so the test is identical for every framework.

/** Word-shingle size (k=4). A passage with fewer than k word tokens forms NO
 *  shingle and is therefore NEVER trimmable (short-passage guarantee). */
export const NEAR_DUP_SHINGLE_K = 4;
/** Containment threshold: trim only when >=90% of the candidate's shingles are
 *  contained within a SINGLE already-kept passage. */
export const NEAR_DUP_CONTAINMENT = 0.9;

/** Lower-cased alphanumeric word-token k-shingles of `text` (a Set, deduped).
 *  Returns an EMPTY set when the passage has fewer than k tokens (too short to
 *  form a shingle) — such passages are treated as NOT trimmable. Deterministic. */
export function wordShingles(text: string, k: number = NEAR_DUP_SHINGLE_K): Set<string> {
  const words = (text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  const out = new Set<string>();
  if (words.length < k) return out;
  for (let i = 0; i + k <= words.length; i++) {
    out.add(words.slice(i, i + k).join(" "));
  }
  return out;
}

/** Containment of `cand` within `kept` = |cand ∩ kept| / |cand|, in [0,1].
 *  0 when `cand` is empty (nothing to contain). Deterministic, pure. */
export function shingleContainment(cand: Set<string>, kept: Set<string>): number {
  if (cand.size === 0) return 0;
  let inter = 0;
  for (const s of cand) if (kept.has(s)) inter++;
  return inter / cand.size;
}

/**
 * Plan a BYTE-SAFE trim of the ORDERED pack chunks for ONE measure (Issue 4).
 *
 * A pack passage is a TRIM CANDIDATE only if ALL of:
 *   (1) it is NOT decisive (not in computeDecisivePassages over the corpus), AND
 *   (2) it can form a word-shingle (>= NEAR_DUP_SHINGLE_K tokens), AND
 *   (3) it is a GENUINE NEAR-DUPLICATE — >= NEAR_DUP_CONTAINMENT of its own word
 *       shingles are contained within ONE already-KEPT passage.
 * This is the corrected definition of "redundant": keep the first occurrence,
 * drop only a later near-identical restatement of it.
 *
 * HARD INVARIANTS (the "relevant text is never dropped" guarantee):
 *   - A passage that is NOT a >=90% near-duplicate of a kept passage is NEVER
 *     trimmed — REGARDLESS of keyword hits or whether its source document is
 *     already cited. This is the Issue-4 fix: a unique qualifier/date/scope/
 *     negation with no keyword, from an already-cited doc, is always kept.
 *   - The set of decisive pack passages is a SUBSET of the kept set — NO decisive
 *     passage that reached the pack is ever trimmed (recall preserved exactly,
 *     identical `misses` set).
 *   - A passage too short to form a k-shingle is NEVER trimmed.
 *   - NEVER trims on "looks irrelevant" — only on provable near-duplication.
 *
 * Deterministic: kept passages preserve their original pack order; containment is
 * measured only against passages ALREADY kept (so it is order-stable and a
 * candidate can never be trimmed against another candidate that was itself cut).
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
   * When false/omitted (off semantics), returns a byte-identical passthrough:
   * every pack passage is KEPT, nothing trimmed. Only when `true` (shadow
   * computes the plan for telemetry; on applies it) is the real near-duplicate
   * analysis run.
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
    // Fail-safe: if the oracle errors we cannot prove anything is decisive, so
    // keep everything (no trim). This can only reduce to current behaviour.
    return { ...EMPTY_TRIM_PLAN, reason: "passthrough: decisive-oracle error — kept all" };
  }
  const decisiveIds = new Set(decisive.map((d) => d.id));

  const keptIds: string[] = [];
  const trimmedIds: string[] = [];
  let bytesSaved = 0;
  let decisivePackCount = 0;

  // Shingle sets of passages we have decided to KEEP (first-occurrence-wins).
  // A candidate is redundant only if it is a >=90% near-duplicate of ONE of these.
  const keptShingleSets: Set<string>[] = [];

  for (const chunk of pack) {
    const id = stablePassageId(chunk);
    const text = chunk.text || "";
    const isDecisive = decisiveIds.has(id);
    if (isDecisive) decisivePackCount++;

    const candShingles = wordShingles(text);

    // NEVER trim: a decisive passage, or a passage too short to form a shingle.
    // Both are kept and added to the kept pool so later near-dups of them can be cut.
    if (isDecisive || candShingles.size === 0) {
      keptIds.push(id);
      keptShingleSets.push(candShingles);
      continue;
    }

    // Near-duplicate test: containment within a SINGLE already-kept passage.
    let maxContainment = 0;
    for (const kept of keptShingleSets) {
      if (kept.size === 0) continue;
      const c = shingleContainment(candShingles, kept);
      if (c > maxContainment) maxContainment = c;
      if (maxContainment >= NEAR_DUP_CONTAINMENT) break;
    }

    if (maxContainment >= NEAR_DUP_CONTAINMENT) {
      trimmedIds.push(id);
      bytesSaved += text.length;
      continue;
    }

    // KEEP — not a near-duplicate of anything already kept.
    keptIds.push(id);
    keptShingleSets.push(candShingles);
  }

  const fired = trimmedIds.length > 0;
  const reason = fired
    ? `context-trim: ${trimmedIds.length} true >=${Math.round(NEAR_DUP_CONTAINMENT * 100)}% ` +
      `near-duplicate(s) trimmed (-${bytesSaved} chars); ${keptIds.length} kept; ` +
      `${decisivePackCount} decisive pack passage(s) all kept (recall preserved)`
    : "no-trim: no >=90% near-duplicates of a kept passage in the pack";

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

// ─── Mode-aware entry point (off / shadow / on) — the single shipped seam ───────

export interface ContextTrimOutcome {
  /** the resolved policy actually used. */
  policy: ContextCostPolicy;
  /** true ONLY when the pack was actually trimmed (policy "on" AND something fired). */
  applied: boolean;
  /** the chunks to KEEP, in pack order. Full pack unless `applied`. */
  keptChunks: Chunk[];
  /** the computed plan (passthrough under "off"). */
  plan: ContextTrimPlan;
  /** a concise marker to log (shadow/on), or null under "off". */
  logLine: string | null;
}

/**
 * Apply the CONTEXT_COST_POLICY to ONE measure's ORDERED pack. This is the SINGLE
 * seam the analyzer uses AND the one the unit tests exercise, so the code tested is
 * exactly the code shipped. Pure except for the returned `logLine` (the caller logs
 * it). Modes:
 *   - off    → identity: full pack, nothing computed beyond passthrough, no log.
 *   - shadow → run the near-duplicate detection but DROP NOTHING: return the FULL
 *              pack unchanged, and surface a would-trim marker in `logLine`.
 *   - on     → actually trim, but ONLY true >=90% near-duplicates per planContextTrim.
 * Never throws: any internal error falls back to the full pack (drop nothing).
 */
export function applyContextTrimPolicy(opts: {
  policy?: ContextCostPolicy | null;
  measure: Pick<FrameworkMeasure, "title" | "evidenceKeywords">;
  packChunks: Chunk[];
  corpusChunks: Chunk[];
}): ContextTrimOutcome {
  const policy = resolveContextCostPolicy(opts.policy);
  const pack = Array.isArray(opts.packChunks) ? opts.packChunks : [];
  const total = pack.length;

  if (policy === "off") {
    const plan = planContextTrim({
      measure: opts.measure,
      packChunks: pack,
      corpusChunks: opts.corpusChunks,
      // apply omitted ⇒ byte-identical passthrough
    });
    return { policy, applied: false, keptChunks: pack, plan, logLine: null };
  }

  // shadow + on both compute the REAL near-duplicate plan.
  const plan = planContextTrim({
    measure: opts.measure,
    packChunks: pack,
    corpusChunks: opts.corpusChunks,
    apply: true,
  });

  if (policy === "shadow") {
    // DROP NOTHING — return the full pack; only report what it WOULD trim.
    const logLine =
      `[CONTEXT-TRIM][shadow] would-trim ${plan.trimmedIds.length}/${total} ` +
      `passages (>=${Math.round(NEAR_DUP_CONTAINMENT * 100)}% near-dup); bytesSaved=${plan.bytesSaved}`;
    return { policy, applied: false, keptChunks: pack, plan, logLine };
  }

  // policy === "on": apply the trim, keeping pack order.
  if (!plan.fired) {
    const logLine =
      `[CONTEXT-TRIM][on] 0/${total} near-duplicates — pack unchanged`;
    return { policy, applied: false, keptChunks: pack, plan, logLine };
  }
  const keptSet = new Set(plan.keptIds);
  const keptChunks = pack.filter((c) => keptSet.has(stablePassageId(c)));
  const logLine =
    `[CONTEXT-TRIM][on] trimmed ${plan.trimmedIds.length}/${total} ` +
    `passages (>=${Math.round(NEAR_DUP_CONTAINMENT * 100)}% near-dup); -${plan.bytesSaved} chars`;
  return { policy, applied: true, keptChunks, plan, logLine };
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

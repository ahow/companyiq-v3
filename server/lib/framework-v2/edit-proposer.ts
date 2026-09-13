/**
 * Framework Creation v2 — Auto-Iterate Loop, Stage 1: Edit Proposer.
 *
 * For every flag surfaced by analyseTestDrive(), propose a specific,
 * mechanical edit to the affected measure. Proposals are shown to the user
 * with accept/reject chips; accepted edits feed into the next iteration's
 * measure-regeneration pass.
 *
 * Proposals are conservative and reversible:
 *   • "too-narrow" flags → broaden fallback_yes_criterion OR expand positive_examples
 *   • "too-broad" flags → tighten substantive_definition OR add negative_examples
 *   • "off-expected-narrow" → same as too-narrow (softer)
 *   • "off-expected-broad" → same as too-broad (softer)
 *   • "r33-heavy-flipping" → raise min_quote_context_chars from 120 → 200
 *   • "adjacent-topic-contamination" → append explicit adjacent-topic exclusion clause
 *
 * These proposals are cause-classified, so the panel can group and summarise
 * (e.g. "8 measures over-narrow, mostly because of fallback_yes_criterion").
 */

import type { Flag } from "./test-drive.js";

export type EditCause =
  | "over-strict-fallback"      // fallback_yes_criterion too tight
  | "over-narrow-definition"    // substantive_definition too specific
  | "over-broad-definition"     // substantive_definition too permissive (too-broad → tighten)
  | "missing-positive-examples" // no examples of what a Yes looks like
  | "adjacent-contamination"    // adjacent topic slipping through
  | "over-broad-wording"        // wording too permissive
  | "insufficient-context"      // quotes lack surrounding context
  | "ambiguous-criteria"        // verdict flips run-to-run (residual instability, C11)
  | "non-discriminating"        // measure gives the same verdict to every company
  | "near-duplicate"            // two measures are near-duplicates (merge/differentiate)
  | "terminology-gap"           // companies use terms not in topicSynonyms
  | "anchor-coverage";          // corpus evidences named standards/frameworks not registered as anchor_frameworks

export type EditAction =
  | "broaden-fallback"
  | "add-positive-examples"
  | "tighten-definition"
  | "add-negative-examples"
  | "raise-min-context"
  | "recalibrate-expected-rate"
  | "rewrite-countable"         // C11: rewrite deciding criteria to a countable N-of-M test
  | "broaden-or-redefine"       // redefine so the measure separates companies
  | "merge-or-differentiate"    // resolve a near-duplicate pair
  | "add-synonyms"              // append mined terminology-gap terms to topic_synonyms
  | "add-adjacent-topics"       // register recurring adjacent-contamination phrases as adjacent_topics
  | "add-anchor-frameworks";    // register corpus-evidenced standards/frameworks as anchor_frameworks

/**
 * Every distinct `patch.op` this module can emit (across proposeEditForFlag,
 * proposeMergeForNearDuplicate, and the framework-level builders
 * proposeSynonymAddition / proposeAdjacentTopics / proposeAnchorFrameworks).
 * This is the single declared source the apply guardrail test enumerates: the
 * test asserts (a) this list exactly matches the ops actually emitted for
 * representative inputs, and (b) every op here has a wired handler in
 * edit-applier's APPLY_HANDLED_OPS. Keep it in sync when adding a new proposal
 * type.
 */
export const EMITTABLE_PATCH_OPS = [
  "replace",
  "regenerate_examples",
  "tighten_definition",
  "append_exclusion",
  "rewrite_countable",
  "broaden_or_redefine",
  "merge_or_differentiate",
  // Framework-level (non per-measure) additive ops. Each appends mined values to
  // a jsonb column on `frameworks` — never a per-measure field. They carry the
  // sentinel measureId FRAMEWORK_SENTINEL so identity resolution and audit treat
  // them as framework-scoped rather than tied to any single measure.
  "add_synonyms",
  "add_adjacent_topics",
  "add_anchor_frameworks",
] as const;
export type EmittablePatchOp = (typeof EMITTABLE_PATCH_OPS)[number];

/**
 * Sentinel measureId for framework-level proposals (terminology-gap synonyms,
 * adjacent-topic registration, anchor-framework coverage). These edits target a
 * jsonb column on `frameworks`, not any `framework_measures` row, so they share
 * one stable, topic-agnostic id across creation, client rendering, identity
 * resolution and the edit audit.
 */
export const FRAMEWORK_SENTINEL = "(framework)";

/** patch.op values that are framework-level (applied to a jsonb column on frameworks). */
export const FRAMEWORK_LEVEL_OPS = ["add_synonyms", "add_adjacent_topics", "add_anchor_frameworks"] as const;

export interface EditProposal {
  measureId: string;
  flagRule: string;
  cause: EditCause;
  action: EditAction;
  fieldPath: string;              // JSON dot-path to the field the edit touches
  currentValueSummary: string;    // short human-readable summary of current value
  proposedValueSummary: string;   // short human-readable summary of proposed value
  rationale: string;              // 1-sentence explanation
  patch: any;                     // structured patch: { op: "replace"|"append", path, value }
  expectedImpact: string;         // "should raise Yes rate by ~15pp"
}

export function proposeEditForFlag(
  flag: Flag,
  currentMeasure: any | undefined,
): EditProposal | null {
  const m = currentMeasure || {};
  const measureId = flag.measureId;

  switch (flag.rule) {
    case "too-narrow":
    case "off-expected-narrow":
      // Prefer broadening the fallback clause; if none exists, add positive examples.
      if (typeof m.fallback_yes_criterion === "string" && m.fallback_yes_criterion.length > 0) {
        const softened = softenFallbackClause(m.fallback_yes_criterion);
        return {
          measureId,
          flagRule: flag.rule,
          cause: "over-strict-fallback",
          action: "broaden-fallback",
          fieldPath: "fallback_yes_criterion",
          currentValueSummary: truncate(m.fallback_yes_criterion, 160),
          proposedValueSummary: truncate(softened, 160),
          rationale:
            "The current fallback requires stringent conditions that few disclosures meet. Soften the required conjuncts so partial-but-substantive disclosure qualifies.",
          patch: { op: "replace", path: "fallback_yes_criterion", value: softened },
          expectedImpact:
            flag.observedRate !== undefined && flag.expectedRate !== undefined
              ? `should move observed ${(flag.observedRate * 100).toFixed(0)}% toward expected ${(flag.expectedRate * 100).toFixed(0)}%`
              : "should raise Yes rate on partial disclosures",
        };
      }
      // No fallback exists; propose adding positive examples.
      return {
        measureId,
        flagRule: flag.rule,
        cause: "missing-positive-examples",
        action: "add-positive-examples",
        fieldPath: "positive_examples",
        currentValueSummary:
          Array.isArray(m.positive_examples) && m.positive_examples.length > 0
            ? `${m.positive_examples.length} example(s), ${Math.round(avgLen(m.positive_examples))} chars avg`
            : "none",
        proposedValueSummary: "add 2–3 realistic Yes examples from public disclosures",
        rationale:
          "The measure lacks positive_examples grounding the LLM in what a real Yes looks like. Add 2–3 substantive examples covering different disclosure styles.",
        patch: { op: "regenerate_examples", path: "positive_examples", value: null },
        expectedImpact: "should reduce false-negatives from LLM under-confidence",
      };

    case "too-broad":
    case "off-expected-broad":
      // Prefer adding negative examples; if many already exist, tighten definition.
      const negCount = Array.isArray(m.negative_examples) ? m.negative_examples.length : 0;
      if (negCount < 3) {
        return {
          measureId,
          flagRule: flag.rule,
          cause: "over-broad-wording",
          action: "add-negative-examples",
          fieldPath: "negative_examples",
          currentValueSummary: `${negCount} negative example(s)`,
          proposedValueSummary: "add 2 negative examples showing what should NOT count",
          rationale:
            "The measure is matching too many disclosures. Add negative_examples showing common adjacent-topic patterns that must be rejected.",
          patch: { op: "regenerate_examples", path: "negative_examples", value: null },
          expectedImpact: "should reduce Yes rate by disqualifying common false-positive patterns",
        };
      }
      // Tighten definition — the measure is too BROAD, so tightening it is the
      // correct move. (Bug fix: this branch previously reported the too-NARROW
      // cause "over-narrow-definition", mislabelling every too-broad tighten.)
      return {
        measureId,
        flagRule: flag.rule,
        cause: "over-broad-definition",
        action: "tighten-definition",
        fieldPath: "substantive_definition",
        currentValueSummary: truncate(m.substantive_definition || "", 160),
        proposedValueSummary: "add explicit sufficiency conditions to substantive_definition",
        rationale:
          "Negative examples already exist but the measure still fires on adjacent-topic material. Tighten the substantive_definition to require named methodologies or quantified claims.",
        patch: { op: "tighten_definition", path: "substantive_definition", value: null },
        expectedImpact: "should reduce Yes rate on generic/aspirational disclosure",
      };

    case "r33-heavy-flipping":
      return {
        measureId,
        flagRule: flag.rule,
        cause: "insufficient-context",
        action: "raise-min-context",
        fieldPath: "min_quote_context_chars",
        currentValueSummary: `${m.min_quote_context_chars ?? 120} chars`,
        proposedValueSummary: "200 chars",
        rationale:
          "Context expansion is flipping too many initial Yes verdicts, meaning the base quote lacked surrounding disclaimers or scope-limiting language. Raise the minimum context so the base evidence carries its own qualification.",
        patch: { op: "replace", path: "min_quote_context_chars", value: 200 },
        expectedImpact: "should reduce R3.3 flip rate below 40%",
      };

    case "adjacent-topic-contamination":
      return {
        measureId,
        flagRule: flag.rule,
        cause: "adjacent-contamination",
        action: "tighten-definition",
        fieldPath: "substantive_definition",
        currentValueSummary: truncate(m.substantive_definition || "", 160),
        proposedValueSummary: "append explicit adjacent-topic exclusion clause",
        rationale:
          "Yes verdicts are being drawn from adjacent-topic sections. Append an explicit exclusion naming the specific adjacent topic surfaced in this measure's evidence.",
        patch: { op: "append_exclusion", path: "substantive_definition", value: null },
        expectedImpact: "should suppress adjacent-topic contamination on Yes verdicts",
      };

    case "residual-instability":
      // ITEM 2 / spec §4.1: the same sample scored k times produced different
      // verdicts for one or more companies. This is a DESIGN defect (ambiguous
      // criteria), not scoring noise to sample away — live scoring stays
      // single-shot. The C11 fix (rewrite the deciding criteria to a countable,
      // quote-verifiable N-of-M test over named artefacts) takes PRECEDENCE over
      // any calibration edit, because a measure that will not reproduce cannot be
      // calibrated meaningfully.
      return {
        measureId,
        flagRule: flag.rule,
        cause: "ambiguous-criteria",
        action: "rewrite-countable",
        fieldPath: "substantive_definition",
        currentValueSummary: truncate(m.substantive_definition || "", 160),
        proposedValueSummary:
          "rewrite deciding criteria to a countable, quote-verifiable N-of-M test over NAMED artefacts (C11)",
        rationale:
          "Verdict is unstable across identical re-runs — the measure leaves a judgment call two passes resolve differently. Remove the degree-word ambiguity by making the deciding rule countable and quote-verifiable. Stability must be fixed before calibration.",
        patch: { op: "rewrite_countable", path: "substantive_definition", value: null },
        expectedImpact:
          typeof flag.flipRate === "number"
            ? `should drive the ${(flag.flipRate * 100).toFixed(0)}% run-to-run flip rate toward 0%`
            : "should eliminate run-to-run verdict flips",
      };

    case "no-differentiation":
      // ITEM 3 / spec §4.5: the measure hands the SAME verdict to every scored
      // company — zero discriminating power. Propose broadening/redefining so it
      // separates companies; if the measure is redundant with another, it is a
      // candidate for removal (surfaced, never auto-deleted).
      return {
        measureId,
        flagRule: flag.rule,
        cause: "non-discriminating",
        action: "broaden-or-redefine",
        fieldPath: "substantive_definition",
        currentValueSummary: truncate(m.substantive_definition || "", 160),
        proposedValueSummary:
          "redefine around a named, quote-verifiable artefact that only SOME companies disclose (or remove if redundant)",
        rationale:
          "The measure returns one verdict for every company, so the framework gains no information from it. Redefine it to test a discriminating artefact so the verdict can vary; if another measure already captures this, consider removing it instead.",
        patch: { op: "broaden_or_redefine", path: "substantive_definition", value: null },
        expectedImpact: "should let the verdict vary across companies, restoring discriminating power",
      };

    default:
      return null;
  }
}

/**
 * Near-duplication proposal (spec §4.2). Unlike flag-driven proposals, near-dups
 * are measure PAIRS, so they are proposed from the quality-metrics focal list
 * rather than the per-measure flag stream. The proposal is user-selectable and
 * never auto-deletes either measure — the user (or LLM recommendation flow)
 * decides whether to merge the pair or differentiate them.
 */
export interface NearDuplicateInput {
  measureIdA: string;
  measureIdB: string;
  labelA: string;
  labelB: string;
  agreement: number;
  kappa: number;
  n: number;
}

export function proposeMergeForNearDuplicate(pair: NearDuplicateInput): EditProposal {
  return {
    measureId: pair.measureIdA,
    flagRule: "near-duplication",
    cause: "near-duplicate",
    action: "merge-or-differentiate",
    fieldPath: "substantive_definition",
    currentValueSummary: `${pair.labelA} ↔ ${pair.labelB}`,
    proposedValueSummary:
      `merge into one measure OR differentiate their substantive_definition so they test distinct artefacts`,
    rationale:
      `"${pair.labelA}" and "${pair.labelB}" agree on ${(pair.agreement * 100).toFixed(0)}% of ${pair.n} companies ` +
      `(κ=${pair.kappa.toFixed(2)}) — they are near-duplicates carrying overlapping signal. Merge them, or sharpen one so ` +
      `it tests something the other does not. Human-overrideable; neither measure is removed automatically.`,
    patch: {
      op: "merge_or_differentiate",
      path: "substantive_definition",
      value: { measureIdA: pair.measureIdA, measureIdB: pair.measureIdB },
    },
    expectedImpact: "should reduce within-pillar redundancy without losing coverage",
  };
}

// ─── Framework-level builders (jsonb columns on `frameworks`) ─────────────
//
// These three builders produce framework-SCOPED proposals rather than
// per-measure ones. Each carries the sentinel measureId FRAMEWORK_SENTINEL and
// uses flagRule === cause so that identity resolution
// (${measureId}::${flagRule}) is unique per framework-level type — this is why
// there is at most ONE proposal per type, aggregating every mined value into a
// single patch.value array. All three are purely ADDITIVE: they append mined
// values to a jsonb column and never remove or overwrite existing entries.
// Callers pass the already-filtered candidate pool (mined values with the
// currently-registered entries removed); each builder returns null when the
// filtered pool is empty so no empty card is surfaced.

/**
 * Terminology-gap → append mined synonyms to `topic_synonyms` (PART A).
 * `candidates` are terms companies use for the topic that are not already in
 * topic_synonyms (nor the topic_term itself); `currentSynonyms` is the live
 * registered list, used only for the human-readable summary.
 */
export function proposeSynonymAddition(
  candidates: string[],
  currentSynonyms: string[],
): EditProposal | null {
  const values = dedupeNonEmpty(candidates);
  if (values.length === 0) return null;
  return {
    measureId: FRAMEWORK_SENTINEL,
    flagRule: "terminology-gap",
    cause: "terminology-gap",
    action: "add-synonyms",
    fieldPath: "topic_synonyms",
    currentValueSummary: summariseList(currentSynonyms),
    proposedValueSummary: `add ${values.length} synonym(s): ${values.join(", ")}`,
    rationale:
      "Companies in the corpus refer to this topic using terms not registered as topic_synonyms, so on-topic disclosure is being missed. Register these mined terms so retrieval and scoring recognise them.",
    patch: { op: "add_synonyms", path: "topic_synonyms", value: values },
    expectedImpact: "should improve on-topic recall by matching companies' own terminology",
  };
}

/**
 * Adjacent-contamination (recurring across multiple measures) → register mined
 * adjacent-topic phrases as `adjacent_topics` (PART B). `recurrence` is the
 * number of DISTINCT measures whose flags cited adjacent-topic contamination;
 * it drives only the rationale text (the caller decides the threshold).
 */
export function proposeAdjacentTopics(
  candidates: string[],
  currentAdjacent: string[],
  recurrence: number,
): EditProposal | null {
  const values = dedupeNonEmpty(candidates);
  if (values.length === 0) return null;
  return {
    measureId: FRAMEWORK_SENTINEL,
    flagRule: "adjacent-contamination",
    cause: "adjacent-contamination",
    action: "add-adjacent-topics",
    fieldPath: "adjacent_topics",
    currentValueSummary: summariseList(currentAdjacent),
    proposedValueSummary: `add ${values.length} adjacent topic(s): ${values.join(", ")}`,
    rationale:
      `Adjacent-topic contamination recurred across ${recurrence} measures, meaning the same neighbouring subject matter is bleeding into Yes verdicts framework-wide. Register these phrases as adjacent_topics so every measure can exclude them consistently.`,
    patch: { op: "add_adjacent_topics", path: "adjacent_topics", value: values },
    expectedImpact: "should suppress cross-measure adjacent-topic contamination framework-wide",
  };
}

/**
 * Anchor coverage → register corpus-evidenced standards/frameworks as
 * `anchor_frameworks` (PART B). ADD-only: never proposes removing an existing
 * anchor. `candidates` are named standards/frameworks the corpus evidences that
 * are not already registered.
 */
export function proposeAnchorFrameworks(
  candidates: string[],
  currentAnchors: string[],
): EditProposal | null {
  const values = dedupeNonEmpty(candidates);
  if (values.length === 0) return null;
  return {
    measureId: FRAMEWORK_SENTINEL,
    flagRule: "anchor-coverage",
    cause: "anchor-coverage",
    action: "add-anchor-frameworks",
    fieldPath: "anchor_frameworks",
    currentValueSummary: summariseList(currentAnchors),
    proposedValueSummary: `add ${values.length} anchor framework(s): ${values.join(", ")}`,
    rationale:
      "The corpus repeatedly cites named standards or frameworks that are not registered as anchor_frameworks, so measures cannot credit companies for aligning to them. Register these to widen recognised anchors (additive only — no existing anchor is removed).",
    patch: { op: "add_anchor_frameworks", path: "anchor_frameworks", value: values },
    expectedImpact: "should improve credit for disclosures that reference recognised standards",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function dedupeNonEmpty(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr || []) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function summariseList(arr: string[]): string {
  const vals = dedupeNonEmpty(arr || []);
  if (vals.length === 0) return "none registered";
  if (vals.length <= 5) return `${vals.length} registered: ${vals.join(", ")}`;
  return `${vals.length} registered: ${vals.slice(0, 5).join(", ")}…`;
}

function softenFallbackClause(clause: string): string {
  // Best-effort softening: replace strict conjunctions with permissive ones
  // ("AND ALL" → "OR ANY", "requires" → "prefers", etc.). This is deliberately
  // conservative; the LLM regenerates the clause fully during iteration N+1.
  return clause
    .replace(/\bAND ALL\b/gi, "AND ANY")
    .replace(/\bmust include\b/gi, "should include")
    .replace(/\brequires? all of\b/gi, "requires at least one of")
    .replace(/\bexplicitly stated\b/gi, "explicitly or implicitly stated");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function avgLen(arr: string[]): number {
  if (!arr.length) return 0;
  return arr.reduce((n, s) => n + s.length, 0) / arr.length;
}

export interface EditProposalBundle {
  proposals: EditProposal[];
  causeBreakdown: Record<EditCause, number>;
  totalFlags: number;
  totalWithProposals: number;
}

export function proposeEditsForFlags(
  flags: Flag[],
  measuresById: Record<string, any>,
): EditProposalBundle {
  const proposals: EditProposal[] = [];
  const causeBreakdown: Record<string, number> = {};
  // De-duplicate genuinely-identical proposals. A measure can carry more than one
  // flag that routes to the same edit (e.g. both "too-broad" and
  // "off-expected-broad" produce the same tighten/add-negative-examples proposal),
  // which would otherwise emit byte-identical cards — inflating the count and, if
  // applied, running the same patch twice. Collapse on the tuple
  // (measureId, cause, fieldPath, patch.op), keeping the first occurrence.
  const seen = new Set<string>();
  for (const flag of flags) {
    const prop = proposeEditForFlag(flag, measuresById[flag.measureId]);
    if (!prop) continue;
    const key = `${prop.measureId}::${prop.cause}::${prop.fieldPath}::${prop.patch?.op ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(prop);
    causeBreakdown[prop.cause] = (causeBreakdown[prop.cause] || 0) + 1;
  }
  return {
    proposals,
    causeBreakdown: causeBreakdown as Record<EditCause, number>,
    totalFlags: flags.length,
    totalWithProposals: proposals.length,
  };
}

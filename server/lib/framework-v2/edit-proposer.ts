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
  | "missing-positive-examples" // no examples of what a Yes looks like
  | "adjacent-contamination"    // adjacent topic slipping through
  | "over-broad-wording"        // wording too permissive
  | "insufficient-context"      // quotes lack surrounding context
  | "terminology-gap";          // companies use terms not in topicSynonyms

export type EditAction =
  | "broaden-fallback"
  | "add-positive-examples"
  | "tighten-definition"
  | "add-negative-examples"
  | "raise-min-context"
  | "recalibrate-expected-rate"
  | "add-synonyms";

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
      // Tighten definition
      return {
        measureId,
        flagRule: flag.rule,
        cause: "over-narrow-definition",
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

    default:
      return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

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
  for (const flag of flags) {
    const prop = proposeEditForFlag(flag, measuresById[flag.measureId]);
    if (prop) {
      proposals.push(prop);
      causeBreakdown[prop.cause] = (causeBreakdown[prop.cause] || 0) + 1;
    }
  }
  return {
    proposals,
    causeBreakdown: causeBreakdown as Record<EditCause, number>,
    totalFlags: flags.length,
    totalWithProposals: proposals.length,
  };
}

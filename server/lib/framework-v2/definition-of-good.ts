/**
 * Framework Creation v2 — The shared "definition of good" (single source of truth)
 *
 * This module encodes, ONCE, the six dimensions a CompanyIQ measurement
 * framework is judged against — the same six the external reviewer agent
 * enforces (see retrieval_experiment/FRAMEWORK_REVIEWER_AGENT.md, whose header
 * notes it mirrors this module). Having one source means the builder and the
 * reviewer grade against the same bar:
 *
 *   (i)   the SKELETON prompt references the set-level, reasoning dimensions
 *         (1 + 3) as a pre-finalisation checklist — so coverage/calibration are
 *         reasoned up front, once, cheaply;
 *   (ii)  the deterministic diagnostic / rules engine enforces the mechanical
 *         dimensions (2 overlap + numbering, 4 intake defects) with zero token
 *         cost and never feeds the repair loop;
 *   (iii) dimension 6 (anti-Goodhart / decidability) is already internalised as
 *         construction rule C11 — this module references it, it is not re-derived
 *         here.
 *
 * IMPORTANT design constraint (grounded in the 316678be repair-loop telemetry):
 * nothing in this module adds an LLM pass and nothing here emits an
 * error/warning-severity violation. The deterministic checks that cite these
 * dimensions either auto-fix in code (no violation) or emit `info`-severity
 * diagnostics that are excluded from the repair trigger and the
 * repairMeasuresTargeted grouping. See rules.ts `validateSetLevel`.
 */

/**
 * A single review dimension. `tag` marks whether the dimension is a topic-
 * independent STRUCTURAL invariant (safe to hard-gate / auto-fix) or a
 * THIS-FRAMEWORK calibrated quality bar (only meaningful relative to a completed
 * run — surfaced as guidance/`info`, never hard-gated pre-empirically).
 */
export interface ReviewDimension {
  id: number;
  key: string;
  title: string;
  /** One-line statement of what "good" means on this dimension. */
  criterion: string;
  /** Where this dimension is enforced in the build. */
  enforcedBy: string;
  tag: "STRUCTURAL" | "THIS-FRAMEWORK";
}

export const DEFINITION_OF_GOOD: readonly ReviewDimension[] = [
  {
    id: 1,
    key: "coverage",
    title: "Coverage completeness",
    criterion:
      "The set covers the topic's material downside/asymmetric risk (disruption to the company's own business model, incident/redress exposure, workforce, security- and data-provenance-specific risk), not only adoption/upside. No material risk side is silently dropped because its terms were declared adjacent/out-of-scope.",
    enforcedBy: "CHUNKED_SKELETON_SYSTEM_PROMPT pre-finalisation checklist (reasoned once at skeleton time)",
    tag: "THIS-FRAMEWORK",
  },
  {
    id: 2,
    key: "non-overlap",
    title: "Non-overlap / no effective double-counting",
    criterion:
      "No two measures would qualify on the SAME disclosure sentence — i.e. no measure pair shares anchor quotes, evidenceKeywords, or a named standard as its deciding evidence. Each measure needs distinct evidence, or the correlation is stated explicitly.",
    enforcedBy: "deterministic overlap detection (rules.ts validateSetLevel → info) + skeleton checklist",
    tag: "STRUCTURAL",
  },
  {
    id: 3,
    key: "calibration",
    title: "Calibration balance",
    criterion:
      "The spread of expected-YES rates is plausible for the topic; each rate is consistent with the stringency of its own substantive definition; pillar counts are balanced; within-category numbering is contiguous (a gap suggests an unintentional drop).",
    enforcedBy: "skeleton checklist (spread) + deterministic numbering-continuity detection (rules.ts validateSetLevel → info)",
    tag: "THIS-FRAMEWORK",
  },
  {
    id: 4,
    key: "clean-intake",
    title: "Clean intake artefacts",
    criterion:
      "No polluted synonyms (n-gram/function-word phrases such as \"the board\", \"and other\", \"operations and\"); no stale/templated query strings (hardcoded years, junk-verb placeholders); negative-keywords and anti-inference rules are populated (they matter more when adjacency risk is high).",
    enforcedBy:
      "deterministic auto-fix at intake/assembly (synonym filter in test-drive.ts, query-template sanitiser) + intake schema generates negativeKeywords/antiInferenceRules + empty-guard info flag (rules.ts validateSetLevel)",
    tag: "STRUCTURAL",
  },
  {
    id: 5,
    key: "disclosure-vs-practice",
    title: "Disclosure-vs-practice awareness",
    criterion:
      "The framework proxies disclosure/reporting sophistication (correlated with cap size and sector), not underlying management quality — sharper where the topic's reporting norms are immature. Interpret scores within sector/cap bands.",
    enforcedBy: "framing note (skeleton checklist / output caveat) — not a generation change",
    tag: "THIS-FRAMEWORK",
  },
  {
    id: 6,
    key: "anti-goodhart",
    title: "Anti-Goodhart / decidability",
    criterion:
      "A deciding test must be verifiable true/false from a single verbatim quote; a degree/holistic word may not be the deciding test. Tightening a measure 'to be more measurable' must not reward a boilerplate proxy over the true objective.",
    enforcedBy: "construction rule C11 (already internalised in generation and repair) — referenced here, unchanged",
    tag: "STRUCTURAL",
  },
] as const;

/**
 * The set-level, reasoning dimensions (1 + 3, plus the framing note 5) rendered
 * as a compact pre-finalisation checklist for CHUNKED_SKELETON_SYSTEM_PROMPT.
 * Kept text-only and topic-neutral so it rides on the EXISTING skeleton call
 * (no new LLM pass, no new call). The mechanical dimensions (2, 4) and the
 * anti-Goodhart dimension (6) are enforced elsewhere and are NOT asked of the
 * skeleton model here.
 */
export const SKELETON_PRE_FINALISATION_CHECKLIST = `# Pre-finalisation checklist (set-level "definition of good")

Before emitting the skeleton, verify the SET as a whole (not just each measure):

1. Coverage completeness — the set covers the topic's material DOWNSIDE / asymmetric risk (e.g. disruption to the company's own business model, incident/redress exposure, workforce, security- and data-provenance-specific risk), not only adoption/upside. Do not leave a material risk side uncovered because its terms are adjacent/out-of-scope; if an adjacency exclusion would drop a legitimate risk measure, keep the measure and narrow the exclusion instead.
2. Non-overlap — no two measure purposes would qualify on the SAME disclosure sentence (no pair relying on the same anchor quote / named standard as its sole evidence). If two measures are close, give each distinct qualifying evidence.
3. Calibration spread — the intended expected-YES spread is plausible for the topic: a mix of easier and harder measures, each measure's expected rate consistent with the stringency of its own purpose. Avoid a set where every measure is permissive (a pillar that saturates discriminates poorly).
4. Balance & numbering — measures are distributed sensibly across categories, and within-category measure numbers are contiguous (no gaps).
5. Framing — remember the framework proxies DISCLOSURE, not underlying practice; do not design measures that assume a company's real-world behaviour can be inferred from the absence of a disclosure.`;

/** Compact one-line-per-dimension reference, e.g. for logs or diagnostic headers. */
export function definitionOfGoodSummary(): string {
  return DEFINITION_OF_GOOD.map(
    (d) => `${d.id}. [${d.tag}] ${d.title}: ${d.criterion}`,
  ).join("\n");
}

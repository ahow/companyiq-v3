// ─── Verdict-Stability Classifier (build-time, framework-agnostic) ───────────
//
// Issue 1 ("verdicts are not reproducible") is, at root, irreducible LLM
// sampling variance on genuinely BORDERLINE measures: identical evidence in,
// different verdict out, concentrated in a few measures whose DECIDING TEST is
// ambiguous. The owner's direction is to harden this AT THE BUILDER so every
// newly-created framework is generated stability-aware — not patched per
// framework. The builder already ERRORS on the two empirically-confirmed flip
// sources at validation time (C11 — a degree word is the deciding test with no
// countable rule; C12 — an M-of-N / OR-list soft gate near its boundary). What
// this module adds is ONE pure classifier that composes those SAME predicates
// into a per-measure "verdict-instability risk" verdict, so the risk is also
// visible on the per-measure design-diagnostic / instability-ranking surface the
// author reads — and so the build-time flag and the post-hoc multi-run
// `residual-instability` proposal share ONE definition of the fix.
//
// STRICTLY topic-agnostic: it reuses only grammatical / structural predicates
// from rules.ts (degree words, countable N-of-M rule, named-artefact
// enumeration, soft-selection gate, conjunctive bundle). It contains NO topic,
// company, framework-id or measure-id vocabulary, and NO LLM / DB access. It is
// a deterministic pure function of the measure's own text.
//
// It is ADVISORY by construction — it classifies, it does not block. Build
// blocking stays with C11 (ERROR) exactly as before; this classifier only
// enriches the advisory design-diagnostic surface.

import {
  findDegreeWords,
  hasCountableRule,
  splitIntoConditions,
  hasNamedArtefactEnumeration,
  hasSoftSelectionGate,
  hasConjunctiveBundle,
  describeSoftGate,
} from "./rules.js";

// The ONE canonical description of the countable-rewrite fix. Both the build-time
// stability flag (via measure-design-diagnostic) and the post-hoc multi-run
// `residual-instability` proposal (edit-proposer) reference this so they never
// drift to two different definitions of "make the deciding rule reproducible".
export const COUNTABLE_REWRITE_GUIDANCE =
  "Remove the degree-word ambiguity by making the deciding rule a countable, " +
  "quote-verifiable N-of-M test over NAMED artefacts (e.g. \"Yes if at least 2 " +
  "of the following appear in a verbatim quote: (a) …, (b) …, (c) …\").";

// The ONE canonical description of the soft-gate hardening fix.
export const CONJUNCTIVE_BUNDLE_GUIDANCE =
  "An M-of-N / OR-list soft gate flips run-to-run near its boundary. Where the " +
  "signal permits, require the co-occurrence, in a SINGLE verbatim quote, of ALL " +
  "of a small set of hard, quote-verifiable tokens rather than letting any one " +
  "soft condition suffice.";

export type StabilityReasonCode =
  | "degree-word-deciding-test"
  | "m-of-n-soft-gate";

export interface StabilityReason {
  code: StabilityReasonCode;
  /** Short, human-readable evidence for this reason (topic-agnostic). */
  evidence: string;
  /** The canonical fix guidance for this reason. */
  fix: string;
}

export type StabilityRisk = "stable" | "borderline";

// Minimal, field-name-stable input. Callers map their own measure shape onto
// these three deciding-test fields (the fields the runtime actually reads to
// decide Yes/No) plus an id/title for reporting. Any field may be omitted.
export interface MeasureStabilityInput {
  measureId: string;
  title?: string | null;
  fallbackYesCriterion?: string | null;
  scoringGuidance?: string | null;
  substantiveDefinition?: string | null;
}

export interface MeasureStabilityResult {
  measureId: string;
  title: string;
  risk: StabilityRisk;
  reasons: StabilityReason[];
}

function toStr(v: string | null | undefined): string {
  return typeof v === "string" ? v : "";
}

function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * Classify a single measure's run-to-run verdict-stability risk from its own
 * deciding-test text. PURE: no LLM, no DB, deterministic. Topic-agnostic.
 *
 * borderline when EITHER empirically-confirmed flip source is present:
 *   1. degree-word-deciding-test — a degree word is the deciding test of a
 *      fallback condition (or, measure-wide, of scoringGuidance /
 *      substantive_definition) with no countable rule or named-artefact
 *      enumeration making it quote-verifiable. Mirrors C11's taxonomy exactly,
 *      using the SAME shared predicates.
 *   2. m-of-n-soft-gate — the deciding gate is an M-of-N / OR-list soft gate not
 *      already tightened into a conjunctive hard-token bundle. Mirrors C12.
 *
 * stable otherwise. A measure may carry both reasons.
 */
export function classifyMeasureStability(
  measure: MeasureStabilityInput,
): MeasureStabilityResult {
  const reasons: StabilityReason[] = [];
  const fallbackText = toStr(measure.fallbackYesCriterion);
  const guidanceText = toStr(measure.scoringGuidance);
  const definitionText = toStr(measure.substantiveDefinition);

  // ── Reason 1: degree-word deciding test (C11 taxonomy, advisory) ──
  // Per-condition over the fallback first (a countable rule in a DIFFERENT
  // condition does not rescue this one — the run-to-run flip case).
  let degreeFlagged = false;
  for (const cond of splitIntoConditions(fallbackText)) {
    const words = findDegreeWords(cond);
    if (words.length === 0) continue;
    if (hasCountableRule(cond) || hasNamedArtefactEnumeration(cond)) continue;
    reasons.push({
      code: "degree-word-deciding-test",
      evidence: `Degree word(s) [${words.join(", ")}] decide a fallback_yes_criterion condition with no in-condition countable or named-artefact test: "${snippet(cond)}". A degree judgment is not decidable from a verbatim quote — two passes split on it run-to-run.`,
      fix: COUNTABLE_REWRITE_GUIDANCE,
    });
    degreeFlagged = true;
    break; // one degree-word reason per measure
  }
  // Measure-level secondary (scoringGuidance / substantive_definition), only when
  // the fallback itself is clean — mirrors C11's one-per-measure behaviour.
  if (!degreeFlagged) {
    const secondary: Array<{ field: string; text: string }> = [
      { field: "scoringGuidance", text: guidanceText },
      { field: "substantive_definition", text: definitionText },
    ];
    const hits = secondary
      .map((f) => ({ field: f.field, words: findDegreeWords(f.text) }))
      .filter((h) => h.words.length > 0);
    if (hits.length > 0) {
      const combined = [fallbackText, guidanceText, definitionText].join("\n");
      if (!hasCountableRule(combined)) {
        const allWords = [...new Set(hits.flatMap((h) => h.words))];
        const fieldList = hits.map((h) => `${h.field} (${h.words.join(", ")})`).join("; ");
        reasons.push({
          code: "degree-word-deciding-test",
          evidence: `Degree word(s) [${allWords.join(", ")}] decide ${fieldList} but the measure carries no countable decision rule — not decidable from a verbatim quote, so two passes split on it run-to-run.`,
          fix: COUNTABLE_REWRITE_GUIDANCE,
        });
      }
    }
  }

  // ── Reason 2: M-of-N / OR-list soft gate (C12 taxonomy, advisory) ──
  // Already-conjunctive measures are treated as hardened → no flag.
  if (!hasConjunctiveBundle(fallbackText) && !hasConjunctiveBundle(guidanceText)) {
    let sourceField: string | null = null;
    let sourceText = "";
    if (hasSoftSelectionGate(fallbackText)) {
      sourceField = "fallback_yes_criterion";
      sourceText = fallbackText;
    } else if (hasSoftSelectionGate(guidanceText)) {
      sourceField = "scoringGuidance";
      sourceText = guidanceText;
    }
    if (sourceField) {
      const { n, m } = describeSoftGate(sourceText);
      const gateDesc =
        n !== null && m !== null
          ? `an M-of-N / OR-list soft gate (any ${n} of ${m} conditions)`
          : n === 1
            ? "an OR-list soft gate (any single listed condition triggers Yes)"
            : "an M-of-N / OR-list soft gate";
      reasons.push({
        code: "m-of-n-soft-gate",
        evidence: `${sourceField} uses ${gateDesc}. An M-of-N count near its boundary is itself a run-to-run flip source.`,
        fix: CONJUNCTIVE_BUNDLE_GUIDANCE,
      });
    }
  }

  return {
    measureId: measure.measureId,
    title: toStr(measure.title),
    risk: reasons.length > 0 ? "borderline" : "stable",
    reasons,
  };
}

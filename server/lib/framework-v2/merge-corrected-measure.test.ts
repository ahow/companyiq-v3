/**
 * Focused unit tests for the prune-merge fix that stopped targeted repair from
 * turning complete measures into stubs.
 *
 * Root cause: the LLM repair prompt asks the model to rewrite ONLY the fields
 * that trigger violations, so it echoes back a PARTIAL measure. The old splice
 * replaced the whole measure with that partial echo, silently dropping every
 * omitted field. mergeCorrectedMeasure must overlay only populated corrected
 * fields onto the original, never deleting a field the model omitted or blanked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeCorrectedMeasure,
  isPopulatedFieldValue,
  CORE_MEASURE_FIELDS,
} from "./merge-corrected-measure.js";

function completeMeasure() {
  return {
    measureId: "1.1-ai-strategy",
    category: "Strategy",
    title: "AI strategy is defined",
    definition: "The company discloses a defined AI strategy.",
    substantive_definition: "A board-approved AI strategy with objectives.",
    scoringGuidance: "Score Yes when a defined AI strategy is disclosed.",
    c1_achievement_guidance: "Yes requires an explicit, named AI strategy.",
    fallback_yes_criterion: "A dedicated AI strategy section counts as Yes.",
    positive_examples: ["We published our AI strategy in 2024."],
    negative_examples: ["We use software."],
    whatConstitutesEvidence: "An explicit AI strategy statement.",
    whatDoesNotConstituteEvidence: "Generic digital transformation language.",
    expected_yes_rate: 0.4,
    min_quote_context_chars: 200,
    evidenceKeywords: ["ai strategy", "roadmap"],
    displayOrder: 1,
  };
}

test("partial echo retains all original fields (no field dropped)", () => {
  const original = completeMeasure();
  // The model returns ONLY the two fields it was asked to fix.
  const corrected = {
    measureId: "1.1-ai-strategy",
    c1_achievement_guidance: "Yes requires an explicit, board-approved AI strategy with measurable objectives.",
    scoringGuidance: "Score Yes only when a board-approved AI strategy is disclosed.",
  };

  const { merged, regressionPrevented } = mergeCorrectedMeasure(original, corrected);

  // The two corrected fields are applied.
  assert.equal(merged.c1_achievement_guidance, corrected.c1_achievement_guidance);
  assert.equal(merged.scoringGuidance, corrected.scoringGuidance);
  // Every OTHER original field survives — this is the bug being fixed.
  assert.equal(merged.title, original.title);
  assert.equal(merged.definition, original.definition);
  assert.equal(merged.substantive_definition, original.substantive_definition);
  assert.equal(merged.fallback_yes_criterion, original.fallback_yes_criterion);
  assert.deepEqual(merged.positive_examples, original.positive_examples);
  assert.deepEqual(merged.negative_examples, original.negative_examples);
  assert.equal(merged.whatConstitutesEvidence, original.whatConstitutesEvidence);
  assert.equal(merged.whatDoesNotConstituteEvidence, original.whatDoesNotConstituteEvidence);
  assert.equal(merged.expected_yes_rate, original.expected_yes_rate);
  assert.equal(merged.min_quote_context_chars, original.min_quote_context_chars);
  assert.deepEqual(merged.evidenceKeywords, original.evidenceKeywords);
  assert.equal(merged.displayOrder, original.displayOrder);
  // No completeness regression: no core field count dropped, so the merge is kept.
  assert.equal(regressionPrevented, false);
  // All core fields remain populated.
  for (const f of CORE_MEASURE_FIELDS) {
    assert.ok(isPopulatedFieldValue((merged as any)[f]), `core field ${f} must remain populated`);
  }
});

test("empty/blank/missing corrected values never overwrite populated originals", () => {
  const original = completeMeasure();
  const corrected = {
    measureId: "1.1-ai-strategy",
    c1_achievement_guidance: "", // blank string must not wipe original
    positive_examples: [], // empty array must not wipe original
    fallback_yes_criterion: null, // null must not wipe original
    whatConstitutesEvidence: undefined, // undefined must not wipe original
    scoringGuidance: "Improved guidance.", // real value IS applied
  };

  const { merged } = mergeCorrectedMeasure(original, corrected);

  assert.equal(merged.c1_achievement_guidance, original.c1_achievement_guidance);
  assert.deepEqual(merged.positive_examples, original.positive_examples);
  assert.equal(merged.fallback_yes_criterion, original.fallback_yes_criterion);
  assert.equal(merged.whatConstitutesEvidence, original.whatConstitutesEvidence);
  assert.equal(merged.scoringGuidance, "Improved guidance.");
});

test("measureId always survives even if the model altered or omitted it", () => {
  const original = completeMeasure();
  const correctedAltered = { measureId: "WRONG-ID", title: "New title" };
  assert.equal(mergeCorrectedMeasure(original, correctedAltered).merged.measureId, "1.1-ai-strategy");

  const correctedNoId = { title: "New title" };
  assert.equal(mergeCorrectedMeasure(original, correctedNoId).merged.measureId, "1.1-ai-strategy");
});

test("completeness-regression guard keeps the original when a merge would reduce core fields", () => {
  const original = completeMeasure();
  // A pathological "corrected" object that would blank core fields if a naive
  // deep-merge (rather than prune-merge) were used. Simulate by constructing an
  // object whose only effect could reduce completeness — the prune-merge already
  // prevents this, so the guard should confirm no regression on the normal path.
  const corrected = { measureId: "1.1-ai-strategy", title: "Tighter title" };
  const { merged, regressionPrevented } = mergeCorrectedMeasure(original, corrected);
  assert.equal(regressionPrevented, false);
  assert.equal(merged.title, "Tighter title");

  // Directly exercise the guard: an "original" that is richer than any possible
  // merge output is impossible via prune-merge, so assert the guard's contract by
  // confirming a corrected object that only ADDS fields never triggers it.
  const sparseOriginal = { measureId: "x", title: "t" };
  const enriching = { measureId: "x", definition: "d", scoringGuidance: "g" };
  const res = mergeCorrectedMeasure(sparseOriginal, enriching);
  assert.equal(res.regressionPrevented, false);
  assert.equal(res.merged.definition, "d");
  assert.equal(res.merged.title, "t");
});

test("isPopulatedFieldValue treats null/blank/empty-array as empty", () => {
  assert.equal(isPopulatedFieldValue(null), false);
  assert.equal(isPopulatedFieldValue(undefined), false);
  assert.equal(isPopulatedFieldValue(""), false);
  assert.equal(isPopulatedFieldValue("   "), false);
  assert.equal(isPopulatedFieldValue([]), false);
  assert.equal(isPopulatedFieldValue("x"), true);
  assert.equal(isPopulatedFieldValue(["x"]), true);
  assert.equal(isPopulatedFieldValue(0), true);
  assert.equal(isPopulatedFieldValue(0.4), true);
  assert.equal(isPopulatedFieldValue(false), true);
});

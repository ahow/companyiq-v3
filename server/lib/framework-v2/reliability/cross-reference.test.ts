import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeMeasureContentHash,
  buildStructuredReference,
  reconcileReferences,
  reconcileWarnings,
  type ReferencedWarning,
} from "./cross-reference.js";
import type { Violation } from "../rules.js";

const measureA = {
  measureId: "1.1",
  title: "Board oversight",
  substantive_definition: "The board has explicit oversight of the topic.",
  whatConstitutesEvidence: "A charter clause assigning oversight.",
  fallback_yes_criterion: "A named committee with the mandate.",
  scoringGuidance: "Yes when a charter clause exists.",
};

test("computeMeasureContentHash is stable across whitespace/case and field-value formatting", () => {
  const h1 = computeMeasureContentHash(measureA);
  const h2 = computeMeasureContentHash({
    ...measureA,
    title: "  Board   Oversight ",
    scoringGuidance: "YES when a charter clause exists.",
  });
  assert.equal(h1, h2, "normalisation should make these hashes equal");
});

test("computeMeasureContentHash changes when decision-relevant content changes", () => {
  const h1 = computeMeasureContentHash(measureA);
  const h2 = computeMeasureContentHash({ ...measureA, substantive_definition: "Something materially different." });
  assert.notEqual(h1, h2);
});

test("computeMeasureContentHash ignores non-decision-relevant fields", () => {
  const h1 = computeMeasureContentHash(measureA);
  const h2 = computeMeasureContentHash({ ...measureA, positive_examples: ["irrelevant to the hash"] });
  assert.equal(h1, h2);
});

test("reconcileReferences: unchanged measure -> current", () => {
  const ref = buildStructuredReference(measureA);
  const [res] = reconcileReferences([ref], [measureA]);
  assert.equal(res.status, "current");
  assert.equal(res.measureExists, true);
  assert.equal(res.currentHash, ref.contentHash);
});

test("reconcileReferences: changed measure -> superseded (NOT dropped)", () => {
  const ref = buildStructuredReference(measureA);
  const changed = { ...measureA, whatConstitutesEvidence: "A different evidence bar entirely." };
  const results = reconcileReferences([ref], [changed]);
  assert.equal(results.length, 1, "reference is preserved, not dropped");
  assert.equal(results[0].status, "superseded");
  assert.equal(results[0].measureExists, true);
  assert.notEqual(results[0].currentHash, ref.contentHash);
});

test("reconcileReferences: missing measureId -> measure-missing surfaced loudly (NOT dropped)", () => {
  const ref = buildStructuredReference(measureA);
  const results = reconcileReferences([ref], [{ ...measureA, measureId: "9.9" }]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "measure-missing");
  assert.equal(results[0].measureExists, false);
  assert.equal(results[0].currentHash, null);
});

test("reconcileWarnings preserves the original warning + disposition as an audit trail", () => {
  const warning: Violation = {
    measureId: "1.1",
    rule: "overlap",
    severity: "info",
    message: "Original finding text about measure 1.1.",
  };
  const stored: ReferencedWarning = {
    id: "w-1",
    reference: buildStructuredReference(measureA),
    warning,
    disposition: { dismissedByOperator: true, note: "reviewed, acceptable" },
  };
  const changed = { ...measureA, scoringGuidance: "A revised scoring rule." };
  const [rec] = reconcileWarnings([stored], [changed]);

  assert.equal(rec.status, "superseded");
  // Original warning + disposition are preserved verbatim (audit trail).
  assert.deepEqual(rec.warning, warning);
  assert.deepEqual(rec.disposition, { dismissedByOperator: true, note: "reviewed, acceptable" });
  // A regenerated reference against current content is provided (cheap regen).
  assert.ok(rec.regeneratedReference);
  assert.equal(rec.regeneratedReference!.measureId, "1.1");
  assert.equal(rec.regeneratedReference!.contentHash, computeMeasureContentHash(changed));
});

test("reconcileWarnings: current warning has no regenerated reference", () => {
  const stored: ReferencedWarning = {
    id: "w-2",
    reference: buildStructuredReference(measureA),
    warning: { measureId: "1.1", rule: "overlap", severity: "info", message: "x" },
  };
  const [rec] = reconcileWarnings([stored], [measureA]);
  assert.equal(rec.status, "current");
  assert.equal(rec.regeneratedReference, null);
});

/**
 * Tests for the generic measure-design diagnostic pure functions (Change E).
 * node:test — run with:  npx tsx --test server/lib/measure-design-diagnostic.test.ts
 *
 * Only the pure, side-effect-free analyzers are exercised here (no DB). Nothing
 * references a specific measure, company, or framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMeasureDefinition,
  computePostTestSignals,
  computeMultiRunSignals,
  type DiagnosticMeasure,
} from "./measure-design-diagnostic.js";

test("PRE-TEST detects whitelist_vs_exclusion_conflict on overlapping content terms", () => {
  const m: DiagnosticMeasure = {
    measureId: "m1",
    title: "Overlap",
    substantiveDefinition: "A dedicated remuneration committee overseeing executive incentives.",
    whatDoesNotConstituteEvidence: "Generic references to a remuneration committee without incentives detail.",
  };
  const patterns = analyzeMeasureDefinition(m).map((f) => f.pattern);
  assert.ok(patterns.includes("whitelist_vs_exclusion_conflict"));
});

test("PRE-TEST detects existence_strength_conflation", () => {
  const m: DiagnosticMeasure = {
    measureId: "m2",
    title: "Conflation",
    primaryAssessmentTarget: "Whether the company has a policy that is comprehensive and robust.",
    definition: "Assess if a disclosed policy exists and whether it is sufficiently detailed.",
  };
  const patterns = analyzeMeasureDefinition(m).map((f) => f.pattern);
  assert.ok(patterns.includes("existence_strength_conflation"));
});

test("PRE-TEST detects non_json_scoring_guidance for plain prose", () => {
  const m: DiagnosticMeasure = {
    measureId: "m3",
    title: "Prose guidance",
    scoringGuidance: "Award Yes when the company clearly discloses a policy.",
  };
  const patterns = analyzeMeasureDefinition(m).map((f) => f.pattern);
  assert.ok(patterns.includes("non_json_scoring_guidance"));
});

test("PRE-TEST returns no findings for a clean, well-scoped measure", () => {
  const m: DiagnosticMeasure = {
    measureId: "m4",
    title: "Clean",
    primaryAssessmentTarget: "Whether a board committee is disclosed.",
    definition: "The company discloses a board committee responsible for oversight.",
    scoringGuidance: JSON.stringify({ yes: "disclosed", no: "not disclosed" }),
  };
  assert.equal(analyzeMeasureDefinition(m).length, 0);
});

test("POST-TEST computes rates and verdict distribution per measure", () => {
  const cellsByMeasure = new Map([
    [
      "m1",
      [
        { measureId: "m1", verdict: "Yes", confidence: "high", score: 1, companyId: 1 },
        { measureId: "m1", verdict: "No", confidence: "review-required", score: 0, companyId: 2, rationaleScoreInconsistent: true },
        { measureId: "m1", verdict: "No", confidence: "low", score: 0, companyId: 3 },
        { measureId: "m1", verdict: "Yes", confidence: "high", score: 1, companyId: 4 },
      ],
    ],
  ]);
  const [sig] = computePostTestSignals(cellsByMeasure, new Map([["m1", "M1"]]));
  assert.equal(sig.cellsAnalyzed, 4);
  assert.deepEqual(sig.verdictDistribution, { Yes: 2, No: 2 });
  assert.equal(sig.lowConfidenceRate, 0.5); // review-required + low
  assert.equal(sig.reviewRequiredRate, 0.25);
  assert.equal(sig.rationaleInconsistentRate, 0.25);
});

test("MULTI-RUN computes verdict flip rate across runs for common companies", () => {
  const run1 = new Map([
    ["m1", [
      { measureId: "m1", verdict: "Yes", companyId: 1 },
      { measureId: "m1", verdict: "No", companyId: 2 },
    ]],
  ]);
  const run2 = new Map([
    ["m1", [
      { measureId: "m1", verdict: "Yes", companyId: 1 }, // stable
      { measureId: "m1", verdict: "Yes", companyId: 2 }, // flipped
    ]],
  ]);
  const [sig] = computeMultiRunSignals([run1, run2], new Map([["m1", "M1"]]));
  assert.equal(sig.companiesCompared, 2);
  assert.equal(sig.flipRate, 0.5);
});

test("MULTI-RUN returns nothing with fewer than two runs", () => {
  const run1 = new Map([["m1", [{ measureId: "m1", verdict: "Yes", companyId: 1 }]]]);
  assert.deepEqual(computeMultiRunSignals([run1], new Map()), []);
});

/**
 * Tests for the PRE-DRAFT design-diagnostic wiring in Framework Builder v2.
 *
 * Verifies the in-memory draft → DiagnosticMeasure mapping (which must accept
 * the LLM's mixed snake_case / camelCase field names) and that a freshly drafted
 * framework gets a STATIC (pre-test only, no runs) diagnostic attached for
 * REVIEW before it is proposed as ready.
 *
 * node:test — run with:
 *   DATABASE_URL=... npx tsx --test server/routes/framework-builder-v2-diagnostic.test.ts
 * (A dummy DATABASE_URL is only needed because the module's import chain pulls
 *  in the db layer; NO query runs — the tested helpers are pure.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftMeasureToDiagnostic, buildDraftDesignDiagnostic } from "./framework-builder-v2.js";

test("draftMeasureToDiagnostic maps snake_case draft fields", () => {
  const dm = draftMeasureToDiagnostic(
    {
      measureId: "1.1",
      title: "T",
      primary_assessment_target: "Whether the company has a robust policy",
      substantive_definition: "def",
      fallback_yes_criterion: "1) ... 2) ... 3) ...",
      positive_examples: ["a"],
      negative_examples: ["b"],
      whatConstitutesEvidence: ["quote one", "quote two"],
    },
    "9",
  );
  assert.equal(dm.measureId, "1.1");
  assert.equal(dm.primaryAssessmentTarget, "Whether the company has a robust policy");
  assert.equal(dm.substantiveDefinition, "def");
  assert.equal(dm.fallbackYesCriterion, "1) ... 2) ... 3) ...");
  // array whatConstitutesEvidence is joined to text
  assert.equal(dm.whatConstitutesEvidence, "quote one\nquote two");
});

test("draftMeasureToDiagnostic falls back to positional id when measureId missing", () => {
  const dm = draftMeasureToDiagnostic({ title: "no id" }, "3");
  assert.equal(dm.measureId, "3");
});

test("buildDraftDesignDiagnostic attaches PRE-TEST only (no runs) to an in-memory draft", () => {
  const draft = {
    framework: { name: "My Framework" },
    categories: [
      {
        name: "Cat A",
        measures: [
          {
            measureId: "1.1",
            title: "Conflated",
            // existence + strength language in the target → conflation finding
            primary_assessment_target: "Whether a disclosed policy exists and is comprehensive and robust.",
            definition: "Assess if the policy is sufficiently detailed.",
          },
          {
            measureId: "1.2",
            title: "Clean",
            substantive_definition: "A named committee with a stated review cadence.",
            scoring_guidance: JSON.stringify({ yes: "present", no: "absent" }),
          },
        ],
      },
    ],
  };
  const intake: any = { topic: "Topic", topicTerm: "topic" };
  const report = buildDraftDesignDiagnostic(draft, intake);

  assert.equal(report.frameworkId, 0, "no persisted id at draft time");
  assert.equal(report.frameworkName, "My Framework");
  assert.equal(report.measuresAnalyzed, 2);
  // Pre-test only: no scoring has happened.
  assert.equal(report.postTest.length, 0);
  assert.equal(report.multiRun.length, 0);
  assert.equal(report.batchIds.length, 0);
  // The conflated measure is flagged; the clean one is not.
  const flaggedIds = report.flaggedMeasures.map((f) => f.measureId);
  assert.ok(flaggedIds.includes("1.1"));
  assert.ok(!flaggedIds.includes("1.2"));
});

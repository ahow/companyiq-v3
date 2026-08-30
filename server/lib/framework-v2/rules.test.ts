/**
 * Unit tests for C1-C10 validators.
 *
 * These tests exercise each rule in isolation with minimal fixtures.
 * The test-runner is currently informal (Node's built-in test module or
 * vitest — the repo has `.test.ts` files elsewhere; running them requires
 * whatever runner is set up).
 *
 * Even without a runner these tests document the intended behaviour.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateAll,
  validateC1,
  validateC2,
  validateC3,
  validateC4,
  validateC5,
  validateC6,
  validateC7,
  validateC8,
  validateC9,
  validateC10,
  type FrameworkDraft,
  type MeasureDraft,
} from "./rules.js";

// ─── Fixtures ────────────────────────────────────────────────────────────

function goodMeasure(overrides: Partial<MeasureDraft> = {}): MeasureDraft {
  return {
    measureId: "1.1-example",
    title: "Does the entity disclose a policy on nature and biodiversity management",
    primary_assessment_target: "policy on nature and biodiversity management",
    substantive_definition:
      "This measure tests whether the entity discloses a policy on nature and biodiversity management. Evidence may be disclosed in any vehicle — annual reports, sustainability reports, dedicated policy documents, code-of-conduct sections, KPI tables, or entity website — provided content substantively matches this measure's target. This measure specifically tests nature and biodiversity management. Evidence attributed to adjacent topics does NOT satisfy this measure, even if language overlaps. Adjacent topics that must be excluded include: general environmental management, climate change strategy.",
    whatConstitutesEvidence: "A published policy, target, or commitment on nature and biodiversity management.",
    whatDoesNotConstituteEvidence:
      "Aspirational language without specific subject, action, or timeframe (e.g. 'we care about nature'). Third-party or industry references not adopted by the entity itself. Evidence attributed to general environmental management without specific nature/biodiversity content.",
    scoringGuidance:
      "Score Yes if a policy, target, or commitment is disclosed. When returning evidence, provide a verbatim quote of at least 120 characters including the full sentence containing the topic term plus at least one adjacent sentence for context.",
    fallback_yes_criterion:
      "Yes if ANY of the following substantive conditions is met, regardless of vocabulary or disclosure vehicle:\n(1) The entity discloses a policy, commitment, target, or statement specifically on nature and biodiversity management, at any level of detail — including forward-looking commitments and framework alignments (e.g. TNFD).\n(2) The entity discloses a monitoring, audit, KPI, or measurement programme specifically addressing nature and biodiversity management.\n(3) The entity discloses a governance structure (board committee, executive owner, working group) with nature and biodiversity management explicitly in its mandate.",
    positive_examples: ["We have adopted a Group Nature Policy in 2024.", "Our board Sustainability Committee reviews our biodiversity strategy annually."],
    negative_examples: ["We care about the environment.", "We support the goals of the Paris Agreement."],
    min_quote_context_chars: 120,
    expected_yes_rate: 0.35,
    c1_achievement_guidance: {
      yes_cases: ["We have achieved our 2020 nature no-net-loss commitment."],
      no_cases: ["Species counts on our sites fell 10% last year."],
      distinguishing_test: "The disclosure must reference a target state, aspiration, or programme; a pure numerical outcome without target-state language does not qualify.",
    },
    ...overrides,
  };
}

function goodFramework(overrides: Partial<FrameworkDraft> = {}): FrameworkDraft {
  return {
    name: "Nature and biodiversity management",
    topicTerm: "nature and biodiversity management",
    topicSynonyms: ["biodiversity", "nature-related risk"],
    adjacentTopics: [
      { name: "general environmental management", example_phrases: ["environmental policy"] },
      { name: "climate change strategy", example_phrases: ["Paris Agreement", "net zero"] },
    ],
    anchorFrameworks: [{ name: "TNFD" }, { name: "SBTN" }],
    sensitivityPreference: "balanced",
    measures: [goodMeasure()],
    ...overrides,
  };
}

// ─── C1 ──────────────────────────────────────────────────────────────────

test("C1 passes on a compliant measure", () => {
  const r = validateC1(goodFramework());
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations)}`);
});

test("C1 fails when title contains an achievement verb", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ title: "Has achieved a nature no-net-loss commitment" })],
  });
  const r = validateC1(fw);
  assert.equal(r.passed, false);
  assert.ok(r.violations.some((v) => v.rule === "C1"));
});

test("C1 passes when achievement verb is present but marked as metrics exception", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ title: "Has achieved a nature no-net-loss commitment", r3_1_exception_metrics: true })],
  });
  const r = validateC1(fw);
  // The verb check is skipped, but c1_achievement_guidance is still required
  assert.ok(r.violations.every((v) => v.severity !== "error" || v.message.includes("distinguishing")));
});

test("C1 fails when c1_achievement_guidance is missing", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ c1_achievement_guidance: undefined })],
  });
  const r = validateC1(fw);
  assert.equal(r.passed, false);
});

// ─── C2 ──────────────────────────────────────────────────────────────────

test("C2 passes on substantive-only exclusions", () => {
  const r = validateC2(goodFramework());
  assert.equal(r.passed, true);
});

test("C2 fails on forward-looking-commitment disqualifier", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        whatDoesNotConstituteEvidence: "Forward-looking commitments do not qualify as evidence.",
      }),
    ],
  });
  const r = validateC2(fw);
  assert.equal(r.passed, false);
});

// ─── C3 ──────────────────────────────────────────────────────────────────

test("C3 passes when min_quote_context_chars >= 120 and scoringGuidance mentions adjacent sentence", () => {
  const r = validateC3(goodFramework());
  assert.equal(r.passed, true);
});

test("C3 fails on missing quote-context field", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ min_quote_context_chars: 80 })],
  });
  const r = validateC3(fw);
  assert.equal(r.passed, false);
});

// ─── C4 ──────────────────────────────────────────────────────────────────

test("C4 passes with 3+ numbered conditions each referencing the topic", () => {
  const r = validateC4(goodFramework());
  assert.equal(r.passed, true);
});

test("C4 fails when a condition omits the topic", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        fallback_yes_criterion:
          "(1) The entity discloses a policy on nature and biodiversity management.\n(2) The entity has any governance structure.\n(3) The entity discloses a monitoring programme on nature and biodiversity management.",
      }),
    ],
  });
  const r = validateC4(fw);
  assert.equal(r.passed, false);
});

// ─── C5 ──────────────────────────────────────────────────────────────────

test("C5 passes when adjacent-topic exclusion is present", () => {
  const r = validateC5(goodFramework());
  assert.equal(r.passed, true);
});

test("C5 fails when substantive_definition omits all adjacent topics", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests nature disclosure. Evidence may be disclosed in any vehicle.",
      }),
    ],
  });
  const r = validateC5(fw);
  assert.equal(r.passed, false);
});

test("C5 passes when LLM paraphrases adjacent-topic names in-sentence", () => {
  // Regression: the LLM emits an exclusion clause but names adjacent topics
  // by distinctive keyword rather than exact intake label.
  const fw = goodFramework({
    adjacentTopics: [
      { name: "Climate Change", example_phrases: ["climate scenario analysis"] },
      { name: "Water Management", example_phrases: [] },
      { name: "Waste & Pollution", example_phrases: [] },
    ],
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests nature scenario analysis for nature and biodiversity. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate scenario analysis, water scenario planning, and waste and pollution scenarios.",
      }),
    ],
  });
  const r = validateC5(fw);
  assert.equal(r.passed, true, `expected passed=true, got violations: ${JSON.stringify(r.violations)}`);
});

// ─── C6 ──────────────────────────────────────────────────────────────────

test("C6 fails when fewer than 2 negative examples", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ negative_examples: ["only one"] })],
  });
  const r = validateC6(fw);
  assert.equal(r.passed, false);
});

// ─── C7 ──────────────────────────────────────────────────────────────────

test("C7 fails on coverage measure without whitelist", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        r3_1_exception_coverage: true,
        title: "Coverage of biodiversity policy is enterprise-wide",
        coverage_whitelist: ["across the group"],
      }),
    ],
  });
  const r = validateC7(fw);
  assert.equal(r.passed, false);
});

test("C7 passes on coverage measure with 3+ whitelist entries and threshold in title", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        r3_1_exception_coverage: true,
        title: "Coverage of biodiversity policy applies enterprise-wide OR to ≥70% of the portfolio",
        coverage_whitelist: ["across the group", "enterprise-wide", "all our operations"],
      }),
    ],
  });
  const r = validateC7(fw);
  assert.equal(r.passed, true);
});

// ─── C8 ──────────────────────────────────────────────────────────────────

test("C8 fails when vehicle-agnostic clause is missing", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ substantive_definition: "Testing biodiversity policy. Adjacent topics: general environmental management, climate change strategy." })],
  });
  const r = validateC8(fw);
  assert.equal(r.passed, false);
});

// ─── C9 ──────────────────────────────────────────────────────────────────

test("C9 fails when expected_yes_rate is missing", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ expected_yes_rate: undefined })],
  });
  const r = validateC9(fw);
  assert.equal(r.passed, false);
});

// ─── C10 ─────────────────────────────────────────────────────────────────

test("C10 fails when topicSynonyms is empty", () => {
  const fw = goodFramework({ topicSynonyms: [] });
  const r = validateC10(fw);
  assert.equal(r.passed, false);
});

// ─── Aggregate ───────────────────────────────────────────────────────────

test("validateAll passes on the good framework", () => {
  const r = validateAll(goodFramework());
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations, null, 2)}`);
});

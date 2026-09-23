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
  validateC11,
  validateC12,
  findDegreeWords,
  DEGREE_WORDS,
  toStructuredIssues,
  renderStructuredIssues,
  evaluateAcceptanceGate,
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

test("C4 passes when at least one condition names the topic (AND-joined scope)", () => {
  // Fallback conditions are AND-joined — topic scope needs to be anchored
  // only ONCE; other conditions can be scaffolding prerequisites. Requiring
  // every condition to repeat the topic produces stilted text.
  const fw = goodFramework({
    measures: [
      goodMeasure({
        fallback_yes_criterion:
          "(1) The disclosure explicitly names the Board or a board-level committee.\n(2) That body is assigned responsibility specifically for nature and biodiversity.\n(3) The described responsibility involves oversight or review activities.",
      }),
    ],
  });
  const r = validateC4(fw);
  assert.equal(r.passed, true, `expected passed=true; violations: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.length, 0);
});

test("C4 fails when NO condition references the topic", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        fallback_yes_criterion:
          "(1) The entity discloses a policy on management topics.\n(2) The entity has any governance structure.\n(3) The entity discloses a monitoring programme on general activities.",
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

test("C8 warns when vehicle-agnostic clause is missing (soft check)", () => {
  const fw = goodFramework({
    measures: [goodMeasure({ substantive_definition: "Testing biodiversity policy. Adjacent topics: general environmental management, climate change strategy." })],
  });
  const r = validateC8(fw);
  // C8 is now a soft warning — doesn't block validation, but should still surface a violation.
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].severity, "warning");
  assert.equal(r.passed, true);
});

test("C8 passes when substantive_definition mentions >=2 disclosure vehicles", () => {
  const fw = goodFramework({
    measures: [goodMeasure({
      substantive_definition: "This measure tests policy disclosure for nature and biodiversity. Evidence attributed to adjacent topics like climate change does NOT satisfy this measure. Evidence may appear in the annual report, sustainability report, or a dedicated policy document.",
    })],
  });
  const r = validateC8(fw);
  assert.equal(r.passed, true);
  assert.equal(r.violations.length, 0);
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

// ─── C11 ─────────────────────────────────────────────────────────────────

test("findDegreeWords finds whole-word degree matches case-insensitively", () => {
  assert.deepEqual(findDegreeWords("Integration is Substantive here").sort(), ["integration", "substantive"]);
  // whole-word only: "disintegration" must NOT match "integration"
  assert.deepEqual(findDegreeWords("disintegration of the estate"), []);
  assert.deepEqual(findDegreeWords(""), []);
  assert.ok(DEGREE_WORDS.includes("integrated"));
});

test("C11 passes when a degree word is accompanied by a countable N-of-M rule", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests whether ERM integration for nature is substantive. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        fallback_yes_criterion:
          "Yes if at least 2 of the following NAMED artefacts appear in a verbatim quote on nature and biodiversity:\n(1) a named risk register or ERM process document listing a nature/biodiversity risk,\n(2) a named risk-committee or board mandate naming nature,\n(3) a quantified or dated nature/biodiversity risk metric.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.filter((v) => v.rule === "C11").length, 0);
});

test("C11 fails when a degree word appears with NO countable rule", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        // No enumerated list and no "N of" selection phrasing anywhere.
        substantive_definition:
          "This measure tests nature and biodiversity risk integration. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        scoringGuidance:
          "Award Yes when nature risk integration into ERM is substantive and the governance is robust. When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.",
        fallback_yes_criterion:
          "Yes when the disclosure shows that nature and biodiversity risks are integrated into enterprise risk management in a meaningful way.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, false);
  const c11 = r.violations.filter((v) => v.rule === "C11");
  assert.equal(c11.length, 1);
  assert.equal(c11[0].severity, "error");
});

test("C11 passes on a measure with no degree words at all", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests whether a nature and biodiversity policy is disclosed. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        scoringGuidance:
          "Score Yes if a nature and biodiversity policy is disclosed. When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.",
        fallback_yes_criterion:
          "Yes when the disclosure names a published nature and biodiversity policy with a stated scope and owner.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.filter((v) => v.rule === "C11").length, 0);
});

// Per-condition tightening: a bare degree word deciding ONE condition must error
// even when a DIFFERENT condition carries a countable rule. This is the real 3.5
// baseline case the old measure-level rule missed.
test("C11 fails when a condition's deciding test is a bare degree word even if a LATER condition is countable", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests nature and biodiversity risk in ERM. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        fallback_yes_criterion:
          "Yes if ANY of the following conditions is met:\n(1) Nature and biodiversity risks are integrated into the enterprise risk management framework.\n(2) At least 2 of the following NAMED artefacts appear in a verbatim quote: (a) a named risk register entry for a nature risk, (b) a named board committee overseeing nature risk, (c) a quantified nature risk metric.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, false);
  const c11 = r.violations.filter((v) => v.rule === "C11");
  assert.equal(c11.length, 1);
  assert.equal(c11[0].severity, "error");
  // The flagged condition must be #1 (the bare degree word), not the countable #2.
  assert.ok(/integrated/.test(c11[0].message), `expected 'integrated' in message: ${c11[0].message}`);
});

// A degree word inside a condition that ALSO carries an in-condition (a)/(b)/(c)
// named-artefact enumeration is decidable → no error.
test("C11 passes when a degree word's condition has an in-condition (a)/(b)/(c) named-artefact test", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests nature and biodiversity risk in ERM. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        fallback_yes_criterion:
          "Yes if ANY of the following conditions is met:\n(1) Nature-risk integration into ERM is shown by the presence in a verbatim quote of (a) a named risk-committee or board mandate naming nature, (b) a named risk-register entry for a nature/biodiversity risk, and (c) a quantified or dated nature risk metric.\n(2) The disclosure names a published nature and biodiversity risk policy with a stated scope and owner.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.filter((v) => v.rule === "C11").length, 0);
});

// A fully clean numbered criterion (no degree words in any condition) → no error.
test("C11 passes on a fully countable per-condition criterion with no degree words", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        substantive_definition:
          "This measure tests nature and biodiversity risk in ERM. Evidence attributed to adjacent topics does NOT satisfy this measure. Adjacent topics that must be excluded include: climate change strategy.",
        scoringGuidance:
          "Score Yes if a named ERM artefact covers a nature risk. When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.",
        fallback_yes_criterion:
          "Yes if ANY of the following conditions is met:\n(1) A named enterprise risk register or principal-risks disclosure lists a nature or biodiversity risk.\n(2) A named board or management committee has nature risk oversight in its stated mandate.\n(3) A quantified or dated nature/biodiversity risk metric is reported at enterprise level.",
      }),
    ],
  });
  const r = validateC11(fw);
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations)}`);
  assert.equal(r.violations.filter((v) => v.rule === "C11").length, 0);
});

// ─── C12 — conjunctive-bundle advisory (info, never blocking) ─────────────

// (a) An M-of-N / OR-list soft gate produces exactly ONE C12 advisory at
// severity "info", and it NEVER makes the framework fail (passed stays true).
test("C12 emits an info advisory on an M-of-N soft gate and never blocks", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        measureId: "1.2-mofn",
        fallback_yes_criterion:
          "Yes if at least 2 of the following conditions appear in a verbatim quote:\n(1) a named enterprise risk register listing a nature or biodiversity risk,\n(2) a named board or management committee with nature and biodiversity risk in its mandate,\n(3) a quantified or dated nature/biodiversity risk metric.",
      }),
    ],
  });
  const r = validateC12(fw);
  const c12 = r.violations.filter((v) => v.rule === "C12");
  assert.equal(c12.length, 1, `expected exactly one C12 advisory, got: ${JSON.stringify(r.violations)}`);
  assert.equal(c12[0].severity, "info");
  assert.ok(c12[0].suggestion && /ALL of the following/i.test(c12[0].suggestion), "C12 suggestion should propose a conjunctive ALL-of bundle");
  // validateC12 itself never fails ...
  assert.equal(r.passed, true);
  // ... and the advisory does NOT flip the overall verdict.
  const all = validateAll(fw);
  assert.equal(all.passed, true, `expected validateAll to pass, got: ${JSON.stringify(all.violations, null, 2)}`);
  assert.ok(all.violations.some((v) => v.rule === "C12" && v.severity === "info"), "C12 info should surface through validateAll");
});

// An OR-list where any single condition triggers Yes also fires C12.
test("C12 fires on an 'any of the following' OR-list gate", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        measureId: "1.3-orlist",
        fallback_yes_criterion:
          "Yes if ANY of the following conditions is met:\n(1) the entity names a nature and biodiversity policy,\n(2) the entity names a nature and biodiversity governance body,\n(3) the entity reports a nature and biodiversity metric.",
      }),
    ],
  });
  const c12 = validateC12(fw).violations.filter((v) => v.rule === "C12");
  assert.equal(c12.length, 1);
  assert.equal(c12[0].severity, "info");
});

// (b) A measure already framed as a conjunctive hard-token bundle produces NO
// C12 advisory (it is treated as already hardened).
test("C12 stays silent on a conjunctive hard-token bundle", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        measureId: "1.4-bundle",
        fallback_yes_criterion:
          "Return Yes ONLY if a single verbatim quote satisfies ALL of the following: (1) it names an enterprise risk register entry covering a nature or biodiversity risk, AND (2) it binds to that entry a named accountable committee or a quantified/dated nature and biodiversity metric.",
        scoringGuidance:
          "Score Yes only when all of the required tokens co-occur in one quote. When returning evidence, provide a verbatim quote of at least 120 characters. Include the full sentence containing the topic term plus at least one adjacent sentence for context.",
      }),
    ],
  });
  const c12 = validateC12(fw).violations.filter((v) => v.rule === "C12");
  assert.equal(c12.length, 0, `expected no C12 advisory on a conjunctive bundle, got: ${JSON.stringify(c12)}`);
});

// (c) C11 (degree-word) behaviour is UNCHANGED by the addition of C12: a bare
// degree-word gate still errors under C11, and adding C12 does not alter that.
test("C12 does not change C11 degree-word behaviour", () => {
  const fw = goodFramework({
    measures: [
      goodMeasure({
        measureId: "9.9-degree",
        fallback_yes_criterion:
          "Yes if the entity has a substantive approach to nature and biodiversity management.",
      }),
    ],
  });
  // C11 still fires as an error.
  const c11 = validateC11(fw).violations.filter((v) => v.rule === "C11");
  assert.equal(c11.length, 1);
  assert.equal(c11[0].severity, "error");
  // This bare degree-word gate has no M-of-N / OR-list structure → no C12.
  const c12 = validateC12(fw).violations.filter((v) => v.rule === "C12");
  assert.equal(c12.length, 0);
  // validateAll still blocks on the C11 error (C12 is advisory-only).
  const all = validateAll(fw);
  assert.equal(all.passed, false);
  assert.ok(all.violations.some((v) => v.rule === "C11" && v.severity === "error"));
});

// ─── Aggregate ───────────────────────────────────────────────────────────

test("validateAll passes on the good framework", () => {
  const r = validateAll(goodFramework());
  assert.equal(r.passed, true, `expected pass, got: ${JSON.stringify(r.violations, null, 2)}`);
});

// ─── ITEM 1: structured issues + acceptance gate ──────────────────────────

// A measure whose fallback decides on a degree word with no countable rule
// produces a C11 error violation — used to drive the transformer/gate tests.
function ambiguousFramework(): FrameworkDraft {
  return goodFramework({
    measures: [
      goodMeasure({
        measureId: "9.9-ambiguous",
        fallback_yes_criterion:
          "Yes if the entity has a substantive approach to nature and biodiversity management.",
      }),
    ],
  });
}

test("toStructuredIssues maps a C11 violation into the four-part shape", () => {
  const v = validateC11(ambiguousFramework());
  assert.equal(v.passed, false);
  const issues = toStructuredIssues(v.violations);
  assert.ok(issues.length >= 1);
  const i = issues.find((x) => x.ruleCode === "C11");
  assert.ok(i, "expected a C11 structured issue");
  assert.equal(i!.severity, "error");
  assert.equal(i!.measureId, "9.9-ambiguous");
  // all four parts present
  assert.ok(i!.issue && i!.issue.length > 0, "issue text present");
  assert.ok(i!.reason && i!.reason.length > 0, "reason present");
  assert.ok(i!.solution && i!.solution.length > 0, "solution present");
  assert.ok(i!.implication && i!.implication.length > 0, "implication present");
  assert.ok(i!.id && i!.id.includes("c11"), "id encodes rule code");
});

test("toStructuredIssues ids are stable across identical drafts", () => {
  const a = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  const b = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  assert.deepEqual(a.map((i) => i.id), b.map((i) => i.id));
});

test("renderStructuredIssues emits all four labelled parts", () => {
  const issues = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  const text = renderStructuredIssues(issues);
  assert.match(text, /Issue:/);
  assert.match(text, /Reason:/);
  assert.match(text, /Proposed solution:/);
  assert.match(text, /Implication of not changing:/);
});

test("evaluateAcceptanceGate BLOCKS unaccepted error issues", () => {
  const issues = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  const gate = evaluateAcceptanceGate(issues, {});
  assert.equal(gate.allowed, false);
  assert.ok(gate.blockingIssues.length >= 1);
});

test("evaluateAcceptanceGate ALLOWS when each error id is accepted", () => {
  const issues = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  const errorIds = issues.filter((i) => i.severity === "error").map((i) => i.id);
  const gate = evaluateAcceptanceGate(issues, { acceptedIssueIds: errorIds });
  assert.equal(gate.allowed, true);
  assert.equal(gate.blockingIssues.length, 0);
  assert.equal(gate.acceptedCount, errorIds.length);
});

test("evaluateAcceptanceGate ALLOWS with proceedWithWarnings", () => {
  const issues = toStructuredIssues(validateC11(ambiguousFramework()).violations);
  const gate = evaluateAcceptanceGate(issues, { proceedWithWarnings: true });
  assert.equal(gate.allowed, true);
  assert.equal(gate.blockingIssues.length, 0);
});

test("evaluateAcceptanceGate ignores warnings (never blocking) and passes clean drafts", () => {
  const clean = toStructuredIssues(validateAll(goodFramework()).violations);
  const gate = evaluateAcceptanceGate(clean, {});
  assert.equal(gate.allowed, true);
});

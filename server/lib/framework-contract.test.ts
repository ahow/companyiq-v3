/**
 * framework-contract.test.ts — A6 / WP07 committed test suite.
 *
 * Proves the seven FW invariants that A6 adds on top of the already-working
 * single-source framework-v2 modules (scoring-contract, structured-guidance,
 * anti-inference, root-cause-diagnostic, builder-improve), plus the three
 * cross-cutting safety properties A6 ships under: the kill-switch defaults to a
 * non-mutating shadow pass, governance never mutates a published score, and the
 * assembled contract round-trips through serialization with every hardening
 * field intact. All tests are deterministic — no DB, no network, no LLM.
 *
 * Mirrors the A3 suite style: plain tsx script, node:assert/strict, a local
 * test() harness with pass/fail counters.
 *
 * FW01 — a missed source = discovery (research) defect, never a definition defect.
 * FW02 — prevalence / target-distribution alone can't alter criteria or scores.
 * FW03 — aspirational ESG text can't satisfy an implementation-specific measure.
 * FW04 — no silent construct change: shadow emits no new version; enforce emits a
 *        NEW version and never rewrites the current published one.
 * FW05 — revisions must help adjudicated failures without harming holdout subgroups.
 * FW06 — export/import preserves hardening fields (round-trip is lossless).
 * FW07 — a test-drive stays within the settings/deadline envelope.
 * + kill-switch-default, non-mutation, and serialization-shape tests.
 *
 * Run: DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub \
 *        npx tsx server/lib/framework-contract.test.ts
 */

import assert from "node:assert/strict";
import {
  // policy / kill-switch
  resolveFrameworkContractPolicy,
  isFrameworkContractEnforced,
  DEFAULT_FRAMEWORK_CONTRACT_POLICY,
  FRAMEWORK_CONTRACT_POLICY_ENV,
  FRAMEWORK_CONTRACT_POLICY_VERSION,
  // G1 — contract view
  buildMeasureContract,
  examplesMutateRule,
  searchHintUsedAsEligibility,
  serializeMeasureContract,
  parseMeasureContract,
  aspirationalEvidenceSatisfies,
  // G2 — defect classifier
  classifyTestDriveDefect,
  classifyMissedDocument,
  ALL_DEFECT_CATEGORIES,
  // G3 — Goodhart validator + impact preview
  validateRubricEdit,
  previewEditImpact,
  // orchestrator + FW05/FW07 helpers
  runContractGovernance,
  evaluateRevisionAgainstHoldout,
  withinTestDriveEnvelope,
  DEFAULT_TEST_DRIVE_ENVELOPE,
  type MeasureContract,
  type ProposedRubricEdit,
} from "./framework-contract.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    fail++;
    console.log(`\u2717 ${name}`);
    console.log(`    ${(err as Error)?.message ?? err}`);
  }
}

// ─── Shared fixtures (generic, framework-level — no company/topic specifics) ──

// An implementation-stance measure: asks for an IMPLEMENTED practice.
const IMPL_MEASURE = {
  measureId: "M-IMPL-1",
  title: "Operates an independent board-level risk committee",
  construct: "existence of an operating board-level risk committee",
  substantiveDefinition:
    "The assessed entity operates an independent board-level committee responsible for risk oversight.",
  scoringGuidance: JSON.stringify({
    qualifyingInstance: "A disclosure describing an operating independent board risk committee.",
    disqualifiers: ["A plan to establish such a committee in the future."],
    anchors: { yes: "The board's Risk Committee met four times in 2024.", no: "No board committee covers risk." },
    yesRequiresQuote: "A Yes requires a verbatim quote naming the committee and its oversight role.",
  }),
  requiredSourceTypes: ["annual report", "governance disclosure"],
  evidenceKeywords: ["risk committee", "board oversight"],
};

// An aspiration-eligible measure: the construct IS a target/commitment.
const ASPIRATION_MEASURE = {
  measureId: "M-ASP-1",
  title: "Has set a published emissions reduction target",
  construct: "the entity has set a published emissions reduction target",
  substantiveDefinition: "The assessed entity has set and published an emissions reduction target.",
  scoringGuidance: JSON.stringify({
    qualifyingInstance: "A disclosure stating a published, dated reduction target.",
    anchors: { yes: "We commit to a 50% reduction by 2030.", no: "No target disclosed." },
  }),
};

function implContract(): MeasureContract {
  return buildMeasureContract(IMPL_MEASURE, { antiInferenceRules: null, topicTerm: "governance" });
}
function aspContract(): MeasureContract {
  return buildMeasureContract(ASPIRATION_MEASURE, { antiInferenceRules: null, topicTerm: "climate" });
}

// ─── FW01 — missed source = discovery defect, not a definition defect ─────────

test("FW01: a missed document routes to a discovery (research) fix, never a rubric change", () => {
  const c = classifyMissedDocument("M-IMPL-1");
  assert.equal(c.category, "discovery", "missed document must be a discovery defect");
  assert.equal(c.route, "research", "discovery defect must route to research");
  assert.equal(c.blocksRubricChange, true, "a missed document can never justify a looser rubric");
});

test("FW01: documentMissing signal is classified as discovery, not framework-ambiguity", () => {
  const c = classifyTestDriveDefect({ measureId: "M-IMPL-1", documentMissing: true, definitionAmbiguous: true });
  // Even with an ambiguity signal also set, the upstream evidence-supply defect wins.
  assert.equal(c.category, "discovery");
  assert.equal(c.route, "research");
  assert.notEqual(c.category, "framework-ambiguity");
});

test("FW01: no actionable scorer-level defect defaults to discovery, not a rubric loosening", () => {
  const c = classifyTestDriveDefect({ measureId: "M-IMPL-1" });
  assert.equal(c.route, "research");
  assert.equal(c.blocksRubricChange, true);
});

// ─── FW02 — prevalence / target distribution alone can't alter criteria/scores ─

test("FW02: a criteria edit justified by a target yes-rate is rejected (distribution-tuning)", () => {
  const edit: ProposedRubricEdit = {
    measureId: "M-IMPL-1",
    field: "definition",
    justification: "Too many companies are getting Yes; move the definition to bring the yes-rate toward 30%.",
    changesCriteriaOrScores: true,
  };
  const v = validateRubricEdit(edit, implContract());
  assert.equal(v.accepted, false, "distribution-tuning edit must be rejected");
  assert.equal(v.rejectionCode, "distribution-tuning");
});

test("FW02: prevalence-only ('too many yes') justification on a score edit is rejected", () => {
  const v = validateRubricEdit({
    measureId: "M-IMPL-1",
    field: "scoring",
    justification: "There are too many yes results across issuers — tighten scoring to match the expected distribution.",
    changesCriteriaOrScores: true,
  });
  assert.equal(v.accepted, false);
  assert.equal(v.rejectionCode, "distribution-tuning");
});

test("FW02: a structural, non-distributional criteria edit is accepted and requires a new version", () => {
  const v = validateRubricEdit({
    measureId: "M-IMPL-1",
    field: "definition",
    justification: "Adjudication found the definition conflates audit committees with risk committees; disambiguate the two.",
    changesCriteriaOrScores: true,
  });
  assert.equal(v.accepted, true, "a structural fix with no distribution justification is allowed");
  assert.equal(v.requiresNewVersion, true, "an accepted edit must create a new version");
});

test("FW02: a pure advisory expected-yes-rate calibration (no criteria/score change) is not blocked", () => {
  const v = validateRubricEdit({
    measureId: "M-IMPL-1",
    field: "expectedYesRate",
    justification: "Recalibrate the advisory expected yes-rate toward the observed base rate.",
    changesCriteriaOrScores: false,
  });
  assert.equal(v.accepted, true, "calibration that changes no criteria/scores is allowed");
});

test("FW02/Q7: a company-specific fix is rejected unless it is a universal data correction", () => {
  const base: ProposedRubricEdit = {
    measureId: "M-IMPL-1",
    field: "definition",
    justification: "Fix a misread of this issuer's filing.",
    changesCriteriaOrScores: true,
    companySpecific: true,
  };
  assert.equal(validateRubricEdit(base, implContract()).rejectionCode, "company-specific");
  const universal = validateRubricEdit({ ...base, universalDataCorrection: true }, implContract());
  assert.equal(universal.accepted, true, "an explicit universal data correction is allowed");
});

// ─── FW03 — aspirational text can't satisfy an implementation-specific measure ─

test("FW03: aspirational text does NOT satisfy an implementation-stance measure", () => {
  const c = implContract();
  assert.equal(c.stance, "implementation", "the measure must be inferred as implementation-stance");
  const r = aspirationalEvidenceSatisfies(c, "The company intends to establish a board risk committee by 2027.");
  assert.equal(r.satisfies, false, "forward-looking language can't evidence an implemented practice");
});

test("FW03: aspirational text DOES satisfy an aspiration-eligible measure (the target IS the construct)", () => {
  const c = aspContract();
  assert.equal(c.stance, "aspiration-eligible");
  const r = aspirationalEvidenceSatisfies(c, "We commit to reducing emissions 50% by 2030.");
  assert.equal(r.satisfies, true, "when the construct is the target itself, a commitment qualifies");
});

test("FW03: concrete implemented evidence is not blocked by the aspiration check", () => {
  const r = aspirationalEvidenceSatisfies(implContract(), "The board's Risk Committee met four times in 2024.");
  assert.equal(r.satisfies, true, "non-aspirational evidence passes the stance gate");
});

// ─── FW04 — no silent construct change ────────────────────────────────────────

test("FW04: shadow policy emits NO new version and mutates no published score", () => {
  const input = {
    framework: { antiInferenceRules: null, topicTerm: "governance", version: 7, name: "Gov FW" },
    measures: [IMPL_MEASURE],
    proposedEdits: [{
      measureId: "M-IMPL-1",
      field: "definition" as const,
      justification: "Disambiguate audit vs risk committee (structural).",
      changesCriteriaOrScores: true,
    }],
  };
  const res = runContractGovernance(input, "shadow");
  assert.equal(res.newFrameworkVersion, null, "shadow must not emit a new version");
  assert.equal(res.publishedScoresMutated, false, "shadow must mutate no published score");
});

test("FW04: enforce emits a NEW framework version (version+1) and leaves the input untouched", () => {
  const fw = { antiInferenceRules: null, topicTerm: "governance", version: 7, name: "Gov FW" };
  const input = {
    framework: fw,
    measures: [IMPL_MEASURE],
    proposedEdits: [{
      measureId: "M-IMPL-1",
      field: "definition" as const,
      justification: "Disambiguate audit vs risk committee (structural).",
      changesCriteriaOrScores: true,
    }],
  };
  const res = runContractGovernance(input, "enforce");
  assert.ok(res.newFrameworkVersion, "enforce must emit a new version from an accepted edit");
  assert.equal(res.newFrameworkVersion!.framework.version, 8, "new version is prior+1");
  assert.equal(fw.version, 7, "the input framework version is NOT mutated");
  assert.equal(res.publishedScoresMutated, false, "even enforce never rewrites a published score");
});

test("FW04: enforce with NO accepted edit emits no new version (nothing to harden)", () => {
  const res = runContractGovernance({
    framework: { version: 7, name: "Gov FW" },
    measures: [IMPL_MEASURE],
    proposedEdits: [{
      measureId: "M-IMPL-1",
      field: "definition" as const,
      justification: "move the yes-rate toward the target distribution",
      changesCriteriaOrScores: true,
    }],
  }, "enforce");
  assert.equal(res.editValidations[0].accepted, false, "the distribution-tuning edit is rejected");
  assert.equal(res.newFrameworkVersion, null, "no accepted edit ⇒ no new version");
});

// ─── FW05 — revisions help adjudicated failures without harming holdout ────────

test("FW05: a revision that fixes adjudicated failures and harms no holdout is accepted", () => {
  const v = evaluateRevisionAgainstHoldout({
    adjudicatedFailBefore: 10,
    adjudicatedFailAfter: 4,
    holdout: [
      { subgroup: "sector-A", correctBefore: 20, correctAfter: 20 },
      { subgroup: "sector-B", correctBefore: 15, correctAfter: 16 },
    ],
  });
  assert.equal(v.accepted, true);
  assert.equal(v.helpedAdjudicated, true);
  assert.equal(v.harmedHoldout, false);
});

test("FW05: a revision that regresses a holdout subgroup is rejected even if it helps adjudicated", () => {
  const v = evaluateRevisionAgainstHoldout({
    adjudicatedFailBefore: 10,
    adjudicatedFailAfter: 4,
    holdout: [{ subgroup: "sector-A", correctBefore: 20, correctAfter: 17 }],
  });
  assert.equal(v.accepted, false);
  assert.equal(v.harmedHoldout, true);
});

test("FW05: a revision that does not reduce adjudicated failures is rejected", () => {
  const v = evaluateRevisionAgainstHoldout({
    adjudicatedFailBefore: 10,
    adjudicatedFailAfter: 10,
    holdout: [{ subgroup: "sector-A", correctBefore: 20, correctAfter: 22 }],
  });
  assert.equal(v.accepted, false);
  assert.equal(v.helpedAdjudicated, false);
});

// ─── FW06 — export/import preserves hardening fields ──────────────────────────

test("FW06: serialize → parse round-trips preserving every hardening field", () => {
  const c = implContract();
  const round = parseMeasureContract(serializeMeasureContract(c));
  assert.ok(round, "parse must succeed on a serialized contract");
  assert.equal(round!.measureId, c.measureId);
  assert.equal(round!.construct, c.construct);
  assert.equal(round!.stance, c.stance);
  assert.equal(round!.rationaleRequirement, c.rationaleRequirement);
  assert.equal(round!.uncertaintyHandling, c.uncertaintyHandling);
  assert.deepEqual(round!.scoring, c.scoring, "the reused scoring contract must survive the round-trip");
  assert.deepEqual(round!.invariants, c.invariants, "the load-bearing invariants must survive");
  assert.equal(round!.contractModelVersion, FRAMEWORK_CONTRACT_POLICY_VERSION);
});

test("FW06: parse returns null on garbage rather than throwing", () => {
  assert.equal(parseMeasureContract("not json"), null);
  assert.equal(parseMeasureContract(""), null);
  assert.equal(parseMeasureContract("{}"), null);
});

// ─── FW07 — test-drive within settings/deadline envelope ──────────────────────

test("FW07: a within-caps test-drive request is accepted", () => {
  const r = withinTestDriveEnvelope({ sampleSize: 50, deadlineMs: 10 * 60 * 1000 });
  assert.equal(r.withinEnvelope, true);
});

test("FW07: an over-sized sample is rejected", () => {
  const r = withinTestDriveEnvelope({ sampleSize: DEFAULT_TEST_DRIVE_ENVELOPE.maxSampleSize + 1, deadlineMs: 1000 });
  assert.equal(r.withinEnvelope, false);
});

test("FW07: an over-deadline request is rejected", () => {
  const r = withinTestDriveEnvelope({ sampleSize: 10, deadlineMs: DEFAULT_TEST_DRIVE_ENVELOPE.maxDeadlineMs + 1 });
  assert.equal(r.withinEnvelope, false);
});

// ─── Kill-switch default ──────────────────────────────────────────────────────

test("kill-switch: default policy is shadow (non-mutating) with no env set", () => {
  const prev = process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
  delete process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
  try {
    assert.equal(DEFAULT_FRAMEWORK_CONTRACT_POLICY, "shadow");
    assert.equal(resolveFrameworkContractPolicy(), "shadow");
    assert.equal(isFrameworkContractEnforced(), false);
  } finally {
    if (prev !== undefined) process.env[FRAMEWORK_CONTRACT_POLICY_ENV] = prev;
  }
});

test("kill-switch: an unrecognised env value falls back to the safe shadow default", () => {
  const prev = process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
  process.env[FRAMEWORK_CONTRACT_POLICY_ENV] = "garbage-value";
  try {
    assert.equal(resolveFrameworkContractPolicy(), "shadow");
  } finally {
    if (prev === undefined) delete process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
    else process.env[FRAMEWORK_CONTRACT_POLICY_ENV] = prev;
  }
});

test("kill-switch: env=enforce is honoured; explicit arg overrides env", () => {
  const prev = process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
  process.env[FRAMEWORK_CONTRACT_POLICY_ENV] = "enforce";
  try {
    assert.equal(resolveFrameworkContractPolicy(), "enforce");
    assert.equal(resolveFrameworkContractPolicy("shadow"), "shadow", "explicit arg wins over env");
  } finally {
    if (prev === undefined) delete process.env[FRAMEWORK_CONTRACT_POLICY_ENV];
    else process.env[FRAMEWORK_CONTRACT_POLICY_ENV] = prev;
  }
});

// ─── Non-mutation safety ──────────────────────────────────────────────────────

test("non-mutation: publishedScoresMutated is false under BOTH policies", () => {
  const input = {
    framework: { version: 3, name: "FW" },
    measures: [IMPL_MEASURE],
    proposedEdits: [{
      measureId: "M-IMPL-1",
      field: "definition" as const,
      justification: "Structural disambiguation.",
      changesCriteriaOrScores: true,
    }],
  };
  assert.equal(runContractGovernance(input, "shadow").publishedScoresMutated, false);
  assert.equal(runContractGovernance(input, "enforce").publishedScoresMutated, false);
});

test("non-mutation: buildMeasureContract does not mutate the input measure and freezes its output", () => {
  const snapshot = JSON.stringify(IMPL_MEASURE);
  const c = buildMeasureContract(IMPL_MEASURE);
  assert.equal(JSON.stringify(IMPL_MEASURE), snapshot, "the input measure must be untouched");
  assert.equal(Object.isFrozen(c), true, "the contract must be frozen");
  assert.throws(() => { (c as any).construct = "tampered"; }, "a frozen contract rejects mutation in strict mode");
});

test("non-mutation: impact preview tabulates cell flips (yes↔no) and mutates no published score", () => {
  const preview = previewEditImpact(
    { measureId: "M-IMPL-1", field: "definition" },
    [
      { companyId: 1, verdictBefore: "Yes", verdictAfter: "No" },
      { companyId: 2, verdictBefore: "No", verdictAfter: "Yes" },
      { companyId: 3, verdictBefore: "Yes", verdictAfter: "Yes" },
      { companyId: 4, verdictBefore: "No", verdictAfter: "No" },
    ],
  );
  assert.equal(preview.cellsYesToNo, 1, "one yes→no flip");
  assert.equal(preview.cellsNoToYes, 1, "one no→yes flip");
  assert.equal(preview.cellsChanged, 2, "two cells changed in total");
  assert.equal(preview.publishedScoresMutated, false, "a preview never mutates a published score");
});

// ─── Serialization / assembly shape ───────────────────────────────────────────

test("serialization: the assembled contract carries every A6 facet", () => {
  const c = implContract();
  assert.ok(c.construct, "construct present");
  assert.ok(c.definition, "definition present");
  assert.ok(c.qualifyingEvidence, "qualifying evidence present");
  assert.ok(Array.isArray(c.nonQualifyingEvidence), "non-qualifying evidence present");
  assert.ok(c.scope && Array.isArray(c.scope.source), "source/entity/time scope present");
  assert.ok(c.antiInferenceRules, "anti-inference rules composed");
  assert.ok(c.scoring && c.scoring.outcomes, "reused scoring contract present");
  assert.ok(c.rationaleRequirement, "rationale requirement present");
  assert.ok(c.uncertaintyHandling, "uncertainty handling present");
  assert.equal(c.invariants.examplesIllustrateOnly, true);
  assert.equal(c.invariants.searchHintsAreNotEligibility, true);
});

test("invariant: an example promoted into the definition is detected as a violation", () => {
  const c = implContract();
  assert.equal(examplesMutateRule(c, c.examples.yes), true, "verbatim example as definition is a leak");
  assert.equal(examplesMutateRule(c, "A genuinely different structural definition of the Yes-bar."), false);
});

test("invariant: a search hint used as a bare keyword gate is detected as a violation", () => {
  const c = implContract();
  assert.equal(
    searchHintUsedAsEligibility(c, "The document contains the phrase risk committee."),
    true,
    "a keyword-gate criterion over a search hint is not eligibility",
  );
  assert.equal(
    searchHintUsedAsEligibility(c, "The entity discloses an operating risk committee with board oversight."),
    false,
    "a substantive criterion is allowed even if it mentions the hint term",
  );
});

test("classifier: all seven A6 categories are covered and route deterministically", () => {
  assert.equal(ALL_DEFECT_CATEGORIES.length, 7, "exactly seven A6 defect categories");
  assert.equal(classifyTestDriveDefect({ technicalFailure: true }).route, "engineering");
  assert.equal(classifyTestDriveDefect({ extractionEmptyOrPartial: true }).route, "research");
  assert.equal(classifyTestDriveDefect({ eligibilityRejected: true }).category, "entity-provenance");
  assert.equal(classifyTestDriveDefect({ passageNotRetrieved: true }).category, "retrieval");
  assert.equal(classifyTestDriveDefect({ scoringError: true }).route, "scoring-fix");
  assert.equal(classifyTestDriveDefect({ definitionAmbiguous: true }).route, "rubric-change");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

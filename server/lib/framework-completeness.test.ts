// Unit tests for the framework-completeness validator (single source of truth
// used by finalisation Part B and the audit endpoint Part D).
//
// The LLM client is ALWAYS stubbed here — these tests never hit a live model.
// Run: npx tsx --test server/lib/framework-completeness.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCompletenessValidator,
  deriveRequiredDocTypes,
  deriveDataPatterns,
  inspectStringArray,
  compilesAsRegex,
  isNonTrivialString,
  type LlmComplete,
  type FrameworkLike,
  type MeasureLike,
} from "./framework-completeness.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function completeScoringGuidance(): string {
  return JSON.stringify({
    yes: "Evidence must be a standalone published policy naming the topic.",
    no: "No such policy is published.",
    partial: "A mention exists but is not a standalone policy.",
    qualifyingInstance: "A named, dated, standalone policy document adopted by the company.",
    disqualifiers: ["Generic boilerplate", "Aspirational intent without a named instance"],
    anchors: {
      yes: "Acme Responsible AI Policy v2 (2024), a standalone PDF — qualifies.",
      no: "A one-line AI mention in a risk factor — fails, not a standalone policy.",
    },
    yesRequiresQuote: "A Yes requires a verbatim quote naming the standalone policy.",
  });
}

function completeMeasure(id: string): MeasureLike {
  return {
    measureId: id,
    title: `Measure ${id}`,
    definition: "A detailed definition of what constitutes a yes for this measure.",
    scoringGuidance: completeScoringGuidance(),
    evidenceKeywords: ["responsible ai", "ai policy", "governance", "board oversight", "ai ethics", "model risk", "nist", "oecd", "ai act", "principles"],
    requiredSourceTypes: ["standalone-policy", "annual-report"],
    substantiveDefinition: "Precise restatement of the measure with boundaries.",
    fallbackYesCriterion: "A board-approved policy referenced in the annual report still counts.",
  };
}

function completeFramework(): FrameworkLike {
  return {
    id: 1,
    name: "AI Governance",
    topicDescription: "x".repeat(300),
    requiredDocTypes: ["Responsible AI Policy", "Proxy Statement"],
    dataPatterns: ["responsible.?ai", "ai.?governance"],
    negativeKeywords: ["cybersecurity only", "generic it"],
    antiInferenceRules: ["DO NOT count a proxy-named policy that is not published standalone."],
    authoritativeRegistries: ["oecd.ai", "partnershiponai.org"],
    authoritativeFilingTypes: [{ weight: 8, pattern: "responsible.?ai.?policy" }],
    documentPriorityUrlPatterns: ["responsible-ai", "ai-governance"],
  };
}

// LLM stub that authors a deterministic non-empty value for whatever field it is asked to fill.
const llmStub: LlmComplete = async (_provider, opts) => {
  const isArray = opts.prompt.includes('"value": [ ');
  // documentPriorityUrlPatterns / dataPatterns must be valid regex fragments;
  // return simple safe tokens that always compile.
  if (isArray) {
    return { text: JSON.stringify({ value: ["llm-authored-a", "llm-authored-b"] }) };
  }
  return { text: JSON.stringify({ value: "llm-authored string value" }) };
};

// LLM stub that always declines (returns empty), to exercise the MISSING path.
const llmDeclineStub: LlmComplete = async () => ({ text: JSON.stringify({ value: [] }) });

// ─── Helper-level tests ──────────────────────────────────────────────────────

test("isNonTrivialString rejects single chars and pure punctuation", () => {
  assert.equal(isNonTrivialString("ai"), true);
  assert.equal(isNonTrivialString("a"), false);
  assert.equal(isNonTrivialString("--"), false);
  assert.equal(isNonTrivialString("  "), false);
  assert.equal(isNonTrivialString(123), false);
});

test("compilesAsRegex flags invalid regex", () => {
  assert.equal(compilesAsRegex("responsible.?ai"), true);
  assert.equal(compilesAsRegex("[unterminated"), false);
  assert.equal(compilesAsRegex("("), false);
  assert.equal(compilesAsRegex(""), false);
});

test("inspectStringArray drops invalid regex when regexMustCompile and flags them", () => {
  const { plausible, flags } = inspectStringArray(["good.?pattern", "[bad", "also-good"], { regexMustCompile: true });
  assert.deepEqual(plausible, ["good.?pattern", "also-good"]);
  assert.ok(flags.some((f) => f.startsWith("invalid_regex")));
});

test("inspectStringArray flags degenerate duplicates", () => {
  const { plausible, flags } = inspectStringArray(["Alpha", "alpha", "beta"]);
  assert.deepEqual(plausible, ["Alpha", "beta"]);
  assert.ok(flags.some((f) => f.startsWith("degenerate_duplicates")));
});

test("deriveRequiredDocTypes aggregates measure requiredSourceTypes", () => {
  const measures = [
    { measureId: "1.1", requiredSourceTypes: ["proxy", "annual-report"] },
    { measureId: "1.2", requiredSourceTypes: ["proxy", "standalone-policy"] },
  ] as MeasureLike[];
  const out = deriveRequiredDocTypes(measures);
  assert.deepEqual(out.sort(), ["annual-report", "proxy", "standalone-policy"]);
});

test("deriveDataPatterns builds patterns from evidenceKeywords", () => {
  const measures = [{ measureId: "1.1", evidenceKeywords: ["responsible ai", "ai"] }] as MeasureLike[];
  const out = deriveDataPatterns(measures);
  // "ai" (2 chars) is skipped (<4), "responsible ai" becomes a spaced pattern
  assert.ok(out.includes("responsible.?ai"));
  assert.ok(!out.includes("ai"));
});

// ─── Scenario 1: complete framework passes ──────────────────────────────────

test("complete framework + complete measures => no missing", async () => {
  const { report, frameworkUpdates, measureUpdates } = await runCompletenessValidator({
    framework: completeFramework(),
    measures: [completeMeasure("1.1"), completeMeasure("1.2")],
    llmComplete: llmStub,
  });
  assert.equal(report.hasIncompleteness, false, JSON.stringify(report.missing));
  assert.equal(report.missing.length, 0);
  assert.equal(Object.keys(frameworkUpdates).length, 0);
  assert.equal(Object.keys(measureUpdates).length, 0);
});

// ─── Scenario 2: empty requiredDocTypes but measures carry requiredSourceTypes → DERIVED ─

test("empty requiredDocTypes is derived from measures (no LLM needed)", async () => {
  const fw = completeFramework();
  fw.requiredDocTypes = [];
  const { report, frameworkUpdates } = await runCompletenessValidator({
    framework: fw,
    measures: [completeMeasure("1.1"), completeMeasure("1.2")],
    llmComplete: llmDeclineStub, // even if LLM declines, derivation should win first
  });
  const rdt = report.results.find((r) => r.field === "requiredDocTypes");
  assert.equal(rdt?.status, "derived");
  assert.deepEqual((frameworkUpdates.requiredDocTypes as string[]).sort(), ["annual-report", "standalone-policy"]);
});

// ─── Scenario 3: genuinely empty field, no source, no reason, no LLM → MISSING ─

test("empty non-justifiable field with no LLM => MISSING with reason", async () => {
  const fw = completeFramework();
  fw.antiInferenceRules = []; // no deterministic derivation exists for this field
  const { report } = await runCompletenessValidator({
    framework: fw,
    measures: [completeMeasure("1.1")],
    // no llmComplete provided
  });
  const air = report.results.find((r) => r.field === "antiInferenceRules");
  assert.equal(air?.status, "missing");
  assert.ok(air?.reason && air.reason.length > 0);
  assert.equal(report.hasIncompleteness, true);
});

// ─── Scenario 4: invalid regex in documentPriorityUrlPatterns → FLAGGED ──────

test("invalid regex entries in documentPriorityUrlPatterns are flagged and dropped", async () => {
  const fw = completeFramework();
  fw.documentPriorityUrlPatterns = ["valid.?pattern", "[unterminated", "("];
  const { report, frameworkUpdates } = await runCompletenessValidator({
    framework: fw,
    measures: [completeMeasure("1.1")],
    llmComplete: llmStub,
  });
  const dpp = report.results.find((r) => r.field === "documentPriorityUrlPatterns");
  // one valid entry remains → status present, but plausibility flags recorded,
  // and the cleaned value (only the valid entry) is persisted.
  assert.equal(dpp?.status, "present");
  assert.ok(dpp?.plausibilityFlags && dpp.plausibilityFlags.some((f) => f.startsWith("invalid_regex")));
  assert.deepEqual(frameworkUpdates.documentPriorityUrlPatterns, ["valid.?pattern"]);
  assert.ok(report.plausibilityWarnings.length >= 1);
});

test("documentPriorityUrlPatterns all-invalid falls through to LLM fill", async () => {
  const fw = completeFramework();
  fw.documentPriorityUrlPatterns = ["[bad", "("];
  const { report, frameworkUpdates } = await runCompletenessValidator({
    framework: fw,
    measures: [completeMeasure("1.1")],
    llmComplete: llmStub,
  });
  const dpp = report.results.find((r) => r.field === "documentPriorityUrlPatterns");
  assert.equal(dpp?.status, "llm_filled");
  assert.deepEqual(frameworkUpdates.documentPriorityUrlPatterns, ["llm-authored-a", "llm-authored-b"]);
});

// ─── Scenario 5: justified-empty → ACCEPTED ─────────────────────────────────

test("justified-empty field is accepted, not missing", async () => {
  const fw = completeFramework();
  fw.authoritativeRegistries = []; // justifiable-empty field
  const { report } = await runCompletenessValidator({
    framework: fw,
    measures: [completeMeasure("1.1")],
    llmComplete: llmDeclineStub, // LLM declines so we reach the justified-empty branch
    justifiedEmpty: { authoritativeRegistries: "No statutory or thematic registry exists for this topic." },
  });
  const ar = report.results.find((r) => r.field === "authoritativeRegistries");
  assert.equal(ar?.status, "justified_empty");
  assert.equal(ar?.reason, "No statutory or thematic registry exists for this topic.");
  // justified-empty must NOT count as incompleteness
  assert.equal(report.missing.some((r) => r.field === "authoritativeRegistries"), false);
});

test("non-justifiable field cannot be excused by a justifiedEmpty reason", async () => {
  const fw = completeFramework();
  fw.requiredDocTypes = [];
  const { report } = await runCompletenessValidator({
    framework: fw,
    measures: [{ measureId: "1.1", ...completeMeasure("1.1"), requiredSourceTypes: [] }],
    // no LLM, and requiredDocTypes has no measure source to derive from
    justifiedEmpty: { requiredDocTypes: "trying to excuse a mandatory field" },
  });
  const rdt = report.results.find((r) => r.field === "requiredDocTypes");
  assert.equal(rdt?.status, "missing");
});

// ─── Scenario 6: measure-level LLM backfill returned in measureUpdates ───────

test("empty measure fields are LLM-filled and returned in measureUpdates", async () => {
  const m = completeMeasure("1.1");
  m.requiredSourceTypes = [];
  m.substantiveDefinition = "";
  const { report, measureUpdates } = await runCompletenessValidator({
    framework: completeFramework(),
    measures: [m],
    llmComplete: llmStub,
  });
  assert.ok(measureUpdates["1.1"]);
  assert.ok(measureUpdates["1.1"].substantiveDefinition);
  assert.ok(Array.isArray(measureUpdates["1.1"].requiredSourceTypes));
  const sd = report.results.find((r) => r.scope === "measure" && r.field === "substantiveDefinition");
  assert.equal(sd?.status, "llm_filled");
});

// ─── Scenario 7: missing scoringGuidance sub-field surfaced ──────────────────

test("missing scoringGuidance sub-field is reported as missing", async () => {
  const m = completeMeasure("1.1");
  const sg = JSON.parse(m.scoringGuidance as string);
  delete sg.yesRequiresQuote;
  m.scoringGuidance = JSON.stringify(sg);
  const { report } = await runCompletenessValidator({
    framework: completeFramework(),
    measures: [m],
    llmComplete: llmStub,
  });
  const yq = report.results.find((r) => r.field === "scoringGuidance.yesRequiresQuote");
  assert.equal(yq?.status, "missing");
  assert.equal(report.hasIncompleteness, true);
});

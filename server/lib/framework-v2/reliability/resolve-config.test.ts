/**
 * Focused unit tests for the canonical config resolver (Workstream 3).
 *
 * These cover the four resolver behaviours the reviewer called out, in isolation
 * from the export/import round-trip (which is covered by export-fidelity.test.ts):
 *   1. anchor parse-then-coerce (JSON-encoded vs plain, NO double-wrapping),
 *   2. scope-field carry-to-root with precedence,
 *   3. lexicon-surface separation (distinct surfaces never collapsed),
 *   4. stable-ID preservation (measureId kept, volatile ids stripped).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coerceAnchorEntry,
  resolveAnchorFrameworks,
  resolveScopeField,
  resolveMeasure,
  resolveConfig,
} from "./resolve-config.js";

// ---------------------------------------------------------------------------
// 1. Anchor parse-then-coerce
// ---------------------------------------------------------------------------

test("coerceAnchorEntry: plain label → {name, source:null}", () => {
  assert.deepEqual(coerceAnchorEntry("SASB"), { name: "SASB", source: null });
  assert.deepEqual(coerceAnchorEntry("  TCFD  "), { name: "TCFD", source: null });
});

test("coerceAnchorEntry: JSON-encoded object string is parsed, NOT double-wrapped", () => {
  const entry = '{"name":"EU AI Act","source":"European Commission"}';
  assert.deepEqual(coerceAnchorEntry(entry), {
    name: "EU AI Act",
    source: "European Commission",
  });
});

test("coerceAnchorEntry: JSON object string with no source → source null", () => {
  assert.deepEqual(coerceAnchorEntry('{"name":"NIST AI RMF"}'), {
    name: "NIST AI RMF",
    source: null,
  });
});

test("coerceAnchorEntry: already-typed anchor dict is used directly", () => {
  assert.deepEqual(coerceAnchorEntry({ name: "GRI", source: "GRI Standards" }), {
    name: "GRI",
    source: "GRI Standards",
  });
});

test("coerceAnchorEntry: a string that JSON-parses to a non-object stays a plain label", () => {
  // "TCFD" is not valid JSON → plain. But a numeric-looking or bracketed label
  // that parses to a non-object must keep the ORIGINAL string as the name.
  assert.deepEqual(coerceAnchorEntry("2050"), { name: "2050", source: null });
  assert.deepEqual(coerceAnchorEntry("[1,2,3]"), { name: "[1,2,3]", source: null });
});

test("coerceAnchorEntry: empty / null-ish entries → null", () => {
  assert.equal(coerceAnchorEntry(""), null);
  assert.equal(coerceAnchorEntry("   "), null);
  assert.equal(coerceAnchorEntry(null), null);
  assert.equal(coerceAnchorEntry(undefined), null);
  assert.equal(coerceAnchorEntry({ source: "x" }), null); // no name
});

test("resolveAnchorFrameworks: mixed root strings + nested typed dicts merge and dedupe", () => {
  const framework = {
    anchorFrameworks: [
      "SASB",
      '{"name":"EU AI Act","source":"European Commission"}',
      "TCFD",
    ],
    intakeArtefact: {
      anchorFrameworks: [
        { name: "EU AI Act", source: "European Commission" }, // duplicate of root
        { name: "UN Global Compact", source: "United Nations" }, // new
      ],
    },
  };
  const anchors = resolveAnchorFrameworks(framework);
  // Root order preserved, nested-only anchor appended, duplicate collapsed once.
  assert.deepEqual(anchors, [
    { name: "SASB", source: null },
    { name: "EU AI Act", source: "European Commission" },
    { name: "TCFD", source: null },
    { name: "UN Global Compact", source: "United Nations" },
  ]);
});

test("resolveAnchorFrameworks: a later non-null source upgrades an earlier null source without reordering", () => {
  const framework = {
    anchorFrameworks: ["EU AI Act"], // null source first
    intakeArtefact: {
      anchorFrameworks: [{ name: "EU AI Act", source: "European Commission" }],
    },
  };
  assert.deepEqual(resolveAnchorFrameworks(framework), [
    { name: "EU AI Act", source: "European Commission" },
  ]);
});

// ---------------------------------------------------------------------------
// 2. Scope-field carry-to-root with precedence
// ---------------------------------------------------------------------------

test("resolveScopeField: root value wins over measures and intake", () => {
  const framework = { entityType: "root value" };
  const measures = [{ entityType: "measure value" }];
  const intake = { entityType: "intake value" };
  assert.equal(
    resolveScopeField("entityType", framework, measures, intake),
    "root value",
  );
});

test("resolveScopeField: derives from measures when root null/absent", () => {
  const framework = { entityType: null };
  const measures = [{}, { entityType: "measure value" }];
  const intake = { entityType: "intake value" };
  assert.equal(
    resolveScopeField("entityType", framework, measures, intake),
    "measure value",
  );
});

test("resolveScopeField: falls back to intake when root and measures are empty", () => {
  const framework = {};
  const measures = [{}];
  const intake = { universe: "MSCI ACWI" };
  assert.equal(resolveScopeField("universe", framework, measures, intake), "MSCI ACWI");
});

test("resolveScopeField: returns null when nowhere populated", () => {
  assert.equal(resolveScopeField("sectorScope", {}, [{}], {}), null);
  assert.equal(resolveScopeField("sectorScope", {}, [], null), null);
});

test("resolveConfig: scope present only in intake is carried to the root", () => {
  const resolved = resolveConfig({
    framework: {
      name: "F",
      entityType: null,
      sectorScope: null,
      universe: null,
      reportingPeriod: null,
      intakeArtefact: {
        entityType: "Publicly-listed companies",
        sectorScope: "agnostic",
        universe: "MSCI ACWI",
        reportingPeriod: "last 3 years",
      },
    },
    measures: [],
  });
  assert.equal(resolved.entityType, "Publicly-listed companies");
  assert.equal(resolved.sectorScope, "agnostic");
  assert.equal(resolved.universe, "MSCI ACWI");
  assert.equal(resolved.reportingPeriod, "last 3 years");
});

// ---------------------------------------------------------------------------
// 3. Lexicon-surface separation
// ---------------------------------------------------------------------------

test("resolveConfig: the retrieval lexicon surfaces are kept DISTINCT, never merged", () => {
  const resolved = resolveConfig({
    framework: {
      name: "F",
      topicSynonyms: ["synonym-a", "synonym-b"],
      evidenceKeywords: ["evidence-a", "evidence-b"],
      requiredDocTypes: ["10-K", "proxy statement"],
      retrievalQueryTerms: ["query-a"],
      negativeKeywords: ["neg-a"],
      antiInferenceRules: ["rule-a"],
    },
    measures: [],
  });

  assert.deepEqual(resolved.topicSynonyms, ["synonym-a", "synonym-b"]);
  assert.deepEqual(resolved.evidenceKeywords, ["evidence-a", "evidence-b"]);
  assert.deepEqual(resolved.documentFilingHints, ["10-K", "proxy statement"]);
  assert.deepEqual(resolved.retrievalQueryTerms, ["query-a"]);
  assert.deepEqual(resolved.negativeKeywords, ["neg-a"]);
  assert.deepEqual(resolved.antiInferenceRules, ["rule-a"]);

  // No surface has bled into another.
  assert.equal(resolved.topicSynonyms.includes("evidence-a"), false);
  assert.equal(resolved.evidenceKeywords.includes("synonym-a"), false);
  assert.equal(resolved.documentFilingHints.includes("query-a"), false);
});

test("resolveConfig: documentFilingHints derives from requiredDocTypes / authoritativeFilingTypes when the primary field is absent", () => {
  const fromRequired = resolveConfig({
    framework: { name: "F", requiredDocTypes: ["10-K"] },
    measures: [],
  });
  assert.deepEqual(fromRequired.documentFilingHints, ["10-K"]);

  const fromAuthoritative = resolveConfig({
    framework: { name: "F", authoritativeFilingTypes: ["8-K"] },
    measures: [],
  });
  assert.deepEqual(fromAuthoritative.documentFilingHints, ["8-K"]);

  // The explicit documentFilingHints surface wins when present.
  const explicit = resolveConfig({
    framework: {
      name: "F",
      documentFilingHints: ["primary"],
      requiredDocTypes: ["fallback"],
    },
    measures: [],
  });
  assert.deepEqual(explicit.documentFilingHints, ["primary"]);
});

test("resolveConfig: framework-level evidenceKeywords is distinct from per-measure evidenceKeywords", () => {
  const resolved = resolveConfig({
    framework: { name: "F", evidenceKeywords: ["fw-level"] },
    measures: [
      { measureId: "M1", displayOrder: 1, evidenceKeywords: ["measure-level"] },
    ],
  });
  assert.deepEqual(resolved.evidenceKeywords, ["fw-level"]);
  assert.deepEqual(resolved.measures[0].evidenceKeywords, ["measure-level"]);
});

// ---------------------------------------------------------------------------
// 4. Stable-ID preservation
// ---------------------------------------------------------------------------

test("resolveMeasure: keeps the stable measureId and strips volatile DB-surrogate ids", () => {
  const m = resolveMeasure({
    id: 12345,
    frameworkId: 99,
    framework_id: 99,
    measureId: "M-STABLE",
    title: "T",
  });
  assert.equal(m.measureId, "M-STABLE");
  assert.equal("id" in m, false);
  assert.equal("frameworkId" in m, false);
  assert.equal("framework_id" in m, false);
});

test("resolveMeasure: measure_id (snake_case) is accepted as the stable id", () => {
  const m = resolveMeasure({ measure_id: "M-SNAKE" });
  assert.equal(m.measureId, "M-SNAKE");
});

test("resolveMeasure: normalises named surfaces from camelCase or snake_case input", () => {
  const camel = resolveMeasure({
    measureId: "M1",
    substantiveDefinition: "sd",
    fallbackYesCriterion: "fy",
    whatConstitutesEvidence: "wce",
    scoringGuidance: "sg",
  });
  assert.equal(camel.substantive_definition, "sd");
  assert.equal(camel.fallback_yes_criterion, "fy");
  assert.equal(camel.whatConstitutesEvidence, "wce");
  assert.equal(camel.scoringGuidance, "sg");

  const snake = resolveMeasure({
    measure_id: "M2",
    substantive_definition: "sd2",
    fallback_yes_criterion: "fy2",
    what_constitutes_evidence: "wce2",
    scoring_guidance: "sg2",
  });
  assert.equal(snake.substantive_definition, "sd2");
  assert.equal(snake.fallback_yes_criterion, "fy2");
  assert.equal(snake.whatConstitutesEvidence, "wce2");
  assert.equal(snake.scoringGuidance, "sg2");
});

test("resolveConfig: measures are ordered by displayOrder and volatile ids excluded across the set", () => {
  const resolved = resolveConfig({
    framework: { name: "F" },
    measures: [
      { id: 2, measureId: "B", displayOrder: 2 },
      { id: 1, measureId: "A", displayOrder: 1 },
    ],
  });
  assert.deepEqual(
    resolved.measures.map((m) => m.measureId),
    ["A", "B"],
  );
  for (const m of resolved.measures) assert.equal("id" in m, false);
});

/**
 * Round-trip tests for the deterministic framework export/import transforms.
 *
 * These guard the core promise of the Import Framework feature: a framework
 * serialized via buildFrameworkExport and re-created via buildFrameworkInserts
 * reproduces every persisted measure field EXACTLY, with no LLM in the loop.
 *
 * Run: npx tsx --test server/lib/framework-v2/import-framework.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFrameworkExport,
  buildFrameworkInserts,
  isFrameworkExportPayload,
  assertMeasureSetPreserved,
  PreserveMeasuresViolation,
  FRAMEWORK_EXPORT_MARKER,
  FRAMEWORK_EXPORT_VERSION,
} from "./import-framework.js";

// A representative persisted framework (as returned by storage.getFrameworkById).
const framework = {
  id: 42,
  workspaceId: 7,
  name: "AI Governance and Strategy",
  topicDescription: "Assessment of AI governance maturity",
  version: 3,
  isActive: true,
  isShared: false,
  builderVersion: "v2",
  topicTerm: "AI governance",
  topicSynonyms: ["AI oversight", "responsible AI"],
  searchTemplates: ["{company} AI governance policy"],
  antiInferenceRules: ["Do not infer from generic ESG language"],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  productionReady: true,
};

// Representative persisted measures (as returned by storage.getFrameworkMeasures).
const measures = [
  {
    id: 100,
    frameworkId: 42,
    measureId: "1.1",
    category: "Governance",
    categoryNumber: 1,
    title: "Board-level AI oversight",
    definition: "The board has explicit responsibility for AI risk.",
    scoringGuidance: "Yes if a named board committee owns AI risk.",
    evidenceKeywords: ["board", "committee", "AI risk"],
    requiredSourceTypes: ["annual-report"],
    displayOrder: 1,
    primaryAssessmentTarget: "board mandate",
    positiveExamples: ["The Board's Risk Committee oversees AI."],
    negativeExamples: ["We care about responsible AI."],
    expectedYesRate: 0.3,
    flaggedNonDiscriminating: false,
  },
  {
    id: 101,
    frameworkId: 42,
    measureId: "2.1",
    category: "Strategy",
    categoryNumber: 2,
    title: "AI strategy disclosure",
    definition: "A documented AI strategy exists.",
    scoringGuidance: "Yes if a written AI strategy is referenced.",
    evidenceKeywords: ["strategy", "roadmap"],
    requiredSourceTypes: null,
    displayOrder: 2,
    primaryAssessmentTarget: "strategy document",
    positiveExamples: [],
    negativeExamples: [],
    expectedYesRate: 0.5,
    flaggedNonDiscriminating: true,
  },
];

const MEASURE_FIELDS = [
  "measureId",
  "category",
  "categoryNumber",
  "title",
  "definition",
  "scoringGuidance",
  "evidenceKeywords",
  "requiredSourceTypes",
  "displayOrder",
  "primaryAssessmentTarget",
  "positiveExamples",
  "negativeExamples",
  "expectedYesRate",
  "flaggedNonDiscriminating",
] as const;

test("export payload carries the schema marker + version", () => {
  const payload = buildFrameworkExport(framework, measures);
  assert.equal((payload as any)[FRAMEWORK_EXPORT_MARKER], FRAMEWORK_EXPORT_VERSION);
  assert.ok(payload.framework);
  assert.equal(payload.measures.length, 2);
});

test("export strips identity/ownership/audit columns", () => {
  const payload = buildFrameworkExport(framework, measures);
  assert.equal((payload.framework as any).id, undefined);
  assert.equal((payload.framework as any).workspaceId, undefined);
  assert.equal((payload.framework as any).createdAt, undefined);
  assert.equal((payload.framework as any).updatedAt, undefined);
  for (const m of payload.measures) {
    assert.equal((m as any).id, undefined);
    assert.equal((m as any).frameworkId, undefined);
  }
});

test("round-trip recreates every measure field for field, in display order", () => {
  const payload = buildFrameworkExport(framework, measures);
  const { framework: fwInsert, measures: measureInserts } = buildFrameworkInserts(
    payload,
    99, // new workspace
    [],
  );

  // Framework: ownership reset to importing workspace, never auto-activated.
  assert.equal((fwInsert as any).workspaceId, 99);
  assert.equal((fwInsert as any).isActive, false);
  assert.equal(fwInsert.name, "AI Governance and Strategy");
  assert.equal((fwInsert as any).id, undefined);
  // Non-identity fields preserved.
  assert.equal((fwInsert as any).topicTerm, "AI governance");
  assert.deepEqual((fwInsert as any).topicSynonyms, ["AI oversight", "responsible AI"]);
  assert.equal((fwInsert as any).version, 3);

  // Measures: exact field preservation, original order.
  assert.equal(measureInserts.length, measures.length);
  measureInserts.forEach((mi, i) => {
    const original = measures[i];
    for (const field of MEASURE_FIELDS) {
      assert.deepEqual(
        (mi as any)[field],
        (original as any)[field],
        `measure ${i} field "${field}" must round-trip exactly`,
      );
    }
    // frameworkId is deliberately NOT set by the transform (caller assigns it).
    assert.equal((mi as any).frameworkId, undefined);
  });
});

test("import sorts by displayOrder even if the array is shuffled", () => {
  const shuffled = {
    [FRAMEWORK_EXPORT_MARKER]: FRAMEWORK_EXPORT_VERSION,
    framework: { name: "X" },
    measures: [
      { measureId: "b", displayOrder: 2, title: "second" },
      { measureId: "a", displayOrder: 1, title: "first" },
    ],
  };
  const { measures: out } = buildFrameworkInserts(shuffled as any, 1, []);
  assert.equal((out[0] as any).measureId, "a");
  assert.equal((out[1] as any).measureId, "b");
});

test('name gets " (imported)" only on collision', () => {
  const payload = buildFrameworkExport(framework, measures);
  const noCollision = buildFrameworkInserts(payload, 1, ["Other framework"]);
  assert.equal(noCollision.framework.name, "AI Governance and Strategy");

  const collision = buildFrameworkInserts(payload, 1, ["AI Governance and Strategy"]);
  assert.equal(collision.framework.name, "AI Governance and Strategy (imported)");
});

test("isFrameworkExportPayload tolerates a raw {framework, measures} object (no marker)", () => {
  assert.equal(isFrameworkExportPayload({ framework: {}, measures: [] }), true);
  assert.equal(isFrameworkExportPayload({ framework: { name: "x" }, measures: [{}] }), true);
});

test("isFrameworkExportPayload rejects unrecognizable bodies", () => {
  assert.equal(isFrameworkExportPayload(null), false);
  assert.equal(isFrameworkExportPayload({}), false);
  assert.equal(isFrameworkExportPayload({ framework: {} }), false); // no measures
  assert.equal(isFrameworkExportPayload({ measures: [] }), false); // no framework
  assert.equal(isFrameworkExportPayload({ framework: [], measures: [] }), false); // framework not object
  assert.equal(isFrameworkExportPayload("nope"), false);
});

// ── WS-C: keep-same-measures verbatim preservation ─────────────────────────────

test("keep-same-measures: titles, order and count are byte-identical after import", () => {
  const payload = buildFrameworkExport(framework, measures);
  const preserved = buildFrameworkInserts(payload, 1, [], { preserveMeasures: true });

  // Count identical.
  assert.equal(preserved.measures.length, measures.length);
  // Titles + order byte-identical (compared against the SOURCE order verbatim).
  const srcTitles = measures.map((m) => m.title);
  const outTitles = preserved.measures.map((m: any) => m.title);
  assert.deepEqual(outTitles, srcTitles, "titles preserved in exact source order");
});

test("keep-same-measures: ADDITIVE criteria hardening survives while the set is preserved", () => {
  // Harden a criterion field on the payload BEFORE import (additive: no title/order/count change).
  const payload = buildFrameworkExport(framework, measures);
  payload.measures[0].scoringGuidance =
    (payload.measures[0].scoringGuidance || "") +
    " Additionally require a named board committee AND a dated mandate in one bounded passage.";
  payload.measures[0].fallbackYesCriterion = "A dated board mandate referencing AI risk.";

  const preserved = buildFrameworkInserts(payload, 1, [], { preserveMeasures: true });

  // Set is preserved …
  assert.deepEqual(
    preserved.measures.map((m: any) => m.title),
    measures.map((m) => m.title),
  );
  assert.equal(preserved.measures.length, measures.length);
  // … and the additive hardening is carried through verbatim.
  assert.match((preserved.measures[0] as any).scoringGuidance, /bounded passage/);
  assert.equal((preserved.measures[0] as any).fallbackYesCriterion, "A dated board mandate referencing AI risk.");
});

test("keep-same-measures: preserves the EXACT payload order even when displayOrder disagrees", () => {
  // Payload order is [2.1, 1.1] but displayOrder values are [99, 1]. Non-preserve mode
  // would re-sort by displayOrder; preserve mode must keep the payload order verbatim.
  const payload = {
    framework: { name: "x" },
    measures: [
      { measureId: "2.1", title: "Second", displayOrder: 99 },
      { measureId: "1.1", title: "First", displayOrder: 1 },
    ],
  };
  const preserved = buildFrameworkInserts(payload as any, 1, [], { preserveMeasures: true });
  assert.deepEqual(preserved.measures.map((m: any) => m.title), ["Second", "First"]);
  // displayOrder is re-stamped to the preserved sequence.
  assert.deepEqual(preserved.measures.map((m: any) => m.displayOrder), [0, 1]);

  // Without preserveMeasures the legacy behaviour re-sorts by displayOrder.
  const resorted = buildFrameworkInserts(payload as any, 1, []);
  assert.deepEqual(resorted.measures.map((m: any) => m.title), ["First", "Second"]);
});

test("assertMeasureSetPreserved throws PreserveMeasuresViolation when count changes", () => {
  assert.throws(
    () => assertMeasureSetPreserved([{ title: "a" }, { title: "b" }], [{ title: "a" }]),
    (err: any) => err instanceof PreserveMeasuresViolation && /count changed/.test(err.message),
  );
});

test("assertMeasureSetPreserved throws PreserveMeasuresViolation when a title is reworded", () => {
  assert.throws(
    () => assertMeasureSetPreserved([{ title: "Board-level AI oversight" }], [{ title: "Board oversight of AI" }]),
    (err: any) => err instanceof PreserveMeasuresViolation && /title at position 0 changed/.test(err.message),
  );
});

test("assertMeasureSetPreserved throws PreserveMeasuresViolation when order changes", () => {
  assert.throws(
    () => assertMeasureSetPreserved([{ title: "a" }, { title: "b" }], [{ title: "b" }, { title: "a" }]),
    (err: any) => err instanceof PreserveMeasuresViolation,
  );
});

test("assertMeasureSetPreserved passes for an identical set (criteria differences ignored)", () => {
  assert.doesNotThrow(() =>
    assertMeasureSetPreserved(
      [{ title: "a", scoringGuidance: "old" }, { title: "b" }],
      [{ title: "a", scoringGuidance: "hardened" }, { title: "b" }],
    ),
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRobustness, type IntakeArtefact } from "./robustness-gate.js";

// Deliverable B (b): with BUILDER_SCOPE_FIELDS_INLINE ON (default), the four scope
// fields (entityType, sectorScope, universe, reportingPeriod) are surfaced as FOUR
// separate inline checklist items so the UX shows per-field contextual feedback,
// instead of one batched "all four set" item that hides which field is null.

function baseIntake(overrides: Partial<IntakeArtefact> = {}): IntakeArtefact {
  return {
    topicTerm: "test-topic",
    topicSynonyms: ["a", "b"],
    adjacentTopics: [
      { name: "x", example_phrases: ["p"] },
      { name: "y", example_phrases: ["q"] },
    ],
    anchorFrameworks: [{ name: "AF" }],
    sensitivityPreference: "balanced",
    subAreaStructure: { type: "custom", categories: ["c1", "c2", "c3"] },
    basePositiveExamples: ["p1", "p2"],
    baseNegativeExamples: ["n1", "n2"],
    pushbackRecord: [],
    ...overrides,
  };
}

function itemById(res: ReturnType<typeof evaluateRobustness>, id: string) {
  return res.items.find((i) => i.id === id);
}

test("(default ON) emits four separate inline scope items, not one batched entityScope", () => {
  const res = evaluateRobustness(baseIntake());
  assert.equal(itemById(res, "entityScope"), undefined, "batched item must be gone when inline is ON");
  for (const id of ["scope.entityType", "scope.sectorScope", "scope.universe", "scope.reportingPeriod"]) {
    assert.ok(itemById(res, id), `expected inline item ${id}`);
  }
});

test("each unset scope field fails independently with a contextual detail", () => {
  const res = evaluateRobustness(
    baseIntake({ entityType: "Listed issuer", sectorScope: undefined, universe: "Group-level", reportingPeriod: undefined }),
  );
  assert.equal(itemById(res, "scope.entityType")!.passed, true);
  assert.equal(itemById(res, "scope.universe")!.passed, true);
  const sector = itemById(res, "scope.sectorScope")!;
  const period = itemById(res, "scope.reportingPeriod")!;
  assert.equal(sector.passed, false);
  assert.equal(period.passed, false);
  assert.match(sector.detail || "", /not set/i);
  assert.match(period.detail || "", /not set/i);
});

test("all four scope fields set => all four inline items pass", () => {
  const res = evaluateRobustness(
    baseIntake({
      entityType: "Listed issuer / consolidated group",
      sectorScope: "All sectors (cross-sector)",
      universe: "Group-level disclosures only",
      reportingPeriod: "Last 3 fiscal years",
    }),
  );
  for (const id of ["scope.entityType", "scope.sectorScope", "scope.universe", "scope.reportingPeriod"]) {
    assert.equal(itemById(res, id)!.passed, true, `${id} should pass`);
  }
});

test("flag OFF restores the single batched entityScope item (backward compatible)", () => {
  const prev = process.env.BUILDER_SCOPE_FIELDS_INLINE;
  process.env.BUILDER_SCOPE_FIELDS_INLINE = "false";
  try {
    const res = evaluateRobustness(baseIntake({ entityType: "x", sectorScope: "y", universe: "z", reportingPeriod: "w" }));
    assert.ok(itemById(res, "entityScope"), "batched item must be present when inline is OFF");
    assert.equal(itemById(res, "scope.entityType"), undefined);
  } finally {
    if (prev === undefined) delete process.env.BUILDER_SCOPE_FIELDS_INLINE;
    else process.env.BUILDER_SCOPE_FIELDS_INLINE = prev;
  }
});

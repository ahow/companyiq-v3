import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDefinitionPresent, type FrameworkDraft } from "./rules.js";

// Issue 1 — `definition` presence guard (topic-agnostic, fail-loud).
//
// The drafting schema emits `substantive_definition`, and save derives the short
// `definition` from it. validateDefinitionPresent is the fail-loud backstop: it
// must ERROR only when a measure has NEITHER field, and must pass when either is
// present — regardless of framework topic.

function fw(measures: FrameworkDraft["measures"]): FrameworkDraft {
  return {
    name: "Test FW",
    topicTerm: "test-topic",
    measures,
  } as FrameworkDraft;
}

test("passes when substantive_definition is present but definition is absent (normal draft)", () => {
  const r = validateDefinitionPresent(
    fw([
      {
        measureId: "1.1",
        title: "Does the entity disclose a policy on X?",
        substantive_definition: "A rich authored definition of what counts as evidence for X.",
      } as any,
    ]),
  );
  assert.equal(r.passed, true);
  assert.equal(r.violations.filter((v) => v.severity === "error").length, 0);
});

test("passes when only the short definition is present", () => {
  const r = validateDefinitionPresent(
    fw([{ measureId: "1.1", title: "T", definition: "A short definition." } as any]),
  );
  assert.equal(r.passed, true);
});

test("ERRORS (fail-loud) when both definition and substantive_definition are empty", () => {
  const r = validateDefinitionPresent(
    fw([{ measureId: "1.1", title: "T", definition: "", substantive_definition: "" } as any]),
  );
  assert.equal(r.passed, false);
  const errs = r.violations.filter((v) => v.severity === "error");
  assert.equal(errs.length, 1);
  assert.equal(errs[0].rule, "DEF");
  assert.equal(errs[0].measureId, "1.1");
});

test("ERRORS when both fields are missing entirely (undefined)", () => {
  const r = validateDefinitionPresent(fw([{ measureId: "2.3", title: "T" } as any]));
  assert.equal(r.passed, false);
  assert.equal(r.violations[0].rule, "DEF");
});

test("whitespace-only definitions are treated as empty", () => {
  const r = validateDefinitionPresent(
    fw([{ measureId: "1.1", title: "T", definition: "   ", substantive_definition: "\n\t " } as any]),
  );
  assert.equal(r.passed, false);
});

test("topic-agnostic: flags per-measure, mixed valid/invalid across an arbitrary set", () => {
  const r = validateDefinitionPresent(
    fw([
      { measureId: "1.1", title: "A", substantive_definition: "ok" } as any,
      { measureId: "1.2", title: "B" } as any,
      { measureId: "1.3", title: "C", definition: "ok" } as any,
      { measureId: "1.4", title: "D", definition: "", substantive_definition: "" } as any,
    ]),
  );
  const errIds = r.violations.filter((v) => v.severity === "error").map((v) => v.measureId).sort();
  assert.deepEqual(errIds, ["1.2", "1.4"]);
});

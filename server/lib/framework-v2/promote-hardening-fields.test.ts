import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteHardeningFields, HARDENING_FIELDS } from "./promote-hardening-fields.js";

test("promotes hardening fields from intakeArtefact when top-level is empty/null", () => {
  const fw = {
    name: "AI Governance",
    negativeKeywords: null,
    antiInferenceRules: undefined,
    intakeArtefact: {
      negativeKeywords: ["chip vendor", "cloud contract"],
      antiInferenceRules: ["Rule A", "Rule B", "Rule C"],
    },
  };
  const { framework, changed, promoted } = promoteHardeningFields(fw);
  assert.equal(changed, true);
  assert.deepEqual(promoted.sort(), [...HARDENING_FIELDS].sort());
  assert.deepEqual(framework.negativeKeywords, ["chip vendor", "cloud contract"]);
  assert.deepEqual(framework.antiInferenceRules, ["Rule A", "Rule B", "Rule C"]);
  // input not mutated
  assert.equal(fw.negativeKeywords, null);
});

test("promotes from an explicit intake source, taking precedence over framework.intakeArtefact", () => {
  const fw = {
    negativeKeywords: [],
    intakeArtefact: { negativeKeywords: ["from-artefact"] },
  };
  const intake = { negativeKeywords: ["from-explicit"], antiInferenceRules: ["r1"] };
  const { framework, promoted } = promoteHardeningFields(fw, intake);
  assert.deepEqual(framework.negativeKeywords, ["from-explicit"]);
  assert.deepEqual((framework as any).antiInferenceRules, ["r1"]);
  assert.deepEqual(promoted.sort(), ["antiInferenceRules", "negativeKeywords"]);
});

test("NON-DESTRUCTIVE: never overwrites a populated top-level value", () => {
  const fw = {
    negativeKeywords: ["existing-1", "existing-2"],
    antiInferenceRules: ["existing rule"],
    intakeArtefact: {
      negativeKeywords: ["intake-a", "intake-b"],
      antiInferenceRules: ["intake rule"],
    },
  };
  const { framework, changed, promoted } = promoteHardeningFields(fw);
  assert.equal(changed, false);
  assert.deepEqual(promoted, []);
  assert.deepEqual(framework.negativeKeywords, ["existing-1", "existing-2"]);
  assert.deepEqual(framework.antiInferenceRules, ["existing rule"]);
});

test("mixed: promotes only the empty field, leaves the populated one alone", () => {
  const fw = {
    negativeKeywords: ["kept"],
    antiInferenceRules: [],
    intakeArtefact: {
      negativeKeywords: ["ignored"],
      antiInferenceRules: ["promoted rule"],
    },
  };
  const { framework, changed, promoted } = promoteHardeningFields(fw);
  assert.equal(changed, true);
  assert.deepEqual(promoted, ["antiInferenceRules"]);
  assert.deepEqual(framework.negativeKeywords, ["kept"]);
  assert.deepEqual(framework.antiInferenceRules, ["promoted rule"]);
});

test("IDEMPOTENT: a second call after promotion is a no-op", () => {
  const fw = {
    negativeKeywords: null,
    intakeArtefact: { negativeKeywords: ["x"], antiInferenceRules: ["y"] },
  };
  const first = promoteHardeningFields(fw);
  assert.equal(first.changed, true);
  const second = promoteHardeningFields(first.framework);
  assert.equal(second.changed, false);
  assert.deepEqual(second.framework.negativeKeywords, ["x"]);
  assert.deepEqual((second.framework as any).antiInferenceRules, ["y"]);
});

test("no intake source available → no change, no throw", () => {
  const fw = { negativeKeywords: null };
  const { changed, promoted, notes } = promoteHardeningFields(fw);
  assert.equal(changed, false);
  assert.deepEqual(promoted, []);
  assert.ok(notes.length > 0);
});

test("empty/non-array intake values are not promoted", () => {
  const fw = {
    negativeKeywords: null,
    antiInferenceRules: null,
    intakeArtefact: { negativeKeywords: [], antiInferenceRules: "not-an-array" },
  };
  const { changed } = promoteHardeningFields(fw);
  assert.equal(changed, false);
});

test("handles null/garbage framework input without throwing", () => {
  const r1 = promoteHardeningFields(null as any);
  assert.equal(r1.changed, false);
  const r2 = promoteHardeningFields("nope" as any);
  assert.equal(r2.changed, false);
});

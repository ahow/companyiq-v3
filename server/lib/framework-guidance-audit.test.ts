/**
 * Tests for the generic framework scoring_guidance audit (Change B).
 * node:test — run with:  npx tsx --test server/lib/framework-guidance-audit.test.ts
 *
 * Nothing here references a specific measure, company, or framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGuidance, auditFrameworkGuidance } from "./framework-guidance-audit.js";

test("plain prose scoring_guidance is flagged as non_json_prose", () => {
  const c = classifyGuidance("Award Yes when the company clearly discloses a policy.");
  assert.equal(c.ok, false);
  assert.equal(c.issue, "non_json_prose");
});

test("valid JSON object with expected buckets is OK", () => {
  const c = classifyGuidance(JSON.stringify({ yes: "...", no: "...", partial: "..." }));
  assert.equal(c.ok, true);
  assert.equal(c.issue, undefined);
});

test("JSON array is flagged as not_object", () => {
  const c = classifyGuidance(JSON.stringify(["yes", "no"]));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "not_object");
});

test("bare JSON string is flagged as not_object", () => {
  const c = classifyGuidance(JSON.stringify("just a string"));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "not_object");
});

test("JSON object without yes/no/partial keys is flagged as missing_expected_keys", () => {
  const c = classifyGuidance(JSON.stringify({ high: "...", low: "..." }));
  assert.equal(c.ok, false);
  assert.equal(c.issue, "missing_expected_keys");
});

test("null / empty guidance is not a defect", () => {
  assert.equal(classifyGuidance(null).ok, true);
  assert.equal(classifyGuidance(undefined).ok, true);
  assert.equal(classifyGuidance("").ok, true);
  assert.equal(classifyGuidance("   ").ok, true);
});

test("auditFrameworkGuidance returns one finding per defective measure only", () => {
  const findings = auditFrameworkGuidance([
    { measureId: "m1", title: "Good", scoringGuidance: JSON.stringify({ yes: "a", no: "b" }) },
    { measureId: "m2", title: "Prose", scoringGuidance: "Score Yes if disclosed." },
    { measureId: "m3", title: "Empty", scoringGuidance: null },
    { measureId: "m4", title: "Array", scoringGuidance: "[1,2,3]" },
  ]);
  const ids = findings.map((f) => f.measureId).sort();
  assert.deepEqual(ids, ["m2", "m4"]);
  const m2 = findings.find((f) => f.measureId === "m2");
  assert.equal(m2?.issue, "non_json_prose");
});

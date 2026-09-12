/**
 * Unit tests for resolveTargetCount / resolveTargetCountValue.
 *
 * Guards the drafter's size-routing against the intake LLM's inconsistent
 * `targetMeasureCount` formatting (integer, numeric string, range, label).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTargetCount, resolveTargetCountValue } from "./target-count.js";

test("integer passes through", () => {
  assert.equal(resolveTargetCountValue(25), 25);
});

test("float is rounded", () => {
  assert.equal(resolveTargetCountValue(24.6), 25);
});

test("zero / negative / non-finite → undefined", () => {
  assert.equal(resolveTargetCountValue(0), undefined);
  assert.equal(resolveTargetCountValue(-5), undefined);
  assert.equal(resolveTargetCountValue(NaN), undefined);
});

test("numeric string", () => {
  assert.equal(resolveTargetCountValue("25"), 25);
  assert.equal(resolveTargetCountValue("  30  "), 30);
});

test("hyphen range → upper bound", () => {
  assert.equal(resolveTargetCountValue("20-30"), 30);
});

test("en-dash range → upper bound", () => {
  assert.equal(resolveTargetCountValue("20–30"), 30);
});

test("range with spaces and word", () => {
  assert.equal(resolveTargetCountValue("35 – 50 measures"), 50);
});

test("label: balanced", () => {
  assert.equal(resolveTargetCountValue("balanced"), 30);
  assert.equal(resolveTargetCountValue("Balanced"), 30);
});

test("label: compact", () => {
  assert.equal(resolveTargetCountValue("Compact"), 18);
});

test("label: comprehensive with range prefers explicit range", () => {
  assert.equal(resolveTargetCountValue("Comprehensive (35-50)"), 50);
});

test("label: comprehensive alone", () => {
  assert.equal(resolveTargetCountValue("comprehensive"), 50);
});

test("custom with explicit number wins", () => {
  assert.equal(resolveTargetCountValue("Custom: 42"), 42);
});

test("unparseable / missing → undefined", () => {
  assert.equal(resolveTargetCountValue("lots"), undefined);
  assert.equal(resolveTargetCountValue(""), undefined);
  assert.equal(resolveTargetCountValue(null), undefined);
  assert.equal(resolveTargetCountValue(undefined), undefined);
  assert.equal(resolveTargetCountValue({}), undefined);
});

test("resolveTargetCount reads intake.targetMeasureCount", () => {
  assert.equal(resolveTargetCount({ targetMeasureCount: "20-30" }), 30);
  assert.equal(resolveTargetCount({ targetMeasureCount: 12 }), 12);
  assert.equal(resolveTargetCount({}), undefined);
  assert.equal(resolveTargetCount(null), undefined);
});

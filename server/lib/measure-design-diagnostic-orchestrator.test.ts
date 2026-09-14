/**
 * Tests for the PURE diagnostic orchestrator `buildDiagnosticReport` — the
 * shared engine both Framework Builder v2 trigger points delegate to (PRE-DRAFT
 * static analysis, and POST-TEST stored-result + multi-run analysis).
 *
 * node:test — run with:
 *   npx tsx --test server/lib/measure-design-diagnostic-orchestrator.test.ts
 *
 * All fixtures are generic — no specific measure, company, or framework id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnosticReport,
  type DiagnosticMeasure,
  type StoredCell,
} from "./measure-design-diagnostic.js";

// A measure that trips the static existence/strength conflation check.
const conflationMeasure: DiagnosticMeasure = {
  measureId: "a1",
  title: "Conflation measure",
  primaryAssessmentTarget: "Whether the company has a policy that is comprehensive and robust.",
  definition: "Assess if a disclosed policy exists and whether it is sufficiently detailed.",
};
const cleanMeasure: DiagnosticMeasure = {
  measureId: "a2",
  title: "Clean measure",
  substantiveDefinition: "A named board committee with a stated quarterly review cadence.",
  scoringGuidance: JSON.stringify({ yes: "named committee present", no: "absent" }),
};

test("PRE-DRAFT mode (runs=[]) yields pre-test findings and empty post/multi", () => {
  const report = buildDiagnosticReport({
    frameworkId: 0,
    frameworkName: "Draft FW",
    measures: [conflationMeasure, cleanMeasure],
    runs: [],
  });
  assert.equal(report.measuresAnalyzed, 2);
  assert.ok(report.preTest.length >= 1, "expected at least one pre-test finding");
  assert.equal(report.postTest.length, 0, "no post-test without runs");
  assert.equal(report.multiRun.length, 0, "no multi-run without runs");
  // The conflation measure should be flagged; the clean one should not.
  const flaggedIds = report.flaggedMeasures.map((f) => f.measureId);
  assert.ok(flaggedIds.includes("a1"));
  assert.ok(!flaggedIds.includes("a2"));
  assert.ok(typeof report.humanSummary === "string" && report.humanSummary.length > 0);
});

test("POST-TEST mode (1 run) computes post-test signals, still no multi-run", () => {
  const run: StoredCell[] = [
    { companyId: 1, measureId: "a1", verdict: "Yes", confidence: "Low", rationaleScoreInconsistent: true },
    { companyId: 2, measureId: "a1", verdict: "No", confidence: "High" },
    { companyId: 1, measureId: "a2", verdict: "Yes", confidence: "High" },
    { companyId: 2, measureId: "a2", verdict: "Yes", confidence: "High" },
  ];
  const report = buildDiagnosticReport({
    frameworkId: 5,
    frameworkName: "FW",
    measures: [conflationMeasure, cleanMeasure],
    runs: [run],
    batchIds: [42],
  });
  assert.ok(report.postTest.length >= 1, "post-test signals present");
  assert.equal(report.multiRun.length, 0, "single run → no flip comparison");
  assert.deepEqual(report.batchIds, [42]);
  const a1 = report.postTest.find((s) => s.measureId === "a1");
  assert.ok(a1, "signal for a1 exists");
  assert.equal(a1!.cellsAnalyzed, 2);
  // One of two a1 cells flagged inconsistent → 0.5 rate.
  assert.ok(Math.abs(a1!.rationaleInconsistentRate - 0.5) < 1e-9);
});

test("POST-TEST mode (2 runs) computes run-to-run flip rate", () => {
  const runA: StoredCell[] = [
    { companyId: 1, measureId: "a1", verdict: "Yes" },
    { companyId: 2, measureId: "a1", verdict: "No" },
  ];
  const runB: StoredCell[] = [
    { companyId: 1, measureId: "a1", verdict: "No" }, // flipped for company 1
    { companyId: 2, measureId: "a1", verdict: "No" }, // stable for company 2
  ];
  const report = buildDiagnosticReport({
    frameworkId: 7,
    frameworkName: "FW",
    measures: [conflationMeasure],
    runs: [runA, runB],
  });
  assert.equal(report.multiRun.length, 1);
  const mr = report.multiRun[0];
  assert.equal(mr.measureId, "a1");
  assert.equal(mr.companiesCompared, 2);
  assert.ok(Math.abs(mr.flipRate - 0.5) < 1e-9, "1 of 2 companies flipped");
});

test("empty runs (all zero-length) are treated as pre-test only", () => {
  const report = buildDiagnosticReport({
    frameworkId: 0,
    frameworkName: null,
    measures: [conflationMeasure],
    runs: [[], []],
  });
  assert.equal(report.postTest.length, 0);
  assert.equal(report.multiRun.length, 0);
});

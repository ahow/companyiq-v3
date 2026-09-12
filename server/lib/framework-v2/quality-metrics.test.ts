/**
 * Unit tests for the Tier-1 design-time quality metrics (quality-metrics.ts).
 *
 * Covers the exported pure statistical helpers with KNOWN expected values, the
 * near-duplication detector, and an end-to-end computeQualityMetrics run over a
 * small synthetic verdict matrix with ≥2 runs (to exercise reliability, ρ
 * shrinkage and the Q composite). These are DESIGN-time diagnostics only — live
 * scoring stays single-shot.
 *
 * Run with:
 *   npx tsx --test server/lib/framework-v2/quality-metrics.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  verdictToBinary,
  rawAgreement,
  cohensKappaBinary,
  pearson,
  spearman,
  gini,
  herfindahl,
  jaccard,
  pointBiserial,
  computeQualityMetrics,
  coherenceGateMetrics,
  Q_IMPORTANCE_WEIGHTS,
  type QualityMetricsInput,
} from "./quality-metrics.js";
import type { TestDriveCompanyResult, MultiRunIteration } from "./test-drive.js";

// Floating-point comparison helper.
function near(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ≈ ${expected}`);
}

// ─── verdictToBinary ───────────────────────────────────────────────────────

test("verdictToBinary: Yes = 1; No/Partial/Insufficient = 0", () => {
  assert.equal(verdictToBinary("Yes"), 1);
  assert.equal(verdictToBinary("No"), 0);
  assert.equal(verdictToBinary("Partial"), 0);
  assert.equal(verdictToBinary("Insufficient evidence"), 0);
  assert.equal(verdictToBinary("anything else"), 0);
});

// ─── rawAgreement ──────────────────────────────────────────────────────────

test("rawAgreement: identical vectors = 1, disjoint = 0, partial = fraction", () => {
  near(rawAgreement([1, 0, 1, 0], [1, 0, 1, 0]), 1);
  near(rawAgreement([1, 1, 1], [0, 0, 0]), 0);
  near(rawAgreement([1, 0, 1, 0], [1, 0, 0, 0]), 0.75);
  assert.equal(rawAgreement([], []), 0);
});

// ─── cohensKappaBinary ─────────────────────────────────────────────────────

test("cohensKappaBinary: perfect agreement on varied margins = 1", () => {
  near(cohensKappaBinary([1, 0, 1, 0], [1, 0, 1, 0]), 1);
});

test("cohensKappaBinary: degenerate pe=1 (both constant, agreeing) = 1", () => {
  // Both raters all-1 → pe = 1; perfectly agreeing → κ defined as 1 (no blow-up).
  near(cohensKappaBinary([1, 1, 1, 1], [1, 1, 1, 1]), 1);
});

test("cohensKappaBinary: degenerate pe=1 but disagreeing = 0", () => {
  // a all-1, b all-0 → pe = 1, po = 0 → κ defined as 0.
  near(cohensKappaBinary([1, 1, 1, 1], [0, 0, 0, 0]), 0);
});

test("cohensKappaBinary: chance-level agreement ≈ 0", () => {
  // a = [1,1,0,0], b = [1,0,1,0]: po = 0.5, pa1 = pb1 = 0.5, pe = 0.5 → κ = 0.
  near(cohensKappaBinary([1, 1, 0, 0], [1, 0, 1, 0]), 0);
});

// ─── pearson / spearman ────────────────────────────────────────────────────

test("pearson: perfect positive linear = 1, negative = -1", () => {
  near(pearson([1, 2, 3], [2, 4, 6]), 1);
  near(pearson([1, 2, 3], [6, 4, 2]), -1);
});

test("pearson: zero variance returns 0 (no NaN)", () => {
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0);
});

test("spearman: monotonic non-linear = 1", () => {
  near(spearman([1, 2, 3, 4], [1, 4, 9, 16]), 1);
});

test("pointBiserial equals pearson", () => {
  const item = [1, 0, 1, 0, 1];
  const total = [3, 1, 4, 0, 5];
  near(pointBiserial(item, total), pearson(item, total));
});

// ─── gini ──────────────────────────────────────────────────────────────────

test("gini: perfectly equal = 0", () => {
  near(gini([1, 1, 1, 1]), 0);
});

test("gini: maximally concentrated = (n-1)/n", () => {
  // One unit holds everything → Gini = 0.75 for n=4.
  near(gini([0, 0, 0, 10]), 0.75);
});

// ─── herfindahl ────────────────────────────────────────────────────────────

test("herfindahl: uniform 4-way = 0.25; fully concentrated = 1", () => {
  near(herfindahl([1, 1, 1, 1]), 0.25);
  near(herfindahl([10, 0, 0, 0]), 1);
  assert.equal(herfindahl([0, 0, 0]), 0);
});

// ─── jaccard ───────────────────────────────────────────────────────────────

test("jaccard: overlap, disjoint, and empty∩empty = 1", () => {
  near(jaccard(new Set(["a", "b"]), new Set(["b", "c"])), 1 / 3);
  near(jaccard(new Set(["a"]), new Set(["b"])), 0);
  near(jaccard(new Set<string>(), new Set<string>()), 1);
  near(jaccard(new Set(["x", "y"]), new Set(["x", "y"])), 1);
});

// ─── Fixtures for end-to-end ───────────────────────────────────────────────

function company(
  companyId: number,
  verdicts: Record<string, "Yes" | "No" | "Partial" | "Insufficient evidence">,
  quoteCount = 2,
): TestDriveCompanyResult {
  return {
    companyId,
    companyName: `Company ${companyId}`,
    measures: Object.entries(verdicts).map(([measureId, verdict]) => ({
      measureId,
      verdict,
      confidence: "Medium",
      quoteCount,
    })),
  };
}

function iterationFrom(iterationNumber: number, companies: TestDriveCompanyResult[]): MultiRunIteration {
  const perMeasure: MultiRunIteration["perMeasure"] = {};
  for (const c of companies) {
    for (const m of c.measures) {
      if (!perMeasure[m.measureId]) perMeasure[m.measureId] = { verdictsByCompany: {} };
      perMeasure[m.measureId].verdictsByCompany[String(c.companyId)] = m.verdict;
    }
  }
  return { iterationNumber, perMeasure };
}

// A near-duplicate pair (m1, m4) plus discriminating measures m2/m3.
const RESULTS: TestDriveCompanyResult[] = [
  company(1, { m1: "Yes", m2: "Yes", m3: "No", m4: "Yes" }),
  company(2, { m1: "Yes", m2: "No", m3: "No", m4: "Yes" }),
  company(3, { m1: "No", m2: "Yes", m3: "Yes", m4: "No" }),
  company(4, { m1: "No", m2: "No", m3: "Yes", m4: "No" }),
];

const METADATA = [
  { measureId: "m1", title: "Board oversight", pillar: "Governance", expected_yes_rate: 0.5 },
  { measureId: "m2", title: "Emissions target", pillar: "Environment", expected_yes_rate: 0.5 },
  { measureId: "m3", title: "Water policy", pillar: "Environment", expected_yes_rate: 0.5 },
  { measureId: "m4", title: "Board committee", pillar: "Governance", expected_yes_rate: 0.5 },
];

function makeInput(overrides: Partial<QualityMetricsInput> = {}): QualityMetricsInput {
  return {
    results: RESULTS,
    measureMetadata: METADATA,
    multiRun: [iterationFrom(1, RESULTS), iterationFrom(2, RESULTS)],
    ...overrides,
  };
}

// ─── near-duplicate detection ──────────────────────────────────────────────

test("nearDuplicatePairs: identical verdict vectors surface as a near-duplicate", () => {
  const report = computeQualityMetrics(makeInput());
  // m1 and m4 have identical verdict vectors across all companies → agreement 1.
  const pair = report.nearDuplicatePairs.find(
    (p) =>
      (p.measureIdA === "m1" && p.measureIdB === "m4") ||
      (p.measureIdA === "m4" && p.measureIdB === "m1"),
  );
  assert.ok(pair, "expected m1↔m4 to be flagged as near-duplicate");
  near(pair!.agreement, 1);
  assert.equal(pair!.n, 4);
  assert.equal(pair!.recommendation, "merge-or-differentiate");
});

// ─── computeQualityMetrics end-to-end ──────────────────────────────────────

test("computeQualityMetrics: reports actual N and run count (never hardcoded)", () => {
  const report = computeQualityMetrics(makeInput());
  assert.equal(report.n, 4);
  assert.equal(report.runs, 2);
  assert.equal(report.thresholdsAreDeferred, true);
});

test("computeQualityMetrics: per-indicator roll-up has one row per measure", () => {
  const report = computeQualityMetrics(makeInput());
  assert.equal(report.perIndicator.length, 4);
  const m1 = report.perIndicator.find((p) => p.measureId === "m1")!;
  // m1 = [Yes,Yes,No,No] → pass rate 0.5.
  near(m1.passRate, 0.5);
  // Stable across the two identical runs → cell stability 1, κ = 1.
  near(m1.cellStability!, 1);
  near(m1.kappa!, 1);
});

test("computeQualityMetrics: perfectly stable re-runs give reliability metrics", () => {
  const report = computeQualityMetrics(makeInput());
  // At least one reliability MAXIMISE metric should be computable (value != null)
  // when two identical runs are supplied.
  const computable = report.reliability.filter((m) => m.value != null);
  assert.ok(computable.length > 0, "expected computable reliability metrics with 2 runs");
});

test("computeQualityMetrics: Q composite present with three dimensions and weights summing to 1", () => {
  const report = computeQualityMetrics(makeInput());
  assert.equal(report.q.dimensions.length, 3);
  const weightSum = report.q.dimensions.reduce((s, d) => s + d.weight, 0);
  near(weightSum, 1, 1e-9);
  // Weights come from the pre-registered Q_IMPORTANCE_WEIGHTS block.
  const importanceSum =
    Q_IMPORTANCE_WEIGHTS.reliability +
    Q_IMPORTANCE_WEIGHTS.coherenceRedundancy +
    Q_IMPORTANCE_WEIGHTS.accuracy;
  near(importanceSum, 1, 1e-9);
  assert.ok("weightSensitivity" in report.q, "weight-sensitivity guard must be present");
});

test("computeQualityMetrics: single run degrades reliability gracefully (no crash, null values)", () => {
  const report = computeQualityMetrics(makeInput({ multiRun: [iterationFrom(1, RESULTS)] }));
  assert.equal(report.runs, 1);
  // Per-indicator cross-run stability is undefined with <2 runs.
  for (const p of report.perIndicator) {
    assert.equal(p.cellStability, null);
    assert.equal(p.kappa, null);
  }
});

test("computeQualityMetrics: empty multiRun still produces a report", () => {
  const report = computeQualityMetrics(makeInput({ multiRun: [] }));
  assert.equal(report.runs, 0);
  assert.equal(report.n, 4);
  assert.ok(Array.isArray(report.discrimination));
  assert.ok(Array.isArray(report.coverage));
});

// ─── coherenceGateMetrics helper ───────────────────────────────────────────

test("coherenceGateMetrics: returns GATE-role metrics for cross-pillar / KR-20 / balance", () => {
  const gates = coherenceGateMetrics(makeInput());
  assert.ok(Array.isArray(gates));
  for (const g of gates) {
    assert.equal(g.role, "GATE");
    assert.equal(typeof g.label, "string");
  }
});

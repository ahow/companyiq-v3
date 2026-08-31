/**
 * Framework Creation v2 — 6 Robustness Exit Criteria for the Auto-Iterate Loop.
 *
 * The Stage-1 improvement panel computes these criteria after every test-drive
 * scoring run. When ALL six pass, the framework is considered robust enough for
 * wider use and the auto-iterate loop exits. Otherwise, a proposed edit list
 * is generated and iteration N+1 begins.
 *
 * Criteria (user-approved 2026-08-31):
 *   1. Discrimination:            signal vs edge Yes-rate gap ≥ 25 percentage points
 *   2. No dead measures:          < 20% of measures fire 0 Yes across test-drive
 *   3. No universal measures:     < 10% of measures fire Yes on every company
 *   4. Calibration:               measures with expected_yes_rate ≥ 20% observed within 2× (up or down)
 *   5. No contamination cluster:  < 10% of Yes verdicts flagged adjacent-topic or R3.3-flipped
 *   6. Distribution shape:        ≥ 1 company scores ≥ 50% Yes AND ≥ 1 scores ≤ 15%
 *
 * These are calibrated for a 10-company test-drive with a stratified split of
 * signal (known discloser) and edge (peripheral) companies. If future users
 * change the sample size the thresholds should be recomputed.
 */

import type { TestDriveCompanyResult } from "./test-drive.js";

export interface RobustnessCriterion {
  id: string;
  label: string;
  passed: boolean;
  observed: string;   // human-readable observed value
  threshold: string;  // human-readable threshold
  detail: string;     // short explanation for the panel
}

export interface RobustnessResult {
  criteria: RobustnessCriterion[];
  allPassed: boolean;
  passedCount: number;
  totalCount: number;
}

export interface CompanyLabel {
  companyId: number;
  isKnownDiscloser: boolean; // "signal" if true, "edge" if false
}

export function computeRobustnessCriteria(
  results: TestDriveCompanyResult[],
  measureMetadata: Array<{ measureId: string; expected_yes_rate?: number }>,
  labels: CompanyLabel[],
): RobustnessResult {
  const criteria: RobustnessCriterion[] = [];
  const totalCompanies = results.length;
  const totalMeasures = measureMetadata.length;

  // Helper: get Yes rate for a set of companies
  const yesRateFor = (companyIds: Set<number>): number => {
    const subset = results.filter((r) => companyIds.has(r.companyId));
    if (subset.length === 0) return 0;
    let total = 0, yes = 0;
    for (const r of subset) {
      total += r.measures.length;
      yes += r.measures.filter((m) => m.verdict === "Yes").length;
    }
    return total > 0 ? yes / total : 0;
  };

  // ── Criterion 1: Discrimination (signal vs edge gap ≥ 25pp) ───────────
  const signalIds = new Set(labels.filter((l) => l.isKnownDiscloser).map((l) => l.companyId));
  const edgeIds = new Set(labels.filter((l) => !l.isKnownDiscloser).map((l) => l.companyId));
  const signalRate = yesRateFor(signalIds);
  const edgeRate = yesRateFor(edgeIds);
  const gap = signalRate - edgeRate;
  criteria.push({
    id: "discrimination",
    label: "Discrimination",
    passed: signalIds.size > 0 && edgeIds.size > 0 && gap >= 0.25,
    observed:
      signalIds.size === 0 || edgeIds.size === 0
        ? "insufficient signal/edge labels"
        : `signal ${(signalRate * 100).toFixed(0)}% vs edge ${(edgeRate * 100).toFixed(0)}% = ${(gap * 100).toFixed(0)}pp gap`,
    threshold: "≥ 25pp gap",
    detail:
      "The framework should score known disclosers materially higher than peripheral companies. A small gap means the measures are firing on noise rather than substantive disclosure.",
  });

  // ── Criterion 2: No dead measures (< 20% fire 0 Yes) ─────────────────
  let deadCount = 0;
  for (const meta of measureMetadata) {
    const yesCount = results.reduce(
      (n, r) => n + (r.measures.find((m) => m.measureId === meta.measureId)?.verdict === "Yes" ? 1 : 0),
      0,
    );
    if (yesCount === 0) deadCount++;
  }
  const deadPct = totalMeasures > 0 ? deadCount / totalMeasures : 0;
  criteria.push({
    id: "no-dead-measures",
    label: "No dead measures",
    passed: deadPct < 0.20,
    observed: `${deadCount}/${totalMeasures} = ${(deadPct * 100).toFixed(0)}%`,
    threshold: "< 20% of measures",
    detail:
      "Measures that never fire waste budget and often signal over-narrow criteria. A handful is expected (peripheral topics for peripheral companies), but many indicate the framework is mis-tuned.",
  });

  // ── Criterion 3: No universal measures (< 10% fire Yes on every company) ─
  let universalCount = 0;
  for (const meta of measureMetadata) {
    const yesCount = results.reduce(
      (n, r) => n + (r.measures.find((m) => m.measureId === meta.measureId)?.verdict === "Yes" ? 1 : 0),
      0,
    );
    if (yesCount === totalCompanies && totalCompanies > 0) universalCount++;
  }
  const universalPct = totalMeasures > 0 ? universalCount / totalMeasures : 0;
  criteria.push({
    id: "no-universal-measures",
    label: "No universal measures",
    passed: universalPct < 0.10,
    observed: `${universalCount}/${totalMeasures} = ${(universalPct * 100).toFixed(0)}%`,
    threshold: "< 10% of measures",
    detail:
      "Measures that fire on every company (including peripheral ones) are too broad. They match adjacent-topic noise and destroy signal-vs-edge discrimination.",
  });

  // ── Criterion 4: Calibration (within 2× of expected for expected ≥ 20%) ─
  let calibratedCount = 0, calibrationDenom = 0;
  for (const meta of measureMetadata) {
    const expected = meta.expected_yes_rate ?? 0.35;
    if (expected < 0.20) continue; // only calibrate on measures with material expectation
    calibrationDenom++;
    const yesCount = results.reduce(
      (n, r) => n + (r.measures.find((m) => m.measureId === meta.measureId)?.verdict === "Yes" ? 1 : 0),
      0,
    );
    const observed = totalCompanies > 0 ? yesCount / totalCompanies : 0;
    if (observed >= expected / 2 && observed <= expected * 2) calibratedCount++;
  }
  const calibratedPct = calibrationDenom > 0 ? calibratedCount / calibrationDenom : 1;
  criteria.push({
    id: "calibration",
    label: "Calibration",
    passed: calibratedPct >= 0.75,
    observed:
      calibrationDenom === 0
        ? "no measures with expected_yes_rate ≥ 20%"
        : `${calibratedCount}/${calibrationDenom} = ${(calibratedPct * 100).toFixed(0)}%`,
    threshold: "≥ 75% of measures within 2× of expected",
    detail:
      "Observed Yes rates should be broadly consistent with the framework author's expectations. Large deviations suggest either the measure is mis-phrased or the expected_yes_rate needs recalibrating.",
  });

  // ── Criterion 5: No contamination cluster (< 10% of Yes flagged) ─────
  let totalYes = 0, contaminatedYes = 0;
  for (const r of results) {
    for (const m of r.measures) {
      if (m.verdict === "Yes") {
        totalYes++;
        if ((m.adjacentTopicHits ?? 0) > 0 || m.r33Flipped) contaminatedYes++;
      }
    }
  }
  const contaminationPct = totalYes > 0 ? contaminatedYes / totalYes : 0;
  criteria.push({
    id: "no-contamination",
    label: "No contamination cluster",
    passed: contaminationPct < 0.10,
    observed: `${contaminatedYes}/${totalYes} = ${(contaminationPct * 100).toFixed(1)}%`,
    threshold: "< 10% of Yes verdicts flagged",
    detail:
      "Yes verdicts drawn from adjacent-topic sections or flipped by context expansion are unreliable signals. A high rate indicates measures are matching topic-adjacent noise.",
  });

  // ── Criterion 6: Distribution shape (≥1 company ≥50% AND ≥1 ≤15%) ────
  let hiCount = 0, loCount = 0;
  for (const r of results) {
    if (r.measures.length === 0) continue;
    const yesRate = r.measures.filter((m) => m.verdict === "Yes").length / r.measures.length;
    if (yesRate >= 0.50) hiCount++;
    if (yesRate <= 0.15) loCount++;
  }
  criteria.push({
    id: "distribution-shape",
    label: "Distribution shape",
    passed: hiCount >= 1 && loCount >= 1,
    observed: `${hiCount} company(ies) ≥ 50%, ${loCount} company(ies) ≤ 15%`,
    threshold: "≥ 1 company each at both ends",
    detail:
      "A well-calibrated framework separates leaders from laggards. Everyone scoring in the middle means the framework is not discriminating; everyone at the same extreme means the framework is uniformly too strict or too lenient.",
  });

  const passedCount = criteria.filter((c) => c.passed).length;
  return {
    criteria,
    allPassed: passedCount === criteria.length,
    passedCount,
    totalCount: criteria.length,
  };
}

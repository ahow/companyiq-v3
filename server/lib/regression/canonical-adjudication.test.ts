/**
 * WS4 — Canonical-rule adjudication harness.
 *
 * Loads the FROZEN adjudication set (`canonical-adjudication.json`), rebuilds THE
 * canonical rule (substantive-first precedence) from each case's own decision
 * fields, and evaluates the case's structured facts against it three-valued.
 *
 * ADJUDICATION HONESTY (see the JSON's own description):
 *   - Cases with expectedStatus "pass"/"fail" carry a reviewer-stated intended
 *     outcome; the harness asserts the evaluator reproduces it.
 *   - Cases with expectedStatus "pending-adjudication" carry NO agreed outcome and
 *     NO invented passage/facts. The harness SURFACES them, EXCLUDES them from the
 *     pass tally, and asserts they are never silently reported as green.
 *
 * This harness must NOT edit expected values to make itself pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCanonicalRule,
  evaluateCanonicalRule,
} from "../framework-v2/reliability/canonical-rule.js";
import type { StructuredRuleStatus, StructuredFacts } from "../framework-v2/reliability/schemas.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export type AdjudicationExpected = StructuredRuleStatus | "pending-adjudication";

export interface AdjudicationCase {
  caseId: string;
  measureId: string;
  polarity?: string;
  passage: string | null;
  measureContract: Record<string, unknown> | null;
  facts: StructuredFacts | null;
  expectedStatus: AdjudicationExpected;
  reason: string;
  source: string;
  signedOffBy?: string;
}

export interface AdjudicationOutcome {
  caseId: string;
  expectedStatus: AdjudicationExpected;
  actualStatus: StructuredRuleStatus | "pending-adjudication";
  matched: boolean;
  pending: boolean;
}

export interface AdjudicationReport {
  total: number;
  adjudicated: number;
  pending: number;
  passedAssertions: number;
  failedAssertions: number;
  outcomes: AdjudicationOutcome[];
}

export function loadAdjudicationSet(): AdjudicationCase[] {
  const raw = readFileSync(join(HERE, "canonical-adjudication.json"), "utf8");
  return JSON.parse(raw).cases as AdjudicationCase[];
}

/**
 * Run every case. Adjudicated cases are evaluated and compared to their
 * reviewer-stated outcome; pending cases are surfaced but NOT evaluated for a
 * green/pass — they are recorded as "pending-adjudication" so they can never be
 * mistaken for a passing control.
 */
export function runCanonicalAdjudication(cases: AdjudicationCase[]): AdjudicationReport {
  const outcomes: AdjudicationOutcome[] = [];
  let adjudicated = 0;
  let pending = 0;
  let passedAssertions = 0;
  let failedAssertions = 0;

  for (const c of cases) {
    if (c.expectedStatus === "pending-adjudication") {
      pending += 1;
      outcomes.push({
        caseId: c.caseId,
        expectedStatus: c.expectedStatus,
        actualStatus: "pending-adjudication",
        matched: true, // "matched" == honoured as pending; never counted as a green pass.
        pending: true,
      });
      continue;
    }
    adjudicated += 1;
    // An adjudicated case MUST supply the facts encoding the reviewer's reading.
    if (!c.facts) {
      failedAssertions += 1;
      outcomes.push({
        caseId: c.caseId,
        expectedStatus: c.expectedStatus,
        actualStatus: "unknown-review-required",
        matched: false,
        pending: false,
      });
      continue;
    }
    const rule = buildCanonicalRule({ measureId: c.measureId, ...(c.measureContract ?? {}) });
    const res = evaluateCanonicalRule(rule, c.facts);
    const matched = res.status === c.expectedStatus;
    if (matched) passedAssertions += 1;
    else failedAssertions += 1;
    outcomes.push({
      caseId: c.caseId,
      expectedStatus: c.expectedStatus,
      actualStatus: res.status,
      matched,
      pending: false,
    });
  }

  return {
    total: cases.length,
    adjudicated,
    pending,
    passedAssertions,
    failedAssertions,
    outcomes,
  };
}

export function formatAdjudicationReport(r: AdjudicationReport): string {
  const lines: string[] = [];
  lines.push(
    `canonical-adjudication: ${r.total} cases — ${r.adjudicated} adjudicated, ${r.pending} pending-adjudication (excluded from pass tally)`,
  );
  for (const o of r.outcomes) {
    const tag = o.pending
      ? "PENDING (surfaced, not scored)"
      : o.matched
        ? `OK    expected=${o.expectedStatus} actual=${o.actualStatus}`
        : `FAIL  expected=${o.expectedStatus} actual=${o.actualStatus}`;
    lines.push(`  - ${o.caseId}: ${tag}`);
  }
  return lines.join("\n");
}

test("canonical adjudication: reviewer-stated cases reproduce, pending cases stay pending", () => {
  const cases = loadAdjudicationSet();
  const report = runCanonicalAdjudication(cases);

  // Print the report so the harness output is captured verbatim.
  console.log(formatAdjudicationReport(report));

  // Every adjudicated (reviewer-signed) case must reproduce its intended outcome.
  const mismatches = report.outcomes.filter((o) => !o.pending && !o.matched);
  assert.equal(
    mismatches.length,
    0,
    `adjudicated cases must reproduce reviewer outcomes; mismatches: ${JSON.stringify(mismatches)}`,
  );

  // Pending cases must be surfaced and never reported as a passing/green control.
  for (const o of report.outcomes.filter((x) => x.pending)) {
    assert.equal(o.actualStatus, "pending-adjudication");
    assert.notEqual(o.actualStatus, "pass");
  }

  // At least the three reviewer-signed pass cases are present and adjudicated.
  assert.ok(report.adjudicated >= 3, "expected at least 3 reviewer-adjudicated cases");
  assert.ok(report.pending >= 1, "expected the frozen pending cases to be present");
});

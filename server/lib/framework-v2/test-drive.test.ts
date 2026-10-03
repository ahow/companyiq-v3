/**
 * Unit tests for the test-drive design-time detectors added in ITEM 2 & ITEM 3:
 *   - computeFlipStats + residual-instability flag (run-to-run verdict changes)
 *   - no-differentiation flag (measure gives every company the same verdict)
 *   - buildSparseCorpusFlag (data-sparse company surfacing)
 *
 * These are DESIGN-time diagnostics only — live scoring stays single-shot.
 * Run with:  npx tsx --test server/lib/framework-v2/test-drive.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyseTestDrive,
  computeFlipStats,
  buildSparseCorpusFlag,
  detectTerminologyGaps,
  isWordBoundary,
  type TestDriveCompanyResult,
  type MultiRunIteration,
} from "./test-drive.js";

// ─── Fixtures ────────────────────────────────────────────────────────────

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

function iteration(
  iterationNumber: number,
  perMeasure: Record<string, Record<string, string>>,
): MultiRunIteration {
  return {
    iterationNumber,
    perMeasure: Object.fromEntries(
      Object.entries(perMeasure).map(([mid, vbc]) => [mid, { verdictsByCompany: vbc }]),
    ),
  };
}

// ─── computeFlipStats ─────────────────────────────────────────────────────

test("computeFlipStats returns [] with fewer than 2 iterations", () => {
  assert.deepEqual(computeFlipStats([]), []);
  assert.deepEqual(computeFlipStats([iteration(1, { m1: { "1": "Yes" } })]), []);
});

test("computeFlipStats detects a company whose verdict flips across runs", () => {
  const multiRun = [
    iteration(1, { m1: { "1": "Yes", "2": "No" } }),
    iteration(2, { m1: { "1": "No", "2": "No" } }), // company 1 flipped Yes→No
  ];
  const stats = computeFlipStats(multiRun);
  const m1 = stats.find((s) => s.measureId === "m1")!;
  assert.equal(m1.runs, 2);
  assert.equal(m1.companiesCompared, 2);
  assert.equal(m1.flippedCount, 1);
  assert.equal(m1.flipRate, 0.5);
  assert.equal(m1.flippedCompanies[0].companyId, "1");
  assert.deepEqual(m1.flippedCompanies[0].verdicts, ["Yes", "No"]);
});

test("computeFlipStats reports zero flips for a perfectly stable measure", () => {
  const multiRun = [
    iteration(1, { m1: { "1": "Yes", "2": "No" } }),
    iteration(2, { m1: { "1": "Yes", "2": "No" } }),
    iteration(3, { m1: { "1": "Yes", "2": "No" } }),
  ];
  const m1 = computeFlipStats(multiRun).find((s) => s.measureId === "m1")!;
  assert.equal(m1.runs, 3);
  assert.equal(m1.flippedCount, 0);
  assert.equal(m1.flipRate, 0);
});

// ─── residual-instability flag ────────────────────────────────────────────

test("analyseTestDrive emits residual-instability when a measure flips run-to-run", () => {
  const results = [
    company(1, { m1: "Yes", m2: "Yes" }),
    company(2, { m1: "No", m2: "No" }),
    company(3, { m1: "Partial", m2: "No" }),
  ];
  const meta = [{ measureId: "m1" }, { measureId: "m2" }];
  const multiRun = [
    iteration(1, { m1: { "1": "Yes", "2": "No", "3": "Partial" }, m2: { "1": "Yes", "2": "No", "3": "No" } }),
    iteration(2, { m1: { "1": "No", "2": "No", "3": "Partial" }, m2: { "1": "Yes", "2": "No", "3": "No" } }),
  ];
  const report = analyseTestDrive(results, meta, multiRun);
  const flag = report.flags.find((f) => f.rule === "residual-instability" && f.measureId === "m1");
  assert.ok(flag, "expected residual-instability flag on m1");
  assert.ok((flag!.flipRate ?? 0) > 0);
  assert.match(flag!.suggestedFix, /countable/i);
  // m2 was perfectly stable → no residual-instability flag
  assert.ok(!report.flags.some((f) => f.rule === "residual-instability" && f.measureId === "m2"));
});

test("residual-instability is error severity when flip rate >= 30%", () => {
  const results = [company(1, { m1: "Yes" }), company(2, { m1: "No" }), company(3, { m1: "Yes" })];
  const meta = [{ measureId: "m1" }];
  const multiRun = [
    iteration(1, { m1: { "1": "Yes", "2": "No", "3": "Yes" } }),
    iteration(2, { m1: { "1": "No", "2": "Yes", "3": "No" } }), // all 3 flip → 100%
  ];
  const flag = analyseTestDrive(results, meta, multiRun).flags.find((f) => f.rule === "residual-instability")!;
  assert.equal(flag.severity, "error");
});

test("analyseTestDrive with no multiRun emits no residual-instability flags (backward compatible)", () => {
  const results = [company(1, { m1: "Yes" }), company(2, { m1: "No" }), company(3, { m1: "Partial" })];
  const report = analyseTestDrive(results, [{ measureId: "m1" }]);
  assert.ok(!report.flags.some((f) => f.rule === "residual-instability"));
});

// ─── no-differentiation flag (ITEM 3) ─────────────────────────────────────

test("analyseTestDrive flags a measure that returns the same verdict for every company", () => {
  const results = [
    company(1, { m1: "Yes", m2: "Yes" }),
    company(2, { m1: "Yes", m2: "No" }),
    company(3, { m1: "Yes", m2: "Partial" }),
  ];
  const report = analyseTestDrive(results, [{ measureId: "m1" }, { measureId: "m2" }]);
  const flag = report.flags.find((f) => f.rule === "no-differentiation" && f.measureId === "m1");
  assert.ok(flag, "expected no-differentiation flag on all-Yes m1");
  assert.equal(flag!.severity, "error");
  // m2 varies → not flagged for no-differentiation
  assert.ok(!report.flags.some((f) => f.rule === "no-differentiation" && f.measureId === "m2"));
});

test("no-differentiation fires for uniform all-No and needs >= min companies", () => {
  const allNo = [company(1, { m1: "No" }), company(2, { m1: "No" }), company(3, { m1: "No" })];
  assert.ok(
    analyseTestDrive(allNo, [{ measureId: "m1" }]).flags.some((f) => f.rule === "no-differentiation"),
  );
  // With only 2 companies (below NO_DIFFERENTIATION_MIN_COMPANIES=3) it must NOT fire.
  const twoOnly = [company(1, { m1: "No" }), company(2, { m1: "No" })];
  assert.ok(
    !analyseTestDrive(twoOnly, [{ measureId: "m1" }]).flags.some((f) => f.rule === "no-differentiation"),
  );
});

// ─── buildSparseCorpusFlag (ITEM 3) ───────────────────────────────────────

test("buildSparseCorpusFlag returns null when nothing is sparse", () => {
  assert.equal(buildSparseCorpusFlag([]), null);
});

test("buildSparseCorpusFlag surfaces sparse companies as an actionable warning", () => {
  const flag = buildSparseCorpusFlag([
    { companyId: 1, companyName: "Acme", classification: "doc-collection-failure" },
    { companyId: 2, companyName: "Beta", classification: "doc-collection-failure" },
  ]);
  assert.ok(flag);
  assert.equal(flag!.rule, "sparse-corpus");
  assert.equal(flag!.severity, "warning");
  assert.match(flag!.message, /Acme/);
  assert.match(flag!.suggestedFix, /corpus/i);
});

// ─── detectTerminologyGaps: word-boundary discipline (synonym-miner fix) ────
// Root cause fixed: a boundary-unsafe `indexOf` matched short known terms
// ("ai", "ml", "llm", "agi") INSIDE ordinary words (chAIrman, mAIntain,
// avAILable), harvesting proxy-statement boilerplate into the synonym list.
// These tests pin the generalised (topic-agnostic) behaviour.

test("isWordBoundary treats letters/digits as word chars and edges as boundaries", () => {
  // "xaiy": index 0..3. 'ai' sits at idx 1. Char before (x) and after (y) are word chars.
  const s = "xaiy";
  assert.equal(isWordBoundary(s, -1), true); // before start
  assert.equal(isWordBoundary(s, s.length), true); // past end
  assert.equal(isWordBoundary(s, 0), false); // 'x'
  assert.equal(isWordBoundary(s, 3), false); // 'y'
  assert.equal(isWordBoundary(" ai ", 0), true); // space
});

test("detectTerminologyGaps does NOT harvest boilerplate around embedded false hits", () => {
  // "ai" is embedded in chairman / maintain / available — never a standalone word.
  // The surrounding proxy-statement boilerplate must NOT become synonym candidates.
  const boiler =
    "the chairman will maintain available records for the annual meeting of the executive officer and the table of contents herein";
  const corpus = new Map<string, string>([
    ["Acme", boiler],
    ["Beta", boiler],
  ]);
  const result = detectTerminologyGaps(corpus, [], "ai");
  const terms = result.missingTerms.map((m) => m.term);
  // None of the classic boilerplate artefacts should appear.
  for (const junk of ["annual meeting", "executive officer", "table contents", "maintain available"]) {
    assert.ok(!terms.includes(junk), `boilerplate "${junk}" should not be harvested, got: ${terms.join(", ")}`);
  }
});

test("detectTerminologyGaps still harvests genuine phrases next to a standalone known term", () => {
  // Here "ai" appears as a real standalone word, with a genuine topic phrase next to it.
  const text =
    "our ai governance board oversees ai governance board decisions across the firm";
  const corpus = new Map<string, string>([
    ["Acme", text],
    ["Beta", text],
  ]);
  const result = detectTerminologyGaps(corpus, [], "ai");
  const terms = result.missingTerms.map((m) => m.term);
  // A real multi-word phrase adjacent to the standalone "ai" should surface.
  assert.ok(
    terms.some((t) => t.includes("governance")),
    `expected a genuine 'governance' phrase, got: ${terms.join(", ")}`,
  );
});

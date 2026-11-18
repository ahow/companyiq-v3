// scoring-fixes.test.ts — DB-free unit tests for the 2026-11-17 scoring-integrity
// remediation pure functions (SCORING_FIXES_PLAN_20261117.md):
//   RC2  computeSourcingCoverage        — coverage suspect from per-measure sourcing
//   RC3  reconcileOneQuotePerMeasure    — one supporting quote backs one measure
//   RC7  shouldReuseCorpusForRerun      — layer-1 corpus-reuse decision
//   RC7  aggregateCrossRunMajority      — layer-2 ≥2/3 cross-run agreement
//
// Run with:  DATABASE_URL=postgres://x npx tsx --test server/lib/scoring-fixes.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSourcingCoverage,
  reconcileOneQuotePerMeasure,
  aggregateCrossRunMajority,
  type MeasureResult,
} from "./analyzer.js";
import { shouldReuseCorpusForRerun } from "./scoring-fix-flags.js";

// Minimal MeasureResult factory — only the fields the pure functions read.
function mr(partial: Partial<MeasureResult> & { measureId: string }): MeasureResult {
  return {
    measureId: partial.measureId,
    title: partial.title ?? partial.measureId,
    definition: null,
    category: "cat",
    categoryNumber: 1,
    score: partial.score ?? 0,
    coverage: null,
    confidence: "high",
    evidenceSummary: "",
    quotes: partial.quotes ?? [],
    verdict: partial.verdict ?? "No",
    verdictNuance: partial.verdictNuance ?? null,
    displayOrder: 0,
    abstained: partial.abstained,
    passageDiagnostics: partial.passageDiagnostics,
  } as MeasureResult;
}

const liveQuote = (text: string) => ({ text, source: "Acme Annual Report", sourceUrl: "https://acme-bev.com/ar" });

// ─── RC2 — computeSourcingCoverage ───────────────────────────────────────────
test("RC2: coverage is suspect when the sourced ratio falls below the threshold", () => {
  // 5 answered measures, only 3 sourced → ratio 0.6 < 0.8 threshold → suspect.
  const measures = [
    mr({ measureId: "m1", quotes: [liveQuote("We completed a double materiality assessment this year, publicly.")] }),
    mr({ measureId: "m2", quotes: [liveQuote("Our board oversees climate-related risks under a formal charter adopted.")] }),
    mr({ measureId: "m3", quotes: [liveQuote("We disclose Scope 1 and Scope 2 emissions in our sustainability report.")] }),
    mr({ measureId: "m4", quotes: [] }),
    mr({ measureId: "m5", quotes: [] }),
  ];
  const out = computeSourcingCoverage(measures, 0.8);
  assert.equal(out.answeredMeasureCount, 5);
  assert.equal(out.sourcedMeasureCount, 3);
  assert.equal(out.unsourcedMeasureCount, 2);
  assert.ok(Math.abs(out.sourcedMeasureRatio - 0.6) < 1e-9);
  assert.equal(out.suspect, true);
});

test("RC2: coverage is NOT suspect once the sourced ratio reaches the threshold", () => {
  // 5 answered, 4 sourced → ratio 0.8 == threshold → not suspect.
  const measures = [
    mr({ measureId: "m1", quotes: [liveQuote("We completed a double materiality assessment this year, publicly.")] }),
    mr({ measureId: "m2", quotes: [liveQuote("Our board oversees climate-related risks under a formal charter adopted.")] }),
    mr({ measureId: "m3", quotes: [liveQuote("We disclose Scope 1 and Scope 2 emissions in our sustainability report.")] }),
    mr({ measureId: "m4", quotes: [liveQuote("We published a human-rights policy covering our operations and supply chain.")] }),
    mr({ measureId: "m5", quotes: [] }),
  ];
  const out = computeSourcingCoverage(measures, 0.8);
  assert.equal(out.sourcedMeasureCount, 4);
  assert.ok(Math.abs(out.sourcedMeasureRatio - 0.8) < 1e-9);
  assert.equal(out.suspect, false);
});

test("RC2: abstained measures are excluded from the denominator; zero answered is not suspect", () => {
  const measures = [
    mr({ measureId: "m1", abstained: true, quotes: [] }),
    mr({ measureId: "m2", abstained: true, quotes: [] }),
  ];
  const out = computeSourcingCoverage(measures, 0.8);
  assert.equal(out.answeredMeasureCount, 0);
  assert.equal(out.suspect, false);
  assert.equal(out.sourcedMeasureRatio, 1);
});

test("RC2: a disqualified quote does not count as an eligible source", () => {
  const measures = [
    mr({ measureId: "m1", quotes: [{ ...liveQuote("A reused quote that was disqualified during reconciliation here."), disqualified: true }] }),
  ];
  const out = computeSourcingCoverage(measures, 0.8);
  assert.equal(out.sourcedMeasureCount, 0);
  assert.equal(out.suspect, true);
});

// ─── RC3 — reconcileOneQuotePerMeasure ───────────────────────────────────────
test("RC3: one quote backing three Yes measures is kept on the best-fit measure; the other two are demoted", () => {
  const shared = "Our board of directors maintains formal oversight of climate-related risks and opportunities across the group.";
  const results = [
    mr({ measureId: "m1", verdict: "Yes", score: 1, quotes: [liveQuote(shared)],
        passageDiagnostics: { topChunks: [{ docUrl: null, docTitle: null, seqInDoc: null, score: 0.4, textPreview: "", forced: false }], docBreakdown: [], queryTermCount: 1 } }),
    mr({ measureId: "m2", verdict: "Yes", score: 1, quotes: [liveQuote(shared)],
        passageDiagnostics: { topChunks: [{ docUrl: null, docTitle: null, seqInDoc: null, score: 0.9, textPreview: "", forced: false }], docBreakdown: [], queryTermCount: 1 } }),
    mr({ measureId: "m3", verdict: "Yes", score: 1, quotes: [liveQuote(shared)],
        passageDiagnostics: { topChunks: [{ docUrl: null, docTitle: null, seqInDoc: null, score: 0.2, textPreview: "", forced: false }], docBreakdown: [], queryTermCount: 1 } }),
  ];
  const outcome = reconcileOneQuotePerMeasure(results, "Acme");
  // m2 has the highest relevance (0.9) → it keeps the quote and stays Yes.
  assert.equal(results.find((r) => r.measureId === "m2")!.verdict, "Yes");
  assert.equal(results.find((r) => r.measureId === "m2")!.quotes[0].disqualified ?? false, false);
  // m1 and m3 lose their only quote → demoted to No (score 0).
  assert.equal(results.find((r) => r.measureId === "m1")!.verdict, "No");
  assert.equal(results.find((r) => r.measureId === "m1")!.score, 0);
  assert.equal(results.find((r) => r.measureId === "m3")!.verdict, "No");
  assert.equal(outcome.reassignments, 2);
  assert.equal(outcome.demotions, 2);
});

test("RC3: a Yes measure with its own distinct quote is untouched", () => {
  const results = [
    mr({ measureId: "m1", verdict: "Yes", score: 1, quotes: [liveQuote("Our board maintains formal oversight of climate-related risks across the group.")] }),
    mr({ measureId: "m2", verdict: "Yes", score: 1, quotes: [liveQuote("We disclose Scope 1, Scope 2 and Scope 3 emissions in our annual sustainability report.")] }),
  ];
  const outcome = reconcileOneQuotePerMeasure(results, "Acme");
  assert.equal(outcome.reassignments, 0);
  assert.equal(outcome.demotions, 0);
  assert.equal(results[0].verdict, "Yes");
  assert.equal(results[1].verdict, "Yes");
});

// ─── RC7 layer 1 — shouldReuseCorpusForRerun ─────────────────────────────────
test("RC7-L1: reuse decision truth table", () => {
  const base = { reuseEnabled: true, hasFrozenCorpus: true, alreadySkippingDiscovery: false, forceRefresh: false, recheck: false };
  // Re-run of an already-researched company with reuse ON → reuse.
  assert.equal(shouldReuseCorpusForRerun({ ...base }), true);
  // Genuine first analysis (no frozen corpus) → discover normally.
  assert.equal(shouldReuseCorpusForRerun({ ...base, hasFrozenCorpus: false }), false);
  // Operator forces a refresh → re-discover.
  assert.equal(shouldReuseCorpusForRerun({ ...base, forceRefresh: true }), false);
  assert.equal(shouldReuseCorpusForRerun({ ...base, recheck: true }), false);
  // Feature disabled → discover normally.
  assert.equal(shouldReuseCorpusForRerun({ ...base, reuseEnabled: false }), false);
  // Already skipping discovery (retry resume) → stays skipped regardless.
  assert.equal(shouldReuseCorpusForRerun({ ...base, alreadySkippingDiscovery: true, reuseEnabled: false, hasFrozenCorpus: false }), true);
});

// ─── RC7 layer 2 — aggregateCrossRunMajority ─────────────────────────────────
test("RC7-L2: a measure scores Yes only at ≥2/3 cross-run agreement", () => {
  const runA = [mr({ measureId: "m1", verdict: "Yes", score: 1, quotes: [liveQuote("We did X across the group this year, publicly disclosed.")] }), mr({ measureId: "m2", verdict: "Yes", score: 1 })];
  const runB = [mr({ measureId: "m1", verdict: "Yes", score: 1, quotes: [liveQuote("We did X across the group this year, publicly disclosed.")] }), mr({ measureId: "m2", verdict: "No", score: 0 })];
  const runC = [mr({ measureId: "m1", verdict: "No", score: 0 }), mr({ measureId: "m2", verdict: "No", score: 0 })];

  const out = aggregateCrossRunMajority([runA, runB, runC]);
  assert.equal(out.runCount, 3);
  assert.equal(out.requiredAgreement, 2);
  // m1: Yes in 2/3 runs → stays Yes.
  const m1 = out.results.find((r) => r.measureId === "m1")!;
  assert.equal(m1.verdict, "Yes");
  assert.equal(m1.score, 1);
  // m2: Yes in only 1/3 runs → demoted to No (score 0).
  const m2 = out.results.find((r) => r.measureId === "m2")!;
  assert.equal(m2.verdict, "No");
  assert.equal(m2.score, 0);
  assert.deepEqual(out.agreedYesMeasureIds, ["m1"]);
  assert.deepEqual(out.demotedMeasureIds, ["m2"]);
});

test("RC7-L2: unanimous Yes stays Yes; unanimous No stays No", () => {
  const run = (v: "Yes" | "No") => [mr({ measureId: "m1", verdict: v, score: v === "Yes" ? 1 : 0, quotes: v === "Yes" ? [liveQuote("We did X across the group this year, publicly disclosed.")] : [] })];
  const yes = aggregateCrossRunMajority([run("Yes"), run("Yes"), run("Yes")]);
  assert.equal(yes.results[0].verdict, "Yes");
  const no = aggregateCrossRunMajority([run("No"), run("No"), run("No")]);
  assert.equal(no.results[0].verdict, "No");
  assert.equal(no.demotedMeasureIds.length, 0); // nothing was Yes to demote
});

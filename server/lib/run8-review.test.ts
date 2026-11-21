import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidePhysicalHazardGate,
  matchesPhysicalHazardTrack,
  evidenceHasPhysicalHazardTerm,
  withSelfConsistencyVoteInTrace,
  readSelfConsistencyVoteFromTrace,
  quoteTokenOverlap,
} from "./scoring-fix-flags.js";
import { QuoteLedger } from "./retrieval-funnel.js";
import { classifiedCoverageComprehensive } from "../../shared/research-state.js";

// ── CHANGE 5 — SCORING_PHYSICAL_HAZARD_TERM_REQUIRED ─────────────────────────
test("decidePhysicalHazardGate: flag off never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: false, isPhysicalTrack: true, verdict: "Yes", evidenceText: "climate-related disclosures" });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "flag-off");
});

test("decidePhysicalHazardGate: non-physical track never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: false, verdict: "Yes", evidenceText: "flood risk" });
  assert.equal(r.downgrade, false);
});

test("decidePhysicalHazardGate: non-Yes verdict never downgrades", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "No", evidenceText: "nothing" });
  assert.equal(r.downgrade, false);
});

test("decidePhysicalHazardGate: Yes with a concrete hazard term stays", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "Yes", evidenceText: "The company assessed flood and heatwave exposure." });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "physical-hazard-term-present");
});

test("decidePhysicalHazardGate: Yes with only 'climate-related' is downgraded", () => {
  const r = decidePhysicalHazardGate({ flagOn: true, isPhysicalTrack: true, verdict: "Yes", evidenceText: "We discuss climate-related matters generally." });
  assert.equal(r.downgrade, true);
  assert.equal(r.reason, "physical-hazard-term-missing");
});

test("matchesPhysicalHazardTrack / evidenceHasPhysicalHazardTerm basics", () => {
  assert.equal(matchesPhysicalHazardTrack(["physical_climate", null]), true);
  assert.equal(matchesPhysicalHazardTrack(["governance", undefined]), false);
  assert.equal(evidenceHasPhysicalHazardTerm("exposure to drought and wildfire"), true);
  assert.equal(evidenceHasPhysicalHazardTerm("climate-related only"), false);
});

// ── CHANGE 6 — vote persisted in decision_trace jsonb ────────────────────────
test("withSelfConsistencyVoteInTrace: flag off is a no-op", () => {
  const trace = { a: 1 };
  assert.equal(withSelfConsistencyVoteInTrace(trace, "3/3", false), trace);
});

test("withSelfConsistencyVoteInTrace: empty vote is a no-op", () => {
  const trace = { a: 1 };
  assert.equal(withSelfConsistencyVoteInTrace(trace, "", true), trace);
});

test("withSelfConsistencyVoteInTrace: merges without overwriting, roundtrips", () => {
  const merged = withSelfConsistencyVoteInTrace({ a: 1, diagnostics: ["x"] }, "2/3", true) as any;
  assert.equal(merged.a, 1);
  assert.deepEqual(merged.diagnostics, ["x"]);
  assert.equal(merged.selfConsistencyVote, "2/3");
  assert.equal(readSelfConsistencyVoteFromTrace(merged), "2/3");
});

test("withSelfConsistencyVoteInTrace: tolerates null/non-object trace", () => {
  const merged = withSelfConsistencyVoteInTrace(null, "1/3", true) as any;
  assert.equal(merged.selfConsistencyVote, "1/3");
  assert.equal(readSelfConsistencyVoteFromTrace(undefined), "");
  assert.equal(readSelfConsistencyVoteFromTrace([1, 2]), "");
});

// ── CHANGE 8 — EVIDENCE_QUOTE_OVERLAP_MATCH ──────────────────────────────────
test("quoteTokenOverlap: identical=1, disjoint=0", () => {
  assert.equal(quoteTokenOverlap("flood risk assessment", "flood risk assessment"), 1);
  assert.equal(quoteTokenOverlap("alpha beta", "gamma delta"), 0);
});

test("QuoteLedger flag OFF: exact-text only (near-duplicates are distinct)", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("The company assessed flood risk in 2023", "m1", false), true);
  // near-dup but not exact → distinct measure can claim it (no threshold passed)
  assert.equal(led.claim("The company assessed flood risk during 2023 fully", "m2", false), true);
  // exact reuse by a different measure → blocked
  assert.equal(led.claim("The company assessed flood risk in 2023", "m2", false), false);
});

test("QuoteLedger flag ON: same passage id = match", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("quote one text here", "m1", false, { passageId: "p1", overlapThreshold: 0.6 }), true);
  // totally different text but same passage id → treated as same, owned by m1
  assert.equal(led.claim("completely unrelated words entirely", "m2", false, { passageId: "p1", overlapThreshold: 0.6 }), false);
});

test("QuoteLedger flag ON: >=60% token overlap = match, <60% = distinct", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("alpha beta gamma delta epsilon", "m1", false, { overlapThreshold: 0.6 }), true);
  // 4 of 5 tokens shared → Jaccard = 4/6 ≈ 0.67 ≥ 0.6 → match (blocked for m2)
  assert.equal(led.claim("alpha beta gamma delta zeta", "m2", false, { overlapThreshold: 0.6 }), false);
  // only 1 shared token with any claimed quote → distinct, m3 may claim
  assert.equal(led.claim("alpha one two three four five", "m3", false, { overlapThreshold: 0.6 }), true);
});

// ── CHANGE 7 — CHECKLIST_SOURCE_TYPE_CLASSIFY (classified coverage) ──────────
const fp = (url: string, title: string) => ({ url, title, gateVerdict: "accept", sourceType: "first_party" }) as any;

test("classifiedCoverageComprehensive: no classifier → not comprehensive", () => {
  const r = classifiedCoverageComprehensive({ documents: [fp("https://x.com/ar.pdf", "Annual Report")] });
  assert.equal(r.comprehensive, false);
});

test("classifiedCoverageComprehensive: both annual + sustainability → comprehensive", () => {
  const classify = (url: string, title: string) => {
    const s = (url + " " + title).toLowerCase();
    const out: string[] = [];
    if (s.includes("annual")) out.push("annual-report");
    if (s.includes("sustain")) out.push("sustainability report");
    return out;
  };
  const r = classifiedCoverageComprehensive({
    documents: [fp("https://x.com/annual.pdf", "Annual Report"), fp("https://x.com/sustainability.pdf", "Sustainability Report")],
    classifySourceTypes: classify,
  });
  assert.equal(r.annualReportPresent, true);
  assert.equal(r.sustainabilityOrClimatePresent, true);
  assert.equal(r.comprehensive, true);
});

test("classifiedCoverageComprehensive: only annual → not comprehensive", () => {
  const classify = (url: string) => (url.includes("annual") ? ["annual-report"] : []);
  const r = classifiedCoverageComprehensive({
    documents: [fp("https://x.com/annual.pdf", "Annual Report")],
    classifySourceTypes: classify,
  });
  assert.equal(r.annualReportPresent, true);
  assert.equal(r.sustainabilityOrClimatePresent, false);
  assert.equal(r.comprehensive, false);
});

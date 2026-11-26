// ─── Unit tests for WS4 — VERDICT_STABILITY pure decision logic ──────────────
//
// All tests inject the k sampled verdicts directly, so they exercise the
// eligibility / majority / tie-break / hysteresis logic WITHOUT calling the LLM.
//
// Run: node --import tsx --test server/lib/verdict-stability.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeBinaryVerdict,
  isFlipProneTrack,
  isBorderlineCell,
  isStabilityEligible,
  resolveByMajority,
  stabiliseVerdict,
  type StabilisableResult,
} from "./verdict-stability.js";

// Build a measure whose substantiveDefinition declares the given TRACK token.
function measureWithTrack(track: string | null): any {
  return track == null
    ? { substantiveDefinition: "No track declared here." }
    : { substantiveDefinition: `TRACK ${track} — resilience of critical operations.` };
}

// A borderline operational_resilience cell scored Yes at first pass.
function borderlineOpResCell(verdict: "Yes" | "No" = "Yes"): StabilisableResult {
  return { verdict, score: verdict === "Yes" ? 1 : 0, confidence: "Low" };
}

// ── normalizeBinaryVerdict ───────────────────────────────────────────────────
test("normalizeBinaryVerdict maps Yes/No case-insensitively; others → null", () => {
  assert.equal(normalizeBinaryVerdict("Yes"), "Yes");
  assert.equal(normalizeBinaryVerdict(" yes "), "Yes");
  assert.equal(normalizeBinaryVerdict("No"), "No");
  assert.equal(normalizeBinaryVerdict("not met"), "No");
  assert.equal(normalizeBinaryVerdict("not-met"), "No");
  assert.equal(normalizeBinaryVerdict("Partial"), null);
  assert.equal(normalizeBinaryVerdict("Scoring error"), null);
  assert.equal(normalizeBinaryVerdict(""), null);
  assert.equal(normalizeBinaryVerdict(null), null);
});

// ── Eligibility: flip-prone track ────────────────────────────────────────────
test("isFlipProneTrack: operational_resilience is flip-prone by default", () => {
  assert.equal(isFlipProneTrack(measureWithTrack("operational_resilience")), true);
  assert.equal(isFlipProneTrack(measureWithTrack("Operational_Resilience")), true); // case-insensitive
});

test("isFlipProneTrack: other tracks and no-track are NOT flip-prone (locked)", () => {
  assert.equal(isFlipProneTrack(measureWithTrack("physical_climate")), false);
  assert.equal(isFlipProneTrack(measureWithTrack("performance")), false);
  assert.equal(isFlipProneTrack(measureWithTrack(null)), false);
});

test("isFlipProneTrack: explicit track set override", () => {
  assert.equal(isFlipProneTrack(measureWithTrack("physical_climate"), ["physical_climate"]), true);
  assert.equal(isFlipProneTrack(measureWithTrack("operational_resilience"), ["physical_climate"]), false);
  assert.equal(isFlipProneTrack(measureWithTrack("operational_resilience"), []), false);
});

// ── Eligibility: borderline ──────────────────────────────────────────────────
test("isBorderlineCell: Low/Medium confidence is borderline; High/unknown is not", () => {
  assert.equal(isBorderlineCell({ confidence: "Low" }), true);
  assert.equal(isBorderlineCell({ confidence: "Medium" }), true);
  assert.equal(isBorderlineCell({ confidence: "High" }), false);
  assert.equal(isBorderlineCell({ confidence: null }), false); // unknown → high → not borderline
  assert.equal(isBorderlineCell({}), false);
});

test("isBorderlineCell: needsReadjudication forces borderline even at High confidence", () => {
  assert.equal(isBorderlineCell({ confidence: "High", needsReadjudication: true }), true);
  assert.equal(isBorderlineCell({ confidence: null, needsReadjudication: true }), true);
});

test("isStabilityEligible requires BOTH flip-prone track AND borderline", () => {
  assert.equal(isStabilityEligible(measureWithTrack("operational_resilience"), { confidence: "Low" }), true);
  // flip-prone but High confidence → not eligible
  assert.equal(isStabilityEligible(measureWithTrack("operational_resilience"), { confidence: "High" }), false);
  // borderline but wrong track → not eligible
  assert.equal(isStabilityEligible(measureWithTrack("physical_climate"), { confidence: "Low" }), false);
});

// ── Pure majority resolution ─────────────────────────────────────────────────
test("resolveByMajority: [Yes,No,No] → No", () => {
  const r = resolveByMajority(["Yes", "No", "No"], "Yes");
  assert.equal(r.resolvedVerdict, "No");
  assert.equal(r.yesVotes, 1);
  assert.equal(r.noVotes, 2);
  assert.equal(r.flipped, true);
  assert.equal(r.resolution, "majority-flip");
});

test("resolveByMajority: [Yes,Yes,No] → Yes", () => {
  const r = resolveByMajority(["Yes", "Yes", "No"], "No");
  assert.equal(r.resolvedVerdict, "Yes");
  assert.equal(r.yesVotes, 2);
  assert.equal(r.noVotes, 1);
  assert.equal(r.flipped, true);
});

test("resolveByMajority: majority confirming the first pass is majority-confirm (no flip)", () => {
  const r = resolveByMajority(["Yes", "Yes", "No"], "Yes");
  assert.equal(r.resolvedVerdict, "Yes");
  assert.equal(r.flipped, false);
  assert.equal(r.resolution, "majority-confirm");
});

test("resolveByMajority: exact tie keeps the first-pass verdict (never flip on a tie)", () => {
  const rYes = resolveByMajority(["Yes", "No"], "Yes");
  assert.equal(rYes.resolvedVerdict, "Yes");
  assert.equal(rYes.resolution, "tie-keep-first");
  assert.equal(rYes.flipped, false);

  const rNo = resolveByMajority(["Yes", "No"], "No");
  assert.equal(rNo.resolvedVerdict, "No");
  assert.equal(rNo.resolution, "tie-keep-first");

  // 2-2 tie on k=4 also keeps first-pass
  const r4 = resolveByMajority(["Yes", "Yes", "No", "No"], "No");
  assert.equal(r4.resolvedVerdict, "No");
  assert.equal(r4.resolution, "tie-keep-first");
});

test("resolveByMajority: non-binary samples are ignored; empty samples keep first-pass", () => {
  // Only one valid vote (No) → threshold floor(1/2)+1 = 1 → No wins
  const r = resolveByMajority(["Partial", "Scoring error", "No"], "Yes");
  assert.equal(r.resolvedVerdict, "No");
  assert.equal(r.yesVotes, 0);
  assert.equal(r.noVotes, 1);

  // No valid samples at all → keep first pass
  const rEmpty = resolveByMajority([], "Yes");
  assert.equal(rEmpty.resolvedVerdict, "Yes");
  assert.equal(rEmpty.resolution, "tie-keep-first");
});

// ── stabiliseVerdict: end-to-end (eligibility + majority + mutation) ──────────
test("stabiliseVerdict: eligible op-res cell [Yes,No,No] → No, score 0, trace + nuance", () => {
  const result = borderlineOpResCell("Yes");
  const out = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: ["Yes", "No", "No"],
  });
  assert.equal(out.verdict, "No");
  assert.equal(out.score, 0);
  assert.ok(out.verdictStabilityTrace);
  assert.equal(out.verdictStabilityTrace?.resolution, "majority-flip");
  assert.equal(out.verdictStabilityTrace?.resolvedVerdict, "No");
  assert.match(String(out.verdictNuance), /Verdict-stability/);
  assert.match(String(out.verdictNuance), /operational_resilience/);
});

test("stabiliseVerdict: eligible op-res cell [Yes,Yes,No] → Yes, score 1", () => {
  const result = borderlineOpResCell("No");
  const out = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: ["Yes", "Yes", "No"],
  });
  assert.equal(out.verdict, "Yes");
  assert.equal(out.score, 1);
  assert.equal(out.verdictStabilityTrace?.resolution, "majority-flip");
});

test("stabiliseVerdict: exact tie keeps first-pass verdict and score (eligible cell)", () => {
  const result = borderlineOpResCell("Yes");
  const out = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: ["Yes", "No"], // 1-1 tie
  });
  assert.equal(out.verdict, "Yes"); // kept
  assert.equal(out.score, 1);
  assert.equal(out.verdictStabilityTrace?.resolution, "tie-keep-first");
  // Tie writes a trace but does NOT add a flip nuance note.
  assert.doesNotMatch(String(out.verdictNuance ?? ""), /resolved by majority/);
});

test("stabiliseVerdict: non-flip-prone track is LOCKED — byte-for-byte unchanged, no trace", () => {
  const result: StabilisableResult = { verdict: "Yes", score: 1, confidence: "Low", verdictNuance: "orig" };
  const snapshot = JSON.stringify(result);
  const out = stabiliseVerdict({
    measure: measureWithTrack("physical_climate"),
    result,
    sampledVerdicts: ["No", "No", "No"], // would flip IF eligible
  });
  assert.equal(out.verdict, "Yes");
  assert.equal(out.score, 1);
  assert.equal(out.verdictStabilityTrace, undefined);
  assert.equal(JSON.stringify(out), snapshot);
});

test("stabiliseVerdict: High-confidence cell is LOCKED even on a flip-prone track", () => {
  const result: StabilisableResult = { verdict: "Yes", score: 1, confidence: "High" };
  const snapshot = JSON.stringify(result);
  const out = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: ["No", "No", "No"],
  });
  assert.equal(out.verdict, "Yes");
  assert.equal(out.score, 1);
  assert.equal(out.verdictStabilityTrace, undefined);
  assert.equal(JSON.stringify(out), snapshot);
});

test("stabiliseVerdict: empty samples (simulating a failed k-pass) keep first-pass", () => {
  const result = borderlineOpResCell("Yes");
  const out = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: [], // caller caught an error and passed no samples
  });
  assert.equal(out.verdict, "Yes");
  assert.equal(out.score, 1);
  assert.equal(out.verdictStabilityTrace?.resolution, "tie-keep-first");
});

test("stabiliseVerdict: idempotent — a row already carrying a trace is not re-touched", () => {
  const result = borderlineOpResCell("Yes");
  const first = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result,
    sampledVerdicts: ["No", "No", "No"],
  });
  assert.equal(first.verdict, "No");
  const afterTrace = JSON.stringify(first);
  const second = stabiliseVerdict({
    measure: measureWithTrack("operational_resilience"),
    result: first,
    sampledVerdicts: ["Yes", "Yes", "Yes"], // would flip back IF re-run
  });
  assert.equal(JSON.stringify(second), afterTrace); // unchanged
});

// ── Env overrides: SCORING_FLIP_PRONE_TRACKS and VERDICT_STABILITY_K ─────────
test("env SCORING_FLIP_PRONE_TRACKS override is respected by the flag reader", async () => {
  const flags = await import("./scoring-fix-flags.js");
  const prev = process.env.SCORING_FLIP_PRONE_TRACKS;
  try {
    process.env.SCORING_FLIP_PRONE_TRACKS = "physical_climate, performance";
    assert.deepEqual(flags.flipProneTracks(), ["physical_climate", "performance"]);
    // Default when unset
    delete process.env.SCORING_FLIP_PRONE_TRACKS;
    assert.deepEqual(flags.flipProneTracks(), ["operational_resilience"]);
  } finally {
    if (prev === undefined) delete process.env.SCORING_FLIP_PRONE_TRACKS;
    else process.env.SCORING_FLIP_PRONE_TRACKS = prev;
  }
});

test("env VERDICT_STABILITY_K override is respected; invalid/absent falls back to 3", async () => {
  const flags = await import("./scoring-fix-flags.js");
  const prev = process.env.VERDICT_STABILITY_K;
  try {
    process.env.VERDICT_STABILITY_K = "5";
    assert.equal(flags.verdictStabilityK(), 5);
    process.env.VERDICT_STABILITY_K = "0"; // below min → fallback 3
    assert.equal(flags.verdictStabilityK(), 3);
    process.env.VERDICT_STABILITY_K = "garbage"; // non-numeric → fallback 3
    assert.equal(flags.verdictStabilityK(), 3);
    delete process.env.VERDICT_STABILITY_K;
    assert.equal(flags.verdictStabilityK(), 3);
  } finally {
    if (prev === undefined) delete process.env.VERDICT_STABILITY_K;
    else process.env.VERDICT_STABILITY_K = prev;
  }
});

test("env override changes eligibility end-to-end (physical_climate becomes flip-prone)", () => {
  const result = borderlineOpResCell("Yes");
  const out = stabiliseVerdict({
    measure: measureWithTrack("physical_climate"),
    result,
    sampledVerdicts: ["No", "No", "No"],
    tracks: ["physical_climate"], // simulate env override via explicit opts
  });
  assert.equal(out.verdict, "No");
  assert.equal(out.score, 0);
});

// ── Flag gate: default OFF ────────────────────────────────────────────────────
test("verdictStabilityEnabled is default OFF (no-op unless explicitly enabled)", async () => {
  const flags = await import("./scoring-fix-flags.js");
  const prev = process.env.VERDICT_STABILITY;
  try {
    delete process.env.VERDICT_STABILITY;
    assert.equal(flags.verdictStabilityEnabled(), false);
    process.env.VERDICT_STABILITY = "true";
    assert.equal(flags.verdictStabilityEnabled(), true);
    process.env.VERDICT_STABILITY = "false";
    assert.equal(flags.verdictStabilityEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.VERDICT_STABILITY;
    else process.env.VERDICT_STABILITY = prev;
  }
});

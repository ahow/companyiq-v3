/**
 * Unit tests for the Change 3 arbiter-trigger tuning helpers in analyzer.ts:
 *   arbiterTriggerDecision, isStageInternallyInconsistent.
 *
 * These are the pure, offline core of the feature — scoreWithCascade uses
 * arbiterTriggerDecision to decide whether to run the third LLM, and
 * isStageInternallyInconsistent to compute the per-stage flags it feeds in. Testing
 * them directly (DI/offline style of cascade-fallback.test.ts; no LLM / network /
 * DB) proves the behaviour the user asked for WITHOUT changing the default:
 *   - default / "exact"  => arbiter fires ONLY on a numeric disagreement
 *                           (regression guard for the default behaviour),
 *   - "inconsistency"    => arbiter ALSO fires when the stages agree but a stage is
 *                           flagged internally inconsistent,
 *   - agreed + clean     => no arbiter in EITHER mode.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arbiterTriggerDecision,
  isStageInternallyInconsistent,
} from "./analyzer.js";

// ─── default / "exact" mode: arbiter only on numeric disagreement ─────────────
test('exact mode: arbiter fires ONLY when s1 !== s2', () => {
  const disagree = arbiterTriggerDecision({ mode: "exact", s1: 1, s2: 0, stage1Flagged: false, stage2Flagged: false });
  assert.equal(disagree.invoke, true);
  assert.equal(disagree.reason, "scores-disagree");
  assert.equal(disagree.mode, "exact");

  const agree = arbiterTriggerDecision({ mode: "exact", s1: 1, s2: 1, stage1Flagged: false, stage2Flagged: false });
  assert.equal(agree.invoke, false);
  assert.equal(agree.reason, null);
});

test('exact mode: a flagged stage does NOT trigger the arbiter when scores agree (regression guard)', () => {
  const d = arbiterTriggerDecision({ mode: "exact", s1: 1, s2: 1, stage1Flagged: true, stage2Flagged: true });
  assert.equal(d.invoke, false, "exact mode must ignore inconsistency flags");
  assert.equal(d.reason, null);
});

test('unknown / empty mode is normalised to "exact" (default preserved)', () => {
  for (const mode of ["", "  ", "weird-mode", "EXACT", "Exact"]) {
    const agreeFlagged = arbiterTriggerDecision({ mode, s1: 0, s2: 0, stage1Flagged: true, stage2Flagged: false });
    assert.equal(agreeFlagged.invoke, false, `mode "${mode}" must behave as exact`);
    assert.equal(agreeFlagged.mode, "exact");
    const disagree = arbiterTriggerDecision({ mode, s1: 1, s2: 0, stage1Flagged: false, stage2Flagged: false });
    assert.equal(disagree.invoke, true);
  }
});

// ─── "inconsistency" mode: also fires on agreed-but-flagged ───────────────────
test('inconsistency mode: arbiter fires on numeric disagreement too', () => {
  const d = arbiterTriggerDecision({ mode: "inconsistency", s1: 1, s2: 0, stage1Flagged: false, stage2Flagged: false });
  assert.equal(d.invoke, true);
  assert.equal(d.reason, "scores-disagree");
  assert.equal(d.mode, "inconsistency");
});

test('inconsistency mode: arbiter fires when stages AGREE but a stage is flagged', () => {
  const flaggedFirst = arbiterTriggerDecision({ mode: "inconsistency", s1: 1, s2: 1, stage1Flagged: true, stage2Flagged: false });
  assert.equal(flaggedFirst.invoke, true);
  assert.equal(flaggedFirst.reason, "agreed-but-flagged-inconsistent");

  const flaggedSecond = arbiterTriggerDecision({ mode: "inconsistency", s1: 0, s2: 0, stage1Flagged: false, stage2Flagged: true });
  assert.equal(flaggedSecond.invoke, true);
  assert.equal(flaggedSecond.reason, "agreed-but-flagged-inconsistent");

  // Case/space-insensitive mode spelling.
  const spaced = arbiterTriggerDecision({ mode: "  Inconsistency ", s1: 1, s2: 1, stage1Flagged: true, stage2Flagged: false });
  assert.equal(spaced.invoke, true);
  assert.equal(spaced.mode, "inconsistency");
});

// ─── agreed + clean: no arbiter in either mode ────────────────────────────────
test('agreed + clean: no arbiter in either mode', () => {
  for (const mode of ["exact", "inconsistency"]) {
    const d = arbiterTriggerDecision({ mode, s1: 1, s2: 1, stage1Flagged: false, stage2Flagged: false });
    assert.equal(d.invoke, false, `${mode}: agreed + clean must not invoke the arbiter`);
    assert.equal(d.reason, null);
  }
});

// ─── isStageInternallyInconsistent: reuses the deterministic detector ─────────
test('isStageInternallyInconsistent: trusts an existing post-merge flag', () => {
  assert.equal(
    isStageInternallyInconsistent({ score: 1, verdict: "Yes", evidenceSummary: "clean", rationaleScoreInconsistent: true }),
    true,
  );
});

test('isStageInternallyInconsistent: honours the model self-check ("No")', () => {
  // A NO verdict whose own self-check says the rationale/score disagree.
  const flagged = isStageInternallyInconsistent({
    score: 0,
    verdict: "No",
    evidenceSummary: "The company discloses and maintains a documented policy covering this.",
    rationaleConsistencyCheck: "No",
  });
  assert.equal(flagged, true);
});

test('isStageInternallyInconsistent: a clean, consistent stage is NOT flagged', () => {
  const clean = isStageInternallyInconsistent({
    score: 1,
    verdict: "Yes",
    evidenceSummary: "The company publishes a board-approved policy and reports annually against it.",
    rationaleConsistencyCheck: "Yes",
  });
  assert.equal(clean, false);
});

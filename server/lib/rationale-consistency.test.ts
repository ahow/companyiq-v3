/**
 * Tests for the generic bidirectional rationale↔score consistency detector
 * (Change D). node:test — run with:  npx tsx --test server/lib/rationale-consistency.test.ts
 *
 * The detector NEVER mutates score/verdict — it only returns flags. These tests
 * assert both directions fire, the negated-affirmative scrubber prevents false
 * positives, the model self-check is honoured, and Partial is not lexically
 * flagged. Nothing here references a specific measure, company, or framework.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRationaleScoreInconsistency } from "./rationale-consistency.js";

test("direction (i): affirmative/existence rationale under a No verdict is flagged", () => {
  const r = detectRationaleScoreInconsistency({
    score: 0,
    verdict: "No",
    rationale:
      "The company explicitly states it has a dedicated board committee and provides a documented oversight process.",
  });
  assert.equal(r.inconsistent, true);
  assert.ok(r.directions.includes("affirmative_on_no"));
  assert.ok(r.signals.affirmativeHits > 0);
});

test("direction (ii): absence/negation rationale under a Yes verdict is flagged", () => {
  const r = detectRationaleScoreInconsistency({
    score: 1,
    verdict: "Yes",
    rationale:
      "There is no evidence of any policy and the group does not disclose an oversight process.",
  });
  assert.equal(r.inconsistent, true);
  assert.ok(r.directions.includes("negation_on_yes"));
  assert.ok(r.signals.absenceHits > 0);
});

test("flags only — no score/verdict is returned or mutated", () => {
  const input = { score: 0, verdict: "No", rationale: "It has an established framework in place." };
  const r = detectRationaleScoreInconsistency(input);
  // The result object exposes only flags/diagnostics, never a score or verdict.
  assert.equal((r as any).score, undefined);
  assert.equal((r as any).verdict, undefined);
  // Caller's input is untouched.
  assert.equal(input.score, 0);
  assert.equal(input.verdict, "No");
});

test("negated-affirmative scrubber: 'has no policy' under a No verdict is NOT flagged", () => {
  const r = detectRationaleScoreInconsistency({
    score: 0,
    verdict: "No",
    rationale:
      "The company has no AI policy and there is no disclosure of any oversight committee.",
  });
  assert.equal(r.directions.includes("affirmative_on_no"), false);
});

test("model self-check 'No' is an independent flag regardless of verdict polarity", () => {
  const r = detectRationaleScoreInconsistency({
    score: 1,
    verdict: "Yes",
    rationale: "The company has a clear and documented policy.", // lexically consistent
    modelConsistencyCheck: "No",
    consistencyNote: "rationale describes only partial coverage",
  });
  assert.equal(r.inconsistent, true);
  assert.ok(r.directions.includes("model_self_check"));
  assert.equal(r.signals.modelSelfCheckFailed, true);
  assert.ok(r.reason.includes("self-check"));
});

test("model self-check 'Yes' does not itself flag", () => {
  const r = detectRationaleScoreInconsistency({
    score: 1,
    verdict: "Yes",
    rationale: "The company has a clear and documented policy in place.",
    modelConsistencyCheck: "Yes",
  });
  assert.equal(r.directions.includes("model_self_check"), false);
});

test("Partial (0.5) is not lexically flagged even with mixed language", () => {
  const r = detectRationaleScoreInconsistency({
    score: 0.5,
    verdict: "Partial",
    rationale:
      "The company discloses a policy but does not provide evidence of board oversight.",
  });
  // No lexical direction should fire for Partial; only model self-check could.
  assert.equal(r.directions.includes("affirmative_on_no"), false);
  assert.equal(r.directions.includes("negation_on_yes"), false);
});

test("consistent Yes with affirmative rationale is not flagged", () => {
  const r = detectRationaleScoreInconsistency({
    score: 1,
    verdict: "Yes",
    rationale: "The company has established a formal board committee and publishes its policy.",
  });
  assert.equal(r.inconsistent, false);
  assert.equal(r.directions.length, 0);
});

test("empty/missing rationale yields no lexical flags", () => {
  const r = detectRationaleScoreInconsistency({ score: 0, verdict: "No", rationale: "" });
  assert.equal(r.signals.affirmativeHits, 0);
  assert.equal(r.signals.absenceHits, 0);
  assert.equal(r.inconsistent, false);
});

/**
 * Unit tests for the Change 2 confidence-gated cascade decision helper in
 * analyzer.ts: confidenceGateDecision.
 *
 * This is the pure, offline core of the gate — scoreWithCascade calls it with the
 * primary stage's confidence and acts on { runSecondary, gateFired, secondarySkipped }.
 * Testing it directly (DI/offline style of cascade-fallback.test.ts; no LLM /
 * network / DB) proves the behaviour the user asked for WITHOUT altering the
 * two-LLM + arbiter default:
 *   - gate OFF  => the two stages ALWAYS run (runSecondary=true, gateFired=false) —
 *                  the regression guard for the default-OFF constraint,
 *   - gate ON + High-confidence primary => secondary (and arbiter) SKIPPED,
 *   - gate ON + Medium/Low primary      => both stages + arbiter path intact.
 *
 * It also pins the cascadeTrace.confidenceGate contract via buildCascadeTrace, so a
 * "gated-primary-only" terminus records that the gate fired and the secondary was
 * skipped while preserving schemaVersion + stage1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceGateDecision,
  buildCascadeTrace,
  newCascadeStageRecord,
} from "./analyzer.js";

// ─── gate OFF: default two-LLM behaviour is byte-identical (regression guard) ──
test("gate OFF: secondary always runs, gate never fires, regardless of confidence", () => {
  for (const conf of ["High", "Medium", "Low", "Review-required", null, undefined, ""]) {
    const d = confidenceGateDecision({ gateEnabled: false, primaryConfidence: conf });
    assert.equal(d.runSecondary, true, `runSecondary must stay true for ${conf}`);
    assert.equal(d.gateFired, false, `gate must not fire when disabled for ${conf}`);
    assert.equal(d.secondarySkipped, false);
    assert.equal(d.reason, "gate-disabled");
  }
});

// ─── gate ON + High primary: skip the secondary (and the arbiter) ─────────────
test("gate ON + High primary: secondary skipped, gate fires", () => {
  const d = confidenceGateDecision({ gateEnabled: true, primaryConfidence: "High" });
  assert.equal(d.runSecondary, false);
  assert.equal(d.gateFired, true);
  assert.equal(d.secondarySkipped, true);
  assert.equal(d.reason, "primary-high-confidence");
});

test("gate ON + High primary: confidence match is case/space-insensitive", () => {
  for (const conf of ["high", "  HIGH ", "High"]) {
    const d = confidenceGateDecision({ gateEnabled: true, primaryConfidence: conf });
    assert.equal(d.runSecondary, false, `"${conf}" should be treated as High`);
    assert.equal(d.secondarySkipped, true);
  }
});

// ─── gate ON + Medium/Low primary: full cascade (both stages + arbiter) runs ───
test("gate ON + Medium/Low/Review primary: secondary runs, arbiter path intact", () => {
  for (const conf of ["Medium", "Low", "Review-required"]) {
    const d = confidenceGateDecision({ gateEnabled: true, primaryConfidence: conf });
    assert.equal(d.runSecondary, true, `${conf} must fall through to the secondary`);
    assert.equal(d.gateFired, true, `gate is active (fired) for ${conf}`);
    assert.equal(d.secondarySkipped, false);
    assert.equal(d.reason, `primary-${conf.toLowerCase()}-confidence`);
  }
});

test("gate ON + unknown/empty confidence: fail-safe to running the secondary", () => {
  for (const conf of [null, undefined, ""]) {
    const d = confidenceGateDecision({ gateEnabled: true, primaryConfidence: conf });
    assert.equal(d.runSecondary, true, "an unreadable confidence must NOT skip the secondary");
    assert.equal(d.secondarySkipped, false);
    assert.equal(d.reason, "primary-unknown-confidence");
  }
});

// ─── cascadeTrace contract for the gated-primary-only terminus ─────────────────
test("buildCascadeTrace: gated-primary-only records gate fired + no stage2/arbiter", () => {
  const stage1 = newCascadeStageRecord("primary", "deepseek");
  stage1.score = 1;
  stage1.ms = 1234;
  const trace = buildCascadeTrace({
    stage1,
    stage2: null,
    arbiter: null,
    finalConfidence: "High",
    outcome: "gated-primary-only",
    confidenceGate: { enabled: true, fired: true, secondarySkipped: true },
  });
  assert.equal(trace.schemaVersion, 1);
  assert.equal(trace.outcome, "gated-primary-only");
  assert.equal(trace.stage2, null, "secondary was skipped → stage2 is null");
  assert.equal(trace.arbiter, null, "arbiter never ran");
  assert.equal(trace.arbiterInvoked, false);
  assert.equal(trace.finalConfidence, "High");
  assert.deepEqual(trace.confidenceGate, { enabled: true, fired: true, secondarySkipped: true });
  assert.equal(trace.stage1.score, 1, "primary stage record preserved");
});

test("buildCascadeTrace: default confidenceGate is the disabled sentinel", () => {
  const stage1 = newCascadeStageRecord("primary", "deepseek");
  const stage2 = newCascadeStageRecord("secondary", "glm-4.6-zai");
  const trace = buildCascadeTrace({
    stage1,
    stage2,
    arbiter: null,
    finalConfidence: "High",
    outcome: "agreed",
  });
  assert.deepEqual(trace.confidenceGate, { enabled: false, fired: false, secondarySkipped: false });
});

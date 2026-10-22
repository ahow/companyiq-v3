/**
 * Change 5 — per-stage cascade instrumentation.
 *
 * Unit tests for the observability-only trace assembled by scoreWithCascade:
 *   newCascadeStageRecord, buildCascadeTrace, and the CascadeTrace shape.
 *
 * Mirrors server/lib/cascade-fallback.test.ts: fully offline (no LLM / network /
 * DB / clock), dependency-injected stage records, asserts on the returned object.
 * The trace must be populated correctly for the three cascade paths it feeds:
 *   - agreement   (stage1 + stage2, no arbiter, High),
 *   - disagreement(stage1 + stage2 + arbiter, Medium / Review-required),
 *   - fallback    (a stage whose provider was substituted mid-run).
 * It must NEVER carry a score/verdict/quote — it is pure telemetry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newCascadeStageRecord,
  buildCascadeTrace,
  type CascadeStageRecord,
} from "./analyzer.js";

// A stage record as the production recorder would leave it after a clean run.
const ran = (
  role: CascadeStageRecord["role"],
  provider: string,
  score: number,
  ms = 5,
): CascadeStageRecord => ({
  role,
  requestedProvider: provider,
  provider,
  score,
  ms,
  fallbackFired: false,
  fallbackTo: null,
  fallbackReason: null,
});

// ─── newCascadeStageRecord ────────────────────────────────────────────────────
test("newCascadeStageRecord: an unrun stage is inert (null score, 0 ms, no fallback)", () => {
  const r = newCascadeStageRecord("secondary", "glm-4.6-zai");
  assert.equal(r.role, "secondary");
  assert.equal(r.requestedProvider, "glm-4.6-zai");
  assert.equal(r.provider, "glm-4.6-zai");
  assert.equal(r.score, null);
  assert.equal(r.ms, 0);
  assert.equal(r.fallbackFired, false);
  assert.equal(r.fallbackTo, null);
  assert.equal(r.fallbackReason, null);
});

// ─── Agreement path ───────────────────────────────────────────────────────────
test("buildCascadeTrace: agreement path → both stages recorded, no arbiter, High", () => {
  const trace = buildCascadeTrace({
    stage1: ran("primary", "deepseek", 1),
    stage2: ran("secondary", "glm-4.6-zai", 1),
    arbiter: null,
    finalConfidence: "High",
    outcome: "agreed",
  });
  assert.equal(trace.schemaVersion, 1);
  assert.equal(trace.outcome, "agreed");
  assert.equal(trace.finalConfidence, "High");
  assert.equal(trace.stage1.provider, "deepseek");
  assert.equal(trace.stage1.score, 1);
  assert.ok(trace.stage2 !== null);
  assert.equal(trace.stage2!.provider, "glm-4.6-zai");
  assert.equal(trace.stage2!.score, 1);
  assert.equal(trace.arbiterInvoked, false);
  assert.equal(trace.arbiter, null);
  // Defaults for the flags Changes 2 & 3 populate.
  assert.deepEqual(trace.confidenceGate, { enabled: false, fired: false, secondarySkipped: false });
  assert.deepEqual(trace.arbiterTrigger, { mode: "exact", reason: null });
});

// ─── Disagreement path (2-of-3 arbiter) ───────────────────────────────────────
test("buildCascadeTrace: disagreement path → arbiter recorded + invoked, Medium", () => {
  const trace = buildCascadeTrace({
    stage1: ran("primary", "deepseek", 1),
    stage2: ran("secondary", "glm-4.6-zai", 0),
    arbiter: ran("arbiter", "gpt5-arbiter", 1),
    finalConfidence: "Medium",
    outcome: "arbiter",
  });
  assert.equal(trace.outcome, "arbiter");
  assert.equal(trace.finalConfidence, "Medium");
  assert.equal(trace.arbiterInvoked, true);
  assert.ok(trace.arbiter !== null);
  assert.equal(trace.arbiter!.provider, "gpt5-arbiter");
  assert.equal(trace.arbiter!.score, 1);
  // All three distinct votes were recorded.
  assert.deepEqual(
    [trace.stage1.score, trace.stage2!.score, trace.arbiter!.score],
    [1, 0, 1],
  );
});

// ─── Three-way split ──────────────────────────────────────────────────────────
test("buildCascadeTrace: three-way split → arbiter invoked, Review-required", () => {
  const trace = buildCascadeTrace({
    stage1: ran("primary", "deepseek", 1),
    stage2: ran("secondary", "glm-4.6-zai", 0),
    arbiter: ran("arbiter", "gpt5-arbiter", 0.5),
    finalConfidence: "Review-required",
    outcome: "3-way",
  });
  assert.equal(trace.outcome, "3-way");
  assert.equal(trace.finalConfidence, "Review-required");
  assert.equal(trace.arbiterInvoked, true);
  assert.deepEqual(
    [trace.stage1.score, trace.stage2!.score, trace.arbiter!.score],
    [1, 0, 0.5],
  );
});

// ─── Fallback path ────────────────────────────────────────────────────────────
test("buildCascadeTrace: a stage that fell back records substitute provider + reason", () => {
  // Secondary requested glm-4.6-zai, hung, fell back to glm-4.6.
  const stage2: CascadeStageRecord = {
    role: "secondary",
    requestedProvider: "glm-4.6-zai",
    provider: "glm-4.6",
    score: 1,
    ms: 181000,
    fallbackFired: true,
    fallbackTo: "glm-4.6",
    fallbackReason: "timeout>180000ms",
  };
  const trace = buildCascadeTrace({
    stage1: ran("primary", "deepseek", 1),
    stage2,
    arbiter: null,
    finalConfidence: "High",
    outcome: "agreed",
  });
  assert.equal(trace.stage2!.fallbackFired, true);
  assert.equal(trace.stage2!.requestedProvider, "glm-4.6-zai");
  assert.equal(trace.stage2!.provider, "glm-4.6");
  assert.equal(trace.stage2!.fallbackTo, "glm-4.6");
  assert.match(trace.stage2!.fallbackReason!, /^timeout>180000ms/);
  // stage1 did NOT fall back.
  assert.equal(trace.stage1.fallbackFired, false);
});

// ─── Telemetry purity ─────────────────────────────────────────────────────────
test("buildCascadeTrace: trace carries no verdict/quote fields (pure telemetry)", () => {
  const trace = buildCascadeTrace({
    stage1: ran("primary", "deepseek", 1),
    stage2: ran("secondary", "glm-4.6-zai", 1),
    arbiter: null,
    finalConfidence: "High",
    outcome: "agreed",
  }) as unknown as Record<string, unknown>;
  assert.equal("verdict" in trace, false);
  assert.equal("quotes" in trace, false);
  assert.equal("score" in trace, false);
});

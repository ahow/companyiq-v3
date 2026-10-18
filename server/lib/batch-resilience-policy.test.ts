/**
 * Phase 3 / Issue 3 — batch-resilience-policy.ts unit tests (offline, pure).
 * Run: npx tsx server/lib/batch-resilience-policy.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBatchResiliencePolicy,
  DEFAULT_BATCH_RESILIENCE_POLICY,
  BATCH_RESILIENCE_POLICY_ENV,
  BATCH_RESILIENCE_POLICY_VERSION,
  resolveResilienceConfig,
  DEFAULT_RESILIENCE_CONFIG,
  decideCompanyAction,
  isSystemicFailure,
  decideBatchContinuation,
} from "./batch-resilience-policy.js";
import { decideBatchStop } from "./batch-stop-rule.js";

// ── RP01: resolver precedence + fail-safe ────────────────────────────────────
test("RP01 resolver precedence + fail-safe to legacy default, never throws", () => {
  assert.equal(DEFAULT_BATCH_RESILIENCE_POLICY, "legacy");
  assert.equal(BATCH_RESILIENCE_POLICY_VERSION, 1);
  const saved = process.env[BATCH_RESILIENCE_POLICY_ENV];
  try {
    delete process.env[BATCH_RESILIENCE_POLICY_ENV];
    assert.equal(resolveBatchResiliencePolicy(), "legacy");
    process.env[BATCH_RESILIENCE_POLICY_ENV] = "resilient";
    assert.equal(resolveBatchResiliencePolicy(), "resilient");
    assert.equal(resolveBatchResiliencePolicy("shadow"), "shadow"); // explicit wins
    delete process.env[BATCH_RESILIENCE_POLICY_ENV];
    assert.equal(resolveBatchResiliencePolicy("garbage"), "legacy"); // unrecognised → default
  } finally {
    if (saved === undefined) delete process.env[BATCH_RESILIENCE_POLICY_ENV];
    else process.env[BATCH_RESILIENCE_POLICY_ENV] = saved;
  }
});

// ── RP02: config merge is forgiving + clamped ────────────────────────────────
test("RP02 resolveResilienceConfig clamps + merges", () => {
  assert.deepEqual(resolveResilienceConfig(), DEFAULT_RESILIENCE_CONFIG);
  const c = resolveResilienceConfig({ maxAttempts: 0, systemicFailFraction: 5, costBudget: 100 });
  assert.equal(c.maxAttempts, 1, "maxAttempts floored to 1");
  assert.equal(c.systemicFailFraction, 1, "fraction clamped to 1");
  assert.equal(c.costBudget, 100);
  const bad = resolveResilienceConfig({ systemicFailFraction: -1 as any, costBudget: -5 as any });
  assert.equal(bad.systemicFailFraction, DEFAULT_RESILIENCE_CONFIG.systemicFailFraction);
  assert.equal(bad.costBudget, undefined, "non-positive budget dropped");
});

// ── RP03: per-company — retry then quarantine WITH REASON ────────────────────
test("RP03 company retried under maxAttempts, quarantined WITH REASON once exhausted", () => {
  const cfg = resolveResilienceConfig({ maxAttempts: 3 });
  const retry = decideCompanyAction({ companyId: "c1", attempts: 1, lastError: "boom" }, cfg);
  assert.equal(retry.action, "retry");
  const retry2 = decideCompanyAction({ companyId: "c1", attempts: 2, lastError: "boom" }, cfg);
  assert.equal(retry2.action, "retry");
  const quarantined = decideCompanyAction({ companyId: "c1", attempts: 3, lastError: "pdf render timeout" }, cfg);
  assert.equal(quarantined.action, "quarantine");
  assert.ok(quarantined.reason.includes("pdf render timeout"), "quarantine carries the reason");
  assert.ok(quarantined.reason.includes("3 attempt"), "quarantine records attempts");
});

test("RP03b completed company accepted; cancellation/pause is not a failure → retry", () => {
  assert.equal(decideCompanyAction({ companyId: "x", attempts: 9, completed: true }).action, "accept");
  // Cancelled/provider_paused are NOT company failures → retry even past maxAttempts
  const cancelled = decideCompanyAction({ companyId: "x", attempts: 9, lastError: "Cancelled by user" });
  assert.equal(cancelled.action, "retry");
  const paused = decideCompanyAction({ companyId: "x", attempts: 9, lastError: "provider_paused: quota" });
  assert.equal(paused.action, "retry");
});

// ── RP04: systemic threshold — >20% fires, isolated does not ──────────────────
test("RP04 systemic signal fires above fraction threshold, not for an isolated failure", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.2 });
  // 1/25 = 4% → NOT systemic
  assert.equal(isSystemicFailure({ total: 25, failedOrQuarantined: 1 }, cfg).systemic, false);
  // 5/25 = 20% → NOT > 20% (strictly greater) → not systemic
  assert.equal(isSystemicFailure({ total: 25, failedOrQuarantined: 5 }, cfg).systemic, false);
  // 6/25 = 24% → systemic
  assert.equal(isSystemicFailure({ total: 25, failedOrQuarantined: 6 }, cfg).systemic, true);
});

test("RP04b cost overrun is systemic regardless of count", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.99, costBudget: 50 });
  const r = isSystemicFailure({ total: 100, failedOrQuarantined: 0, costSpent: 51 }, cfg);
  assert.equal(r.systemic, true);
  assert.ok(r.reason.includes("cost overrun"));
});

// ── RP05: INVARIANT — one failure NEVER cancels the batch (resilient) ─────────
test("RP05 resilient: one slow/failed company never cancels the other 24", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.2 });
  const d = decideBatchContinuation({
    policy: "resilient",
    stats: { total: 25, failedOrQuarantined: 1 },
    cfg,
  });
  assert.equal(d.cancel, false, "one failure does NOT cancel the batch");
  assert.equal(d.systemic, false);
  // but a systemic fraction DOES cancel
  const sys = decideBatchContinuation({
    policy: "resilient",
    stats: { total: 25, failedOrQuarantined: 10 },
    cfg,
  });
  assert.equal(sys.cancel, true);
  assert.equal(sys.systemic, true);
});

// ── RP06: legacy default DELEGATES to batch-stop-rule (byte-identical) ────────
test("RP06 legacy default delegates to batch-stop-rule decideBatchStop", () => {
  const counts = { failedAttemptJobs: 2, retryExhaustedJobs: 0 };
  const threshold = 2;
  const delegated = decideBatchContinuation({
    policy: "legacy",
    stats: { total: 25, failedOrQuarantined: 2, legacyCounts: counts },
    legacyThreshold: threshold,
  });
  const direct = decideBatchStop(counts, threshold);
  assert.equal(delegated.cancel, direct.stop, "legacy cancel == decideBatchStop.stop");
  assert.ok(delegated.reason.includes(direct.reason), "legacy reason wraps decideBatchStop reason");
  // retry-exhaustion also cancels under legacy (matches S4)
  const exhausted = decideBatchContinuation({
    policy: "legacy",
    stats: { total: 25, failedOrQuarantined: 1, legacyCounts: { failedAttemptJobs: 1, retryExhaustedJobs: 1 } },
    legacyThreshold: 2,
  });
  assert.equal(exhausted.cancel, true, "legacy cancels on retry-exhaustion (unchanged S4)");
});

// ── RP07: shadow is non-mutating (returns legacy action) ─────────────────────
test("RP07 shadow returns legacy action while surfacing resilient telemetry", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.2 });
  // Legacy threshold disabled (0) → legacy would NOT cancel; resilient WOULD (systemic)
  const d = decideBatchContinuation({
    policy: "shadow",
    stats: { total: 25, failedOrQuarantined: 20, legacyCounts: { failedAttemptJobs: 20, retryExhaustedJobs: 0 } },
    cfg,
    legacyThreshold: 0,
  });
  assert.equal(d.cancel, false, "shadow does NOT change behaviour (legacy threshold 0 = disabled)");
  assert.equal(d.systemic, true, "but telemetry flags it WOULD be systemic");
  assert.ok(d.reason.includes("would CANCEL"));
});

// ─── M3 EXECUTOR CONTRACT — the exact row→stats→decision mapping worker.ts uses ───
// worker.ts::stopRuleTripped (resilient) builds stats from COUNT_BATCH_RESILIENCE_STATS_SQL
// rows ({ total_jobs, failed_or_quarantined }) and acts ONLY on decision.cancel:
//   cancel === false → return false (no batch cancel; retry/quarantine proceeds)
//   cancel === true  → run the SAME durable cancel sequence S4 uses, return true
// These tests pin that mapping so the armed executor cannot silently drift.

/** Mirror of the worker.ts stats builder (Number() coercion over the SQL row). */
function statsFromRow(row: Record<string, unknown>) {
  return {
    total: Number((row as any).total_jobs ?? 0),
    failedOrQuarantined: Number((row as any).failed_or_quarantined ?? 0),
  };
}

test("RP08 executor contract: isolated failure row → cancel=false (batch continues)", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.2 });
  // 1 of 25 failed — an isolated failure. SQL returns ::int columns.
  const d = decideBatchContinuation({ policy: "resilient", stats: statsFromRow({ total_jobs: 25, failed_or_quarantined: 1 }), cfg });
  assert.equal(d.cancel, false, "worker returns false → retry/quarantine proceeds, batch NOT cancelled");
  assert.equal(d.systemic, false);
});

test("RP09 executor contract: systemic failure row → cancel=true (durable cancel sequence)", () => {
  const cfg = resolveResilienceConfig({ systemicFailFraction: 0.2 });
  const d = decideBatchContinuation({ policy: "resilient", stats: statsFromRow({ total_jobs: 25, failed_or_quarantined: 10 }), cfg });
  assert.equal(d.cancel, true, "worker runs runStopRuleCancelSequence → return true");
  assert.equal(d.systemic, true);
  // cost overrun is also systemic (independent of count)
  const costCfg = resolveResilienceConfig({ systemicFailFraction: 0.99, costBudget: 50 });
  const dc = decideBatchContinuation({ policy: "resilient", stats: { ...statsFromRow({ total_jobs: 100, failed_or_quarantined: 0 }), costSpent: 60 }, cfg: costCfg });
  assert.equal(dc.cancel, true);
});

test("RP10 executor contract: empty/NULL row coerces to zero → no cancel (fail-open safe)", () => {
  const cfg = resolveResilienceConfig();
  const d = decideBatchContinuation({ policy: "resilient", stats: statsFromRow({}), cfg });
  assert.equal(d.cancel, false, "no rows → total 0, nothing failed → never cancels");
});

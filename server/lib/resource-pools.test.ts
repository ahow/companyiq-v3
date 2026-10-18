/**
 * Phase 3 / Issue 3 — resource-pools.ts unit tests (offline, pure, DORMANT module).
 * Run: npx tsx server/lib/resource-pools.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveResourcePoolPolicy,
  DEFAULT_RESOURCE_POOL_POLICY,
  RESOURCE_POOL_POLICY_ENV,
  RESOURCE_POOL_POLICY_VERSION,
  allocateSeparatedPools,
  resolveResourcePools,
  poolsRespectCeiling,
  DEFAULT_BROWSER_RECOVERY_FRACTION,
} from "./resource-pools.js";
import { DEFAULT_CAPACITY_CONFIG, checkCeilingInvariant, type CapacityConfig } from "./capacity-config.js";

// ── RPL01: resolver precedence + fail-safe ───────────────────────────────────
test("RPL01 resolver precedence + fail-safe to shared default, never throws", () => {
  assert.equal(DEFAULT_RESOURCE_POOL_POLICY, "shared");
  assert.equal(RESOURCE_POOL_POLICY_VERSION, 1);
  const saved = process.env[RESOURCE_POOL_POLICY_ENV];
  try {
    delete process.env[RESOURCE_POOL_POLICY_ENV];
    assert.equal(resolveResourcePoolPolicy(), "shared");
    process.env[RESOURCE_POOL_POLICY_ENV] = "separated";
    assert.equal(resolveResourcePoolPolicy(), "separated");
    assert.equal(resolveResourcePoolPolicy("shadow"), "shadow"); // explicit wins
    delete process.env[RESOURCE_POOL_POLICY_ENV];
    assert.equal(resolveResourcePoolPolicy("garbage"), "shared"); // unrecognised → default
  } finally {
    if (saved === undefined) delete process.env[RESOURCE_POOL_POLICY_ENV];
    else process.env[RESOURCE_POOL_POLICY_ENV] = saved;
  }
});

// ── RPL02: split is deterministic, sums EXACTLY to total, keeps each pool ≥1 ──
test("RPL02 allocateSeparatedPools deterministic, sums to total, both pools ≥1", () => {
  const a = allocateSeparatedPools(10);
  const b = allocateSeparatedPools(10);
  assert.deepEqual(a, b, "deterministic");
  assert.equal(a.browser_recovery + a.analysis, 10, "sum == total (no capacity added)");
  assert.ok(a.browser_recovery >= 1 && a.analysis >= 1, "each pool ≥1");
  // 30% of 10 = 3 browser, 7 analysis
  assert.deepEqual(a, { browser_recovery: 3, analysis: 7 });
  // edge cases
  assert.deepEqual(allocateSeparatedPools(0), { browser_recovery: 0, analysis: 0 });
  assert.deepEqual(allocateSeparatedPools(1), { browser_recovery: 0, analysis: 1 });
  assert.equal(DEFAULT_BROWSER_RECOVERY_FRACTION, 0.3);
});

// ── RPL03: shared default is byte-identical single pool ───────────────────────
test("RPL03 shared default → single shared pool sized at B6 effective concurrency", () => {
  const cfg: CapacityConfig = { ...DEFAULT_CAPACITY_CONFIG };
  const r = resolveResourcePools({ policy: "shared", cfg });
  assert.equal(r.separated, false);
  assert.deepEqual(Object.keys(r.pools), ["shared"]);
  assert.equal(r.pools.shared, r.sharedSlots, "single pool = effective concurrency (unchanged path)");
});

// ── RPL04: separated → two pools whose sum == shared slot count ───────────────
test("RPL04 separated: two pools, combined slots never exceed the shared path", () => {
  const cfg: CapacityConfig = { ...DEFAULT_CAPACITY_CONFIG };
  const r = resolveResourcePools({ policy: "separated", cfg });
  assert.equal(r.separated, true);
  assert.deepEqual(Object.keys(r.pools).sort(), ["analysis", "browser_recovery"]);
  const sum = r.pools.browser_recovery + r.pools.analysis;
  assert.equal(sum, r.sharedSlots, "separated total == shared total (no extra capacity)");
});

// ── RPL05: INVARIANT — pools respect the B6 97-usable ceiling (reused, not re-derived)
test("RPL05 separated pools respect the capacity-config ceiling invariant", () => {
  const cfg: CapacityConfig = { ...DEFAULT_CAPACITY_CONFIG };
  const r = resolveResourcePools({ policy: "separated", cfg });
  assert.equal(r.withinBudget, true, "effective pool total within budget");
  // Direct check via the reused B6 primitive — sum of pools satisfies the invariant.
  assert.ok(poolsRespectCeiling(r.pools, cfg), "poolsRespectCeiling true");
  const sum = r.pools.browser_recovery + r.pools.analysis;
  assert.ok(checkCeilingInvariant(cfg, sum, cfg.replicaCount), "B6 invariant holds on pool sum");
  // And since separated sum == shared slots, it is EXACTLY as safe as the shared path.
  assert.ok(checkCeilingInvariant(cfg, r.sharedSlots, cfg.replicaCount));
});

test("RPL05b poolsRespectCeiling rejects an oversized layout", () => {
  const cfg: CapacityConfig = { ...DEFAULT_CAPACITY_CONFIG };
  // A deliberately oversized layout must be flagged (would breach the ceiling).
  const oversized = { browser_recovery: 50, analysis: 50 };
  assert.equal(poolsRespectCeiling(oversized, cfg), false);
});

// ── RPL06: shadow is non-mutating (returns shared pool, surfaces plan) ────────
test("RPL06 shadow returns the shared pool but surfaces the separated plan", () => {
  const cfg: CapacityConfig = { ...DEFAULT_CAPACITY_CONFIG };
  const r = resolveResourcePools({ policy: "shadow", cfg });
  assert.equal(r.separated, false, "shadow does NOT separate (non-mutating)");
  assert.deepEqual(Object.keys(r.pools), ["shared"], "effective pool is still shared");
  assert.ok(r.separatedPlan.browser_recovery >= 1 && r.separatedPlan.analysis >= 1, "but the plan is computed for telemetry");
});

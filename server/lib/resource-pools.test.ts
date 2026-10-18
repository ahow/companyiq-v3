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
  resolveBrowserPoolSlots,
  BROWSER_SEPARATED_MAX_ENV,
  DEFAULT_BROWSER_SEPARATED_MAX,
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

// ─── M4 WIRING SEAM — resolveBrowserPoolSlots (the processor.ts MAX_CONCURRENT_BROWSER source) ───

// RPL07: shared (DEFAULT) is byte-identical — slots == sharedDefault, no mutation.
test("RPL07 shared policy returns sharedDefault verbatim (byte-identical default)", () => {
  for (const sd of [1, 2, 4]) {
    const r = resolveBrowserPoolSlots({ sharedDefault: sd, policy: "shared" });
    assert.equal(r.slots, sd, "slots == sharedDefault");
    assert.equal(r.separated, false);
    assert.equal(r.policy, "shared");
  }
  // Default production value: MAX_CONCURRENT_BROWSER unset → "1".
  assert.equal(resolveBrowserPoolSlots({ sharedDefault: 1, policy: "shared" }).slots, 1);
});

// RPL08: shadow is non-mutating — slots stay sharedDefault even though a plan is computed.
test("RPL08 shadow policy is non-mutating (slots stay sharedDefault, plan surfaced)", () => {
  const r = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "shadow" });
  assert.equal(r.slots, 1, "shadow does not change concurrency");
  assert.equal(r.separated, false);
  assert.ok(r.plannedBrowserRecovery >= 1, "the separated plan is still computed for telemetry");
});

// RPL09: separated clamps the B6 browser-recovery pool into [sharedDefault, maxSeparated].
test("RPL09 separated: 1-slot bottleneck lifts to the bounded browser-recovery pool (1→3)", () => {
  // Default cfg effective concurrency 10 → browser_recovery plan = 3 (30%).
  const r = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "separated" });
  assert.equal(r.policy, "separated");
  assert.equal(r.separated, true, "slots differ from the single shared slot");
  assert.equal(r.slots, 3, "clamped to the default BROWSER_SEPARATED_MAX cap of 3");
  assert.ok(r.slots >= 1 && r.slots <= DEFAULT_BROWSER_SEPARATED_MAX, "within conservative bound");
  assert.equal(r.withinBudget, true);
});

// RPL10: separated never drops below sharedDefault and never exceeds maxSeparated.
test("RPL10 separated clamp honours both the floor (sharedDefault) and the cap (maxSeparated)", () => {
  // maxSeparated below the plan → capped at maxSeparated, but never below sharedDefault.
  const capped = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "separated", maxSeparated: 2 });
  assert.equal(capped.slots, 2, "capped at maxSeparated=2");
  // sharedDefault already above the plan → slots never regress below it.
  const floored = resolveBrowserPoolSlots({ sharedDefault: 5, policy: "separated", maxSeparated: 3 });
  assert.ok(floored.slots >= 5, "never drops below the configured sharedDefault");
});

// RPL11: separated slot layout still respects the B6 ceiling (safety invariant).
test("RPL11 separated slots respect the B6 ceiling / withinBudget", () => {
  const r = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "separated" });
  assert.equal(r.withinBudget, true);
  // The separated split sums to the shared slot count, so it is exactly as safe
  // as the shared path — the browser-recovery slice is a bounded subset.
  assert.ok(r.plannedBrowserRecovery <= DEFAULT_CAPACITY_CONFIG.replicaCount * 100, "sane plan");
});

// RPL12: BROWSER_SEPARATED_MAX env overrides the conservative cap; fail-safe parse.
test("RPL12 BROWSER_SEPARATED_MAX env caps the separated slot count", () => {
  const saved = process.env[BROWSER_SEPARATED_MAX_ENV];
  try {
    process.env[BROWSER_SEPARATED_MAX_ENV] = "2";
    const r = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "separated" });
    assert.equal(r.slots, 2, "env cap applied");
    process.env[BROWSER_SEPARATED_MAX_ENV] = "garbage";
    const r2 = resolveBrowserPoolSlots({ sharedDefault: 1, policy: "separated" });
    assert.equal(r2.slots, 3, "bad env value falls back to default cap 3");
    assert.equal(DEFAULT_BROWSER_SEPARATED_MAX, 3);
  } finally {
    if (saved === undefined) delete process.env[BROWSER_SEPARATED_MAX_ENV];
    else process.env[BROWSER_SEPARATED_MAX_ENV] = saved;
  }
});

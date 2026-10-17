/**
 * capacity-config.test.ts — B6 / WP14 committed test suite.
 *
 * Proves the connection-budget-aware worker concurrency ships SAFE and framework-level:
 *   CAP01 (HEADLINE) — the ceiling invariant
 *       effectiveConcurrency × replicaCount × connectionsPerJob + reservedOverhead
 *           ≤ dbConnectionBudget
 *     holds for the computed dynamic concurrency across a sweep of replicaCount (1..40)
 *     AND a sweep of budgets. Beyond maxSafeReplicas the checker returns false
 *     (documented "cut replicas" signal), never a silent breach.
 *   CAP02 — kill-switch default is `static`; static AND shadow leave the USED
 *           concurrency == the current production constant (byte-identical behaviour).
 *   CAP03 — dynamic mode applies the budget-derived value and can only ever LOWER
 *           concurrency as replicas grow, never raise above HARD_MAX (today's static).
 *   CAP04 — env override works (CAPACITY_POLICY + the budget knobs + replica count).
 *   CAP05 — resolveCapacityPolicy fail-safe: unrecognised/empty → `static`, total,
 *           never throws (a typo can never silently change concurrency).
 *   CAP06 — determinism: same config → same computed concurrency + same result object.
 *   CAP07 — purity/scope: no DB, no network; shadow still computes the dynamic value
 *           for logging while USING the static value.
 *
 * All deterministic — no DB, no network, no LLM. Mirrors model-cost.test.ts.
 *
 * Run: npx tsx server/lib/capacity-config.test.ts
 */

import assert from "node:assert/strict";
import {
  resolveCapacityPolicy,
  DEFAULT_CAPACITY_POLICY,
  CAPACITY_POLICY_ENV,
  CAPACITY_POLICY_VERSION,
  DEFAULT_CAPACITY_CONFIG,
  loadCapacityConfig,
  computeDynamicConcurrency,
  maxSafeReplicas,
  checkCeilingInvariant,
  totalConnectionLoad,
  resolveEffectiveConcurrency,
  type CapacityConfig,
} from "./capacity-config.js";

let pass = 0;
let fail = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`\u2713 ${name}`);
  } catch (err) {
    fail++;
    console.log(`\u2717 ${name}`);
    console.log(`    ${(err as Error)?.message ?? err}`);
  }
}

function cfg(overrides: Partial<CapacityConfig> = {}): CapacityConfig {
  return { ...DEFAULT_CAPACITY_CONFIG, ...overrides };
}

// ─── CAP01 — HEADLINE: the ceiling invariant holds across the sweep ───────────

test("CAP01 headline: dynamic concurrency satisfies the ceiling invariant for replicaCount 1..maxSafeReplicas across budget sweep", () => {
  const budgets = [60, 75, 90, 97, 120, 200];
  for (const dbConnectionBudget of budgets) {
    const base = cfg({ dbConnectionBudget });
    const maxR = maxSafeReplicas(base);
    assert.ok(maxR >= 1, `maxSafeReplicas should be >=1 for budget ${dbConnectionBudget}`);
    for (let replicaCount = 1; replicaCount <= maxR; replicaCount++) {
      const c = cfg({ dbConnectionBudget, replicaCount });
      const eff = computeDynamicConcurrency(c);
      assert.ok(eff >= 1, `concurrency must be >=1 (budget ${dbConnectionBudget}, r=${replicaCount}) got ${eff}`);
      assert.ok(
        checkCeilingInvariant(c, eff, replicaCount),
        `INVARIANT BREACH: budget=${dbConnectionBudget} r=${replicaCount} eff=${eff} ` +
          `load=${totalConnectionLoad(c, eff, replicaCount)} > budget`,
      );
    }
  }
});

test("CAP01b: beyond maxSafeReplicas the checker reports infeasible (cut replicas), never a silent breach", () => {
  const base = cfg(); // budget 90, overhead 10, cpj 2 ⇒ maxSafeReplicas 40
  assert.equal(maxSafeReplicas(base), 40, "expected maxSafeReplicas=40 for default config");
  const over = cfg({ replicaCount: 41 });
  const eff = computeDynamicConcurrency(over); // clamps to 1 for liveness
  assert.equal(eff, 1, "beyond maxSafeReplicas the min-1 liveness clamp applies");
  assert.equal(
    checkCeilingInvariant(over, eff, 41),
    false,
    "the invariant checker must FLAG the breach (1×41×2+10=92 > 90), not hide it",
  );
});

test("CAP01c: known per-replica concurrency points (default budget) match the inventory", () => {
  const expected: Record<number, number> = { 1: 10, 2: 10, 4: 10, 8: 5, 10: 4, 16: 2, 20: 2, 40: 1 };
  for (const [r, want] of Object.entries(expected)) {
    const got = computeDynamicConcurrency(cfg({ replicaCount: Number(r) }));
    assert.equal(got, want, `r=${r}: expected concurrency ${want}, got ${got}`);
  }
});

// ─── CAP02 — default is static; static/shadow are byte-identical to prod ───────

test("CAP02 default policy is `static`", () => {
  const prev = process.env[CAPACITY_POLICY_ENV];
  delete process.env[CAPACITY_POLICY_ENV];
  try {
    assert.equal(DEFAULT_CAPACITY_POLICY, "static");
    assert.equal(resolveCapacityPolicy(), "static");
    assert.equal(CAPACITY_POLICY_VERSION, 1);
  } finally {
    if (prev === undefined) delete process.env[CAPACITY_POLICY_ENV];
    else process.env[CAPACITY_POLICY_ENV] = prev;
  }
});

test("CAP02b static AND shadow USE the static concurrency (byte-identical) even when dynamic would differ", () => {
  // 10 replicas ⇒ dynamic would be 4, but static/shadow must still USE 10.
  const c = cfg({ replicaCount: 10, staticConcurrency: 10 });
  for (const policy of ["static", "shadow"] as const) {
    const r = resolveEffectiveConcurrency(c, policy);
    assert.equal(r.effectiveConcurrency, 10, `${policy}: effective must equal the static constant (10)`);
    assert.equal(r.staticConcurrency, 10);
    // shadow still COMPUTES the dynamic value for logging, but does not apply it.
    assert.equal(r.dynamicConcurrency, 4, `${policy}: dynamic should be computed (=4) for observability`);
  }
});

// ─── CAP03 — dynamic applies the value; only ever lowers, never above HARD_MAX ─

test("CAP03 dynamic applies the budget-derived value and never exceeds HARD_MAX", () => {
  for (let replicaCount = 1; replicaCount <= 40; replicaCount++) {
    const c = cfg({ replicaCount });
    const r = resolveEffectiveConcurrency(c, "dynamic");
    assert.equal(r.effectiveConcurrency, computeDynamicConcurrency(c));
    assert.ok(r.effectiveConcurrency <= DEFAULT_CAPACITY_CONFIG.hardMax, `r=${replicaCount}: must not exceed HARD_MAX`);
    assert.ok(r.effectiveConcurrency <= r.staticConcurrency, `r=${replicaCount}: dynamic must only lower, never raise`);
    assert.ok(r.withinBudget, `r=${replicaCount}: dynamic effective must be within budget`);
  }
});

test("CAP03b dynamic equals static for small replica counts (<=4) — no change there", () => {
  for (const replicaCount of [1, 2, 3, 4]) {
    const c = cfg({ replicaCount });
    assert.equal(resolveEffectiveConcurrency(c, "dynamic").effectiveConcurrency, 10, `r=${replicaCount} should stay 10`);
  }
});

// ─── CAP04 — env override ─────────────────────────────────────────────────────

test("CAP04 env overrides: policy, budget knobs, replica count all read from env", () => {
  const saved = { ...process.env };
  try {
    process.env[CAPACITY_POLICY_ENV] = "DYNAMIC"; // case/space-insensitive
    assert.equal(resolveCapacityPolicy(), "dynamic");

    process.env.WORKER_CONCURRENCY = "8";
    process.env.REPLICA_COUNT = "5";
    process.env.DB_CONNECTION_BUDGET = "50";
    process.env.DB_RESERVED_OVERHEAD = "6";
    process.env.DB_CONNECTIONS_PER_JOB = "2";
    const c = loadCapacityConfig();
    assert.equal(c.staticConcurrency, 8);
    assert.equal(c.hardMax, 8, "HARD_MAX defaults to the static concurrency");
    assert.equal(c.replicaCount, 5);
    assert.equal(c.dbConnectionBudget, 50);
    assert.equal(c.reservedOverhead, 6);
    // dynamic: floor((50-6)/5/2)=floor(4.4)=4, clamped to hardMax 8 ⇒ 4
    assert.equal(computeDynamicConcurrency(c), 4);
  } finally {
    for (const k of ["WORKER_CONCURRENCY", "REPLICA_COUNT", "DB_CONNECTION_BUDGET", "DB_RESERVED_OVERHEAD", "DB_CONNECTIONS_PER_JOB", CAPACITY_POLICY_ENV]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("CAP04b RAILWAY_REPLICA_COUNT is read when REPLICA_COUNT is absent; floor 1", () => {
  const saved = { ...process.env };
  try {
    delete process.env.REPLICA_COUNT;
    process.env.RAILWAY_REPLICA_COUNT = "7";
    assert.equal(loadCapacityConfig().replicaCount, 7);
    delete process.env.RAILWAY_REPLICA_COUNT;
    assert.equal(loadCapacityConfig().replicaCount, 1, "missing replica env ⇒ floor 1");
  } finally {
    for (const k of ["REPLICA_COUNT", "RAILWAY_REPLICA_COUNT"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ─── CAP05 — fail-safe resolve ────────────────────────────────────────────────

test("CAP05 resolveCapacityPolicy fail-safe: unrecognised/empty → static, never throws", () => {
  const saved = process.env[CAPACITY_POLICY_ENV];
  try {
    for (const bad of ["", "   ", "autoscale", "on", "off", "DyNaMiX", "123"]) {
      process.env[CAPACITY_POLICY_ENV] = bad;
      assert.equal(resolveCapacityPolicy(), "static", `env="${bad}" should fall back to static`);
    }
    // explicit arg beats env; a bad explicit arg also falls back
    process.env[CAPACITY_POLICY_ENV] = "dynamic";
    assert.equal(resolveCapacityPolicy("static"), "static", "explicit arg wins");
    assert.equal(resolveCapacityPolicy("nope" as any), "dynamic", "bad explicit arg ⇒ env used");
  } finally {
    if (saved === undefined) delete process.env[CAPACITY_POLICY_ENV];
    else process.env[CAPACITY_POLICY_ENV] = saved;
  }
});

test("CAP05b loadCapacityConfig tolerates garbage env values (falls back to defaults)", () => {
  const saved = { ...process.env };
  try {
    process.env.DB_CONNECTION_BUDGET = "not-a-number";
    process.env.REPLICA_COUNT = "-3";
    process.env.DB_CONNECTIONS_PER_JOB = "0";
    const c = loadCapacityConfig();
    assert.equal(c.dbConnectionBudget, DEFAULT_CAPACITY_CONFIG.dbConnectionBudget);
    assert.equal(c.replicaCount, 1, "negative replica count floors to 1");
    assert.equal(c.connectionsPerJob, DEFAULT_CAPACITY_CONFIG.connectionsPerJob, "0 ⇒ default");
  } finally {
    for (const k of ["DB_CONNECTION_BUDGET", "REPLICA_COUNT", "DB_CONNECTIONS_PER_JOB"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ─── CAP06 — determinism ──────────────────────────────────────────────────────

test("CAP06 determinism: same config → identical computed concurrency + result object", () => {
  const c = cfg({ replicaCount: 8 });
  const a = resolveEffectiveConcurrency(c, "dynamic");
  const b = resolveEffectiveConcurrency(c, "dynamic");
  assert.deepEqual(a, b);
  assert.equal(computeDynamicConcurrency(c), computeDynamicConcurrency(c));
});

// ─── CAP07 — purity / scope ───────────────────────────────────────────────────

test("CAP07 pure: functions do not require DATABASE_URL and shadow computes-but-does-not-apply", () => {
  // No env at all beyond defaults — nothing here touches the DB.
  const c = cfg({ replicaCount: 20 }); // dynamic would be 2
  const shadow = resolveEffectiveConcurrency(c, "shadow");
  assert.equal(shadow.effectiveConcurrency, 10, "shadow USES static (10)");
  assert.equal(shadow.dynamicConcurrency, 2, "shadow COMPUTES dynamic (2) for logging");
  assert.notEqual(shadow.effectiveConcurrency, shadow.dynamicConcurrency, "shadow must not apply the dynamic value");
});

// ─── summary ──────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

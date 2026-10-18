/**
 * Phase 3 / Issue 3 — pipeline-time-budget.ts unit tests (offline, pure).
 * Run: npx tsx server/lib/pipeline-time-budget.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePipelineTimeBudgetPolicy,
  DEFAULT_PIPELINE_TIME_BUDGET_POLICY,
  PIPELINE_TIME_BUDGET_POLICY_ENV,
  PIPELINE_TIME_BUDGET_POLICY_VERSION,
  legacyWallclockMs,
  allocateStageBudgets,
  resolveEffectiveBudget,
  evaluateTimeBudget,
  retainEvidence,
  TIME_DEGRADED_SOURCE_STATE,
  DEFAULT_STAGE_BUDGET_SPECS,
  type ResolvedPipelineBudget,
} from "./pipeline-time-budget.js";
import { isRetryable, isConclusiveAbsence } from "../../shared/research-state.js";

// ── PTB01: resolver — default, env, explicit, fail-safe ──────────────────────
test("PTB01 resolver precedence + fail-safe to default, never throws", () => {
  assert.equal(DEFAULT_PIPELINE_TIME_BUDGET_POLICY, "wallclock");
  assert.equal(PIPELINE_TIME_BUDGET_POLICY_VERSION, 1);
  const saved = process.env[PIPELINE_TIME_BUDGET_POLICY_ENV];
  try {
    delete process.env[PIPELINE_TIME_BUDGET_POLICY_ENV];
    assert.equal(resolvePipelineTimeBudgetPolicy(), "wallclock");
    process.env[PIPELINE_TIME_BUDGET_POLICY_ENV] = "budgeted";
    assert.equal(resolvePipelineTimeBudgetPolicy(), "budgeted");
    // explicit overrides env
    assert.equal(resolvePipelineTimeBudgetPolicy("shadow"), "shadow");
    // unrecognised explicit falls through to env (still "budgeted" here)
    assert.equal(resolvePipelineTimeBudgetPolicy("garbage"), "budgeted");
    // unrecognised env with no explicit → default
    process.env[PIPELINE_TIME_BUDGET_POLICY_ENV] = "nonsense";
    assert.equal(resolvePipelineTimeBudgetPolicy(), "wallclock");
    // unrecognised explicit AND unset env → default
    delete process.env[PIPELINE_TIME_BUDGET_POLICY_ENV];
    assert.equal(resolvePipelineTimeBudgetPolicy("garbage"), "wallclock");
  } finally {
    if (saved === undefined) delete process.env[PIPELINE_TIME_BUDGET_POLICY_ENV];
    else process.env[PIPELINE_TIME_BUDGET_POLICY_ENV] = saved;
  }
});

// ── PTB02: wallclock default returns legacy number, NO per-stage budgets ──────
test("PTB02 wallclock default is byte-identical legacy single deadline", () => {
  const b = resolveEffectiveBudget({ policy: "wallclock", totalBudgetMs: 2_100_000 });
  assert.equal(b.totalBudgetMs, 2_100_000);
  assert.deepEqual(b.perStageBudgetMs, {}); // no per-stage budgets at default
  // legacyWallclockMs honours env override, defaults to 540000
  assert.equal(legacyWallclockMs({} as NodeJS.ProcessEnv), 540000);
  assert.equal(legacyWallclockMs({ PIPELINE_TIMEOUT_MS: "2100000" } as any), 2_100_000);
});

// ── PTB03: stage allocation is deterministic + sums to total ──────────────────
test("PTB03 allocateStageBudgets deterministic, weighted, sums exactly to total", () => {
  const total = 1_000_000;
  const a = allocateStageBudgets(total, DEFAULT_STAGE_BUDGET_SPECS);
  const b = allocateStageBudgets(total, DEFAULT_STAGE_BUDGET_SPECS);
  assert.deepEqual(a, b, "deterministic");
  const sum = Object.values(a).reduce((x, y) => x + y, 0);
  assert.equal(sum, total, "allocations sum to total (last stage absorbs remainder)");
  // weight order: fetch(4) > analysis(3) > extraction(2) > discovery(1)
  assert.ok(a.fetch > a.analysis && a.analysis > a.extraction && a.extraction > a.discovery);
});

test("PTB03b allocation honours min/max floors/ceilings", () => {
  const specs = [
    { stage: "a", weight: 1, minMs: 100 },
    { stage: "b", weight: 100, maxMs: 500 },
  ];
  const a = allocateStageBudgets(1000, specs);
  assert.ok(a.a >= 100, "min floor respected");
  assert.ok(a.b <= 500, "max ceiling respected");
});

// ── PTB04: wallclock evaluate — stop only at hard deadline, never degrades ────
test("PTB04 wallclock evaluate: continue < deadline, stop_pipeline >= deadline, never degrades", () => {
  const budget = resolveEffectiveBudget({ policy: "wallclock", totalBudgetMs: 1000 });
  const stages = [{ stage: "fetch", elapsedMs: 999999, completed: false }];
  const cont = evaluateTimeBudget({ budget, elapsedMs: 500, stages });
  assert.equal(cont.action, "continue");
  assert.deepEqual(cont.degradedStages, [], "wallclock NEVER degrades a stage");
  const stop = evaluateTimeBudget({ budget, elapsedMs: 1000, stages });
  assert.equal(stop.action, "stop_pipeline");
  assert.deepEqual(stop.degradedStages, []);
});

// ── PTB05: budgeted evaluate — stalled stage degrades its SOURCE, pipeline continues
test("PTB05 budgeted: one stalled stage degrades its source, pipeline CONTINUES", () => {
  const budget = resolveEffectiveBudget({
    policy: "budgeted",
    totalBudgetMs: 1000,
    specs: [
      { stage: "fetch", weight: 1 },   // 500ms
      { stage: "analysis", weight: 1 },// 500ms
    ],
  });
  // fetch stalled past its 500ms budget; total elapsed still < 1000 hard
  const d = evaluateTimeBudget({
    budget,
    elapsedMs: 600,
    stages: [
      { stage: "fetch", elapsedMs: 550, completed: false, hasEvidence: true },
      { stage: "analysis", elapsedMs: 0, completed: false },
    ],
  });
  assert.equal(d.action, "degrade_stage", "degrade, NOT stop the whole pipeline");
  assert.deepEqual(d.degradedStages, ["fetch"]);
  assert.equal(d.degradedSourceState, "transient_unavailable");
});

// ── PTB06: INVARIANT — degraded source is retryable, NOT a conclusive absence ─
test("PTB06 degraded source state is retryable + not conclusive absence (never a 'No')", () => {
  assert.equal(TIME_DEGRADED_SOURCE_STATE, "transient_unavailable");
  assert.ok(isRetryable(TIME_DEGRADED_SOURCE_STATE), "must be retryable");
  assert.ok(!isConclusiveAbsence(TIME_DEGRADED_SOURCE_STATE), "must NOT be conclusive absence");
});

// ── PTB07: INVARIANT — evidence is NEVER dropped by any decision ──────────────
test("PTB07 evidence retained by reference regardless of action (constraint 4)", () => {
  const budget = resolveEffectiveBudget({ policy: "budgeted", totalBudgetMs: 100, specs: [{ stage: "fetch", weight: 1 }] });
  const evidence = [{ id: 1, text: "already retrieved" }, { id: 2, text: "keep me" }];
  for (const elapsed of [10, 150, 999999]) {
    const d = evaluateTimeBudget({
      budget,
      elapsedMs: elapsed,
      stages: [{ stage: "fetch", elapsedMs: elapsed, completed: false, hasEvidence: true }],
    });
    assert.equal(d.evidenceRetained, true, "evidenceRetained flag always true");
    const kept = retainEvidence(evidence, d);
    assert.equal(kept, evidence, "same reference returned (no copy, no drop)");
    assert.equal(kept.length, 2, "nothing dropped");
    assert.deepEqual(kept, [{ id: 1, text: "already retrieved" }, { id: 2, text: "keep me" }]);
  }
});

// ── PTB08: shadow mode is non-mutating (action mirrors wallclock) ─────────────
test("PTB08 shadow: computes degraded set for telemetry but action mirrors wall-clock", () => {
  const shadow = resolveEffectiveBudget({
    policy: "shadow",
    totalBudgetMs: 1000,
    specs: [{ stage: "fetch", weight: 1 }, { stage: "analysis", weight: 1 }],
  });
  const stages = [
    { stage: "fetch", elapsedMs: 900, completed: false }, // over its ~500 budget
    { stage: "analysis", elapsedMs: 0, completed: false },
  ];
  // Below hard total → wallclock would "continue"; shadow must also "continue"
  const belowHard = evaluateTimeBudget({ budget: shadow, elapsedMs: 900, stages });
  assert.equal(belowHard.action, "continue", "shadow does NOT change behaviour");
  assert.ok(belowHard.degradedStages.includes("fetch"), "but telemetry shows it WOULD degrade");
  // Compare to wallclock on identical inputs → same action
  const wc: ResolvedPipelineBudget = { policy: "wallclock", totalBudgetMs: 1000, perStageBudgetMs: {} };
  const wcDec = evaluateTimeBudget({ budget: wc, elapsedMs: 900, stages });
  assert.equal(belowHard.action, wcDec.action, "shadow action == wallclock action");
});

// ── PTB09: completed stages are never degraded ───────────────────────────────
test("PTB09 a completed stage is never degraded even if it ran long", () => {
  const budget = resolveEffectiveBudget({ policy: "budgeted", totalBudgetMs: 1000, specs: [{ stage: "fetch", weight: 1 }] });
  const d = evaluateTimeBudget({
    budget,
    elapsedMs: 500,
    stages: [{ stage: "fetch", elapsedMs: 999999, completed: true }],
  });
  assert.equal(d.action, "continue");
  assert.deepEqual(d.degradedStages, []);
});

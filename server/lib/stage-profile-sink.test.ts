// WP10 — per-stage wall-clock profiler unit tests.
// Run: node --import tsx --test server/lib/stage-profile-sink.test.ts
//
// Exercises the PURE builder (buildStageProfileRows), which needs no DB. The
// contract: one finished attempt-timer expands into one row per stage PLUS one
// attempt-total row (stage '*'), each self-describing with full attribution so
// a batch run's per-stage and per-job wall-clock is queryable afterwards.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStageProfileRows,
  STAGE_PROFILE_COLS,
  type StageProfileSummary,
} from "./stage-profile-sink.js";

const C = {
  workspace_id: 0, batch_id: 1, job_id: 2, attempt_id: 3, attempt_n: 4,
  company_id: 5, framework_id: 6, timer_kind: 7, timer_label: 8, outcome: 9,
  stage: 10, done: 11, errors: 12, pending: 13, busy_sum_ms: 14,
  union_wall_ms: 15, attempt_wall_ms: 16, tracked_wall_ms: 17,
  started_at: 18, emit_ts: 19,
} as const;

function sample(): StageProfileSummary {
  return {
    timerKind: "attempt",
    timerLabel: "pipeline",
    outcome: "completed",
    startedAtIso: "2026-02-02T10:00:00.000Z",
    attemptWallMs: 12000,
    trackedWallMs: 11000,
    stages: {
      discovery: { done: 3, errors: 0, pending: 0, busy_sum_ms: 4000, union_wall_ms: 3500 },
      fetch: { done: 10, errors: 2, pending: 1, busy_sum_ms: 6000, union_wall_ms: 5000 },
      scoring: { done: 8, errors: 1, pending: 0, busy_sum_ms: 2500, union_wall_ms: 2500 },
    },
    attribution: {
      workspaceId: 1, batchId: 100, jobId: 200, attemptId: "att-xyz",
      attemptNumber: 2, companyId: 300, frameworkId: 400,
    },
  };
}

test("emits one row per stage PLUS one attempt-total row (stage '*')", () => {
  const rows = buildStageProfileRows(sample());
  assert.equal(rows.length, 4); // 3 stages + 1 total
  const stages = rows.map((r) => r[C.stage]);
  assert.deepEqual(new Set(stages), new Set(["discovery", "fetch", "scoring", "*"]));
});

test("every row carries full attribution and fixed column count", () => {
  const rows = buildStageProfileRows(sample());
  for (const r of rows) {
    assert.equal(r.length, STAGE_PROFILE_COLS);
    assert.equal(STAGE_PROFILE_COLS, 20);
    assert.equal(r[C.workspace_id], 1);
    assert.equal(r[C.batch_id], 100);
    assert.equal(r[C.job_id], 200);
    assert.equal(r[C.attempt_id], "att-xyz");
    assert.equal(r[C.attempt_n], 2);
    assert.equal(r[C.company_id], 300);
    assert.equal(r[C.framework_id], 400);
    assert.equal(r[C.timer_kind], "attempt");
    assert.equal(r[C.timer_label], "pipeline");
    assert.equal(r[C.outcome], "completed");
    assert.equal(r[C.started_at], "2026-02-02T10:00:00.000Z");
    // timer-level wall-clock repeated on every row for cheap per-job queries.
    assert.equal(r[C.attempt_wall_ms], 12000);
    assert.equal(r[C.tracked_wall_ms], 11000);
    assert.ok(!Number.isNaN(Date.parse(String(r[C.emit_ts]))));
  }
});

test("per-stage rows carry that stage's own counters (joinable by stage, not order)", () => {
  const rows = buildStageProfileRows(sample());
  const fetch = rows.find((r) => r[C.stage] === "fetch")!;
  assert.equal(fetch[C.done], 10);
  assert.equal(fetch[C.errors], 2);
  assert.equal(fetch[C.pending], 1);
  assert.equal(fetch[C.busy_sum_ms], 6000);
  assert.equal(fetch[C.union_wall_ms], 5000);
});

test("attempt-total row ('*') sums stage counters so job-level needs no re-aggregation", () => {
  const rows = buildStageProfileRows(sample());
  const total = rows.find((r) => r[C.stage] === "*")!;
  assert.equal(total[C.done], 3 + 10 + 8);
  assert.equal(total[C.errors], 0 + 2 + 1);
  assert.equal(total[C.pending], 0 + 1 + 0);
  assert.equal(total[C.busy_sum_ms], 4000 + 6000 + 2500);
  // union on the total row ≈ tracked attempt wall-clock.
  assert.equal(total[C.union_wall_ms], 11000);
});

test("a timer with no stages still emits exactly the attempt-total row", () => {
  const s = sample();
  s.stages = {};
  const rows = buildStageProfileRows(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][C.stage], "*");
  assert.equal(rows[0][C.done], 0);
  assert.equal(rows[0][C.errors], 0);
});

test("missing attribution degrades to NULLs, never throws", () => {
  const s = sample();
  s.attribution = {};
  const rows = buildStageProfileRows(s);
  const total = rows.find((r) => r[C.stage] === "*")!;
  assert.equal(total[C.workspace_id], null);
  assert.equal(total[C.job_id], null);
  assert.equal(total[C.company_id], null);
});

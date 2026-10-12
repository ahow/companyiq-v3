/**
 * Batch stop rule S4 tests (lib/batch-stop-rule.ts). Deterministic, no network, no paid calls.
 * Run: npx tsx server/lib/batch-stop-rule.test.ts
 * Optional SQL check against the local integration Postgres (read/write only to a TEMP table):
 *   STOP_RULE_TEST_PG=postgres://ciq:ciq@127.0.0.1:55432/ciq npx tsx server/lib/batch-stop-rule.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readStopRuleThreshold, decideBatchStop, enforceBatchStopRule, isStopRuleFailure,
  COUNT_BATCH_FAILURES_SQL, STOP_RULE_ENV, runStopRuleCancelSequence, type BatchFailureCounts,
} from "./batch-stop-rule.js";

const SPAWN_ABORT = "Isolated job child exited unexpectedly (code=null signal=SIGABRT stage=spawn)";

test("threshold: unset / 0 / junk → disabled (legacy behaviour unchanged)", () => {
  assert.equal(readStopRuleThreshold({}), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "" }), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "0" }), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "-2" }), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "two" }), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "1.5" }), 0);
  assert.equal(readStopRuleThreshold({ [STOP_RULE_ENV]: "2" }), 2);
});

test("decision: ≥ threshold failed jobs, or any retry-exhausted job, stops", () => {
  assert.equal(decideBatchStop({ failedAttemptJobs: 5, retryExhaustedJobs: 3 }, 0).stop, false);
  assert.equal(decideBatchStop({ failedAttemptJobs: 1, retryExhaustedJobs: 0 }, 2).stop, false);
  assert.equal(decideBatchStop({ failedAttemptJobs: 2, retryExhaustedJobs: 0 }, 2).stop, true);
  assert.equal(decideBatchStop({ failedAttemptJobs: 1, retryExhaustedJobs: 1 }, 2).stop, true);
});

test("cancellation and provider-quota pauses are not S4 failures", () => {
  assert.equal(isStopRuleFailure("Cancelled (batch cancelled)"), false);
  assert.equal(isStopRuleFailure("provider_paused:quota_exhausted:..."), false);
  assert.equal(isStopRuleFailure(""), false);
  assert.equal(isStopRuleFailure(SPAWN_ABORT), true);
});

test("enforce: disabled never counts or cancels", async () => {
  let counted = 0, cancelled = 0;
  const stopped = await enforceBatchStopRule(1, 1, SPAWN_ABORT, {
    threshold: 0, countFailures: async () => { counted++; return { failedAttemptJobs: 99, retryExhaustedJobs: 99 }; },
    cancelBatch: async () => { cancelled++; }, log: () => {},
  });
  assert.equal(stopped, false); assert.equal(counted, 0); assert.equal(cancelled, 0);
});

test("enforce: count error fails open to the legacy retry path (no cancel)", async () => {
  let cancelled = 0; const logs: string[] = [];
  const stopped = await enforceBatchStopRule(1, 1, SPAWN_ABORT, {
    threshold: 2, countFailures: async () => { throw new Error("pg down"); },
    cancelBatch: async () => { cancelled++; }, log: (l) => logs.push(l),
  });
  assert.equal(stopped, false); assert.equal(cancelled, 0);
  assert.match(logs[0], /count failed/);
});

test("enforce: cancel-sequence error still suppresses the retry", async () => {
  const stopped = await enforceBatchStopRule(1, 1, SPAWN_ABORT, {
    threshold: 2, countFailures: async () => ({ failedAttemptJobs: 2, retryExhaustedJobs: 0 }),
    cancelBatch: async () => { throw new Error("redis down"); }, log: () => {},
  });
  assert.equal(stopped, true);
});

/**
 * Batch-1276-shaped simulation of the worker failure branch (worker.ts:
 * failJob → [stop rule] → retry-or-final), using storage.failJob's status rule
 * (attempts >= 3 → 'failed', else 'pending') and MAX_RETRY_ATTEMPTS = 3.
 * 25 jobs, WORKER_CONCURRENCY-style 8 in flight across replicas, 13 jobs whose
 * child always aborts at spawn (as observed), 12 that succeed.
 */
async function simulate(threshold: number) {
  let countCalls = 0; const steps: string[] = []; let attemptsAfterTrip = 0;
  const MAX = 3, N = 25, FAILING = new Set([1, 2, 4, 6, 7, 9, 11, 13, 15, 17, 19, 21, 23]);
  type J = { id: number; attempts: number; status: string; lastError: string | null };
  const jobs = new Map<number, J>(Array.from({ length: N }, (_, i) => [i, { id: i, attempts: 0, status: "pending", lastError: null }]));
  const queue: number[] = [...jobs.keys()];
  let cancelled = false, failedAttempts = 0, retriesEnqueued = 0, failedJobsCounter = 0;
  const count = async (): Promise<BatchFailureCounts> => {
    countCalls++;
    const a = [...jobs.values()];
    const f = (j: J) => j.lastError != null && isStopRuleFailure(j.lastError);
    return { failedAttemptJobs: a.filter((j) => j.status !== "completed" && f(j)).length, retryExhaustedJobs: a.filter((j) => j.status === "failed" && f(j)).length };
  };
  while (queue.length && !cancelled) {
    const wave = queue.splice(0, 8);
    for (const id of wave) {
      if (cancelled) { attemptsAfterTrip++; break; } // claimJob's PG fence refuses jobs of a cancelled batch
      const j = jobs.get(id)!; j.attempts++;
      if (!FAILING.has(id)) { j.status = "completed"; continue; }
      failedAttempts++;
      j.lastError = SPAWN_ABORT; j.status = j.attempts >= MAX ? "failed" : "pending";
      const stopped = await enforceBatchStopRule(7, id, SPAWN_ABORT, {
        threshold, countFailures: count, log: () => {},
        cancelBatch: (bid, reason) => runStopRuleCancelSequence(bid, reason, {
          flag: () => { steps.push("flag"); cancelled = true; },
          purge: async () => { steps.push("purge"); queue.length = 0; },
          snapshot: async () => { steps.push("snapshot"); },
          pgCancel: async () => { steps.push("pgCancel"); },
          log: () => {},
        }),
      });
      if (stopped) continue;
      if (j.attempts < MAX) { retriesEnqueued++; queue.push(id); } else failedJobsCounter++;
    }
  }
  return { cancelled, countCalls, steps, attemptsAfterTrip, queued: queue.length, failedAttempts, retriesEnqueued, failedJobsCounter, exhausted: [...jobs.values()].filter((j) => j.status === "failed").length };
}

test("batch-1276 shape WITHOUT the rule: 13 jobs exhaust retries (39 failed attempts)", async () => {
  const r = await simulate(0);
  assert.equal(r.cancelled, false);
  assert.equal(r.exhausted, 13);
  assert.equal(r.failedAttempts, 39);
  assert.equal(r.failedJobsCounter, 13);
});

test("batch-1276 shape WITH BATCH_STOP_RULE_FAILED_JOBS=2: stops at the 2nd failed job, before any job exhausts retries", async () => {
  const r = await simulate(readStopRuleThreshold({ [STOP_RULE_ENV]: "2" }));
  assert.equal(r.cancelled, true);
  assert.equal(r.failedAttempts, 2);
  assert.equal(r.retriesEnqueued, 1); // job #1's first failure (1 < threshold) retries; job #2 trips S4
  assert.equal(r.exhausted, 0);
});

test("worker default (env unset): retry path byte-for-byte legacy — rule never counts, never cancels", async () => {
  const saved = process.env[STOP_RULE_ENV]; delete process.env[STOP_RULE_ENV];
  try {
    const r = await simulate(readStopRuleThreshold()); // what worker.stopRuleTripped reads
    assert.equal(r.countCalls, 0, "no DB count at threshold 0");
    assert.deepEqual(r.steps, [], "no cancel sequence");
    assert.equal(r.retriesEnqueued, 26); // 13 jobs × 2 retries — unchanged legacy behaviour
    assert.equal(r.exhausted, 13);
  } finally { if (saved !== undefined) process.env[STOP_RULE_ENV] = saved; }
});

test("threshold N=3: Nth failed job trips → batch cancelled, snapshot saved, queue purged, no further retries/claims", async () => {
  const r = await simulate(3);
  assert.equal(r.cancelled, true);
  assert.equal(r.failedAttempts, 3, "stops on the 3rd failed attempt");
  assert.deepEqual(r.steps, ["flag", "purge", "snapshot", "pgCancel"], "POST /batch/cancel order, snapshot included");
  assert.equal(r.queued, 0, "queued jobs purged");
  assert.equal(r.retriesEnqueued, 2, "only the 2 sub-threshold failures retried; the tripping failure is not re-enqueued");
  assert.equal(r.exhausted, 0);
});

test("cancel sequence: purge/snapshot errors are non-fatal; PG cancel still runs", async () => {
  const steps: string[] = []; const logs: string[] = [];
  await runStopRuleCancelSequence(9, "stop rule S4", {
    flag: () => { steps.push("flag"); },
    purge: async () => { steps.push("purge"); throw new Error("redis down"); },
    snapshot: async () => { steps.push("snapshot"); throw new Error("snapshot failed"); },
    pgCancel: async (_b, reason) => { steps.push(`pgCancel:${reason}`); },
    log: (l) => logs.push(l),
  });
  assert.deepEqual(steps, ["flag", "purge", "snapshot", "pgCancel:stop rule S4"]);
  assert.equal(logs.length, 2);
});

test("SQL: COUNT_BATCH_FAILURES_SQL counts first failed attempts and exhaustion (optional, local PG)", { skip: !process.env.STOP_RULE_TEST_PG }, async () => {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.STOP_RULE_TEST_PG });
  await c.connect();
  try {
    await c.query("CREATE TEMP TABLE analysis_jobs (id serial, batch_id int, status text, last_error text)");
    await c.query(`INSERT INTO analysis_jobs (batch_id, status, last_error) VALUES
      (7,'pending',$1), (7,'running',$1), (7,'failed',$1), (7,'completed',$1), (7,'completed',NULL),
      (7,'failed','Cancelled (batch cancelled)'), (7,'pending','provider_paused:quota_exhausted:x'),
      (8,'failed',$1)`, [SPAWN_ABORT]);
    const r = await c.query(COUNT_BATCH_FAILURES_SQL, [7]);
    assert.deepEqual(r.rows[0], { failed_attempt_jobs: 3, retry_exhausted_jobs: 1 });
  } finally { await c.end(); }
});

/**
 * Operation-scoped cancellation (batch-1277 fix) — behavioural tests against the
 * REAL production functions and their real in-process broker, NOT copied
 * simulations.
 *
 * What is exercised here (no Chromium, no DB, no Redis, zero paid calls):
 *   - the production replica browser-permit broker (acquireBrowserSlot /
 *     releaseBrowserSlot, reached through the exported processorSlotBroker.browser
 *     that job-isolation uses in production), driven by a real OperationScope;
 *   - the production fetchIssuerPdfsWithPrimedSession admission path, which
 *     withdraws a queued recovery from the broker at the company deadline and
 *     marks every URL explicitly incomplete (admission_timeout) WITHOUT launching
 *     a browser, consuming the permit, or recording any false success;
 *   - the real createOperationScope primitive (absolute deadline → abort; abort
 *     composed with the attempt-lifecycle/revocation signal via AbortSignal.any).
 *
 * The complementary paths that need a real Chromium and real isolated children —
 * timeout while HOLDING the permit (abort → page closed → browser reaped → permit
 * returned), cancellation in-flight / post-acquire / pre-acquire, child-death
 * reap-before-release, and a healthy end-to-end extraction with no regression —
 * are covered by the sibling suite browser-close-order.test.ts, which this change
 * keeps green (run it alongside this file).
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/operation-scoped-cancellation.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// The operation-scope deadline timer is unref'd (exactly as in production, where
// live sockets keep the loop alive). With no sockets here, keep the event loop
// alive so those timers can fire and the tests settle; cleared in test.after.
const keepAlive = setInterval(() => {}, 1000);

// Test-only environment, set BEFORE importing the processor so the module reads
// a per-replica browser limit of 1 (the production default) and stays on the
// LOCAL (non-isolated) broker path — CIQ_ISOLATED_CHILD is deliberately unset.
Object.assign(process.env, {
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const {
  createOperationScope,
  isOperationAbortedError,
  createAttemptLifecycle,
  revokeAttempt,
} = await import("./lifecycle-fence.js");
const { runWithDiagContext } = await import("./diag-context.js");
const { processorSlotBroker, fetchIssuerPdfsWithPrimedSession } = await import("./processor.js");

const b = processorSlotBroker.browser;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fail loudly if a prior test leaked the single permit (tests run sequentially).
function assertDrained(where: string) {
  const s = b.state();
  assert.equal(s.active, 0, `${where}: permit leaked (active=${s.active})`);
  assert.equal(s.waiting, 0, `${where}: waiter leaked (waiting=${s.waiting})`);
}

// ── Suite A — real replica broker: queued-waiter cancellation ────────────────

test("A1 queued waiter withdraws from the broker at its deadline and is NEVER granted", async () => {
  assertDrained("A1 pre");
  await b.acquire(); // hold the only permit (no scope)
  assert.equal(b.state().active, 1);

  const scope = createOperationScope({ budgetMs: 150 });
  const t0 = Date.now();
  let err: any;
  try {
    await b.acquire(scope); // queues behind the held permit
  } catch (e) {
    err = e;
  }
  const waited = Date.now() - t0;

  assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.reason, "deadline_elapsed");
  assert.equal(b.state().waiting, 0, "aborted waiter removed itself from the broker queue");
  assert.equal(b.state().active, 1, "aborted waiter never consumed the held permit");
  assert.ok(waited >= 140 && waited < 3000, `gave up at ~deadline (waited=${waited}ms)`);

  scope.dispose();
  await b.release(); // release the originally-held permit
  assertDrained("A1 post");
});

test("A2 the next waiting operation is admitted promptly once the holder releases", async () => {
  assertDrained("A2 pre");
  await b.acquire(); // A holds
  const scope = createOperationScope({ budgetMs: 10_000 });
  const p = b.acquire(scope); // B queues
  await sleep(20);
  assert.equal(b.state().waiting, 1, "B is queued");

  const t0 = Date.now();
  await b.release(); // A releases → direct hand-off to B
  await p; // B admitted
  const lat = Date.now() - t0;

  assert.ok(lat < 250, `B admitted promptly after release (lat=${lat}ms)`);
  assert.equal(b.state().active, 1, "B now holds exactly one permit");
  assert.equal(b.state().waiting, 0);

  scope.dispose();
  await b.release(); // B releases
  assertDrained("A2 post");
});

test("A3a grant/abort race — abort BEFORE release: waiter rejects, permit returns cleanly to the pool", async () => {
  assertDrained("A3a pre");
  await b.acquire(); // A holds the only permit
  const scope = createOperationScope({ budgetMs: 30 });
  const outcome = await b.acquire(scope).then(
    () => "granted",
    (e) => { if (!isOperationAbortedError(e)) throw e; return "aborted"; },
  );
  assert.equal(outcome, "aborted", "B aborted at its deadline while A still held the permit");
  assert.equal(b.state().waiting, 0, "B withdrew from the queue");
  assert.equal(b.state().active, 1, "A still holds exactly one permit — no phantom grant to B");

  await b.release(); // A releases; the queue is empty, so the permit returns to the pool
  assert.equal(b.state().active, 0, "no leak after abort-then-release");
  scope.dispose();
  assertDrained("A3a post");
});

test("A3b grant/abort race — abort AFTER grant: the late deadline is a no-op, permit not leaked or double-counted", async () => {
  assertDrained("A3b pre");
  await b.acquire(); // A holds
  const scope = createOperationScope({ budgetMs: 40 });
  const p = b.acquire(scope); // B queues
  await sleep(10);
  assert.equal(b.state().waiting, 1, "B is queued");

  await b.release(); // A releases → B granted at ~10ms (well before the 40ms deadline)
  await p;
  assert.equal(b.state().active, 1, "B holds exactly one permit");
  assert.equal(b.state().waiting, 0);

  await sleep(60); // let B's 40ms deadline fire AFTER the grant — it must be a no-op
  assert.equal(b.state().active, 1, "abort after grant did not release B's held permit");
  assert.equal(b.state().waiting, 0);

  await b.release(); // B releases normally
  assert.equal(b.state().active, 0, "no leak after grant-then-abort");
  scope.dispose();
  assertDrained("A3b post");
});

// ── Suite B — real recovery function: deferred-sweep admission expiry ─────────

test("B expired queued recovery attempts 0 URLs, marks them incomplete (admission_timeout), consumes no budget/permit", async () => {
  assertDrained("B pre");
  await b.acquire(); // hold the only permit so recovery must queue for admission

  const origin = "http://127.0.0.1:1"; // never contacted: we abort before any launch
  const urls = [`${origin}/a.pdf`, `${origin}/b.pdf`, `${origin}/c.pdf`];
  const outcomes: Array<{ url: string; ok: boolean; reason: string }> = [];
  const scope = createOperationScope({ budgetMs: 150 });

  const t0 = Date.now();
  const recovered = await fetchIssuerPdfsWithPrimedSession(origin, urls, {
    scope,
    outcomes,
    // A large ACTIVE per-origin budget: it must not even start, because admission
    // never happens — the queued waiter gives up at the company (scope) deadline.
    overallBudgetMs: 600_000,
    perPdfTimeoutMs: 45_000,
  });
  const waited = Date.now() - t0;

  assert.equal(recovered.size, 0, "no PDFs recovered — the operation was never admitted");
  assert.equal(outcomes.length, urls.length, "one outcome recorded per URL");
  for (const o of outcomes) {
    assert.equal(o.ok, false, `URL not researched: ${o.url}`);
    assert.equal(o.reason, "admission_timeout", `URL marked explicitly incomplete/pending: ${o.url}`);
  }
  assert.ok(waited >= 140 && waited < 5000, `gave up at the company deadline while queued (waited=${waited}ms)`);
  assert.equal(b.state().waiting, 0, "recovery waiter withdrew from the broker queue");
  assert.equal(b.state().active, 1, "held permit untouched; recovery never consumed it");

  scope.dispose();
  await b.release();
  assertDrained("B post");
});

// ── Suite C — real createOperationScope primitive ────────────────────────────

test("C1 absolute deadline aborts the scope with OperationAbortedError(deadline_elapsed)", async () => {
  const scope = createOperationScope({ budgetMs: 120 });
  assert.equal(scope.aborted(), false);
  const r1 = scope.remainingMs();
  assert.ok(r1 > 0 && r1 <= 120, `remainingMs in range (${r1})`);

  let err: any;
  try {
    await scope.whenAborted("c1");
  } catch (e) {
    err = e;
  }
  assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}`);
  assert.equal(err.reason, "deadline_elapsed");
  assert.equal(scope.aborted(), true);
  assert.equal(scope.remainingMs(), 0, "remainingMs never goes negative");
  scope.dispose();
});

test("C2 scope is composed with the attempt-lifecycle signal: a revoke aborts it before the deadline", async () => {
  const lc = createAttemptLifecycle({ jobId: 1, batchId: 1, attemptNumber: 1, deadlineAt: null });
  const ctx = { batchId: 1, jobId: 1, attemptNumber: 1, lifecycle: lc } as any;

  await runWithDiagContext(ctx, async () => {
    // A long budget that will NOT be reached: the abort must come from the revoke.
    const scope = createOperationScope({ budgetMs: 60_000, ctx });
    assert.equal(scope.aborted(), false);

    revokeAttempt(lc, "batch_cancelled");

    let err: any;
    try {
      await scope.whenAborted("c2");
    } catch (e) {
      err = e;
    }
    assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}`);
    assert.equal(scope.aborted(), true);
    assert.equal(scope.abortReason(), "batch_cancelled");
    assert.ok(scope.remainingMs() > 1000, "aborted well before the (unreached) deadline");
    scope.dispose();
  });
});

test.after(() => {
  clearInterval(keepAlive);
  // Nothing persistent to tear down; assert the broker ends fully drained.
  const s = b.state();
  assert.equal(s.active, 0, `broker left non-drained: active=${s.active}`);
  assert.equal(s.waiting, 0, `broker left non-drained: waiting=${s.waiting}`);
});

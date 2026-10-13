/**
 * batch-1277 (B2) — cancellable subprocess-admission boundary test.
 *
 * The browser permit has a sibling bottleneck: the subprocess slot
 * (MAX_CONCURRENT_SUBPROC), acquired by every pdf-parse / pdftotext / OCR
 * extraction through acquireProcSlot(). Before B2, a queued proc waiter had no
 * way to withdraw: an operation whose deadline elapsed (or whose attempt was
 * revoked) while waiting for a slot would still be GRANTED one and then dispatch
 * dead extraction work, serialising every other extraction behind it exactly the
 * way the browser permit did.
 *
 * These tests drive the REAL production acquireProcSlot / releaseProcSlot through
 * the exported processorSlotBroker.proc that production code uses — NOT a copied
 * simulation — with a real OperationScope, mirroring the browser-permit suite
 * (operation-scoped-cancellation.test.ts A1/A2/A3). MAX_CONCURRENT_SUBPROC is
 * pinned to 1 so slot accounting is exact. No Chromium, no DB, no Redis, no paid
 * calls.
 *
 *   npx tsx server/lib/cancellable-proc-admission-boundary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  MAX_CONCURRENT_SUBPROC: "1",
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const { processorSlotBroker } = await import("./processor.js");
const { createOperationScope, isOperationAbortedError } = await import("./lifecycle-fence.js");

const p = processorSlotBroker.proc;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function assertDrained(where: string) {
  const s = p.state();
  assert.equal(s.active, 0, `${where}: proc slot leaked (active=${s.active})`);
  assert.equal(s.waiting, 0, `${where}: proc waiter leaked (waiting=${s.waiting})`);
}

test("B2-1 queued proc waiter withdraws at its deadline and is NEVER granted the slot", async () => {
  assertDrained("B2-1 pre");
  assert.equal(p.state().max, 1, "MAX_CONCURRENT_SUBPROC pinned to 1");

  await p.acquire(); // hold the only proc slot (no scope)
  assert.equal(p.state().active, 1);
  assert.equal(p.state().waiting, 0, "no waiter yet");

  const t0 = Date.now();
  const scope = createOperationScope({ budgetMs: 150 });
  let err: any;
  const waiterP = p.acquire(scope).catch((e) => { err = e; }); // queues behind the held slot
  await sleep(30);
  assert.equal(p.state().waiting, 1, "the scoped acquire is queued behind the held slot");

  // Watchdog: without the B2 withdrawal the waiter never settles. Bound the wait so
  // a regression surfaces as a clean assertion failure (not an indefinite hang).
  const settled = await Promise.race([
    waiterP.then(() => "settled" as const),
    sleep(2500).then(() => "hung" as const),
  ]);
  assert.equal(settled, "settled", "waiter withdrew and settled at its deadline (did not hang waiting for a slot)");
  const waited = Date.now() - t0;

  assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}: ${err?.message}`);
  assert.equal(err.reason, "deadline_elapsed");
  assert.ok(/proc_admission/.test(err.message), `abort surfaced at the proc-admission boundary: ${err.message}`);
  assert.equal(p.state().waiting, 0, "aborted waiter removed itself from the proc queue");
  assert.equal(p.state().active, 1, "aborted waiter never consumed the held slot");
  assert.ok(waited >= 140 && waited < 3000, `gave up at ~deadline (waited=${waited}ms)`);

  scope.dispose();
  p.release(); // release the originally-held slot
  assertDrained("B2-1 post");
});

test("B2-2 the next waiting operation is admitted promptly once the holder releases", async () => {
  assertDrained("B2-2 pre");
  await p.acquire(); // A holds
  const scope = createOperationScope({ budgetMs: 10_000 });
  const pB = p.acquire(scope); // B queues
  await sleep(20);
  assert.equal(p.state().waiting, 1, "B is queued");

  const t0 = Date.now();
  p.release(); // A releases → direct hand-off to B (count never touched)
  await pB; // B admitted
  const lat = Date.now() - t0;

  assert.ok(lat < 250, `B admitted promptly after release (lat=${lat}ms)`);
  assert.equal(p.state().active, 1, "B now holds exactly one proc slot");
  assert.equal(p.state().waiting, 0);

  scope.dispose();
  p.release(); // B releases
  assertDrained("B2-2 post");
});

test("B2-3 grant/abort race — abort BEFORE release: waiter withdraws, slot returns cleanly (no leak, no phantom grant)", async () => {
  assertDrained("B2-3 pre");
  await p.acquire(); // A holds the only slot
  const scope = createOperationScope({ budgetMs: 30 });
  const outcome = await p.acquire(scope).then(
    () => "granted",
    (e) => { if (!isOperationAbortedError(e)) throw e; return "aborted"; },
  );
  assert.equal(outcome, "aborted", "B aborted at its deadline while A still held the slot");
  assert.equal(p.state().waiting, 0, "B withdrew from the queue");
  assert.equal(p.state().active, 1, "A still holds exactly one slot — no phantom grant to B");

  p.release(); // A releases; queue is empty → slot returns to the pool
  assert.equal(p.state().active, 0, "no leak after abort-then-release");
  scope.dispose();
  assertDrained("B2-3 post");
});

test("B2-4 pre-aborted scope is refused at admission and consumes NO slot", async () => {
  assertDrained("B2-4 pre");
  const scope = createOperationScope({ budgetMs: 1 });
  await sleep(10); // scope already aborted before we even queue
  assert.equal(scope.aborted(), true);

  let err: any;
  try { await p.acquire(scope); } catch (e) { err = e; }
  assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}`);
  assert.ok(/proc_admission/.test(err.message), err.message);
  assert.equal(p.state().active, 0, "pre-aborted admission consumed no slot");
  assert.equal(p.state().waiting, 0);
  scope.dispose();
  assertDrained("B2-4 post");
});

test.after(() => {
  clearInterval(keepAlive);
  assertDrained("B2 after");
});

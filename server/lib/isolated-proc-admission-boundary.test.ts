/**
 * batch-1277 (B2, real-IPC) — cancellable subprocess-admission across the REAL
 * parent/child isolation boundary.
 *
 * cancellable-proc-admission-boundary.test.ts proves the withdrawal guarantee
 * against the in-process broker (processorSlotBroker.proc) in a SINGLE process.
 * This test proves the SAME guarantee end-to-end across a REAL forked job child
 * and the real IPC channel: the child's acquireProcSlot() goes out as a
 * remoteAcquire to the PARENT broker, and when the child's OperationScope aborts
 * it must send cancelAcquire and reject at the proc_admission boundary — not hang,
 * not consume a phantom slot when the parent later releases.
 *
 * Shape:
 *   1. The parent (this test) holds the single parent-side proc slot (max=1).
 *   2. A real isolated child (proc-admission-child.ts) calls
 *      processorSlotBroker.proc.acquire(scope) → its request QUEUES in the parent
 *      broker (observed as waiting==1 over the real IPC path).
 *   3. The child's short-budget scope elapses → cancelAcquire → the child's
 *      acquire rejects with OperationAbortedError(proc_admission).
 *   4. The parent releases its held slot; the queued-but-cancelled grant is handed
 *      straight back → broker drains with NO leak and NO phantom grant.
 *
 * Real Chromium is NOT needed (no browser work). Needs the isolation runtime and
 * a DATABASE_URL for the child's pools. Opt-in via ISOLATED_PROC_ADMIT_REQUIRED=1
 * to force failure instead of skip if isolation cannot fork here.
 *
 *   npx tsx server/lib/isolated-proc-admission-boundary.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, {
  WORKER_ISOLATION_ENABLED: "true",
  CIQ_CHILD_TEST_MODULE: path.join(HERE, "__fixtures__/proc-admission-child.ts"),
  MAX_CONCURRENT_SUBPROC: "1",
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
  PIPELINE_TIMEOUT_MS: "60000",
  PROC_ADMIT_MODE: "queue_then_abort",
  PROC_ADMIT_BUDGET: "700",
});

const { runPipelineIsolated, __testing } = await import("./job-isolation.js");
const { processorSlotBroker } = await import("./processor.js");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const procState = () => __testing.brokerState().proc;

test("B2 real-IPC: a child's queued proc admission withdraws at its deadline across the isolation boundary (no leak, no phantom grant)", async () => {
  assert.equal(procState().max, 1, "MAX_CONCURRENT_SUBPROC pinned to 1");
  assert.equal(procState().active, 0, "pre: no proc slot held");
  assert.equal(procState().waiting, 0, "pre: no proc waiter");

  const outFile = `/tmp/proc-admit-${process.pid}.json`;
  fs.rmSync(outFile, { force: true });
  process.env.PROC_ADMIT_OUT = outFile;

  // 1. Parent holds the only parent-side proc slot (in-process; this IS the broker
  //    children are granted from). The forked child's request must now queue.
  await processorSlotBroker.proc.acquire();
  assert.equal(procState().active, 1, "parent holds the single proc slot");

  try {
    // 2. Spawn the real child. It calls processorSlotBroker.proc.acquire(scope) →
    //    remoteAcquire → the parent broker queues the request (waiting goes to 1).
    const runP = runPipelineIsolated({ company: { id: 7100 } as any, framework: { id: 1 } as any, measures: [], workspaceId: 1 } as any);

    // Observe the REAL cross-IPC queued admission before the child's scope aborts.
    let sawWaiting = false;
    for (let i = 0; i < 80; i++) { // up to ~4s, well under the 700ms*… child window + fork time
      if (procState().waiting >= 1) { sawWaiting = true; break; }
      await sleep(50);
    }
    assert.ok(sawWaiting, "the child's proc admission request queued in the PARENT broker over IPC");

    // 3. The child's 700ms scope elapses → cancelAcquire → the child's acquire
    //    rejects at the proc_admission boundary. The child reports that outcome.
    const res: any = await runP.catch((e) => ({ __err: e }));
    assert.ok(!res.__err, `child pipeline settled without a harness error: ${res.__err?.message || ""}`);

    const c = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(c.outcome, "aborted", `child's queued admission was ABORTED (withdrawn), not granted: ${JSON.stringify(c)}`);
    assert.equal(c.isOperationAborted, true, `withdrawal surfaced as an OperationAbortedError: ${JSON.stringify(c)}`);
    assert.ok(/proc_admission/.test(String(c.error)), `abort surfaced at the proc-admission boundary: ${c.error}`);
    assert.ok(c.waitedMs >= 650 && c.waitedMs < 10_000, `child gave up at ~its deadline (waitedMs=${c.waitedMs})`);

    // The parent still holds exactly its one slot — the cancelled child request was
    // NEVER granted a phantom slot.
    assert.equal(procState().active, 1, "parent still holds exactly one slot — no phantom grant to the child");
  } finally {
    // 4. Release the parent's held slot; the queued-but-cancelled grant is handed
    //    straight back, so the broker drains cleanly.
    processorSlotBroker.proc.release();
    delete process.env.PROC_ADMIT_OUT;
    fs.rmSync(outFile, { force: true });
  }

  // Drain may complete asynchronously as the cancelled grant resolves parent-side.
  for (let i = 0; i < 40 && (procState().active !== 0 || procState().waiting !== 0); i++) await sleep(50);
  assert.equal(procState().active, 0, "no proc slot leaked after abort-then-release");
  assert.equal(procState().waiting, 0, "no proc waiter leaked");
});

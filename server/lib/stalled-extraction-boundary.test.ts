/**
 * batch-1277 (B3/B6) — stalled-extraction boundary test.
 *
 * Proves the property the whole subprocess boundary exists for: a child that
 * NEVER exits on its own (a hung pdf-parse / pdftotext / OCR) does not pin the
 * parent or a concurrency slot past the operation deadline. When the scope
 * aborts, runProcessCollect SIGKILLs the live child immediately (B3 active-work
 * abort) rather than waiting for the child's own timeout, settles the parent as
 * a NON-success (code null), releases the proc slot, and leaves capacity fully
 * restored for the next extraction.
 *
 * The abort is driven by a manual attempt revoke on a LONG-budget scope, so the
 * kill is unambiguously the B3 abort path — not the internal timeout backstop
 * (which sits ~60s away and would also set timedOut=true). This isolates the
 * behaviour we added from the pre-existing timeout.
 *
 * Real primitives only: the production runProcessCollect / acquireProcSlot /
 * createOperationScope, a real OS child process, the real proc broker. No DB
 * rows are written, no Redis, no Chromium, no paid calls. MAX_CONCURRENT_SUBPROC
 * is pinned to 1 so slot accounting is deterministic.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/stalled-extraction-boundary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  MAX_CONCURRENT_SUBPROC: "1",
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const { runProcessCollect, extractViaPdfParseSubprocess, processorSlotBroker } = await import("./processor.js");
const { createOperationScope, createAttemptLifecycle, revokeAttempt, isOperationAbortedError } =
  await import("./lifecycle-fence.js");
const { normaliseTableHorizonMarkers } = await import("./table-horizon-normaliser.js");
const { runWithDiagContext } = await import("./diag-context.js");

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "__fixtures__", "sample-filing.pdf");

const b = processorSlotBroker.proc;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A child that prints its own pid (so the test can prove it was really killed)
// and then blocks forever. Stands in for a hung pdf-parse/pdftotext/OCR child.
const STALL_SRC = "process.stdout.write(String(process.pid)); setInterval(() => {}, 1e6);";

// Poll process.kill(pid, 0): succeeds while the pid exists, throws ESRCH once
// the kernel has reaped it. Returns true if the process is gone within `ms`.
async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch (e: any) { return e?.code === "ESRCH"; }
    await delay(20);
  }
  return false;
}

test("B3 — a hung extraction child is SIGKILLed on scope abort; parent stays responsive, slot restored", async () => {
  assert.equal(b.state().active, 0, "precondition: broker drained");
  assert.equal(b.state().max, 1, "MAX_CONCURRENT_SUBPROC pinned to 1");

  const lc = createAttemptLifecycle({ jobId: 1, batchId: 1, attemptNumber: 1, deadlineAt: null });
  const ctx = { batchId: 1, jobId: 1, attemptNumber: 1, lifecycle: lc } as any;

  const started = Date.now();
  const result = await runWithDiagContext(ctx, async () => {
    // Long budget that will NOT be reached: the abort comes from the manual revoke,
    // so the kill cannot be attributed to the internal timeout backstop.
    const scope = createOperationScope({ budgetMs: 60_000, ctx });
    try {
      // Launch the hung child (do NOT await yet — it never exits on its own).
      const settle = runProcessCollect(
        process.execPath,
        ["-e", STALL_SRC],
        { timeoutMs: 60_000, maxBuffer: 1 << 20 },
        scope,
      );
      // Let the child spawn and emit its pid, confirm it actually occupies a slot…
      await delay(250);
      assert.equal(b.state().active, 1, "the hung child holds the single proc slot while alive");
      // …then abort the operation. B3 must SIGKILL the live child at once.
      revokeAttempt(lc, "batch_cancelled");
      assert.equal(scope.aborted(), true, "scope observes the revoke");
      return await settle;
    } finally {
      scope.dispose();
    }
  });

  const elapsed = Date.now() - started;

  // (a) Parent responsive: settled right after the abort, nowhere near the child's
  // own 60s backstop and certainly not the 1e6s sleep.
  assert.ok(elapsed < 5_000, `parent settled promptly after abort (elapsed=${elapsed}ms)`);

  // (d) Non-success settle: killed child → code null, and NOT a timeout (the abort
  // path, not the backstop timer). A null code is never treated as recovered text.
  assert.equal(result.code, null, "killed child settles with code null");
  assert.equal(result.timedOut, false, "settled via abort, not the internal timeout backstop");

  // (b) The SIGKILL was real: the child pid no longer exists.
  const pid = parseInt(result.stdout.toString("utf8").trim(), 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `captured child pid (${result.stdout.toString("utf8").trim()})`);
  assert.equal(await waitGone(pid, 3_000), true, `child pid ${pid} was SIGKILLed (ESRCH)`);

  // (c) The proc slot was released on the abort settle path — no capacity leak.
  assert.equal(b.state().active, 0, "proc slot released after the aborted extraction");
  assert.equal(b.state().waiting, 0, "no stranded waiters");

  // (e) Capacity restored: a healthy extraction runs fine immediately afterwards.
  const raw = await extractViaPdfParseSubprocess(readFileSync(FIXTURE));
  const text = normaliseTableHorizonMarkers(raw).text;
  assert.ok(text.includes("CIQMARKER-ALPHA"), "healthy extraction works after the kill (capacity restored)");
  assert.equal(b.state().active, 0, "slot released again after the healthy extraction");
  assert.equal(b.state().waiting, 0);
});

// A second guard on the real extractViaPdfParseSubprocess wrapper: when the scope
// is ALREADY aborted at admission, the wrapper must THROW OperationAbortedError
// (retryable) rather than quietly returning "" and letting the caller treat it as
// a legitimate empty extraction — and it must not consume a proc slot. This is the
// admission-withdrawal half of the boundary (B2), as surfaced through the wrapper
// the production extractor actually calls.
test("B3/B2 — extractViaPdfParseSubprocess throws (retryable) on an already-aborted scope and takes no slot", async () => {
  assert.equal(b.state().active, 0, "precondition: broker drained");

  const lc = createAttemptLifecycle({ jobId: 2, batchId: 2, attemptNumber: 1, deadlineAt: null });
  const ctx = { batchId: 2, jobId: 2, attemptNumber: 1, lifecycle: lc } as any;

  await runWithDiagContext(ctx, async () => {
    const scope = createOperationScope({ budgetMs: 60_000, ctx });
    revokeAttempt(lc, "batch_cancelled"); // abort BEFORE the extraction is attempted
    assert.equal(scope.aborted(), true);

    let err: any;
    try {
      await extractViaPdfParseSubprocess(readFileSync(FIXTURE), scope.remainingMs(), scope);
    } catch (e) {
      err = e;
    } finally {
      scope.dispose();
    }

    assert.ok(isOperationAbortedError(err), `expected OperationAbortedError, got ${err?.name}`);
    assert.equal(err.reason, "batch_cancelled", "abort reason preserved (surfaces as retryable, not swallowed)");
  });

  // No slot was ever consumed by the refused admission.
  assert.equal(b.state().active, 0, "no proc slot consumed by a refused (pre-aborted) extraction");
  assert.equal(b.state().waiting, 0);
});

test.after(() => {
  clearInterval(keepAlive);
  const s = b.state();
  assert.equal(s.active, 0, `broker left non-drained: active=${s.active}`);
  assert.equal(s.waiting, 0, `broker left non-drained: waiting=${s.waiting}`);
});

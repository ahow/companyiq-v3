/**
 * Bounded in-flight interruption of an ACTIVE browser operation (batch-1277,
 * B-browser). Opt-in; needs a local Chromium, no DB writes, no Redis, zero paid
 * calls.
 *
 * Scenario (the real boundary the fix changes):
 *   An operation is in flight inside fetchPdfViaBrowser, holding the single
 *   browser permit, blocked on page.goto() against a URL that never answers
 *   (/hang.pdf). Its OperationScope still has a LARGE wall-clock budget left, so
 *   the per-nav timeout (min(BROWSER_FETCH_TIMEOUT, remainingMs)) does NOT cap it
 *   short. The abort arrives from the OTHER source the scope combines — a
 *   lifecycle REVOKE (parent/batch cancel), not the scope's own deadline.
 *
 *   Before the fix, scope.aborted() is only consulted at the explicit gates
 *   BETWEEN CDP calls, so the in-flight goto runs to the full BROWSER_FETCH_TIMEOUT
 *   before the next check settles the op — the aborted op keeps the permit for
 *   many seconds. After the fix, installBoundedPageInterrupt() closes the page
 *   within BROWSER_ABORT_GRACE_MS of the abort; the pending goto then rejects at
 *   the next protocol round-trip and the op settles at the next gate as a
 *   retryable OperationAbortedError — BOUNDED, not instantaneous.
 *
 * BROWSER_FETCH_TIMEOUT_MS is pinned to 8000 here so the two regimes are clearly
 * separable: the fix settles well under 3 s; without it the op cannot settle
 * before ~8 s. The assertion bound (3 s) sits strictly between the grace (~0.5 s)
 * and the full browser timeout (8 s).
 *
 *   npx tsx server/lib/browser-inflight-interrupt.test.ts
 * Skips (exit 0) when Chromium is missing unless INFLIGHT_INTERRUPT_REQUIRED=1.
 */
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";

const CHROMIUM = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/local/bin/chromium";
Object.assign(process.env, {
  PUPPETEER_EXECUTABLE_PATH: CHROMIUM,
  MAX_CONCURRENT_BROWSER: "1",
  // Pin the per-nav/browser timeout so "bounded interrupt" (< 3 s) and
  // "runs to the browser timeout" (~8 s) are unambiguously distinguishable.
  BROWSER_FETCH_TIMEOUT_MS: "8000",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const REVOKE_AFTER_MS = 300;   // let the op get in flight on /hang.pdf first
const SETTLE_BOUND_MS = 3000;  // must settle well under BROWSER_FETCH_TIMEOUT (8 s)
const SCOPE_BUDGET_MS = 60000; // large, so the nav timeout is NOT what settles it

if (!fs.existsSync(CHROMIUM)) {
  if (process.env.INFLIGHT_INTERRUPT_REQUIRED === "1") throw new Error(`chromium missing at ${CHROMIUM}`);
  console.log(`SKIP browser-inflight-interrupt: chromium missing at ${CHROMIUM}`);
} else {
  const { fetchPdfViaBrowser, fetchWithBrowser, closeSharedBrowser } = await import("./processor.js");
  const { createOperationScope, isOperationAbortedError } = await import("./lifecycle-fence.js");
  const { createAttemptLifecycle, revokeAttempt } = await import("./lifecycle-fence.js");

  // The bounded Chromium teardown below forces process.exit, which fires before
  // node:test has computed process.exitCode. Track failures explicitly so the
  // forced exit still returns 1 on any failing assertion — a hung teardown must
  // never launder a real failure into a green exit code.
  let hadFailure = false;
  const gated = (fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (e) { hadFailure = true; throw e; }
  };

  // ── local server: /hang.pdf accepts the connection but never responds ──
  const sockets = new Set<any>();
  const srv = http.createServer((q, r) => {
    if ((q.url || "").startsWith("/hang")) return; // never answers (/hang.pdf, /hang.html)
    r.writeHead(200, { "content-type": "text/html" }); r.end("<html><body>home</body></html>");
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;

  test("B-browser: a mid-navigation REVOKE settles the in-flight op within the grace, not at the browser timeout", gated(async () => {
    // Build a lifecycle we can revoke externally, with a large scope budget so the
    // ONLY thing that can settle the op quickly is the bounded interrupt (not the
    // per-nav deadline, which would otherwise be min(8000, remainingMs) = 8000).
    const lifecycle = createAttemptLifecycle({ jobId: 1, batchId: 1, attemptNumber: 1, deadlineAt: null });
    const scope = createOperationScope({ budgetMs: SCOPE_BUDGET_MS, ctx: { lifecycle }, label: "inflight-interrupt-test" });

    const started = Date.now();
    const work = fetchPdfViaBrowser(`${base}/hang.pdf`, scope);

    // Once the op is demonstrably in flight, revoke the attempt (parent/batch cancel).
    await new Promise((r) => setTimeout(r, REVOKE_AFTER_MS));
    const revokedAt = Date.now();
    revokeAttempt(lifecycle, "test_inflight_revoke");

    let settledErr: any;
    let settledVal: any;
    try { settledVal = await work; } catch (e) { settledErr = e; }
    const settleLatency = Date.now() - revokedAt;

    scope.dispose();

    // The op must END as a retryable abort — never a silent empty success, which
    // would mean the aborted op ran its full path and returned "no content".
    assert.ok(settledErr, `expected the in-flight op to reject, got value=${JSON.stringify(settledVal)}`);
    assert.ok(
      isOperationAbortedError(settledErr),
      `expected OperationAbortedError, got ${settledErr?.name}: ${settledErr?.message}`,
    );
    // The whole point: it settles within the grace + one round-trip, NOT at the
    // 8 s browser timeout. This is the assertion the mutation (no-op interrupt)
    // flips, because then the op can only settle at the per-nav timeout (~8 s).
    assert.ok(
      settleLatency < SETTLE_BOUND_MS,
      `in-flight op settled ${settleLatency}ms after revoke — expected < ${SETTLE_BOUND_MS}ms ` +
        `(BROWSER_FETCH_TIMEOUT is 8000ms; a latency near that means the interrupt did not bound it)`,
    );
    console.log(`[inflight-interrupt] settled ${settleLatency}ms after revoke (total ${Date.now() - started}ms), reason=${settledErr.reason ?? settledErr.message}`);
  }));

  test("B-browser (HTML path): a mid-navigation REVOKE on fetchWithBrowser settles within the grace, not at the browser timeout", gated(async () => {
    // Same boundary as above but on the HTML path (fetchWithBrowser), which before
    // this candidate was NOT wired to installBoundedPageInterrupt. Large scope
    // budget so only the bounded interrupt (not the per-nav deadline) can settle
    // the in-flight page.goto quickly.
    const lifecycle = createAttemptLifecycle({ jobId: 2, batchId: 1, attemptNumber: 1, deadlineAt: null });
    const scope = createOperationScope({ budgetMs: SCOPE_BUDGET_MS, ctx: { lifecycle }, label: "inflight-interrupt-html-test" });

    const started = Date.now();
    const work = fetchWithBrowser(`${base}/hang.html`, scope);

    await new Promise((r) => setTimeout(r, REVOKE_AFTER_MS));
    const revokedAt = Date.now();
    revokeAttempt(lifecycle, "test_inflight_revoke_html");

    let settledErr: any;
    let settledVal: any;
    try { settledVal = await work; } catch (e) { settledErr = e; }
    const settleLatency = Date.now() - revokedAt;

    scope.dispose();

    // Must END as a retryable abort — never a silent "" (which would mark the URL
    // permanently dead) and never run to the 8 s browser timeout.
    assert.ok(settledErr, `expected the in-flight HTML op to reject, got value=${JSON.stringify(settledVal)}`);
    assert.ok(
      isOperationAbortedError(settledErr),
      `expected OperationAbortedError on the HTML path, got ${settledErr?.name}: ${settledErr?.message}`,
    );
    assert.ok(
      settleLatency < SETTLE_BOUND_MS,
      `HTML-path in-flight op settled ${settleLatency}ms after revoke — expected < ${SETTLE_BOUND_MS}ms ` +
        `(a latency near BROWSER_FETCH_TIMEOUT=8000ms means fetchWithBrowser is not wired to the interrupt)`,
    );
    console.log(`[inflight-interrupt-html] settled ${settleLatency}ms after revoke (total ${Date.now() - started}ms), reason=${settledErr.reason ?? settledErr.message}`);
  }));

  test.after(async () => {
    // Bound the shared-browser close so a slow/hung Chromium teardown cannot keep
    // the event loop (and a CI gate) alive after the assertions have passed.
    try {
      await Promise.race([
        closeSharedBrowser(),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
    } catch { /* ignore */ }
    for (const s of sockets) s.destroy();
    srv.close();
    // Any residual Chromium handle is out-of-band; the TAP results above are final.
    // Exit with the code the test runner computed from the results (1 if any test
    // failed) so a hung Chromium teardown cannot turn a real failure into a green
    // CI gate. Never hard-code exit 0 here — that would mask failures.
    setTimeout(() => process.exit(hadFailure ? 1 : 0), 200).unref();
  });
}

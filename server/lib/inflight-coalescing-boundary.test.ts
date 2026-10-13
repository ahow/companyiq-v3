/**
 * batch-1277 (B7) — in-flight-document coalescing boundary test.
 *
 * Proves the two properties the inFlightDocs map exists for, against the REAL
 * production processDocument wrapper (its real coalescing map + the real
 * `!existing.scope?.aborted()` liveness guard):
 *
 *   B7-1 COALESCE: two concurrent processDocument() calls for the SAME url launch
 *     exactly ONE underlying (browser/network) fetch — never two overlapping
 *     recoveries that would double-book the single browser permit and race to
 *     persist a late result. Both callers resolve with the one fetch's text.
 *
 *   B7-2 NO-REUSE-OF-ABORTED: a new caller must NOT coalesce onto an in-flight
 *     entry whose scope has already aborted (deadline elapsed / attempt revoked).
 *     Such an entry is being torn down and its result is withheld by the abort
 *     guards, so re-using it would make the fresh caller fail spuriously. The new
 *     caller instead starts its own fresh fetch under its own live scope.
 *
 * Injectable seam (same philosophy as B1's fetchFn): __setProcessDocumentWorkerForTest
 * swaps ONLY the expensive downstream uncached worker for a controllable stand-in
 * that counts invocations and resolves on command. The coalescing map and the
 * liveness guard under test are the REAL production code in processDocument.
 *
 * No DB, no Redis, no Chromium, no paid calls. Unique URLs per test avoid the
 * content cache; the seam is cleared in test.after.
 *
 *   npx tsx server/lib/inflight-coalescing-boundary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
});

const { processDocument, __setProcessDocumentWorkerForTest } = await import("./processor.js");
const { createOperationScope } = await import("./lifecycle-fence.js");

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A controllable stand-in for the uncached (browser/network) worker. Records every
// invocation and hands back a deferred the test resolves on command, so overlap is
// observable deterministically. Each returned text is unique per invocation so the
// test can tell "both callers got the SAME single fetch" from "each ran its own".
function makeWorker() {
  let calls = 0;
  const deferreds: Array<{ url: string; resolve: (t: string) => void; reject: (e: any) => void }> = [];
  const fn = (url: string): Promise<string> => {
    const n = ++calls;
    return new Promise<string>((resolve, reject) => {
      deferreds.push({ url, resolve: () => resolve(`TEXT#${n}`), reject });
    });
  };
  return {
    fn,
    get calls() { return calls; },
    resolveAll() { for (const d of deferreds.splice(0)) d.resolve(""); },
  };
}

test("B7-1 — concurrent same-URL processDocument calls coalesce to ONE underlying fetch", async () => {
  const w = makeWorker();
  __setProcessDocumentWorkerForTest(w.fn);
  try {
    const url = `https://example.test/b7-coalesce-${Date.now()}.pdf`;

    // Two callers race for the same URL while the single fetch is still in flight.
    const p1 = processDocument(url, "pdf");
    const p2 = processDocument(url, "pdf");
    await delay(50); // both callers have passed the coalescing check

    assert.equal(w.calls, 1, "exactly one underlying fetch launched for two concurrent same-URL callers");

    w.resolveAll();
    const [t1, t2] = await Promise.all([p1, p2]);
    assert.equal(t1, "TEXT#1", "first caller gets the single fetch's text");
    assert.equal(t2, "TEXT#1", "second caller is handed the SAME fetch's text (coalesced), not a second fetch");
  } finally {
    __setProcessDocumentWorkerForTest(null);
  }
});

test("B7-2 — a new caller does NOT coalesce onto an in-flight entry whose scope has aborted", async () => {
  const w = makeWorker();
  __setProcessDocumentWorkerForTest(w.fn);
  // Short absolute budget → the first caller's scope aborts via its real deadline
  // timer while the worker fetch is still held (not resolved), so scope.aborted()
  // is true and unambiguous. The second caller runs under a long-lived scope.
  const abortedScope = createOperationScope({ budgetMs: 40 });
  const liveScope = createOperationScope({ budgetMs: 60_000 });
  try {
    const url = `https://example.test/b7-aborted-${Date.now()}.pdf`;

    // First caller launches the fetch under the short-budget scope and we DO NOT
    // resolve the worker, so the entry is still in flight when its scope elapses.
    const first = processDocument(url, "pdf", { scope: abortedScope });
    await delay(30);
    assert.equal(w.calls, 1, "first fetch launched");

    await delay(60); // let the 40ms budget elapse → abortedScope aborts
    assert.equal(abortedScope.aborted(), true, "first caller's scope has aborted (deadline elapsed)");

    // A new caller arrives for the SAME url. The in-flight entry's scope is aborted,
    // so the liveness guard must REFUSE to coalesce and start a fresh fetch instead.
    const second = processDocument(url, "pdf", { scope: liveScope });
    await delay(30);

    assert.equal(w.calls, 2, "new caller started its OWN fresh fetch (did not coalesce onto the aborted entry)");

    w.resolveAll();
    const t2 = await second;
    assert.equal(t2, "TEXT#2", "new caller resolves from its own (second) fetch, under its live scope");
    await first.catch(() => {}); // first may settle either way; not under test here
  } finally {
    __setProcessDocumentWorkerForTest(null);
    abortedScope.dispose();
    liveScope.dispose();
  }
});

test.after(() => {
  __setProcessDocumentWorkerForTest(null);
  clearInterval(keepAlive);
});

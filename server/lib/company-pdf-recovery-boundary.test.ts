/**
 * batch-1277 (B1) — behavioural tests for the EXTRACTED production recovery helper
 * runCompanyPdfRecovery (server/lib/pipeline.ts) against the REAL createOperationScope
 * primitive and the REAL processor admission boundary (fetchIssuerPdfsWithPrimedSession
 * + the real replica browser-permit broker). No Chromium, no DB writes, no paid calls.
 *
 * COVERAGE SCOPE (stated honestly): this is an INTEGRATION test of the recovery
 * boundary — helper -> operation scope -> fetch boundary -> broker admission — NOT a
 * full company-pipeline end-to-end run. The complementary in-flight / post-acquire
 * paths that need a real Chromium (timeout WHILE HOLDING the permit, child-death
 * reap-before-release) are covered by the sibling browser-close-order.test.ts.
 *
 *   DATABASE_URL=<any pg url; not connected> npx tsx server/lib/company-pdf-recovery-boundary.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";

// The operation-scope deadline timer is unref'd (as in production). Keep the loop
// alive so those timers fire and tests settle; cleared in test.after.
const keepAlive = setInterval(() => {}, 1000);

Object.assign(process.env, {
  MAX_CONCURRENT_BROWSER: "1",
  DATABASE_URL: process.env.DATABASE_URL || "postgres://ciq:ciq@127.0.0.1:55432/ciq",
  ADAPTIVE_CONCURRENCY_ENABLED: "false",
  CREDIT_PAUSE_ENABLED: "false",
  // Pin the hard cap so the min(cap, remainingMs) capping assertion is deterministic.
  PDF_RECOVERY_MAX_BUDGET_MS: "600000",
});

const { isOperationAbortedError } = await import("./lifecycle-fence.js");
const { runCompanyPdfRecovery } = await import("./pipeline.js");
const { processorSlotBroker, fetchIssuerPdfsWithPrimedSession } = await import("./processor.js");
import type { IssuerPdfFetchFn } from "./pipeline.js";
import type { PdfRecoveryOutcome } from "./processor.js";

const b = processorSlotBroker.browser;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function assertDrained(where: string) {
  const s = b.state();
  assert.equal(s.active, 0, `${where}: permit leaked (active=${s.active})`);
  assert.equal(s.waiting, 0, `${where}: waiter leaked (waiting=${s.waiting})`);
}

// ── B1-1 — the scope is actually propagated to the fetch boundary ────────────
test("B1-1 helper arms ONE operation scope and passes it to every fetch-boundary call", async () => {
  const seenScopes: unknown[] = [];
  const seenUrls: string[][] = [];
  const fetchFn: IssuerPdfFetchFn = async (_origin, urls, opts) => {
    seenScopes.push(opts.scope);
    seenUrls.push(urls);
    return new Map(); // recovered nothing
  };
  const candidatesByOrigin = new Map<string, string[]>([
    ["https://a.example", ["https://a.example/1.pdf", "https://a.example/2.pdf"]],
    ["https://b.example", ["https://b.example/1.pdf"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const res = await runCompanyPdfRecovery({ candidatesByOrigin, attemptBudget: 40, outcomes, fetchFn });

  assert.equal(seenScopes.length, 2, "both origins were dispatched");
  assert.ok(seenScopes[0], "a scope was passed to the fetch boundary (was DEAD/omitted before B1)");
  // THE regression guard: the SAME scope object is reused across origins (one
  // company-wide deadline, not reset per origin).
  assert.strictEqual(seenScopes[0], seenScopes[1], "the SAME scope is reused across origins");
  assert.equal(res.attemptsUsed, 3);
  assert.equal(res.aborted, false);
});

// ── B1-2 — remainingMs caps the scope budget below the constant ──────────────
test("B1-2 remainingMs caps the recovery scope budget (min of cap and remaining)", async () => {
  // With a tiny remainingMs the scope must abort ~that fast even though the
  // PDF_RECOVERY_MAX_BUDGET_MS constant is 10 minutes. A fetchFn that stalls lets
  // the scope deadline fire while we are "inside" the boundary.
  let sawAbortInsideBoundary = false;
  const fetchFn: IssuerPdfFetchFn = async (_origin, urls, opts) => {
    // Wait past the cap; the scope must abort during this wait.
    const scope = opts.scope!;
    const t0 = Date.now();
    while (Date.now() - t0 < 600 && !scope.aborted()) await sleep(10);
    if (scope.aborted()) sawAbortInsideBoundary = true;
    // Emulate the real callee: mark every URL retryable, recover nothing.
    for (const u of urls) opts.outcomes?.push({ url: u, ok: false, reason: "deadline_elapsed" });
    return new Map();
  };
  const candidatesByOrigin = new Map<string, string[]>([
    ["https://a.example", ["https://a.example/1.pdf"]],
    ["https://b.example", ["https://b.example/1.pdf"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const t0 = Date.now();
  const res = await runCompanyPdfRecovery({
    candidatesByOrigin, attemptBudget: 40, outcomes, remainingMs: 150, fetchFn,
  });
  const elapsed = Date.now() - t0;

  assert.ok(sawAbortInsideBoundary, "scope aborted ~150ms in, NOT at the 10-min constant");
  assert.ok(elapsed < 5000, `recovery gave up near the cap, not the constant (elapsed=${elapsed}ms)`);
  assert.equal(res.aborted, true, "helper reports the company-wide deadline elapsed");
  // Second origin was NOT dispatched after the scope aborted (see B1-3).
  assert.ok(res.attemptsUsed <= 1, `remaining origin left unattempted (attemptsUsed=${res.attemptsUsed})`);
});

// ── B1-3 — no origin dispatched after the deadline; the rest stay retryable ──
test("B1-3 after the deadline elapses no further origin is dispatched and the tail stays retryable", async () => {
  // First origin's fetch burns the whole budget; the scope then being aborted must
  // stop dispatch of every later origin.
  const dispatched: string[] = [];
  const fetchFn: IssuerPdfFetchFn = async (origin, _urls, opts) => {
    dispatched.push(origin);
    const scope = opts.scope!;
    const t0 = Date.now();
    while (Date.now() - t0 < 500 && !scope.aborted()) await sleep(10);
    return new Map();
  };
  const candidatesByOrigin = new Map<string, string[]>([
    ["https://a.example", ["https://a.example/1.pdf"]],
    ["https://b.example", ["https://b.example/1.pdf"]],
    ["https://c.example", ["https://c.example/1.pdf"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const res = await runCompanyPdfRecovery({
    candidatesByOrigin, attemptBudget: 40, outcomes, remainingMs: 120, fetchFn,
  });

  assert.deepEqual(dispatched, ["https://a.example"], "only the first origin ran; b and c never dispatched");
  assert.equal(res.aborted, true);
  // b and c were never attempted → retryable by the deferred sweep (no false 'dead').
  assert.ok(res.attemptsUsed <= 1, `unattempted tail remains (attemptsUsed=${res.attemptsUsed})`);
});

// ── B1-4 — attemptBudget caps total per-URL attempts across origins ──────────
test("B1-4 attemptBudget caps total attempts ACROSS origins (CHANGE 3 starvation fix is honoured)", async () => {
  const perOriginUrlCounts: number[] = [];
  const fetchFn: IssuerPdfFetchFn = async (_origin, urls) => {
    perOriginUrlCounts.push(urls.length);
    return new Map();
  };
  const candidatesByOrigin = new Map<string, string[]>([
    ["https://a.example", ["a1", "a2", "a3"]],
    ["https://b.example", ["b1", "b2", "b3"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const res = await runCompanyPdfRecovery({ candidatesByOrigin, attemptBudget: 4, outcomes, fetchFn });

  assert.equal(res.attemptsUsed, 4, "exactly the attempt budget was spent");
  assert.deepEqual(perOriginUrlCounts, [3, 1], "origin A took 3, origin B the remaining 1 (budget split across origins)");
});

// ── B1-5 — healthy path: ample budget, all origins run, recovered collected ──
test("B1-5 healthy path — ample budget dispatches all origins and returns recovered text UNFILTERED", async () => {
  const fetchFn: IssuerPdfFetchFn = async (origin, urls) => {
    const m = new Map<string, string>();
    for (const u of urls) m.set(u, `TEXT from ${origin} ${u}`);
    return m;
  };
  const candidatesByOrigin = new Map<string, string[]>([
    ["https://a.example", ["https://a.example/1.pdf"]],
    ["https://b.example", ["https://b.example/1.pdf", "https://b.example/2.pdf"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const res = await runCompanyPdfRecovery({ candidatesByOrigin, attemptBudget: 40, outcomes, fetchFn });

  assert.equal(res.aborted, false);
  assert.equal(res.attemptsUsed, 3);
  assert.equal(res.recovered.length, 3, "all recovered pairs returned to the caller (caller applies min-length + persist)");
  assert.ok(res.recovered.every((r) => r.text.startsWith("TEXT from ")));
});

// ── B1-6 — the scope reaches the REAL admission boundary and withdraws there ─
// This ties the helper to the REAL processor callee (default fetchFn) WITHOUT a
// browser: the single permit is held, so the recovery queues for admission; its
// company-wide scope elapses while queued, so the real fetchIssuerPdfsWithPrimedSession
// withdraws and marks EVERY url admission_timeout (retryable) without launching a
// browser or recording any false success.
test("B1-6 default fetchFn routes through the REAL admission boundary which withdraws at the company deadline", async () => {
  assertDrained("B1-6 pre");
  await b.acquire(); // hold the only permit so recovery must queue for admission
  assert.equal(b.state().active, 1);

  const candidatesByOrigin = new Map<string, string[]>([
    ["https://esg.example", ["https://esg.example/report-1.pdf", "https://esg.example/report-2.pdf"]],
  ]);
  const outcomes: PdfRecoveryOutcome[] = [];
  const t0 = Date.now();
  const res = await runCompanyPdfRecovery({
    candidatesByOrigin,
    attemptBudget: 40,
    outcomes,
    remainingMs: 200, // company-wide deadline ~200ms while queued behind the held permit
    // no fetchFn → default REAL fetchIssuerPdfsWithPrimedSession
  });
  const waited = Date.now() - t0;

  assert.equal(res.recovered.length, 0, "nothing falsely recovered while blocked");
  assert.equal(outcomes.length, 2, "every url got an explicit outcome");
  assert.ok(
    outcomes.every((o) => !o.ok && (o.reason === "admission_timeout" || o.reason === "deadline_elapsed")),
    `every url is retryable/incomplete, not dead: ${JSON.stringify(outcomes.map((o) => o.reason))}`,
  );
  assert.ok(waited < 5000, `withdrew near the company deadline, not a per-origin 10-min cap (waited=${waited}ms)`);
  assert.equal(b.state().active, 1, "the queued recovery NEVER consumed the held permit");
  assert.equal(b.state().waiting, 0, "the aborted recovery removed itself from the broker queue");

  await b.release();
  assertDrained("B1-6 post");
});

test.after(() => clearInterval(keepAlive));

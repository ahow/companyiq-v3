/**
 * Standalone unit tests for attempt-scoped cancellation through the SCORING path
 * (no DB / Redis / network / paid calls — every provider is an in-process mock
 * installed via __setProvidersForTests, which replaces the whole registry).
 * Run: DATABASE_URL=<any pg url; not connected> npx tsx server/lib/scoring-cancellation.unit.test.ts
 *
 * Covers (Part B):
 *  1. dispatch refused + in-flight aborted across primary, retry, backoff,
 *     fallback (completeScoring) and primary/secondary/arbiter (REAL
 *     scoreWithCascade via __analyzerTestHooks), plus the non-strict path;
 *  2. ownership loss (revokeAttempt, startOwnershipWatch token mismatch /
 *     status change; fail-open on read error) halts the old execution;
 *  3. cancellation is never retried, never failed over, never converted into
 *     a score / abstain (REAL scoreSingleMeasurePass); content-retry is gated;
 *  4. 5 concurrent siblings (MEASURE_CONCURRENCY) abort together with no
 *     orphaned timers / abort listeners;
 *  5. abortableSleep / scoring backoff resolve immediately on abort;
 *  6. healthy run: 36 measures scored, zero aborts, normal retry + fallback
 *     intact, and no signal at all outside an attempt context.
 */
process.exitCode = 1;
const keepAlive = setInterval(() => {}, 1000);

import { getEventListeners } from "node:events";
import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import {
  createAttemptLifecycle, revokeAttempt, registerBatchCancelSource,
  isLifecycleCancelledError, startOwnershipWatch,
} from "./lifecycle-fence.js";
import { completeScoring, abortableSleep, __setProvidersForTests, type AIProvider } from "./ai-providers.js";
import { __analyzerTestHooks } from "./analyzer.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Timer tracker (counts timers created AFTER install that are still live) ──
const live = new Set<any>();
{
  const oSI = globalThis.setInterval, oCI = globalThis.clearInterval;
  const oST = globalThis.setTimeout, oCT = globalThis.clearTimeout;
  (globalThis as any).setInterval = (fn: any, ms?: number, ...a: any[]) => { const t = oSI(fn, ms, ...a); live.add(t); return t; };
  (globalThis as any).clearInterval = (t: any) => { live.delete(t); oCI(t); };
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = oST((...x: any[]) => { live.delete(t); fn(...x); }, ms, ...a); live.add(t); return t;
  };
  (globalThis as any).clearTimeout = (t: any) => { live.delete(t); oCT(t); };
}

// ─── Mock providers ──────────────────────────────────────────────────────────
type Behavior = (n: number, opts: any, m: Mock) => Promise<string>;
interface Mock extends AIProvider { calls: number; inflight: number; aborted: number; signals: Array<AbortSignal | undefined>; behavior: Behavior; available: boolean }
function mk(name: string, family: string, behavior: Behavior, available = true): Mock {
  const m: Mock = {
    name, model: `${name}-model`, family, calls: 0, inflight: 0, aborted: 0, signals: [], behavior, available,
    isAvailable: () => m.available,
    complete: (opts: any) => {
      m.calls++; m.signals.push(opts.signal); m.inflight++;
      return m.behavior(m.calls, opts, m).finally(() => { m.inflight--; });
    },
  };
  return m;
}
const NO_JSON = JSON.stringify({ score: 0, verdict: "No", confidence: "High", evidenceSummary: "none", quotes: [] });
const YES_JSON = JSON.stringify({ score: 1, verdict: "Yes", confidence: "High", evidenceSummary: "found", quotes: [{ text: "the board oversees climate risk", source: "AR 2025" }] });
const ok = (text = NO_JSON, delayMs = 0): Behavior => async () => { if (delayMs) await sleep(delayMs); return text; };
/** Never settles on its own; rejects like a real SDK/axios transport on abort. */
const hang: Behavior = (_n, opts, m) => new Promise<string>((_res, rej) => {
  const s: AbortSignal | undefined = opts.signal;
  if (!s) return; // would hang forever — tests always run hang under a signal
  const on = () => { m.aborted++; const e: any = new Error("canceled"); e.name = "CanceledError"; e.code = "ERR_CANCELED"; rej(e); };
  if (s.aborted) on(); else s.addEventListener("abort", on, { once: true });
});
const fail500: Behavior = async () => { const e: any = new Error("server boom"); e.status = 500; throw e; };
const seq = (...bs: Behavior[]): Behavior => (n, o, m) => bs[Math.min(n - 1, bs.length - 1)](n, o, m);

let P1: Mock, P2: Mock, ARB: Mock, FB1: Mock;
let restore: (() => void) | null = null;
function install(b: { p1?: Behavior; p2?: Behavior; arb?: Behavior; fb1?: Behavior; p1Available?: boolean } = {}) {
  restore?.();
  P1 = mk("p1", "fam-a", b.p1 ?? ok(), b.p1Available ?? true);
  P2 = mk("p2", "fam-b", b.p2 ?? ok());
  ARB = mk("arb", "fam-c", b.arb ?? ok());
  FB1 = mk("fb1", "fam-d", b.fb1 ?? ok());
  restore = __setProvidersForTests([P1, P2, ARB, FB1]);
}
const allMocks = () => [P1, P2, ARB, FB1];
const totalCalls = () => allMocks().reduce((a, m) => a + m.calls, 0);
const totalInflight = () => allMocks().reduce((a, m) => a + m.inflight, 0);

const TOKEN = "11111111-1111-4111-8111-111111111111";
function newCtx(batchId = 77, opts: { deadlineAt?: Date | null } = {}): DiagContext {
  const lifecycle = createAttemptLifecycle({ jobId: 501, batchId, attemptNumber: 1, deadlineAt: opts.deadlineAt ?? null, attemptToken: TOKEN });
  return { batchId, jobId: 501, attemptNumber: 1, companyId: 7, lifecycle };
}
const lcListeners = (ctx: DiagContext) => getEventListeners(ctx.lifecycle!.abort.signal, "abort").length;
async function settleFlush() { await sleep(5); }
async function catchErr<T>(p: Promise<T>): Promise<{ err: any; val?: T; ms: number }> {
  const t0 = Date.now();
  try { const val = await p; return { err: null, val, ms: Date.now() - t0 }; } catch (err) { return { err, ms: Date.now() - t0 }; }
}
const REQ = { system: "s", prompt: "p", json: true, maxTokens: 50 };

const measure: any = {
  id: 1, frameworkId: 1, measureId: "M1", title: "Board climate oversight", definition: "The board oversees climate risk.",
  category: "Governance", categoryNumber: 1, displayOrder: 1, scoringGuidance: null, positiveExamples: [], negativeExamples: [],
};
let evidenceSeq = 0;
const evidence = () => `DOCUMENT: AR 2025\nThe board oversees climate risk. (case ${++evidenceSeq})`;
const cascadeSettings: any = { cascadePrimary: "p1", cascadeSecondary: "p2", cascadeArbiter: "arb", scoringMode: "binary" };

async function main() {
  process.env.LLM_USAGE_LOGGING_ENABLED = "false"; // no usage buffer / DB flush
  process.env.PROVIDER_FALLBACK_ORDER = "p1,fb1";
  process.env.SCORING_STRICT_PROVIDER = "true";
  process.env.RETRIEVAL_EVIDENCE_GATE = "0"; // keep mocked Yes/No votes intact for cascade disagreement
  process.env.SCORING_REQ_LOG = "settle";
  delete process.env.SCORING_PROVIDER_RETRIES; // production default (4)
  const cancelledBatches = new Set<number>();
  registerBatchCancelSource((id) => cancelledBatches.has(id));
  const timerBase = live.size;

  console.log("── 5. abortableSleep ──");
  {
    const ac = new AbortController();
    const base = live.size;
    setTimeout(() => ac.abort(new Error("x")), 20);
    const r = await catchErr(abortableSleep(5000, ac.signal));
    check("abortableSleep rejects promptly on abort (<200ms of a 5000ms sleep)", r.err != null && r.ms < 200, r.ms);
    check("abortableSleep rejection is a LifecycleCancelledError", isLifecycleCancelledError(r.err));
    await settleFlush();
    check("abortableSleep: timer cleared + listener removed", live.size === base && getEventListeners(ac.signal, "abort").length === 0, { live: live.size - base });
    const pre = new AbortController(); pre.abort();
    check("abortableSleep on already-aborted signal rejects synchronously-ish", isLifecycleCancelledError((await catchErr(abortableSleep(5000, pre.signal))).err));
    const ac2 = new AbortController();
    const r2 = await catchErr(abortableSleep(30, ac2.signal));
    check("abortableSleep resolves normally when not aborted; no listener left", r2.err == null && r2.ms >= 25 && getEventListeners(ac2.signal, "abort").length === 0);
    const r3 = await catchErr(abortableSleep(30));
    check("abortableSleep without signal = plain sleep", r3.err == null && r3.ms >= 25);
  }

  console.log("── 1/3. completeScoring: primary / retry / backoff / fallback ──");
  {
    // Already revoked → zero dispatch.
    install();
    const ctx = newCtx(); revokeAttempt(ctx.lifecycle, "admin_cancel_test");
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("revoked before dispatch → LifecycleCancelledError, zero provider calls", isLifecycleCancelledError(r.err) && totalCalls() === 0, { calls: totalCalls() });
  }
  {
    // Abort in-flight primary: no retry, no fallback.
    install({ p1: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "pipeline_timeout"), 30);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("in-flight primary aborted → LifecycleCancelledError(pipeline_timeout)", isLifecycleCancelledError(r.err) && r.err.reason === "pipeline_timeout", r.err?.message);
    check("primary transport saw the abort (signal passed into .complete)", P1.aborted === 1 && P1.signals[0] instanceof AbortSignal);
    check("cancellation NOT retried (p1 called once) and NOT failed over (fb1/p2/arb uncalled)", P1.calls === 1 && FB1.calls + P2.calls + ARB.calls === 0, allMocks().map((m) => m.calls));
    check("cancellation is prompt (<300ms)", r.ms < 300, r.ms);
    await settleFlush();
    check("no orphan listener on attempt signal / no live timers", lcListeners(ctx) === 0 && live.size === timerBase, { l: lcListeners(ctx), t: live.size - timerBase });
  }
  {
    // Abort during the interruptible backoff after a transient failure.
    install({ p1: fail500 });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "job_watchdog_timeout"), 100);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("abort during 500ms backoff → resolves early (<350ms) with cancellation", isLifecycleCancelledError(r.err) && r.ms < 350, { ms: r.ms, e: r.err?.message });
    check("no retry dispatched after abort, no fallback", P1.calls === 1 && FB1.calls === 0);
    await settleFlush();
    check("backoff timer + listener cleaned up", lcListeners(ctx) === 0 && live.size === timerBase, { t: live.size - timerBase });
  }
  {
    // Abort the RETRY request in flight (first try fails, second hangs).
    install({ p1: seq(fail500, hang) });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "ownership_lost"), 650);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("in-flight retry (try 2) aborted with cancellation", isLifecycleCancelledError(r.err) && P1.calls === 2 && P1.aborted === 1, { calls: P1.calls, e: r.err?.message });
    check("aborted retry not failed over", FB1.calls + P2.calls + ARB.calls === 0);
  }
  {
    // Abort the FALLBACK request in flight (primary unavailable).
    install({ p1Available: false, fb1: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "admin_cancel_test"), 30);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("in-flight fallback aborted with cancellation", isLifecycleCancelledError(r.err) && FB1.calls === 1 && FB1.aborted === 1, r.err?.message);
    check("no further fallback after abort (p2/arb uncalled)", P2.calls + ARB.calls === 0, [P2.calls, ARB.calls]);
  }
  {
    // Revoked before fallback dispatch → fallback refused.
    install({ p1Available: false, fb1: ok() });
    const ctx = newCtx(); revokeAttempt(ctx.lifecycle, "admin_cancel_test");
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("revoked → fallback dispatch refused (zero calls)", isLifecycleCancelledError(r.err) && totalCalls() === 0);
  }
  {
    // Late response: transport ignores the signal and resolves after revoke → discarded.
    install({ p1: ok(NO_JSON, 80) });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "pipeline_timeout"), 20);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("late response after revoke is DISCARDED (cancellation, no text returned)", isLifecycleCancelledError(r.err) && r.val === undefined && P1.calls === 1 && FB1.calls === 0);
  }
  {
    // Batch cancel noticed via the cancel source (Redis-backed in prod) → in-flight aborted by poll.
    install({ p1: hang });
    const ctx = newCtx(4242);
    setTimeout(() => cancelledBatches.add(4242), 30);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    cancelledBatches.delete(4242);
    check("batch cancel noticed → in-flight aborted (reason batch_cancelled, ≤ ~250ms poll)", isLifecycleCancelledError(r.err) && r.err.reason === "batch_cancelled" && r.ms < 600, { ms: r.ms, e: r.err?.message });
    check("batch cancel: no retry / failover", P1.calls === 1 && FB1.calls === 0);
  }
  {
    // Non-strict (legacy silent-fallback) path also honours the signal.
    process.env.SCORING_STRICT_PROVIDER = "false";
    install({ p1: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "admin_cancel_test"), 30);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    process.env.SCORING_STRICT_PROVIDER = "true";
    check("non-strict path: aborted, not failed over", isLifecycleCancelledError(r.err) && P1.aborted === 1 && FB1.calls + P2.calls + ARB.calls === 0, allMocks().map((m) => m.calls));
  }

  console.log("── 4. concurrent siblings (MEASURE_CONCURRENCY=5) ──");
  {
    install({ p1: hang });
    const ctx = newCtx();
    const base = live.size;
    const runs = runWithDiagContext(ctx, () => Promise.allSettled(Array.from({ length: 5 }, (_, i) => completeScoring("p1", { ...REQ, logMeta: { measureId: `M${i}` } } as any))));
    await sleep(30);
    check("5 siblings in flight before revoke", P1.inflight === 5, P1.inflight);
    check("5 per-request listeners attached to the attempt signal", lcListeners(ctx) === 5, lcListeners(ctx));
    const t0 = Date.now();
    revokeAttempt(ctx.lifecycle, "admin_cancel_test");
    const res = await runs;
    const elapsed = Date.now() - t0;
    check("all 5 siblings rejected with LifecycleCancelledError", res.every((x) => x.status === "rejected" && isLifecycleCancelledError((x as any).reason)));
    check("all 5 transports aborted together (<50ms)", P1.aborted === 5 && elapsed < 50, { aborted: P1.aborted, elapsed });
    check("no sibling retried or failed over", P1.calls === 5 && FB1.calls + P2.calls + ARB.calls === 0);
    await settleFlush();
    check("no orphaned listeners on attempt signal", lcListeners(ctx) === 0, lcListeners(ctx));
    check("no orphaned timers (per-request poll intervals + backoffs cleared)", live.size === base, live.size - base);
    check("no in-flight mock requests remain", totalInflight() === 0);
  }

  console.log("── 1/3. REAL scoreWithCascade (primary + secondary + arbiter) ──");
  const { scoreWithCascade, scoreSingleMeasurePass } = __analyzerTestHooks;
  const cascadeArgs = () => ({ companyName: "TestCo", companyId: 7, measure, evidenceText: evidence(), topicDescription: "climate", settings: cascadeSettings });
  {
    install({ p1: ok(NO_JSON), p2: ok(NO_JSON) });
    const r = await runWithDiagContext(newCtx(), () => catchErr(scoreWithCascade(cascadeArgs())));
    check("healthy cascade agreement: scored, no arbiter call", r.err == null && r.val?.score === 0 && ARB.calls === 0 && P1.calls === 1 && P2.calls === 1, { e: r.err?.message, calls: allMocks().map((m) => m.calls) });
  }
  {
    install({ p1: ok(YES_JSON), p2: ok(NO_JSON), arb: ok(YES_JSON) });
    const r = await runWithDiagContext(newCtx(), () => catchErr(scoreWithCascade(cascadeArgs())));
    check("healthy cascade disagreement: arbiter called once and decides", r.err == null && ARB.calls === 1 && r.val?.score === 1, { e: r.err?.message, calls: allMocks().map((m) => m.calls), s: r.val?.score });
  }
  {
    install({ p1: hang, p2: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "admin_cancel_test"), 40);
    const r = await runWithDiagContext(ctx, () => catchErr(scoreWithCascade(cascadeArgs())));
    check("cascade: primary + secondary in flight both aborted", P1.aborted === 1 && P2.aborted === 1, [P1.aborted, P2.aborted]);
    check("cascade: cancellation propagates (no score / abstain result)", isLifecycleCancelledError(r.err) && r.val === undefined, r.err?.message ?? r.val);
    check("cascade: arbiter never dispatched; no content retry, no failover", ARB.calls === 0 && P1.calls === 1 && P2.calls === 1 && FB1.calls === 0, allMocks().map((m) => m.calls));
  }
  {
    install({ p1: ok(YES_JSON), p2: ok(NO_JSON), arb: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "job_watchdog_timeout"), 60);
    const r = await runWithDiagContext(ctx, () => catchErr(scoreWithCascade(cascadeArgs())));
    check("cascade: in-flight arbiter aborted → cancellation, no result", isLifecycleCancelledError(r.err) && ARB.aborted === 1 && ARB.calls === 1 && FB1.calls === 0, { e: r.err?.message, calls: allMocks().map((m) => m.calls) });
  }
  {
    install();
    const ctx = newCtx(); revokeAttempt(ctx.lifecycle, "admin_cancel_test");
    const r = await runWithDiagContext(ctx, () => catchErr(scoreWithCascade(cascadeArgs())));
    check("cascade: revoked before start → zero dispatches", isLifecycleCancelledError(r.err) && totalCalls() === 0);
  }

  console.log("── 3. REAL scoreSingleMeasurePass: cancellation ≠ score/abstain ──");
  const passArgs = () => ({ companyName: "TestCo", companyId: 7, measure, evidenceText: evidence(), topicDescription: "climate", provider: "p1", scoringMode: "binary" });
  {
    install({ p1: ok("null") }); // documented content crash: null JSON → null-deref
    const r = await runWithDiagContext(newCtx(), () => catchErr(scoreSingleMeasurePass(passArgs())));
    check("control: non-cancel content crash still content-retried (3 calls) then ABSTAINS", r.err == null && P1.calls === 3 && (r.val as any)?.abstained === true, { e: r.err?.message, calls: P1.calls, v: (r.val as any)?.verdict });
  }
  {
    install({ p1: hang });
    const ctx = newCtx();
    setTimeout(() => revokeAttempt(ctx.lifecycle, "admin_cancel_test"), 30);
    const r = await runWithDiagContext(ctx, () => catchErr(scoreSingleMeasurePass(passArgs())));
    check("cancelled pass → throws LifecycleCancelledError (NOT abstain/zero)", isLifecycleCancelledError(r.err) && r.val === undefined, r.val);
    check("cancelled pass → NOT content-retried (1 call)", P1.calls === 1, P1.calls);
  }
  {
    // Deadline passes while the (null-content) response is in flight but before the
    // 250ms poll fires: completeScoring returns, parse fails, and the
    // content-retry dispatch gate must refuse the re-attempt.
    install({ p1: ok("null", 60) });
    const ctx = newCtx(77, { deadlineAt: new Date(Date.now() + 30) });
    const r = await runWithDiagContext(ctx, () => catchErr(scoreSingleMeasurePass(passArgs())));
    check("content-retry gated: deadline_elapsed → cancellation, 1 call, no abstain", isLifecycleCancelledError(r.err) && r.err.reason === "deadline_elapsed" && P1.calls === 1, { e: r.err?.message, calls: P1.calls });
  }

  console.log("── 2. ownership loss (startOwnershipWatch) ──");
  {
    install({ p1: hang });
    const ctx = newCtx();
    let reads = 0;
    const stop = startOwnershipWatch(ctx.lifecycle, async () => { reads++; return reads < 2 ? { attemptToken: TOKEN, status: "claimed" } : { attemptToken: "22222222-2222-4222-8222-222222222222", status: "claimed" }; }, 20);
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    stop();
    check("token mismatch (reclaimed by another replica) → self-revoke ownership_lost", ctx.lifecycle!.revoked && ctx.lifecycle!.revokedReason === "ownership_lost");
    check("old execution's in-flight request aborted, not retried/failed over", isLifecycleCancelledError(r.err) && r.err.reason === "ownership_lost" && P1.aborted === 1 && FB1.calls === 0, r.err?.message);
  }
  {
    const ctx = newCtx();
    const stop = startOwnershipWatch(ctx.lifecycle, async () => ({ attemptToken: TOKEN, status: "failed" }), 15);
    await sleep(60); stop();
    check("status no longer 'claimed' → ownership_lost", ctx.lifecycle!.revokedReason === "ownership_lost");
  }
  {
    const ctx = newCtx();
    let reads = 0;
    const stop = startOwnershipWatch(ctx.lifecycle, async () => { reads++; throw new Error("db blip"); }, 15);
    await sleep(70);
    const stop2 = startOwnershipWatch(ctx.lifecycle, async () => null, 15);
    await sleep(40); stop(); stop2();
    check("read error / missing row → fail-open (not revoked)", reads >= 2 && !ctx.lifecycle!.revoked, { reads, revoked: ctx.lifecycle!.revoked });
  }
  {
    const ctx = newCtx();
    let reads = 0;
    const base = live.size;
    const stop = startOwnershipWatch(ctx.lifecycle, async () => { reads++; return { attemptToken: TOKEN, status: "claimed" }; }, 15);
    await sleep(60); stop(); const after = reads; await sleep(50);
    check("matching owner → not revoked; stop() halts reads and clears the timer", !ctx.lifecycle!.revoked && after >= 2 && reads === after && live.size === base, { reads, after, t: live.size - base });
    const noTok = createAttemptLifecycle({ jobId: 1, batchId: 1, attemptNumber: 1, deadlineAt: null, attemptToken: null });
    let r2 = 0;
    const s2 = startOwnershipWatch(noTok, async () => { r2++; return null; }, 10);
    const s3 = startOwnershipWatch(ctx.lifecycle, async () => { r2++; return null; }, 0);
    await sleep(40); s2(); s3();
    check("watch is a no-op for token-less lifecycles and intervalMs=0", r2 === 0);
  }

  console.log("── logs: token-attributed [SCORING-REQ] start/settle ──");
  {
    process.env.SCORING_REQ_LOG = "all";
    const lines: string[] = [];
    const oL = console.log, oW = console.warn;
    console.log = (...a: any[]) => { lines.push(a.join(" ")); };
    console.warn = (...a: any[]) => { lines.push(a.join(" ")); };
    try {
      install({ p1: hang });
      const ctx = newCtx();
      setTimeout(() => revokeAttempt(ctx.lifecycle, "admin_cancel_test"), 20);
      await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", { ...REQ, logMeta: { measureId: "M9" } } as any)));
      install({ p1: ok() });
      await runWithDiagContext(newCtx(), () => completeScoring("p1", { ...REQ, logMeta: { measureId: "M10" } } as any));
      install({ p1: ok() });
      await completeScoring("p1", REQ); // outside an attempt: silent
    } finally { console.log = oL; console.warn = oW; process.env.SCORING_REQ_LOG = "settle"; }
    const req = lines.filter((l) => l.startsWith("[SCORING-REQ]"));
    const has = (re: RegExp) => req.some((l) => re.test(l));
    check("start log carries token/job/attempt/batch/company/measure/provider/role/call",
      has(new RegExp(`^\\[SCORING-REQ\\] start token=${TOKEN} job=501 attempt=1 batch=77 company=7 measure=M9 provider=p1 role=primary#1 call=scoring$`)), req);
    check("settle log outcome=aborted with reason", has(/settle .*measure=M9 .*outcome=aborted ms=\d+ reason="admin_cancel_test"/));
    check("settle log outcome=success", has(/settle .*measure=M10 .*outcome=success/));
    check("no [SCORING-REQ] lines outside an attempt context (4 lines total)", req.length === 4, req.length);
  }

  console.log("── 6. healthy run: 36 measures, retry + fallback intact, inert outside attempts ──");
  {
    const failOnceIds = new Set(["M0", "M12", "M24"]);
    const seen = new Map<string, number>();
    install({
      p1: async (_n, opts) => {
        const id = String(opts.prompt);
        const k = (seen.get(id) ?? 0) + 1; seen.set(id, k);
        if (failOnceIds.has(id) && k === 1) return fail500(_n, opts, P1);
        await sleep(5);
        return NO_JSON;
      },
    });
    const ctx = newCtx();
    const base = live.size;
    const results: string[] = [];
    await runWithDiagContext(ctx, async () => {
      const ids = Array.from({ length: 36 }, (_, i) => `M${i}`);
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        const out = await Promise.all(batch.map((id) => completeScoring("p1", { ...REQ, prompt: id, logMeta: { measureId: id } } as any)));
        out.forEach((o) => results.push(o.provider));
      }
    });
    check("36/36 measures scored", results.length === 36 && results.every((p) => p === "p1"), results.length);
    check("normal retry intact: 3 transient failures retried on same provider (39 calls)", P1.calls === 39 && FB1.calls === 0, P1.calls);
    check("zero aborts, attempt not revoked", P1.aborted === 0 && !ctx.lifecycle!.revoked);
    await settleFlush();
    check("no orphaned listeners/timers after healthy run", lcListeners(ctx) === 0 && live.size === base, { l: lcListeners(ctx), t: live.size - base });
  }
  {
    install({ p1: fail500, fb1: ok(NO_JSON) });
    const ctx = newCtx();
    const r = await runWithDiagContext(ctx, () => catchErr(completeScoring("p1", REQ)));
    check("normal fallback intact: primary exhausted after 4 tries → fb1 grades", r.err == null && r.val?.provider === "fb1" && P1.calls === 4 && FB1.calls === 1, { e: r.err?.message, calls: allMocks().map((m) => m.calls) });
  }
  {
    install({ p1: ok() });
    const r = await completeScoring("p1", REQ);
    check("outside an attempt context: no signal passed to the transport (inert)", r.provider === "p1" && P1.signals[0] === undefined);
  }

  restore?.();
  await settleFlush();
  check("global: no live timers left behind by the scoring path", live.size === timerBase, live.size - timerBase);
  console.log(`\n${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

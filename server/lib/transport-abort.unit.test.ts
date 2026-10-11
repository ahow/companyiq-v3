/**
 * Adapter-level transport-abort tests for the SCORING path, plus the
 * cancellation-aware LLM slot, admin-cancel → shared attempt controller,
 * ownership-watch shutdown, and the job-watchdog timer clearing.
 * No DB / Redis / external network / paid calls: the real transports talk only
 * to an in-process HTTP server on 127.0.0.1, or to a stub axios adapter.
 * Run: DATABASE_URL=<any pg url; not connected> npx tsx server/lib/transport-abort.unit.test.ts
 *
 *  1. Transport matrix: REAL OpenAICompatibleProvider (axios http adapter) and
 *     REAL ClaudeProvider (@anthropic-ai/sdk, global fetch; non-stream + stream)
 *     against a hanging loopback server; GeminiProvider (axios, fixed Google
 *     URL) via a stub axios adapter. Captures the signal handed to the
 *     transport, aborts it, asserts rejection is cancellation, single dispatch,
 *     no retry / key rotation / fallback. Unsupported-abort paths documented.
 *  2. acquireLlmSlot(signal): queued waiter abort, FIFO, no permit leak.
 *  3. Admin cancel (registered batch cancel source) aborts the SHARED lc.abort
 *     while provider calls are pending; ownership watch stop during a pending poll.
 *  A. raceWithWatchdog clears its timer in finally (worker.ts job watchdog).
 */
process.exitCode = 1;
const keepAlive = setInterval(() => {}, 1000);

import http from "node:http";
import type { AddressInfo } from "node:net";
import { getEventListeners } from "node:events";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";
import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import {
  createAttemptLifecycle, revokeAttempt, registerBatchCancelSource, LifecycleCancelledError,
  isLifecycleCancelledError, startOwnershipWatch, raceWithWatchdog, type JobOwnershipSnapshot,
} from "./lifecycle-fence.js";
import {
  completeScoring, completeWithFallback, __setProvidersForTests, __providerClassesForTests,
  __llmSlotForTests, type AIProvider,
} from "./ai-providers.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3000) { const t0 = Date.now(); while (!cond() && Date.now() - t0 < ms) await sleep(5); return cond(); }
async function catchErr<T>(p: Promise<T>): Promise<{ err: any; val?: T; ms: number }> {
  const t0 = Date.now();
  try { const val = await p; return { err: null, val, ms: Date.now() - t0 }; } catch (err) { return { err, ms: Date.now() - t0 }; }
}
let unhandled = 0;
process.on("unhandledRejection", (e) => { unhandled++; console.error("UNHANDLED", e); });

// ─── Timer tracker (same approach as scoring-cancellation.unit.test.ts) ──────
const live = new Set<any>();
const created: any[] = [];
{
  const oSI = globalThis.setInterval, oCI = globalThis.clearInterval;
  const oST = globalThis.setTimeout, oCT = globalThis.clearTimeout;
  (globalThis as any).setInterval = (fn: any, ms?: number, ...a: any[]) => { const t = oSI(fn, ms, ...a); live.add(t); created.push(t); return t; };
  (globalThis as any).clearInterval = (t: any) => { live.delete(t); oCI(t); };
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = oST((...x: any[]) => { live.delete(t); fn(...x); }, ms, ...a); live.add(t); return t;
  };
  (globalThis as any).clearTimeout = (t: any) => { live.delete(t); oCT(t); };
}

// ─── Loopback server: hangs by default, or answers per `mode` ────────────────
type Mode = "hang" | "openai-ok" | "anthropic-ok";
let mode: Mode = "hang";
let reqs = 0, closes = 0;
const NO_JSON = JSON.stringify({ score: 0, verdict: "No", confidence: "High", evidenceSummary: "none", quotes: [] });
const server = http.createServer((req, res) => {
  reqs++;
  req.resume();
  res.on("close", () => { if (!res.writableEnded) closes++; });
  req.on("end", () => {
    if (mode === "openai-ok") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: NO_JSON }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    } else if (mode === "anthropic-ok") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: NO_JSON }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    } // "hang": never respond
  });
});

// ─── Capture the signal handed to each transport ─────────────────────────────
// axios: request interceptor (runs inside axios.post, immediately before the
// adapter). Anthropic: Messages.prototype.create (the SDK method the provider
// calls) + globalThis.fetch (the SDK's transport).
const axiosSignals: Array<AbortSignal | undefined> = [];
axios.interceptors.request.use((cfg) => { axiosSignals.push(cfg.signal as AbortSignal | undefined); return cfg; });
const sdkCreateSignals: Array<AbortSignal | undefined> = [];
const origCreate = (Anthropic as any).Messages.prototype.create;
(Anthropic as any).Messages.prototype.create = function (this: any, body: any, options?: any) {
  sdkCreateSignals.push(options?.signal);
  return origCreate.call(this, body, options);
};
const fetchSignals: Array<AbortSignal | undefined> = [];
const origFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => { fetchSignals.push(init?.signal); return origFetch(input, init); };

// Counting mock used as the configured fallback (must stay at 0 calls).
function mockFb(): AIProvider & { calls: number } {
  const m: any = { name: "fb", model: "fb-model", family: "fam-fb", calls: 0, isAvailable: () => true,
    complete: async () => { m.calls++; return NO_JSON; } };
  return m;
}
const TOKEN = "22222222-2222-4222-8222-222222222222";
function newCtx(batchId = 88): DiagContext {
  const lifecycle = createAttemptLifecycle({ jobId: 601, batchId, attemptNumber: 1, deadlineAt: null, attemptToken: TOKEN });
  return { batchId, jobId: 601, attemptNumber: 1, companyId: 9, lifecycle };
}
const REQ = { system: "s", prompt: "p", json: true, maxTokens: 50 };
const reasonOf = (s: AbortSignal | undefined) => (isLifecycleCancelledError(s?.reason) ? s!.reason.reason : String(s?.reason));

async function main() {
  process.env.LLM_USAGE_LOGGING_ENABLED = "false";
  process.env.SCORING_STRICT_PROVIDER = "true";
  process.env.SCORING_REQ_LOG = "off";
  delete process.env.SCORING_PROVIDER_RETRIES; // production default (4)
  const cancelledBatches = new Set<number>();
  registerBatchCancelSource((id) => cancelledBatches.has(id));

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TA_TEST_KEY = "k1,k2"; // two keys → would rotate on 429/401; must NOT rotate on abort
  process.env.ANTHROPIC_API_KEY = "ak1,ak2";
  process.env.ANTHROPIC_BASE_URL = base; // SDK reads this at construction (client.js L67)
  process.env.GEMINI_API_KEY = "gk";
  const { ClaudeProvider, OpenAICompatibleProvider, GeminiProvider } = __providerClassesForTests;
  const oc = new OpenAICompatibleProvider({ name: "oc", model: "oc-model", family: "fam-oc", apiKeyEnv: "TA_TEST_KEY", baseUrl: base });
  const claude = new ClaudeProvider("claude-test-model");
  (claude as any).name = "claude-t";
  const gem = new GeminiProvider();
  const timerBase = live.size;

  const reset = () => { reqs = 0; closes = 0; axiosSignals.length = 0; sdkCreateSignals.length = 0; fetchSignals.length = 0; mode = "hang"; };

  // ═══ 1A. OpenAICompatibleProvider — real axios http adapter ═══════════════
  console.log("── 1A. OpenAI-compatible (raw axios, real http adapter) ──");
  for (const variant of ["explicit", "attempt"] as const) {
    reset();
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "oc,fb";
    const restore = __setProvidersForTests([oc, fb]);
    const ac = new AbortController();
    const ctx = newCtx();
    const p = variant === "explicit"
      ? catchErr(completeScoring("oc", { ...REQ, signal: ac.signal }))
      : runWithDiagContext(ctx, () => catchErr(completeScoring("oc", REQ)));
    await waitFor(() => reqs === 1);
    const sig = axiosSignals[0];
    const pre = { aborted: !!sig?.aborted, reqs };
    if (variant === "explicit") ac.abort(new LifecycleCancelledError("admin_cancel"));
    else revokeAttempt(ctx.lifecycle!, "ownership_lost");
    const r = await p;
    await waitFor(() => closes === 1, 1000);
    const want = variant === "explicit" ? "admin_cancel" : "ownership_lost";
    if (variant === "explicit") check("1A explicit: signal handed to axios === caller's signal (identity)", sig === ac.signal);
    else check("1A attempt: signal handed to axios is the attempt-derived per-request signal (child of lc.abort), live before revoke", !!sig && sig !== ctx.lifecycle!.abort.signal && !pre.aborted);
    check(`1A ${variant}: transport signal aborted with LifecycleCancelledError(${want})`, !!sig?.aborted && reasonOf(sig) === want, reasonOf(sig));
    check(`1A ${variant}: in-flight call rejected with LifecycleCancelledError(${want}) promptly`, isLifecycleCancelledError(r.err) && r.err.reason === want && r.ms < 1000, { e: r.err?.message, ms: r.ms });
    check(`1A ${variant}: exactly 1 HTTP request, socket closed by abort, no key rotation/retry, fallback 0`, reqs === 1 && closes === 1 && axiosSignals.length === 1 && fb.calls === 0, { reqs, closes, ax: axiosSignals.length, fb: fb.calls });
    restore();
  }
  {
    reset();
    const fb = mockFb();
    const restore = __setProvidersForTests([oc, fb]);
    const ac = new AbortController(); ac.abort(new LifecycleCancelledError("batch_cancelled"));
    const r = await catchErr(completeScoring("oc", { ...REQ, signal: ac.signal }));
    check("1A pre-aborted: rejected before dispatch, 0 HTTP requests, fallback 0", isLifecycleCancelledError(r.err) && reqs === 0 && axiosSignals.length === 0 && fb.calls === 0, { reqs, e: r.err?.message });
    mode = "openai-ok";
    const ok = await catchErr(completeScoring("oc", { ...REQ, signal: new AbortController().signal }));
    check("1A healthy: same real transport returns the response when not aborted", ok.err == null && ok.val?.text === NO_JSON && ok.val?.provider === "oc", ok.err?.message);
    restore();
  }

  // ═══ 1B. ClaudeProvider — real @anthropic-ai/sdk over global fetch ════════
  console.log("── 1B. Anthropic SDK (messages.create / messages.stream → fetch) ──");
  for (const variant of ["create", "stream"] as const) {
    reset();
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "claude-t,fb";
    const restore = __setProvidersForTests([claude, fb]);
    const ac = new AbortController();
    const maxTokens = variant === "stream" ? 25000 : 50; // >20000 → messages.stream branch
    const p = catchErr(completeScoring("claude-t", { ...REQ, maxTokens, signal: ac.signal }));
    await waitFor(() => reqs === 1);
    const userListeners = getEventListeners(ac.signal, "abort").length;
    ac.abort(new LifecycleCancelledError("admin_cancel"));
    const r = await p;
    await waitFor(() => closes === 1, 1000);
    if (variant === "create") check("1B create: signal handed to SDK messages.create === caller's signal (identity)", sdkCreateSignals[0] === ac.signal);
    else check("1B stream: SDK MessageStream subscribed to caller's signal (abort listener attached) and passed its own linked signal to create", userListeners >= 1 && !!sdkCreateSignals[0] && sdkCreateSignals[0] !== ac.signal, { userListeners });
    check(`1B ${variant}: SDK's fetch signal (internal, linked) aborted`, fetchSignals.length === 1 && !!fetchSignals[0]?.aborted);
    check(`1B ${variant}: in-flight call rejected with LifecycleCancelledError(admin_cancel)`, isLifecycleCancelledError(r.err) && r.err.reason === "admin_cancel" && r.ms < 1000, { e: r.err?.message, ms: r.ms });
    check(`1B ${variant}: 1 fetch / 1 HTTP request (SDK maxRetries=3 not used, no key rotation), fallback 0`, fetchSignals.length === 1 && reqs === 1 && fb.calls === 0, { f: fetchSignals.length, reqs, fb: fb.calls });
    restore();
  }
  {
    reset();
    const fb = mockFb();
    const restore = __setProvidersForTests([claude, fb]);
    const ctx = newCtx();
    const p = runWithDiagContext(ctx, () => catchErr(completeScoring("claude-t", REQ)));
    await waitFor(() => reqs === 1);
    revokeAttempt(ctx.lifecycle!, "pipeline_timeout");
    const r = await p;
    check("1B attempt ctx: revoke aborts the SDK request via the attempt-derived signal", isLifecycleCancelledError(r.err) && r.err.reason === "pipeline_timeout" && !!sdkCreateSignals[0]?.aborted && fetchSignals.length === 1 && fb.calls === 0, { e: r.err?.message });
    mode = "anthropic-ok";
    const ok = await catchErr(completeScoring("claude-t", { ...REQ, signal: new AbortController().signal }));
    check("1B healthy: same real SDK transport returns the response when not aborted", ok.err == null && ok.val?.text === NO_JSON, ok.err?.message);
    restore();
  }

  // ═══ 1C. GeminiProvider — axios to a fixed Google URL → stub adapter ══════
  console.log("── 1C. Gemini (raw axios; stub adapter, URL not redirectable) ──");
  const savedAdapter = axios.defaults.adapter;
  {
    reset();
    let adapterCalls = 0; let adapterSignal: AbortSignal | undefined;
    axios.defaults.adapter = (config: any) => new Promise((_res, rej) => {
      adapterCalls++; adapterSignal = config.signal;
      const on = () => rej(new axios.CanceledError("canceled", "ERR_CANCELED", config));
      if (config.signal?.aborted) on(); else config.signal?.addEventListener("abort", on, { once: true });
    });
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "gemini,fb";
    const restore = __setProvidersForTests([gem, fb]);
    const ac = new AbortController();
    const p = catchErr(completeScoring("gemini", { ...REQ, signal: ac.signal }));
    await waitFor(() => adapterCalls === 1);
    ac.abort(new LifecycleCancelledError("admin_cancel"));
    const r = await p;
    check("1C gemini: signal handed to axios adapter === caller's signal (identity)", adapterSignal === ac.signal && axiosSignals[0] === ac.signal);
    check("1C gemini: abort rejects with LifecycleCancelledError, 1 adapter call, fallback 0", isLifecycleCancelledError(r.err) && r.err.reason === "admin_cancel" && adapterCalls === 1 && fb.calls === 0, { e: r.err?.message, adapterCalls, fb: fb.calls });
    restore();
  }

  // ═══ 1D. Paths where the transport does NOT honour abort ══════════════════
  console.log("── 1D. Unsupported-abort fallbacks ──");
  {
    // Transport that IGNORES the signal and resolves after revoke → the
    // post-dispatch check discards the text (late-response), no retry/fallback.
    reset();
    let adapterCalls = 0;
    axios.defaults.adapter = async (config: any) => {
      adapterCalls++;
      await new Promise((r) => config.signal.addEventListener("abort", r, { once: true }));
      await sleep(10);
      return { data: { choices: [{ message: { content: NO_JSON }, finish_reason: "stop" }] }, status: 200, statusText: "OK", headers: {}, config };
    };
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "oc,fb";
    const restore = __setProvidersForTests([oc, fb]);
    const ac = new AbortController();
    const p = catchErr(completeScoring("oc", { ...REQ, signal: ac.signal }));
    await waitFor(() => adapterCalls === 1);
    ac.abort(new LifecycleCancelledError("admin_cancel"));
    const r = await p;
    // axios itself re-checks the signal after the adapter resolves
    // (node_modules/axios/lib/core/dispatchRequest.js L50) and throws
    // CanceledError, so the late body never reaches the provider.
    check("1D signal-ignoring axios adapter: late response discarded by axios post-adapter check → cancellation, 1 dispatch, fallback 0",
      isLifecycleCancelledError(r.err) && r.err.reason === "admin_cancel" && adapterCalls === 1 && fb.calls === 0, { e: r.err?.message, adapterCalls });
    restore();
  }
  {
    // A transport that ignores the signal ABOVE axios (provider resolves after
    // abort): completeScoring's own post-dispatch check discards the text.
    let n = 0, resolvedAfterAbort = false;
    const lateP: AIProvider = { name: "late", model: "late-m", family: "f", isAvailable: () => true,
      complete: async (o: any) => { n++; await new Promise((r) => o.signal.addEventListener("abort", r, { once: true })); resolvedAfterAbort = o.signal.aborted; return NO_JSON; } };
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "late,fb";
    const restore = __setProvidersForTests([lateP, fb]);
    const ac = new AbortController();
    const p = catchErr(completeScoring("late", { ...REQ, signal: ac.signal }));
    await waitFor(() => n === 1);
    ac.abort(new LifecycleCancelledError("admin_cancel"));
    const r = await p;
    check("1D signal-ignoring provider: response after abort DISCARDED by completeScoring late-response check, 1 dispatch, fallback 0",
      resolvedAfterAbort && isLifecycleCancelledError(r.err) && r.val === undefined && n === 1 && fb.calls === 0, { e: r.err?.message, n, resolvedAfterAbort });
    restore();
  }
  axios.defaults.adapter = savedAdapter;
  {
    // Non-scoring completeWithFallback passes NO signal: not abortable by design.
    reset(); mode = "openai-ok";
    const restore = __setProvidersForTests([oc]);
    const r = await catchErr(completeWithFallback("oc", REQ));
    check("1D completeWithFallback (non-scoring): NO signal reaches axios (documented: not abortable)", r.err == null && axiosSignals.length === 1 && axiosSignals[0] === undefined, { n: axiosSignals.length, e: r.err?.message });
    restore();
  }

  // ═══ 2. acquireLlmSlot(signal) ═══════════════════════════════════════════
  console.log("── 2. Cancellation-aware LLM slot ──");
  {
    const S = __llmSlotForTests;
    const max = S.state().max;
    check("2 precondition: pool idle", S.state().active === 0 && S.state().waiting === 0, S.state());
    for (let i = 0; i < max; i++) await S.acquire();
    const order: string[] = [];
    const acA = new AbortController(), acC = new AbortController();
    const pA = catchErr(S.acquire(acA.signal).then(() => { order.push("A"); }));
    const pB = S.acquire().then(() => { order.push("B"); });
    const pC = S.acquire(acC.signal).then(() => { order.push("C"); });
    await sleep(5);
    check("2 three waiters queued behind a full pool", S.state().active === max && S.state().waiting === 3, S.state());
    acA.abort(new LifecycleCancelledError("admin_cancel"));
    const rA = await pA;
    check("2a aborted queued waiter rejects promptly with LifecycleCancelledError", isLifecycleCancelledError(rA.err) && rA.err.reason === "admin_cancel" && rA.ms < 50, { e: rA.err?.message, ms: rA.ms });
    check("2c aborted waiter: queue entry removed, abort listener removed, no permit taken", S.state().waiting === 2 && S.state().active === max && getEventListeners(acA.signal, "abort").length === 0, S.state());
    S.release(); await pB;
    check("2b/2d capacity returns → next NON-cancelled waiter (B) acquires; A never dispatches", order.join() === "B" && S.state().active === max && S.state().waiting === 1, { order, s: S.state() });
    S.release(); await pC;
    check("2d FIFO preserved for remaining waiter (C), its listener removed on acquire", order.join() === "B,C" && S.state().waiting === 0 && getEventListeners(acC.signal, "abort").length === 0, { order, s: S.state() });
    for (let i = 0; i < max; i++) S.release();
    check("2c permits return exactly to 0 (no leak)", S.state().active === 0 && S.state().waiting === 0, S.state());

    // Race: woken by release, aborted before its continuation runs.
    for (let i = 0; i < max; i++) await S.acquire();
    const acD = new AbortController();
    const pD = catchErr(S.acquire(acD.signal));
    const pE = S.acquire();
    await sleep(5);
    S.release();                                       // hands wake-up to D …
    acD.abort(new LifecycleCancelledError("ownership_lost")); // … which is aborted first
    const rD = await pD; await pE;
    check("2 race (wake then abort): D rejects, wake-up passed to E, active stays == max (no double count, no loss)",
      isLifecycleCancelledError(rD.err) && S.state().active === max && S.state().waiting === 0, { e: rD.err?.message, s: S.state() });
    for (let i = 0; i < max; i++) S.release();
    const acP = new AbortController(); acP.abort(new LifecycleCancelledError("x"));
    const rP = await catchErr(S.acquire(acP.signal));
    check("2 pre-aborted: rejects without taking a permit or queueing", isLifecycleCancelledError(rP.err) && S.state().active === 0 && S.state().waiting === 0, S.state());

    // Through completeScoring: queued scoring call revoked while waiting.
    const calls = { n: 0 };
    const pm: AIProvider = { name: "pm", model: "pm-m", family: "f", isAvailable: () => true, complete: async () => { calls.n++; return NO_JSON; } };
    const restore = __setProvidersForTests([pm]);
    process.env.PROVIDER_FALLBACK_ORDER = "pm";
    for (let i = 0; i < max; i++) await S.acquire();
    const ctx = newCtx();
    const pq = runWithDiagContext(ctx, () => catchErr(completeScoring("pm", REQ)));
    await sleep(5);
    const queued = S.state().waiting === 1;
    revokeAttempt(ctx.lifecycle!, "job_watchdog_timeout");
    const rq = await pq;
    check("2 completeScoring queued for a slot: revoke rejects it (LifecycleCancelledError), provider never called",
      queued && isLifecycleCancelledError(rq.err) && rq.err.reason === "job_watchdog_timeout" && calls.n === 0, { queued, e: rq.err?.message, calls: calls.n });
    check("2 completeScoring cancelled-in-queue did NOT release a permit it never held (active still == max)", S.state().active === max && S.state().waiting === 0, S.state());
    for (let i = 0; i < max; i++) S.release();
    const h = await catchErr(completeScoring("pm", REQ));
    check("2 healthy completeScoring afterwards: acquires, scores, releases (active back to 0)", h.err == null && calls.n === 1 && S.state().active === 0, S.state());
    restore();
  }

  // ═══ 3. Admin cancel → shared controller, while provider calls PENDING ════
  console.log("── 3. Admin cancel aborts the shared attempt controller ──");
  {
    reset();
    const fb = mockFb();
    process.env.PROVIDER_FALLBACK_ORDER = "oc,fb";
    const restore = __setProvidersForTests([oc, fb]);
    const ctx = newCtx(4242);
    const lc = ctx.lifecycle!;
    const p1 = runWithDiagContext(ctx, () => catchErr(completeScoring("oc", REQ)));
    const p2 = runWithDiagContext(ctx, () => catchErr(completeScoring("oc", { ...REQ, prompt: "p2" })));
    await waitFor(() => reqs === 2);
    const sigs = [...axiosSignals];
    const pending = !lc.abort.signal.aborted && sigs.every((s) => s && !s.aborted);
    const t0 = Date.now();
    cancelledBatches.add(4242); // what isBatchCancelledCached reports after an admin cancel
    const [r1, r2] = await Promise.all([p1, p2]);
    const ms = Date.now() - t0;
    await waitFor(() => closes === 2, 1000);
    check("3 both provider calls pending before cancel", pending && reqs === 2 && sigs.length === 2);
    check("3 SHARED lc.abort fired (lc.revoked, revokedReason=batch_cancelled)", lc.abort.signal.aborted && lc.revoked && lc.revokedReason === "batch_cancelled", { r: lc.revokedReason });
    check("3 both transport signals aborted with batch_cancelled", sigs.every((s) => s!.aborted && reasonOf(s) === "batch_cancelled"), sigs.map(reasonOf));
    check("3 both pending calls rejected mid-flight with LifecycleCancelledError(batch_cancelled) within one poll (<1000ms)",
      [r1, r2].every((r) => isLifecycleCancelledError(r.err) && r.err.reason === "batch_cancelled") && ms < 1000, { ms, e: [r1.err?.message, r2.err?.message] });
    check("3 no retry / fallback after admin cancel; sockets closed", reqs === 2 && closes === 2 && fb.calls === 0, { reqs, closes, fb: fb.calls });
    cancelledBatches.delete(4242);
    restore();
  }

  // ═══ 3b. Ownership watch stop() while a poll is pending ═══════════════════
  console.log("── 3b. Ownership watch shutdown ──");
  for (const outcome of ["mismatch", "reject"] as const) {
    const ctx = newCtx();
    const lc = ctx.lifecycle!;
    let reads = 0; let settle!: (v: JobOwnershipSnapshot | null) => void; let fail!: (e: any) => void;
    const before = created.length;
    const stop = startOwnershipWatch(lc, () => { reads++; return new Promise((res, rej) => { settle = res; fail = rej; }); }, 15);
    const watchTimer = created.slice(before).find(Boolean);
    await waitFor(() => reads === 1);
    await sleep(80); // ≥5 more intervals elapse while the first read is pending
    const overlapOk = reads === 1;
    const unrefOk = !!watchTimer && typeof watchTimer.hasRef === "function" && watchTimer.hasRef() === false;
    stop();
    if (outcome === "mismatch") settle({ attemptToken: "someone-else", status: "claimed" });
    else fail(new Error("db down"));
    await sleep(40);
    check(`3b ${outcome}: overlap guard — no second read while first pending`, overlapOk, { reads });
    check(`3b ${outcome}: watch timer is unref'd`, unrefOk);
    check(`3b ${outcome}: poll settling after stop() → no revoke, no further reads, timer cleared`, !lc.revoked && reads === 1 && !live.has(watchTimer), { revoked: lc.revoked, reads });
  }
  check("3b no unhandled rejections", unhandled === 0, unhandled);

  // ═══ A. raceWithWatchdog (worker.ts job watchdog) ═════════════════════════
  console.log("── A. Job watchdog timer cleared in finally ──");
  {
    let fired = 0;
    const b0 = live.size;
    const v = await raceWithWatchdog(sleep(10).then(() => "done"), 200, () => { fired++; return new Error("wd"); });
    check("A work settles first → resolves and watchdog timer is cleared immediately", v === "done" && live.size === b0, { live: live.size - b0 });
    await sleep(250);
    check("A cleared watchdog never fires after the job settled", fired === 0);
    const rj = await catchErr(raceWithWatchdog(Promise.reject(new Error("boom")), 200, () => { fired++; return new Error("wd"); }));
    check("A work rejects → same rejection, timer cleared, watchdog not fired", rj.err?.message === "boom" && live.size === b0 && fired === 0);
    const lc = newCtx().lifecycle!;
    const hangR = await catchErr(raceWithWatchdog(new Promise<string>(() => {}), 30, () => { fired++; revokeAttempt(lc, "job_watchdog_timeout"); return new Error("Job watchdog timeout after 30ms"); }));
    check("A hung work → watchdog fires once, onFire side effects run (revoke), race rejects with its Error", fired === 1 && lc.revokedReason === "job_watchdog_timeout" && hangR.err?.message === "Job watchdog timeout after 30ms" && live.size === b0);
  }

  await new Promise<void>((r) => { (server as any).closeAllConnections?.(); server.close(() => r()); });
  await sleep(20);
  check("global: no live timers left behind", live.size === timerBase, live.size - timerBase);
  check("global: no unhandled rejections", unhandled === 0, unhandled);
  console.log(`\n${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

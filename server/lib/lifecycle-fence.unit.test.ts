/**
 * Standalone unit tests for the lifecycle dispatch gates (no DB/Redis I/O).
 * Run: DATABASE_URL=<any pg url; not connected> npx tsx server/lib/lifecycle-fence.unit.test.ts
 *
 * Covers: discovery withBucket pre-acquire / post-acquire / in-flight gates,
 * attempt revoke + deadline, requestAbortSignal, fault-inject re-keying,
 * fault-inject FAIL-CLOSED (companyId-only spec is inert), and the REAL
 * discovery search path (runTargetedDisclosureQuery -> webSearch ->
 * webSearchInner -> withBucket(serperBucket) -> webSearchSerper -> axios.post,
 * only axios.post stubbed) driven in the same sequential per-query loop shape
 * as pipeline.ts's targeted-repair loop, with the cancel source flipping mid-loop.
 */
// Premature exit (e.g. event loop drained while a promise is pending) must not
// look like success: default to failure until main() completes.
process.exitCode = 1;
// The lifecycle poll timer is unref'd (as in production, where sockets keep the
// loop alive); keep the loop alive for the fake in-flight requests below.
const keepAlive = setInterval(() => {}, 1000);

import { runWithDiagContext, type DiagContext } from "./diag-context.js";
import {
  createAttemptLifecycle, revokeAttempt, assertDispatchAllowed, dispatchRevokedReason,
  registerBatchCancelSource, requestAbortSignal, isLifecycleCancelledError,
  ownershipFromContext, requireOwnershipForBatchWrite, ownerPredicate,
} from "./lifecycle-fence.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { withBucket, runTargetedDisclosureQuery } from "./discovery.js";
import axios from "axios";
import {
  parseFaultConfig, __reloadFaultConfigForTests, getFaultSpec, faultTimeoutMs,
  isFaultInjectActive, maybeFireCancel,
} from "./fault-inject.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); } else { failed++; console.error(`  FAIL  ${name}`); }
}

const cancelled = new Set<number>();
registerBatchCancelSource((id) => cancelled.has(id));

function ctxFor(batchId: number, opts: { deadlineAt?: Date | null } = {}): DiagContext {
  const lifecycle = createAttemptLifecycle({ jobId: 1, batchId, attemptNumber: 1, deadlineAt: opts.deadlineAt ?? null });
  return { batchId, jobId: 1, attemptNumber: 1, companyId: 7, lifecycle };
}

function fakeBucket(acquireDelayMs = 0, onAcquire?: () => void) {
  const b = { acquired: 0, released: 0,
    async acquire() { b.acquired++; if (acquireDelayMs) await new Promise((r) => setTimeout(r, acquireDelayMs)); onAcquire?.(); },
    release() { b.released++; } };
  return b;
}

async function main() {
  console.log("── discovery dispatch gates (O1) ──");
  // 1. No context (scripts): behaviour unchanged.
  {
    const b = fakeBucket();
    const r = await withBucket(b as any, async () => "ok");
    check("no attempt context: withBucket runs fn unchanged", r === "ok" && b.released === 1);
  }
  // 2. Cancelled BEFORE dispatch: no acquire, fn never called.
  {
    cancelled.add(101);
    const b = fakeBucket(); let called = false;
    let err: unknown = null;
    await runWithDiagContext(ctxFor(101), async () => {
      try { await withBucket(b as any, async () => { called = true; return 1; }); } catch (e) { err = e; }
    });
    check("pre-cancel: LifecycleCancelledError thrown", isLifecycleCancelledError(err));
    check("pre-cancel: provider fn never dispatched", !called);
    check("pre-cancel: bucket never acquired", b.acquired === 0 && b.released === 0);
  }
  // 3. Cancel arrives WHILE waiting for a bucket token: refused post-acquire, token released.
  {
    const b = fakeBucket(50, () => cancelled.add(102)); let called = false; let err: unknown = null;
    await runWithDiagContext(ctxFor(102), async () => {
      try { await withBucket(b as any, async () => { called = true; return 1; }); } catch (e) { err = e; }
    });
    check("cancel during bucket wait: refused post-acquire", isLifecycleCancelledError(err) && /post-acquire/.test(String((err as Error).message)));
    check("cancel during bucket wait: provider fn never dispatched", !called);
    check("cancel during bucket wait: token released (no leak)", b.acquired === 1 && b.released === 1);
  }
  // 4. Cancel arrives while the provider request is IN FLIGHT: abort signal fires.
  {
    const b = fakeBucket(); let sawAbort = false; let err: unknown = null;
    await runWithDiagContext(ctxFor(103), async () => {
      try {
        await withBucket(b as any, (signal) => new Promise((_, rej) => {
          setTimeout(() => cancelled.add(103), 20);
          signal!.addEventListener("abort", () => { sawAbort = true; rej(signal!.reason); });
        }));
      } catch (e) { err = e; }
    });
    check("in-flight cancel: request AbortSignal fired", sawAbort);
    check("in-flight cancel: surfaced as LifecycleCancelledError", isLifecycleCancelledError(err));
    check("in-flight cancel: token released", b.released === 1);
  }
  // 5. Watchdog/pipeline-timeout revoke aborts in-flight immediately (no poll wait).
  {
    const ctx = ctxFor(104); const b = fakeBucket(); let err: unknown = null; const t0 = Date.now();
    await runWithDiagContext(ctx, async () => {
      try {
        await withBucket(b as any, (signal) => new Promise((_, rej) => {
          setTimeout(() => revokeAttempt(ctx.lifecycle, "job_watchdog_timeout"), 10);
          signal!.addEventListener("abort", () => rej(signal!.reason));
        }));
      } catch (e) { err = e; }
    });
    check("revoke: in-flight aborted with reason", isLifecycleCancelledError(err) && (err as any).reason === "job_watchdog_timeout");
    check("revoke: abort latency < 200ms (event-driven)", Date.now() - t0 < 200);
    let err2: unknown = null;
    await runWithDiagContext(ctx, async () => { try { assertDispatchAllowed("x"); } catch (e) { err2 = e; } });
    check("revoke: subsequent dispatch refused", isLifecycleCancelledError(err2));
  }
  // 6. Deadline elapsed -> refused even without a revoke/cancel.
  {
    const ctx = ctxFor(105, { deadlineAt: new Date(Date.now() - 1) });
    check("deadline elapsed: dispatchRevokedReason=deadline_elapsed", dispatchRevokedReason(ctx) === "deadline_elapsed");
    const ok = ctxFor(106, { deadlineAt: new Date(Date.now() + 60_000) });
    check("deadline in future + not cancelled: allowed", dispatchRevokedReason(ok) === null);
  }
  // 7. requestAbortSignal with already-revoked parent is aborted synchronously.
  {
    const ctx = ctxFor(107); revokeAttempt(ctx.lifecycle, "pipeline_timeout");
    const { signal, dispose } = requestAbortSignal(ctx); dispose();
    check("requestAbortSignal: pre-revoked parent -> aborted", signal.aborted && isLifecycleCancelledError(signal.reason));
  }

  console.log("── REAL discovery search path, cancel flips mid-loop (O1 realism) ──");
  {
    // Real production chain; only the network call (axios.post) is stubbed.
    // The loop mirrors pipeline.ts `for (const query of check.targetedQueries)
    // await runTargetedDisclosureQuery(query, companyName)`.
    const BATCH = 120, N = 8, CANCEL_AFTER = 3;
    const savedPost = axios.post; const savedSerper = process.env.SERPER_API_KEY; const savedSerp = process.env.SERP_API_KEY;
    process.env.SERPER_API_KEY = "unit-test-fake"; delete process.env.SERP_API_KEY; // Serper only: no fallback provider
    let dispatched = 0; let dispatchedPreCancel = 0; let dispatchedPostCancel = 0; let cancelFlipped = false;
    (axios as any).post = async (_url: string, body: any) => {
      dispatched++;
      if (cancelFlipped) dispatchedPostCancel++; else dispatchedPreCancel++;
      if (dispatched === CANCEL_AFTER) { cancelled.add(BATCH); cancelFlipped = true; } // admin cancel lands mid-loop
      return { data: { organic: [{ title: `Acmezzz result ${body?.q}`, link: `https://acmezzz.example/${dispatched}`, snippet: "" }] } };
    };
    const perQuery: number[] = [];
    try {
      await runWithDiagContext(ctxFor(BATCH), async () => {
        for (let i = 0; i < N; i++) {
          const before = dispatched;
          // distinct query text per iteration so the 24h search cache never short-circuits dispatch
          await runTargetedDisclosureQuery(`unit-loop-${Date.now()}-${i} acmezzz annual report`, "Acmezzz Holdings");
          perQuery.push(dispatched - before);
        }
        // A parallel wave after cancel (pipeline/discovery fan-out shape) must also dispatch nothing.
        await Promise.all(Array.from({ length: 5 }, (_, j) =>
          runTargetedDisclosureQuery(`unit-wave-${Date.now()}-${j} acmezzz`, "Acmezzz Holdings")));
      });
    } finally {
      (axios as any).post = savedPost;
      if (savedSerper === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = savedSerper;
      if (savedSerp !== undefined) process.env.SERP_API_KEY = savedSerp;
    }
    console.log(`    real-loop dispatch: pre-cancel=${dispatchedPreCancel} post-cancel=${dispatchedPostCancel} perQuery=${JSON.stringify(perQuery)}`);
    check(`real loop: pre-cancel dispatches recorded separately = ${CANCEL_AFTER}`, dispatchedPreCancel === CANCEL_AFTER);
    check("real loop: ZERO provider dispatches after the cancel source flipped (sequential + parallel wave)", dispatchedPostCancel === 0);
    check("real loop: every pre-cancel iteration dispatched exactly once", perQuery.slice(0, CANCEL_AFTER).every((n) => n === 1));
    check("real loop: every post-cancel iteration dispatched nothing", perQuery.slice(CANCEL_AFTER).every((n) => n === 0));
  }

  console.log("── fault-inject FAIL-CLOSED (companyId-only spec, no batch/job) ──");
  {
    const env = { DIAG_FAULT_INJECT: JSON.stringify([
      { mode: "pipeline_timeout", ms: 50, companyId: 7 },
      { mode: "discovery_timeout", ms: 60, companyId: 7 },
      { mode: "cancel_waiting_db", companyId: 7 },
      { mode: "cancel_external_inflight", companyId: 7 },
    ]) };
    const parsed = parseFaultConfig(env);
    check("fail-closed: companyId-only parse -> zero specs", parsed.specs.length === 0);
    check("fail-closed: companyId-only parse -> no target", parsed.target.batchId === null && parsed.target.jobId === null);
    // Also refuse non-numeric targets (not silently treated as wildcard).
    check("fail-closed: non-numeric DIAG_FAULT_BATCH -> inert", parseFaultConfig({ ...env, DIAG_FAULT_BATCH: "abc" }).specs.length === 0);
    __reloadFaultConfigForTests(env);
    check("fail-closed: isFaultInjectActive() false", isFaultInjectActive() === false);
    const ids = { batchId: 101, jobId: 1, companyId: 7 };
    check("fail-closed: getFaultSpec(pipeline_timeout) null even for matching company", getFaultSpec("pipeline_timeout", ids) === null);
    check("fail-closed: getFaultSpec(discovery_timeout) null", getFaultSpec("discovery_timeout", ids) === null);
    check("fail-closed: faultTimeoutMs returns the normal deadline", faultTimeoutMs("pipeline_timeout", 999_000, ids) === 999_000 && faultTimeoutMs("discovery_timeout", 555, ids) === 555);
    // maybeFireCancel must resolve without touching cancellation/storage. Run it
    // inside a real attempt context matching the company; the batch must stay uncancelled.
    let resolved = false;
    await runWithDiagContext(ctxFor(130), async () => {
      await maybeFireCancel("cancel_waiting_db", "unit", {}); await maybeFireCancel("cancel_external_inflight", "unit", {});
      resolved = true;
    });
    check("fail-closed: maybeFireCancel resolves and fires nothing (no cancel recorded)", resolved && !cancelled.has(130) && dispatchRevokedReason(ctxFor(130)) === null);
    __reloadFaultConfigForTests({});
  }

  console.log("── fault-inject re-keyed on batch/job ──");
  {
    const inert = parseFaultConfig({ DIAG_FAULT_INJECT: JSON.stringify({ mode: "pipeline_timeout", ms: 50 }) });
    check("no DIAG_FAULT_BATCH/JOB -> inert", inert.specs.length === 0);
    __reloadFaultConfigForTests({ DIAG_FAULT_INJECT: JSON.stringify([{ mode: "pipeline_timeout", ms: 50 }]), DIAG_FAULT_BATCH: "900" });
    check("targeted batch matches", getFaultSpec("pipeline_timeout", { batchId: 900, companyId: 1 })?.ms === 50);
    check("other batch, same company, does NOT match", getFaultSpec("pipeline_timeout", { batchId: 901, companyId: 1 }) === null);
    check("faultTimeoutMs untargeted -> normal", faultTimeoutMs("pipeline_timeout", 1234, { batchId: 1 }) === 1234);
    __reloadFaultConfigForTests({ DIAG_FAULT_INJECT: JSON.stringify({ mode: "discovery_timeout", ms: 70, companyId: 5 }), DIAG_FAULT_BATCH: "900", DIAG_FAULT_JOB: "33" });
    check("batch+job+company all match", getFaultSpec("discovery_timeout", { batchId: 900, jobId: 33, companyId: 5 })?.ms === 70);
    check("wrong job does not match", getFaultSpec("discovery_timeout", { batchId: 900, jobId: 34, companyId: 5 }) === null);
    check("companyId only an extra filter", getFaultSpec("discovery_timeout", { batchId: 900, jobId: 33, companyId: 6 }) === null);
    __reloadFaultConfigForTests({});
  }

  console.log("── ownership identity (attempt_token) + fail-closed batch writes (Items 1/4) ──");
  {
    const lc = createAttemptLifecycle({ jobId: 5, batchId: 9, attemptNumber: 1, deadlineAt: null, attemptToken: "11111111-1111-4111-8111-111111111111" });
    const own = ownershipFromContext({ batchId: 9, jobId: 5, lifecycle: lc })!;
    check("ownershipFromContext carries attemptToken", own.attemptToken === "11111111-1111-4111-8111-111111111111");
    const q = new PgDialect().sqlToQuery(ownerPredicate(own));
    check("ownerPredicate keys on attempt_token (IS NOT DISTINCT FROM, bound param)", /j\.attempt_token IS NOT DISTINCT FROM \$\d+::uuid/.test(q.sql) && q.params.includes(own.attemptToken));
    check("ownerPredicate still matches attempts + status='claimed'", /j\.attempts = \$\d+/.test(q.sql) && q.sql.includes("j.status = 'claimed'"));
    const qNull = new PgDialect().sqlToQuery(ownerPredicate({ jobId: 5, attemptNumber: 1 }));
    check("token-less ownership binds NULL (matches only legacy NULL-token rows)", qNull.params.includes(null));
    // Fail-closed: batch write with no attempt context must throw, never fall back.
    let err: unknown = null;
    try { requireOwnershipForBatchWrite(42, "pipeline.score-write", undefined); } catch (e) { err = e; }
    check("batch write without ownership context -> LifecycleCancelledError(ownership_context_missing)", isLifecycleCancelledError(err) && (err as any).reason === "ownership_context_missing");
    check("batch-less direct call (scripts) -> null, unfenced path allowed", requireOwnershipForBatchWrite(null, "x", undefined) === null);
    check("inside an attempt context -> returns that ownership", requireOwnershipForBatchWrite(9, "x", { batchId: 9, jobId: 5, lifecycle: lc })?.attemptToken === own.attemptToken);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

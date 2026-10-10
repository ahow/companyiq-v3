/**
 * Standalone unit tests for the lifecycle dispatch gates (no DB/Redis I/O).
 * Run: DATABASE_URL=<any pg url; not connected> npx tsx server/lib/lifecycle-fence.unit.test.ts
 *
 * Covers: discovery withBucket pre-acquire / post-acquire / in-flight gates,
 * attempt revoke + deadline, requestAbortSignal, fault-inject re-keying.
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
} from "./lifecycle-fence.js";
import { withBucket } from "./discovery.js";
import { parseFaultConfig, __reloadFaultConfigForTests, getFaultSpec, faultTimeoutMs } from "./fault-inject.js";

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

  console.log(`\n${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

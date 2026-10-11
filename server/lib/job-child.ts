/**
 * Worker isolation — job CHILD entry (forked by job-isolation.ts).
 * Runs exactly one runAnalysisPipeline under its own lifecycle (same ownership
 * token + deadline as the parent attempt), then reports result/error and exits.
 * Must not statically import pipeline/db/redis: they load only after `init`.
 */
import { createAttemptLifecycle, registerBatchCancelSource, revokeAttempt } from "./lifecycle-fence.js";
import { runWithDiagContext, getDiagContext } from "./diag-context.js";
import { runWithLlmContext } from "./llm-usage.js";
import { sendToParent, onDescendantGroup } from "./isolation-ipc.js";
import { Worker } from "node:worker_threads";

let cancelFlag = false;
let lc: ReturnType<typeof createAttemptLifecycle> | null = null;
let started = false;
registerBatchCancelSource(() => cancelFlag);

// ─── Parent-death watchdog ───────────────────────────────────────────────────
// process.on("exit") in the parent cannot run when the parent is SIGKILLed /
// OOM-killed. This thread has its own event loop, so it keeps running even
// while the pipeline blocks this process's main thread: when the original
// parent disappears (ppid changes on reparenting) it SIGKILLs our own process
// group (us + pdftotext etc.) and every registered detached group (Chromium).
const WATCHDOG_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const groups = new Set();
parentPort.on("message", (pid) => groups.add(pid));
setInterval(() => {
  if (process.ppid === workerData.ppid) return;
  for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch {} }
  try { process.kill(-workerData.self, "SIGKILL"); } catch {}
  try { process.kill(workerData.self, "SIGKILL"); } catch {}
}, workerData.pollMs);
`;
const watchdog = new Worker(WATCHDOG_SRC, { eval: true, workerData: { ppid: process.ppid, self: process.pid, pollMs: parseInt(process.env.WORKER_ISOLATION_PARENT_POLL_MS || "250", 10) } });
watchdog.unref();
const descendantGroups = new Set<number>();
onDescendantGroup((pid) => { descendantGroups.add(pid); watchdog.postMessage(pid); });

// IPC channel closed (parent exited or died) while our loop is free: same cleanup.
process.on("disconnect", () => {
  for (const g of descendantGroups) { try { process.kill(-g, "SIGKILL"); } catch { /* gone */ } }
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(0); }
});
process.on("message", (m: any) => {
  if (!m || typeof m !== "object") return;
  if (m.t === "revoke") revokeAttempt(lc, m.reason || "revoked");
  else if (m.t === "cancel") cancelFlag = true;
  else if (m.t === "init" && !started) { started = true; void run(m); }
});

function serializeError(e: any) {
  return { name: e?.name, message: String(e?.message ?? e), stack: e?.stack, code: e?.code, provider: e?.provider, failureClass: e?.failureClass, reason: e?.reason };
}

async function run(init: any): Promise<void> {
  const o = init.opts;
  if (init.cancelled) cancelFlag = true;
  const L = init.lifecycle;
  lc = L ? createAttemptLifecycle({ jobId: L.jobId, batchId: L.batchId, attemptNumber: L.attemptNumber, deadlineAt: L.deadlineAt ? new Date(L.deadlineAt) : null, attemptToken: L.attemptToken }) : null;
  if (L?.revokedReason) revokeAttempt(lc, L.revokedReason);
  const batchFetchState = o.batchFetchState ?? { hostSlowFetches: new Map(), hostCircuitBroken: new Set() };
  const cancelCheck = () => cancelFlag || !!lc?.revoked;
  const ctx: any = { batchId: o.batchId ?? null, jobId: L?.jobId ?? null, attemptId: init.attemptId, attemptNumber: L?.attemptNumber ?? null, companyId: init.companyId, frameworkId: init.frameworkId, stage: "pipeline", lifecycle: lc ?? undefined };
  const stageTimer = setInterval(() => sendToParent({ t: "stage", stage: ctx.stage }), 2000);
  try {
    const result = await runWithLlmContext({ workspaceId: o.workspaceId, batchId: o.batchId, companyId: init.companyId, frameworkId: init.frameworkId, callType: "scoring" },
      () => runWithDiagContext(ctx, async () => {
        const full = { ...o, cancelCheck, batchFetchState };
        const testModule = process.env.CIQ_CHILD_TEST_MODULE;
        if (testModule) {
          const mod = await import(testModule);
          return mod.run(full, { lifecycle: lc, getDiagContext, isCancelled: cancelCheck });
        }
        const { runAnalysisPipeline } = await import("./pipeline.js");
        return runAnalysisPipeline(full);
      }));
    sendToParent({ t: "stage", stage: ctx.stage });
    sendToParent({ t: "result", result, revokedReason: lc?.revoked ? lc.revokedReason : null, batchFetchState });
  } catch (e) {
    sendToParent({ t: "error", error: serializeError(e) });
  } finally {
    clearInterval(stageTimer);
  }
  // Let the IPC queue drain, then exit (pools/timers must not keep us alive).
  setTimeout(() => process.exit(0), 50);
}

sendToParent({ t: "ready" });

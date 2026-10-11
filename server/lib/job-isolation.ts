/**
 * Worker isolation — PARENT-side supervisor (docs/worker-isolation/DESIGN.md).
 *
 * runPipelineIsolated() runs one job's runAnalysisPipeline in a forked child
 * process so its synchronous CPU work can never block the BullMQ worker's event
 * loop (lock renewal, heartbeats, watchdog, ownership watch, PG/Redis I/O).
 * Same signature/result as runAnalysisPipeline; gated by
 * WORKER_ISOLATION_ENABLED=true (default off → worker.ts calls the pipeline
 * in-process exactly as at 35884ee).
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { PipelineOptions, PipelineResult, BatchFetchState } from "./pipeline.js";
import { getDiagContext, setDiagStage } from "./diag-context.js";
import { revokeAttempt, LifecycleCancelledError } from "./lifecycle-fence.js";
import { llmSlotBroker } from "./ai-providers.js";
import { processorSlotBroker } from "./processor.js";
import { ingestUsageRowFromChild } from "./llm-usage.js";
import { ingestSignalFromChild } from "./adaptive-concurrency.js";
import { ProviderScoringError } from "./credit-breaker.js";
import { PG_PARENT_RESERVE } from "../db.js";
import type { PermitKind } from "./isolation-ipc.js";

export function isolationEnabled(): boolean {
  return process.env.WORKER_ISOLATION_ENABLED === "true";
}

const CHILD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "job-child.ts");

/** Per-child DB budget: floor((PG_POOL_MAX − R) / WORKER_CONCURRENCY) (DESIGN §4). */
export function childPgBudget(env: NodeJS.ProcessEnv = process.env): number {
  const total = parseInt(env.PG_POOL_MAX || "20", 10);
  const reserve = Math.max(1, parseInt(env.WORKER_ISOLATION_PARENT_PG_RESERVE || String(PG_PARENT_RESERVE), 10));
  const conc = Math.max(1, parseInt(env.WORKER_CONCURRENCY || "10", 10));
  return Math.floor((total - reserve) / conc);
}

interface Grant { kind: PermitKind; granted: boolean; cancelled: boolean; ac?: AbortController }
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
}

function mergeBatchFetchState(into: BatchFetchState | undefined, from: BatchFetchState | undefined): void {
  if (!into || !from) return;
  for (const h of from.hostCircuitBroken ?? []) into.hostCircuitBroken.add(h);
  for (const [h, n] of from.hostSlowFetches ?? []) into.hostSlowFetches.set(h, Math.max(n, into.hostSlowFetches.get(h) ?? 0));
}

function rebuildError(e: any): Error {
  let err: Error;
  if (e?.name === "ProviderScoringError") err = new ProviderScoringError(e.provider, e.failureClass, e.message);
  else if (e?.name === "LifecycleCancelledError") { err = new LifecycleCancelledError(e.reason || "revoked"); err.message = e.message; }
  else { err = new Error(e?.message || "Isolated job child error"); if (e?.name) err.name = e.name; }
  if (e?.stack) err.stack = e.stack;
  if (e?.code !== undefined) (err as any).code = e.code;
  return err;
}

export function runPipelineIsolated(opts: PipelineOptions): Promise<PipelineResult> {
  const ctx = getDiagContext();
  const lc = ctx?.lifecycle;
  const budget = childPgBudget();
  if (budget < 1) {
    return Promise.reject(new Error(`Worker isolation refused: per-child PG budget ${budget} < 1 (PG_POOL_MAX − WORKER_ISOLATION_PARENT_PG_RESERVE) / WORKER_CONCURRENCY`));
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => { for (const c of live) killGroup(c, "SIGKILL"); });
  }
  const graceMs = parseInt(process.env.WORKER_ISOLATION_KILL_GRACE_MS || "10000", 10);
  const testModule = process.env.CIQ_CHILD_TEST_MODULE;

  return new Promise<PipelineResult>((resolve, reject) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, CIQ_ISOLATED_CHILD: "1", CIQ_PROCESS_ROLE: "job-child", PG_POOL_MAX: String(budget), ...(testModule ? { CIQ_CHILD_TEST_MODULE: testModule } : {}) },
    });
    live.add(child);
    const grants = new Map<number, Grant>();
    let settled = false;
    let lastStage = "spawn";
    let killReason: string | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const send = (m: unknown) => { try { if (child.connected) child.send(m as any); } catch { /* closing */ } };

    const armKill = (why: string) => {
      if (killReason) return;
      killReason = why;
      timers.push(setTimeout(() => {
        console.warn(`[WORKER-ISOLATION] child pid=${child.pid} still alive ${graceMs}ms after ${why} → SIGTERM group`);
        killGroup(child, "SIGTERM");
        timers.push(setTimeout(() => killGroup(child, "SIGKILL"), 5000));
      }, graceMs));
    };

    // Parent lifecycle revoke (watchdog / ownership lost) → child revoke + escalation.
    const onRevoke = () => { send({ t: "revoke", reason: lc?.revokedReason || "revoked" }); armKill(`revoke:${lc?.revokedReason}`); };
    if (lc) { if (lc.abort.signal.aborted) onRevoke(); else lc.abort.signal.addEventListener("abort", onRevoke, { once: true }); }
    if (lc?.deadlineAt) {
      const ms = Math.max(0, lc.deadlineAt.getTime() - Date.now());
      timers.push(setTimeout(() => armKill("deadline"), ms));
    }
    let cancelSent = false;
    const cancelPoll = setInterval(() => {
      if (!cancelSent && opts.cancelCheck?.()) { cancelSent = true; send({ t: "cancel" }); armKill("cancel"); }
    }, 500);

    const releaseAll = () => {
      for (const [id, g] of grants) {
        if (g.granted) {
          if (g.kind === "llm") llmSlotBroker.release(); else processorSlotBroker[g.kind].release();
        } else { g.cancelled = true; g.ac?.abort(); }
        grants.delete(id);
      }
    };
    const cleanup = () => {
      clearInterval(cancelPoll);
      for (const t of timers) clearTimeout(t);
      lc?.abort.signal.removeEventListener("abort", onRevoke);
    };
    const finish = (fn: () => void) => { if (settled) return; settled = true; fn(); };

    child.on("message", (m: any) => {
      if (!m || typeof m !== "object") return;
      switch (m.t) {
        case "ready":
          send({ t: "init", opts: { ...opts, cancelCheck: undefined }, lifecycle: lc ? { jobId: lc.jobId, batchId: lc.batchId, attemptNumber: lc.attemptNumber, deadlineAt: lc.deadlineAt, attemptToken: lc.attemptToken ?? null, revokedReason: lc.revoked ? lc.revokedReason : null } : null,
            attemptId: ctx?.attemptId ?? opts.attemptId ?? null, companyId: ctx?.companyId ?? (opts.company as any)?.id ?? null, frameworkId: ctx?.frameworkId ?? (opts.framework as any)?.id ?? null, cancelled: cancelSent });
          break;
        case "acquire": {
          const kind = m.kind as PermitKind;
          const g: Grant = { kind, granted: false, cancelled: false };
          grants.set(m.id, g);
          let p: Promise<void>;
          if (kind === "llm") { g.ac = new AbortController(); p = llmSlotBroker.acquire(g.ac.signal); } else p = processorSlotBroker[kind].acquire();
          p.then(() => {
            if (g.cancelled || !grants.has(m.id) || settled && !child.connected) {
              if (kind === "llm") llmSlotBroker.release(); else processorSlotBroker[kind].release();
              grants.delete(m.id);
              return;
            }
            g.granted = true;
            send({ t: "granted", id: m.id });
          }, () => { grants.delete(m.id); });
          break;
        }
        case "cancelAcquire": { const g = grants.get(m.id); if (g && !g.granted) { g.cancelled = true; g.ac?.abort(); grants.delete(m.id); } break; }
        case "release": {
          const g = grants.get(m.id);
          if (g?.granted) { if (g.kind === "llm") llmSlotBroker.release(); else processorSlotBroker[g.kind].release(); grants.delete(m.id); }
          break;
        }
        case "usage": ingestUsageRowFromChild(m.row); break;
        case "signal": ingestSignalFromChild(m.kind); break;
        case "stage": if (typeof m.stage === "string") { lastStage = m.stage; setDiagStage(m.stage); } break;
        case "result":
          mergeBatchFetchState(opts.batchFetchState, m.batchFetchState);
          if (m.revokedReason && lc) revokeAttempt(lc, m.revokedReason);
          finish(() => resolve(m.result as PipelineResult));
          break;
        case "error":
          finish(() => reject(rebuildError(m.error)));
          break;
      }
    });

    child.on("exit", (code, signal) => {
      live.delete(child);
      releaseAll();
      cleanup();
      // Reap any descendants (Chromium / pdftotext) left in the child's group.
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } }
      finish(() => {
        const base = `Isolated job child exited unexpectedly (code=${code} signal=${signal} stage=${lastStage})`;
        reject(new Error(killReason ? `Job watchdog timeout: ${base} after ${killReason}` : base));
      });
    });
    child.on("error", (e) => { console.warn(`[WORKER-ISOLATION] child error: ${e?.message || e}`); });
  });
}

export const __testing = {
  liveChildren: () => live.size,
  brokerState: () => ({ llm: llmSlotBroker.state(), browser: processorSlotBroker.browser.state(), proc: processorSlotBroker.proc.state() }),
};

/**
 * Worker isolation — PARENT-side supervisor (docs/worker-isolation/DESIGN.md).
 *
 * runPipelineIsolated() runs one job's runAnalysisPipeline in a forked child
 * process so its synchronous CPU work can never block the BullMQ worker's event
 * loop (lock renewal, heartbeats, watchdog, ownership watch, PG/Redis I/O).
 * Same signature/result as runAnalysisPipeline; gated by
 * WORKER_ISOLATION_ENABLED=true (default off → worker.ts calls the pipeline
 * in-process exactly as at 35884ee).
 *
 * The parent enforces BOTH existing deadlines on its own clock, independent of
 * the (possibly synchronously blocked) child:
 *   - pipeline deadline: PIPELINE_TIMEOUT_MS from spawn (≤ the child's own
 *     in-pipeline timer, which starts later), and
 *   - job deadline: lifecycle.deadlineAt (claim + JOB_TIMEOUT_MS).
 * At the earlier one the attempt is revoked and the child's process group plus
 * every registered descendant group (Chromium) is SIGKILLed immediately — no
 * cleanup grace extends dispatch/persist permission past a deadline.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
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

/** Same env + default as pipeline.ts PIPELINE_TIMEOUT_MS. */
export function pipelineTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseInt(env.PIPELINE_TIMEOUT_MS || "540000", 10);
}

/** Why the parent terminated the child (null = it was never asked to stop). */
export type KillReason = "pipeline_deadline" | "job_deadline" | "cancel" | `revoke:${string}`;

export type IsolatedOutcome = { resolve: PipelineResult } | { reject: Error };

/**
 * Single classification point for how an isolated attempt ends. Each row maps
 * to the result the IN-PROCESS pipeline/worker produces for the same event, so
 * worker.ts's existing retry policy (retry-policy.ts) applies unchanged:
 *  - child reported result/error first   → exactly that (it finished before any kill)
 *  - pipeline deadline                   → {error:"Pipeline timed out after Ns", failureType:"timeout"} (pipeline.ts)
 *  - job deadline                        → Error("Job watchdog timeout: …") → non-retriable
 *  - killed after cancel / revoke        → {error:"Cancelled"}; worker.ts fenceCancelledResult keeps a
 *                                          cancelled batch a cancellation, else non-retriable watchdog
 *  - died with no kill requested         → Error("Isolated job child exited unexpectedly …") → retriable
 */
export function classifyIsolatedOutcome(o: {
  reported: IsolatedOutcome | null; killReason: KillReason | null;
  code: number | null; signal: NodeJS.Signals | null; lastStage: string; pipelineElapsedMs: number;
}): IsolatedOutcome {
  if (o.reported) return o.reported;
  const exit = `code=${o.code} signal=${o.signal} stage=${o.lastStage}`;
  const base = { documentsProcessed: 0, documentsFresh: 0, documentsCached: 0 };
  switch (o.killReason) {
    case "pipeline_deadline":
      return { resolve: { success: false, error: `Pipeline timed out after ${Math.round(o.pipelineElapsedMs / 1000)}s`, ...base, failureType: "timeout" } as PipelineResult };
    case "job_deadline":
      return { reject: new Error(`Job watchdog timeout: isolated child killed at job deadline (${exit})`) };
    case null:
      return { reject: new Error(`Isolated job child exited unexpectedly (${exit})`) };
    default: // "cancel" | "revoke:*"
      return { resolve: { success: false, error: "Cancelled", ...base, failureType: "cancelled" } as PipelineResult };
  }
}

interface Grant { kind: PermitKind; granted: boolean; cancelled: boolean; ac?: AbortController }
const live = new Map<ChildProcess, Set<number>>(); // child → its process group + registered descendant groups
let exitHookInstalled = false;
const stats = { forks: 0, maxForkMs: 0, messages: 0, maxHandlerMs: 0 };

function signalGroups(groups: Iterable<number>, sig: NodeJS.Signals): void {
  for (const g of groups) { try { process.kill(-g, sig); } catch { /* group gone */ } }
}
function groupsAlive(groups: Iterable<number>): boolean {
  for (const g of groups) { try { process.kill(-g, 0); return true; } catch { /* gone */ } }
  return false;
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

/** In-process parity for a pipeline timeout (pipeline.ts): mark company failed + log. Best effort, never awaited. */
function recordPipelineTimeout(opts: PipelineOptions, elapsedMs: number, limitMs: number): void {
  const company: any = opts.company;
  void (async () => {
    const storage: any = await import("../storage.js");
    const elapsed = Math.round(elapsedMs / 1000);
    await storage.updateCompany(company.id, opts.workspaceId, { analysisStatus: "failed" });
    await storage.logProcessingError({ companyId: company.id, companyName: company.name, stage: "pipeline_timeout",
      error: JSON.stringify({ type: "timeout", elapsedSeconds: elapsed, limitSeconds: Math.round(limitMs / 1000), message: `Pipeline timed out after ${elapsed}s (limit: ${limitMs / 1000}s) [isolated child killed by parent]` }) });
  })().catch((e) => console.warn(`[WORKER-ISOLATION] pipeline-timeout bookkeeping failed: ${e?.message || e}`));
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
    // Graceful parent exit only. Abrupt parent death (SIGKILL/OOM) is handled
    // child-side by job-child.ts's parent-death watchdog thread.
    process.on("exit", () => { for (const groups of live.values()) signalGroups(groups, "SIGKILL"); });
  }
  const graceMs = parseInt(process.env.WORKER_ISOLATION_KILL_GRACE_MS || "10000", 10);
  const exitGraceMs = parseInt(process.env.WORKER_ISOLATION_EXIT_GRACE_MS || "2000", 10);
  const nice = parseInt(process.env.WORKER_ISOLATION_CHILD_NICE || "10", 10);
  const pipelineMs = pipelineTimeoutMs();
  const testModule = process.env.CIQ_CHILD_TEST_MODULE;

  return new Promise<PipelineResult>((resolve, reject) => {
    const pipelineStart = Date.now();
    const tFork = performance.now();
    const child = fork(CHILD_PATH, [], {
      execArgv: ["--import", "tsx"],
      serialization: "advanced",
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, CIQ_ISOLATED_CHILD: "1", CIQ_PROCESS_ROLE: "job-child", PG_POOL_MAX: String(budget), ...(testModule ? { CIQ_CHILD_TEST_MODULE: testModule } : {}) },
    });
    stats.forks++; stats.maxForkMs = Math.max(stats.maxForkMs, performance.now() - tFork);
    // CPU contention: children run at lower priority (inherited by Chromium /
    // pdftotext) so the supervisor wins the CPU for lock renewal / heartbeats.
    if (child.pid && nice > 0) { try { os.setPriority(child.pid, nice); } catch { /* not permitted */ } }
    const groups = new Set<number>(child.pid ? [child.pid] : []);
    live.set(child, groups);
    const grants = new Map<number, Grant>();
    let settled = false;
    let exited = false;
    let lastStage = "spawn";
    let killReason: KillReason | null = null;
    let reported: IsolatedOutcome | null = null;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const send = (m: unknown) => { try { if (child.connected) child.send(m as any); } catch { /* closing */ } };
    const killNow = () => signalGroups(groups, "SIGKILL");

    // Cooperative stop (cancel / revoke): child gets graceMs to return, then
    // SIGTERM → +5 s SIGKILL to every group.
    const armKill = (why: KillReason) => {
      if (killReason || reported) return;
      killReason = why;
      timers.push(setTimeout(() => {
        console.warn(`[WORKER-ISOLATION] child pid=${child.pid} still alive ${graceMs}ms after ${why} → SIGTERM groups`);
        signalGroups(groups, "SIGTERM");
        timers.push(setTimeout(killNow, 5000));
      }, graceMs));
    };
    // Hard deadline: revoke + immediate SIGKILL. A cancellation already in
    // progress stays classified as cancellation (only the kill is hastened).
    const onDeadline = (which: "pipeline_deadline" | "job_deadline") => {
      if (exited) return;
      // Already reported but still inside the exit grace: the grace never
      // outlives a deadline — kill now; the reported outcome still wins.
      if (reported) { killNow(); return; }
      if (killReason !== "cancel" && killReason !== "pipeline_deadline" && killReason !== "job_deadline") killReason = which;
      console.warn(`[WORKER-ISOLATION] ${which} reached for child pid=${child.pid} (stage=${lastStage}) → revoke + SIGKILL groups`);
      if (lc) revokeAttempt(lc, which === "pipeline_deadline" ? "pipeline_timeout" : "job_watchdog_timeout");
      killNow();
    };

    const onRevoke = () => { send({ t: "revoke", reason: lc?.revokedReason || "revoked" }); armKill(`revoke:${lc?.revokedReason}`); };
    if (lc) { if (lc.abort.signal.aborted) onRevoke(); else lc.abort.signal.addEventListener("abort", onRevoke, { once: true }); }
    timers.push(setTimeout(() => onDeadline("pipeline_deadline"), pipelineMs));
    if (lc?.deadlineAt) timers.push(setTimeout(() => onDeadline("job_deadline"), Math.max(0, lc.deadlineAt.getTime() - Date.now())));
    let cancelSent = false;
    const cancelPoll = setInterval(() => {
      if (!cancelSent && opts.cancelCheck?.()) { cancelSent = true; send({ t: "cancel" }); armKill("cancel"); }
    }, 500);

    const releaseGrant = (g: Grant) => { if (g.kind === "llm") llmSlotBroker.release(); else processorSlotBroker[g.kind].release(); };
    const releaseAll = () => {
      for (const [id, g] of grants) {
        if (g.granted) releaseGrant(g); else { g.cancelled = true; g.ac?.abort(); }
        grants.delete(id);
      }
    };
    const cleanup = () => {
      clearInterval(cancelPoll);
      for (const t of timers) clearTimeout(t);
      lc?.abort.signal.removeEventListener("abort", onRevoke);
    };
    // The outcome is delivered only after the child has EXITED, its groups are
    // gone and its permits are back: a child can never report success while
    // its own processing (or a descendant) still runs or holds capacity.
    const onReported = (o: IsolatedOutcome) => {
      if (reported) return;
      reported = o;
      timers.push(setTimeout(() => { console.warn(`[WORKER-ISOLATION] child pid=${child.pid} reported but did not exit in ${exitGraceMs}ms → SIGKILL groups`); killNow(); }, exitGraceMs));
    };

    child.on("message", (m: any) => {
      const t0 = performance.now();
      stats.messages++;
      try { handle(m); } finally { stats.maxHandlerMs = Math.max(stats.maxHandlerMs, performance.now() - t0); }
    });
    function handle(m: any): void {
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
            // Granted after the request was withdrawn / the child exited: hand it straight back.
            if (g.cancelled || !grants.has(m.id) || exited) { releaseGrant(g); grants.delete(m.id); return; }
            g.granted = true;
            send({ t: "granted", id: m.id });
          }, () => { grants.delete(m.id); });
          break;
        }
        case "cancelAcquire": {
          const g = grants.get(m.id);
          if (g && !g.granted) { g.cancelled = true; g.ac?.abort(); grants.delete(m.id); }
          break;
        }
        case "release": {
          const g = grants.get(m.id);
          if (g?.granted) { releaseGrant(g); grants.delete(m.id); }
          break;
        }
        case "pgroup": if (Number.isInteger(m.pid) && m.pid > 1) groups.add(m.pid); break;
        case "usage": ingestUsageRowFromChild(m.row); break;
        case "signal": ingestSignalFromChild(m.kind); break;
        case "stage": if (typeof m.stage === "string") { lastStage = m.stage; setDiagStage(m.stage); } break;
        case "result":
          mergeBatchFetchState(opts.batchFetchState, m.batchFetchState);
          if (m.revokedReason && lc) revokeAttempt(lc, m.revokedReason);
          onReported({ resolve: m.result as PipelineResult });
          break;
        case "error":
          onReported({ reject: rebuildError(m.error) });
          break;
      }
    }

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      const pipelineElapsedMs = Date.now() - pipelineStart;
      const out = classifyIsolatedOutcome({ reported, killReason, code, signal, lastStage, pipelineElapsedMs });
      if (!reported && killReason === "pipeline_deadline") recordPipelineTimeout(opts, pipelineElapsedMs, pipelineMs);
      if ("resolve" in out) resolve(out.resolve); else reject(out.reject);
    };

    child.on("exit", (code, signal) => {
      exited = true;
      cleanup();
      // Reap stragglers in the child's group and every registered descendant
      // group (Chromium), wait (bounded) until they are gone, THEN return the
      // child's permits — capacity is never re-granted while old processes run.
      killNow();
      const until = Date.now() + 2000;
      const finish = () => {
        if (groupsAlive(groups) && Date.now() < until) { timers.push(setTimeout(finish, 20)); return; }
        live.delete(child);
        releaseAll();
        settle(code, signal);
      };
      finish();
    });
    child.on("error", (e) => {
      console.warn(`[WORKER-ISOLATION] child error: ${e?.message || e}`);
      if (!child.pid) { live.delete(child); cleanup(); releaseAll(); if (!settled) { settled = true; reject(e); } }
    });
  });
}

export const __testing = {
  liveChildren: () => live.size,
  brokerState: () => ({ llm: llmSlotBroker.state(), browser: processorSlotBroker.browser.state(), proc: processorSlotBroker.proc.state() }),
  stats: () => ({ ...stats }),
  resetStats: () => { stats.forks = 0; stats.maxForkMs = 0; stats.messages = 0; stats.maxHandlerMs = 0; },
};

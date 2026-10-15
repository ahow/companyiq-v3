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
import { readdir, readFile } from "node:fs/promises";
import type { PipelineOptions, PipelineResult, BatchFetchState } from "./pipeline.js";
import { getDiagContext, setDiagStage } from "./diag-context.js";
import { revokeAttempt, LifecycleCancelledError } from "./lifecycle-fence.js";
import { llmSlotBroker } from "./ai-providers.js";
import { processorSlotBroker } from "./processor.js";
import { ingestUsageRowFromChild } from "./llm-usage.js";
import { ingestPaidCallRowFromChild } from "./paid-call-attribution.js";
import { ingestStageProfileRowFromChild } from "./stage-profile-sink.js";
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
 *  - report ACCEPTED before any terminal decision (deadline / cancel / revoke)
 *                                        → exactly that. A report arriving AFTER a terminal decision is
 *                                          never accepted (logged + kept as diagnostics only), so `reported`
 *                                          here is always a pre-decision report: the decision is monotonic.
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
const stats = { forks: 0, maxForkMs: 0, messages: 0, maxHandlerMs: 0, lateReportsDiscarded: 0, quarantined: 0 };
const lateReports: Array<{ childPid: number | undefined; killReason: KillReason; kind: "result" | "error"; summary: string; at: number }> = [];

function signalGroups(groups: Iterable<number>, sig: NodeJS.Signals): void {
  for (const g of groups) { try { process.kill(-g, sig); } catch { /* group gone */ } }
}

/**
 * Liveness of a set of process groups. `live` = member processes that are NOT
 * zombies (they can still run, hold memory, file handles, sockets); `zombies`
 * = exited-but-unreaped members (hold no resources besides a pid slot — they do
 * NOT count as running). kill(-g, 0) alone cannot tell the two apart, so it is
 * only the cheap fast path: when it reports every group gone, nothing is left;
 * otherwise /proc/<pid>/stat (state, pgrp) decides. Without a readable /proc
 * the result is `reliable: false` and every kill-visible group counts as live
 * (conservative: capacity is withheld rather than wrongly released).
 */
export interface GroupProbe { live: number[]; zombies: number[]; reliable: boolean }
export type LivenessProbe = (groups: number[]) => Promise<GroupProbe>;
export const probeGroups: LivenessProbe = async (groups) => {
  const visible = groups.filter((g) => { try { process.kill(-g, 0); return true; } catch { return false; } });
  if (visible.length === 0) return { live: [], zombies: [], reliable: true };
  const want = new Set(visible);
  let entries: string[];
  try { entries = await readdir("/proc"); } catch { return { live: visible.map((g) => -g), zombies: [], reliable: false }; }
  const live: number[] = [], zombies: number[] = [];
  await Promise.all(entries.filter((e) => /^\d+$/.test(e)).map(async (e) => {
    let st: string;
    try { st = await readFile(`/proc/${e}/stat`, "utf8"); } catch { return; } // exited meanwhile
    const f = st.slice(st.lastIndexOf(")") + 2).split(" "); // [state, ppid, pgrp, ...]
    if (!want.has(Number(f[2]))) return;
    (f[0] === "Z" ? zombies : live).push(Number(e));
  }));
  return { live, zombies, reliable: true };
};
let livenessProbe: LivenessProbe = probeGroups;
const testHooks = { suppressDeadlineKill: false };

/**
 * Quarantine (cleanup unconfirmed). A child whose process groups still contain
 * a live (non-zombie) process after the bounded reap window keeps its granted
 * permits OUT of the replica pool: capacity is never re-granted while an old
 * Chromium / pdftotext may still be running. Released only when a later probe
 * confirms the groups are gone (background monitor) or an operator calls
 * recoverQuarantinedChildren() deliberately.
 */
export interface QuarantineEntry {
  childPid: number; jobId: number | null; batchId: number | null; groups: number[]; reason: string; since: number;
  livePids: number[]; zombiePids: number[]; probeReliable: boolean; withheld: Record<PermitKind, number>;
}
const quarantine = new Map<number, { entry: QuarantineEntry; release: () => void }>();
let quarantineTimer: ReturnType<typeof setInterval> | null = null;
let quarantineTickRunning = false;

function releaseQuarantined(pid: number, how: string): void {
  const q = quarantine.get(pid);
  if (!q) return;
  quarantine.delete(pid);
  q.release();
  console.warn(`[WORKER-ISOLATION] quarantine cleared for child pid=${pid} (${how}); permits returned ${JSON.stringify(q.entry.withheld)}`);
  if (quarantine.size === 0 && quarantineTimer) { clearInterval(quarantineTimer); quarantineTimer = null; }
}
function ensureQuarantineMonitor(): void {
  if (quarantineTimer) return;
  const pollMs = parseInt(process.env.WORKER_ISOLATION_QUARANTINE_POLL_MS || "5000", 10);
  quarantineTimer = setInterval(() => {
    if (quarantineTickRunning) return;
    quarantineTickRunning = true;
    void (async () => {
      for (const [pid, q] of [...quarantine]) {
        signalGroups(q.entry.groups, "SIGKILL");
        let r: GroupProbe;
        try { r = await livenessProbe(q.entry.groups); } catch { continue; }
        q.entry.livePids = r.live; q.entry.zombiePids = r.zombies; q.entry.probeReliable = r.reliable;
        if (r.live.length === 0) releaseQuarantined(pid, "termination confirmed");
      }
    })().finally(() => { quarantineTickRunning = false; });
  }, pollMs);
  quarantineTimer.unref();
}

/** Current quarantine (diagnostics / ops). */
export function quarantinedChildren(): QuarantineEntry[] {
  return [...quarantine.values()].map((q) => ({ ...q.entry, groups: [...q.entry.groups], livePids: [...q.entry.livePids], zombiePids: [...q.entry.zombiePids], withheld: { ...q.entry.withheld } }));
}
/** Deliberate operator recovery: SIGKILL the groups once more and return the withheld permits regardless of the probe. */
export function recoverQuarantinedChildren(childPid?: number): number {
  let n = 0;
  for (const pid of [...quarantine.keys()]) {
    if (childPid !== undefined && pid !== childPid) continue;
    signalGroups(quarantine.get(pid)!.entry.groups, "SIGKILL");
    releaseQuarantined(pid, "deliberate recovery");
    n++;
  }
  return n;
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
    process.on("exit", () => {
      for (const groups of live.values()) signalGroups(groups, "SIGKILL");
      for (const q of quarantine.values()) signalGroups(q.entry.groups, "SIGKILL");
    });
  }
  const graceMs = parseInt(process.env.WORKER_ISOLATION_KILL_GRACE_MS || "10000", 10);
  const exitGraceMs = parseInt(process.env.WORKER_ISOLATION_EXIT_GRACE_MS || "2000", 10);
  const reapWindowMs = parseInt(process.env.WORKER_ISOLATION_REAP_WINDOW_MS || "2000", 10);
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
    // batch-1277: outstanding browser/lease operations reported by the child, so
    // a deadline/kill can be explained after the fact (which op held / was
    // queued for the permit, its origin, URL count, and queued/granted times).
    // Keyed by op id; entries are removed on released/settled.
    const outstandingLeases = new Map<string, import("./isolation-ipc.js").LeaseEvent>();
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
      // Monotonic: the FIRST terminal decision (cancel / revoke / deadline) is final;
      // a later deadline only hastens the kill.
      if (!killReason) killReason = which;
      const leaseSummary = outstandingLeases.size === 0 ? "none" : Array.from(outstandingLeases.values())
        .map((e) => `${e.op}[${e.ev} ${e.kind ?? "?"} ${e.origin ?? "-"} urls=${e.urls ?? 0} job=${e.job ?? "-"}/att=${e.attempt ?? "-"} at=${e.at}]`).join(", ");
      console.warn(`[WORKER-ISOLATION] ${which} reached for child pid=${child.pid} (stage=${lastStage}, outstandingLeases=${leaseSummary}) → revoke + SIGKILL groups`);
      if (lc) revokeAttempt(lc, which === "pipeline_deadline" ? "pipeline_timeout" : "job_watchdog_timeout");
      if (!testHooks.suppressDeadlineKill) killNow(); // test-only: lets an ordering test deliver a report AFTER the decision
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
    // Cleanup unconfirmed: withdraw queued requests but KEEP granted permits out of
    // the pool; returns the release function handed to the quarantine entry.
    const withholdAll = (): { withheld: Record<PermitKind, number>; release: () => void } => {
      const held: Grant[] = [];
      const withheld: Record<PermitKind, number> = { llm: 0, browser: 0, proc: 0 };
      for (const [id, g] of grants) {
        if (g.granted) { held.push(g); withheld[g.kind]++; } else { g.cancelled = true; g.ac?.abort(); }
        grants.delete(id);
      }
      let done = false;
      return { withheld, release: () => { if (done) return; done = true; for (const g of held) releaseGrant(g); } };
    };
    const cleanup = () => {
      clearInterval(cancelPoll);
      for (const t of timers) clearTimeout(t);
      lc?.abort.signal.removeEventListener("abort", onRevoke);
    };
    // The outcome is delivered only after the child has EXITED, its groups are
    // gone and its permits are back: a child can never report success while
    // its own processing (or a descendant) still runs or holds capacity.
    //
    // Monotonic terminal decision: a report is ACCEPTED only if no terminal
    // decision (deadline / cancel / revoke) was taken before it reached this
    // loop. A late report is logged and kept as diagnostics only — it can never
    // turn a timeout / cancellation into a success (or vice versa).
    const onReported = (o: IsolatedOutcome) => {
      if (reported) return;
      if (killReason) {
        stats.lateReportsDiscarded++;
        const summary = "resolve" in o ? `success=${o.resolve?.success} error=${o.resolve?.error ?? "-"}` : `error=${o.reject.message}`;
        lateReports.push({ childPid: child.pid, killReason, kind: "resolve" in o ? "result" : "error", summary, at: Date.now() });
        if (lateReports.length > 50) lateReports.shift();
        console.warn(`[WORKER-ISOLATION] child pid=${child.pid} reported AFTER terminal decision ${killReason} → discarded (diagnostic only: ${summary})`);
        return;
      }
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
        case "paid": ingestPaidCallRowFromChild(m.row); break;
        case "stageprofile": ingestStageProfileRowFromChild(m.row); break;
        case "signal": ingestSignalFromChild(m.kind); break;
        case "stage": if (typeof m.stage === "string") { lastStage = m.stage; setDiagStage(m.stage); } break;
        case "lease": {
          // batch-1277: track the set of browser operations the child has queued
          // for / is holding, so a later deadline/kill can be explained. acquire
          // and granted (re)record the op; released and settled remove it.
          if (typeof m.op !== "string") break;
          const e = m as import("./isolation-ipc.js").LeaseEvent;
          if (e.ev === "acquire" || e.ev === "granted") outstandingLeases.set(e.op, e);
          else outstandingLeases.delete(e.op);
          break;
        }
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

    const settle = (code: number | null, signal: NodeJS.Signals | null, cleanupFailure: string | null = null) => {
      if (settled) return;
      settled = true;
      const pipelineElapsedMs = Date.now() - pipelineStart;
      let out = classifyIsolatedOutcome({ reported, killReason, code, signal, lastStage, pipelineElapsedMs });
      if (!reported && killReason === "pipeline_deadline") recordPipelineTimeout(opts, pipelineElapsedMs, pipelineMs);
      // Cleanup unconfirmed never yields a clean success. A non-success terminal
      // outcome (timeout / cancellation / error) is kept as decided.
      if (cleanupFailure && "resolve" in out && out.resolve.success) out = { reject: new Error(cleanupFailure) };
      if ("resolve" in out) resolve(out.resolve); else reject(out.reject);
    };

    child.on("exit", (code, signal) => {
      exited = true;
      cleanup();
      // Reap stragglers in the child's group and every registered descendant
      // group (Chromium), wait (bounded) until no LIVE (non-zombie) member is
      // left, THEN return the child's permits — capacity is never re-granted
      // while old processes run. If termination cannot be confirmed in the
      // window the child is quarantined: permits withheld, outcome not success.
      killNow();
      const until = Date.now() + reapWindowMs;
      void (async () => {
        let r: GroupProbe = { live: [], zombies: [], reliable: true };
        for (;;) {
          try { r = await livenessProbe([...groups]); } catch (e: any) { r = { live: [-1], zombies: [], reliable: false }; }
          if (r.live.length === 0 || Date.now() >= until) break;
          killNow();
          await new Promise((res) => setTimeout(res, 20));
        }
        live.delete(child);
        if (r.live.length === 0) { releaseAll(); settle(code, signal); return; }
        const { withheld, release } = withholdAll();
        const pid = child.pid ?? -1;
        const reason = `cleanup unconfirmed after ${reapWindowMs}ms: live=[${r.live.join(",")}] zombies=[${r.zombies.join(",")}] probeReliable=${r.reliable}`;
        quarantine.set(pid, { entry: { childPid: pid, jobId: lc?.jobId ?? null, batchId: lc?.batchId ?? null, groups: [...groups], reason, since: Date.now(),
          livePids: r.live, zombiePids: r.zombies, probeReliable: r.reliable, withheld }, release });
        stats.quarantined++;
        ensureQuarantineMonitor();
        console.error(`[WORKER-ISOLATION] QUARANTINE child pid=${pid} job=${lc?.jobId ?? "-"} groups=[${[...groups].join(",")}] ${reason}; permits withheld ${JSON.stringify(withheld)}`);
        settle(code, signal, `Isolated job child cleanup unconfirmed: child pid=${pid} quarantined, ${reason}, permits withheld browser=${withheld.browser} proc=${withheld.proc} llm=${withheld.llm}`);
      })();
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
  resetStats: () => { Object.assign(stats, { forks: 0, maxForkMs: 0, messages: 0, maxHandlerMs: 0, lateReportsDiscarded: 0, quarantined: 0 }); lateReports.length = 0; },
  lateReports: () => lateReports.map((r) => ({ ...r })),
  setLivenessProbe: (p: LivenessProbe | null) => { livenessProbe = p ?? probeGroups; },
  setSuppressDeadlineKill: (v: boolean) => { testHooks.suppressDeadlineKill = v; },
};

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
import { resolvePipelineTimeBudgetPolicy, resolveEffectiveBudget } from "./pipeline-time-budget.js";

export function isolationEnabled(): boolean {
  return process.env.WORKER_ISOLATION_ENABLED === "true";
}

// The isolated child is resolved next to THIS module. When the worker runs from
// precompiled JS (dist/), this module is job-isolation.js and the child is
// job-child.js; when it runs under tsx (dev/tests), both are .ts. Keying the
// child extension off our own extension means the compiled worker forks a plain
// `node job-child.js` (no runtime TypeScript compile — the fix for the
// batch-start fork storm that wedged children at the "spawn" stage), while the
// dev/test path is byte-identical to before.
const SELF_EXT = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
const CHILD_IS_COMPILED = SELF_EXT === ".js";
const CHILD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), `job-child${SELF_EXT}`);
// Only load tsx into the child when the child itself is TypeScript. A compiled
// child must NOT pay the tsx import/compile cost (that is the whole point).
const CHILD_EXEC_ARGV = CHILD_IS_COMPILED ? [] : ["--import", "tsx"];

// Pre-warmed pool children load the SINGLE-FILE bundled child in compiled mode
// (scripts/build-server.mjs emits dist/server/lib/job-child.bundle.js): one file
// cold-loaded once per child instead of the ~280-module graph, which is the
// structural cure for the cold-import wedge. Under tsx (dev/tests) there is no
// bundle, so the pool forks the plain .ts child exactly like the legacy path.
const POOL_CHILD_PATH = CHILD_IS_COMPILED
  ? path.join(path.dirname(fileURLToPath(import.meta.url)), "job-child.bundle.js")
  : CHILD_PATH;
// The bundle flattens the module tree to dist/server/lib/, so any module that
// resolves an asset from its own location (framework-v2/defect-ledger.ts uses
// __dirname/../../data) would drift to dist/data. Pin the default ledger path to
// the real dist/server/data so the bundled child matches the 1:1 transpiled tree.
// (import.meta.url-anchored assets in server/lib itself — processor.ts's
// pdf-parse-worker.cjs — are already at this same dir, so they do NOT drift.)
const COMPILED_SERVER_DATA_DIR = CHILD_IS_COMPILED
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data")
  : null;

/**
 * Pool size (DESIGN: pre-warmed long-lived child pool). Default 0 → the legacy
 * per-job fork path is used unchanged (ship DORMANT; the whole pool path is
 * inert until an operator sets this). Enable for a canary with e.g.
 * WORKER_ISOLATION_POOL_SIZE = min(WORKER_CONCURRENCY, 4..8).
 */
export function isolationPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, parseInt(env.WORKER_ISOLATION_POOL_SIZE || "0", 10) || 0);
}
/** Recycle a pooled child after this many jobs (memory hygiene). 0 = unlimited. */
export function poolMaxJobs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, parseInt(env.WORKER_ISOLATION_POOL_MAX_JOBS || "0", 10) || 0);
}

// Nice is applied AFTER a child reports "warm", never at fork: a child niced to
// +10 during its cold import gets CPU-starved and never finishes loading (the
// production "child did not warm" wedge). Recorded for tests.
const niceApplications: Array<{ pid: number; nice: number }> = [];
function applyChildNice(pid: number, nice: number): void {
  niceApplications.push({ pid, nice });
  if (niceApplications.length > 200) niceApplications.shift();
  try { os.setPriority(pid, nice); } catch { /* not permitted */ }
}

/** Per-child DB budget: floor((PG_POOL_MAX − R) / WORKER_CONCURRENCY) (DESIGN §4). */
export function childPgBudget(env: NodeJS.ProcessEnv = process.env): number {
  const total = parseInt(env.PG_POOL_MAX || "20", 10);
  const reserve = Math.max(1, parseInt(env.WORKER_ISOLATION_PARENT_PG_RESERVE || String(PG_PARENT_RESERVE), 10));
  const conc = Math.max(1, parseInt(env.WORKER_CONCURRENCY || "10", 10));
  return Math.floor((total - reserve) / conc);
}

// ─── Startup admission gate (thundering-herd cure) ───────────────────────────
// At batch start the worker forks up to WORKER_CONCURRENCY children at once and
// each then cold-loads the large pipeline.js ESM graph (~280 modules). While the
// worker ran children under tsx, each child's transpile latency incidentally
// staggered these imports; precompiling to plain JS (commit 9e8e80d) removed
// that stagger, so on a CPU/IO-constrained container all imports fire
// simultaneously and can saturate the box so badly the module graph never
// finishes loading — children sit wedged in `await import("./pipeline.js")` for
// the whole job. This gate is the STRUCTURAL cure, independent of what provided
// the stagger before: it bounds how many children may be in their cold-start
// (fork → "warm") phase at any instant, turning the burst into a ramp. A slot is
// released the moment a child reports "warm" (its pipeline module is loaded) or
// when the child settles/exits — whichever comes first — so a slot can never
// leak, and a true wedge self-heals once the startup watchdog kills the child.
// WORKER_ISOLATION_STARTUP_CONCURRENCY=0 disables the gate (unbounded, legacy).
function startupGateLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKER_ISOLATION_STARTUP_CONCURRENCY;
  if (raw === undefined) return 4;
  return Math.max(0, parseInt(raw, 10) || 0);
}
let startupActive = 0;
const startupWaiters: Array<() => void> = [];
function acquireStartupSlot(): Promise<void> {
  const limit = startupGateLimit();
  if (limit === 0 || startupActive < limit) { startupActive++; return Promise.resolve(); }
  return new Promise<void>((res) => startupWaiters.push(res));
}
function releaseStartupSlot(): void {
  const next = startupWaiters.shift();
  if (next) next();                                   // hand the held slot straight to the next waiter
  else startupActive = Math.max(0, startupActive - 1);
}
export const __startupGateTesting = {
  state: () => ({ active: startupActive, waiting: startupWaiters.length, limit: startupGateLimit() }),
};

/**
 * Same env + default as pipeline.ts PIPELINE_TIMEOUT_MS. Phase 3 / Issue 3 routes
 * the parent's single hard deadline through the time-budget lever. At the DEFAULT
 * (PIPELINE_TIME_BUDGET_POLICY unset → "wallclock") this returns exactly
 * parseInt(env.PIPELINE_TIMEOUT_MS||"540000") — byte-identical to today. The
 * per-stage budgets / progress-based degradation that "budgeted" adds operate on
 * the heartbeat evaluation path (evaluateTimeBudget), not on this hard ceiling, so
 * the parent's guillotine is unchanged regardless of policy.
 */
export function pipelineTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const legacy = parseInt(env.PIPELINE_TIMEOUT_MS || "540000", 10);
  if (resolvePipelineTimeBudgetPolicy() === "wallclock") return legacy;
  return resolveEffectiveBudget({ env, totalBudgetMs: legacy }).totalBudgetMs;
}

/** Why the parent terminated the child (null = it was never asked to stop). */
export type KillReason = "pipeline_deadline" | "job_deadline" | "startup_timeout" | "cancel" | `revoke:${string}`;

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
    case "startup_timeout":
      // The child never finished loading its pipeline module (cold-import wedge
      // under batch-start contention). Fail LOUD and RETRIABLE — a reject is the
      // "died unexpectedly" class (retry-policy.ts), so the job is re-queued and,
      // once the startup admission gate has drained the herd, succeeds.
      return { reject: new Error(`Isolated job child startup timed out: pipeline module did not load before deadline (${exit})`) };
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
    await storage.logProcessingError({ workspaceId: opts.workspaceId, companyId: company.id, companyName: company.name, stage: "pipeline_timeout",
      error: JSON.stringify({ type: "timeout", elapsedSeconds: elapsed, limitSeconds: Math.round(limitMs / 1000), message: `Pipeline timed out after ${elapsed}s (limit: ${limitMs / 1000}s) [isolated child killed by parent]` }) });
  })().catch((e) => console.warn(`[WORKER-ISOLATION] pipeline-timeout bookkeeping failed: ${e?.message || e}`));
}

export async function runPipelineIsolated(opts: PipelineOptions): Promise<PipelineResult> {
  // Pre-warmed pool path (opt-in, default off). When enabled, dispatch the job to
  // a long-lived warm child instead of forking a fresh one per job. The legacy
  // per-job body below is byte-for-byte unchanged on the default (pool size 0).
  if (isolationPoolSize() > 0) return runPipelineInPool(opts);
  const ctx = getDiagContext();
  const lc = ctx?.lifecycle;
  const budget = childPgBudget();
  if (budget < 1) {
    throw new Error(`Worker isolation refused: per-child PG budget ${budget} < 1 (PG_POOL_MAX − WORKER_ISOLATION_PARENT_PG_RESERVE) / WORKER_CONCURRENCY`);
  }
  installParentExitHook();
  const graceMs = parseInt(process.env.WORKER_ISOLATION_KILL_GRACE_MS || "10000", 10);
  const exitGraceMs = parseInt(process.env.WORKER_ISOLATION_EXIT_GRACE_MS || "2000", 10);
  const reapWindowMs = parseInt(process.env.WORKER_ISOLATION_REAP_WINDOW_MS || "2000", 10);
  const nice = parseInt(process.env.WORKER_ISOLATION_CHILD_NICE || "10", 10);
  const pipelineMs = pipelineTimeoutMs();
  const startupMs = parseInt(process.env.WORKER_ISOLATION_STARTUP_TIMEOUT_MS || "120000", 10);
  const testModule = process.env.CIQ_CHILD_TEST_MODULE;

  // Admission gate: bound how many children are in their cold-start phase at once
  // (see startupGateLimit). Acquired BEFORE the fork so the fork itself ramps;
  // released on "warm" / settle / exit (idempotent). The per-child wait is tiny
  // relative to the pipeline and job deadlines, which are measured from here/claim.
  await acquireStartupSlot();

  return await new Promise<PipelineResult>((resolve, reject) => {
    let startupReleased = false;
    const releaseStartup = () => { if (!startupReleased) { startupReleased = true; releaseStartupSlot(); } };
    const pipelineStart = Date.now();
    const tFork = performance.now();
    const child = fork(CHILD_PATH, [], {
      execArgv: CHILD_EXEC_ARGV,
      serialization: "advanced",
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, CIQ_ISOLATED_CHILD: "1", CIQ_PROCESS_ROLE: "job-child", PG_POOL_MAX: String(budget), ...(testModule ? { CIQ_CHILD_TEST_MODULE: testModule } : {}) },
    });
    stats.forks++; stats.maxForkMs = Math.max(stats.maxForkMs, performance.now() - tFork);
    // CPU contention: children run at lower priority (inherited by Chromium /
    // pdftotext) so the supervisor wins the CPU for lock renewal / heartbeats.
    // Applied ONLY after the child reports "warm" (applyNice below), never at fork:
    // a child niced during its cold import is CPU-starved and never finishes
    // loading (the production "child did not warm" wedge).
    let niceApplied = false;
    const applyNice = () => { if (niceApplied) return; niceApplied = true; if (child.pid && nice > 0) applyChildNice(child.pid, nice); };
    const groups = new Set<number>(child.pid ? [child.pid] : []);
    live.set(child, groups);
    const grants = new Map<number, Grant>();
    let settled = false;
    let exited = false;
    let warm = false;
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
    // Startup watchdog (SAFETY NET): the general invariant that no await in the
    // job path may block unbounded without a deadline that turns a hang into a
    // reported failure. The 75-min pipeline deadline is far too coarse to catch a
    // cold-import wedge; this fires if the child has not reported "warm" (pipeline
    // module loaded) within startupMs of fork, SIGKILLs it, and lets settle()
    // classify it as a retriable startup_timeout — a loud, retried failure instead
    // of an 18-min silent freeze. Disabled when startupMs ≤ 0.
    if (startupMs > 0) timers.push(setTimeout(() => {
      if (warm || exited || reported || killReason) return;
      console.error(`[WORKER-ISOLATION] child pid=${child.pid} did not warm (load pipeline.js) within ${startupMs}ms (stage=${lastStage}) → SIGKILL + fail-loud (retriable startup_timeout)`);
      killReason = "startup_timeout";
      killNow();
    }, startupMs));
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
        case "warm": warm = true; applyNice(); releaseStartup(); break; // pipeline module loaded → cold-start over, free the gate slot + nice now
        case "stage": if (typeof m.stage === "string") {
          lastStage = m.stage; setDiagStage(m.stage);
          // Fallback warm signal: any stage past the cold-import ("spawn"/"pipeline"
          // are the pre-import markers; the stage heartbeat ticks "pipeline" every
          // 2s DURING the import, so those must NOT release the gate). A real stage
          // (fetch/analyze/score/…) proves the module graph loaded.
          if (m.stage !== "spawn" && m.stage !== "pipeline") { warm = true; applyNice(); releaseStartup(); }
        } break;
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
      releaseStartup(); // never leak a gate slot: a child that died before "warm" frees it here
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
      if (!child.pid) { live.delete(child); cleanup(); releaseAll(); releaseStartup(); if (!settled) { settled = true; reject(e); } }
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Pre-warmed child pool (opt-in via WORKER_ISOLATION_POOL_SIZE > 0)
// ════════════════════════════════════════════════════════════════════════════
// Instead of forking a fresh child per job (each paying the ~280-module pipeline
// cold-import that starved niced children in production), fork a small pool of
// long-lived children ONCE. Each imports pipeline.js a single time, reports
// "warm", then processes many jobs over its IPC channel. The parent tracks
// idle/busy, dispatches each isolated job to an idle child, and on a child's
// death respawns a replacement; the in-flight attempt rejects as the retriable
// "exited unexpectedly" class so worker.ts/BullMQ re-queues it as a fresh
// attempt (attempt accounting preserved) that lands on a warm child.
//
// The clean path keeps the child ALIVE: on a `result`/`error` report the parent
// waits for the child's `idle` message (sent after the child resets its per-job
// state), reaps any descendant groups, releases the job's permits, delivers the
// outcome and recycles the child to idle. The kill path (deadline / cancel /
// revoke / crash / unconfirmed cleanup) SIGKILLs the child's groups; the exit
// handler then settles via the same classify + reap + quarantine machinery as
// the legacy per-job path and respawns a replacement.

/** Install the graceful-exit SIGKILL hook once (covers both the legacy per-job
 * children and pooled children — all are tracked in `live`). Abrupt parent death
 * (SIGKILL/OOM) is handled child-side by job-child.ts's watchdog thread. */
function installParentExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const groups of live.values()) signalGroups(groups, "SIGKILL");
    for (const q of quarantine.values()) signalGroups(q.entry.groups, "SIGKILL");
  });
}

function releaseGrantToBroker(g: Grant): void {
  if (g.kind === "llm") llmSlotBroker.release(); else processorSlotBroker[g.kind].release();
}

interface PooledChild {
  child: ChildProcess;
  ownPid: number;                 // the child's own pid (its process-group leader)
  groups: Set<number>;            // own pid + registered descendant groups (Chromium)
  warm: boolean;                  // pipeline module imported, ready to serve
  available: boolean;             // idle, not currently running a job
  niceApplied: boolean;           // os.setPriority applied (once, after first warm)
  nice: number;
  jobsRun: number;                // completed jobs (for poolMaxJobs recycling)
  epoch: number;                  // pool epoch at creation; a shutdown bump (poolEpoch) retires this child without respawn
  startupTimer: ReturnType<typeof setTimeout> | null;
  releaseStartup: () => void;     // idempotent startup-gate release for this cold-start
  session: JobSession | null;     // the in-flight job, or null when idle
}
interface JobWaiter {
  opts: PipelineOptions;
  ctx: any;                       // diag context captured in the job's async scope
  lc: any;                        // lifecycle (ctx?.lifecycle) captured likewise
  resolve: (r: PipelineResult) => void;
  reject: (e: Error) => void;
}
interface JobSession {
  opts: PipelineOptions;
  ctx: any;
  lc: any;
  resolve: (r: PipelineResult) => void;
  reject: (e: Error) => void;
  grants: Map<number, Grant>;
  outstandingLeases: Map<string, any>;
  killReason: KillReason | null;
  reported: IsolatedOutcome | null;
  settled: boolean;
  lastStage: string;
  pipelineStart: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  cancelPoll: ReturnType<typeof setInterval> | null;
  cancelSent: boolean;
  onRevoke: (() => void) | null;
  graceMs: number;
  exitGraceMs: number;
  reapWindowMs: number;
  pipelineMs: number;
}

const POOL_COLDSTART_FAIL_CAP = 10;
const pool: PooledChild[] = [];
const jobWaiters: JobWaiter[] = [];
let poolShuttingDown = false;
let poolPending = 0;              // children forked but not yet in `pool`
let poolDesiredSize = 0;
let poolColdStartFailures = 0;    // consecutive never-warmed deaths (circuit breaker)
let poolEpoch = 0;                // bumped by shutdownPool; deferred spawns from an older epoch abort

function pcSend(pc: PooledChild, m: unknown): void {
  try { if (pc.child.connected) pc.child.send(m as any); } catch { /* closing */ }
}
function removeFromPool(pc: PooledChild): void {
  const i = pool.indexOf(pc);
  if (i >= 0) pool.splice(i, 1);
}

async function runPipelineInPool(opts: PipelineOptions): Promise<PipelineResult> {
  const budget = childPgBudget();
  if (budget < 1) {
    throw new Error(`Worker isolation refused: per-child PG budget ${budget} < 1 (PG_POOL_MAX − WORKER_ISOLATION_PARENT_PG_RESERVE) / WORKER_CONCURRENCY`);
  }
  installParentExitHook();
  ensurePool();
  // Capture the diag context HERE, in the job's async scope. dispatch may happen
  // later (from a child's message handler) where the ALS context is wrong, so the
  // waiter carries its own ctx/lc rather than re-reading getDiagContext() then.
  const ctx = getDiagContext();
  const lc = ctx?.lifecycle;
  return await new Promise<PipelineResult>((resolve, reject) => {
    const waiter: JobWaiter = { opts, ctx, lc, resolve, reject };
    if (poolShuttingDown) { reject(new Error("Worker isolation pool shutting down")); return; }
    const pc = acquireChild();
    if (pc) { pc.available = false; dispatchJob(pc, waiter); }
    else jobWaiters.push(waiter);
  });
}

function ensurePool(): void {
  if (poolShuttingDown) return;
  poolDesiredSize = isolationPoolSize();
  while (pool.length + poolPending < poolDesiredSize) createPooledChild();
}

function acquireChild(): PooledChild | null {
  for (const pc of pool) if (pc.warm && pc.available && !pc.session) return pc;
  return null;
}

function createPooledChild(): void {
  if (poolShuttingDown) return;
  const epoch = poolEpoch;
  poolPending++;
  const budget = childPgBudget();
  const nice = parseInt(process.env.WORKER_ISOLATION_CHILD_NICE || "10", 10);
  const startupMs = parseInt(process.env.WORKER_ISOLATION_STARTUP_TIMEOUT_MS || "120000", 10);
  const testModule = process.env.CIQ_CHILD_TEST_MODULE;
  void acquireStartupSlot().then(() => {
    if (poolShuttingDown || poolEpoch !== epoch) { releaseStartupSlot(); poolPending--; return; }
    const env: NodeJS.ProcessEnv = { ...process.env, CIQ_CHILD_POOL: "1", CIQ_ISOLATED_CHILD: "1", CIQ_PROCESS_ROLE: "job-child", PG_POOL_MAX: String(budget), ...(testModule ? { CIQ_CHILD_TEST_MODULE: testModule } : {}) };
    // Bundled child safety net: pin the defect-ledger default to dist/server/data
    // so the flattened bundle does not drift it to dist/data (see COMPILED_SERVER_DATA_DIR).
    if (COMPILED_SERVER_DATA_DIR && !env.DEFECT_LEDGER_PATH) env.DEFECT_LEDGER_PATH = path.join(COMPILED_SERVER_DATA_DIR, "defect-ledger.jsonl");
    const tFork = performance.now();
    const child = fork(POOL_CHILD_PATH, [], {
      execArgv: CHILD_EXEC_ARGV,
      serialization: "advanced",
      detached: true,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env,
    });
    stats.forks++; stats.maxForkMs = Math.max(stats.maxForkMs, performance.now() - tFork);
    poolPending--;
    const ownPid = child.pid ?? -1;
    let startupReleased = false;
    const releaseStartup = () => { if (!startupReleased) { startupReleased = true; releaseStartupSlot(); } };
    const pc: PooledChild = { child, ownPid, groups: new Set<number>(ownPid > 0 ? [ownPid] : []), warm: false, available: false, niceApplied: false, nice, jobsRun: 0, epoch, startupTimer: null, releaseStartup, session: null };
    pool.push(pc);
    live.set(child, pc.groups);
    // Startup watchdog: a pooled child that never finishes its single cold-import
    // is SIGKILLed and respawned (with backoff + circuit breaker). Same safety-net
    // role as the legacy per-job startup watchdog, now gating pool cold-starts.
    if (startupMs > 0) pc.startupTimer = setTimeout(() => {
      if (pc.warm) return;
      console.error(`[WORKER-ISOLATION] pooled child pid=${child.pid} did not warm (load pipeline.js) within ${startupMs}ms → SIGKILL + respawn`);
      signalGroups(pc.groups, "SIGKILL");
    }, startupMs);
    child.on("message", (m: any) => { const t0 = performance.now(); stats.messages++; try { routeChildMessage(pc, m); } finally { stats.maxHandlerMs = Math.max(stats.maxHandlerMs, performance.now() - t0); } });
    child.on("exit", (code, signal) => onPooledChildExit(pc, code, signal, releaseStartup));
    child.on("error", (e) => {
      console.warn(`[WORKER-ISOLATION] pooled child error: ${e?.message || e}`);
      if (!child.pid) {                              // fork itself failed → never entered the OS
        releaseStartup();
        if (pc.startupTimer) { clearTimeout(pc.startupTimer); pc.startupTimer = null; }
        removeFromPool(pc); live.delete(child);
        scheduleRespawn(true);
      }
    });
  }).catch((e) => { poolPending--; console.warn(`[WORKER-ISOLATION] pooled child spawn failed: ${(e as any)?.message || e}`); });
}

function routeChildMessage(pc: PooledChild, m: any): void {
  if (!m || typeof m !== "object") return;
  const session = pc.session;
  switch (m.t) {
    // ── child-level (no session) ───────────────────────────────────────────
    case "ready":
      pcSend(pc, { t: "warmup" });                   // pool: import pipeline once, then wait for jobs
      break;
    case "warm":
      pc.warm = true;
      pc.releaseStartup();                            // free the startup-gate slot (cold-start over)
      poolColdStartFailures = 0;                      // a successful warm clears the circuit breaker
      if (!pc.niceApplied && pc.ownPid > 0 && pc.nice > 0) { pc.niceApplied = true; applyChildNice(pc.ownPid, pc.nice); }
      makeAvailable(pc);
      break;
    case "idle":                                      // child reported + reset → recycle to idle
      if (session && session.reported) finalizeCleanAndRecycle(pc);
      break;
    case "pgroup": if (Number.isInteger(m.pid) && m.pid > 1) pc.groups.add(m.pid); break;
    case "usage": ingestUsageRowFromChild(m.row); break;
    case "paid": ingestPaidCallRowFromChild(m.row); break;
    case "stageprofile": ingestStageProfileRowFromChild(m.row); break;
    case "signal": ingestSignalFromChild(m.kind); break;
    // ── session-level (require an in-flight job) ───────────────────────────
    case "acquire": {
      if (!session) break;
      const kind = m.kind as PermitKind;
      const g: Grant = { kind, granted: false, cancelled: false };
      session.grants.set(m.id, g);
      let p: Promise<void>;
      if (kind === "llm") { g.ac = new AbortController(); p = llmSlotBroker.acquire(g.ac.signal); } else p = processorSlotBroker[kind].acquire();
      p.then(() => {
        if (g.cancelled || !session.grants.has(m.id) || session.settled) { releaseGrantToBroker(g); session.grants.delete(m.id); return; }
        g.granted = true;
        pcSend(pc, { t: "granted", id: m.id });
      }, () => { session.grants.delete(m.id); });
      break;
    }
    case "cancelAcquire": {
      if (!session) break;
      const g = session.grants.get(m.id);
      if (g && !g.granted) { g.cancelled = true; g.ac?.abort(); session.grants.delete(m.id); }
      break;
    }
    case "release": {
      if (!session) break;
      const g = session.grants.get(m.id);
      if (g?.granted) { releaseGrantToBroker(g); session.grants.delete(m.id); }
      break;
    }
    case "stage": if (session && typeof m.stage === "string") { session.lastStage = m.stage; setDiagStage(m.stage); } break;
    case "lease": {
      if (!session || typeof m.op !== "string") break;
      if (m.ev === "acquire" || m.ev === "granted") session.outstandingLeases.set(m.op, m);
      else session.outstandingLeases.delete(m.op);
      break;
    }
    case "result":
      if (!session) break;
      mergeBatchFetchState(session.opts.batchFetchState, m.batchFetchState);
      if (m.revokedReason && session.lc) revokeAttempt(session.lc, m.revokedReason);
      onReportedPool(pc, session, { resolve: m.result as PipelineResult });
      break;
    case "error":
      if (!session) {                                 // warmup load failure (no job) → child will exit → respawn
        console.warn(`[WORKER-ISOLATION] pooled child pid=${pc.ownPid} failed to warm: ${m.error?.message || "unknown"}`);
        break;
      }
      onReportedPool(pc, session, { reject: rebuildError(m.error) });
      break;
  }
}

function makeAvailable(pc: PooledChild): void {
  if (poolShuttingDown) return;
  pc.session = null;
  const w = jobWaiters.shift();
  if (w) { pc.available = false; dispatchJob(pc, w); }
  else pc.available = true;
}

function dispatchJob(pc: PooledChild, w: JobWaiter): void {
  const { opts, ctx, lc } = w;
  const graceMs = parseInt(process.env.WORKER_ISOLATION_KILL_GRACE_MS || "10000", 10);
  const exitGraceMs = parseInt(process.env.WORKER_ISOLATION_EXIT_GRACE_MS || "2000", 10);
  const reapWindowMs = parseInt(process.env.WORKER_ISOLATION_REAP_WINDOW_MS || "2000", 10);
  const pipelineMs = pipelineTimeoutMs();
  const session: JobSession = {
    opts, ctx, lc, resolve: w.resolve, reject: w.reject,
    grants: new Map(), outstandingLeases: new Map(),
    killReason: null, reported: null, settled: false, lastStage: "pipeline",
    pipelineStart: Date.now(), timers: [], cancelPoll: null, cancelSent: false, onRevoke: null,
    graceMs, exitGraceMs, reapWindowMs, pipelineMs,
  };
  pc.session = session;
  pc.available = false;
  session.timers.push(setTimeout(() => onDeadlinePool(pc, session, "pipeline_deadline"), pipelineMs));
  if (lc?.deadlineAt) session.timers.push(setTimeout(() => onDeadlinePool(pc, session, "job_deadline"), Math.max(0, lc.deadlineAt.getTime() - Date.now())));
  const onRevoke = () => { pcSend(pc, { t: "revoke", reason: lc?.revokedReason || "revoked" }); armKillPool(pc, session, `revoke:${lc?.revokedReason}`); };
  session.onRevoke = onRevoke;
  if (lc) { if (lc.abort.signal.aborted) onRevoke(); else lc.abort.signal.addEventListener("abort", onRevoke, { once: true }); }
  session.cancelPoll = setInterval(() => {
    if (!session.cancelSent && opts.cancelCheck?.()) { session.cancelSent = true; pcSend(pc, { t: "cancel" }); armKillPool(pc, session, "cancel"); }
  }, 500);
  pcSend(pc, { t: "init", opts: { ...opts, cancelCheck: undefined },
    lifecycle: lc ? { jobId: lc.jobId, batchId: lc.batchId, attemptNumber: lc.attemptNumber, deadlineAt: lc.deadlineAt, attemptToken: lc.attemptToken ?? null, revokedReason: lc.revoked ? lc.revokedReason : null } : null,
    attemptId: ctx?.attemptId ?? opts.attemptId ?? null,
    companyId: ctx?.companyId ?? (opts.company as any)?.id ?? null,
    frameworkId: ctx?.frameworkId ?? (opts.framework as any)?.id ?? null,
    cancelled: session.cancelSent });
}

/** Hard deadline for a pooled job: revoke + SIGKILL the child's groups. The exit
 * handler then settles the session (reported wins if one arrived in time). */
function onDeadlinePool(pc: PooledChild, session: JobSession, which: "pipeline_deadline" | "job_deadline"): void {
  if (session.settled) return;
  if (session.reported) { signalGroups(pc.groups, "SIGKILL"); return; }
  if (!session.killReason) session.killReason = which;
  const leaseSummary = session.outstandingLeases.size === 0 ? "none" : Array.from(session.outstandingLeases.values())
    .map((e: any) => `${e.op}[${e.ev} ${e.kind ?? "?"} ${e.origin ?? "-"} urls=${e.urls ?? 0} job=${e.job ?? "-"}/att=${e.attempt ?? "-"} at=${e.at}]`).join(", ");
  console.warn(`[WORKER-ISOLATION] ${which} reached for pooled child pid=${pc.ownPid} (stage=${session.lastStage}, outstandingLeases=${leaseSummary}) → revoke + SIGKILL groups`);
  if (session.lc) revokeAttempt(session.lc, which === "pipeline_deadline" ? "pipeline_timeout" : "job_watchdog_timeout");
  if (!testHooks.suppressDeadlineKill) signalGroups(pc.groups, "SIGKILL");
}

/** Cooperative stop (cancel / revoke): graceMs for the child to return, then
 * SIGTERM → +5s SIGKILL the child's groups (destroys this warm child; exit → respawn). */
function armKillPool(pc: PooledChild, session: JobSession, why: KillReason): void {
  if (session.killReason || session.reported) return;
  session.killReason = why;
  session.timers.push(setTimeout(() => {
    console.warn(`[WORKER-ISOLATION] pooled child pid=${pc.ownPid} still alive ${session.graceMs}ms after ${why} → SIGTERM groups`);
    signalGroups(pc.groups, "SIGTERM");
    session.timers.push(setTimeout(() => signalGroups(pc.groups, "SIGKILL"), 5000));
  }, session.graceMs));
}

/** A clean report arrived; if the child does not go `idle` within exitGraceMs it
 * is hung after reporting — SIGKILL it (exit handler settles with the report). */
function onReportedPool(pc: PooledChild, session: JobSession, o: IsolatedOutcome): void {
  if (session.reported) return;
  if (session.killReason) {
    stats.lateReportsDiscarded++;
    const summary = "resolve" in o ? `success=${o.resolve?.success} error=${o.resolve?.error ?? "-"}` : `error=${o.reject.message}`;
    lateReports.push({ childPid: pc.ownPid, killReason: session.killReason, kind: "resolve" in o ? "result" : "error", summary, at: Date.now() });
    if (lateReports.length > 50) lateReports.shift();
    console.warn(`[WORKER-ISOLATION] pooled child pid=${pc.ownPid} reported AFTER terminal decision ${session.killReason} → discarded (diagnostic only: ${summary})`);
    return;
  }
  session.reported = o;
  session.timers.push(setTimeout(() => { console.warn(`[WORKER-ISOLATION] pooled child pid=${pc.ownPid} reported but did not idle in ${session.exitGraceMs}ms → SIGKILL groups`); signalGroups(pc.groups, "SIGKILL"); }, session.exitGraceMs));
}

function clearSessionTimers(session: JobSession): void {
  if (session.cancelPoll) { clearInterval(session.cancelPoll); session.cancelPoll = null; }
  for (const t of session.timers) clearTimeout(t);
  session.timers.length = 0;
  if (session.onRevoke && session.lc) session.lc.abort.signal.removeEventListener("abort", session.onRevoke);
}

function releaseSessionGrants(session: JobSession): void {
  for (const [id, g] of session.grants) {
    if (g.granted) releaseGrantToBroker(g); else { g.cancelled = true; g.ac?.abort(); }
    session.grants.delete(id);
  }
}
function withholdSessionGrants(session: JobSession): { withheld: Record<PermitKind, number>; release: () => void } {
  const held: Grant[] = [];
  const withheld: Record<PermitKind, number> = { llm: 0, browser: 0, proc: 0 };
  for (const [id, g] of session.grants) {
    if (g.granted) { held.push(g); withheld[g.kind]++; } else { g.cancelled = true; g.ac?.abort(); }
    session.grants.delete(id);
  }
  let done = false;
  return { withheld, release: () => { if (done) return; done = true; for (const g of held) releaseGrantToBroker(g); } };
}

function settleSession(session: JobSession, code: number | null, signal: NodeJS.Signals | null, cleanupFailure: string | null): void {
  if (session.settled) return;
  session.settled = true;
  clearSessionTimers(session);
  const pipelineElapsedMs = Date.now() - session.pipelineStart;
  let out = classifyIsolatedOutcome({ reported: session.reported, killReason: session.killReason, code, signal, lastStage: session.lastStage, pipelineElapsedMs });
  if (!session.reported && session.killReason === "pipeline_deadline") recordPipelineTimeout(session.opts, pipelineElapsedMs, session.pipelineMs);
  if (cleanupFailure && "resolve" in out && out.resolve.success) out = { reject: new Error(cleanupFailure) };
  if ("resolve" in out) session.resolve(out.resolve); else session.reject(out.reject);
}

/** Clean completion: child stays alive. Reap DESCENDANT groups only (never the
 * child's own pid), release the job's permits, deliver the reported outcome, and
 * recycle the child to idle. */
function finalizeCleanAndRecycle(pc: PooledChild): void {
  const session = pc.session;
  if (!session || session.settled) return;
  clearSessionTimers(session);
  const descendants = [...pc.groups].filter((g) => g !== pc.ownPid);
  const reapWindowMs = session.reapWindowMs;
  void (async () => {
    let r: GroupProbe = { live: [], zombies: [], reliable: true };
    if (descendants.length > 0) {
      signalGroups(descendants, "SIGKILL");
      const until = Date.now() + reapWindowMs;
      for (;;) {
        try { r = await livenessProbe(descendants); } catch { r = { live: [-1], zombies: [], reliable: false }; }
        if (r.live.length === 0 || Date.now() >= until) break;
        signalGroups(descendants, "SIGKILL");
        await new Promise((res) => setTimeout(res, 20));
      }
    }
    // Drop reaped descendant groups; keep the child's own group.
    pc.groups.clear(); if (pc.ownPid > 0) pc.groups.add(pc.ownPid);
    if (r.live.length !== 0) {
      // Descendants could not be confirmed gone even on a clean report → do not
      // re-grant this child's capacity: retire it (kill + quarantine) and respawn.
      const { withheld, release } = withholdSessionGrants(session);
      const reason = `cleanup unconfirmed after ${reapWindowMs}ms (clean report): live=[${r.live.join(",")}] zombies=[${r.zombies.join(",")}] probeReliable=${r.reliable}`;
      const pid = pc.ownPid;
      quarantine.set(pid, { entry: { childPid: pid, jobId: session.lc?.jobId ?? null, batchId: session.lc?.batchId ?? null, groups: descendants, reason, since: Date.now(), livePids: r.live, zombiePids: r.zombies, probeReliable: r.reliable, withheld }, release });
      stats.quarantined++;
      ensureQuarantineMonitor();
      console.error(`[WORKER-ISOLATION] QUARANTINE pooled child pid=${pid} ${reason}; permits withheld ${JSON.stringify(withheld)}`);
      settleSession(session, null, null, `Isolated job child cleanup unconfirmed: pooled child pid=${pid} quarantined, ${reason}, permits withheld browser=${withheld.browser} proc=${withheld.proc} llm=${withheld.llm}`);
      pc.session = null;
      signalGroups(new Set([pc.ownPid]), "SIGKILL");   // kill the child itself → exit handler respawns
      return;
    }
    releaseSessionGrants(session);
    settleSession(session, null, null, null);            // reported outcome wins
    pc.session = null;
    recycleChild(pc);
  })();
}

/** Return a clean child to the pool, or retire it (kill → respawn) once it has
 * served poolMaxJobs jobs (memory hygiene; 0 = unlimited). */
function recycleChild(pc: PooledChild): void {
  if (poolShuttingDown) return;
  pc.jobsRun++;
  const max = poolMaxJobs();
  if (max > 0 && pc.jobsRun >= max) {
    console.warn(`[WORKER-ISOLATION] pooled child pid=${pc.ownPid} reached poolMaxJobs=${max} → retire + respawn`);
    signalGroups(pc.groups, "SIGKILL");               // exit handler (no session) respawns a fresh warm child
    return;
  }
  makeAvailable(pc);
}

function onPooledChildExit(pc: PooledChild, code: number | null, signal: NodeJS.Signals | null, releaseStartup: () => void): void {
  if (pc.startupTimer) { clearTimeout(pc.startupTimer); pc.startupTimer = null; }
  releaseStartup();
  const epoch = pc.epoch; // this child's creation epoch; a shutdown bump between then and now suppresses respawn
  const neverWarmed = !pc.warm;
  const session = pc.session;
  pc.session = null;
  removeFromPool(pc);
  signalGroups(pc.groups, "SIGKILL");
  const reapWindowMs = session?.reapWindowMs ?? parseInt(process.env.WORKER_ISOLATION_REAP_WINDOW_MS || "2000", 10);
  const until = Date.now() + reapWindowMs;
  void (async () => {
    let r: GroupProbe = { live: [], zombies: [], reliable: true };
    for (;;) {
      try { r = await livenessProbe([...pc.groups]); } catch { r = { live: [-1], zombies: [], reliable: false }; }
      if (r.live.length === 0 || Date.now() >= until) break;
      signalGroups(pc.groups, "SIGKILL");
      await new Promise((res) => setTimeout(res, 20));
    }
    live.delete(pc.child);
    if (session && !session.settled) {
      if (r.live.length === 0) { releaseSessionGrants(session); settleSession(session, code, signal, null); }
      else {
        const { withheld, release } = withholdSessionGrants(session);
        const pid = pc.ownPid;
        const reason = `cleanup unconfirmed after ${reapWindowMs}ms: live=[${r.live.join(",")}] zombies=[${r.zombies.join(",")}] probeReliable=${r.reliable}`;
        quarantine.set(pid, { entry: { childPid: pid, jobId: session.lc?.jobId ?? null, batchId: session.lc?.batchId ?? null, groups: [...pc.groups], reason, since: Date.now(), livePids: r.live, zombiePids: r.zombies, probeReliable: r.reliable, withheld }, release });
        stats.quarantined++;
        ensureQuarantineMonitor();
        console.error(`[WORKER-ISOLATION] QUARANTINE pooled child pid=${pid} job=${session.lc?.jobId ?? "-"} groups=[${[...pc.groups].join(",")}] ${reason}; permits withheld ${JSON.stringify(withheld)}`);
        settleSession(session, code, signal, `Isolated job child cleanup unconfirmed: pooled child pid=${pid} quarantined, ${reason}, permits withheld browser=${withheld.browser} proc=${withheld.proc} llm=${withheld.llm}`);
      }
    }
    if (!poolShuttingDown && poolEpoch === epoch) scheduleRespawn(neverWarmed);
  })();
}

/** Respawn toward the desired pool size. A never-warmed death counts toward a
 * circuit breaker so a persistent cold-start wedge cannot fork-storm forever. */
function scheduleRespawn(neverWarmed: boolean): void {
  if (poolShuttingDown) return;
  if (neverWarmed) {
    poolColdStartFailures++;
    if (poolColdStartFailures > POOL_COLDSTART_FAIL_CAP) {
      console.error(`[WORKER-ISOLATION] pool cold-start failed ${poolColdStartFailures}x (cap ${POOL_COLDSTART_FAIL_CAP}) → circuit open; rejecting ${jobWaiters.length} queued isolated jobs`);
      const err = new Error(`Worker isolation pool failed to warm after ${poolColdStartFailures} attempts (cold-start wedge); isolated jobs refused`);
      for (const w of jobWaiters.splice(0)) w.reject(err);
      return;
    }
  }
  if (pool.length + poolPending >= isolationPoolSize()) return;
  const epoch = poolEpoch;
  const backoff = neverWarmed ? Math.min(30000, 500 * Math.pow(2, Math.min(poolColdStartFailures, 6))) : 100;
  const t = setTimeout(() => {
    if (poolShuttingDown || poolEpoch !== epoch) return;
    while (pool.length + poolPending < isolationPoolSize()) createPooledChild();
  }, backoff);
  t.unref?.();
}

/** Tear the pool down (tests / shutdown): reject queued jobs, SIGKILL every
 * child, and wait (bounded) for them to exit. */
async function shutdownPool(): Promise<void> {
  poolShuttingDown = true;
  poolEpoch++; // invalidate any deferred spawns from onPooledChildExit/scheduleRespawn fired by our own SIGKILLs
  for (const w of jobWaiters.splice(0)) w.reject(new Error("Worker isolation pool shutting down"));
  for (const pc of pool.slice()) {
    if (pc.startupTimer) { clearTimeout(pc.startupTimer); pc.startupTimer = null; }
    pc.releaseStartup();
    if (pc.session) clearSessionTimers(pc.session);
    signalGroups(pc.groups, "SIGKILL");
  }
  const deadline = Date.now() + 5000;
  while (pool.length > 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));
  for (const pc of pool.splice(0)) live.delete(pc.child);
  poolShuttingDown = false;
  poolColdStartFailures = 0;
  poolDesiredSize = 0;
}

export const __testing = {
  liveChildren: () => live.size,
  brokerState: () => ({ llm: llmSlotBroker.state(), browser: processorSlotBroker.browser.state(), proc: processorSlotBroker.proc.state() }),
  stats: () => ({ ...stats }),
  resetStats: () => { Object.assign(stats, { forks: 0, maxForkMs: 0, messages: 0, maxHandlerMs: 0, lateReportsDiscarded: 0, quarantined: 0 }); lateReports.length = 0; niceApplications.length = 0; },
  lateReports: () => lateReports.map((r) => ({ ...r })),
  setLivenessProbe: (p: LivenessProbe | null) => { livenessProbe = p ?? probeGroups; },
  setSuppressDeadlineKill: (v: boolean) => { testHooks.suppressDeadlineKill = v; },
  // Pre-warmed pool (opt-in) diagnostics / test control.
  shutdownPool: () => shutdownPool(),
  poolState: () => ({ size: pool.length, pending: poolPending, desired: poolDesiredSize, warm: pool.filter((p) => p.warm).length, available: pool.filter((p) => p.available).length, busy: pool.filter((p) => !!p.session).length, waiters: jobWaiters.length, pids: pool.map((p) => p.ownPid) }),
  niceApplications: () => niceApplications.map((n) => ({ ...n })),
};

// ─── DIAGNOSTIC-ONLY attempt / stage correlation + stage timers ──────────────
// Behaviour-neutral instrumentation (batch-1255 plan §6.2/§6.3). Nothing in this
// module alters control flow: it only records and logs. Every helper is a
// transparent pass-through when no diagnostic context is active.
//
// Context is propagated implicitly via AsyncLocalStorage (same pattern as
// llm-usage.ts runWithLlmContext). The worker wraps each job in
// runWithDiagContext(); every DB op / log site below that runs inside the job
// (including timers created inside it, e.g. the heartbeat) can read
// batch_id / job_id / attempt_id / company_id / stage without threading params.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface DiagContext {
  batchId?: number | null;
  jobId?: number | null;
  /** UUID minted per job CLAIM in worker.ts. Each retry gets a new one. */
  attemptId?: string | null;
  /** analysis_jobs.attempts counter value at claim time (1-based). */
  attemptNumber?: number | null;
  companyId?: number | null;
  frameworkId?: number | null;
  /** Coarse pipeline stage (pre-claim, fetch, discovery, analyze, score-write, finalize...). */
  stage?: string;
  /** Open (and recently closed) stage timers for this attempt. */
  timers?: Set<StageTimer>;
  /**
   * Lifecycle fencing state for a worker attempt (see lifecycle-fence.ts).
   * Shared by reference with child contexts so a revoke is seen everywhere.
   */
  lifecycle?: AttemptLifecycleState;
}

export interface AttemptLifecycleState {
  jobId: number;
  batchId: number;
  attemptNumber: number;
  deadlineAt: Date | null;
  /** analysis_jobs.attempt_token minted by this attempt's claimJob (never reused). */
  attemptToken?: string | null;
  revoked: boolean;
  revokedReason: string | null;
  abort: AbortController;
}

const diagStore = new AsyncLocalStorage<DiagContext>();

export function runWithDiagContext<T>(ctx: DiagContext, fn: () => T): T {
  return diagStore.run(ctx, fn);
}

export function getDiagContext(): DiagContext | undefined {
  return diagStore.getStore();
}

/** Mutates the current job's context stage. No-op outside a context. */
export function setDiagStage(stage: string): void {
  const c = diagStore.getStore();
  if (c) c.stage = stage;
}

/** Compact key=value tags for log lines. Safe outside a context. */
export function diagTags(c: DiagContext | undefined = diagStore.getStore()): string {
  if (!c) return "batch=- job=- attempt_id=- company=- stage=-";
  return (
    `batch=${c.batchId ?? "-"} job=${c.jobId ?? "-"} attempt_id=${c.attemptId ?? "-"}` +
    ` attempt_n=${c.attemptNumber ?? "-"} company=${c.companyId ?? "-"} stage=${c.stage ?? "-"}`
  );
}

/** Structured form of the same tags (for JSON log payloads). */
export function diagFields(c: DiagContext | undefined = diagStore.getStore()): Record<string, unknown> {
  return {
    batch_id: c?.batchId ?? null,
    job_id: c?.jobId ?? null,
    attempt_id: c?.attemptId ?? null,
    attempt_n: c?.attemptNumber ?? null,
    company_id: c?.companyId ?? null,
    stage: c?.stage ?? null,
  };
}

// ─── Stage timer ─────────────────────────────────────────────────────────────
// Records, per stage: count, errors, SUMMED busy time (sum of each op's own
// duration — overlapping concurrent ops are each counted, so this can exceed
// wall-clock) and UNION time (wall-clock during which ≥1 op of that stage was in
// flight — never double-counts concurrency). Also tracks overall attempt
// wall-clock, wall-clock covered by ANY tracked op, the last op that made
// progress (completed) and the ops still pending at finish/timeout.
// Ops that START after finish() are counted as post-close ops (evidence of work
// continuing after a timeout / ownership loss) — recorded, never blocked.

interface StageStats {
  count: number;
  errors: number;
  busyMs: number;
  unionMs: number;
  active: number;
  activeSince: number;
}

interface PendingOp {
  stage: string;
  op: string;
  startedAt: number;
}

const DIAG_STAGE_TIMERS_ENABLED = process.env.DIAG_STAGE_TIMERS !== "false";
const POST_CLOSE_LOG_FIRST = 20;
const POST_CLOSE_LOG_EVERY = 50;

export class StageTimer {
  readonly kind: string;
  readonly label: string;
  readonly startedAt = performance.now();
  readonly startedAtIso = new Date().toISOString();
  private stages = new Map<string, StageStats>();
  private anyActive = 0;
  private anySince = 0;
  private anyMs = 0;
  private pending = new Map<number, PendingOp>();
  private nextId = 1;
  private lastProgress: { stage: string; op: string; atMs: number; ok: boolean } | null = null;
  closed = false;
  private closedAt = 0;
  private postCloseOps = 0;
  private postCloseByStage: Record<string, number> = {};

  constructor(kind: string, label: string) {
    this.kind = kind;
    this.label = label;
  }

  private stat(stage: string): StageStats {
    let s = this.stages.get(stage);
    if (!s) {
      s = { count: 0, errors: 0, busyMs: 0, unionMs: 0, active: 0, activeSince: 0 };
      this.stages.set(stage, s);
    }
    return s;
  }

  /** Marks an op as started; returns an idempotent end(ok) callback. */
  begin(stage: string, op: string): (ok?: boolean) => void {
    const now = performance.now();
    if (this.closed) {
      this.postCloseOps++;
      this.postCloseByStage[stage] = (this.postCloseByStage[stage] || 0) + 1;
      if (this.postCloseOps <= POST_CLOSE_LOG_FIRST || this.postCloseOps % POST_CLOSE_LOG_EVERY === 0) {
        console.warn(
          `[DIAG][post-close-op] timer=${this.kind}:${this.label} n=${this.postCloseOps} stage=${stage} op=${truncate(op, 160)}` +
            ` ms_since_close=${Math.round(now - this.closedAt)} ${diagTags()}`,
        );
      }
      return () => {};
    }
    const id = this.nextId++;
    this.pending.set(id, { stage, op, startedAt: now });
    const s = this.stat(stage);
    if (s.active === 0) s.activeSince = now;
    s.active++;
    if (this.anyActive === 0) this.anySince = now;
    this.anyActive++;
    let ended = false;
    return (ok = true) => {
      if (ended) return;
      ended = true;
      if (!this.pending.has(id)) return; // finished while pending; already accounted as pending
      this.pending.delete(id);
      const end = performance.now();
      s.count++;
      if (!ok) s.errors++;
      s.busyMs += end - now;
      s.active--;
      if (s.active === 0) s.unionMs += end - s.activeSince;
      this.anyActive--;
      if (this.anyActive === 0) this.anyMs += end - this.anySince;
      this.lastProgress = { stage, op, atMs: end - this.startedAt, ok };
    };
  }

  /** Closes the timer and emits ONE summary line. Idempotent. */
  finish(outcome: string, err?: unknown): void {
    if (this.closed) return;
    // Diagnostics must never throw into the caller's control flow.
    try {
      this.finishInner(outcome, err);
    } catch (e: any) {
      this.closed = true;
      console.warn(`[DIAG][stage-timer] summary failed (ignored): ${e?.message || e}`);
    }
  }

  private finishInner(outcome: string, err?: unknown): void {
    const now = performance.now();
    this.closed = true;
    this.closedAt = now;
    const wallMs = now - this.startedAt;
    // Fold still-active intervals into union/any time up to "now".
    const stages: Record<string, unknown> = {};
    let busySum = 0;
    for (const [name, s] of this.stages) {
      const pendingBusy = [...this.pending.values()]
        .filter((p) => p.stage === name)
        .reduce((a, p) => a + (now - p.startedAt), 0);
      const union = s.unionMs + (s.active > 0 ? now - s.activeSince : 0);
      busySum += s.busyMs + pendingBusy;
      stages[name] = {
        done: s.count,
        errors: s.errors,
        pending: s.active,
        busy_sum_ms: Math.round(s.busyMs + pendingBusy),
        union_wall_ms: Math.round(union),
      };
    }
    const anyMs = this.anyMs + (this.anyActive > 0 ? now - this.anySince : 0);
    const pendingList = [...this.pending.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(0, 10)
      .map((p) => ({ stage: p.stage, op: truncate(p.op, 160), age_ms: Math.round(now - p.startedAt) }));
    const payload = {
      kind: this.kind,
      label: this.label,
      outcome,
      error: err ? truncate(String((err as any)?.message || err), 300) : null,
      started_at: this.startedAtIso,
      attempt_wall_ms: Math.round(wallMs),
      tracked_wall_ms: Math.round(anyMs),
      other_untracked_wall_ms: Math.round(Math.max(0, wallMs - anyMs)),
      busy_sum_ms_all_stages: Math.round(busySum),
      stages,
      last_progress: this.lastProgress
        ? { ...this.lastProgress, op: truncate(this.lastProgress.op, 160), atMs: Math.round(this.lastProgress.atMs) }
        : null,
      pending_at_close_count: this.pending.size,
      pending_at_close: pendingList,
      ...diagFields(),
    };
    const line = `[DIAG][stage-timer] ${JSON.stringify(payload)}`;
    if (outcome === "ok") console.log(line);
    else console.warn(line);
    // Pending entries stay referenced only for their end() closures to no-op.
    this.pending.clear();
  }

  get postCloseCount(): number {
    return this.postCloseOps;
  }
}

/**
 * Creates a (detached) stage timer, or null when DIAG_STAGE_TIMERS=false.
 * Attach it to an async tree with runWithChildTimer(timer, fn).
 */
export function startStageTimer(kind: string, label: string): StageTimer | null {
  if (!DIAG_STAGE_TIMERS_ENABLED) return null;
  return new StageTimer(kind, label);
}

/**
 * Runs fn in a CHILD context (copy of the current one) whose timer set also
 * includes `timer`. Only ops inside fn's async tree are attributed to `timer`,
 * so ops recorded after the timer closes are genuinely post-close work by that
 * tree (e.g. an orphaned discovery/pipeline after its timeout), not unrelated
 * later work. Returns exactly what fn returns.
 */
export function runWithChildTimer<T>(timer: StageTimer | null, fn: () => T): T {
  if (!timer) return fn();
  const c = diagStore.getStore();
  const child: DiagContext = { ...(c || {}), timers: new Set([...(c?.timers || []), timer]) };
  return diagStore.run(child, fn);
}

/** Begin an op on every timer in the current context. Returns end(ok). */
export function beginStage(stage: string, op: string): (ok?: boolean) => void {
  const c = diagStore.getStore();
  if (!c?.timers || c.timers.size === 0) return noop;
  const ends: Array<(ok?: boolean) => void> = [];
  for (const t of c.timers) ends.push(t.begin(stage, op));
  return (ok = true) => {
    for (const e of ends) e(ok);
  };
}

/** Times an async op under a stage. Same resolution/rejection as fn(). */
export async function timeStage<T>(stage: string, op: string, fn: () => Promise<T>): Promise<T> {
  const c = diagStore.getStore();
  if (!c?.timers || c.timers.size === 0) return fn();
  const end = beginStage(stage, op);
  try {
    const r = await fn();
    end(true);
    return r;
  } catch (e) {
    end(false);
    throw e;
  }
}

function noop(): void {}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ─── WP10 — Read-only per-stage PROFILER sink ────────────────────────────────
// Plan: docs/quality-and-efficiency-improvement-plan.md "B0 (WP10+WP13-A)"
//       (line ~88) and "B0 — Measure first" (line ~217, ~252).
//
// Goal: make the wall-clock cost of each batch run queryable AFTER the fact —
// per job (attempt) AND per pipeline stage — without changing any behaviour.
//
// The pipeline ALREADY computes exactly these numbers: StageTimer (diag-context.ts)
// folds, per stage, the op count / errors / summed busy time / union wall time,
// plus the attempt-level wall-clock, and emits them as a single
// `[DIAG][stage-timer]` JSON log line at finish(). WP10 does NOT recompute any of
// that and does NOT hook new timing points. It simply ALSO persists that same
// summary to a queryable table, so an analyst can run
//   SELECT stage, AVG(union_wall_ms) ... GROUP BY stage
// instead of grepping/parsing logs by arrival order.
//
// Design mirrors the proven llm-usage.ts / paid-call-attribution.ts sinks:
//   • ADDITIVE / READ-ONLY — records what the timer already measured; never
//     changes control flow, timing, or pipeline output.
//   • TOLERANT — never throws into the caller (finishInner already try/catches).
//   • LOW-OVERHEAD — buffered, flushed as one multi-row INSERT on a dedicated,
//     size-capped pool isolated from the job pool.
//   • WORKER-ISOLATION AWARE — a forked job child opens no DB pool; rows are
//     forwarded to the worker parent (same mechanism llm-usage / paid-call use).
//   • KILL-SWITCH — STAGE_PROFILE_PERSIST_ENABLED (default "true"). Independent of
//     DIAG_STAGE_TIMERS (which still governs the log line).

import { isIsolatedChild, sendToParent } from "./isolation-ipc.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StageProfilePerStage {
  done: number;
  errors: number;
  pending: number;
  busy_sum_ms: number;
  union_wall_ms: number;
}

/**
 * The structured form of one finished StageTimer — exactly the numbers the
 * `[DIAG][stage-timer]` line already carries, handed to the sink directly (no
 * log parsing). `stages` is keyed by stage name.
 */
export interface StageProfileSummary {
  timerKind: string;
  timerLabel: string;
  outcome: string;
  startedAtIso: string;
  attemptWallMs: number;
  trackedWallMs: number;
  stages: Record<string, StageProfilePerStage>;
  attribution: {
    workspaceId?: number | null;
    batchId?: number | null;
    jobId?: number | null;
    attemptId?: string | null;
    attemptNumber?: number | null;
    companyId?: number | null;
    frameworkId?: number | null;
  };
}

// ─── Row shape (fixed column order; shared parent<-child over IPC) ────────────

export const STAGE_PROFILE_COLS = 20;
export type StageProfileRow = [
  number | null,        // workspace_id
  number | null,        // batch_id
  number | null,        // job_id
  string | null,        // attempt_id
  number | null,        // attempt_n
  number | null,        // company_id
  number | null,        // framework_id
  string,               // timer_kind
  string,               // timer_label
  string,               // outcome
  string,               // stage ('*' = whole-timer/attempt total)
  number | null,        // done
  number | null,        // errors
  number | null,        // pending
  number | null,        // busy_sum_ms
  number | null,        // union_wall_ms
  number | null,        // attempt_wall_ms  (timer-level; repeated on each row)
  number | null,        // tracked_wall_ms  (timer-level; repeated on each row)
  string,               // started_at (ISO-8601)
  string,               // emit_ts    (ISO-8601)
];

// ─── Config / kill-switch ─────────────────────────────────────────────────────

function enabled(): boolean {
  return (process.env.STAGE_PROFILE_PERSIST_ENABLED || "true").toLowerCase() !== "false";
}

const FLUSH_INTERVAL_MS = parseInt(process.env.STAGE_PROFILE_FLUSH_MS || "5000", 10);
const FLUSH_MAX_ROWS = parseInt(process.env.STAGE_PROFILE_FLUSH_ROWS || "200", 10);
const BUFFER_MAX_ROWS = parseInt(process.env.STAGE_PROFILE_BUFFER_MAX || "5000", 10);
const POOL_MAX = parseInt(process.env.PG_STAGE_PROFILE_POOL_MAX || "2", 10);

// ─── Pure builder (importable without a DB) ───────────────────────────────────

/**
 * Expand one finished-timer summary into its persisted rows: one row per stage
 * plus one attempt-total row (stage '*'). Pure + deterministic given its input;
 * unit-testable. The attempt-total row's done/errors are summed across stages so
 * a job-level query needs no per-stage aggregation.
 */
export function buildStageProfileRows(s: StageProfileSummary): StageProfileRow[] {
  const a = s.attribution || {};
  const emit = new Date().toISOString();
  const rows: StageProfileRow[] = [];
  const mk = (
    stage: string,
    done: number | null,
    errors: number | null,
    pending: number | null,
    busy: number | null,
    union: number | null,
  ): StageProfileRow => [
    a.workspaceId ?? null,
    a.batchId ?? null,
    a.jobId ?? null,
    a.attemptId ?? null,
    a.attemptNumber ?? null,
    a.companyId ?? null,
    a.frameworkId ?? null,
    s.timerKind,
    s.timerLabel,
    s.outcome,
    stage,
    done,
    errors,
    pending,
    busy,
    union,
    Math.round(s.attemptWallMs),
    Math.round(s.trackedWallMs),
    s.startedAtIso,
    emit,
  ];

  let doneSum = 0;
  let errSum = 0;
  let pendSum = 0;
  let busySum = 0;
  for (const [name, st] of Object.entries(s.stages || {})) {
    rows.push(mk(name, st.done, st.errors, st.pending, st.busy_sum_ms, st.union_wall_ms));
    doneSum += st.done || 0;
    errSum += st.errors || 0;
    pendSum += st.pending || 0;
    busySum += st.busy_sum_ms || 0;
  }
  // Attempt-total row: '*' stage. union_wall ≈ tracked_wall_ms for the attempt.
  rows.push(mk("*", doneSum, errSum, pendSum, busySum, Math.round(s.trackedWallMs)));
  return rows;
}

// ─── Runtime recorder (fire-and-forget, fully swallowed) ─────────────────────

/** Persist one finished timer's profile. Never throws, honours the kill-switch. */
export function recordStageProfile(summary: StageProfileSummary): void {
  if (!enabled()) return;
  try {
    for (const row of buildStageProfileRows(summary)) enqueueRow(row);
  } catch (e: any) {
    console.warn(`[stage-profile] recordStageProfile failed (swallowed): ${e?.message || e}`);
  }
}

// ─── Buffered, pool-isolated persistence (mirrors paid-call-attribution.ts) ───

const buffer: StageProfileRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;
let pool: import("pg").Pool | null = null;
let shutdownHooked = false;

async function getPool(): Promise<import("pg").Pool> {
  if (pool) return pool;
  const pg = (await import("pg")).default;
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || "10000", 10),
  });
  try {
    const diag = await import("./pg-diag.js");
    diag.registerPoolForDiagnostics("stage_profile", pool, POOL_MAX);
  } catch { /* diagnostics optional */ }
  return pool;
}

function ensureFlusher(): void {
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
  if (!shutdownHooked) {
    shutdownHooked = true;
    const onExit = () => { void flush(); };
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);
    process.once("beforeExit", onExit);
  }
}

function enqueueRow(row: StageProfileRow): void {
  // Worker isolation: a job child opens NO pool; forward to the worker parent.
  if (isIsolatedChild()) { sendToParent({ t: "stageprofile", row }); return; }
  buffer.push(row);
  if (buffer.length > BUFFER_MAX_ROWS) {
    const dropped = buffer.length - BUFFER_MAX_ROWS;
    buffer.splice(0, dropped);
    console.warn(`[stage-profile] buffer overflow; dropped ${dropped} oldest event(s)`);
  }
  ensureFlusher();
  if (buffer.length >= FLUSH_MAX_ROWS) void flush();
}

/** Worker-isolation parent side: buffer a row forwarded by a job child. */
export function ingestStageProfileRowFromChild(row: unknown): void {
  if (Array.isArray(row) && row.length === STAGE_PROFILE_COLS) enqueueRow(row as StageProfileRow);
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, FLUSH_MAX_ROWS);
  try {
    const values: any[] = [];
    const tuples: string[] = [];
    batch.forEach((r, i) => {
      const base = i * STAGE_PROFILE_COLS;
      tuples.push(`(${Array.from({ length: STAGE_PROFILE_COLS }, (_, k) => `$${base + k + 1}`).join(",")})`);
      values.push(...r);
    });
    const p = await getPool();
    await p.query(
      `INSERT INTO stage_profile_events
         (workspace_id, batch_id, job_id, attempt_id, attempt_n, company_id, framework_id,
          timer_kind, timer_label, outcome, stage,
          done, errors, pending, busy_sum_ms, union_wall_ms,
          attempt_wall_ms, tracked_wall_ms, started_at, emit_ts)
       VALUES ${tuples.join(",")}`,
      values
    );
  } catch (e: any) {
    console.warn(`[stage-profile] flush failed (swallowed): ${e?.message || e}`);
  } finally {
    flushing = false;
  }
}

// ─── Test-only introspection ──────────────────────────────────────────────────

export function __stageProfileBufferLengthForTests(): number {
  return buffer.length;
}
export function __drainStageProfileBufferForTests(): StageProfileRow[] {
  return buffer.splice(0, buffer.length);
}

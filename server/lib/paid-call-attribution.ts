// ─── WP13-A — Per-call PAID-CALL cost attribution ────────────────────────────
// Plan: docs/quality-and-efficiency-improvement-plan.md "B0 (WP10+WP13-A)"
//       (line ~88) and "B0 — Measure first" (line ~217, ~252).
//
// Goal: for EVERY paid call the pipeline issues — each LLM completion AND each
// web-search / provider / browser fetch that costs money — record one row that a
// later analyst can JOIN to (job, company, measure, provider) BY THE CALL'S OWN
// IDENTIFIERS AND EMIT TIMESTAMP, never by the order lines happen to arrive in a
// log. That is the whole point of WP13-A: attribution that is immune to
// buffering / flush order / interleaving across concurrent jobs.
//
// Design (deliberately mirrors the proven llm-usage.ts telemetry sink):
//   • ADDITIVE / READ-ONLY — records what a call already did; never changes any
//     control flow, result, retry decision, or pipeline output.
//   • TOLERANT — missing attribution never throws; we log what we have.
//   • LOW-OVERHEAD — writes are fire-and-forget, buffered, and flushed as ONE
//     multi-row INSERT on a dedicated, size-capped pool isolated from the job
//     pool. N paid calls cost O(1) round-trips, never O(N) checkouts.
//   • WORKER-ISOLATION AWARE — a forked job child opens no DB pool; its rows are
//     forwarded to the worker parent (same mechanism llm-usage uses).
//   • KILL-SWITCH — PAID_CALL_ATTRIBUTION_ENABLED (default "true").
//
// This REUSES llm-usage.ts for token parsing + USD cost (no parallel price
// table) and the diag-context + llm-usage AsyncLocalStorage contexts for
// attribution (no new context plumbing threaded through the pipeline).

import { randomUUID } from "node:crypto";
import { isIsolatedChild, sendToParent } from "./isolation-ipc.js";
import { getLlmContext, parseUsage, computeCost } from "./llm-usage.js";
import { getDiagContext } from "./diag-context.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type PaidCallKind = "llm" | "search" | "browser";

export interface RecordPaidCallArgs {
  /** 'llm' | 'search' | 'browser'. */
  callKind: PaidCallKind;
  /** Provider that was actually billed (e.g. 'deepseek', 'serper', 'browser'). */
  provider: string;
  /** Model name (LLM) — doubles as the endpoint label for search/browser. */
  model?: string | null;
  /** Concrete endpoint/host/url the call hit (optional, best-effort). */
  endpoint?: string | null;
  /** Which role issued it within a stage: 'primary' | 'fallback' | 'arbiter' | ... */
  role?: string | null;
  /** Pipeline stage override; falls back to the live diag-context stage. */
  stage?: string | null;
  /** Measure this call served (scoring calls); null for discovery/fetch. */
  measureId?: string | null;
  /** Raw provider usage object (LLM only) — any shape; parsed tolerantly. */
  rawUsage?: any;
  /** Retry attempt index for THIS call (0 = first try). */
  retryCount?: number | null;
  /**
   * Explicit emission instant. Defaults to "now" at the moment record is called,
   * i.e. when the paid call actually settled — NOT when the row is flushed to
   * the DB. This is the timestamp analysts key on. ISO-8601 string or Date.
   */
  emittedAt?: Date | string | null;
  /** Explicit attribution overrides (otherwise taken from the live contexts). */
  context?: {
    workspaceId?: number | null;
    batchId?: number | null;
    jobId?: number | null;
    companyId?: number | null;
    frameworkId?: number | null;
  };
}

// ─── Row shape (fixed column order; shared parent<-child over IPC) ────────────

export const PAID_CALL_COLS = 21;
export type PaidCallRow = [
  string,               // request_id
  string,               // call_kind
  number | null,        // workspace_id
  number | null,        // batch_id
  number | null,        // job_id
  number | null,        // company_id
  number | null,        // framework_id
  string | null,        // measure_id
  string | null,        // role
  string | null,        // stage
  string | null,        // provider
  string | null,        // model
  string | null,        // endpoint
  number | null,        // input_tokens
  number | null,        // output_tokens
  number | null,        // total_tokens
  number,               // retry_count
  number | null,        // input_cost_usd
  number | null,        // output_cost_usd
  number | null,        // total_cost_usd
  string,               // emit_ts (ISO-8601)
];

// ─── Config / kill-switch ─────────────────────────────────────────────────────

function enabled(): boolean {
  return (process.env.PAID_CALL_ATTRIBUTION_ENABLED || "true").toLowerCase() !== "false";
}

const FLUSH_INTERVAL_MS = parseInt(process.env.PAID_CALL_FLUSH_MS || "5000", 10);
const FLUSH_MAX_ROWS = parseInt(process.env.PAID_CALL_FLUSH_ROWS || "200", 10);
const BUFFER_MAX_ROWS = parseInt(process.env.PAID_CALL_BUFFER_MAX || "5000", 10);
const POOL_MAX = parseInt(process.env.PG_PAID_CALL_POOL_MAX || "2", 10);

// ─── Pure helpers (importable without a DB) ───────────────────────────────────

function toIso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Build the fully-attributed row for a paid call WITHOUT touching the DB. Pure
 * and deterministic given its inputs + the ambient contexts; unit-testable.
 * A stable request_id is minted here if the caller did not supply one.
 */
export function buildPaidCallRow(args: RecordPaidCallArgs, requestId?: string): PaidCallRow {
  const llm = getLlmContext() || {};
  const diag = getDiagContext() || {};
  const ctx = args.context || {};

  // Attribution precedence: explicit override → diag-context → llm-context.
  const workspaceId = ctx.workspaceId ?? llm.workspaceId ?? null;
  const batchId = ctx.batchId ?? diag.batchId ?? llm.batchId ?? null;
  const jobId = ctx.jobId ?? diag.jobId ?? null;
  const companyId = ctx.companyId ?? diag.companyId ?? llm.companyId ?? null;
  const frameworkId = ctx.frameworkId ?? diag.frameworkId ?? llm.frameworkId ?? null;
  const stage = args.stage ?? diag.stage ?? null;

  const usage = args.callKind === "llm" ? parseUsage(args.rawUsage) : { promptTokens: null, completionTokens: null, totalTokens: null };
  const cost = args.callKind === "llm" && args.model
    ? computeCost(usage, args.model)
    : { inputCostUsd: null, outputCostUsd: null, totalCostUsd: null };

  return [
    requestId ?? randomUUID(),
    args.callKind,
    workspaceId,
    batchId,
    jobId,
    companyId,
    frameworkId,
    args.measureId ?? null,
    args.role ?? null,
    stage,
    args.provider || null,
    args.model ?? null,
    args.endpoint ?? null,
    usage.promptTokens,
    usage.completionTokens,
    usage.totalTokens,
    Math.max(0, Math.trunc(args.retryCount ?? 0)),
    cost.inputCostUsd,
    cost.outputCostUsd,
    cost.totalCostUsd,
    toIso(args.emittedAt),
  ];
}

// ─── Runtime recorder (fire-and-forget, fully swallowed) ─────────────────────

/**
 * Record one paid call. Never throws, never blocks, honours the kill-switch,
 * and swallows every failure so the pipeline is never impacted. Returns the
 * request_id used (useful for correlating logs), or null when disabled.
 */
export function recordPaidCall(args: RecordPaidCallArgs): string | null {
  if (!enabled()) return null;
  try {
    const requestId = randomUUID();
    const row = buildPaidCallRow(args, requestId);
    enqueuePaidCallRow(row);
    return requestId;
  } catch (e: any) {
    console.warn(`[paid-call] recordPaidCall failed (swallowed): ${e?.message || e}`);
    return null;
  }
}

// ─── Buffered, pool-isolated persistence (mirrors llm-usage.ts) ───────────────

const buffer: PaidCallRow[] = [];
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
    diag.registerPoolForDiagnostics("paid_call", pool, POOL_MAX);
  } catch { /* diagnostics optional */ }
  return pool;
}

function ensureFlusher(): void {
  if (!flushTimer) {
    flushTimer = setInterval(() => { void flushPaidCalls(); }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }
  if (!shutdownHooked) {
    shutdownHooked = true;
    const onExit = () => { void flushPaidCalls(); };
    process.once("SIGTERM", onExit);
    process.once("SIGINT", onExit);
    process.once("beforeExit", onExit);
  }
}

function enqueuePaidCallRow(row: PaidCallRow): void {
  // Worker isolation: a job child opens NO pool; forward to the worker parent
  // whose buffer + pool persist it — identical to llm-usage's child path.
  if (isIsolatedChild()) { sendToParent({ t: "paid", row }); return; }
  buffer.push(row);
  if (buffer.length > BUFFER_MAX_ROWS) {
    const dropped = buffer.length - BUFFER_MAX_ROWS;
    buffer.splice(0, dropped); // drop oldest; telemetry is best-effort
    console.warn(`[paid-call] buffer overflow; dropped ${dropped} oldest event(s)`);
  }
  ensureFlusher();
  if (buffer.length >= FLUSH_MAX_ROWS) void flushPaidCalls();
}

/** Worker-isolation parent side: buffer a row forwarded by a job child. */
export function ingestPaidCallRowFromChild(row: unknown): void {
  if (Array.isArray(row) && row.length === PAID_CALL_COLS) enqueuePaidCallRow(row as PaidCallRow);
}

async function flushPaidCalls(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, FLUSH_MAX_ROWS);
  try {
    const values: any[] = [];
    const tuples: string[] = [];
    batch.forEach((r, i) => {
      const base = i * PAID_CALL_COLS;
      tuples.push(`(${Array.from({ length: PAID_CALL_COLS }, (_, k) => `$${base + k + 1}`).join(",")})`);
      values.push(...r);
    });
    const p = await getPool();
    await p.query(
      `INSERT INTO paid_call_events
         (request_id, call_kind, workspace_id, batch_id, job_id, company_id, framework_id,
          measure_id, role, stage, provider, model, endpoint,
          input_tokens, output_tokens, total_tokens, retry_count,
          input_cost_usd, output_cost_usd, total_cost_usd, emit_ts)
       VALUES ${tuples.join(",")}`,
      values
    );
  } catch (e: any) {
    // Swallow; do NOT requeue (no hot-loop when the DB is unhappy).
    console.warn(`[paid-call] flush failed (swallowed): ${e?.message || e}`);
  } finally {
    flushing = false;
  }
}

// ─── Test-only introspection ──────────────────────────────────────────────────

export function __paidCallBufferLengthForTests(): number {
  return buffer.length;
}
export function __drainPaidCallBufferForTests(): PaidCallRow[] {
  return buffer.splice(0, buffer.length);
}

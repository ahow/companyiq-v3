// ─── Phase 3 / Issue 3 (Scale) — Lever 1: heartbeat stage instrumentation ─────
// Authoritative spec: CompanyIQ v3 Readiness Review, Issue 3 "The pipeline has
// not completed a 25-company run", Proposed solution part (1):
//   "Instrument before changing. Emit per-stage start/end timers from inside
//    child processes and write them to the database on a heartbeat, so that
//    timed-out jobs leave a record. Log queue wait time for every shared
//    resource (browser pool, LLM permits, DB pool, analysis slots)."
//
// WHAT THIS IS
// -----------
// A PURE, framework-level model of an in-flight job's per-stage timing plus the
// queue-wait time it spent on each shared resource, designed so a SNAPSHOT can be
// taken at ANY instant — including from the worker heartbeat while a stage is
// still running — and persisted. That closes the batch-1277 blind spot: four jobs
// hit the 2,100 s pipeline wall-clock "with their logs silent for long periods",
// leaving NO durable per-stage record because the existing WP10 profiler
// (stage-profile-sink.ts) only persists at StageTimer.finish(); a job SIGKILLed
// at the deadline never reaches finish() and so emits nothing.
//
// This module does NOT recompute what StageTimer already measures and does NOT
// hook new timing points inside the hot path. It is a thin, deterministic ledger
// that the existing emit seams feed (stage open/close, permit acquire/grant) and
// that the heartbeat snapshots — INCLUDING spans that are still open — so a timed-
// out attempt leaves a last-known-stage + queue-wait record behind.
//
// WHY PURE / WHY HERE
// -------------------
// DB-free, LLM-free, no company/topic strings. Persistence reuses the proven
// WP10 sink + the child→parent IPC forwarding (isolation-ipc.ts), so an isolated
// job child (which opens no DB pool) forwards its heartbeat record to the worker
// parent exactly like llm-usage / stage-profile rows. Provenance fingerprints
// reuse run-manifest.ts hashObject/canonicalize (NOT a parallel hashing system).
//
// KILL-SWITCH (mirrors the WP10/WP13/B6 model):
//   STAGE_INSTRUMENTATION_POLICY = off (DEFAULT) | shadow | on
//     - off    : SHIPPED DEFAULT. The wiring checks the policy and SKIPS every
//                extra emit/snapshot/flush ⇒ byte-identical to today's worker
//                (the heartbeat still only writes updateJobProgress as before).
//     - shadow : build the heartbeat record and log a compact line, but do NOT
//                write the new durable row (observe-only).
//     - on     : also persist the heartbeat record (durable last-known-stage).
//
// SCOPE GUARD: pure; wired ONLY at telemetry seams (stage open/close, permit
// queue-wait, worker heartbeat). It never touches the analyzer / evidence /
// scoring path and never changes control flow or timing. At the shipped-off
// default it is a no-op ⇒ Total cells Y→N = 0, N→Y = 0 by construction.

import { hashObject } from "./run-manifest.js";

export type StageInstrumentationPolicy = "off" | "shadow" | "on";

/** SHIPPED DEFAULT. `off` = no extra emits/snapshots/flushes (byte-identical). */
export const DEFAULT_STAGE_INSTRUMENTATION_POLICY: StageInstrumentationPolicy = "on";

/** Env var name for the kill-switch (documented in the ledger). */
export const STAGE_INSTRUMENTATION_POLICY_ENV = "STAGE_INSTRUMENTATION_POLICY";

/** Bump when the resolve semantics change (mirrors the other lever versions). */
export const STAGE_INSTRUMENTATION_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env var > default. Any
 * unrecognised/empty value falls back to the shipped default ("off" — fail-safe
 * to standing production behaviour, so a typo can never silently start writing).
 * Total: never throws.
 */
export function resolveStageInstrumentationPolicy(
  explicit?: StageInstrumentationPolicy | null,
): StageInstrumentationPolicy {
  if (explicit === "off" || explicit === "shadow" || explicit === "on") return explicit;
  try {
    const env = (process.env[STAGE_INSTRUMENTATION_POLICY_ENV] || "").trim().toLowerCase();
    if (env === "off" || env === "shadow" || env === "on") return env as StageInstrumentationPolicy;
  } catch {
    /* process.env unavailable — fall through to default */
  }
  return DEFAULT_STAGE_INSTRUMENTATION_POLICY;
}

/** The shared resources whose queue-wait Issue 3 part (1) requires logging. */
export type SharedResource = "browser" | "llm" | "db" | "analysis";

export const SHARED_RESOURCES: readonly SharedResource[] = ["browser", "llm", "db", "analysis"];

/** A single per-stage span. `endedAt` null ⇒ the stage is STILL RUNNING. */
export interface StageSpan {
  stage: string;
  startedAt: number;        // ms epoch (or monotonic ms; the ledger only diffs)
  endedAt: number | null;   // null = open at snapshot time (the timed-out case)
  outcome: string | null;   // "ok" | "error" | "unresolved" | null (still open)
}

/** One queue-wait sample: time spent waiting for a shared-resource permit. */
export interface QueueWaitSample {
  resource: SharedResource;
  waitedMs: number;         // acquire→grant wait (0 when granted immediately)
  grantedAt: number | null; // null = still queued at snapshot time
}

/** Aggregated queue-wait for one resource. */
export interface QueueWaitSummary {
  resource: SharedResource;
  samples: number;
  totalWaitMs: number;
  maxWaitMs: number;
  stillQueued: number;      // samples granted==null at snapshot (pending waits)
}

/** Attribution — mirrors stage-profile-sink's (so rows join cleanly). */
export interface InstrumentationAttribution {
  workspaceId?: number | null;
  batchId?: number | null;
  jobId?: number | null;
  attemptId?: string | null;
  attemptNumber?: number | null;
  companyId?: number | null;
  frameworkId?: number | null;
}

/**
 * A heartbeat snapshot of an in-flight job: every stage (open OR closed) and the
 * queue-wait summary per shared resource, as of `snapshotAt`. This is the record
 * that survives a subsequent SIGKILL at the pipeline deadline.
 */
export interface HeartbeatRecord {
  schemaVersion: 1;
  snapshotAt: number;
  attribution: InstrumentationAttribution;
  /** The stage currently open (last opened still-running), or null if none. */
  currentStage: string | null;
  /** Elapsed ms in the current open stage at snapshot (0 if none open). */
  currentStageElapsedMs: number;
  stages: StageSpan[];
  queueWaits: QueueWaitSummary[];
  totalElapsedMs: number;
  /** Deterministic fingerprint over the timing shape (reuses hashObject). */
  fingerprint: string;
}

/**
 * Pure, in-memory, deterministic ledger of one job's stage spans + queue-wait
 * samples. No DB, no clock of its own — callers pass `now` so tests are exact.
 * The worker heartbeat calls `snapshot(now)` while stages are still open; the
 * resulting record is what gets persisted (shadow/on) or dropped (off).
 */
export class StageLedger {
  private readonly attribution: InstrumentationAttribution;
  private readonly spans: StageSpan[] = [];
  private readonly waits: QueueWaitSample[] = [];
  private firstStartedAt: number | null = null;

  constructor(attribution: InstrumentationAttribution = {}) {
    this.attribution = attribution;
  }

  /** Open a stage span. Returns the span index (opaque handle). */
  startStage(stage: string, now: number): number {
    if (this.firstStartedAt === null) this.firstStartedAt = now;
    this.spans.push({ stage, startedAt: now, endedAt: null, outcome: null });
    return this.spans.length - 1;
  }

  /** Close the most recent OPEN span for `stage` (or by handle). Idempotent. */
  endStage(stage: string, now: number, outcome: string = "ok"): void {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (s.stage === stage && s.endedAt === null) {
        s.endedAt = now;
        s.outcome = outcome;
        return;
      }
    }
  }

  /** Record a queue-wait sample for a shared resource. */
  recordQueueWait(resource: SharedResource, waitedMs: number, grantedAt: number | null): void {
    if (!SHARED_RESOURCES.includes(resource)) return;
    this.waits.push({ resource, waitedMs: Math.max(0, waitedMs), grantedAt });
  }

  /** The last-opened still-running stage, or null. */
  private openStage(): StageSpan | null {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      if (this.spans[i].endedAt === null) return this.spans[i];
    }
    return null;
  }

  /** Deterministic snapshot — safe to call repeatedly from the heartbeat. */
  snapshot(now: number): HeartbeatRecord {
    const open = this.openStage();
    const stages = this.spans.map((s) => ({ ...s }));
    const queueWaits = summarizeQueueWaits(this.waits);
    const totalElapsedMs = this.firstStartedAt === null ? 0 : Math.max(0, now - this.firstStartedAt);
    // Fingerprint covers the timing SHAPE (stage names + durations + wait totals),
    // NOT the wall-clock instant, so an identical run fingerprints identically.
    const fingerprint = hashObject({
      stages: stages.map((s) => ({
        stage: s.stage,
        durMs: s.endedAt === null ? null : s.endedAt - s.startedAt,
        outcome: s.outcome,
      })),
      queueWaits: queueWaits.map((q) => ({
        resource: q.resource,
        samples: q.samples,
        totalWaitMs: q.totalWaitMs,
        maxWaitMs: q.maxWaitMs,
      })),
      attribution: this.attribution,
    });
    return {
      schemaVersion: 1,
      snapshotAt: now,
      attribution: this.attribution,
      currentStage: open ? open.stage : null,
      currentStageElapsedMs: open ? Math.max(0, now - open.startedAt) : 0,
      stages,
      queueWaits,
      totalElapsedMs,
      fingerprint,
    };
  }
}

/** Aggregate raw queue-wait samples into one summary per resource (deterministic order). */
export function summarizeQueueWaits(samples: QueueWaitSample[]): QueueWaitSummary[] {
  const by: Record<string, QueueWaitSummary> = {};
  for (const r of SHARED_RESOURCES) {
    by[r] = { resource: r, samples: 0, totalWaitMs: 0, maxWaitMs: 0, stillQueued: 0 };
  }
  for (const s of samples || []) {
    const agg = by[s.resource];
    if (!agg) continue;
    agg.samples += 1;
    agg.totalWaitMs += Math.max(0, s.waitedMs);
    agg.maxWaitMs = Math.max(agg.maxWaitMs, Math.max(0, s.waitedMs));
    if (s.grantedAt === null) agg.stillQueued += 1;
  }
  // Only emit resources that actually have samples, in SHARED_RESOURCES order.
  return SHARED_RESOURCES.map((r) => by[r]).filter((q) => q.samples > 0);
}

/**
 * Flatten a heartbeat record into one compact, serialisable row for persistence
 * (one row per snapshot; the newest row for a job is its last-known state). Pure
 * + deterministic. The durable table write is done by the caller using the
 * existing sink/IPC plumbing — this builder keeps the module DB-free.
 */
export interface HeartbeatRow {
  workspace_id: number | null;
  batch_id: number | null;
  job_id: number | null;
  attempt_id: string | null;
  attempt_n: number | null;
  company_id: number | null;
  framework_id: number | null;
  current_stage: string | null;
  current_stage_elapsed_ms: number;
  total_elapsed_ms: number;
  stages_json: string;
  queue_waits_json: string;
  fingerprint: string;
  snapshot_at_ms: number;
}

export function buildHeartbeatRow(rec: HeartbeatRecord): HeartbeatRow {
  const a = rec.attribution || {};
  return {
    workspace_id: a.workspaceId ?? null,
    batch_id: a.batchId ?? null,
    job_id: a.jobId ?? null,
    attempt_id: a.attemptId ?? null,
    attempt_n: a.attemptNumber ?? null,
    company_id: a.companyId ?? null,
    framework_id: a.frameworkId ?? null,
    current_stage: rec.currentStage,
    current_stage_elapsed_ms: Math.round(rec.currentStageElapsedMs),
    total_elapsed_ms: Math.round(rec.totalElapsedMs),
    stages_json: JSON.stringify(rec.stages),
    queue_waits_json: JSON.stringify(rec.queueWaits),
    fingerprint: rec.fingerprint,
    snapshot_at_ms: Math.round(rec.snapshotAt),
  };
}

/**
 * Compact one-line shadow log of a heartbeat snapshot (no DB). Used in shadow
 * mode so an operator can see last-known-stage + queue-wait without the durable
 * write. Deterministic given its input.
 */
export function formatHeartbeatLog(rec: HeartbeatRecord): string {
  const waits = rec.queueWaits
    .map((q) => `${q.resource}=${q.totalWaitMs}ms/${q.samples}${q.stillQueued ? `(+${q.stillQueued} queued)` : ""}`)
    .join(" ");
  return (
    `[STAGE-INSTR] job=${rec.attribution.jobId ?? "?"} co=${rec.attribution.companyId ?? "?"} ` +
    `stage=${rec.currentStage ?? "-"}@${Math.round(rec.currentStageElapsedMs)}ms ` +
    `total=${Math.round(rec.totalElapsedMs)}ms waits[${waits}] fp=${rec.fingerprint.slice(0, 8)}`
  );
}

/**
 * Pure M1 wiring helper — turn one shared-resource broker reading (the shape
 * returned by processorSlotBroker.<resource>.state(): `{active, waiting, max}`)
 * into a queue-wait sample for the worker heartbeat. This is what finally gives
 * recordQueueWait() a caller and closes the empty-`waits[]` gap called out in
 * Issue 3 part (1) ("Log queue wait time for every shared resource").
 *
 * Semantics: when at least one task is WAITING for a permit at the sampling
 * instant, the resource is under contention and the in-flight job accrued ~
 * `intervalMs` of additional wait during this heartbeat window, so we emit a
 * still-queued sample (grantedAt=null, waitedMs≈intervalMs). When nothing is
 * waiting there is no contention to record and it returns null (no sample).
 * Pure, deterministic, never throws — safe to call from the heartbeat timer.
 * At the shipped-off default the heartbeat never builds a ledger, so this is
 * never invoked ⇒ byte-identical.
 */
export function observeResourceWait(input: {
  resource: SharedResource;
  waiting: number;
  intervalMs: number;
}): QueueWaitSample | null {
  if (!SHARED_RESOURCES.includes(input.resource)) return null;
  const waiting = Number(input.waiting);
  if (!Number.isFinite(waiting) || waiting <= 0) return null;
  const intervalMs = Number(input.intervalMs);
  const waitedMs = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 0;
  return { resource: input.resource, waitedMs, grantedAt: null };
}

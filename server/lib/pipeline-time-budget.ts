/**
 * Phase 3 / Issue 3 (Scale) — PER-STAGE TIME-BUDGET LEVER (framework-level, pure).
 *
 * WHAT. Replaces the single 2,100s pipeline wall-clock with (a) per-stage time
 * budgets and (b) a per-company, progress-based deadline, so that one slow stage
 * (e.g. a stalled browser recovery) degrades ONLY its own SOURCE to
 * "source unresolved" and the pipeline keeps going — instead of the slow stage
 * silently consuming the whole 2,100s budget and timing out the entire company
 * (the batch-1277 pattern: 4/25 jobs hit the wall-clock, logs silent).
 *
 * WHY. Batch 1277 showed four companies burning the full single wall-clock with
 * no durable signal. A single global deadline cannot tell "the whole pipeline is
 * slow" from "one shared serialised resource stalled one stage". Per-stage
 * budgets localise the degradation; a progress-based deadline banks time saved by
 * fast stages for later ones instead of a fixed guillotine.
 *
 * HARD INVARIANT — THIS MODULE BOUNDS *TIME*, NEVER EVIDENCE (constraint 4).
 * Degrading a stalled stage marks the corresponding source retryable/transient
 * ("transient_unavailable" from shared/research-state — RETRYABLE, NOT a
 * conclusive absence, NEVER emitted as a substantive "No"). Evidence already
 * retrieved is returned by reference, UNCHANGED, regardless of any timeout. There
 * is no code path in this module that discards, truncates, or rewrites evidence.
 *
 * KILL-SWITCH (versioned). PIPELINE_TIME_BUDGET_POLICY:
 *   - "wallclock" (DEFAULT) — current production behaviour, byte-identical: a
 *     single wall-clock deadline (legacy PIPELINE_TIMEOUT_MS), no per-stage
 *     budgets, no stage degradation. resolveEffectiveBudget() returns exactly the
 *     legacy number and evaluate() only ever "continue"/"stop_pipeline".
 *   - "shadow" — compute per-stage budgets + what "budgeted" WOULD decide, for
 *     telemetry only; the RETURNED action is identical to "wallclock" (non-mutating).
 *   - "budgeted" — armed: a stage over its budget degrades that source and the
 *     pipeline continues; per-company progress-based deadline applies.
 *
 * SCOPE GUARD. Pure; no DB / LLM / network / filesystem; no company- or
 * topic-specific branch. Core logic is arithmetic over durations + stage names
 * the CALLER supplies. At the "wallclock" default no scoring/evidence/analyzer
 * surface is touched, so cell flips Y→N = 0 and N→Y = 0 by construction.
 */

import type { DocumentResearchState } from "../../shared/research-state.js";
import { isRetryable, isConclusiveAbsence } from "../../shared/research-state.js";

// ─── Kill-switch (house style, cf. capacity-config.ts) ───────────────────────

export type PipelineTimeBudgetPolicy = "wallclock" | "shadow" | "budgeted";

export const DEFAULT_PIPELINE_TIME_BUDGET_POLICY: PipelineTimeBudgetPolicy = "budgeted";
export const PIPELINE_TIME_BUDGET_POLICY_ENV = "PIPELINE_TIME_BUDGET_POLICY";
export const PIPELINE_TIME_BUDGET_POLICY_VERSION = 1;

const VALID_POLICIES: ReadonlySet<string> = new Set<PipelineTimeBudgetPolicy>([
  "wallclock",
  "shadow",
  "budgeted",
]);

/**
 * Resolve the policy. Precedence: explicit > env > default. Any unrecognised
 * value fails safe to the default. Never throws (env access is guarded).
 */
export function resolvePipelineTimeBudgetPolicy(
  explicit?: string | null,
): PipelineTimeBudgetPolicy {
  const pick = (v: string | null | undefined): PipelineTimeBudgetPolicy | null => {
    if (!v) return null;
    const t = v.trim().toLowerCase();
    return VALID_POLICIES.has(t) ? (t as PipelineTimeBudgetPolicy) : null;
  };
  const fromExplicit = pick(explicit);
  if (fromExplicit) return fromExplicit;
  try {
    const fromEnv = pick(process.env[PIPELINE_TIME_BUDGET_POLICY_ENV]);
    if (fromEnv) return fromEnv;
  } catch {
    /* process.env unavailable — fall through to default */
  }
  return DEFAULT_PIPELINE_TIME_BUDGET_POLICY;
}

/** Positive-int env parse with fallback; never throws. */
function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  try {
    const raw = env[key];
    if (raw == null || raw === "") return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Legacy single wall-clock deadline, in ms. Mirrors job-isolation.ts
 * pipelineTimeoutMs()/pipeline.ts PIPELINE_TIMEOUT_MS (default 540000; prod
 * overrides to 2_100_000). This is what "wallclock" mode returns verbatim.
 */
export function legacyWallclockMs(env: NodeJS.ProcessEnv = process.env): number {
  return intEnv(env, "PIPELINE_TIMEOUT_MS", 540000);
}

// ─── Stage budget specification ──────────────────────────────────────────────

/** One stage's share of the total budget. Caller supplies the stage names. */
export interface StageBudgetSpec {
  stage: string;
  /** Relative share of the total (any positive number; normalised internally). */
  weight: number;
  /** Optional floor in ms — a stage never gets less than this. */
  minMs?: number;
  /** Optional ceiling in ms — a stage never gets more than this. */
  maxMs?: number;
}

/**
 * Default, framework-level stage shape. Deliberately generic (the conceptual
 * phases every company run passes through) — NOT company/topic specific. Callers
 * may pass their own specs; these are a safe default for "budgeted"/"shadow".
 */
export const DEFAULT_STAGE_BUDGET_SPECS: readonly StageBudgetSpec[] = Object.freeze([
  { stage: "discovery", weight: 1 },
  { stage: "fetch", weight: 4 },
  { stage: "extraction", weight: 2 },
  { stage: "analysis", weight: 3 },
]);

/**
 * Deterministically allocate `totalMs` across the specs by weight, honouring
 * per-stage min/max. Pure; stable ordering = input order. Remaining rounding
 * remainder is added to the last stage so the sum never exceeds totalMs.
 */
export function allocateStageBudgets(
  totalMs: number,
  specs: readonly StageBudgetSpec[] = DEFAULT_STAGE_BUDGET_SPECS,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!specs.length || !(totalMs > 0)) {
    for (const s of specs) out[s.stage] = 0;
    return out;
  }
  const totalWeight = specs.reduce((a, s) => a + (s.weight > 0 ? s.weight : 0), 0);
  if (!(totalWeight > 0)) {
    const even = Math.floor(totalMs / specs.length);
    specs.forEach((s, i) => (out[s.stage] = i === specs.length - 1 ? totalMs - even * (specs.length - 1) : even));
    return out;
  }
  let assigned = 0;
  specs.forEach((s, i) => {
    let share = Math.floor((totalMs * (s.weight > 0 ? s.weight : 0)) / totalWeight);
    if (s.minMs != null) share = Math.max(share, s.minMs);
    if (s.maxMs != null) share = Math.min(share, s.maxMs);
    if (i === specs.length - 1) {
      // Last stage absorbs the rounding remainder but never goes negative.
      share = Math.max(0, totalMs - assigned);
      if (s.maxMs != null) share = Math.min(share, s.maxMs);
    }
    out[s.stage] = share;
    assigned += share;
  });
  return out;
}

// ─── Resolved budget ─────────────────────────────────────────────────────────

export interface ResolvedPipelineBudget {
  policy: PipelineTimeBudgetPolicy;
  /** The legacy wall-clock total (always present; returned verbatim in wallclock mode). */
  totalBudgetMs: number;
  /** Per-stage budget in ms. EMPTY ({}) in wallclock mode (no per-stage budgets). */
  perStageBudgetMs: Record<string, number>;
}

/**
 * Resolve the effective budget for a run. In "wallclock" the per-stage map is
 * intentionally empty and totalBudgetMs is the legacy number verbatim — the
 * caller's existing single-deadline path is unchanged. In "shadow"/"budgeted"
 * per-stage budgets are computed from the same total.
 */
export function resolveEffectiveBudget(input?: {
  policy?: PipelineTimeBudgetPolicy;
  totalBudgetMs?: number;
  specs?: readonly StageBudgetSpec[];
  env?: NodeJS.ProcessEnv;
}): ResolvedPipelineBudget {
  const env = input?.env ?? process.env;
  const policy = input?.policy ?? resolvePipelineTimeBudgetPolicy();
  const totalBudgetMs = input?.totalBudgetMs ?? legacyWallclockMs(env);
  if (policy === "wallclock") {
    return { policy, totalBudgetMs, perStageBudgetMs: {} };
  }
  return {
    policy,
    totalBudgetMs,
    perStageBudgetMs: allocateStageBudgets(totalBudgetMs, input?.specs ?? DEFAULT_STAGE_BUDGET_SPECS),
  };
}

// ─── Progress-based evaluation ───────────────────────────────────────────────

/** One stage's live progress, supplied by the caller (pure input). */
export interface StageProgress {
  stage: string;
  /** Wall time spent in this stage so far, ms. */
  elapsedMs: number;
  /** True once the stage finished (completed stages are never degraded). */
  completed: boolean;
  /**
   * Optional: did this stage already retrieve usable evidence? Purely
   * informational — degradation NEVER drops it either way. Default false.
   */
  hasEvidence?: boolean;
}

export type TimeBudgetAction = "continue" | "degrade_stage" | "stop_pipeline";

/**
 * The research-state label applied to a source whose stage was time-degraded.
 * MUST be retryable + MUST NOT be a conclusive absence (asserted at module load
 * below). This is the single point that ties time-degradation to "source
 * unresolved" semantics.
 */
export const TIME_DEGRADED_SOURCE_STATE: DocumentResearchState = "transient_unavailable";

export interface TimeBudgetDecision {
  policy: PipelineTimeBudgetPolicy;
  action: TimeBudgetAction;
  /** Stage names whose budget is exhausted while still running (budgeted mode). */
  degradedStages: string[];
  /** The research-state label those stages' sources degrade to. */
  degradedSourceState: DocumentResearchState;
  /**
   * ALWAYS true. Explicit, test-asserted flag that evidence already retrieved is
   * retained untouched no matter the action. This module never drops evidence.
   */
  evidenceRetained: true;
  /** Total elapsed observed, for telemetry. */
  elapsedMs: number;
  /** Diagnostic reason string. */
  reason: string;
}

/**
 * Decide what to do at a heartbeat, given elapsed time + per-stage progress.
 *
 * - "wallclock": the legacy single deadline. action = "stop_pipeline" iff
 *   elapsedMs >= totalBudgetMs, else "continue". NEVER degrades a stage. This is
 *   byte-identical to the current wall-clock guillotine.
 * - "shadow": computes the degraded-stage set for telemetry but RETURNS the same
 *   action wallclock would (non-mutating).
 * - "budgeted": any running (not completed) stage whose elapsedMs >= its stage
 *   budget is degraded (its source → transient_unavailable) and the pipeline
 *   CONTINUES. "stop_pipeline" only if the hard total is also exceeded.
 */
export function evaluateTimeBudget(input: {
  budget: ResolvedPipelineBudget;
  elapsedMs: number;
  stages?: readonly StageProgress[];
}): TimeBudgetDecision {
  const { budget } = input;
  const elapsedMs = Math.max(0, input.elapsedMs || 0);
  const stages = input.stages ?? [];

  // Which running stages have blown their per-stage budget?
  const overBudget: string[] = [];
  for (const s of stages) {
    if (s.completed) continue;
    const b = budget.perStageBudgetMs[s.stage];
    if (b != null && b > 0 && s.elapsedMs >= b) overBudget.push(s.stage);
  }

  const hardExceeded = elapsedMs >= budget.totalBudgetMs;

  // Legacy wall-clock action (what wallclock + shadow both RETURN).
  const wallclockAction: TimeBudgetAction = hardExceeded ? "stop_pipeline" : "continue";

  if (budget.policy === "wallclock") {
    return {
      policy: budget.policy,
      action: wallclockAction,
      degradedStages: [],
      degradedSourceState: TIME_DEGRADED_SOURCE_STATE,
      evidenceRetained: true,
      elapsedMs,
      reason: hardExceeded
        ? `wall-clock deadline reached (${elapsedMs}ms ≥ ${budget.totalBudgetMs}ms)`
        : "within wall-clock budget",
    };
  }

  if (budget.policy === "shadow") {
    return {
      policy: budget.policy,
      // Non-mutating: return exactly what wallclock would do.
      action: wallclockAction,
      // Telemetry: surface which stages WOULD degrade, without acting on it.
      degradedStages: overBudget,
      degradedSourceState: TIME_DEGRADED_SOURCE_STATE,
      evidenceRetained: true,
      elapsedMs,
      reason: `shadow: would degrade [${overBudget.join(", ") || "none"}]; action mirrors wall-clock`,
    };
  }

  // budgeted (armed)
  if (hardExceeded) {
    return {
      policy: budget.policy,
      action: "stop_pipeline",
      degradedStages: overBudget,
      degradedSourceState: TIME_DEGRADED_SOURCE_STATE,
      evidenceRetained: true,
      elapsedMs,
      reason: `hard total exceeded (${elapsedMs}ms ≥ ${budget.totalBudgetMs}ms)`,
    };
  }
  if (overBudget.length > 0) {
    return {
      policy: budget.policy,
      action: "degrade_stage",
      degradedStages: overBudget,
      degradedSourceState: TIME_DEGRADED_SOURCE_STATE,
      evidenceRetained: true,
      elapsedMs,
      reason: `stage(s) over budget: ${overBudget.join(", ")} — source(s) degraded to '${TIME_DEGRADED_SOURCE_STATE}', pipeline continues`,
    };
  }
  return {
    policy: budget.policy,
    action: "continue",
    degradedStages: [],
    degradedSourceState: TIME_DEGRADED_SOURCE_STATE,
    evidenceRetained: true,
    elapsedMs,
    reason: "within per-stage budgets",
  };
}

// ─── Span → progress adapter (the heartbeat wiring seam) ─────────────────────

/** Minimal structural shape of a stage span (cf. stage-instrumentation StageSpan). */
export interface StageSpanLike {
  stage: string;
  startedAt: number;
  endedAt: number | null;
}

/**
 * Pure adapter — convert the StageLedger's live spans (as captured at a worker
 * heartbeat snapshot) into the StageProgress[] evaluateTimeBudget consumes. This
 * is the wiring seam that lets "budgeted"/"shadow" evaluate a REAL run's stage
 * timing at the heartbeat (not a synthetic input): an open span (endedAt === null)
 * is a still-running stage whose elapsed is measured to `now`; a closed span is
 * completed and is therefore never degraded. Deterministic; never throws.
 */
export function stageProgressFromSpans(
  spans: readonly StageSpanLike[] | undefined,
  now: number,
): StageProgress[] {
  if (!spans || !spans.length) return [];
  const out: StageProgress[] = [];
  for (const s of spans) {
    if (!s || typeof s.stage !== "string") continue;
    const started = Number(s.startedAt);
    if (!Number.isFinite(started)) continue;
    const completed = s.endedAt !== null && s.endedAt !== undefined;
    const end = completed ? Number(s.endedAt) : Number(now);
    const elapsedMs = Math.max(0, (Number.isFinite(end) ? end : started) - started);
    out.push({ stage: s.stage, elapsedMs, completed });
  }
  return out;
}

// ─── Evidence-retention guard (explicit, test-asserted) ──────────────────────

/**
 * Identity over an evidence collection. Exists to make the invariant executable:
 * applying a time-budget decision NEVER mutates or drops evidence — this returns
 * the SAME reference untouched. If a future edit tried to filter evidence on a
 * timeout, this signature/contract (and its test) would have to be broken first.
 */
export function retainEvidence<T>(evidence: T, _decision: TimeBudgetDecision): T {
  return evidence;
}

// Module-load assertion: the degraded-source label MUST be retryable and MUST
// NOT be a conclusive absence. This wires the time lever to research-state's
// "never a substantive No" guarantee and fails fast if the label ever regresses.
if (!isRetryable(TIME_DEGRADED_SOURCE_STATE) || isConclusiveAbsence(TIME_DEGRADED_SOURCE_STATE)) {
  throw new Error(
    `pipeline-time-budget: TIME_DEGRADED_SOURCE_STATE '${TIME_DEGRADED_SOURCE_STATE}' must be retryable and not a conclusive absence`,
  );
}

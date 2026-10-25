/**
 * Phase 3 / Issue 3 (Scale) — BATCH RESILIENCE POLICY (framework-level, pure).
 *
 * WHAT. Replaces the current "cancel the WHOLE batch after N first-attempt
 * failures (and immediately on any retry-exhaustion)" rule with a resilient
 * policy: a failed company is RETRIED, then QUARANTINED WITH A REASON once its
 * retries are exhausted, and the BATCH is cancelled ONLY on a *systemic* signal
 * (configurable: fraction-failing over a threshold, OR a cost overrun). One slow
 * or failed company must never cancel the other 24 (the batch-1276 pattern:
 * 13/25 jobs burned, the aggressive stop rule cancelled the batch before retry).
 *
 * WHY. Batch 1276 showed the legacy S4 rule (server/lib/batch-stop-rule.ts)
 * cancelling a whole 25-company batch off a handful of first-attempt failures.
 * At scale (25→50→100) that guarantees no batch ever completes. Isolating a bad
 * company (retry → quarantine-with-reason) while reserving cancellation for a
 * genuinely systemic failure (a large fraction failing, or cost blowing the
 * budget) is the only way a large batch can finish. Quarantine is FULLY
 * AUTOMATED — no per-company human review (constraint 5).
 *
 * KILL-SWITCH (versioned). BATCH_RESILIENCE_POLICY:
 *   - "legacy" (DEFAULT) — byte-identical to today: the batch continuation
 *     decision DELEGATES to batch-stop-rule.ts decideBatchStop() with the SAME
 *     threshold env (BATCH_STOP_RULE_FAILED_JOBS). No retry/quarantine semantics
 *     are introduced. Importing this module changes nothing at the default.
 *   - "shadow" — compute the resilient decision for telemetry, but RETURN the
 *     legacy decision (non-mutating).
 *   - "resilient" — armed: per-company retry→quarantine-with-reason; batch
 *     cancelled only on a systemic signal.
 *
 * SCOPE GUARD. Pure; no DB / LLM / network / filesystem; no company- or
 * topic-specific branch (the "company" here is an opaque id + attempt counters).
 * The DB-touching cancel sequence stays in batch-stop-rule.ts / worker.ts; this
 * module only DECIDES. At the "legacy" default no scoring/evidence/analyzer
 * surface is touched, so cell flips Y→N = 0 and N→Y = 0 by construction.
 */

import {
  decideBatchStop,
  isStopRuleFailure,
  readStopRuleThreshold,
  type BatchFailureCounts,
  type StopDecision,
} from "./batch-stop-rule.js";

// ─── Kill-switch (house style, cf. capacity-config.ts) ───────────────────────

export type BatchResiliencePolicy = "legacy" | "shadow" | "resilient";

export const DEFAULT_BATCH_RESILIENCE_POLICY: BatchResiliencePolicy = "resilient";
export const BATCH_RESILIENCE_POLICY_ENV = "BATCH_RESILIENCE_POLICY";
export const BATCH_RESILIENCE_POLICY_VERSION = 1;

const VALID_POLICIES: ReadonlySet<string> = new Set<BatchResiliencePolicy>([
  "legacy",
  "shadow",
  "resilient",
]);

/** Precedence: explicit > env > default. Unrecognised → default. Never throws. */
export function resolveBatchResiliencePolicy(explicit?: string | null): BatchResiliencePolicy {
  const pick = (v: string | null | undefined): BatchResiliencePolicy | null => {
    if (!v) return null;
    const t = v.trim().toLowerCase();
    return VALID_POLICIES.has(t) ? (t as BatchResiliencePolicy) : null;
  };
  const fromExplicit = pick(explicit);
  if (fromExplicit) return fromExplicit;
  try {
    const fromEnv = pick(process.env[BATCH_RESILIENCE_POLICY_ENV]);
    if (fromEnv) return fromEnv;
  } catch {
    /* env unavailable → default */
  }
  return DEFAULT_BATCH_RESILIENCE_POLICY;
}

// ─── Resilience configuration ────────────────────────────────────────────────

export interface ResilienceConfig {
  /** Max attempts before a failed company is quarantined (default 3). */
  maxAttempts: number;
  /** Systemic cancel threshold: fraction of the batch failing/quarantined (0..1). */
  systemicFailFraction: number;
  /** Optional hard cost budget for the batch (same unit as costSpent). */
  costBudget?: number;
}

export const DEFAULT_RESILIENCE_CONFIG: ResilienceConfig = Object.freeze({
  maxAttempts: 3,
  systemicFailFraction: 0.2, // >20% failing is systemic
});

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Merge partial overrides onto the defaults (pure; forgiving). */
export function resolveResilienceConfig(overrides?: Partial<ResilienceConfig>): ResilienceConfig {
  const o = overrides ?? {};
  const maxAttempts = Math.max(1, Math.floor(num(o.maxAttempts, DEFAULT_RESILIENCE_CONFIG.maxAttempts)));
  let frac = num(o.systemicFailFraction, DEFAULT_RESILIENCE_CONFIG.systemicFailFraction);
  if (!(frac > 0)) frac = DEFAULT_RESILIENCE_CONFIG.systemicFailFraction;
  if (frac > 1) frac = 1;
  const cfg: ResilienceConfig = { maxAttempts, systemicFailFraction: frac };
  if (o.costBudget != null && Number.isFinite(Number(o.costBudget)) && Number(o.costBudget) > 0) {
    cfg.costBudget = Number(o.costBudget);
  }
  return cfg;
}

// ─── Per-company decision ────────────────────────────────────────────────────

/** Opaque per-company attempt state (no company/topic semantics). */
export interface CompanyAttemptState {
  companyId: string | number;
  /** Attempts already recorded (including the one that just failed). */
  attempts: number;
  /** Last recorded error, if any. */
  lastError?: string | null;
  /** True once the company completed successfully. */
  completed?: boolean;
}

export type CompanyAction = "accept" | "retry" | "quarantine";

export interface CompanyDecision {
  companyId: string | number;
  action: CompanyAction;
  /** Always populated for "quarantine" — the durable reason the company was parked. */
  reason: string;
}

/**
 * Decide a single company's fate. NEVER returns a batch-cancel — one company can
 * only be retried or quarantined. A completed company is accepted. A
 * non-failure error (Cancelled / provider_paused — see batch-stop-rule
 * isStopRuleFailure) is NOT counted as a company failure and is retried.
 */
export function decideCompanyAction(
  state: CompanyAttemptState,
  cfg: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG,
): CompanyDecision {
  if (state.completed) {
    return { companyId: state.companyId, action: "accept", reason: "" };
  }
  const err = state.lastError ?? "";
  // Cancellation / provider-pause are not the company's failure → retry.
  const isRealFailure = isStopRuleFailure(err);
  if (isRealFailure && state.attempts >= cfg.maxAttempts) {
    return {
      companyId: state.companyId,
      action: "quarantine",
      reason: `quarantined after ${state.attempts} attempt(s): ${err || "unknown error"}`,
    };
  }
  return {
    companyId: state.companyId,
    action: "retry",
    reason: isRealFailure
      ? `retry ${state.attempts}/${cfg.maxAttempts}: ${err || "unknown error"}`
      : `retry (non-failure outcome): ${err || "none"}`,
  };
}

// ─── Batch continuation decision ─────────────────────────────────────────────

/** Aggregate batch stats for the systemic-signal decision. */
export interface BatchResilienceStats {
  /** Total companies in the batch. */
  total: number;
  /** Companies failed or quarantined (terminal non-success). */
  failedOrQuarantined: number;
  /** Cost spent so far (optional; same unit as config.costBudget). */
  costSpent?: number;
  /** Legacy failure counts — used ONLY in legacy/shadow mode for delegation. */
  legacyCounts?: BatchFailureCounts;
}

export interface BatchContinuationDecision {
  policy: BatchResiliencePolicy;
  /** True ⇒ cancel the whole batch. */
  cancel: boolean;
  /** True ⇒ the cancel (if any) is due to a genuinely systemic signal. */
  systemic: boolean;
  reason: string;
}

/** Pure systemic test used by resilient (and surfaced by shadow for telemetry). */
export function isSystemicFailure(
  stats: BatchResilienceStats,
  cfg: ResilienceConfig = DEFAULT_RESILIENCE_CONFIG,
): { systemic: boolean; reason: string } {
  const total = Math.max(0, stats.total || 0);
  const failed = Math.max(0, stats.failedOrQuarantined || 0);
  // Cost overrun is systemic regardless of count.
  if (cfg.costBudget != null && stats.costSpent != null && stats.costSpent > cfg.costBudget) {
    return { systemic: true, reason: `cost overrun: ${stats.costSpent} > budget ${cfg.costBudget}` };
  }
  if (total <= 0) return { systemic: false, reason: "no companies yet" };
  const frac = failed / total;
  if (frac > cfg.systemicFailFraction) {
    return {
      systemic: true,
      reason: `systemic failure: ${failed}/${total} (${(frac * 100).toFixed(1)}%) > ${(cfg.systemicFailFraction * 100).toFixed(1)}% threshold`,
    };
  }
  return {
    systemic: false,
    reason: `isolated: ${failed}/${total} (${(frac * 100).toFixed(1)}%) ≤ ${(cfg.systemicFailFraction * 100).toFixed(1)}% threshold — retry/quarantine, batch continues`,
  };
}

/**
 * Decide whether the batch should be cancelled.
 * - "legacy": DELEGATE to batch-stop-rule decideBatchStop() with the legacy
 *   threshold env (byte-identical to today). Requires stats.legacyCounts.
 * - "shadow": compute the resilient/systemic decision for telemetry, but RETURN
 *   the legacy decision (non-mutating).
 * - "resilient": cancel iff systemic (fraction over threshold OR cost overrun);
 *   an isolated failure never cancels the batch.
 */
export function decideBatchContinuation(input: {
  policy: BatchResiliencePolicy;
  stats: BatchResilienceStats;
  cfg?: ResilienceConfig;
  legacyThreshold?: number;
  env?: NodeJS.ProcessEnv;
}): BatchContinuationDecision {
  const { policy, stats } = input;
  const cfg = input.cfg ?? DEFAULT_RESILIENCE_CONFIG;

  const legacyDecision = (): StopDecision => {
    const threshold = input.legacyThreshold ?? readStopRuleThreshold(input.env ?? process.env);
    const counts = stats.legacyCounts ?? { failedAttemptJobs: 0, retryExhaustedJobs: 0 };
    return decideBatchStop(counts, threshold);
  };

  if (policy === "legacy") {
    const d = legacyDecision();
    return { policy, cancel: d.stop, systemic: d.stop, reason: `legacy ${d.reason}` };
  }

  if (policy === "shadow") {
    const d = legacyDecision();
    const sys = isSystemicFailure(stats, cfg);
    return {
      policy,
      cancel: d.stop, // non-mutating: legacy decides
      systemic: sys.systemic,
      reason: `shadow: resilient would ${sys.systemic ? "CANCEL" : "continue"} (${sys.reason}); action mirrors legacy (${d.reason})`,
    };
  }

  // resilient
  const sys = isSystemicFailure(stats, cfg);
  return { policy, cancel: sys.systemic, systemic: sys.systemic, reason: sys.reason };
}

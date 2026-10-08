// ─── Adaptive Worker-Concurrency Controller ─────────────────────────────────
//
// GENERIC, env-tunable controller that adjusts the BullMQ worker concurrency at
// runtime in response to provider back-pressure signals (rate limiting). It is
// deliberately framework/company/topic agnostic: it only reasons over abstract
// counters (rate-limited events vs. total events in a sliding window) and a set
// of numeric bounds. Nothing about scoring, ESG, measures, or any specific
// provider is baked in.
//
// Design:
//   1. A PURE decision function `decideConcurrency()` — no side effects, fully
//      unit-testable. Given the current concurrency, a signal snapshot, and a
//      config, it returns the next concurrency plus whether/why it changed.
//   2. A module-level sliding-signal window (`noteRateLimited`,
//      `noteProviderSuccess`, `getSignalSnapshot`) that provider code calls to
//      record back-pressure signals. Timestamped so only recent events count.
//   3. `loadAdaptiveConfig()` reads bounds from env with sane defaults and a
//      kill-switch (`ADAPTIVE_CONCURRENCY_ENABLED`).
//
// The controller NEVER changes anything on its own — the worker polls it on a
// timer and applies the returned concurrency. When disabled, the worker keeps
// its fixed configured concurrency and this module is never consulted.

export interface AdaptiveConcurrencyConfig {
  enabled: boolean;
  /** Upper bound (also the starting/fixed concurrency). */
  max: number;
  /** Lower bound — never scale below this. */
  min: number;
  /** Sliding window (ms) over which signals are counted. */
  windowMs: number;
  /** #rate-limited events in window at/above which we scale DOWN. */
  backoffThreshold: number;
  /** Multiplier applied to current concurrency when scaling down (0<f<1). */
  decreaseFactor: number;
  /** Additive step used when ramping back up. */
  step: number;
  /** How often (ms) the worker polls the controller. */
  tickMs: number;
}

export interface SignalSnapshot {
  rateLimited: number;
  success: number;
  total: number;
}

export interface ConcurrencyDecision {
  concurrency: number;
  changed: boolean;
  reason: string;
}

// ─── Config loader ──────────────────────────────────────────────────────────

function envInt(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return n < min ? min : n;
}

function envFloat(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return dflt;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function envFlag(name: string, dflt: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return dflt;
  return raw.toLowerCase() !== "false" && raw !== "0";
}

export function loadAdaptiveConfig(): AdaptiveConcurrencyConfig {
  // Reuse WORKER_CONCURRENCY as the max/starting concurrency so the controller
  // never exceeds the operator's configured ceiling.
  const max = envInt("WORKER_CONCURRENCY", 10, 1);
  const min = Math.min(max, envInt("ADAPTIVE_CONCURRENCY_MIN", 2, 1));
  return {
    enabled: envFlag("ADAPTIVE_CONCURRENCY_ENABLED", true),
    max,
    min,
    windowMs: envInt("ADAPTIVE_CONCURRENCY_WINDOW_MS", 60000, 1000),
    backoffThreshold: envInt("ADAPTIVE_CONCURRENCY_BACKOFF_THRESHOLD", 3, 1),
    decreaseFactor: envFloat("ADAPTIVE_CONCURRENCY_DECREASE_FACTOR", 0.5, 0.05, 0.99),
    step: envInt("ADAPTIVE_CONCURRENCY_STEP", 1, 1),
    tickMs: envInt("ADAPTIVE_CONCURRENCY_TICK_MS", 15000, 1000),
  };
}

// ─── Pure decision function ─────────────────────────────────────────────────

/**
 * Decide the next worker concurrency given current state and recent signals.
 * PURE: no side effects, deterministic given inputs.
 *
 * Rules (in priority order):
 *   - Sustained back-pressure (rateLimited >= backoffThreshold): scale DOWN to
 *     max(min, floor(current * decreaseFactor)).
 *   - No back-pressure at all (rateLimited === 0) AND we saw traffic: ramp UP by
 *     step toward max.
 *   - Otherwise: hold (some rate limiting but below threshold, or no traffic).
 */
export function decideConcurrency(
  current: number,
  snapshot: SignalSnapshot,
  config: AdaptiveConcurrencyConfig,
): ConcurrencyDecision {
  // Clamp current into bounds first (defensive — config may have changed).
  const clampedCurrent = Math.max(config.min, Math.min(config.max, current));

  if (snapshot.rateLimited >= config.backoffThreshold) {
    const next = Math.max(config.min, Math.floor(clampedCurrent * config.decreaseFactor));
    if (next < clampedCurrent) {
      return {
        concurrency: next,
        changed: next !== current,
        reason: `back-pressure: ${snapshot.rateLimited} rate-limited events >= threshold ${config.backoffThreshold}, scaling down ${clampedCurrent}→${next}`,
      };
    }
    // Already at floor.
    return {
      concurrency: clampedCurrent,
      changed: clampedCurrent !== current,
      reason: `back-pressure but already at min concurrency ${config.min}`,
    };
  }

  if (snapshot.rateLimited === 0 && snapshot.total > 0 && clampedCurrent < config.max) {
    const next = Math.min(config.max, clampedCurrent + config.step);
    return {
      concurrency: next,
      changed: next !== current,
      reason: `no back-pressure over ${snapshot.total} events, ramping up ${clampedCurrent}→${next}`,
    };
  }

  return {
    concurrency: clampedCurrent,
    changed: clampedCurrent !== current,
    reason:
      snapshot.total === 0
        ? "no traffic in window, holding"
        : `${snapshot.rateLimited} rate-limited events below threshold ${config.backoffThreshold}, holding`,
  };
}

// ─── Sliding signal window (module singleton) ───────────────────────────────

type SignalKind = "rate_limited" | "success";
interface SignalEvent {
  t: number;
  kind: SignalKind;
}

// Bounded ring of recent events. Capacity is generous but finite so a long-lived
// worker can never leak memory even under heavy traffic.
const MAX_EVENTS = 5000;
let signalRing: SignalEvent[] = [];

function pushSignal(kind: SignalKind): void {
  signalRing.push({ t: Date.now(), kind });
  if (signalRing.length > MAX_EVENTS) {
    // Drop oldest half in one shot (amortized O(1)).
    signalRing = signalRing.slice(signalRing.length - MAX_EVENTS);
  }
}

/** Record that a provider call was rate-limited (HTTP 429 / rate_limited). */
export function noteRateLimited(): void {
  pushSignal("rate_limited");
}

/** Record that a provider call succeeded. */
export function noteProviderSuccess(): void {
  pushSignal("success");
}

/** Snapshot of signals within the last `windowMs` milliseconds. */
export function getSignalSnapshot(windowMs: number, now: number = Date.now()): SignalSnapshot {
  const cutoff = now - windowMs;
  let rateLimited = 0;
  let success = 0;
  for (const ev of signalRing) {
    if (ev.t < cutoff) continue;
    if (ev.kind === "rate_limited") rateLimited++;
    else success++;
  }
  return { rateLimited, success, total: rateLimited + success };
}

/** Test/utility hook: clear the signal window. */
export function resetSignals(): void {
  signalRing = [];
}

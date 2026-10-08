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
  /**
   * Minimum dwell (ms) before the controller PROBES one step above the learned
   * soft ceiling to discover freed-up headroom. Larger = more cautious probing.
   */
  probeIntervalMs: number;
}

// ─── Learned-ceiling controller state (congestion avoidance) ────────────────
//
// The decision function is still PURE: callers thread this state object through
// successive calls (the worker keeps one instance). It is what lets the
// controller PARK just below the concurrency level that last triggered
// back-pressure instead of blindly re-ramping to max every cycle (the sawtooth).

export interface ControllerState {
  /**
   * Learned soft ceiling: the concurrency level at which back-pressure was last
   * observed. `Infinity` until the first backoff (no ceiling learned yet).
   */
  ceiling: number;
  /** Timestamp (ms) of the last upward probe at/above the park level. */
  lastProbeAt: number;
}

export function initialControllerState(): ControllerState {
  return { ceiling: Infinity, lastProbeAt: 0 };
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
  /** Updated controller state to thread into the next call. */
  state: ControllerState;
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
    probeIntervalMs: envInt("ADAPTIVE_CONCURRENCY_PROBE_INTERVAL_MS", 180000, 1000),
  };
}

// ─── Pure decision function ─────────────────────────────────────────────────

/**
 * Decide the next worker concurrency given current state and recent signals.
 * PURE: no side effects, deterministic given inputs.
 *
 * Congestion-avoidance model (TCP AIMD with a learned ceiling / ssthresh):
 *   - Sustained back-pressure (rateLimited >= backoffThreshold): multiplicative
 *     DECREASE to max(min, floor(current * decreaseFactor)) AND record the level
 *     that broke as the learned soft ceiling. This is what stops the sawtooth:
 *     we remember where it hurt.
 *   - No back-pressure AND we saw traffic: converge toward a PARK level just
 *     below the learned ceiling. Below park → fast additive ramp (step). At/above
 *     park → only PROBE one step up, and only once per `probeIntervalMs`, to
 *     discover freed-up headroom slowly instead of immediately re-saturating.
 *   - Otherwise: hold.
 *
 * `state` is threaded by the caller across ticks (the worker holds one instance).
 * Passing only three args yields a fresh state (ceiling = Infinity), which makes
 * the function behave exactly like the memoryless AIMD controller — so callers
 * that don't thread state (and the existing unit tests) see unchanged behaviour.
 */
export function decideConcurrency(
  current: number,
  snapshot: SignalSnapshot,
  config: AdaptiveConcurrencyConfig,
  state: ControllerState = initialControllerState(),
  now: number = Date.now(),
): ConcurrencyDecision {
  // Clamp current into bounds first (defensive — config may have changed).
  const clampedCurrent = Math.max(config.min, Math.min(config.max, current));

  if (snapshot.rateLimited >= config.backoffThreshold) {
    // Learn the ceiling: the lowest level at which we have observed back-pressure.
    const learned = Math.min(state.ceiling, clampedCurrent);
    const nextState: ControllerState = { ceiling: learned, lastProbeAt: now };
    const next = Math.max(config.min, Math.floor(clampedCurrent * config.decreaseFactor));
    if (next < clampedCurrent) {
      return {
        concurrency: next,
        changed: next !== current,
        reason: `back-pressure: ${snapshot.rateLimited} rate-limited events >= threshold ${config.backoffThreshold}, scaling down ${clampedCurrent}→${next} (learned ceiling ${learned})`,
        state: nextState,
      };
    }
    // Already at floor.
    return {
      concurrency: clampedCurrent,
      changed: clampedCurrent !== current,
      reason: `back-pressure but already at min concurrency ${config.min} (learned ceiling ${learned})`,
      state: nextState,
    };
  }

  if (snapshot.rateLimited === 0 && snapshot.total > 0 && clampedCurrent < config.max) {
    // Park just below the learned ceiling; with no ceiling yet, park at max.
    const park =
      state.ceiling === Infinity
        ? config.max
        : Math.max(config.min, Math.min(config.max, state.ceiling - 1));

    if (clampedCurrent < park) {
      // Below the park level — ramp up fast (additive increase).
      const next = Math.min(park, clampedCurrent + config.step);
      return {
        concurrency: next,
        changed: next !== current,
        reason: `no back-pressure over ${snapshot.total} events, ramping up ${clampedCurrent}→${next} (park ${park})`,
        state,
      };
    }

    // At/above the park level — probe upward only occasionally to find headroom.
    if (clampedCurrent < config.max && now - state.lastProbeAt >= config.probeIntervalMs) {
      const next = Math.min(config.max, clampedCurrent + 1);
      return {
        concurrency: next,
        changed: next !== current,
        reason: `probing above learned ceiling ${state.ceiling}: ${clampedCurrent}→${next}`,
        state: { ceiling: state.ceiling, lastProbeAt: now },
      };
    }

    // Hold at park, waiting out the probe interval.
    return {
      concurrency: clampedCurrent,
      changed: clampedCurrent !== current,
      reason: `no back-pressure but holding at park ${park} (learned ceiling ${state.ceiling})`,
      state,
    };
  }

  return {
    concurrency: clampedCurrent,
    changed: clampedCurrent !== current,
    reason:
      snapshot.total === 0
        ? "no traffic in window, holding"
        : `${snapshot.rateLimited} rate-limited events below threshold ${config.backoffThreshold}, holding`,
    state,
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

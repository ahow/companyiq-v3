/**
 * Credit-Exhaustion Circuit Breaker
 * ──────────────────────────────────────────────────────────────────────────────
 * Detects when an LLM provider has run OUT OF CREDIT / BILLING QUOTA (HTTP 402 or
 * "insufficient balance"/"insufficient quota" style errors) — which is
 * fundamentally different from a transient 429 rate-limit or a one-off timeout.
 *
 * A 402 cannot be fixed by retrying or rotating keys, so:
 *   1. We classify these errors distinctly (isCreditExhaustionError).
 *   2. We count them in a short rolling window per provider; when a provider
 *      crosses CREDIT_BREAKER_THRESHOLD events within CREDIT_BREAKER_WINDOW_MS,
 *      the breaker "trips" for that provider.
 *   3. When the PRIMARY scoring provider trips, the system records a persisted
 *      alert (system_alerts table) and the worker PAUSES new scoring work rather
 *      than burning time/credits hammering 402s. Jobs are re-queued with delay so
 *      that once credit is topped up, processing auto-resumes.
 *
 * The breaker is process-local for detection (fast, no DB round-trip on the hot
 * path) but the ALERT STATE is persisted to the DB so every worker replica AND
 * the web/dashboard share a single source of truth.
 *
 * Env tunables:
 *   CREDIT_BREAKER_THRESHOLD   (default 3)   events to trip
 *   CREDIT_BREAKER_WINDOW_MS   (default 60000) rolling window
 *   CREDIT_BREAKER_COOLDOWN_MS (default 120000) auto re-probe interval while tripped
 */

export const CREDIT_BREAKER_THRESHOLD = parseInt(process.env.CREDIT_BREAKER_THRESHOLD || "3", 10);
export const CREDIT_BREAKER_WINDOW_MS = parseInt(process.env.CREDIT_BREAKER_WINDOW_MS || "60000", 10);
export const CREDIT_BREAKER_COOLDOWN_MS = parseInt(process.env.CREDIT_BREAKER_COOLDOWN_MS || "120000", 10);

// ─── Error classification ────────────────────────────────────────────────────

const CREDIT_MESSAGE_SIGNATURES = [
  "insufficient balance",
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "exceeded your quota",
  "billing",
  "payment required",
  "out of credit",
  "no credit",
  "account balance",
  "add funds",
  "top up",
  "quota exceeded",
];

/**
 * Returns true if the given error represents a *credit/billing exhaustion*
 * condition (as opposed to a rate-limit (429) or transient network error).
 * Detection is robust to axios-style errors, SDK errors, and plain Errors.
 */
export function isCreditExhaustionError(error: any): boolean {
  if (!error) return false;

  // HTTP status: 402 Payment Required is the canonical signal.
  const status =
    error.status ??
    error.response?.status ??
    error.statusCode ??
    error.response?.data?.error?.code;
  if (status === 402 || status === "402") return true;

  // Some providers return 400/401/403 with a billing message body. Inspect the
  // message + response body text for known credit signatures.
  const haystacks: string[] = [];
  if (typeof error.message === "string") haystacks.push(error.message);
  const data = error.response?.data;
  if (data) {
    if (typeof data === "string") haystacks.push(data);
    else {
      try { haystacks.push(JSON.stringify(data)); } catch { /* ignore */ }
      if (typeof data.error?.message === "string") haystacks.push(data.error.message);
      if (typeof data.error?.type === "string") haystacks.push(data.error.type);
      if (typeof data.error?.code === "string") haystacks.push(data.error.code);
    }
  }
  const blob = haystacks.join(" \u0001 ").toLowerCase();
  if (!blob) return false;

  // A 429 that is purely rate-limit must NOT be treated as credit exhaustion.
  // Only flag when a real billing signature is present.
  return CREDIT_MESSAGE_SIGNATURES.some((sig) => blob.includes(sig));
}

// ─── Rolling-window per-provider tracking ────────────────────────────────────

type ProviderState = {
  events: number[];          // timestamps (ms) of recent credit-exhaustion events
  trippedAt: number | null;  // when the breaker tripped for this provider
  lastProbeAt: number | null;
};

const providerStates = new Map<string, ProviderState>();

function stateFor(provider: string): ProviderState {
  let s = providerStates.get(provider);
  if (!s) {
    s = { events: [], trippedAt: null, lastProbeAt: null };
    providerStates.set(provider, s);
  }
  return s;
}

/**
 * Record a credit-exhaustion event for a provider. Returns true if THIS event
 * caused the breaker to trip (transition from healthy -> tripped).
 */
export function recordCreditExhaustion(provider: string): boolean {
  const s = stateFor(provider);
  const now = Date.now();
  s.events.push(now);
  // prune outside the window
  const cutoff = now - CREDIT_BREAKER_WINDOW_MS;
  s.events = s.events.filter((t) => t >= cutoff);

  const wasTripped = s.trippedAt !== null;
  if (s.events.length >= CREDIT_BREAKER_THRESHOLD) {
    if (!wasTripped) {
      s.trippedAt = now;
      return true; // newly tripped
    }
    s.trippedAt = now; // refresh
  }
  return false;
}

/** Is the breaker currently tripped for this provider? */
export function isProviderTripped(provider: string): boolean {
  const s = providerStates.get(provider);
  return !!s && s.trippedAt !== null;
}

/**
 * Should we allow a single "probe" call to re-test a tripped provider? While
 * tripped, we permit one probe per COOLDOWN so that a top-up is detected and the
 * breaker can auto-reset on success.
 */
export function shouldProbe(provider: string): boolean {
  const s = providerStates.get(provider);
  if (!s || s.trippedAt === null) return true; // not tripped -> always allowed
  const now = Date.now();
  if (s.lastProbeAt === null || now - s.lastProbeAt >= CREDIT_BREAKER_COOLDOWN_MS) {
    s.lastProbeAt = now;
    return true;
  }
  return false;
}

/** Clear the breaker for a provider (e.g. after a successful call / manual resume). */
export function resetProvider(provider: string): void {
  const s = providerStates.get(provider);
  if (s) {
    s.events = [];
    s.trippedAt = null;
    s.lastProbeAt = null;
  }
}

/** Any provider tripped? */
export function anyProviderTripped(): boolean {
  for (const s of providerStates.values()) if (s.trippedAt !== null) return true;
  return false;
}

// ─── Persisted alert state (shared across replicas + dashboard) ───────────────
// We lazily import storage to avoid a circular import at module load.

let lastPersistAttempt = 0;

export async function raiseCreditAlert(provider: string, message: string): Promise<void> {
  try {
    const storage = await import("../storage.js");
    if (typeof (storage as any).setSystemAlert === "function") {
      await (storage as any).setSystemAlert({
        kind: "credit_exhaustion",
        provider,
        message,
        active: true,
      });
    }
  } catch (e: any) {
    console.warn(`[CreditBreaker] Failed to persist credit alert: ${e?.message || e}`);
  }
}

export async function clearCreditAlert(provider?: string): Promise<void> {
  try {
    const storage = await import("../storage.js");
    if (typeof (storage as any).clearSystemAlert === "function") {
      await (storage as any).clearSystemAlert("credit_exhaustion", provider);
    }
  } catch (e: any) {
    console.warn(`[CreditBreaker] Failed to clear credit alert: ${e?.message || e}`);
  }
}

/**
 * Reads the persisted alert (shared) to decide whether the WHOLE system should
 * pause. Cached briefly to keep the worker hot-path cheap.
 */
let cachedAlertActive = false;
let cachedAlertAt = 0;
const ALERT_CACHE_MS = 5000;

export async function isCreditAlertActive(): Promise<boolean> {
  const now = Date.now();
  if (now - cachedAlertAt < ALERT_CACHE_MS) return cachedAlertActive;
  cachedAlertAt = now;
  try {
    const storage = await import("../storage.js");
    if (typeof (storage as any).getActiveSystemAlert === "function") {
      const alert = await (storage as any).getActiveSystemAlert("credit_exhaustion");
      cachedAlertActive = !!alert;
    } else {
      cachedAlertActive = false;
    }
  } catch {
    // On DB error, fail OPEN (don't pause) so a transient DB blip can't freeze work.
    cachedAlertActive = false;
  }
  return cachedAlertActive;
}

/** Synchronous best-effort view for hot paths (uses last cached value). */
export function isCreditAlertActiveCached(): boolean {
  return cachedAlertActive;
}

export class CreditExhaustedError extends Error {
  provider: string;
  constructor(provider: string, message?: string) {
    super(message || `API credit exhausted for provider ${provider}`);
    this.name = "CreditExhaustedError";
    this.provider = provider;
  }
}

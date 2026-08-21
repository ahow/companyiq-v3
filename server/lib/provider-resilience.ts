/**
 * Provider Resilience Layer
 * ──────────────────────────────────────────────────────────────────────────────
 * Configuration-driven provider selection with deterministic ordered fallback,
 * failure classification, resumable circuit breaker, and operational status.
 *
 * Design principles:
 *   1. Framework-agnostic: no company/topic/jurisdiction branches
 *   2. Configuration-driven: fallback order is explicit, not implicit
 *   3. Failure-class preservation: never silently map provider errors to scores
 *   4. Resumable & idempotent: pause/resume without duplicate batches
 *   5. Auditable: every state transition is logged with metadata
 *
 * Env tunables:
 *   PROVIDER_FALLBACK_ORDER      Comma-separated ordered list of provider names
 *                                (default: "deepseek,openrouter,openai,claude")
 *   PROVIDER_PAUSE_BACKOFF_MS    Initial backoff before auto-retry (default 120000)
 *   PROVIDER_MAX_BACKOFF_MS      Max backoff cap (default 3600000 = 1 hour)
 *   PROVIDER_BACKOFF_MULTIPLIER  Exponential multiplier (default 2)
 */

// ─── Failure Classification ─────────────────────────────────────────────────

/**
 * Exhaustive failure classes for provider errors. Each class determines
 * retry/fallback/pause behavior differently.
 */
export type ProviderFailureClass =
  | "quota_exhausted"       // HTTP 402, billing/credit errors — cannot retry, must pause or fallback
  | "authentication"        // HTTP 401/403 without billing message — key invalid/revoked
  | "rate_limited"          // HTTP 429 or explicit rate-limit — transient, backoff and retry
  | "server_error"          // HTTP 5xx — transient, retry with backoff
  | "timeout"              // ETIMEDOUT, ECONNABORTED, socket hang up — transient
  | "malformed_output"     // Provider returned non-parseable structured output
  | "application_error";   // All other errors (network, DNS, unexpected)

/**
 * Classify an error into a ProviderFailureClass. This is the single source of
 * truth for error classification — used by the circuit breaker, retry logic,
 * and failure persistence.
 */
export function classifyProviderError(error: any): ProviderFailureClass {
  if (!error) return "application_error";

  const status =
    error.status ??
    error.response?.status ??
    error.statusCode ??
    error.response?.data?.error?.code;

  // Collect message haystacks for pattern matching
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

  // 1. Quota/billing exhaustion (most critical — triggers pause)
  const CREDIT_SIGNATURES = [
    "insufficient balance", "insufficient_quota", "insufficient quota",
    "exceeded your current quota", "exceeded your quota", "billing",
    "payment required", "out of credit", "no credit", "account balance",
    "add funds", "top up", "quota exceeded",
  ];
  if (status === 402 || status === "402") return "quota_exhausted";
  if (CREDIT_SIGNATURES.some((sig) => blob.includes(sig))) return "quota_exhausted";

  // 2. Authentication errors (key revoked/invalid — not fixable by retry)
  if (status === 401 || status === 403) return "authentication";

  // 3. Rate limiting (transient — backoff and retry)
  if (status === 429 || status === "429") return "rate_limited";
  if (/rate.?limit|too many requests/i.test(blob)) return "rate_limited";

  // 4. Server errors (transient — retry)
  if (typeof status === "number" && status >= 500 && status < 600) return "server_error";

  // 5. Timeout (transient — retry with longer timeout or different provider)
  if (/timed? ?out|ETIMEDOUT|ECONNABORTED|timeout|socket hang up|ECONNRESET/i.test(blob)) return "timeout";

  // 6. Malformed output (provider returned garbage — may retry or fallback)
  if (/failed to parse json|unexpected response type|invalid json/i.test(blob)) return "malformed_output";

  // 7. Everything else
  return "application_error";
}

/**
 * Whether a failure class is retriable on the same provider (with backoff).
 */
export function isRetriableFailureClass(cls: ProviderFailureClass): boolean {
  return cls === "rate_limited" || cls === "server_error" || cls === "timeout" || cls === "malformed_output";
}

/**
 * Whether a failure class should trigger provider fallback (try next in chain).
 */
export function shouldFallback(cls: ProviderFailureClass): boolean {
  return cls === "quota_exhausted" || cls === "authentication" || cls === "timeout" || cls === "server_error";
}

/**
 * Whether a failure class should trigger a system-wide pause (circuit breaker).
 */
export function shouldPauseScoring(cls: ProviderFailureClass): boolean {
  return cls === "quota_exhausted";
}

// ─── Provider Fallback Configuration ────────────────────────────────────────

const DEFAULT_FALLBACK_ORDER = "deepseek,openrouter,openai,claude";

/**
 * Returns the configured deterministic fallback order. The primary scoring
 * provider is always first; remaining entries are the explicit fallback chain.
 * If PROVIDER_FALLBACK_ORDER is not set, uses a sensible default.
 */
export function getConfiguredFallbackOrder(): string[] {
  const raw = process.env.PROVIDER_FALLBACK_ORDER || DEFAULT_FALLBACK_ORDER;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Given the current scoring provider name, returns the ordered list of
 * providers to try (primary first, then configured fallbacks, excluding
 * the primary and any already-tripped providers).
 */
export function resolveProviderChain(
  primaryName: string,
  trippedProviders: Set<string>,
): string[] {
  const configured = getConfiguredFallbackOrder();
  // Ensure primary is first
  const chain: string[] = [primaryName];
  for (const name of configured) {
    if (name !== primaryName && !chain.includes(name)) {
      chain.push(name);
    }
  }
  // Filter out tripped providers (except primary which gets a probe chance)
  return chain.filter((name) => name === primaryName || !trippedProviders.has(name));
}

// ─── Pause/Resume State ─────────────────────────────────────────────────────

export interface ProviderPauseState {
  provider: string;
  failureClass: ProviderFailureClass;
  pausedAt: number;           // epoch ms
  retryAfter: number;         // epoch ms — earliest auto-retry time
  backoffMs: number;          // current backoff duration
  affectedJobIds: number[];   // job IDs that were paused (capped at 100 for storage)
  affectedBatchIds: number[]; // batch IDs affected
  resumeCount: number;        // how many times this provider has been resumed
  lastResumedAt: number | null;
  lastResumedBy: string | null; // "auto" | "manual" | null
}

// Process-local pause state (authoritative state is in DB via system_alerts,
// but this provides fast synchronous access for hot paths)
const pauseStates = new Map<string, ProviderPauseState>();

const PAUSE_BACKOFF_MS = parseInt(process.env.PROVIDER_PAUSE_BACKOFF_MS || "120000", 10);
const MAX_BACKOFF_MS = parseInt(process.env.PROVIDER_MAX_BACKOFF_MS || "3600000", 10);
const BACKOFF_MULTIPLIER = parseFloat(process.env.PROVIDER_BACKOFF_MULTIPLIER || "2");

/**
 * Record a provider pause. Returns the pause state for persistence.
 */
export function pauseProvider(
  provider: string,
  failureClass: ProviderFailureClass,
  affectedJobIds: number[] = [],
  affectedBatchIds: number[] = [],
): ProviderPauseState {
  const existing = pauseStates.get(provider);
  const now = Date.now();
  // Exponential backoff: double the backoff each time, capped at MAX
  const prevBackoff = existing?.backoffMs || PAUSE_BACKOFF_MS;
  const backoffMs = existing
    ? Math.min(prevBackoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS)
    : PAUSE_BACKOFF_MS;

  const state: ProviderPauseState = {
    provider,
    failureClass,
    pausedAt: now,
    retryAfter: now + backoffMs,
    backoffMs,
    affectedJobIds: affectedJobIds.slice(0, 100),
    affectedBatchIds: [...new Set(affectedBatchIds)],
    resumeCount: existing?.resumeCount || 0,
    lastResumedAt: existing?.lastResumedAt || null,
    lastResumedBy: existing?.lastResumedBy || null,
  };
  pauseStates.set(provider, state);
  return state;
}

/**
 * Resume a provider (manual or auto). Idempotent — safe to call multiple times.
 * Returns true if the provider was actually paused and is now resumed.
 */
export function resumeProvider(provider: string, by: "auto" | "manual" = "manual"): boolean {
  const state = pauseStates.get(provider);
  if (!state) return false;
  state.lastResumedAt = Date.now();
  state.lastResumedBy = by;
  state.resumeCount++;
  pauseStates.delete(provider);
  return true;
}

/**
 * Check if a provider is currently paused.
 */
export function isProviderPaused(provider: string): boolean {
  return pauseStates.has(provider);
}

/**
 * Check if auto-retry is due for a paused provider (backoff elapsed).
 */
export function isRetryDue(provider: string): boolean {
  const state = pauseStates.get(provider);
  if (!state) return false;
  return Date.now() >= state.retryAfter;
}

/**
 * Get the pause state for a provider (or null if not paused).
 */
export function getPauseState(provider: string): ProviderPauseState | null {
  return pauseStates.get(provider) || null;
}

/**
 * Get all currently paused providers.
 */
export function getAllPausedProviders(): ProviderPauseState[] {
  return Array.from(pauseStates.values());
}

/**
 * Clear all pause states (used in tests).
 */
export function clearAllPauseStates(): void {
  pauseStates.clear();
}

// ─── Operational Status ─────────────────────────────────────────────────────

export interface ProviderOperationalStatus {
  provider: string;
  status: "healthy" | "paused" | "degraded";
  failureClass: ProviderFailureClass | null;
  pausedAt: string | null;      // ISO timestamp
  retryAfter: string | null;    // ISO timestamp
  backoffMs: number | null;
  affectedJobIds: number[];
  affectedBatchIds: number[];
  resumeCount: number;
  lastResumedAt: string | null;
  lastResumedBy: string | null;
}

/**
 * Build the operational status for all providers. Used by the status endpoint.
 */
export function buildOperationalStatus(
  availableProviders: string[],
  trippedProviders: Set<string>,
): ProviderOperationalStatus[] {
  return availableProviders.map((name) => {
    const pauseState = pauseStates.get(name);
    if (pauseState) {
      return {
        provider: name,
        status: "paused" as const,
        failureClass: pauseState.failureClass,
        pausedAt: new Date(pauseState.pausedAt).toISOString(),
        retryAfter: new Date(pauseState.retryAfter).toISOString(),
        backoffMs: pauseState.backoffMs,
        affectedJobIds: pauseState.affectedJobIds,
        affectedBatchIds: pauseState.affectedBatchIds,
        resumeCount: pauseState.resumeCount,
        lastResumedAt: pauseState.lastResumedAt ? new Date(pauseState.lastResumedAt).toISOString() : null,
        lastResumedBy: pauseState.lastResumedBy,
      };
    }
    if (trippedProviders.has(name)) {
      return {
        provider: name,
        status: "degraded" as const,
        failureClass: "quota_exhausted" as const,
        pausedAt: null,
        retryAfter: null,
        backoffMs: null,
        affectedJobIds: [],
        affectedBatchIds: [],
        resumeCount: 0,
        lastResumedAt: null,
        lastResumedBy: null,
      };
    }
    return {
      provider: name,
      status: "healthy" as const,
      failureClass: null,
      pausedAt: null,
      retryAfter: null,
      backoffMs: null,
      affectedJobIds: [],
      affectedBatchIds: [],
      resumeCount: 0,
      lastResumedAt: null,
      lastResumedBy: null,
    };
  });
}

// ─── Failure Record (for persistence) ───────────────────────────────────────

export interface ProviderFailureRecord {
  provider: string;
  model: string;
  failureClass: ProviderFailureClass;
  httpStatus: number | null;
  errorMessage: string;
  jobId: number | null;
  batchId: number | null;
  measureId: string | null;
  timestamp: string;  // ISO
}

/**
 * Build a failure record from an error context. Used to persist failure
 * metadata to the job's progress_detail without converting it to a score.
 */
export function buildFailureRecord(opts: {
  provider: string;
  model: string;
  error: any;
  jobId?: number;
  batchId?: number;
  measureId?: string;
}): ProviderFailureRecord {
  const status =
    opts.error?.status ??
    opts.error?.response?.status ??
    opts.error?.statusCode ??
    null;
  return {
    provider: opts.provider,
    model: opts.model,
    failureClass: classifyProviderError(opts.error),
    httpStatus: typeof status === "number" ? status : null,
    errorMessage: String(opts.error?.message || opts.error || "unknown").slice(0, 500),
    jobId: opts.jobId ?? null,
    batchId: opts.batchId ?? null,
    measureId: opts.measureId ?? null,
    timestamp: new Date().toISOString(),
  };
}

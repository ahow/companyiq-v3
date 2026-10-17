/**
 * WP14 / B6 — Connection-budget-aware worker concurrency.
 *
 * WHAT THIS IS
 * ------------
 * A disciplined capacity-TUNING method with ONE genuinely dynamic element — NOT a
 * closed-loop autoscaler and NOT a replica-count controller. The replica COUNT stays
 * the user's manual lever (set in Railway). B6 only makes the worker safe/correct at
 * whatever replica count is set, by deriving per-replica job concurrency from the
 * binding DB-connection budget so that the TOTAL connections opened across all
 * replicas can never exceed the hosted-Postgres ceiling as replicas scale up/down.
 *
 * WHY
 * ---
 * The binding constraint is the hosted-Postgres connection ceiling (LIVE-confirmed
 * 97 usable = max_connections 100 − superuser_reserved 3). The documented
 * "88-vs-97 failure" was a pool bump that pushed the saturated worst case toward 97.
 * Each worker job fans sequential drizzle queries through the shared pool, so
 * worker job concurrency × replicaCount is the lever that governs peak DB pressure.
 *
 * INVARIANT (guaranteed by construction for replicaCount in [1, maxSafeReplicas]):
 *   effectiveConcurrency × replicaCount × connectionsPerJob + reservedOverhead
 *       ≤ dbConnectionBudget
 *
 * KILL-SWITCH (mirrors the WP13/B5 model-cost pattern exactly):
 *   CAPACITY_POLICY = static (DEFAULT) | shadow | dynamic
 *     - static  : use the current fixed WORKER_CONCURRENCY unchanged (byte-identical
 *                 to today's production — the SHIPPED DEFAULT, so this deploy is a no-op).
 *     - shadow  : compute the budget-derived concurrency and log it, but still USE the
 *                 static value (observe-only).
 *     - dynamic : apply the budget-derived concurrency (can only ever LOWER concurrency
 *                 as replicas grow; never raises above HARD_MAX = today's static value).
 *
 * SCOPE GUARD: this module is pure (no DB, no company/topic strings) and is wired ONLY
 * at the worker-concurrency seam. It does NOT touch the analyzer / evidence / scoring
 * path, and it does NOT change any DB pool max size (an approval-gated tuned-matrix
 * decision). Scoring packs are byte-identical ⇒ cell flips Y→N=0, N→Y=0 by construction.
 */

export type CapacityPolicy = "static" | "shadow" | "dynamic";

/**
 * SHIPPED DEFAULT. `static` reproduces today's production behaviour byte-identically
 * (the worker uses its fixed WORKER_CONCURRENCY). Flipping to `dynamic` is the user's
 * approval-gated lever (CAPACITY_POLICY=dynamic on the Railway services).
 */
export const DEFAULT_CAPACITY_POLICY: CapacityPolicy = "static";

/** Env var name for the kill-switch (documented in the ledger). */
export const CAPACITY_POLICY_ENV = "CAPACITY_POLICY";

/** Bump when the resolve semantics change (mirrors the other WP policy versions). */
export const CAPACITY_POLICY_VERSION = 1;

/**
 * Resolve the active policy: explicit arg > env CAPACITY_POLICY > default.
 * Any unrecognised/empty value falls back to the shipped default ("static" —
 * fail-safe to standing production behaviour, so a typo can never silently change
 * worker concurrency). Total: never throws.
 */
export function resolveCapacityPolicy(
  explicit?: CapacityPolicy | null,
): CapacityPolicy {
  if (explicit === "static" || explicit === "shadow" || explicit === "dynamic") return explicit;
  try {
    const env = (process.env[CAPACITY_POLICY_ENV] || "").trim().toLowerCase();
    if (env === "static" || env === "shadow" || env === "dynamic") return env as CapacityPolicy;
  } catch {
    /* process.env unavailable — fall through to default */
  }
  return DEFAULT_CAPACITY_POLICY;
}

/** Connection-budget configuration. All values have safe in-code defaults. */
export interface CapacityConfig {
  /** Usable DB-connection budget for the whole app (safely under the 97 usable ceiling). */
  dbConnectionBudget: number;
  /** Connections reserved for the app service + worker control-plane + telemetry pools. */
  reservedOverhead: number;
  /** Peak DB connections a single worker job holds (= PG_POOL_MAX / static concurrency). */
  connectionsPerJob: number;
  /** Hard upper bound on per-replica concurrency (= today's static value; dynamic can only lower). */
  hardMax: number;
  /** Current worker-replica count, read from the Railway env at boot. Floor 1. */
  replicaCount: number;
  /** Today's fixed WORKER_CONCURRENCY — the static/shadow value and the HARD_MAX anchor. */
  staticConcurrency: number;
}

/** In-code defaults derived in gate_b6_out/b6_bottleneck_and_connection_inventory.(md|json). */
export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  dbConnectionBudget: 90,
  reservedOverhead: 10,
  connectionsPerJob: 2,
  hardMax: 10,
  replicaCount: 1,
  staticConcurrency: 10,
};

/** Parse a positive integer env value, or fall back. Never throws. */
function intEnv(env: NodeJS.ProcessEnv | undefined, key: string, fallback: number): number {
  try {
    const raw = env?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  } catch {
    return fallback;
  }
}

/**
 * Build the capacity config from the environment, falling back to the shipped
 * constant defaults for any missing/invalid value. `staticConcurrency` tracks the
 * worker's existing WORKER_CONCURRENCY (so static/shadow stay byte-identical) and
 * also anchors HARD_MAX. replicaCount reads REPLICA_COUNT then RAILWAY_REPLICA_COUNT.
 * Pure + total (never throws).
 */
export function loadCapacityConfig(env: NodeJS.ProcessEnv | undefined = process.env): CapacityConfig {
  const staticConcurrency = intEnv(env, "WORKER_CONCURRENCY", DEFAULT_CAPACITY_CONFIG.staticConcurrency);
  const replicaCount = Math.max(
    1,
    intEnv(
      env,
      "REPLICA_COUNT",
      intEnv(env, "RAILWAY_REPLICA_COUNT", DEFAULT_CAPACITY_CONFIG.replicaCount),
    ),
  );
  return {
    dbConnectionBudget: intEnv(env, "DB_CONNECTION_BUDGET", DEFAULT_CAPACITY_CONFIG.dbConnectionBudget),
    reservedOverhead: intEnv(env, "DB_RESERVED_OVERHEAD", DEFAULT_CAPACITY_CONFIG.reservedOverhead),
    connectionsPerJob: intEnv(env, "DB_CONNECTIONS_PER_JOB", DEFAULT_CAPACITY_CONFIG.connectionsPerJob),
    // HARD_MAX pins to today's static concurrency so dynamic can only ever LOWER it.
    hardMax: intEnv(env, "CAPACITY_HARD_MAX", staticConcurrency),
    replicaCount,
    staticConcurrency,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Budget-derived per-replica worker concurrency:
 *   clamp( floor( (budget − overhead) / replicaCount / connectionsPerJob ), 1, hardMax )
 * Min-1 for liveness (a worker must process ≥1 job). For replicaCount beyond
 * maxSafeReplicas the min-1 clamp would breach the ceiling — that is surfaced by
 * checkCeilingInvariant (a documented "cut replicas" signal), never silently.
 * Pure + deterministic.
 */
export function computeDynamicConcurrency(cfg: CapacityConfig): number {
  const replicaCount = Math.max(1, Math.floor(cfg.replicaCount));
  const connectionsPerJob = Math.max(1, cfg.connectionsPerJob);
  const budgetForJobs = cfg.dbConnectionBudget - cfg.reservedOverhead;
  const perReplica = Math.floor(budgetForJobs / replicaCount / connectionsPerJob);
  return clamp(perReplica, 1, Math.max(1, cfg.hardMax));
}

/**
 * Largest replica count for which the invariant still holds at ≥1 concurrency:
 *   floor( (budget − overhead) / connectionsPerJob )
 * Beyond this, even concurrency=1 breaches the ceiling ⇒ the operator must cut replicas.
 */
export function maxSafeReplicas(cfg: CapacityConfig): number {
  const connectionsPerJob = Math.max(1, cfg.connectionsPerJob);
  return Math.floor((cfg.dbConnectionBudget - cfg.reservedOverhead) / connectionsPerJob);
}

/** Worst-case total DB connections at a given concurrency + replica count. */
export function totalConnectionLoad(
  cfg: CapacityConfig,
  concurrency: number,
  replicaCount: number,
): number {
  return concurrency * replicaCount * Math.max(1, cfg.connectionsPerJob) + cfg.reservedOverhead;
}

/**
 * The ceiling invariant checker (exposed for tests + the matrix harness):
 *   concurrency × replicaCount × connectionsPerJob + reservedOverhead ≤ dbConnectionBudget
 * Returns false (infeasible — "cut replicas") rather than ever permitting a breach.
 */
export function checkCeilingInvariant(
  cfg: CapacityConfig,
  concurrency: number,
  replicaCount: number,
): boolean {
  return totalConnectionLoad(cfg, concurrency, replicaCount) <= cfg.dbConnectionBudget;
}

export interface EffectiveConcurrencyResult {
  policy: CapacityPolicy;
  /** The fixed WORKER_CONCURRENCY (static/shadow use this — byte-identical to prod). */
  staticConcurrency: number;
  /** The budget-derived value (always computed, for shadow logging + diagnostics). */
  dynamicConcurrency: number;
  /** The value the worker actually USES: static/shadow → static; dynamic → dynamic. */
  effectiveConcurrency: number;
  /** Does the EFFECTIVE value satisfy the ceiling invariant at this replica count? */
  withinBudget: boolean;
  /** maxSafeReplicas for the active config (for logs / the "cut replicas" signal). */
  maxSafeReplicas: number;
}

/**
 * Resolve the concurrency the worker should run at, honouring the kill-switch.
 * static/shadow return the static value (byte-identical to today's production);
 * dynamic returns the budget-derived value. The dynamic value is ALWAYS computed so
 * shadow mode can log the delta without applying it. Pure + total.
 */
export function resolveEffectiveConcurrency(
  cfg: CapacityConfig = loadCapacityConfig(),
  explicitPolicy?: CapacityPolicy | null,
): EffectiveConcurrencyResult {
  const policy = resolveCapacityPolicy(explicitPolicy);
  const staticConcurrency = Math.max(1, cfg.staticConcurrency);
  const dynamicConcurrency = computeDynamicConcurrency(cfg);
  const effectiveConcurrency = policy === "dynamic" ? dynamicConcurrency : staticConcurrency;
  return {
    policy,
    staticConcurrency,
    dynamicConcurrency,
    effectiveConcurrency,
    withinBudget: checkCeilingInvariant(cfg, effectiveConcurrency, cfg.replicaCount),
    maxSafeReplicas: maxSafeReplicas(cfg),
  };
}

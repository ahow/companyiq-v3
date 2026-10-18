/**
 * Phase 3 / Issue 3 (Scale) — POOL-SEPARATION LEVER (framework-level, pure, DORMANT).
 *
 * WHAT. Models separate, bounded resource pools for BROWSER-RECOVERY slots vs
 * ANALYSIS slots, instead of today's single shared execution path. Composed with
 * the B6 capacity-config connection budget so the two pools TOGETHER can never
 * breach the 97-usable-connection ceiling (this module REUSES capacity-config.ts
 * checkCeilingInvariant / totalConnectionLoad — it does NOT re-derive the budget).
 *
 * WHY. The batch-1276 isolated-child-spawn-aborts under 8-slot load and the
 * batch-1277 "shared serialised resource" hypothesis (4/25 jobs stalling a single
 * shared path to the 2,100s wall-clock) both point at one undifferentiated pool.
 * Separating browser-recovery capacity from analysis capacity lets a storm of
 * slow browser recoveries exhaust ONLY the browser pool, leaving analysis slots
 * free — rather than serialising the whole worker behind one contended resource.
 *
 * SHIPPED DORMANT. Arming this is gated on the Phase-3 part-2 paid instrumented
 * 25-company diagnostic run (which this turn does NOT perform). Until that data
 * exists the split ratio is unvalidated, so the module ships OFF behind its
 * kill-switch and is wired nowhere — it is imported only by its own test.
 *
 * KILL-SWITCH (versioned). RESOURCE_POOL_POLICY:
 *   - "shared" (DEFAULT) — current single shared path, byte-identical: one pool
 *     sized at the B6 effective concurrency; no separation.
 *   - "shadow" — compute the separated allocation for telemetry, but RETURN the
 *     single shared pool (non-mutating).
 *   - "separated" — armed: two bounded pools (browser-recovery + analysis) whose
 *     combined slots never exceed the shared slot count, so the ceiling invariant
 *     that already holds for the shared path is preserved by construction.
 *
 * SCOPE GUARD. Pure; no DB / LLM / network / filesystem; no company- or
 * topic-specific branch. At the "shared" default (and dormant/unwired) no
 * scoring/evidence/analyzer surface is touched, so cell flips Y→N = 0 and
 * N→Y = 0 by construction.
 */

import {
  loadCapacityConfig,
  resolveEffectiveConcurrency,
  checkCeilingInvariant,
  totalConnectionLoad,
  type CapacityConfig,
} from "./capacity-config.js";

// ─── Kill-switch (house style, cf. capacity-config.ts) ───────────────────────

export type ResourcePoolPolicy = "shared" | "shadow" | "separated";

export const DEFAULT_RESOURCE_POOL_POLICY: ResourcePoolPolicy = "shared";
export const RESOURCE_POOL_POLICY_ENV = "RESOURCE_POOL_POLICY";
export const RESOURCE_POOL_POLICY_VERSION = 1;

const VALID_POLICIES: ReadonlySet<string> = new Set<ResourcePoolPolicy>([
  "shared",
  "shadow",
  "separated",
]);

/** Precedence: explicit > env > default. Unrecognised → default. Never throws. */
export function resolveResourcePoolPolicy(explicit?: string | null): ResourcePoolPolicy {
  const pick = (v: string | null | undefined): ResourcePoolPolicy | null => {
    if (!v) return null;
    const t = v.trim().toLowerCase();
    return VALID_POLICIES.has(t) ? (t as ResourcePoolPolicy) : null;
  };
  const fromExplicit = pick(explicit);
  if (fromExplicit) return fromExplicit;
  try {
    const fromEnv = pick(process.env[RESOURCE_POOL_POLICY_ENV]);
    if (fromEnv) return fromEnv;
  } catch {
    /* env unavailable → default */
  }
  return DEFAULT_RESOURCE_POOL_POLICY;
}

// ─── Pool allocation ─────────────────────────────────────────────────────────

export type PoolName = "browser_recovery" | "analysis";

/**
 * Fraction of the total slots reserved for browser recovery when SEPARATED.
 * Unvalidated until the paid diagnostic run — hence dormant. Conservative
 * default: 30% browser-recovery, 70% analysis.
 */
export const DEFAULT_BROWSER_RECOVERY_FRACTION = 0.3;

export interface SeparatedPools {
  browser_recovery: number;
  analysis: number;
}

/**
 * Split `totalSlots` into two bounded pools. Each pool gets ≥1 slot (liveness)
 * when totalSlots ≥ 2; the sum ALWAYS equals totalSlots exactly (analysis
 * absorbs the remainder), so separation never adds capacity over the shared
 * path. Pure + deterministic.
 */
export function allocateSeparatedPools(
  totalSlots: number,
  browserRecoveryFraction: number = DEFAULT_BROWSER_RECOVERY_FRACTION,
): SeparatedPools {
  const total = Math.max(0, Math.floor(totalSlots));
  if (total <= 0) return { browser_recovery: 0, analysis: 0 };
  if (total === 1) return { browser_recovery: 0, analysis: 1 };
  let frac = browserRecoveryFraction;
  if (!(frac > 0)) frac = DEFAULT_BROWSER_RECOVERY_FRACTION;
  if (frac >= 1) frac = DEFAULT_BROWSER_RECOVERY_FRACTION;
  let browser = Math.floor(total * frac);
  browser = Math.min(Math.max(1, browser), total - 1); // keep ≥1 for each pool
  const analysis = total - browser;
  return { browser_recovery: browser, analysis };
}

// ─── Resolved pools ──────────────────────────────────────────────────────────

export interface ResolvedResourcePools {
  policy: ResourcePoolPolicy;
  /** Slots that would be used by the single shared path (= B6 effective concurrency). */
  sharedSlots: number;
  /** The pools actually in effect. In "shared"/"shadow" these are {shared: sharedSlots}. */
  pools: Record<string, number>;
  /** True only when the separated pools are actually in effect (policy === "separated"). */
  separated: boolean;
  /** The separated allocation (always computed; surfaced for shadow telemetry). */
  separatedPlan: SeparatedPools;
  /** Does the EFFECTIVE pool total satisfy the B6 ceiling invariant? */
  withinBudget: boolean;
  /** Worst-case DB connections the effective pool total implies (via capacity-config). */
  worstCaseConnections: number;
}

/**
 * Resolve the resource-pool layout for a given capacity config. Reuses B6 to get
 * the shared slot count (effective concurrency) and to check the ceiling — this
 * module never re-derives the connection budget.
 *
 * - "shared": one pool of sharedSlots (byte-identical to today).
 * - "shadow": compute separatedPlan for telemetry, but the effective pools are
 *   still the single shared pool (non-mutating).
 * - "separated": effective pools = the two-pool split (sum == sharedSlots).
 */
export function resolveResourcePools(input?: {
  policy?: ResourcePoolPolicy;
  cfg?: CapacityConfig;
  browserRecoveryFraction?: number;
}): ResolvedResourcePools {
  const cfg = input?.cfg ?? loadCapacityConfig();
  const policy = input?.policy ?? resolveResourcePoolPolicy();
  const sharedSlots = resolveEffectiveConcurrency(cfg).effectiveConcurrency;
  const separatedPlan = allocateSeparatedPools(sharedSlots, input?.browserRecoveryFraction);

  const pools: Record<string, number> =
    policy === "separated"
      ? { browser_recovery: separatedPlan.browser_recovery, analysis: separatedPlan.analysis }
      : { shared: sharedSlots };

  const effectiveTotal = Object.values(pools).reduce((a, b) => a + b, 0);
  return {
    policy,
    sharedSlots,
    pools,
    separated: policy === "separated",
    separatedPlan,
    // Reuse B6 ceiling check — the pools' total slot count is what pressures the DB.
    withinBudget: checkCeilingInvariant(cfg, effectiveTotal, cfg.replicaCount),
    worstCaseConnections: totalConnectionLoad(cfg, effectiveTotal, cfg.replicaCount),
  };
}

/**
 * Explicit ceiling guard over an arbitrary pool layout. Delegates to B6
 * checkCeilingInvariant on the SUM of pool slots — the separated pools, taken
 * together, must respect the same ceiling as the shared path. Pure.
 */
export function poolsRespectCeiling(
  pools: Record<string, number>,
  cfg: CapacityConfig = loadCapacityConfig(),
  replicaCount: number = cfg.replicaCount,
): boolean {
  const total = Object.values(pools).reduce((a, b) => a + (b > 0 ? b : 0), 0);
  return checkCeilingInvariant(cfg, total, replicaCount);
}

// ─── Browser-recovery slot resolution (the processor.ts wiring seam) ──────────

/**
 * Conservative upper bound on the SEPARATED browser-recovery slot count. Chromium
 * is memory-heavy, so arming separation must never raise live-browser concurrency
 * without a bound — this caps the browser-recovery pool regardless of what the B6
 * split would otherwise yield. Read from BROWSER_SEPARATED_MAX (default 3): the
 * diagnostic (batch 1295) found a single serialised slot (1) was the bottleneck;
 * a small bounded increase (1 → ≤3) is what the evidence supports.
 */
export const BROWSER_SEPARATED_MAX_ENV = "BROWSER_SEPARATED_MAX";
export const DEFAULT_BROWSER_SEPARATED_MAX = 3;

function intEnv(env: NodeJS.ProcessEnv | undefined, key: string, fallback: number): number {
  try {
    const raw = env?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export interface ResolvedBrowserPoolSlots {
  policy: ResourcePoolPolicy;
  /** The MAX_CONCURRENT_BROWSER value the processor should actually use. */
  slots: number;
  /** Today's shipped default (= parseInt(MAX_CONCURRENT_BROWSER||"1")); the shared value. */
  sharedDefault: number;
  /** True only when the separated browser-recovery pool is actually applied. */
  separated: boolean;
  /** The B6-derived browser-recovery pool size (always computed; surfaced for telemetry). */
  plannedBrowserRecovery: number;
  /** Conservative cap actually applied to the separated slot count. */
  maxSeparated: number;
  /** Does the effective pool layout satisfy the B6 ceiling invariant? */
  withinBudget: boolean;
  reason: string;
}

/**
 * Resolve how many concurrent browser slots the processor should run, honouring
 * the RESOURCE_POOL_POLICY kill-switch. This is the single wiring seam M4 arms.
 *
 * - "shared" (DEFAULT): slots = sharedDefault, byte-identical to today (the
 *   processor keeps its single-slot — or env-configured — path untouched).
 * - "shadow": compute the separated plan for telemetry but RETURN sharedDefault
 *   (non-mutating — concurrency is unchanged).
 * - "separated": slots = the B6 browser-recovery pool size, CLAMPED to
 *   [sharedDefault, maxSeparated] so it never drops below today's value and never
 *   exceeds the conservative memory cap. If the effective layout would breach the
 *   B6 ceiling (never, since the split sums to the shared slots) it falls back to
 *   sharedDefault. Pure + total (never throws).
 */
export function resolveBrowserPoolSlots(input: {
  sharedDefault: number;
  policy?: ResourcePoolPolicy;
  cfg?: CapacityConfig;
  maxSeparated?: number;
  browserRecoveryFraction?: number;
  env?: NodeJS.ProcessEnv;
}): ResolvedBrowserPoolSlots {
  const env = input.env ?? process.env;
  const sharedDefault = Math.max(1, Math.floor(input.sharedDefault || 1));
  const policy = input.policy ?? resolveResourcePoolPolicy();
  const maxSeparated = Math.max(
    1,
    Math.floor(input.maxSeparated ?? intEnv(env, BROWSER_SEPARATED_MAX_ENV, DEFAULT_BROWSER_SEPARATED_MAX)),
  );
  const resolved = resolveResourcePools({
    policy,
    cfg: input.cfg,
    browserRecoveryFraction: input.browserRecoveryFraction,
  });
  const plannedBrowserRecovery = resolved.separatedPlan.browser_recovery;

  // shared / shadow: byte-identical — the processor keeps sharedDefault.
  if (policy !== "separated") {
    return {
      policy,
      slots: sharedDefault,
      sharedDefault,
      separated: false,
      plannedBrowserRecovery,
      maxSeparated,
      withinBudget: resolved.withinBudget,
      reason:
        policy === "shadow"
          ? `shadow: would use browser_recovery=${plannedBrowserRecovery} (clamped≤${maxSeparated}); slots stay ${sharedDefault}`
          : `shared: slots=${sharedDefault} (unchanged)`,
    };
  }

  // separated (armed): clamp the B6 pool size into [sharedDefault, maxSeparated].
  const lo = sharedDefault;
  const hi = Math.max(sharedDefault, maxSeparated);
  const slots = Math.min(Math.max(plannedBrowserRecovery, lo), hi);
  // Safety: never apply a layout that would breach the B6 ceiling (the split sums
  // to the shared slots, so this holds — but fail safe to sharedDefault if not).
  if (!resolved.withinBudget) {
    return {
      policy,
      slots: sharedDefault,
      sharedDefault,
      separated: false,
      plannedBrowserRecovery,
      maxSeparated,
      withinBudget: false,
      reason: `separated layout over B6 ceiling — fail-safe to shared slots=${sharedDefault}`,
    };
  }
  return {
    policy,
    slots,
    sharedDefault,
    separated: slots !== sharedDefault,
    plannedBrowserRecovery,
    maxSeparated,
    withinBudget: true,
    reason: `separated: browser_recovery=${plannedBrowserRecovery} clamped to [${lo},${hi}] → slots=${slots}`,
  };
}

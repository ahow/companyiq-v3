/**
 * discovery-parallel.ts — B3 / WP11: discovery query dedupe + bounded parallelism
 * + canonical-source-first, behind a versioned kill-switch.
 *
 * WHY (plan §"B3. Discovery query dedupe + bounded parallelism (WP11)"):
 *   Discovery fans a company out across MANY search queries, each dispatched
 *   one-after-another through webSearch(). Two inefficiencies are provable and
 *   framework-level, independent of any company or topic:
 *     1. REDUNDANT CALLS — distinct query-builder lanes routinely emit queries
 *        that are EFFECTIVELY IDENTICAL once normalised (same provider, same
 *        options, same normalized query string). Each one currently costs a
 *        separate provider round-trip (the 24h searchCache only collapses
 *        BYTE-identical (query,opts) keys, not normalization-identical ones).
 *     2. SERIAL WALL-CLOCK — independent (cache-miss) queries are awaited in
 *        sequence even though they share nothing and are individually rate
 *        limited by their own provider token buckets.
 *
 *   B3 removes BOTH without changing WHAT is discovered. The HARD CONSTRAINT is
 *   "fewer redundant CALLS, never fewer QUERIES": the query SET is never dropped
 *   or shrunk, dedupe collapses ONLY provably effectively-identical queries, and
 *   bounded parallelism must produce a result set that is DETERMINISTICALLY
 *   IDENTICAL to the serial baseline (completion order must never leak into
 *   output order). essential-source recall is therefore unchanged (DQ01).
 *
 * WHAT THIS MODULE IS:
 *   A deterministic, PURE, DB-free, LLM-free, network-free toolkit. Every
 *   function that could touch the network takes the real search function as an
 *   INJECTED argument, so the planners/executors can be exercised offline with a
 *   stub (GATE2 fixed-corpus equivalence). Responsibilities:
 *     1. POLICY / KILL-SWITCH (resolveDiscoveryParallelPolicy) — mirrors the A5
 *        RECALL_EXPANSION_POLICY precedent, but the SHIPPED DEFAULT is "serial"
 *        (OFF): the new path is skipped entirely and discovery behaves exactly as
 *        it does today, byte-for-byte.
 *     2. CANONICALISATION (canonicalizeQuery) — a deterministic normal form used
 *        as a dedupe key. It collapses ONLY provably-identical queries (trim +
 *        collapse internal whitespace + lowercase + identical provider + identical
 *        serialized options). It NEVER merges queries that differ in any
 *        meaningful token, so recall is bytewise-preserved.
 *     3. DEDUPE PLANNER (planQueryDedupe) — given the ordered query list, returns
 *        the unique execution units (first occurrence wins, original order
 *        preserved) plus an alias map (duplicate index → canonical index) and the
 *        collapsed count. No query is dropped from the PLAN; duplicates are simply
 *        served from the canonical unit's single result.
 *     4. CANONICAL-SOURCE-FIRST (orderForExecution) — a STABLE reordering that
 *        dispatches canonical-source queries (registry/trusted/issuer-domain)
 *        before the rest, so under any bound the authoritative sources are
 *        discovered first. This affects EXECUTION order only; results are always
 *        returned in the caller's ORIGINAL input order (see runBoundedParallel),
 *        so output ordering is serial-equivalent.
 *     5. BOUNDED PARALLEL EXECUTOR (runBoundedParallel) — runs a worker over the
 *        items with at most maxParallel in flight, and returns the results in
 *        INPUT order regardless of completion order. Deterministic and total.
 *     6. ATTRIBUTION (buildQueryAttribution) — a telemetry-only trace recording
 *        which query FIRST yielded each new eligible source; redundant / collapsed
 *        queries contribute zero new sources. Used by "shadow" mode.
 *
 * VERSIONED KILL-SWITCH (mirrors evidence-recall RECALL_EXPANSION_POLICY):
 *   resolveDiscoveryParallelPolicy() reads env DISCOVERY_PARALLEL_POLICY:
 *     - "serial" (DEFAULT): current one-after-another behaviour. The new path is
 *                 SKIPPED ENTIRELY — zero behavioural change, byte-identical.
 *     - "shadow": run the new plan (dedupe + bounded parallel) but emit only the
 *                 attribution trace; the returned result set stays serial-equivalent.
 *     - "on":     apply dedupe + bounded parallelism + canonical-source-first.
 *   A typo or unrecognised value fails safe to the shipped default ("serial"),
 *   never to an unintended behaviour-changing mode.
 *
 * SAFETY: every exported function is pure and total (never throws on bad input),
 * returns plain data, performs no I/O of its own, and never calls a model.
 */

// ─── Policy / kill-switch ─────────────────────────────────────────────────────

export type DiscoveryParallelPolicy = "serial" | "shadow" | "on";

/**
 * DEFAULT = current production behaviour (serial, one query after another). The
 * new dedupe/parallel path is SKIPPED ENTIRELY under this default. Activation is
 * a separate, deliberately gated step — this module ships OFF.
 */
export const DEFAULT_DISCOVERY_PARALLEL_POLICY: DiscoveryParallelPolicy = "serial";

/** Env var name for the kill-switch (documented in the ledger). */
export const DISCOVERY_PARALLEL_ENV = "DISCOVERY_PARALLEL_POLICY";

/**
 * Resolve the active policy: explicit arg > env DISCOVERY_PARALLEL_POLICY > default.
 * Any unrecognised value falls back to the shipped default ("serial") — a typo can
 * never silently enable the behaviour-changing path. Set DISCOVERY_PARALLEL_POLICY=on
 * (or =shadow) to override without a redeploy.
 */
export function resolveDiscoveryParallelPolicy(
  explicit?: DiscoveryParallelPolicy | null,
): DiscoveryParallelPolicy {
  if (explicit === "serial" || explicit === "shadow" || explicit === "on") return explicit;
  const env = (process.env[DISCOVERY_PARALLEL_ENV] || "").trim().toLowerCase();
  if (env === "serial" || env === "shadow" || env === "on") return env as DiscoveryParallelPolicy;
  return DEFAULT_DISCOVERY_PARALLEL_POLICY;
}

/** True only when the kill-switch actively changes behaviour (dedupe+parallel): "on". */
export function isDiscoveryParallelEnabled(explicit?: DiscoveryParallelPolicy | null): boolean {
  return resolveDiscoveryParallelPolicy(explicit) === "on";
}

/** True when the new path RUNS (either "on" or "shadow") — i.e. not the serial default. */
export function isDiscoveryParallelActive(explicit?: DiscoveryParallelPolicy | null): boolean {
  return resolveDiscoveryParallelPolicy(explicit) !== "serial";
}

// ─── Tunable bounds (env-overridable; safe defaults) ──────────────────────────

/** Default bound for maximum concurrent provider calls when policy=on. */
export const DEFAULT_DISCOVERY_MAX_PARALLEL = 4;

/** Env var name for the concurrency bound. */
export const DISCOVERY_MAX_PARALLEL_ENV = "DISCOVERY_MAX_PARALLEL";

/**
 * Resolve the maximum number of concurrent search calls. Clamped to >= 1 (a bound
 * of 0 or negative would deadlock a bounded executor). Any non-numeric value falls
 * back to the default. This is an UPPER bound only — the per-provider token buckets
 * in discovery.ts still apply, so effective concurrency is min(this, bucket tokens).
 */
export function resolveDiscoveryMaxParallel(explicit?: number | null): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const raw = parseInt(process.env[DISCOVERY_MAX_PARALLEL_ENV] || "", 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return DEFAULT_DISCOVERY_MAX_PARALLEL;
}

// ─── Canonicalisation ─────────────────────────────────────────────────────────

/**
 * Deterministically serialise search options into a stable string so that two
 * option objects with the same effective values produce the same key regardless
 * of key insertion order. Only the fields discovery actually varies are
 * considered; unknown fields are included (sorted) so nothing is silently merged.
 */
export function canonicalizeOptions(opts: Record<string, unknown> | null | undefined): string {
  if (!opts || typeof opts !== "object") return "{}";
  const keys = Object.keys(opts).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (opts as Record<string, unknown>)[k];
    if (v === undefined) continue; // undefined === "field absent" — do not distinguish
    parts.push(`${k}=${stableValue(v)}`);
  }
  return `{${parts.join(",")}}`;
}

function stableValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Normalise a raw query string to its dedupe NORMAL FORM. This is intentionally
 * CONSERVATIVE: it only removes differences that cannot change what a search
 * provider returns:
 *   - trims leading/trailing whitespace,
 *   - collapses any run of internal whitespace to a single space,
 *   - lowercases (search providers are case-insensitive).
 * It deliberately does NOT reorder tokens, strip punctuation, drop quotes/operators
 * (site:, filetype:, OR, "..."), or otherwise alter query semantics — any of those
 * could change recall, which is forbidden. Two queries share a normal form ONLY
 * when they are provably effectively identical.
 */
export function normalizeQueryText(query: string): string {
  if (typeof query !== "string") return "";
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The full canonical dedupe key for a query: provider + normalized text +
 * canonical options. Queries collapse ONLY when all three match. The provider is
 * part of the key because the same text against a different provider is a
 * genuinely different call that may return different results.
 */
export function canonicalizeQuery(
  query: string,
  provider: string,
  opts?: Record<string, unknown> | null,
): string {
  return `${provider}\u0001${normalizeQueryText(query)}\u0001${canonicalizeOptions(opts)}`;
}

// ─── Dedupe planner ───────────────────────────────────────────────────────────

export interface QuerySpec {
  /** The raw query string, exactly as the query-builder emitted it. */
  query: string;
  /** Provider the query will be dispatched to (e.g. "serper", "serpapi", "auto"). */
  provider?: string;
  /** Search options (num/tbs/gl/hl/…). */
  opts?: Record<string, unknown> | null;
  /**
   * Whether this query targets a CANONICAL source (registry / trusted source /
   * verified issuer domain). Used by orderForExecution for canonical-first
   * dispatch. Optional; defaults to false.
   */
  canonical?: boolean;
}

export interface ExecUnit<T = QuerySpec> {
  /** Stable canonical dedupe key. */
  key: string;
  /** The representative spec (the FIRST occurrence in input order). */
  spec: T;
  /** Index of the representative spec in the original input array. */
  index: number;
}

export interface DedupePlan<T = QuerySpec> {
  /** Unique execution units, in first-occurrence (original) order. */
  units: ExecUnit<T>[];
  /**
   * For every ORIGINAL index, the index INTO `units` that serves it. Length
   * equals the input length, so no query is dropped from the plan — duplicates
   * are simply mapped onto their canonical unit.
   */
  unitForOriginalIndex: number[];
  /** Number of queries collapsed onto an earlier canonical unit (redundant calls removed). */
  collapsedCount: number;
  /** Total input queries (never changes — proves the query set is preserved). */
  totalQueries: number;
}

/**
 * Build the dedupe plan from an ordered list of query specs. First occurrence of
 * a canonical key wins and becomes the execution unit; later identical queries
 * are aliased onto it. Order of first occurrences is preserved exactly, so the
 * serial result-processing order is reproducible. Pure and total.
 */
export function planQueryDedupe(
  specs: QuerySpec[],
  keyFn: (s: QuerySpec) => string = (s) => canonicalizeQuery(s.query, s.provider || "auto", s.opts),
): DedupePlan {
  const units: ExecUnit[] = [];
  const keyToUnitIndex = new Map<string, number>();
  const unitForOriginalIndex: number[] = [];
  let collapsedCount = 0;

  const list = Array.isArray(specs) ? specs : [];
  for (let i = 0; i < list.length; i++) {
    const spec = list[i];
    const key = keyFn(spec);
    const existing = keyToUnitIndex.get(key);
    if (existing === undefined) {
      const unitIndex = units.length;
      keyToUnitIndex.set(key, unitIndex);
      units.push({ key, spec, index: i });
      unitForOriginalIndex.push(unitIndex);
    } else {
      unitForOriginalIndex.push(existing);
      collapsedCount++;
    }
  }

  return {
    units,
    unitForOriginalIndex,
    collapsedCount,
    totalQueries: list.length,
  };
}

// ─── Canonical-source-first ordering ──────────────────────────────────────────

/**
 * Return the execution order (an array of indices into `units`) that dispatches
 * canonical-source units first, preserving the relative order WITHIN each group
 * (a STABLE partition). This changes only the order in which calls are issued —
 * callers must still map results back to the original positions, so OUTPUT order
 * is unaffected. Pure and total.
 */
export function orderForExecution<T>(
  units: ExecUnit<T>[],
  isCanonical: (u: ExecUnit<T>) => boolean,
): number[] {
  const canonicalIdx: number[] = [];
  const restIdx: number[] = [];
  for (let i = 0; i < units.length; i++) {
    if (isCanonical(units[i])) canonicalIdx.push(i);
    else restIdx.push(i);
  }
  return canonicalIdx.concat(restIdx);
}

/** Default canonical predicate for QuerySpec units (reads spec.canonical). */
export function specIsCanonical(u: ExecUnit<QuerySpec>): boolean {
  return !!u.spec.canonical;
}

// ─── Bounded parallel executor ────────────────────────────────────────────────

/**
 * Run `worker` over every item with at most `maxParallel` in flight at any time,
 * and return the results array in INPUT order (results[i] corresponds to items[i]),
 * regardless of the order in which workers complete. This is the guarantee that
 * parallel completion order never leaks into discovery's output ordering.
 *
 * `executionOrder`, when provided, is a permutation of [0..items.length) giving
 * the order in which to START the workers (e.g. canonical-first). It changes only
 * dispatch order; results are still indexed by original position.
 *
 * Deterministic and total: a worker rejection is captured per-slot and rethrown
 * as an aggregated error only after all work settles, so one failing query cannot
 * abort the others or leave the result array ragged. If `onItemError` is provided
 * it is called per failure and the slot result is left as the provided fallback.
 */
export async function runBoundedParallel<I, R>(
  items: I[],
  worker: (item: I, originalIndex: number) => Promise<R>,
  maxParallel: number,
  options?: {
    executionOrder?: number[];
    onItemError?: (err: unknown, item: I, originalIndex: number) => R;
  },
): Promise<R[]> {
  const list = Array.isArray(items) ? items : [];
  const results: R[] = new Array(list.length);
  if (list.length === 0) return results;

  const bound = Math.max(1, Math.floor(maxParallel) || 1);
  const order =
    options?.executionOrder && options.executionOrder.length === list.length
      ? options.executionOrder
      : list.map((_, i) => i);

  let cursor = 0;
  const errors: unknown[] = [];

  async function runSlot(): Promise<void> {
    while (true) {
      const myCursor = cursor++;
      if (myCursor >= order.length) return;
      const originalIndex = order[myCursor];
      const item = list[originalIndex];
      try {
        results[originalIndex] = await worker(item, originalIndex);
      } catch (err) {
        if (options?.onItemError) {
          results[originalIndex] = options.onItemError(err, item, originalIndex);
        } else {
          errors.push(err);
        }
      }
    }
  }

  const slots: Promise<void>[] = [];
  for (let i = 0; i < Math.min(bound, order.length); i++) slots.push(runSlot());
  await Promise.all(slots);

  if (errors.length > 0 && !options?.onItemError) {
    const agg = new Error(
      `runBoundedParallel: ${errors.length} worker(s) failed; first: ${
        (errors[0] as Error)?.message ?? String(errors[0])
      }`,
    );
    (agg as any).errors = errors;
    throw agg;
  }

  return results;
}

/**
 * Expand per-UNIT results back to per-ORIGINAL-QUERY results using a dedupe plan,
 * so a caller that deduped N queries into M units still gets an N-length array in
 * the original query order, with each duplicate served from its canonical unit's
 * result. This is what makes the deduped+parallel result set reproduce the serial
 * result set exactly (same results processed in the same order). Pure and total.
 */
export function expandUnitResults<R>(plan: DedupePlan, unitResults: R[]): R[] {
  const out: R[] = new Array(plan.unitForOriginalIndex.length);
  for (let i = 0; i < plan.unitForOriginalIndex.length; i++) {
    out[i] = unitResults[plan.unitForOriginalIndex[i]];
  }
  return out;
}

// ─── Attribution (telemetry-only; used by "shadow") ───────────────────────────

export interface QueryAttribution {
  /** Original query index. */
  index: number;
  /** The query string. */
  query: string;
  /** Canonical dedupe key. */
  key: string;
  /** Whether this query was executed (true) or served from an earlier unit (false). */
  executed: boolean;
  /** Source identities (e.g. normalized URLs) this query FIRST contributed. */
  newSources: string[];
  /** Total source identities the query returned (including already-seen ones). */
  totalReturned: number;
}

/**
 * Build a per-query attribution trace: walking queries in original order, record
 * which source identities each query is the FIRST to contribute. Redundant /
 * collapsed queries (served from an earlier unit) and queries that only re-surface
 * already-seen sources contribute ZERO new sources — this is the telemetry that
 * proves dedupe removed only redundant work. Pure and total.
 *
 * @param specs            original ordered query specs
 * @param plan             the dedupe plan for those specs
 * @param unitResults      per-UNIT results (unitResults[u] for units[u])
 * @param sourceIdsOf      extract the source identities from a unit's result
 */
export function buildQueryAttribution<R>(
  specs: QuerySpec[],
  plan: DedupePlan,
  unitResults: R[],
  sourceIdsOf: (result: R) => string[],
): QueryAttribution[] {
  const seen = new Set<string>();
  const out: QueryAttribution[] = [];
  // A unit is "executed" at its FIRST original occurrence only.
  const unitFirstSeenAt = new Map<number, number>();
  for (let i = 0; i < plan.unitForOriginalIndex.length; i++) {
    const u = plan.unitForOriginalIndex[i];
    if (!unitFirstSeenAt.has(u)) unitFirstSeenAt.set(u, i);
  }

  for (let i = 0; i < specs.length; i++) {
    const unitIndex = plan.unitForOriginalIndex[i];
    const executed = unitFirstSeenAt.get(unitIndex) === i;
    const result = unitResults[unitIndex];
    const ids = result ? sourceIdsOf(result) || [] : [];
    const newSources: string[] = [];
    if (executed) {
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          newSources.push(id);
        }
      }
    }
    out.push({
      index: i,
      query: specs[i]?.query ?? "",
      key: plan.units[unitIndex]?.key ?? "",
      executed,
      newSources,
      totalReturned: ids.length,
    });
  }
  return out;
}

/**
 * High-level planner that ties the pieces together for a caller that wants the
 * deduped + bounded-parallel + canonical-first execution of a query list, with
 * results returned in ORIGINAL query order. The caller injects the real search
 * function (so this module stays network-free and GATE2-testable). Pure wrt I/O
 * except for invoking the injected search function.
 *
 * Returns the per-original-query results plus the plan (for attribution/telemetry).
 */
export async function runDiscoveryQueryPlan<R>(
  specs: QuerySpec[],
  search: (spec: QuerySpec, originalIndex: number) => Promise<R>,
  opts?: {
    maxParallel?: number | null;
    keyFn?: (s: QuerySpec) => string;
    isCanonical?: (u: ExecUnit<QuerySpec>) => boolean;
    onItemError?: (err: unknown, spec: QuerySpec, originalIndex: number) => R;
  },
): Promise<{ results: R[]; plan: DedupePlan; unitResults: R[] }> {
  const plan = planQueryDedupe(specs, opts?.keyFn);
  const maxParallel = resolveDiscoveryMaxParallel(opts?.maxParallel);
  const executionOrder = orderForExecution(plan.units, opts?.isCanonical || specIsCanonical);

  const unitResults = await runBoundedParallel(
    plan.units,
    (unit) => search(unit.spec, unit.index),
    maxParallel,
    {
      executionOrder,
      onItemError: opts?.onItemError
        ? (err, unit, _i) => opts.onItemError!(err, unit.spec, unit.index)
        : undefined,
    },
  );

  return { results: expandUnitResults(plan, unitResults), plan, unitResults };
}

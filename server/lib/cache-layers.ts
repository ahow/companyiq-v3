/**
 * cache-layers.ts — B4 / WP12: layered 7-level content-hash cache behind a
 * versioned kill-switch.
 *
 * WHY (plan §"B4. Layered content-hash cache (WP12)"):
 *   The pipeline recomputes the same expensive artifacts over and over across
 *   runs even when nothing that FEEDS them has changed: the same PDF bytes are
 *   re-extracted, the same extracted text re-OCR'd, the same corpus re-indexed,
 *   the same eligibility re-decided, the same evidence packs re-assembled, the
 *   same scores re-derived. Each of these layers is a PURE function of a small,
 *   enumerable set of TRUE dependencies (its inputs' content hashes). When those
 *   dependency hashes are unchanged, the output is provably identical, so the
 *   recompute is wasted work.
 *
 *   B4 adds a get-or-compute wrapper per pipeline layer, keyed by the CONTENT
 *   HASH of its true dependencies (NOT a TTL — freshness is by hash, so any
 *   change to any input hash is a natural miss that forces a recompute). It is
 *   framework-level and company/topic-agnostic: the wrapper never inspects the
 *   payload, only its injected dependency hashes.
 *
 * THE 7 LAYERS (coarse → fine; each depends on the layer(s) above it):
 *     1. bytes       — raw fetched document bytes, keyed by source URL + byte hash
 *     2. extraction  — text/structure extracted from bytes
 *     3. ocr         — OCR output for image/scanned pages
 *     4. index       — BM25 / retrieval index built over the corpus
 *     5. eligibility — the frozen eligibility decision per target (A3)
 *     6. packs       — assembled evidence packs
 *     7. scores      — derived scores / verdicts
 *   Finer layers compose the coarser layers' hashes into their own key, so a
 *   change anywhere upstream invalidates everything downstream by construction.
 *
 * HARD CORRECTNESS INVARIANTS (asserted by cache-layers.test.ts):
 *   - DETERMINISTIC EQUIVALENCE: a cache HIT returns a value byte-identical to a
 *     cold recompute. Verdicts are invariant (cold === warm).
 *   - FRESHNESS BY HASH: any change to any dependency content hash produces a
 *     different key ⇒ miss ⇒ recompute. There is no TTL and no time component.
 *   - STRICT TENANT ISOLATION: the workspace/tenant scope is part of every key,
 *     so workspace B can NEVER serve a hit from workspace A even with
 *     byte-identical content. No cross-tenant key collision is possible.
 *   - REASON-AWARE NEGATIVE CACHING: a negative outcome (e.g. "ineligible",
 *     "no-extractable-text") is cached WITH its reason and short-circuits while
 *     inputs are unchanged; because the reason-key includes the dependency
 *     hashes, any input change is a different key ⇒ the stale negative is never
 *     served (natural invalidation).
 *   - A3 COMPOSITION: the eligibility/packs/scores keys include the eligibility
 *     decision inputs, so a DIFFERING recomputed eligibility yields a different
 *     key ⇒ a cached pack/score from the old eligibility is NOT served.
 *   - A1 COMPOSITION: a reuse (hit) path must still carry the extraction_state /
 *     provenance label — a cached artifact is never returned with a NULL state
 *     (mirrors the 08b56ee invariant that reused docs stay labelled).
 *
 * VERSIONED KILL-SWITCH (mirrors discovery-parallel DISCOVERY_PARALLEL_POLICY):
 *   resolveCacheLayerPolicy() reads env CACHE_LAYER_POLICY:
 *     - "off" (DEFAULT): no caching. getOrCompute SKIPS the cache ENTIRELY and
 *                 just awaits the compute fn — byte-identical to today's pipeline.
 *     - "shadow": compute the key and record a hit/miss telemetry event, but
 *                 ALWAYS recompute and return the fresh value (never serve a hit).
 *                 Lets us measure the would-be hit rate with zero behaviour change.
 *     - "on":     serve VALIDATED hits (all dependency hashes match); otherwise
 *                 recompute and store.
 *   A typo or unrecognised value fails safe to the shipped default ("off"),
 *   never to a behaviour-changing mode.
 *
 * SAFETY: every exported function is pure/total (never throws on bad input),
 * performs no I/O of its own (the expensive work is an INJECTED compute fn so the
 * wrapper runs offline in tests), touches no DB, and never calls a model. The
 * store is a pluggable interface with a bounded in-memory default.
 */

import { hashObject } from "./run-manifest";

// ─── Policy / kill-switch ─────────────────────────────────────────────────────

export type CacheLayerPolicy = "off" | "shadow" | "on";

/**
 * DEFAULT = current production behaviour (no caching). The cache path is SKIPPED
 * ENTIRELY under this default; every getOrCompute just runs the compute fn, so
 * the pipeline is byte-identical to today. Activation is a separate, deliberately
 * gated step — this module ships OFF.
 */
export const DEFAULT_CACHE_LAYER_POLICY: CacheLayerPolicy = "off";

/** Env var name for the kill-switch (documented in the ledger). */
export const CACHE_LAYER_ENV = "CACHE_LAYER_POLICY";

/**
 * Resolve the active policy: explicit arg > env CACHE_LAYER_POLICY > default.
 * Any unrecognised value falls back to the shipped default ("off") — a typo can
 * never silently enable caching. Set CACHE_LAYER_POLICY=on (or =shadow) to
 * override without a redeploy.
 */
export function resolveCacheLayerPolicy(
  explicit?: CacheLayerPolicy | null,
): CacheLayerPolicy {
  if (explicit === "off" || explicit === "shadow" || explicit === "on") return explicit;
  const env = (process.env[CACHE_LAYER_ENV] || "").trim().toLowerCase();
  if (env === "off" || env === "shadow" || env === "on") return env as CacheLayerPolicy;
  return DEFAULT_CACHE_LAYER_POLICY;
}

/** True only when the cache serves validated hits: policy === "on". */
export function isCacheLayerEnabled(explicit?: CacheLayerPolicy | null): boolean {
  return resolveCacheLayerPolicy(explicit) === "on";
}

/** True when the cache path RUNS at all ("on" or "shadow") — i.e. not the off default. */
export function isCacheLayerActive(explicit?: CacheLayerPolicy | null): boolean {
  return resolveCacheLayerPolicy(explicit) !== "off";
}

// ─── Tunable bounds (env-overridable; safe defaults) ──────────────────────────

/**
 * Default per-layer cap on the number of distinct entries held in the in-memory
 * store. A conservative bound that prevents unbounded growth; eviction is FIFO
 * (insertion order). This only affects the default store — a caller may inject
 * its own store with a different policy.
 */
export const DEFAULT_CACHE_MAX_ENTRIES = 2048;

/** Env var name for the per-layer entry cap. */
export const CACHE_MAX_ENTRIES_ENV = "CACHE_LAYER_MAX_ENTRIES";

/**
 * Resolve the maximum entries per layer. Clamped to >= 1 (a cap of 0 or negative
 * would make every store write a no-op). Any non-numeric value falls back to the
 * default.
 */
export function resolveCacheMaxEntries(explicit?: number | null): number {
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const raw = parseInt(process.env[CACHE_MAX_ENTRIES_ENV] || "", 10);
  if (Number.isFinite(raw) && raw >= 1) return raw;
  return DEFAULT_CACHE_MAX_ENTRIES;
}

// ─── Layer identifiers ────────────────────────────────────────────────────────

/** The 7 cacheable pipeline layers, coarse → fine. */
export type CacheLayerId =
  | "bytes"
  | "extraction"
  | "ocr"
  | "index"
  | "eligibility"
  | "packs"
  | "scores";

/** Enumerated layer ids, in dependency order. */
export const CACHE_LAYER_IDS: readonly CacheLayerId[] = [
  "bytes",
  "extraction",
  "ocr",
  "index",
  "eligibility",
  "packs",
  "scores",
] as const;

// ─── Cache key construction ───────────────────────────────────────────────────

/**
 * A fully-qualified cache key input. The key is a deterministic composite of:
 *   - workspaceId: the TENANT/workspace scope (strict isolation — two workspaces
 *     with byte-identical content get DIFFERENT keys and never collide).
 *   - layerId: which of the 7 layers this entry belongs to.
 *   - dependencyHashes: the content hashes of this layer's TRUE dependencies, in
 *     caller-supplied order. Any change to any hash changes the key (freshness
 *     by hash).
 *   - extra (optional): any additional structured discriminator folded into the
 *     key via its canonical hash (e.g. the eligibility decision inputs for the
 *     eligibility/packs/scores layers — see buildEligibilityScopeHash).
 */
export interface CacheKeyInput {
  workspaceId: string | number;
  layerId: CacheLayerId;
  dependencyHashes: readonly string[];
  extra?: unknown;
}

/**
 * Field separator chosen to never appear in a sha256 hex digest, a layer id, or a
 * normal workspace id, so no two distinct inputs can alias to the same joined
 * string. (U+0001 start-of-heading.)
 */
const KEY_SEP = "\u0001";

/**
 * Build the deterministic cache key string for a layer lookup. The workspace
 * scope is ALWAYS the first field, guaranteeing tenant isolation. Dependency
 * hashes are included in order (order is significant — a layer that reorders its
 * inputs is a different computation). `extra` is folded in via its canonical
 * hash so structured discriminators are order-insensitive within themselves.
 */
export function buildCacheKey(input: CacheKeyInput): string {
  const scope = String(input.workspaceId ?? "");
  const deps = (input.dependencyHashes || []).map(h => String(h ?? "")).join(",");
  const extra = input.extra === undefined ? "" : hashObject(input.extra);
  return [scope, input.layerId, deps, extra].join(KEY_SEP);
}

/**
 * Build the eligibility-scope hash that the eligibility/packs/scores layers fold
 * into their key (A3 composition). Any difference in the recomputed eligibility
 * decision inputs (entity, issuer, source class, as-of date, policy version,
 * scope) yields a different hash ⇒ a different key ⇒ a pack/score cached under
 * the OLD eligibility is never served. Pure canonical hash — field order and
 * key insertion order do not matter.
 */
export function buildEligibilityScopeHash(decision: unknown): string {
  return hashObject(decision ?? null);
}

// ─── Store interface + bounded in-memory default ──────────────────────────────

/**
 * A cached entry. `value` is the recomputed payload. `provenance` carries the
 * A1 extraction_state / provenance label that MUST survive a reuse (never NULL):
 * a cache hit returns the value AND its provenance so a downstream reuse path can
 * re-label the artifact exactly as the cold path would have.
 */
export interface CacheEntry<V> {
  value: V;
  /** A1: extraction_state / provenance label carried across a reuse. */
  provenance?: Record<string, unknown>;
}

/** Pluggable store. The default is a bounded in-memory Map; callers may inject. */
export interface CacheStore<V = unknown> {
  get(key: string): CacheEntry<V> | undefined;
  set(key: string, entry: CacheEntry<V>): void;
  has(key: string): boolean;
  /** Number of live entries (for bound enforcement / telemetry). */
  readonly size: number;
}

/**
 * Bounded in-memory store with FIFO eviction. Total and side-effect-free beyond
 * its own Map. When `maxEntries` is reached, the oldest inserted key is dropped.
 * Re-setting an existing key refreshes its value without changing eviction order.
 */
export class InMemoryCacheStore<V = unknown> implements CacheStore<V> {
  private readonly map = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;

  constructor(maxEntries?: number) {
    this.maxEntries = resolveCacheMaxEntries(maxEntries);
  }

  get(key: string): CacheEntry<V> | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  set(key: string, entry: CacheEntry<V>): void {
    if (!this.map.has(key)) {
      while (this.map.size >= this.maxEntries) {
        const oldest = this.map.keys().next().value;
        if (oldest === undefined) break;
        this.map.delete(oldest);
      }
    }
    this.map.set(key, entry);
  }

  get size(): number {
    return this.map.size;
  }
}

// ─── Telemetry ────────────────────────────────────────────────────────────────

export type CacheOutcome = "hit" | "miss" | "skip" | "shadow-hit" | "shadow-miss";

/** A single get-or-compute telemetry event (shadow mode records these). */
export interface CacheTelemetryEvent {
  layerId: CacheLayerId;
  key: string;
  outcome: CacheOutcome;
  /** True when the entry is a negative (reason-aware) cache entry. */
  negative?: boolean;
}

/** Optional telemetry sink injected by the caller (shadow + on both emit). */
export type CacheTelemetrySink = (event: CacheTelemetryEvent) => void;

// ─── get-or-compute (positive) ────────────────────────────────────────────────

export interface GetOrComputeArgs<V> {
  store: CacheStore<V>;
  workspaceId: string | number;
  layerId: CacheLayerId;
  /** Content hashes of this layer's TRUE dependencies (freshness by hash). */
  dependencyHashes: readonly string[];
  /** Optional structured discriminator folded into the key (e.g. A3 scope). */
  extra?: unknown;
  /** The expensive recompute. Returns the value AND its provenance (A1 label). */
  compute: () => Promise<CacheEntry<V>> | CacheEntry<V>;
  /** Explicit policy override (else resolved from env / default). */
  policy?: CacheLayerPolicy | null;
  /** Optional telemetry sink. */
  telemetry?: CacheTelemetrySink;
}

export interface GetOrComputeResult<V> {
  value: V;
  provenance?: Record<string, unknown>;
  outcome: CacheOutcome;
  key: string;
}

/**
 * Get-or-compute for one layer, keyed by true-dependency content hashes.
 *
 *   - policy "off"    : SKIP the cache entirely; just run compute (today's path).
 *                       Returns outcome "skip". Byte-identical to no cache.
 *   - policy "shadow" : build the key, record would-be hit/miss telemetry, but
 *                       ALWAYS recompute and return the fresh value. Never serves
 *                       a hit. (The store is still populated so hit-rate is real.)
 *   - policy "on"     : serve a validated hit if the key is present (all
 *                       dependency hashes matched by construction); else recompute
 *                       and store.
 *
 * A HIT returns the stored value AND its provenance unchanged — byte-identical to
 * a cold recompute (deterministic equivalence) and still carrying the A1 label.
 */
export async function getOrCompute<V>(args: GetOrComputeArgs<V>): Promise<GetOrComputeResult<V>> {
  const policy = resolveCacheLayerPolicy(args.policy);
  const key = buildCacheKey({
    workspaceId: args.workspaceId,
    layerId: args.layerId,
    dependencyHashes: args.dependencyHashes,
    extra: args.extra,
  });

  // OFF: skip the cache entirely — identical to the pre-cache pipeline.
  if (policy === "off") {
    const fresh = await args.compute();
    return { value: fresh.value, provenance: fresh.provenance, outcome: "skip", key };
  }

  const existing = args.store.get(key);

  // SHADOW: record the would-be outcome but always return fresh.
  if (policy === "shadow") {
    const outcome: CacheOutcome = existing ? "shadow-hit" : "shadow-miss";
    args.telemetry?.({ layerId: args.layerId, key, outcome });
    const fresh = await args.compute();
    // Keep the store warm so the measured hit-rate reflects reality.
    args.store.set(key, { value: fresh.value, provenance: fresh.provenance });
    return { value: fresh.value, provenance: fresh.provenance, outcome, key };
  }

  // ON: serve a validated hit, else compute + store.
  if (existing) {
    args.telemetry?.({ layerId: args.layerId, key, outcome: "hit" });
    return { value: existing.value, provenance: existing.provenance, outcome: "hit", key };
  }
  args.telemetry?.({ layerId: args.layerId, key, outcome: "miss" });
  const fresh = await args.compute();
  args.store.set(key, { value: fresh.value, provenance: fresh.provenance });
  return { value: fresh.value, provenance: fresh.provenance, outcome: "miss", key };
}

// ─── get-or-compute (reason-aware negative cache) ─────────────────────────────

/**
 * A negative outcome cached WITH its reason. A negative short-circuits the
 * expensive compute while inputs are unchanged. Because the key includes the
 * dependency hashes, any input change produces a DIFFERENT key, so a stale
 * negative can never be served after its inputs change (natural invalidation).
 */
export interface NegativeEntry {
  negative: true;
  reason: string;
  provenance?: Record<string, unknown>;
}

/** Either a positive value or a reason-aware negative. */
export type MaybeNegative<V> =
  | { negative: false; value: V; provenance?: Record<string, unknown> }
  | NegativeEntry;

export interface GetOrComputeNegativeArgs<V> {
  store: CacheStore<MaybeNegative<V>>;
  workspaceId: string | number;
  layerId: CacheLayerId;
  dependencyHashes: readonly string[];
  extra?: unknown;
  /** Compute that may itself decide the outcome is negative (with a reason). */
  compute: () => Promise<MaybeNegative<V>> | MaybeNegative<V>;
  policy?: CacheLayerPolicy | null;
  telemetry?: CacheTelemetrySink;
}

export interface GetOrComputeNegativeResult<V> {
  result: MaybeNegative<V>;
  outcome: CacheOutcome;
  key: string;
}

/**
 * Get-or-compute with reason-aware negative caching. Same policy semantics as
 * getOrCompute: "off" skips, "shadow" records but always recomputes, "on" serves
 * validated hits (positive OR negative). A served negative short-circuits the
 * compute entirely.
 */
export async function getOrComputeNegative<V>(
  args: GetOrComputeNegativeArgs<V>,
): Promise<GetOrComputeNegativeResult<V>> {
  const policy = resolveCacheLayerPolicy(args.policy);
  const key = buildCacheKey({
    workspaceId: args.workspaceId,
    layerId: args.layerId,
    dependencyHashes: args.dependencyHashes,
    extra: args.extra,
  });

  if (policy === "off") {
    const fresh = await args.compute();
    return { result: fresh, outcome: "skip", key };
  }

  const existing = args.store.get(key);

  if (policy === "shadow") {
    const outcome: CacheOutcome = existing ? "shadow-hit" : "shadow-miss";
    args.telemetry?.({
      layerId: args.layerId,
      key,
      outcome,
      negative: existing?.value.negative === true,
    });
    const fresh = await args.compute();
    args.store.set(key, { value: fresh });
    return { result: fresh, outcome, key };
  }

  if (existing) {
    args.telemetry?.({
      layerId: args.layerId,
      key,
      outcome: "hit",
      negative: existing.value.negative === true,
    });
    return { result: existing.value, outcome: "hit", key };
  }
  args.telemetry?.({ layerId: args.layerId, key, outcome: "miss" });
  const fresh = await args.compute();
  args.store.set(key, { value: fresh });
  return { result: fresh, outcome: "miss", key };
}

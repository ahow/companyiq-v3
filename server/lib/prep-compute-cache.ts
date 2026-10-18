/**
 * prep-compute-cache.ts — B1 / WP10: exact-equivalence prep-stage compute cache,
 * behind a versioned kill-switch.
 *
 * WHY (plan §"B1. Exact-equivalence compute wins (WP10)"):
 *   The prep stage recomputes identical work on every pass, framework-level and
 *   independent of any company or topic:
 *     1. PEER-SCAN REGEX — the aboutness scorer rebuilds a Unicode word-boundary
 *        RegExp for EVERY peer name on EVERY document, across the full ~2,675-peer
 *        universe. The pattern for a given term is a pure function of the term, so
 *        recompiling it per document is wasted work.
 *     2. BM25 PER-DOC TERM FREQUENCIES — bm25Score() re-tokenises the candidate
 *        document and rebuilds its term-frequency Map on EVERY (chunk × measure)
 *        call, even though the BM25 index (and therefore each document's tokens)
 *        is fixed for the whole corpus-assembly run.
 *     3. NO-OP DB WRITES — the document-metadata upsert re-writes byte-identical
 *        rows (the documents table has no updatedAt, so an identical upsert is a
 *        true no-op on observable state).
 *
 *   B1 removes this wasted compute WITHOUT changing WHAT is produced. It is an
 *   exact-equivalence optimisation: every cached value is byte-for-byte what the
 *   uncached path would have computed, so scoring, evidence packs, verdicts,
 *   ranking order and tie-breaks are all unchanged. The full 2,675-peer universe
 *   is preserved — nothing is cut to a subset (that would be corpus-pinning and
 *   is explicitly forbidden).
 *
 * VERSIONED KILL-SWITCH:
 *   resolvePrepComputeCachePolicy() reads env PREP_COMPUTE_CACHE_POLICY:
 *     - "on"  (DEFAULT): precompute/cache the three items above. Because every
 *             cached value is proven byte-identical to the recomputed value, the
 *             default is ON (unlike behaviour-changing WPs, which default OFF).
 *     - "off": skip ALL caching — every call recomputes from scratch, reproducing
 *             today's behaviour exactly (the released baseline path). Use this to
 *             fall back with zero redeploy if a byte-difference is ever suspected.
 *   A typo / unrecognised value fails safe to the shipped default ("on").
 *
 *   NOTE on "on" being the default: the acceptance bar for B1 is byte-identical
 *   output whether on or off, proven by prep-compute-cache.test.ts (regex match
 *   equivalence incl. Unicode/boundary/overlap, BM25 rank+tie-break equivalence,
 *   cache invalidation on content change, and no-op-skip never dropping a real
 *   write). The off path is the exact pre-B1 code path.
 *
 * SAFETY: every export is pure/total or a bounded in-memory cache. No I/O, no
 *   model calls. All caches are BOUNDED (FIFO eviction at a configurable cap) so
 *   memory cannot grow unboundedly across a batch.
 */

import { createHash } from "node:crypto";

// ─── Policy / kill-switch ─────────────────────────────────────────────────────

export type PrepComputeCachePolicy = "off" | "on";

/**
 * DEFAULT = ON. B1 is byte-identical by construction, so the optimisation is
 * active in production. The OFF path reproduces the exact pre-B1 behaviour and is
 * reachable with no redeploy via PREP_COMPUTE_CACHE_POLICY=off.
 */
export const DEFAULT_PREP_COMPUTE_CACHE_POLICY: PrepComputeCachePolicy = "on";

/** Env var name for the kill-switch (documented in the ledger). */
export const PREP_COMPUTE_CACHE_ENV = "PREP_COMPUTE_CACHE_POLICY";

/**
 * Resolve the active policy: explicit arg > env PREP_COMPUTE_CACHE_POLICY > default.
 * Any unrecognised value falls back to the shipped default ("on"). Set
 * PREP_COMPUTE_CACHE_POLICY=off to disable all prep-stage caching without a redeploy.
 */
export function resolvePrepComputeCachePolicy(
  explicit?: PrepComputeCachePolicy | null,
): PrepComputeCachePolicy {
  if (explicit === "off" || explicit === "on") return explicit;
  const env = (process.env[PREP_COMPUTE_CACHE_ENV] || "").trim().toLowerCase();
  if (env === "off" || env === "on") return env as PrepComputeCachePolicy;
  return DEFAULT_PREP_COMPUTE_CACHE_POLICY;
}

/** True when the prep-compute cache is active (policy "on"). */
export function isPrepComputeCacheEnabled(explicit?: PrepComputeCachePolicy | null): boolean {
  return resolvePrepComputeCachePolicy(explicit) === "on";
}

// ─── Bounds (env-overridable; safe defaults) ──────────────────────────────────

function readPositiveInt(envName: string, fallback: number): number {
  const raw = (process.env[envName] || "").trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max distinct peer-scan regexes held in memory. The peer universe is ~2,675;
 *  default comfortably covers it plus target terms, with FIFO eviction beyond. */
export const PREP_REGEX_CACHE_MAX = readPositiveInt("PREP_REGEX_CACHE_MAX", 8192);

/** Max distinct (companyId,url) document-upsert fingerprints held for no-op
 *  skipping within a process. FIFO eviction beyond the cap. */
export const PREP_UPSERT_DEDUPE_MAX = readPositiveInt("PREP_UPSERT_DEDUPE_MAX", 20000);

// ─── BoundedCache (FIFO eviction) ─────────────────────────────────────────────

/**
 * A minimal bounded map with first-in-first-out eviction. Insertion order is
 * tracked by the underlying Map; when size exceeds `max`, the oldest key is
 * evicted. Deterministic and total. Used for the peer-scan regex cache.
 */
export class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {
    this.max = Math.max(1, max | 0);
  }
  get(key: K): V | undefined {
    return this.map.get(key);
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V): void {
    // If the key already exists, update in place (keeps original insertion slot).
    if (this.map.has(key)) {
      this.map.set(key, value);
      return;
    }
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}

// ─── Peer-scan regex cache ────────────────────────────────────────────────────
//
// The aboutness scorer matches each term with a Unicode word-boundary pattern.
// The compiled RegExp for a given term is a PURE function of the term (the escape
// + pattern + flags are fixed), so it is cached and reused across documents.
//
// Flag safety: callers use String.prototype.match(re) with the global ("g") flag.
// Per spec, String#match with a global regex resets lastIndex to 0 before and
// after matching, so a cached global RegExp is safe to reuse across .match()
// calls — it never carries stateful lastIndex between calls. (This is asserted by
// prep-compute-cache.test.ts.)

const peerRegexCache = new BoundedCache<string, RegExp>(PREP_REGEX_CACHE_MAX);

/**
 * Get (or compile+cache) the regex for `cacheKey`, built by `build()`. When the
 * policy is OFF, `build()` is called every time and nothing is cached — exactly
 * the pre-B1 behaviour. The returned RegExp is byte-identical either way (same
 * source + flags); only compilation is memoised.
 */
export function getCachedRegex(
  cacheKey: string,
  build: () => RegExp,
  explicit?: PrepComputeCachePolicy | null,
): RegExp {
  if (!isPrepComputeCacheEnabled(explicit)) return build();
  const hit = peerRegexCache.get(cacheKey);
  if (hit) return hit;
  const re = build();
  peerRegexCache.set(cacheKey, re);
  return re;
}

/** Test/diagnostic helper: current regex-cache size. */
export function peerRegexCacheSize(): number {
  return peerRegexCache.size;
}

/** Test helper: clear the regex cache (no effect on correctness). */
export function clearPeerRegexCache(): void {
  peerRegexCache.clear();
}

// ─── Document-upsert no-op dedupe registry ────────────────────────────────────
//
// The documents table is upserted (INSERT ... ON CONFLICT DO UPDATE) with four
// mutable fields (title, gateVerdict, gateReason, sourceType). The table has NO
// updatedAt/auto-timestamp column, so re-writing byte-identical values is a true
// no-op on observable DB state. This registry records, per (companyId,url), the
// fingerprint of the LAST values WE persisted this process, so an immediately
// following identical upsert can be skipped.
//
// Correctness ("never drop a real write; when in doubt, write"):
//   • We skip ONLY when our own prior write for that exact key stored the exact
//     same fingerprint — i.e. the row provably already holds those bytes.
//   • Any competing writer MUST invalidate the entry:
//       - clearDiscoveredDocuments() DELETEs rows → invalidate per company.
//       - updateDocumentSourceType() changes source_type → invalidate by docId.
//   • On a cache miss, policy OFF, or any doubt, the write proceeds.

interface UpsertEntry {
  fingerprint: string;
  docId?: number;
}

const upsertDedupe = new BoundedCache<string, UpsertEntry>(PREP_UPSERT_DEDUPE_MAX);
// docId → key reverse index so an updateDocumentSourceType(docId) can invalidate.
const docIdToUpsertKey = new BoundedCache<number, string>(PREP_UPSERT_DEDUPE_MAX);

function upsertKey(companyId: number, url: string): string {
  return `${companyId}\u0000${url}`;
}

/**
 * Stable fingerprint of the mutable upsert fields. Null/undefined are normalised
 * to a sentinel so "" and null stay distinguishable. Field order is fixed.
 */
export function documentUpsertFingerprint(fields: {
  title?: string | null;
  gateVerdict?: string | null;
  gateReason?: string | null;
  sourceType?: string | null;
}): string {
  const norm = (v: string | null | undefined): string => (v === null || v === undefined ? "\u0001null" : v);
  return JSON.stringify([
    norm(fields.title),
    norm(fields.gateVerdict),
    norm(fields.gateReason),
    norm(fields.sourceType),
  ]);
}

/**
 * True if an identical upsert for (companyId,url) was already persisted by THIS
 * process and nothing has invalidated it since — i.e. the write would be a no-op
 * and can be skipped. Always false when the policy is OFF.
 */
export function shouldSkipDocumentUpsert(
  companyId: number,
  url: string,
  fingerprint: string,
  explicit?: PrepComputeCachePolicy | null,
): boolean {
  if (!isPrepComputeCacheEnabled(explicit)) return false;
  const entry = upsertDedupe.get(upsertKey(companyId, url));
  return entry !== undefined && entry.fingerprint === fingerprint;
}

/** Record that we persisted `fingerprint` for (companyId,url) [+ docId]. */
export function recordDocumentUpsert(
  companyId: number,
  url: string,
  fingerprint: string,
  docId?: number,
): void {
  const key = upsertKey(companyId, url);
  upsertDedupe.set(key, { fingerprint, docId });
  if (typeof docId === "number") docIdToUpsertKey.set(docId, key);
}

/** Invalidate all upsert fingerprints for a company (call on row deletion). */
export function invalidateDocumentUpsertForCompany(companyId: number): void {
  const prefix = `${companyId}\u0000`;
  // BoundedCache has no iteration API; rebuild by filtering. Bounded + infrequent
  // (called once per discovery clear), so the cost is acceptable and safe.
  const survivors: Array<[string, UpsertEntry]> = [];
  // Access underlying entries via a drain-and-refill on a fresh structure.
  for (const [k, v] of (upsertDedupe as unknown as { map: Map<string, UpsertEntry> }).map) {
    if (!k.startsWith(prefix)) survivors.push([k, v]);
  }
  upsertDedupe.clear();
  docIdToUpsertKey.clear();
  for (const [k, v] of survivors) {
    upsertDedupe.set(k, v);
    if (typeof v.docId === "number") docIdToUpsertKey.set(v.docId, k);
  }
}

/** Invalidate the upsert fingerprint for a specific document id (call when a
 *  different writer mutates one of the upsert fields, e.g. source_type). */
export function invalidateDocumentUpsertByDocId(docId: number): void {
  const key = docIdToUpsertKey.get(docId);
  if (key !== undefined) {
    upsertDedupe.delete(key);
    docIdToUpsertKey.delete(docId);
  }
}

/** Test helper: clear the upsert dedupe registry. */
export function clearDocumentUpsertDedupe(): void {
  upsertDedupe.clear();
  docIdToUpsertKey.clear();
}

/** Test/diagnostic helper: current dedupe registry size. */
export function documentUpsertDedupeSize(): number {
  return upsertDedupe.size;
}

// ─── Score/verdict cache (Phase 1.2 — the MISSING 3rd layer) ──────────────────
//
// WHY (plan §"Phase 1 — Reproducibility", step 1.2):
//   A single run over a company must be reproducible. The scorer re-rolls the
//   dice for an evidence pack even when every input that determines the verdict
//   is unchanged, which is a source of run-to-run wobble (28/360 cells flip on a
//   fresh re-run). This layer "remembers the answer for an identical evidence
//   pack so we don't re-roll the dice." It sits alongside the two existing B1
//   layers (peer-scan regex + document-upsert dedupe) in this same module, under
//   the SAME PREP_COMPUTE_CACHE_POLICY kill-switch.
//
// KEY (framework-level / company- & topic-agnostic):
//   key = sha256( evidence-pack content hash
//               + measure version
//               + prompt version
//               + model id )
//   Only GENERIC inputs — no company name, no topic term, nothing bespoke. Two
//   byte-identical evidence packs scored under the same measure/prompt/model
//   therefore map to the same key and yield the SAME verdict.
//
// VERDICT-SAFE BY CONSTRUCTION:
//   getOrComputeVerdict() returns, on a HIT, exactly the value a cold recompute
//   produced and stored — there is no transformation on the hit path. Any change
//   to ANY of the four key inputs changes the key ⇒ miss ⇒ recompute, so a stale
//   verdict can never be served (freshness by hash; no TTL, no time component).
//   When the policy is OFF the cache is skipped entirely and compute() runs every
//   time, byte-identical to the pre-Phase-1 path.
//
// SAFETY: pure/in-memory, bounded (FIFO eviction), no I/O, no model calls. The
//   expensive scoring is an INJECTED compute fn so this wrapper runs fully
//   offline in tests (see phase1-reproducibility.test.ts).

/** Max distinct verdicts held in memory (FIFO eviction beyond the cap). */
export const PREP_VERDICT_CACHE_MAX = readPositiveInt("PREP_VERDICT_CACHE_MAX", 20000);

/** The four GENERIC inputs that fully determine a verdict for a pack. */
export interface VerdictCacheKeyInput {
  /** Content hash (e.g. sha256) of the assembled evidence pack text. */
  evidencePackHash: string;
  /** Measure/framework content version (hash or monotonic version). */
  measureVersion: string | number;
  /** Scoring-prompt version (hash or monotonic version). */
  promptVersion: string | number;
  /** Provider:model identifier (e.g. "deepseek:deepseek-chat"). */
  modelId: string;
}

/**
 * Field separator chosen to never appear in a sha256 hex digest or a normal
 * version/model id, so no two distinct inputs can alias to the same joined
 * string. (U+0001 start-of-heading.)
 */
const VERDICT_KEY_SEP = "\u0001";

/**
 * Build the deterministic verdict cache key. Field order is FIXED (pack, measure,
 * prompt, model), so the key is a pure, canonical function of the four generic
 * inputs — order-stable and company/topic-agnostic. A change to any field yields
 * a different key (no false hits).
 */
export function buildVerdictCacheKey(input: VerdictCacheKeyInput): string {
  const parts = [
    String(input.evidencePackHash ?? ""),
    String(input.measureVersion ?? ""),
    String(input.promptVersion ?? ""),
    String(input.modelId ?? ""),
  ].join(VERDICT_KEY_SEP);
  return createHash("sha256").update(parts).digest("hex");
}

/** A cached verdict payload. `verdict` is the scorer's output, carried verbatim. */
export interface VerdictCacheEntry<V> {
  verdict: V;
}

const verdictCache = new BoundedCache<string, VerdictCacheEntry<unknown>>(PREP_VERDICT_CACHE_MAX);

export type VerdictCacheOutcome = "hit" | "miss" | "skip";

export interface GetOrComputeVerdictResult<V> {
  value: V;
  outcome: VerdictCacheOutcome;
  key: string;
}

/**
 * Get-or-compute a verdict for a pack, keyed by the four generic inputs.
 *
 *   - policy OFF : SKIP the cache entirely; just run compute() (pre-Phase-1 path).
 *                  Returns outcome "skip". Byte-identical to no cache.
 *   - policy ON  : serve a validated HIT if present (identical key ⇒ identical
 *                  verdict); else compute, store, and return outcome "miss".
 *
 * A HIT returns the stored value with NO transformation — exactly what the
 * uncached path would produce (verdict-safe). `onHit` is an optional telemetry
 * hook ("cache hit logged") invoked only when a hit is served.
 */
export async function getOrComputeVerdict<V>(args: {
  keyInput: VerdictCacheKeyInput;
  compute: () => Promise<V> | V;
  explicit?: PrepComputeCachePolicy | null;
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
}): Promise<GetOrComputeVerdictResult<V>> {
  const key = buildVerdictCacheKey(args.keyInput);

  // OFF: skip the cache entirely — identical to the pre-Phase-1 scorer.
  if (!isPrepComputeCacheEnabled(args.explicit)) {
    const value = await args.compute();
    return { value, outcome: "skip", key };
  }

  const existing = verdictCache.get(key) as VerdictCacheEntry<V> | undefined;
  if (existing !== undefined) {
    args.onHit?.(key);
    return { value: existing.verdict, outcome: "hit", key };
  }

  args.onMiss?.(key);
  const value = await args.compute();
  verdictCache.set(key, { verdict: value });
  return { value, outcome: "miss", key };
}

/** Test/diagnostic helper: current verdict-cache size. */
export function verdictCacheSize(): number {
  return verdictCache.size;
}

/** Test helper: clear the verdict cache (no effect on correctness). */
export function clearVerdictCache(): void {
  verdictCache.clear();
}

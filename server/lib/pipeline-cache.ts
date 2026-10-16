/**
 * pipeline-cache.ts — B4 / WP12: the WIRING layer that connects the standalone
 * cache-layers.ts primitive to the real pipeline seams.
 *
 * WHY THIS FILE EXISTS
 *   cache-layers.ts ships a correct, fully-tested get-or-compute primitive, but
 *   it is STANDALONE — nothing in the pipeline calls it, so it eliminates no
 *   redundant work. This module is the thin, framework-level glue that invokes
 *   getOrCompute at the pipeline's expensive seams, each call STRICTLY GATED by
 *   the same CACHE_LAYER_POLICY kill-switch so that the SHIPPED DEFAULT ("off")
 *   is byte-identical to today's pipeline.
 *
 *   The gating is free: getOrCompute with policy "off" SKIPS the cache entirely
 *   and just awaits the injected compute fn (see cache-layers.ts). So wrapping a
 *   seam in one of these helpers is a provable pass-through at the default — the
 *   wrapped expression runs exactly as it did before, with the same inputs, the
 *   same return value, and zero cache interaction.
 *
 * WHICH SEAMS ARE WIRED HERE (and why only these)
 *   WIRED:
 *     - bytes  (cacheDocumentFetch) — the per-document fetch+extract result,
 *       keyed by {workspace, source-url, as-of}. This is the single biggest
 *       lever: a hit skips the network fetch AND the downstream pdf-parse /
 *       pdftotext / OCR extraction for a source already fetched for this
 *       workspace. Tenant scope (workspaceId) is available at the call site
 *       (runFetchPhase); the fetched/extracted text is a deterministic function
 *       of the source content, so a hit is byte-identical to a cold fetch.
 *     - index  (cacheRetrievalIndex) — the BM25-selected retrieval corpus built
 *       by summarizeDocuments, keyed by {workspace, pipeline-version,
 *       content-hash of the doc set}. The corpus is a PURE, deterministic
 *       function of the (normalised) document texts (no model call — the model
 *       tag is "bm25-headers-*"), so a hit is byte-identical.
 *
 *   DEFERRED (documented honestly — not wired in this step):
 *     - extraction / ocr as STANDALONE content-hash layers: processor.ts carries
 *       no workspace/tenant scope at all (OperationScope does not either), so a
 *       tenant-isolated extraction cache would require threading workspaceId
 *       through processDocument and ~10 internal extract call sites plus the test
 *       fixtures, risking the A4 (.text byte-identical to every caller) and A1
 *       (provenance never NULL) invariants. The bytes seam already caches the
 *       POST-extraction text per {workspace, url}, so a bytes hit transitively
 *       skips extraction+OCR anyway — the lever is captured without the invasive
 *       wiring.
 *     - eligibility: the A3 recompute-per-target enforcement shipped recently; a
 *       per-target cache key must capture the full per-target decision scope or
 *       it risks serving a stale decision, which would break A3. Too high-risk
 *       for a default-off wiring step.
 *     - packs: composes the RESOLVED eligibility decision into its key; with
 *       eligibility deferred the key cannot be fully/safely composed.
 *     - scores: the LLM scoring path uses self-consistency sampling + a provider
 *       cascade and is NOT deterministic across cold runs, so cold===warm
 *       byte-identity is not a property of the compute itself — caching it would
 *       change determinism characteristics rather than preserve them.
 *
 * SAFETY: this module performs no I/O, touches no DB, and calls no model. The
 * expensive work is always the caller's INJECTED compute fn. Every helper
 * delegates to the cache-layers primitive, whose policy semantics (off/shadow/on)
 * and tenant-isolation / freshness-by-hash invariants are asserted by
 * cache-layers.test.ts and re-asserted end-to-end by cache-wiring.test.ts.
 */

import { createHash } from "crypto";
import {
  InMemoryCacheStore,
  getOrCompute,
  type CacheEntry,
  type CacheStore,
  type CacheLayerPolicy,
  type CacheTelemetrySink,
} from "./cache-layers.js";

// ─── sha256 helper (dependency-hash construction) ─────────────────────────────

/** Deterministic sha256 hex of a string (used to hash a source URL / id). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(String(s ?? "")).digest("hex");
}

// ─── Per-layer singleton stores (lazy, env-bounded) ───────────────────────────
//
// One bounded in-memory store per WIRED layer, shared across the process so a
// hit from an earlier document/run is visible to a later one. Lazy-initialised
// so the default-off pipeline never even allocates them (the off path in
// getOrCompute never calls store.get/set), and resettable for tests.

let bytesStore: InMemoryCacheStore<string> | null = null;
let indexStore: InMemoryCacheStore<unknown> | null = null;

function getBytesStore(): InMemoryCacheStore<string> {
  if (!bytesStore) bytesStore = new InMemoryCacheStore<string>();
  return bytesStore;
}

function getIndexStore(): InMemoryCacheStore<unknown> {
  if (!indexStore) indexStore = new InMemoryCacheStore<unknown>();
  return indexStore;
}

/**
 * Drop all wired-layer stores. Test-only: lets each test start from a cold cache
 * so cold-vs-warm behaviour is deterministic regardless of execution order.
 */
export function __resetPipelineCachesForTest(): void {
  bytesStore = null;
  indexStore = null;
}

// ─── bytes seam ───────────────────────────────────────────────────────────────

export interface CacheDocumentFetchArgs {
  /** Tenant/workspace scope — strict isolation (part of every key). */
  workspaceId: string | number;
  /** The source URL (or stable source id) being fetched. */
  sourceUrl: string;
  /**
   * Optional as-of discriminator (e.g. reporting-period / run date). When the
   * caller wants fresh bytes for a new period, pass a changed value → new key →
   * natural miss. Omit for a pure {workspace, url} key.
   */
  asOf?: string;
  /** The expensive fetch+extract. Returns the extracted document text. */
  compute: () => Promise<string>;
  /** Explicit policy override (else resolved from env / default "off"). */
  policy?: CacheLayerPolicy | null;
  /** Optional telemetry sink (shadow + on emit). */
  telemetry?: CacheTelemetrySink;
  /** Optional injected store (tests); defaults to the process singleton. */
  store?: CacheStore<string>;
}

/**
 * bytes layer: get-or-compute the fetched+extracted text for one source,
 * tenant-isolated by workspace and keyed by the source URL (+ optional as-of).
 *
 * DEFAULT ("off"): runs `compute()` directly and returns its result — the
 * network fetch and all extraction happen exactly as they do today, with zero
 * cache interaction. Under "on", a second call for the same {workspace, url}
 * serves the stored text and skips the fetch+extract entirely.
 */
export async function cacheDocumentFetch(args: CacheDocumentFetchArgs): Promise<string> {
  const res = await getOrCompute<string>({
    store: args.store ?? getBytesStore(),
    workspaceId: args.workspaceId,
    layerId: "bytes",
    dependencyHashes: [sha256Hex(args.sourceUrl)],
    extra: args.asOf === undefined ? undefined : { asOf: args.asOf },
    policy: args.policy,
    telemetry: args.telemetry,
    compute: async () => ({ value: await args.compute() }),
  });
  return res.value;
}

// ─── index seam ───────────────────────────────────────────────────────────────

export interface CacheRetrievalIndexArgs<V> {
  /** Tenant/workspace scope (the company/workspace id is fine). */
  workspaceId: string | number;
  /**
   * Content hashes of this layer's TRUE dependencies — e.g. a content-stable
   * hash of the document-set texts. Any change ⇒ different key ⇒ miss.
   */
  dependencyHashes: readonly string[];
  /**
   * Structured discriminator folded into the key (e.g. pipeline / tokenizer
   * version salt) so a code change that alters retrieval invalidates the entry.
   */
  extra?: unknown;
  /** The deterministic BM25 corpus build. Returns the value (+ optional provenance). */
  compute: () => Promise<V> | V;
  policy?: CacheLayerPolicy | null;
  telemetry?: CacheTelemetrySink;
  store?: CacheStore<V>;
}

/**
 * index layer: get-or-compute the deterministic BM25 retrieval corpus for a
 * document set, tenant-isolated by workspace and keyed by the content hash of
 * the doc set (+ version salt).
 *
 * DEFAULT ("off"): runs `compute()` directly and returns its result byte-for-
 * byte — the corpus is built exactly as today. Under "on", an identical doc set
 * (same content hash) for the same workspace serves the stored corpus.
 */
export async function cacheRetrievalIndex<V>(args: CacheRetrievalIndexArgs<V>): Promise<V> {
  const res = await getOrCompute<V>({
    store: (args.store ?? (getIndexStore() as unknown as CacheStore<V>)),
    workspaceId: args.workspaceId,
    layerId: "index",
    dependencyHashes: args.dependencyHashes,
    extra: args.extra,
    policy: args.policy,
    telemetry: args.telemetry,
    compute: async () => {
      const value = await args.compute();
      return { value } as CacheEntry<V>;
    },
  });
  return res.value;
}

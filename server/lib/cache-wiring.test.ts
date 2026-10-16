/**
 * cache-wiring.test.ts — B4/WP12: INTEGRATION tests for the pipeline-cache
 * wiring helpers that connect the cache-layers primitive to the real pipeline
 * seams (server/lib/pipeline-cache.ts).
 *
 * These tests prove, at EACH WIRED SEAM (bytes, index), the four acceptance
 * properties the task requires:
 *   (a) policy "off" (shipped default): the compute runs DIRECTLY, the result is
 *       byte-identical to a bare call, and there is ZERO cache interaction
 *       (no store.get / store.set / store.has) — a provable pass-through.
 *   (b) policy "on": a 2nd identical call is served from cache and equals the
 *       cold result (deterministic equivalence); a CHANGED input hash is a miss
 *       that recomputes (freshness by hash).
 *   (c) policy "shadow": always returns a fresh recompute, even on a would-be hit
 *       (zero behaviour change; store still warmed for hit-rate measurement).
 *   (d) strict tenant isolation: workspace B never serves a hit from workspace A,
 *       even with byte-identical inputs.
 *
 * Offline + free: the "expensive" compute at each seam is a stub counter, and the
 * store is an instrumented in-memory store — no network, DB, or model. Run with:
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/cache-wiring.test.ts
 */

import assert from "node:assert";
import { InMemoryCacheStore, type CacheEntry, type CacheStore } from "./cache-layers";
import { cacheDocumentFetch, cacheRetrievalIndex, sha256Hex } from "./pipeline-cache";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${name}`);
      console.error(`    ${(err as Error).message}`);
    }
  })();
}

/**
 * An in-memory store wrapper that COUNTS every get/set/has so a test can assert
 * "zero cache interaction" under the off default, and inspect hit/miss behaviour
 * under on/shadow.
 */
class CountingStore<V> implements CacheStore<V> {
  gets = 0;
  sets = 0;
  hasCalls = 0;
  private readonly inner: InMemoryCacheStore<V>;
  constructor(max?: number) {
    this.inner = new InMemoryCacheStore<V>(max);
  }
  get(key: string): CacheEntry<V> | undefined {
    this.gets++;
    return this.inner.get(key);
  }
  set(key: string, entry: CacheEntry<V>): void {
    this.sets++;
    this.inner.set(key, entry);
  }
  has(key: string): boolean {
    this.hasCalls++;
    return this.inner.has(key);
  }
  get size(): number {
    return this.inner.size;
  }
  get touches(): number {
    return this.gets + this.sets + this.hasCalls;
  }
}

async function main() {
  console.log("cache-wiring.test.ts — B4/WP12 pipeline-cache seam wiring\n");

  // ─────────────────────────────────────────────────────────────────────────
  // BYTES SEAM (cacheDocumentFetch) — pipeline.ts runFetchPhase processDocument
  // ─────────────────────────────────────────────────────────────────────────

  await test("bytes/off: compute runs directly, byte-identical, ZERO cache interaction", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => {
      computes++;
      return "EXTRACTED TEXT for https://x/doc.pdf";
    };
    const a = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/doc.pdf", compute, store, policy: "off" });
    const b = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/doc.pdf", compute, store, policy: "off" });
    assert.equal(a, "EXTRACTED TEXT for https://x/doc.pdf");
    assert.equal(b, a, "off returns the same value a bare call would");
    assert.equal(computes, 2, "off must run compute every time (no caching)");
    assert.equal(store.touches, 0, "off must NEVER touch the store (provable pass-through)");
    assert.equal(store.size, 0, "off must never populate the store");
  });

  await test("bytes/on: 2nd identical fetch is a HIT equal to cold; compute runs once", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => {
      computes++;
      return `cold-text-${computes}`; // value changes per compute so a hit is provable
    };
    const cold = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", compute, store, policy: "on" });
    const warm = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", compute, store, policy: "on" });
    assert.equal(cold, "cold-text-1");
    assert.equal(warm, cold, "a HIT is byte-identical to the cold fetch");
    assert.equal(computes, 1, "on serves the hit without recomputing");
  });

  await test("bytes/on: a CHANGED url (different dependency) is a MISS that recomputes", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => `t${++computes}`;
    await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", compute, store, policy: "on" });
    await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/b.pdf", compute, store, policy: "on" });
    assert.equal(computes, 2, "a different source url is a different key ⇒ miss ⇒ recompute");
  });

  await test("bytes/on: a CHANGED as-of (different discriminator) is a MISS", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => `t${++computes}`;
    await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", asOf: "2024", compute, store, policy: "on" });
    await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", asOf: "2025", compute, store, policy: "on" });
    assert.equal(computes, 2, "a changed as-of is a different key ⇒ miss ⇒ recompute");
  });

  await test("bytes/shadow: always returns a FRESH recompute even on a would-be hit", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => `fresh-${++computes}`;
    const first = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", compute, store, policy: "shadow" });
    const second = await cacheDocumentFetch({ workspaceId: 1, sourceUrl: "https://x/a.pdf", compute, store, policy: "shadow" });
    assert.equal(first, "fresh-1");
    assert.equal(second, "fresh-2", "shadow never serves a hit — always recomputes");
    assert.equal(computes, 2);
    assert.ok(store.size >= 1, "shadow still warms the store for hit-rate measurement");
  });

  await test("bytes/on: strict tenant isolation — workspace B never reads workspace A's entry", async () => {
    const store = new CountingStore<string>();
    let computes = 0;
    const compute = async () => `ws-text-${++computes}`;
    const a = await cacheDocumentFetch({ workspaceId: "A", sourceUrl: "https://x/same.pdf", compute, store, policy: "on" });
    const b = await cacheDocumentFetch({ workspaceId: "B", sourceUrl: "https://x/same.pdf", compute, store, policy: "on" });
    assert.equal(a, "ws-text-1");
    assert.equal(b, "ws-text-2", "identical url in workspace B is a DIFFERENT key ⇒ no cross-tenant hit");
    assert.equal(computes, 2, "tenant B recomputes rather than serving tenant A's bytes");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INDEX SEAM (cacheRetrievalIndex) — analyzer.ts summarizeDocuments (BM25)
  // ─────────────────────────────────────────────────────────────────────────

  const idxResult = (tag: string) => ({ text: `CORPUS ${tag}`, model: "bm25-headers-v3l-topicaware" });
  const depFor = (texts: string[]) => [sha256Hex(texts.join("\u0000"))];

  await test("index/off: compute runs directly, byte-identical, ZERO cache interaction", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult("A");
    };
    const a = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2"]), extra: { corpus: "dev" }, compute, store, policy: "off" });
    const b = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2"]), extra: { corpus: "dev" }, compute, store, policy: "off" });
    assert.deepEqual(a, idxResult("A"));
    assert.deepEqual(b, a, "off returns the same corpus object a bare call would");
    assert.equal(computes, 2, "off must rebuild the corpus every time");
    assert.equal(store.touches, 0, "off must NEVER touch the store");
    assert.equal(store.size, 0);
  });

  await test("index/on: identical doc-set is a HIT equal to cold; BM25 build runs once", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    const cold = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    const warm = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    assert.deepEqual(cold, idxResult("build-1"));
    assert.deepEqual(warm, cold, "a HIT is byte-identical to the cold BM25 corpus");
    assert.equal(computes, 1, "on serves the hit without rebuilding");
  });

  await test("index/on: a CHANGED doc-set content hash is a MISS that rebuilds", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1", "d2", "d3"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    assert.equal(computes, 2, "a changed doc set is a different content hash ⇒ miss ⇒ rebuild");
  });

  await test("index/on: a CHANGED version salt (code change) is a MISS", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1"]), extra: { corpus: "sha-aaa" }, compute, store, policy: "on" });
    await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1"]), extra: { corpus: "sha-bbb" }, compute, store, policy: "on" });
    assert.equal(computes, 2, "a changed PIPELINE_VERSION salt invalidates the entry");
  });

  await test("index/shadow: always returns a FRESH rebuild even on a would-be hit", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`fresh-${computes}`);
    };
    const first = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1"]), extra: { corpus: "dev" }, compute, store, policy: "shadow" });
    const second = await cacheRetrievalIndex({ workspaceId: 7, dependencyHashes: depFor(["d1"]), extra: { corpus: "dev" }, compute, store, policy: "shadow" });
    assert.deepEqual(first, idxResult("fresh-1"));
    assert.deepEqual(second, idxResult("fresh-2"), "shadow never serves a hit — always rebuilds");
    assert.equal(computes, 2);
  });

  await test("index/on: strict tenant isolation — workspace B never reads workspace A's corpus", async () => {
    const store = new CountingStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    const a = await cacheRetrievalIndex({ workspaceId: "A", dependencyHashes: depFor(["d1"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    const b = await cacheRetrievalIndex({ workspaceId: "B", dependencyHashes: depFor(["d1"]), extra: { corpus: "dev" }, compute, store, policy: "on" });
    assert.deepEqual(a, idxResult("build-1"));
    assert.deepEqual(b, idxResult("build-2"), "identical doc set in workspace B is a DIFFERENT key ⇒ no cross-tenant hit");
    assert.equal(computes, 2, "tenant B rebuilds rather than serving tenant A's corpus");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

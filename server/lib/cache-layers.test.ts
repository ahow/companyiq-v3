/**
 * cache-layers.test.ts — GATE1 (unit) + GATE2 (fixed-corpus equivalence) for
 * B4 / WP12: the layered 7-level content-hash cache.
 *
 * Runs fully offline — every "expensive" layer is a stub compute fn, there is no
 * DB / network / model. Asserts the hard correctness invariants from the module
 * header:
 *   1. default-off: policy resolver + getOrCompute SKIP the cache (byte-identical)
 *   2. deterministic equivalence: a HIT is byte-identical to a cold recompute
 *   3. freshness by hash: any dependency-hash change ⇒ miss ⇒ recompute
 *   4. strict tenant isolation: workspace B never serves workspace A's entry
 *   5. reason-aware negative cache: short-circuits, invalidated when inputs change
 *   6. A3 composition: differing eligibility ⇒ cached pack/score NOT served
 *   7. A1 composition: a reuse (hit) path still carries extraction_state (≠ NULL)
 *   8. shadow mode: returns fresh even on a would-be hit, records telemetry
 *
 * Invocation (offline):
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/cache-layers.test.ts
 */

import assert from "node:assert";
import {
  CacheLayerPolicy,
  DEFAULT_CACHE_LAYER_POLICY,
  CACHE_LAYER_ENV,
  resolveCacheLayerPolicy,
  isCacheLayerEnabled,
  isCacheLayerActive,
  DEFAULT_CACHE_MAX_ENTRIES,
  resolveCacheMaxEntries,
  CACHE_LAYER_IDS,
  buildCacheKey,
  buildEligibilityScopeHash,
  InMemoryCacheStore,
  getOrCompute,
  getOrComputeNegative,
  CacheEntry,
  MaybeNegative,
  CacheTelemetryEvent,
} from "./cache-layers";

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

async function main() {
  console.log("cache-layers.test.ts — B4/WP12 layered content-hash cache\n");

  // ── 1. Default-off: resolver + skip ─────────────────────────────────────────
  await test("policy default is 'off' and unrecognised values fail safe to off", () => {
    const saved = process.env[CACHE_LAYER_ENV];
    delete process.env[CACHE_LAYER_ENV];
    assert.equal(DEFAULT_CACHE_LAYER_POLICY, "off");
    assert.equal(resolveCacheLayerPolicy(), "off");
    process.env[CACHE_LAYER_ENV] = "garbage-value";
    assert.equal(resolveCacheLayerPolicy(), "off", "typo must fail safe to off");
    process.env[CACHE_LAYER_ENV] = "ON";
    assert.equal(resolveCacheLayerPolicy(), "on", "case-insensitive env parse");
    assert.equal(resolveCacheLayerPolicy("shadow"), "shadow", "explicit arg wins over env");
    if (saved === undefined) delete process.env[CACHE_LAYER_ENV];
    else process.env[CACHE_LAYER_ENV] = saved;
    assert.equal(isCacheLayerEnabled("on"), true);
    assert.equal(isCacheLayerEnabled("shadow"), false);
    assert.equal(isCacheLayerEnabled("off"), false);
    assert.equal(isCacheLayerActive("off"), false);
    assert.equal(isCacheLayerActive("shadow"), true);
    assert.equal(isCacheLayerActive("on"), true);
  });

  await test("default-off getOrCompute SKIPS the cache entirely (never serves a hit)", async () => {
    const store = new InMemoryCacheStore<number>();
    let computes = 0;
    const compute = (): CacheEntry<number> => {
      computes++;
      return { value: 42, provenance: { extraction_state: "extracted" } };
    };
    const a = await getOrCompute({
      store, workspaceId: "ws1", layerId: "extraction",
      dependencyHashes: ["h1"], compute, policy: "off",
    });
    const b = await getOrCompute({
      store, workspaceId: "ws1", layerId: "extraction",
      dependencyHashes: ["h1"], compute, policy: "off",
    });
    assert.equal(a.outcome, "skip");
    assert.equal(b.outcome, "skip");
    assert.equal(computes, 2, "off must recompute every time (no caching)");
    assert.equal(store.size, 0, "off must never populate the store");
  });

  // ── 2. Deterministic equivalence: HIT === cold recompute ────────────────────
  await test("equivalence: a cache HIT is byte-identical to the cold recompute", async () => {
    const store = new InMemoryCacheStore<{ text: string; n: number }>();
    let computes = 0;
    const compute = (): CacheEntry<{ text: string; n: number }> => {
      computes++;
      return { value: { text: "extracted body", n: 7 }, provenance: { extraction_state: "extracted" } };
    };
    const cold = await getOrCompute({
      store, workspaceId: 100, layerId: "packs",
      dependencyHashes: ["dep-a", "dep-b"], compute, policy: "on",
    });
    const warm = await getOrCompute({
      store, workspaceId: 100, layerId: "packs",
      dependencyHashes: ["dep-a", "dep-b"], compute, policy: "on",
    });
    assert.equal(cold.outcome, "miss");
    assert.equal(warm.outcome, "hit");
    assert.equal(computes, 1, "second call must be served from cache");
    assert.deepEqual(warm.value, cold.value, "hit value must equal cold value");
    assert.deepEqual(warm.provenance, cold.provenance, "hit provenance must equal cold");
  });

  // ── 3. Freshness by hash ────────────────────────────────────────────────────
  await test("freshness: any dependency-hash change ⇒ miss ⇒ recompute (no TTL)", async () => {
    const store = new InMemoryCacheStore<string>();
    let computes = 0;
    const compute = (): CacheEntry<string> => { computes++; return { value: `v${computes}` }; };
    const first = await getOrCompute({
      store, workspaceId: "ws", layerId: "scores",
      dependencyHashes: ["x1"], compute, policy: "on",
    });
    const again = await getOrCompute({
      store, workspaceId: "ws", layerId: "scores",
      dependencyHashes: ["x1"], compute, policy: "on",
    });
    const changed = await getOrCompute({
      store, workspaceId: "ws", layerId: "scores",
      dependencyHashes: ["x2"], compute, policy: "on",
    });
    assert.equal(first.outcome, "miss");
    assert.equal(again.outcome, "hit");
    assert.equal(changed.outcome, "miss", "a changed input hash must miss");
    assert.equal(computes, 2, "unchanged ⇒ 1 compute, changed ⇒ +1");
    assert.notEqual(first.key, changed.key, "different dep hash ⇒ different key");
  });

  // ── 4. Strict tenant isolation ──────────────────────────────────────────────
  await test("tenant isolation: workspace B MISSES on workspace A's entry (identical content)", async () => {
    const store = new InMemoryCacheStore<string>();
    let computes = 0;
    const compute = (): CacheEntry<string> => { computes++; return { value: "same-bytes" }; };
    const a = await getOrCompute({
      store, workspaceId: "workspace-A", layerId: "bytes",
      dependencyHashes: ["identical-hash"], compute, policy: "on",
    });
    const b = await getOrCompute({
      store, workspaceId: "workspace-B", layerId: "bytes",
      dependencyHashes: ["identical-hash"], compute, policy: "on",
    });
    assert.equal(a.outcome, "miss");
    assert.equal(b.outcome, "miss", "workspace B must not serve workspace A's entry");
    assert.equal(computes, 2, "each tenant recomputes — no cross-tenant collision");
    assert.notEqual(a.key, b.key, "tenant scope must make the keys differ");
    // And B hitting its OWN entry works:
    const bAgain = await getOrCompute({
      store, workspaceId: "workspace-B", layerId: "bytes",
      dependencyHashes: ["identical-hash"], compute, policy: "on",
    });
    assert.equal(bAgain.outcome, "hit");
    assert.equal(computes, 2);
  });

  // ── 5. Reason-aware negative cache ──────────────────────────────────────────
  await test("negative cache: short-circuits while inputs unchanged, carries reason", async () => {
    const store = new InMemoryCacheStore<MaybeNegative<string>>();
    let computes = 0;
    const compute = (): MaybeNegative<string> => {
      computes++;
      return { negative: true, reason: "no-extractable-text", provenance: { extraction_state: "empty" } };
    };
    const first = await getOrComputeNegative({
      store, workspaceId: "ws", layerId: "extraction",
      dependencyHashes: ["neg-hash"], compute, policy: "on",
    });
    const second = await getOrComputeNegative({
      store, workspaceId: "ws", layerId: "extraction",
      dependencyHashes: ["neg-hash"], compute, policy: "on",
    });
    assert.equal(first.outcome, "miss");
    assert.equal(second.outcome, "hit", "negative must short-circuit on unchanged inputs");
    assert.equal(computes, 1, "negative outcome must not recompute");
    assert.equal(second.result.negative, true);
    if (second.result.negative) assert.equal(second.result.reason, "no-extractable-text");
  });

  await test("negative cache: invalidated when inputs change (no stale negative)", async () => {
    const store = new InMemoryCacheStore<MaybeNegative<string>>();
    let computes = 0;
    const compute = (): MaybeNegative<string> => {
      computes++;
      // After inputs change, the recompute now SUCCEEDS (positive).
      return computes === 1
        ? { negative: true, reason: "ineligible-source-class" }
        : { negative: false, value: "now-eligible" };
    };
    const neg = await getOrComputeNegative({
      store, workspaceId: "ws", layerId: "eligibility",
      dependencyHashes: ["before"], compute, policy: "on",
    });
    const after = await getOrComputeNegative({
      store, workspaceId: "ws", layerId: "eligibility",
      dependencyHashes: ["after"], compute, policy: "on",
    });
    assert.equal(neg.result.negative, true);
    assert.equal(after.outcome, "miss", "changed inputs ⇒ new key ⇒ stale negative not served");
    assert.equal(after.result.negative, false);
    if (!after.result.negative) assert.equal(after.result.value, "now-eligible");
  });

  // ── 6. A3 composition ───────────────────────────────────────────────────────
  await test("A3: differing recomputed eligibility ⇒ cached pack/score NOT served", async () => {
    const store = new InMemoryCacheStore<string>();
    let computes = 0;
    const compute = (): CacheEntry<string> => { computes++; return { value: `pack-${computes}` }; };
    const eligV1 = { entity: "E1", issuer: "I1", sourceClass: "registry", asOf: "2026-01-01", version: 3, scope: "s" };
    const eligV2 = { ...eligV1, version: 4 }; // eligibility recomputed differently
    const p1 = await getOrCompute({
      store, workspaceId: "ws", layerId: "packs",
      dependencyHashes: ["corpus-h"], extra: buildEligibilityScopeHash(eligV1),
      compute, policy: "on",
    });
    const p1b = await getOrCompute({
      store, workspaceId: "ws", layerId: "packs",
      dependencyHashes: ["corpus-h"], extra: buildEligibilityScopeHash(eligV1),
      compute, policy: "on",
    });
    const p2 = await getOrCompute({
      store, workspaceId: "ws", layerId: "packs",
      dependencyHashes: ["corpus-h"], extra: buildEligibilityScopeHash(eligV2),
      compute, policy: "on",
    });
    assert.equal(p1.outcome, "miss");
    assert.equal(p1b.outcome, "hit", "same eligibility ⇒ hit");
    assert.equal(p2.outcome, "miss", "different eligibility ⇒ must recompute, not serve old pack");
    assert.notEqual(p1.key, p2.key, "eligibility scope must be folded into the key");
    assert.equal(computes, 2);
  });

  await test("buildEligibilityScopeHash is order-insensitive within the decision object", () => {
    const a = buildEligibilityScopeHash({ entity: "E", issuer: "I", version: 1 });
    const b = buildEligibilityScopeHash({ version: 1, issuer: "I", entity: "E" });
    assert.equal(a, b, "canonical hash ⇒ key insertion order does not matter");
    const c = buildEligibilityScopeHash({ entity: "E", issuer: "I", version: 2 });
    assert.notEqual(a, c, "a differing field must change the hash");
  });

  // ── 7. A1 composition: reuse still labels extraction_state (≠ NULL) ─────────
  await test("A1: a reuse (hit) path carries extraction_state/provenance (never NULL)", async () => {
    const store = new InMemoryCacheStore<string>();
    const compute = (): CacheEntry<string> => ({
      value: "extracted-text",
      provenance: { extraction_state: "extracted", source: "pdf-fidelity" },
    });
    const cold = await getOrCompute({
      store, workspaceId: "ws", layerId: "extraction",
      dependencyHashes: ["bytes-h"], compute, policy: "on",
    });
    const reuse = await getOrCompute({
      store, workspaceId: "ws", layerId: "extraction",
      dependencyHashes: ["bytes-h"], compute, policy: "on",
    });
    assert.equal(reuse.outcome, "hit");
    assert.ok(reuse.provenance, "reuse must carry provenance");
    assert.notEqual(reuse.provenance!.extraction_state, null);
    assert.notEqual(reuse.provenance!.extraction_state, undefined);
    assert.equal(reuse.provenance!.extraction_state, "extracted");
    assert.deepEqual(reuse.provenance, cold.provenance, "reuse label must match cold label");
  });

  // ── 8. Shadow mode ──────────────────────────────────────────────────────────
  await test("shadow: returns FRESH even on a would-be hit, records telemetry", async () => {
    const store = new InMemoryCacheStore<string>();
    const events: CacheTelemetryEvent[] = [];
    let computes = 0;
    const compute = (): CacheEntry<string> => { computes++; return { value: `fresh-${computes}` }; };
    const telemetry = (e: CacheTelemetryEvent) => events.push(e);
    const first = await getOrCompute({
      store, workspaceId: "ws", layerId: "scores",
      dependencyHashes: ["s-h"], compute, policy: "shadow", telemetry,
    });
    const second = await getOrCompute({
      store, workspaceId: "ws", layerId: "scores",
      dependencyHashes: ["s-h"], compute, policy: "shadow", telemetry,
    });
    assert.equal(first.outcome, "shadow-miss");
    assert.equal(second.outcome, "shadow-hit", "would-be hit recorded...");
    assert.equal(second.value, "fresh-2", "...but fresh value returned, not cached");
    assert.equal(computes, 2, "shadow must always recompute");
    assert.equal(events.length, 2);
    assert.equal(events[0].outcome, "shadow-miss");
    assert.equal(events[1].outcome, "shadow-hit");
  });

  // ── Bounds + layer id sanity ────────────────────────────────────────────────
  await test("bounds: max-entries resolver clamps and defaults safely", () => {
    const saved = process.env.CACHE_LAYER_MAX_ENTRIES;
    delete process.env.CACHE_LAYER_MAX_ENTRIES;
    assert.equal(resolveCacheMaxEntries(), DEFAULT_CACHE_MAX_ENTRIES);
    assert.equal(resolveCacheMaxEntries(0), DEFAULT_CACHE_MAX_ENTRIES, "0 falls back to default");
    assert.equal(resolveCacheMaxEntries(-5), DEFAULT_CACHE_MAX_ENTRIES, "negative falls back");
    assert.equal(resolveCacheMaxEntries(10), 10);
    process.env.CACHE_LAYER_MAX_ENTRIES = "garbage";
    assert.equal(resolveCacheMaxEntries(), DEFAULT_CACHE_MAX_ENTRIES, "non-numeric env ⇒ default");
    if (saved === undefined) delete process.env.CACHE_LAYER_MAX_ENTRIES;
    else process.env.CACHE_LAYER_MAX_ENTRIES = saved;
  });

  await test("store: FIFO eviction respects max-entries bound", () => {
    const store = new InMemoryCacheStore<number>(2);
    store.set("k1", { value: 1 });
    store.set("k2", { value: 2 });
    store.set("k3", { value: 3 }); // evicts k1
    assert.equal(store.has("k1"), false, "oldest evicted");
    assert.equal(store.has("k2"), true);
    assert.equal(store.has("k3"), true);
    assert.equal(store.size, 2, "size never exceeds the bound");
  });

  await test("layer ids: exactly the 7 declared layers in dependency order", () => {
    assert.deepEqual([...CACHE_LAYER_IDS], [
      "bytes", "extraction", "ocr", "index", "eligibility", "packs", "scores",
    ]);
  });

  await test("buildCacheKey: distinct layers with identical deps never collide", () => {
    const k1 = buildCacheKey({ workspaceId: "w", layerId: "bytes", dependencyHashes: ["h"] });
    const k2 = buildCacheKey({ workspaceId: "w", layerId: "extraction", dependencyHashes: ["h"] });
    assert.notEqual(k1, k2, "layer id must be part of the key");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

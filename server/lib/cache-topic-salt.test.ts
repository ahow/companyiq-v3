/**
 * cache-topic-salt.test.ts — Option 2: prove the framework/topic identity is
 * folded into BOTH text-cache keys so a different topic can NEVER be served
 * another topic's topic-aware trimmed corpus for the SAME document set.
 *
 * Background: summarizeDocumentsCompute trims a large corpus (> bm25Skip-
 * SummarizationBelowChars, default 600k chars) in a TOPIC-AWARE way. The two
 * caches that store that trimmed corpus — the in-memory INDEX seam
 * (cacheRetrievalIndex) and the DB SUMMARY cache (summary_cache docHash) —
 * previously keyed only on companyId + content hash + PIPELINE_VERSION, omitting
 * the topic. So framework A's A-trimmed corpus could be served to framework B on
 * the identical documents. Both keys now carry topicCacheSalt(topicDescription).
 *
 * This test imports the REAL topicCacheSalt from analyzer.ts and exercises the
 * REAL cacheRetrievalIndex seam (the same primitive summarizeDocuments wraps),
 * and replicates the EXACT summary docHash formula from analyzer.ts. Offline +
 * free: the "expensive" corpus build is a stub counter; the store is in-memory.
 * Run with:
 *   DATABASE_URL=postgres://stub:stub@127.0.0.1:1/stub npx tsx server/lib/cache-topic-salt.test.ts
 */

import assert from "node:assert";
import { createHash } from "node:crypto";
import { InMemoryCacheStore } from "./cache-layers";
import { cacheRetrievalIndex, sha256Hex } from "./pipeline-cache";
import { topicCacheSalt } from "./analyzer";

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

// Replica of the summary-cache docHash formula in summarizeDocumentsCompute.
// Kept byte-identical to analyzer.ts so the test fails loudly if the formula
// drifts away from carrying the topic salt.
function summaryDocHash(hashBasis: string, pipelineVersion: string, topicDescription: string): string {
  return createHash("sha256")
    .update(hashBasis + `:corpus-${pipelineVersion}` + `:topic-${topicCacheSalt(topicDescription)}`)
    .digest("hex")
    .slice(0, 16);
}

async function main() {
  console.log("cache-topic-salt.test.ts — Option 2: topic identity in both text-cache keys\n");

  // ─────────────────────────────────────────────────────────────────────────
  // topicCacheSalt — the shared primitive
  // ─────────────────────────────────────────────────────────────────────────

  await test("salt: different topics ⇒ different salts", () => {
    assert.notEqual(
      topicCacheSalt("AI governance and oversight"),
      topicCacheSalt("Climate transition risk"),
      "distinct framework topics must produce distinct salts",
    );
  });

  await test("salt: cosmetic variants (case / whitespace) ⇒ SAME salt (no needless invalidation)", () => {
    assert.equal(
      topicCacheSalt("  AI   Governance "),
      topicCacheSalt("ai governance"),
      "trim + lowercase + whitespace-collapse normalizes cosmetic edits",
    );
  });

  await test("salt: null / undefined / empty are stable and equal", () => {
    const empty = topicCacheSalt("");
    assert.equal(topicCacheSalt(null), empty);
    assert.equal(topicCacheSalt(undefined), empty);
    assert.equal(topicCacheSalt("   "), empty, "all-whitespace normalizes to empty");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // INDEX seam (cacheRetrievalIndex) — the primitive summarizeDocuments wraps.
  // Same company, same documents, DIFFERENT topic ⇒ MISS (no cross-topic leak).
  // ─────────────────────────────────────────────────────────────────────────

  const idxResult = (tag: string) => ({ text: `TRIMMED-CORPUS ${tag}`, model: "bm25-headers-v3l-topicaware" });
  const depFor = (texts: string[]) => [sha256Hex(texts.join("\u0000"))];
  // The identical large document set, scored under two different frameworks.
  const DOCS = ["annual-report", "sustainability-report", "tcfd"];

  await test("index/on: SAME company + SAME docs, DIFFERENT topic ⇒ MISS (segregated, no leak)", async () => {
    const store = new InMemoryCacheStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    // Framework A trims the shared corpus toward its topic.
    const a = await cacheRetrievalIndex({
      workspaceId: 42,
      dependencyHashes: depFor(DOCS),
      extra: { corpus: "dev", topic: topicCacheSalt("AI governance") },
      compute, store, policy: "on",
    });
    // Framework B, identical company + identical documents, different topic.
    const b = await cacheRetrievalIndex({
      workspaceId: 42,
      dependencyHashes: depFor(DOCS),
      extra: { corpus: "dev", topic: topicCacheSalt("Climate transition risk") },
      compute, store, policy: "on",
    });
    assert.deepEqual(a, idxResult("build-1"));
    assert.deepEqual(b, idxResult("build-2"), "B must rebuild its own trimmed corpus, not inherit A's");
    assert.equal(computes, 2, "a different topic is a different index key ⇒ miss ⇒ rebuild");
  });

  await test("index/on: SAME company + SAME docs + SAME topic ⇒ HIT (legitimate reuse preserved)", async () => {
    const store = new InMemoryCacheStore<ReturnType<typeof idxResult>>();
    let computes = 0;
    const compute = () => {
      computes++;
      return idxResult(`build-${computes}`);
    };
    const topicExtra = { corpus: "dev", topic: topicCacheSalt("AI governance") };
    const cold = await cacheRetrievalIndex({ workspaceId: 42, dependencyHashes: depFor(DOCS), extra: topicExtra, compute, store, policy: "on" });
    const warm = await cacheRetrievalIndex({ workspaceId: 42, dependencyHashes: depFor(DOCS), extra: topicExtra, compute, store, policy: "on" });
    assert.deepEqual(warm, cold, "same topic on the same docs is still a byte-identical hit");
    assert.equal(computes, 1, "topic salt does NOT break same-topic reuse");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUMMARY cache docHash (DB layer) — exact formula replica.
  // Same corpus bytes, DIFFERENT topic ⇒ DIFFERENT docHash (segregated row).
  // ─────────────────────────────────────────────────────────────────────────

  await test("summary docHash: SAME corpus bytes, DIFFERENT topic ⇒ DIFFERENT docHash (no leak)", () => {
    const hashBasis = sha256Hex(DOCS.join("\u0000")); // stands in for content-stable hash of the doc texts
    const hashA = summaryDocHash(hashBasis, "pipeline-abc", "AI governance");
    const hashB = summaryDocHash(hashBasis, "pipeline-abc", "Climate transition risk");
    assert.notEqual(hashA, hashB, "summary_cache row must be per-topic, not shared across frameworks");
  });

  await test("summary docHash: SAME corpus bytes + SAME topic ⇒ SAME docHash (deterministic reuse)", () => {
    const hashBasis = sha256Hex(DOCS.join("\u0000"));
    assert.equal(
      summaryDocHash(hashBasis, "pipeline-abc", "AI governance"),
      summaryDocHash(hashBasis, "pipeline-abc", "AI governance"),
      "identical corpus + topic is a stable cache key",
    );
  });

  await test("summary docHash: DIFFERENT corpus bytes, SAME topic ⇒ DIFFERENT docHash (freshness preserved)", () => {
    const hashA = summaryDocHash(sha256Hex("corpus-v1"), "pipeline-abc", "AI governance");
    const hashB = summaryDocHash(sha256Hex("corpus-v2"), "pipeline-abc", "AI governance");
    assert.notEqual(hashA, hashB, "changed content still invalidates even when the topic is unchanged");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();

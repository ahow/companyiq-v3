// KEEP #1: per-provider token buckets + SerpAPI circuit-breaker.
// Run: DATABASE_URL=postgres://x:y@localhost:1/z npx tsx --test server/lib/search-rate-limit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTokenBucket, createCircuitBreaker } from "./discovery.js";

test("independent buckets: draining one does not block the other", async () => {
  const a = createTokenBucket(2, 0.0001, 200);
  const b = createTokenBucket(2, 0.0001, 200);
  await a.acquire(); await a.acquire();
  const t0 = Date.now();
  await b.acquire();
  assert.ok(Date.now() - t0 < 50);
});

test("release wakes a queued waiter", async () => {
  const a = createTokenBucket(1, 0.0001, 5000);
  await a.acquire();
  let woke = false;
  const p = a.acquire().then(() => { woke = true; });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(woke, false);
  a.release();
  await p;
  assert.equal(woke, true);
});

test("breaker opens after threshold, half-opens after cooldown, closes on success", () => {
  let now = 1000;
  const br = createCircuitBreaker("T", 3, 60000, () => now);
  assert.equal(br.allow(), true); br.failure();
  assert.equal(br.allow(), true); br.failure();
  assert.equal(br.allow(), true); br.success();          // success resets
  for (let i = 0; i < 3; i++) { assert.equal(br.allow(), true); br.failure(); }
  assert.equal(br.allow(), false);                        // open
  now += 60001;
  assert.equal(br.allow(), true);                         // half-open trial
  assert.equal(br.allow(), false);                        // only one trial
  br.failure();                                           // trial fails → re-open
  assert.equal(br.allow(), false);
  now += 60001;
  assert.equal(br.allow(), true); br.success();
  assert.equal(br.allow(), true); assert.equal(br.state.consecutiveFailures, 0);
});

test("neutral (429) does not count toward the breaker", () => {
  const br = createCircuitBreaker("T", 2, 1000, () => 0);
  for (let i = 0; i < 5; i++) { br.allow(); br.neutral(); }
  assert.equal(br.allow(), true);
});

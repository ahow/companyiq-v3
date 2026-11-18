import { test } from "node:test";
import assert from "node:assert/strict";
import { runBoundedPool } from "./bounded-pool.js";

// ─── D (serial default) ──────────────────────────────────────────────────────

test("concurrency <= 1 processes items strictly in index order (serial default)", async () => {
  const order: number[] = [];
  const items = ["a", "b", "c", "d"];
  await runBoundedPool(items, 1, async (item, i) => {
    // stagger so that any parallelism would reorder completions
    await new Promise((r) => setTimeout(r, (items.length - i) * 5));
    order.push(i);
  });
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("concurrency 0 / NaN / negative are floored to 1 (strictly serial)", async () => {
  for (const c of [0, -4, Number.NaN]) {
    const order: number[] = [];
    await runBoundedPool([10, 20, 30], c, async (_item, i) => {
      await new Promise((r) => setTimeout(r, (3 - i) * 5));
      order.push(i);
    });
    assert.deepEqual(order, [0, 1, 2], `cap ${c} must behave serially`);
  }
});

// ─── D/E (bounded peak concurrency) ──────────────────────────────────────────

test("peak concurrency never exceeds the cap, even with a large input set", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_v, i) => i);
  const cap = 3;
  await runBoundedPool(items, cap, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
  });
  assert.ok(peak <= cap, `peak ${peak} must be <= cap ${cap}`);
  assert.ok(peak > 1, `expected real parallelism with cap ${cap}, got peak ${peak}`);
});

test("every item is processed exactly once, with its correct index", async () => {
  const items = ["w", "x", "y", "z", "q"];
  const seenByIndex = new Map<number, string>();
  let calls = 0;
  await runBoundedPool(items, 2, async (item, i) => {
    calls++;
    seenByIndex.set(i, item);
  });
  assert.equal(calls, items.length);
  assert.equal(seenByIndex.size, items.length);
  for (let i = 0; i < items.length; i++) {
    assert.equal(seenByIndex.get(i), items[i]);
  }
});

test("empty input is a no-op", async () => {
  let calls = 0;
  await runBoundedPool([], 4, async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test("cap larger than the input set does not over-spawn (never more workers than items)", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [1, 2];
  await runBoundedPool(items, 10, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
  });
  assert.ok(peak <= items.length, `peak ${peak} must be <= item count ${items.length}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideConcurrency,
  loadAdaptiveConfig,
  noteRateLimited,
  noteProviderSuccess,
  getSignalSnapshot,
  resetSignals,
  type AdaptiveConcurrencyConfig,
} from "./adaptive-concurrency.js";

function cfg(over: Partial<AdaptiveConcurrencyConfig> = {}): AdaptiveConcurrencyConfig {
  return {
    enabled: true,
    max: 10,
    min: 2,
    windowMs: 60000,
    backoffThreshold: 3,
    decreaseFactor: 0.5,
    step: 1,
    tickMs: 15000,
    ...over,
  };
}

// ─── Pure decision function ─────────────────────────────────────────────────

test("A: sustained back-pressure scales concurrency down by decreaseFactor", () => {
  const d = decideConcurrency(10, { rateLimited: 5, success: 20, total: 25 }, cfg());
  assert.equal(d.concurrency, 5, "10 * 0.5 = 5");
  assert.equal(d.changed, true);
  assert.match(d.reason, /back-pressure/);
});

test("B: back-pressure never scales below min", () => {
  const d = decideConcurrency(3, { rateLimited: 9, success: 1, total: 10 }, cfg({ min: 2 }));
  // 3 * 0.5 = 1.5 → floor 1, clamped to min 2
  assert.equal(d.concurrency, 2);
});

test("C: at min under back-pressure holds at min", () => {
  const d = decideConcurrency(2, { rateLimited: 9, success: 1, total: 10 }, cfg({ min: 2 }));
  assert.equal(d.concurrency, 2);
  assert.equal(d.changed, false);
});

test("D: no back-pressure with traffic ramps up by step", () => {
  const d = decideConcurrency(4, { rateLimited: 0, success: 30, total: 30 }, cfg());
  assert.equal(d.concurrency, 5);
  assert.equal(d.changed, true);
  assert.match(d.reason, /ramping up/);
});

test("E: ramp up never exceeds max", () => {
  const d = decideConcurrency(10, { rateLimited: 0, success: 30, total: 30 }, cfg({ max: 10 }));
  assert.equal(d.concurrency, 10);
  assert.equal(d.changed, false);
});

test("F: no traffic holds current", () => {
  const d = decideConcurrency(6, { rateLimited: 0, success: 0, total: 0 }, cfg());
  assert.equal(d.concurrency, 6);
  assert.equal(d.changed, false);
  assert.match(d.reason, /no traffic/);
});

test("G: rate-limited below threshold holds", () => {
  const d = decideConcurrency(6, { rateLimited: 2, success: 40, total: 42 }, cfg({ backoffThreshold: 3 }));
  assert.equal(d.concurrency, 6);
  assert.equal(d.changed, false);
  assert.match(d.reason, /holding/);
});

test("H: full cycle — back off on sustained 429s then ramp back up when subsided", () => {
  const c = cfg({ max: 12, min: 2, backoffThreshold: 3, decreaseFactor: 0.5, step: 2 });
  let cur = 12;
  // Sustained rate limiting
  cur = decideConcurrency(cur, { rateLimited: 6, success: 10, total: 16 }, c).concurrency; // 6
  assert.equal(cur, 6);
  cur = decideConcurrency(cur, { rateLimited: 6, success: 4, total: 10 }, c).concurrency; // 3
  assert.equal(cur, 3);
  // Subsided → ramp up by step=2
  cur = decideConcurrency(cur, { rateLimited: 0, success: 20, total: 20 }, c).concurrency; // 5
  assert.equal(cur, 5);
  cur = decideConcurrency(cur, { rateLimited: 0, success: 20, total: 20 }, c).concurrency; // 7
  assert.equal(cur, 7);
});

test("I: defensive clamp when current is out of bounds", () => {
  // current above max with no traffic → clamp down to max, marked changed
  const d = decideConcurrency(99, { rateLimited: 0, success: 0, total: 0 }, cfg({ max: 10 }));
  assert.equal(d.concurrency, 10);
  assert.equal(d.changed, true);
});

// ─── Signal window ──────────────────────────────────────────────────────────

test("J: signal window counts events and respects window cutoff", () => {
  resetSignals();
  noteRateLimited();
  noteRateLimited();
  noteProviderSuccess();
  const snap = getSignalSnapshot(60000);
  assert.equal(snap.rateLimited, 2);
  assert.equal(snap.success, 1);
  assert.equal(snap.total, 3);
});

test("K: events outside window are excluded", () => {
  resetSignals();
  noteRateLimited();
  // Query with a window in the far future relative to a 0 cutoff — use tiny window.
  const snap = getSignalSnapshot(0, Date.now() + 10_000);
  assert.equal(snap.total, 0, "event older than window cutoff excluded");
});

// ─── Config loader kill-switch ──────────────────────────────────────────────

test("L: kill-switch disables via env", () => {
  const prev = process.env.ADAPTIVE_CONCURRENCY_ENABLED;
  process.env.ADAPTIVE_CONCURRENCY_ENABLED = "false";
  const c = loadAdaptiveConfig();
  assert.equal(c.enabled, false);
  if (prev === undefined) delete process.env.ADAPTIVE_CONCURRENCY_ENABLED;
  else process.env.ADAPTIVE_CONCURRENCY_ENABLED = prev;
});

test("M: min never exceeds max even if misconfigured", () => {
  const prevMin = process.env.ADAPTIVE_CONCURRENCY_MIN;
  const prevMax = process.env.WORKER_CONCURRENCY;
  process.env.WORKER_CONCURRENCY = "4";
  process.env.ADAPTIVE_CONCURRENCY_MIN = "20";
  const c = loadAdaptiveConfig();
  assert.equal(c.max, 4);
  assert.equal(c.min, 4, "min clamped to max");
  if (prevMin === undefined) delete process.env.ADAPTIVE_CONCURRENCY_MIN;
  else process.env.ADAPTIVE_CONCURRENCY_MIN = prevMin;
  if (prevMax === undefined) delete process.env.WORKER_CONCURRENCY;
  else process.env.WORKER_CONCURRENCY = prevMax;
});

// Unit tests for GENERALISED per-measure verdict-stability k calibration (WS4).
//
// Covers the pure flag helpers (calibrateKFromFlipRate, verdictStabilityKBands)
// and the pure calibration core (computePerMeasureK). No DB is touched — the
// DB-backed persistPerMeasureK is exercised only through its pure helper and its
// no-op guard, so these tests run without DATABASE_URL.
//
// Run: node --import tsx --test server/lib/calibrate-verdict-stability-k.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { calibrateKFromFlipRate, verdictStabilityKBands } from "./scoring-fix-flags.js";
import { computePerMeasureK, persistPerMeasureK } from "./framework-v2/calibrate-verdict-stability-k.js";

// ── calibrateKFromFlipRate — band boundaries (default bands 0.08→5, 0.04→3) ──
test("calibrateKFromFlipRate: band boundaries map to the expected k", () => {
  assert.equal(calibrateKFromFlipRate(0.08), 5); // exactly the top band
  assert.equal(calibrateKFromFlipRate(0.12), 5); // above the top band
  assert.equal(calibrateKFromFlipRate(0.07), 3); // between bands → middle band
  assert.equal(calibrateKFromFlipRate(0.04), 3); // exactly the middle band
  assert.equal(calibrateKFromFlipRate(0.039), 1); // below lowest band → no-op
  assert.equal(calibrateKFromFlipRate(0), 1); // perfectly stable → no-op
});

test("calibrateKFromFlipRate: non-finite / negative → 1 (no-op)", () => {
  assert.equal(calibrateKFromFlipRate(NaN), 1);
  assert.equal(calibrateKFromFlipRate(Infinity), 1);
  assert.equal(calibrateKFromFlipRate(-0.5), 1);
  // @ts-expect-error intentionally passing a bad value
  assert.equal(calibrateKFromFlipRate(undefined), 1);
});

test("calibrateKFromFlipRate: honours custom bands passed in", () => {
  const bands = [{ minFlipRate: 0.5, k: 9 }, { minFlipRate: 0.1, k: 2 }];
  assert.equal(calibrateKFromFlipRate(0.6, bands), 9);
  assert.equal(calibrateKFromFlipRate(0.2, bands), 2);
  assert.equal(calibrateKFromFlipRate(0.05, bands), 1);
});

// ── verdictStabilityKBands — default + env override ──────────────────────────
test("verdictStabilityKBands: default bands sorted DESC by minFlipRate", () => {
  const prev = process.env.VERDICT_STABILITY_K_BANDS;
  try {
    delete process.env.VERDICT_STABILITY_K_BANDS;
    assert.deepEqual(verdictStabilityKBands(), [
      { minFlipRate: 0.08, k: 5 },
      { minFlipRate: 0.04, k: 3 },
    ]);
  } finally {
    if (prev === undefined) delete process.env.VERDICT_STABILITY_K_BANDS;
    else process.env.VERDICT_STABILITY_K_BANDS = prev;
  }
});

test("verdictStabilityKBands: env override parsed, malformed pairs ignored, sorted DESC", () => {
  const prev = process.env.VERDICT_STABILITY_K_BANDS;
  try {
    // One good pair, one good pair out of order, and several malformed ones.
    process.env.VERDICT_STABILITY_K_BANDS = "0.04:3, 0.2:7, junk, 0.1:, :4, 0.3:0";
    assert.deepEqual(verdictStabilityKBands(), [
      { minFlipRate: 0.2, k: 7 },
      { minFlipRate: 0.04, k: 3 },
    ]);
  } finally {
    if (prev === undefined) delete process.env.VERDICT_STABILITY_K_BANDS;
    else process.env.VERDICT_STABILITY_K_BANDS = prev;
  }
});

test("verdictStabilityKBands: env with no valid pairs falls back to default", () => {
  const prev = process.env.VERDICT_STABILITY_K_BANDS;
  try {
    process.env.VERDICT_STABILITY_K_BANDS = "garbage,also:bad,:,";
    assert.deepEqual(verdictStabilityKBands(), [
      { minFlipRate: 0.08, k: 5 },
      { minFlipRate: 0.04, k: 3 },
    ]);
  } finally {
    if (prev === undefined) delete process.env.VERDICT_STABILITY_K_BANDS;
    else process.env.VERDICT_STABILITY_K_BANDS = prev;
  }
});

// ── computePerMeasureK — maps measureIds to expected k ───────────────────────
test("computePerMeasureK: maps each measureId to its calibrated k (default bands)", () => {
  const bands = [{ minFlipRate: 0.08, k: 5 }, { minFlipRate: 0.04, k: 3 }];
  const stats = [
    { measureId: "m1", flipRate: 0.10, runs: 3 }, // → 5
    { measureId: "m2", flipRate: 0.05, runs: 3 }, // → 3
    { measureId: "m3", flipRate: 0.0, runs: 3 }, // → 1 (below lowest band)
  ];
  const map = computePerMeasureK(stats, bands);
  assert.equal(map.get("m1"), 5);
  assert.equal(map.get("m2"), 3);
  assert.equal(map.get("m3"), 1);
  assert.equal(map.size, 3);
});

test("computePerMeasureK: skips stats with missing/invalid flipRate or measureId", () => {
  const stats: any[] = [
    { measureId: "ok", flipRate: 0.1, runs: 3 },
    { measureId: "noRate", runs: 3 }, // no flipRate → skipped
    { measureId: "badRate", flipRate: NaN, runs: 3 }, // non-finite → skipped
    { flipRate: 0.1, runs: 3 }, // no measureId → skipped
    { measureId: "", flipRate: 0.1, runs: 3 }, // empty measureId → skipped
  ];
  const map = computePerMeasureK(stats);
  assert.deepEqual([...map.keys()], ["ok"]);
});

test("computePerMeasureK: non-array input → empty map", () => {
  // @ts-expect-error intentionally passing a bad value
  assert.equal(computePerMeasureK(null).size, 0);
});

// ── persistPerMeasureK — meaningfulness guard (no DB call when < 2 runs) ──────
test("persistPerMeasureK: empty flipStats → no-op (db never called)", async () => {
  let called = false;
  const fakeDb = { execute: async () => { called = true; return { rowCount: 1 }; } };
  const out = await persistPerMeasureK(fakeDb, 25, []);
  assert.deepEqual(out, { updated: 0, kByMeasure: {} });
  assert.equal(called, false);
});

test("persistPerMeasureK: no stat with runs>=2 → no-op (db never called)", async () => {
  let called = false;
  const fakeDb = { execute: async () => { called = true; return { rowCount: 1 }; } };
  const out = await persistPerMeasureK(fakeDb, 25, [{ measureId: "m1", flipRate: 0.1, runs: 1 }]);
  assert.deepEqual(out, { updated: 0, kByMeasure: {} });
  assert.equal(called, false);
});

test("persistPerMeasureK: with runs>=2 → issues one UPDATE per measure and sums rowCount", async () => {
  const seen: Array<{ k: number }> = [];
  const fakeDb = {
    execute: async (_q: any) => {
      seen.push({ k: 0 });
      return { rowCount: 1 };
    },
  };
  const stats = [
    { measureId: "m1", flipRate: 0.1, runs: 3 }, // k=5
    { measureId: "m2", flipRate: 0.05, runs: 3 }, // k=3
  ];
  const out = await persistPerMeasureK(fakeDb, 25, stats);
  assert.equal(out.updated, 2); // two UPDATEs, each rowCount 1
  assert.equal(seen.length, 2);
  assert.deepEqual(out.kByMeasure, { m1: 5, m2: 3 });
});

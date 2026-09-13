import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEffectiveBatch } from "./effective-batch.js";

const completed = (id: number) => ({ id, status: "completed" });
const cancelled = (id: number) => ({ id, status: "cancelled" });
const running = (id: number) => ({ id, status: "running" });
const failed = (id: number) => ({ id, status: "failed" });

test("newest completed → use newest (normal case, unchanged)", () => {
  const newest = completed(61);
  const latest = completed(61);
  assert.equal(pickEffectiveBatch(newest, latest), newest);
});

test("newest cancelled, a completed batch exists → use latest completed", () => {
  const newest = cancelled(62);
  const latest = completed(61);
  const eff = pickEffectiveBatch(newest, latest);
  assert.equal(eff, latest);
  assert.equal(eff!.id, 61);
});

test("newest running, a completed batch exists → use latest completed", () => {
  const eff = pickEffectiveBatch(running(70), completed(69));
  assert.equal(eff!.id, 69);
});

test("newest failed, a completed batch exists → use latest completed", () => {
  const eff = pickEffectiveBatch(failed(80), completed(78));
  assert.equal(eff!.id, 78);
});

test("newest not completed and NO completed batch exists → fall back to newest", () => {
  const newest = cancelled(5);
  const eff = pickEffectiveBatch(newest, null);
  assert.equal(eff, newest);
});

test("no batches at all → null", () => {
  assert.equal(pickEffectiveBatch(null, null), null);
});

test("newest completed even when an older completed exists → still newest (never regress to older)", () => {
  // latestCompleted query returns the newest completed, which equals newest here.
  const newest = completed(61);
  assert.equal(pickEffectiveBatch(newest, newest).id, 61);
});

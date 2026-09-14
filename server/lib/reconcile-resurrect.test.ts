import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOrphanLastError,
  isResurrectEligible,
  ORPHAN_REJECTION_REASON,
  type ResurrectRow,
} from "./reconcile-resurrect.js";

// The exact signature startup-cleanup.ts writes (note the em-dash U+2014).
const ORPHAN_ERROR = "Server restarted — job was orphaned";

test("isOrphanLastError: matches the exact orphan signature", () => {
  assert.equal(isOrphanLastError(ORPHAN_ERROR), true);
});

test("isOrphanLastError: matches case-insensitively and on the 'orphaned' token", () => {
  assert.equal(isOrphanLastError("SERVER RESTARTED — JOB WAS ORPHANED"), true);
  assert.equal(isOrphanLastError("job orphaned during restart"), true);
});

test("isOrphanLastError: rejects genuine scoring/analysis failures", () => {
  assert.equal(isOrphanLastError("evidence gate failed: insufficient corpus"), false);
  assert.equal(isOrphanLastError("LLM provider timeout after 3 retries"), false);
  assert.equal(isOrphanLastError("reconcile budget exhausted"), false);
  assert.equal(isOrphanLastError("superseded by reconciler recovery"), false);
});

test("isOrphanLastError: rejects null / empty / non-string", () => {
  assert.equal(isOrphanLastError(null), false);
  assert.equal(isOrphanLastError(undefined), false);
  assert.equal(isOrphanLastError(""), false);
  assert.equal(isOrphanLastError(123 as any), false);
});

const NOW = new Date("2026-09-14T12:00:00Z");
const config = { windowMin: 120 };

function baseRow(overrides: Partial<ResurrectRow> = {}): ResurrectRow {
  return {
    status: "failed",
    lastError: ORPHAN_ERROR,
    rejectionReason: ORPHAN_REJECTION_REASON,
    lastProgressAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), // 10 min ago
    ...overrides,
  };
}

test("isResurrectEligible: eligible orphan within window", () => {
  assert.equal(isResurrectEligible(baseRow(), config, NOW), true);
});

test("isResurrectEligible: rejects user-cancelled batches", () => {
  assert.equal(
    isResurrectEligible(baseRow({ rejectionReason: "cancelled by user" }), config, NOW),
    false,
  );
});

test("isResurrectEligible: rejects other rejection reasons", () => {
  assert.equal(isResurrectEligible(baseRow({ rejectionReason: null }), config, NOW), false);
  assert.equal(isResurrectEligible(baseRow({ rejectionReason: "" }), config, NOW), false);
});

test("isResurrectEligible: rejects jobs stale beyond the window", () => {
  const stale = baseRow({
    lastProgressAt: new Date(NOW.getTime() - 121 * 60_000).toISOString(), // 121 min ago
  });
  assert.equal(isResurrectEligible(stale, config, NOW), false);
});

test("isResurrectEligible: accepts a job exactly at the window boundary", () => {
  const edge = baseRow({
    lastProgressAt: new Date(NOW.getTime() - 120 * 60_000).toISOString(), // exactly 120 min
  });
  assert.equal(isResurrectEligible(edge, config, NOW), true);
});

test("isResurrectEligible: rejects non-failed status", () => {
  assert.equal(isResurrectEligible(baseRow({ status: "completed" }), config, NOW), false);
  assert.equal(isResurrectEligible(baseRow({ status: "claimed" }), config, NOW), false);
  assert.equal(isResurrectEligible(baseRow({ status: "pending" }), config, NOW), false);
});

test("isResurrectEligible: rejects non-orphan last_error", () => {
  assert.equal(
    isResurrectEligible(baseRow({ lastError: "LLM provider timeout" }), config, NOW),
    false,
  );
  assert.equal(isResurrectEligible(baseRow({ lastError: null }), config, NOW), false);
});

test("isResurrectEligible: rejects missing/unparseable last_progress_at", () => {
  assert.equal(isResurrectEligible(baseRow({ lastProgressAt: null }), config, NOW), false);
  assert.equal(isResurrectEligible(baseRow({ lastProgressAt: "not-a-date" }), config, NOW), false);
});

test("isResurrectEligible: rejects future last_progress_at", () => {
  const future = baseRow({
    lastProgressAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  });
  assert.equal(isResurrectEligible(future, config, NOW), false);
});

test("isResurrectEligible: accepts Date and epoch-ms timestamps", () => {
  const asDate = baseRow({ lastProgressAt: new Date(NOW.getTime() - 30 * 60_000) });
  const asEpoch = baseRow({ lastProgressAt: NOW.getTime() - 30 * 60_000 });
  assert.equal(isResurrectEligible(asDate, config, NOW), true);
  assert.equal(isResurrectEligible(asEpoch, config, NOW), true);
});

test("isResurrectEligible: accepts numeric now argument", () => {
  assert.equal(isResurrectEligible(baseRow(), config, NOW.getTime()), true);
});

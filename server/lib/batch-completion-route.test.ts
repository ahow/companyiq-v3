/**
 * Unit tests for the TEST-DRIVE-ONLY batch completion gate.
 *
 * Proves the two required behaviours, topic/company-agnostically:
 *   (a) a test drive that finishes with failures routes to "test-drive-complete"
 *       and the failed companies are dropped (only status==='completed' survive),
 *       so the builder sees the batch as finished instead of "still running".
 *   (b) a NORMAL (non-test-drive) batch with failures routes to "pending-review"
 *       (unchanged behaviour — failures surfaced for accept/retry).
 *
 * Run with:  npx tsx --test server/lib/batch-completion-route.test.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { routeFailedBatch, dropFailedJobs } from "./batch-completion-route.js";

// Generic, identity-agnostic fixture: jobs keyed only by status + opaque ids.
// No company name, topic, measure or framework appears anywhere.
const mixedJobs = [
  { companyId: 1, status: "completed" },
  { companyId: 2, status: "failed" },
  { companyId: 3, status: "completed" },
  { companyId: 4, status: "pending" },
  { companyId: 5, status: "claimed" },
  { companyId: 6, status: "cancelled" },
  { companyId: 7, status: "completed" },
];

test("(a) test drive with failures auto-completes and drops failed companies", () => {
  // 49 completed + 1 failed = all terminal, with a failure present.
  assert.equal(routeFailedBatch({ isTestDrive: true }), "test-drive-complete");

  // The failed companies are dropped purely by status — only 'completed' survive.
  const kept = dropFailedJobs(mixedJobs);
  assert.deepEqual(
    kept.map((j) => j.companyId).sort((a, b) => a - b),
    [1, 3, 7],
    "only status==='completed' jobs are kept; failed/pending/claimed/cancelled dropped",
  );
  assert.ok(
    kept.every((j) => j.status === "completed"),
    "no non-completed job survives the drop",
  );
});

test("(b) normal (non-test-drive) batch with failures routes to pending-review (unchanged)", () => {
  assert.equal(routeFailedBatch({ isTestDrive: false }), "pending-review");
});

test("dropFailedJobs is generic: order- and identity-independent, by status only", () => {
  // Shuffled order, different opaque ids, same statuses -> same keep-set by status.
  const shuffled = [
    { id: "x-99", status: "failed" },
    { id: "x-01", status: "completed" },
    { id: "x-42", status: "failed" },
    { id: "x-07", status: "completed" },
  ];
  const kept = dropFailedJobs(shuffled);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((j) => j.status === "completed"));
});

test("dropFailedJobs on an all-completed set keeps everything", () => {
  const allOk = [
    { status: "completed" },
    { status: "completed" },
  ];
  assert.equal(dropFailedJobs(allOk).length, 2);
});

test("dropFailedJobs on an all-failed set keeps nothing", () => {
  const allFailed = [
    { status: "failed" },
    { status: "failed" },
  ];
  assert.equal(dropFailedJobs(allFailed).length, 0);
});

// WS6 — unit tests for the auto-snapshot decision + persistence helpers.
//
// This imports ONLY ./auto-snapshot.js (a DB-free leaf module) so it runs with
// no DATABASE_URL / live DB. No real DB queries are executed — the DB work is
// injected as an `execute` stub that we control.
//
// Run: node --import tsx --test server/lib/auto-snapshot.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoSnapshot, dedupeDocumentIds, persistAutoSnapshot } from "./auto-snapshot.js";

// ── shouldAutoSnapshot — truth table ────────────────────────────────────────
test("shouldAutoSnapshot: all conditions met → true", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: 2746, sourceBatchId: null, documentIds: [1, 2, 3] }),
    true,
  );
});

test("shouldAutoSnapshot: flag off → false", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: false, batchId: 2746, sourceBatchId: null, documentIds: [1, 2, 3] }),
    false,
  );
});

test("shouldAutoSnapshot: no batchId → false", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: null, sourceBatchId: null, documentIds: [1, 2, 3] }),
    false,
  );
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: undefined, sourceBatchId: null, documentIds: [1, 2, 3] }),
    false,
  );
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: 0, sourceBatchId: null, documentIds: [1, 2, 3] }),
    false,
  );
});

test("shouldAutoSnapshot: sourceBatchId present (replay) → false", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: 2746, sourceBatchId: 2741, documentIds: [1, 2, 3] }),
    false,
  );
});

test("shouldAutoSnapshot: empty document list → false", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: 2746, sourceBatchId: null, documentIds: [] }),
    false,
  );
});

test("shouldAutoSnapshot: documentIds all invalid → false", () => {
  assert.equal(
    shouldAutoSnapshot({ flagEnabled: true, batchId: 2746, sourceBatchId: null, documentIds: [0, -1, NaN] }),
    false,
  );
});

// ── dedupeDocumentIds — pure helper ─────────────────────────────────────────
test("dedupeDocumentIds: dedupes while preserving first-seen order", () => {
  assert.deepEqual(dedupeDocumentIds([3, 1, 3, 2, 1, 2]), [3, 1, 2]);
});

test("dedupeDocumentIds: drops non-finite / non-positive values", () => {
  assert.deepEqual(dedupeDocumentIds([1, 0, -5, NaN, 2, Infinity, 3]), [1, 2, 3]);
});

test("dedupeDocumentIds: non-array → empty", () => {
  // @ts-expect-error intentionally passing a bad value
  assert.deepEqual(dedupeDocumentIds(null), []);
});

// ── persistAutoSnapshot — guarded idempotent persistence ────────────────────
test("persistAutoSnapshot: empty doc list → execute NOT called, returns false", async () => {
  let called = false;
  const result = await persistAutoSnapshot({
    batchId: 2746,
    companyId: 124,
    documentIds: [],
    execute: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(result, false);
});

test("persistAutoSnapshot: dedupes document IDs before handing to execute", async () => {
  let received: number[] | null = null;
  const result = await persistAutoSnapshot({
    batchId: 2746,
    companyId: 124,
    documentIds: [5, 5, 7, 7, 7, 9],
    execute: async ({ documentIds }) => {
      received = documentIds;
    },
  });
  assert.deepEqual(received, [5, 7, 9]);
  assert.equal(result, true);
});

test("persistAutoSnapshot: passes batchId + companyId through to execute", async () => {
  let args: any = null;
  await persistAutoSnapshot({
    batchId: 2746,
    companyId: 124,
    documentIds: [1],
    execute: async (a) => {
      args = a;
    },
  });
  assert.equal(args.batchId, 2746);
  assert.equal(args.companyId, 124);
  assert.deepEqual(args.documentIds, [1]);
});

test("persistAutoSnapshot: injected throwing execute is swallowed (fail-safe), returns false", async () => {
  // Suppress the expected console.warn so the test output stays clean.
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    let result: boolean | undefined;
    await assert.doesNotReject(async () => {
      result = await persistAutoSnapshot({
        batchId: 2746,
        companyId: 124,
        documentIds: [1, 2, 3],
        execute: async () => {
          throw new Error("simulated DB failure");
        },
      });
    });
    assert.equal(result, false);
  } finally {
    console.warn = origWarn;
  }
});

test("persistAutoSnapshot: valid docs + successful execute → returns true", async () => {
  const result = await persistAutoSnapshot({
    batchId: 2746,
    companyId: 124,
    documentIds: [1, 2, 3],
    execute: async () => {
      /* no-op success */
    },
  });
  assert.equal(result, true);
});

// Pure-function unit tests for Approach 4 semantic hybrid ranking.
// No network / no embeddings API is exercised — only the deterministic pure
// functions (hybridRankScores, cosineSim). Run with: npx tsx --test <file>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hybridRankScores, cosineSim } from "./corpus-semantic.js";

test("hybridRankScores: floor chunks always rank above non-floor chunks", () => {
  // Chunk 0: weak BM25, weak cosine, but FLOOR.
  // Chunk 1: strong BM25, strong cosine, NOT floor.
  const scores = hybridRankScores({
    bm25: [0.1, 10],
    cosine: [0.01, 0.99],
    floor: [true, false],
  });
  assert.ok(scores[0] > scores[1], "floor chunk must outrank a strong non-floor chunk");
});

test("hybridRankScores: within the same tier, strong cosine lifts a mid-BM25 chunk", () => {
  // idx1 has only middle BM25 but the top cosine; RRF should lift it to #1.
  const scores = hybridRankScores({
    bm25: [3, 2, 1],
    cosine: [0.1, 0.9, 0.5],
    floor: [false, false, false],
  });
  assert.ok(scores[1] > scores[0] && scores[1] > scores[2], "top-cosine chunk should rank highest");
});

test("hybridRankScores: deterministic across repeated calls", () => {
  const opts = { bm25: [3, 1, 2], cosine: [0.2, 0.8, 0.5], floor: [false, true, false] };
  const a = hybridRankScores(opts);
  const b = hybridRankScores(opts);
  assert.deepEqual(a, b);
});

test("hybridRankScores: null cosine falls back to BM25 ordering (no throw)", () => {
  const scores = hybridRankScores({
    bm25: [10, 1],
    cosine: [null, null],
    floor: [false, false],
  });
  assert.ok(scores[0] > scores[1], "with no cosine, higher BM25 must rank higher");
});

test("cosineSim: identical vectors ~= 1", () => {
  const v = [1, 2, 3];
  const c = cosineSim(v, v);
  assert.ok(c !== null && Math.abs(c - 1) < 1e-9);
});

test("cosineSim: orthogonal vectors = 0", () => {
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
});

test("cosineSim: null on mismatched length, empty, or null input", () => {
  assert.equal(cosineSim([1, 2], [1, 2, 3]), null);
  assert.equal(cosineSim([], []), null);
  assert.equal(cosineSim(null, [1, 2]), null);
  assert.equal(cosineSim([0, 0], [1, 1]), null); // zero-norm → null
});

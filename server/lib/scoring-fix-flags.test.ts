// ─── Unit tests for the pure-logic helpers behind the six default-OFF feature
//     flags (F1 freeze-key, F3 domain union/normalize, F6 tie-break + vote).
//
// These functions are deterministic and DB-free, so they are tested in isolation
// here. The flag gates themselves (envOnDefaultFalse) are behavioural wrappers
// over process.env and are covered implicitly by the decideTiebreakRetry flagOn
// cases below.
//
// Run: node --import tsx --test server/lib/scoring-fix-flags.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  freezeFrameworkKey,
  normalizeDomain,
  unionOwnDomains,
  decideTiebreakRetry,
  formatVoteString,
} from "./scoring-fix-flags.js";

// ── F1: freezeFrameworkKey — lineage vs id selection ─────────────────────────
test("F1 freezeFrameworkKey: flag OFF always returns the framework id", () => {
  assert.equal(freezeFrameworkKey({ flagOn: false, frameworkId: 25, frameworkLineageId: 23 }), 25);
  assert.equal(freezeFrameworkKey({ flagOn: false, frameworkId: 25, frameworkLineageId: null }), 25);
  assert.equal(freezeFrameworkKey({ flagOn: false, frameworkId: 25 }), 25);
});

test("F1 freezeFrameworkKey: flag ON returns the lineage id when present", () => {
  assert.equal(freezeFrameworkKey({ flagOn: true, frameworkId: 25, frameworkLineageId: 23 }), 23);
  // Root framework: lineage id equals its own id → shared key is the id itself.
  assert.equal(freezeFrameworkKey({ flagOn: true, frameworkId: 23, frameworkLineageId: 23 }), 23);
});

test("F1 freezeFrameworkKey: flag ON falls back to id when lineage is null/undefined", () => {
  assert.equal(freezeFrameworkKey({ flagOn: true, frameworkId: 25, frameworkLineageId: null }), 25);
  assert.equal(freezeFrameworkKey({ flagOn: true, frameworkId: 25 }), 25);
});

test("F1 freezeFrameworkKey: lineage id of 0 is a valid key (not treated as absent)", () => {
  // null-check uses != null, so 0 is honoured.
  assert.equal(freezeFrameworkKey({ flagOn: true, frameworkId: 25, frameworkLineageId: 0 }), 0);
});

// ── F3: normalizeDomain ──────────────────────────────────────────────────────
test("F3 normalizeDomain: strips scheme, www, path, query, fragment and lowercases", () => {
  assert.equal(normalizeDomain("https://www.Example.com/path?q=1#frag"), "example.com");
  assert.equal(normalizeDomain("HTTP://Example.COM"), "example.com");
  assert.equal(normalizeDomain("  example.com.  "), "example.com");
  assert.equal(normalizeDomain("www.sub.example.co.uk/a/b"), "sub.example.co.uk");
});

test("F3 normalizeDomain: returns empty string for non-strings and blanks", () => {
  assert.equal(normalizeDomain(null), "");
  assert.equal(normalizeDomain(undefined), "");
  assert.equal(normalizeDomain(123 as any), "");
  assert.equal(normalizeDomain("   "), "");
});

// ── F3: unionOwnDomains — dedupe/normalize, order preserved ───────────────────
test("F3 unionOwnDomains: unions related + manual, deduped and normalized", () => {
  const out = unionOwnDomains(
    ["https://www.a.com", "b.com"],
    ["B.COM", "https://c.com/x", "a.com"],
  );
  assert.deepEqual(out, ["a.com", "b.com", "c.com"]);
});

test("F3 unionOwnDomains: related_domains appear before manual-only domains", () => {
  const out = unionOwnDomains(["first.com"], ["second.com"]);
  assert.deepEqual(out, ["first.com", "second.com"]);
});

test("F3 unionOwnDomains: drops malformed/empty entries and tolerates non-arrays", () => {
  assert.deepEqual(unionOwnDomains(["", "   ", "ok.com"], null), ["ok.com"]);
  assert.deepEqual(unionOwnDomains(null, undefined), []);
  assert.deepEqual(unionOwnDomains("notanarray" as any, ["x.com"]), ["x.com"]);
});

// ── F6: formatVoteString ─────────────────────────────────────────────────────
test("F6 formatVoteString: formats winning/substantive as 'w/s'", () => {
  assert.equal(formatVoteString(2, 3), "2/3");
  assert.equal(formatVoteString(3, 3), "3/3");
  assert.equal(formatVoteString(1, 2), "1/2");
});

test("F6 formatVoteString: blank for unusable inputs", () => {
  assert.equal(formatVoteString(0, 0), "");      // no substantive passes
  assert.equal(formatVoteString(2, 1), "");      // winning > substantive
  assert.equal(formatVoteString(-1, 3), "");     // negative
  assert.equal(formatVoteString(NaN, 3), "");
  assert.equal(formatVoteString("x", "y"), "");
});

// ── F6: decideTiebreakRetry ──────────────────────────────────────────────────
test("F6 decideTiebreakRetry: flag OFF never retries", () => {
  assert.equal(decideTiebreakRetry({ flagOn: false, substantiveScores: [0, 1], failedPassCount: 1 }), false);
});

test("F6 decideTiebreakRetry: retries only on even split WITH a failed pass", () => {
  // 1-1 split + one failed pass → retry.
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [0, 1], failedPassCount: 1 }), true);
});

test("F6 decideTiebreakRetry: no retry when substantive passes already have a majority", () => {
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [1, 1, 0], failedPassCount: 1 }), false);
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [1, 1], failedPassCount: 1 }), false);
});

test("F6 decideTiebreakRetry: no retry when no pass failed", () => {
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [0, 1], failedPassCount: 0 }), false);
});

test("F6 decideTiebreakRetry: no retry when there are no substantive scores", () => {
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [], failedPassCount: 2 }), false);
});

test("F6 decideTiebreakRetry: three-way even split counts as a tie", () => {
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [0, 0.5, 1], failedPassCount: 1 }), true);
});

test("F6 decideTiebreakRetry: single substantive pass is not a tie", () => {
  assert.equal(decideTiebreakRetry({ flagOn: true, substantiveScores: [1], failedPassCount: 1 }), false);
});

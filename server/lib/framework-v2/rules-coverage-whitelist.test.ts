import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateC7,
  ensureCoverageWhitelist,
  COVERAGE_WHITELIST_FALLBACK,
  type FrameworkDraft,
} from "./rules.js";

// C7c — deterministic, idempotent LAST-RESORT population of a coverage measure's
// coverage_whitelist. validateC7 requires ≥3 plain-language equivalents of the
// coverage extent; the repair LLM is unreliable at populating it and prune-merge
// preserves the ORIGINAL (often empty) array, so the "found 0" error re-fires
// every pass. ensureCoverageWhitelist supplies the floor from a fixed, topic-
// agnostic scope/extent vocabulary. Mirrors the C7b title / C2b tense last-resorts.

function fw(measures: FrameworkDraft["measures"]): FrameworkDraft {
  return { name: "Test FW", topicTerm: "test-topic", measures } as FrameworkDraft;
}

test("ensureCoverageWhitelist: empty/undefined input returns ≥3 fallback entries", () => {
  for (const input of [undefined, [] as string[]]) {
    const out = ensureCoverageWhitelist(input);
    assert.ok(out.length >= 3, `expected ≥3 entries, got ${out.length}`);
    for (const e of out) {
      assert.ok(
        COVERAGE_WHITELIST_FALLBACK.includes(e),
        `every entry must come from the fallback vocabulary, got "${e}"`,
      );
    }
  }
});

test("ensureCoverageWhitelist: a single caller entry is preserved FIRST and topped up to 3", () => {
  const out = ensureCoverageWhitelist(["throughout our entire supply chain"]);
  assert.equal(out[0], "throughout our entire supply chain", "caller entry must win first slot");
  assert.equal(out.length, 3, "must top up to exactly the ≥3 floor");
  // No duplicates (case-insensitive).
  const lowered = out.map((s) => s.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length, "no duplicate entries");
});

test("ensureCoverageWhitelist: a whitelist already ≥3 valid entries is returned unchanged (idempotent)", () => {
  const existing = ["across the group", "all business units", "every subsidiary"];
  const out = ensureCoverageWhitelist(existing);
  assert.deepEqual(out, existing, "already-sufficient whitelist must be returned intact, no fallbacks appended");
  // Idempotent: a second application changes nothing.
  assert.deepEqual(ensureCoverageWhitelist(out), out);
});

test("ensureCoverageWhitelist: dedup is case-insensitive and whitespace is trimmed", () => {
  const out = ensureCoverageWhitelist([
    "  Across The Group  ", // dup of a fallback phrase, different case + padding
    "across the group",     // exact dup of the above after normalisation
    "ALL OPERATIONS",       // dup of another fallback phrase, different case
  ]);
  const lowered = out.map((s) => s.toLowerCase());
  assert.equal(new Set(lowered).size, lowered.length, "no case-insensitive duplicates");
  assert.equal(out[0], "Across The Group", "first valid entry preserved (trimmed) in its original case");
  assert.ok(out.length >= 3);
});

test("ensureCoverageWhitelist: blank / whitespace-only / non-string entries are dropped", () => {
  const out = ensureCoverageWhitelist([
    "",
    "   ",
    null as any,
    undefined as any,
    42 as any,
    "group-wide",
  ]);
  assert.equal(out[0], "group-wide", "only the one valid entry survives as the first slot");
  for (const e of out) {
    assert.ok(typeof e === "string" && e.trim() !== "", "no blank/non-string entries in output");
  }
  assert.ok(out.length >= 3, "topped up to the floor");
});

test("ensureCoverageWhitelist: the result makes validateC7 pass the whitelist check", () => {
  // Title already carries a countable threshold ("Enterprise-wide …") so the
  // ONLY dimension under test is the coverage_whitelist.
  const r = validateC7(
    fw([
      {
        measureId: "1.5",
        title: "Enterprise-wide coverage of the investment commitment",
        coverage_whitelist: ensureCoverageWhitelist([]),
      } as any,
    ]),
  );
  const wlErr = r.violations.find(
    (v) =>
      v.rule === "C7" &&
      (/plain-language equivalents/i.test(v.message) || /coverage_whitelist/i.test(v.message)),
  );
  assert.equal(wlErr, undefined, "a topped-up whitelist must clear the C7 whitelist check");
});

test("COVERAGE_WHITELIST_FALLBACK: every phrase is pure scope/extent language (topic-agnostic)", () => {
  // Lightweight guard: the fallback vocabulary must not smuggle in any subject
  // matter — only generic scope/extent words are permitted.
  const SCOPE_EXTENT_WORDS = new Set([
    "across", "the", "group", "enterprise-wide", "all", "operations",
    "group-wide", "company-wide", "our", "entire", "every",
  ]);
  for (const phrase of COVERAGE_WHITELIST_FALLBACK) {
    for (const word of phrase.toLowerCase().split(/\s+/)) {
      assert.ok(
        SCOPE_EXTENT_WORDS.has(word),
        `fallback phrase "${phrase}" contains non-scope word "${word}"`,
      );
    }
  }
});

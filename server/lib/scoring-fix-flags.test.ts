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
  // Phase A — WS2 dedup + WS3 recency pure helpers
  nearDuplicateKey,
  dedupByContentKey,
  decideRecencyCorpusCutoff,
  resolvePerCompanyEntities,
  frameworkRelatedEntities,
  frameworkOwnEntities,
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


// ─── WS2 — near-duplicate collapse (nearDuplicateKey + dedupByContentKey) ─────

test("WS2 nearDuplicateKey: identical content ⇒ identical key, regardless of whitespace", () => {
  const body = "Physical climate resilience disclosure. ".repeat(20); // > 200 chars
  const a = nearDuplicateKey(body);
  const b = nearDuplicateKey("  " + body.replace(/ /g, "\n") + "   ");
  assert.ok(a, "key should be produced for long content");
  assert.equal(a, b);
});

test("WS2 nearDuplicateKey: different content ⇒ different key", () => {
  const a = nearDuplicateKey("Alpha resilience disclosure. ".repeat(20));
  const b = nearDuplicateKey("Beta continuity statement. ".repeat(20));
  assert.notEqual(a, b);
});

test("WS2 nearDuplicateKey: short content ⇒ null (fail-open, never deduped)", () => {
  assert.equal(nearDuplicateKey("too short"), null);
  assert.equal(nearDuplicateKey(""), null);
  assert.equal(nearDuplicateKey(null), null);
  assert.equal(nearDuplicateKey(undefined), null);
});

test("WS2 dedupByContentKey: collapses later duplicates, keeps first occurrence", () => {
  const keys = ["h1", "h2", "h1", "h3", "h2"];
  const { keepIndices, droppedIndices } = dedupByContentKey(keys);
  assert.deepEqual(keepIndices, [0, 1, 3]);
  assert.deepEqual(droppedIndices, [2, 4]);
});

test("WS2 dedupByContentKey: null keys are always kept (un-fingerprintable)", () => {
  const keys = [null, "h1", null, "h1"];
  const { keepIndices, droppedIndices } = dedupByContentKey(keys);
  assert.deepEqual(keepIndices, [0, 1, 2]); // both nulls + first h1
  assert.deepEqual(droppedIndices, [3]);    // second h1 only
});

// ─── WS3 — recency corpus policy (decideRecencyCorpusCutoff) ──────────────────

test("WS3 recency: normal cutoff drops docs older than the window, keeps in-window", () => {
  // window 4y from 2026 ⇒ minYear 2022. 2020 & 2019 are older.
  const r = decideRecencyCorpusCutoff({
    docYears: [2026, 2024, 2020, 2019, 2023],
    windowYears: 4,
    currentYear: 2026,
  });
  assert.deepEqual(r.keepIndices, [0, 1, 4]);
  assert.deepEqual(r.droppedIndices, [2, 3]);
  assert.deepEqual(r.agingIndices, []);
  assert.equal(r.failOpen, false);
});

test("WS3 recency: undated docs are KEPT (never dropped on recency)", () => {
  const r = decideRecencyCorpusCutoff({
    docYears: [null, 2018, 2025],
    windowYears: 4,
    currentYear: 2026,
  });
  assert.ok(r.keepIndices.includes(0), "undated kept");
  assert.ok(r.keepIndices.includes(2), "in-window kept");
  assert.deepEqual(r.droppedIndices, [1]);
  assert.equal(r.failOpen, false);
});

test("WS3 recency FAIL-OPEN: all docs older than window ⇒ keep ALL, mark aging", () => {
  // Nothing in-window and nothing undated — must NOT starve to zero.
  const r = decideRecencyCorpusCutoff({
    docYears: [2015, 2016, 2017],
    windowYears: 4,
    currentYear: 2026,
  });
  assert.deepEqual(r.keepIndices, [0, 1, 2]);
  assert.deepEqual(r.droppedIndices, []);
  assert.deepEqual(r.agingIndices, [0, 1, 2]);
  assert.equal(r.failOpen, true);
  assert.match(r.reason, /fail-open/);
});

test("WS3 recency: no window declared ⇒ keep all (fail-open)", () => {
  const r = decideRecencyCorpusCutoff({ docYears: [2010, 2026], windowYears: null, currentYear: 2026 });
  assert.deepEqual(r.keepIndices, [0, 1]);
  assert.deepEqual(r.droppedIndices, []);
  assert.equal(r.failOpen, false);
});

// ─── WS1 — per-company entity descriptor resolution (data shapes) ─────────────

test("WS1 resolvePerCompanyEntities: descriptor shape with domains for the named company", () => {
  const cfg = {
    "Hyundai Glovis": [
      { name: "Hyundai Motor Company", aliases: ["Hyundai Motor", "HMC"], domains: ["hyundai.com"] },
    ],
  };
  const out = resolvePerCompanyEntities(cfg, "Hyundai Glovis");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Hyundai Motor Company");
  assert.deepEqual(out[0].domains, ["hyundai.com"]);
  assert.deepEqual(out[0].aliases, ["Hyundai Motor", "HMC"]);
});

test("WS1 resolvePerCompanyEntities: case-insensitive key match + unrelated company ⇒ empty", () => {
  const cfg = { "Hyundai Glovis": [{ name: "Hyundai Motor Company", domains: ["hyundai.com"] }] };
  assert.equal(resolvePerCompanyEntities(cfg, "hyundai glovis").length, 1);
  assert.equal(resolvePerCompanyEntities(cfg, "Michelin").length, 0);
});

test("WS1 resolvePerCompanyEntities: legacy names-only array shape still parses (backward compat)", () => {
  const cfg = { "Hyundai Glovis": ["Hyundai Motor Company"] };
  const out = resolvePerCompanyEntities(cfg, "Hyundai Glovis");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Hyundai Motor Company");
  assert.deepEqual(out[0].domains, []);
});

test("WS1 resolvePerCompanyEntities: flat array applies to every company", () => {
  const cfg = [{ name: "Parent Co", domains: ["parent.com"] }];
  assert.equal(resolvePerCompanyEntities(cfg, "Anyone").length, 1);
});

// ─── Distinctive-core FALLBACK: short-name config key → full legal DB name ───

test("WS1 fallback: short-name key resolves against full legal DB name (the real bug)", () => {
  const cfg = {
    "Hyundai Glovis": [{ name: "Hyundai Motor Company", aliases: ["HMC"], domains: ["hyundai.com"] }],
  };
  // DB company name is the full legal name — exact match fails, fallback must engage.
  const out = resolvePerCompanyEntities(cfg, "HYUNDAI GLOVIS Co., LTD.");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Hyundai Motor Company");
  assert.deepEqual(out[0].domains, ["hyundai.com"]);
});

test("WS1 fallback: does NOT over-match a distinct peer sharing a brand token", () => {
  const cfg = {
    "Hyundai Glovis": [{ name: "Hyundai Motor Company", aliases: ["HMC"], domains: ["hyundai.com"] }],
  };
  // {hyundai} ⊂ {hyundai,motor}? key core is {hyundai,glovis}; glovis ∉ company ⇒ no match.
  assert.equal(resolvePerCompanyEntities(cfg, "Hyundai Motor Company").length, 0);
});

test("WS1 fallback: Santos short-name key resolves to SANTOS LIMITED", () => {
  const cfg = { "Santos": [{ name: "Santos Peer", domains: ["peer.example"] }] };
  const out = resolvePerCompanyEntities(cfg, "SANTOS LIMITED");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Santos Peer");
});

test("WS1 fallback: Michelin key (subset) resolves to full legal name", () => {
  const cfg = { "Michelin": [{ name: "Michelin Peer", domains: ["peer.example"] }] };
  // key core {michelin} ⊂ company core {generale,des,etablissements,michelin,sca,compagnie}
  const out = resolvePerCompanyEntities(cfg, "COMPAGNIE GENERALE DES ETABLISSEMENTS MICHELIN SCA");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Michelin Peer");
});

test("WS1 fallback: exact match always wins and is never treated as ambiguous", () => {
  const cfg = {
    "Hyundai Glovis": [{ name: "Exact Peer", domains: ["exact.example"] }],
    "Hyundai": [{ name: "Loose Peer", domains: ["loose.example"] }],
  };
  // Exact (case-insensitive) key match short-circuits the fallback entirely.
  const out = resolvePerCompanyEntities(cfg, "Hyundai Glovis");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Exact Peer");
});

test("WS1 fallback: ambiguity guard — two keys subset of same company ⇒ match NONE", () => {
  const cfg = {
    "Hyundai": [{ name: "Peer A", domains: ["a.example"] }],
    "Glovis": [{ name: "Peer B", domains: ["b.example"] }],
  };
  // Both {hyundai} and {glovis} are subsets of {hyundai,glovis} ⇒ ambiguous ⇒ [].
  assert.equal(resolvePerCompanyEntities(cfg, "HYUNDAI GLOVIS Co., LTD.").length, 0);
});

test("WS1 fallback: wildcard match suppresses fallback (no exact/wildcard ⇒ fallback only)", () => {
  const cfg = {
    "*": [{ name: "All Peer", domains: ["all.example"] }],
    "Hyundai Glovis": [{ name: "Loose Peer", domains: ["loose.example"] }],
  };
  // Wildcard produced an entry ⇒ fallback does not run; only the wildcard entry returns.
  const out = resolvePerCompanyEntities(cfg, "HYUNDAI GLOVIS Co., LTD.");
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "All Peer");
});

test("WS1 fallback: generic-only key never matches (empty distinctive core)", () => {
  const cfg = { "The Group Company Ltd": [{ name: "X", domains: ["x.example"] }] };
  // key core is empty after dropping generic words ⇒ no fallback match.
  assert.equal(resolvePerCompanyEntities(cfg, "SANTOS LIMITED").length, 0);
});

test("WS1 frameworkRelatedEntities/frameworkOwnEntities: undeclared ⇒ [] (fail-open)", () => {
  assert.deepEqual(frameworkRelatedEntities({}, "Hyundai Glovis"), []);
  assert.deepEqual(frameworkOwnEntities({}, "Hyundai Glovis"), []);
  assert.deepEqual(frameworkRelatedEntities(null, "X"), []);
});

test("WS1 frameworkRelatedEntities: merges related_listed_companies + parent_entities", () => {
  const fw = {
    related_listed_companies: { "Hyundai Glovis": [{ name: "Hyundai Motor Company", domains: ["hyundai.com"] }] },
    parent_entities: { "Hyundai Glovis": [{ name: "Hyundai Holdings", domains: ["holdings.example"] }] },
  };
  const out = frameworkRelatedEntities(fw, "Hyundai Glovis");
  const names = out.map((e) => e.name).sort();
  assert.deepEqual(names, ["Hyundai Holdings", "Hyundai Motor Company"]);
});

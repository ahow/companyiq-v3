import assert from "node:assert/strict";
import { test } from "node:test";
import {
  seedKnownDisclosureUrls,
  requiredSourceTypesBlocking,
  shouldExcludeByKeywords,
  QuoteLedger,
  passagesAreAdjacent,
  spanSatisfies,
  RetrievalFunnel,
  mayRetryExtraction,
  resolveFrozenCorpus,
} from "./retrieval-funnel.ts";

// ── 3.1 frozen-corpus content-hash/url reuse ─────────────────────────────────
test("3.1 flag OFF: resolves by document_id only (byte-identical to prior)", () => {
  const snapshot = [
    { documentId: 1, url: "https://x.com/a", contentHash: "h1" },
    { documentId: 2, url: "https://x.com/b", contentHash: "h2" },
  ];
  // id 2 has been reset away; content index could resolve it but flag is OFF.
  const live = {
    acceptedIds: new Set<number>([1]),
    byUrl: new Map<string, number>([["https://x.com/b", 99]]),
    byContentHash: new Map<string, number>([["h2", 99]]),
  };
  const r = resolveFrozenCorpus(snapshot, live, false);
  assert.deepEqual(r.resolvedIds, [1]);
  assert.equal(r.resolvedById, 1);
  assert.equal(r.resolvedByContent, 0);
  assert.equal(r.orphanedCount, 1); // id 2 stays orphaned when flag off
});

test("3.1 flag ON: orphaned id re-resolves by content_hash then url (survives reset)", () => {
  const snapshot = [
    { documentId: 1, url: "https://x.com/a", contentHash: "h1" },
    { documentId: 2, url: "https://x.com/b", contentHash: "h2" }, // id gone, hash present
    { documentId: 3, url: "https://x.com/c/", contentHash: null }, // id gone, url only
  ];
  const live = {
    acceptedIds: new Set<number>([1]),
    byContentHash: new Map<string, number>([["h2", 42]]),
    byUrl: new Map<string, number>([["https://x.com/c", 43]]),
  };
  const r = resolveFrozenCorpus(snapshot, live, true);
  assert.deepEqual(r.resolvedIds.sort((a, b) => a - b), [1, 42, 43]);
  assert.equal(r.resolvedById, 1);
  assert.equal(r.resolvedByContent, 2);
  assert.equal(r.orphanedCount, 0); // content-hash reuse rebuilds corpus w/o re-discovery
});

test("3.1 fully-orphaned snapshot with no content match stays orphaned (purge+rediscover)", () => {
  const snapshot = [
    { documentId: 7, url: "https://x.com/z", contentHash: "hz" },
  ];
  const live = { acceptedIds: new Set<number>(), byContentHash: new Map(), byUrl: new Map() };
  const r = resolveFrozenCorpus(snapshot, live, true);
  assert.deepEqual(r.resolvedIds, []);
  assert.equal(r.orphanedCount, 1); // simulated purge: nothing resolvable → orphan guard fires
});

// ── 3.2a seed ────────────────────────────────────────────────────────────────
test("3.2a merges + dedupes framework-supplied URLs, existing first", () => {
  const out = seedKnownDisclosureUrls(["https://a.com/1"], {
    knownDisclosureUrls: ["https://a.com/1/", "https://b.com/2"],
  });
  assert.deepEqual(out, ["https://a.com/1", "https://b.com/2"]);
});

// ── 3.2b vehicle-agnostic ────────────────────────────────────────────────────
test("3.2b required source types block only when flag off", () => {
  assert.equal(requiredSourceTypesBlocking(false), true);
  assert.equal(requiredSourceTypesBlocking(true), false);
});

// ── 3.2c exclusion keywords ──────────────────────────────────────────────────
test("3.2c exclusion excludes unless relaxed + on-theme", () => {
  const excl = ["transition risk"];
  const onTheme = ["physical risk", "flood"];
  assert.equal(shouldExcludeByKeywords("our transition risk plan", excl, onTheme, false), true);
  assert.equal(shouldExcludeByKeywords("transition risk and flood exposure", excl, onTheme, true), false);
  assert.equal(shouldExcludeByKeywords("transition risk only", excl, onTheme, true), true);
  assert.equal(shouldExcludeByKeywords("unrelated text", excl, onTheme, false), false);
});

// ── 3.3a single-use quotes ───────────────────────────────────────────────────
test("3.3a quote counts toward one measure unless sharing allowed", () => {
  const led = new QuoteLedger();
  assert.equal(led.claim("The board oversees climate risk.", "G1", false), true);
  assert.equal(led.claim("the board oversees climate risk", "G5", false), false); // normalised collision
  assert.equal(led.claim("The board oversees climate risk.", "G1", false), true); // same owner ok
  const led2 = new QuoteLedger();
  assert.equal(led2.claim("shared quote", "A", true), true);
  assert.equal(led2.claim("shared quote", "B", true), true); // sharing allowed
});

// ── 3.3b adjacent passage span ───────────────────────────────────────────────
test("3.3b adjacency + spanning satisfaction", () => {
  const a = { docId: 1, start: 0, end: 50, text: "we have a continuity system" };
  const b = { docId: 1, start: 120, end: 200, text: "with a 4 hour recovery objective" };
  assert.equal(passagesAreAdjacent(a, b, 400), true);
  assert.equal(passagesAreAdjacent(a, { ...b, docId: 2 }, 400), false);
  const pred = (t: string) => t.includes("continuity system") && t.includes("recovery objective");
  assert.equal(spanSatisfies(a, b, 400, pred), true);
  assert.equal(spanSatisfies(a, b, 10, pred), false); // too far apart
});

// ── 3.4a funnel ──────────────────────────────────────────────────────────────
test("3.4a funnel counters + throughput", () => {
  const f = new RetrievalFunnel();
  f.countDiscovered(10); f.countFetched(8); f.countExtracted(6); f.countPassedToScorer(5);
  f.countFailure("pdf-behind-link", 2);
  assert.equal(f.toJSON().throughput, 0.5);
  assert.equal(f.failuresByVehicle["pdf-behind-link"], 2);
});

// ── 3.4b bounded retry ───────────────────────────────────────────────────────
test("3.4b retry is bounded + vehicle-scoped", () => {
  const rec = ["pdf-behind-link"];
  assert.equal(mayRetryExtraction("pdf-behind-link", 0, 1, rec), true);
  assert.equal(mayRetryExtraction("pdf-behind-link", 1, 1, rec), false); // budget exhausted
  assert.equal(mayRetryExtraction("html", 0, 1, rec), false); // not recoverable vehicle
  assert.equal(mayRetryExtraction("pdf-behind-link", 0, 0, rec), false); // zero budget
});

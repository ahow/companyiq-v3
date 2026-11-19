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
} from "./retrieval-funnel.ts";

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

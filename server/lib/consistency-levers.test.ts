import { test } from "node:test";
import assert from "node:assert/strict";
import {
  // (2) DISCOVERY_DETERMINISTIC
  deterministicDiscoverySeed,
  canonicalUrlKey,
  sortDedupeCanonicalUrls,
  canonicalDocKey,
  // (3) CORPUS_COVERAGE_BAR_FREEZE
  decideCoverageBarFreeze,
  corpusCoverageRequiredCategories,
  // (4) FETCH_FLOOR_REQUIRED_RETRY
  decideFetchFloorRetry,
  // (5) DISCOVERY_PROVIDER_BACKOFF
  backoffDelayMs,
  // (7) RETRIEVAL_DETERMINISTIC_RANK
  stablePassageTiebreak,
  // (8) CHUNKING_DETERMINISTIC
  stableDocOrderKey,
  compareDocsForStableChunking,
  // (9) SCORING_QUOTE_VERBATIM_REQUIRED
  normalizeForVerbatim,
  quoteVerbatimPresent,
  decideQuoteVerbatimGate,
  // (10) READJUDICATION_CONFIDENCE_THRESHOLD
  confidenceToNumber,
  decideReadjudicationByConfidence,
  // (12) CROSS_MEASURE_CONSISTENCY
  detectCrossMeasureInconsistencies,
} from "./scoring-fix-flags.js";
import { shouldReadjudicate } from "./readjudication.js";

// These twelve levers are the consistency-test plan flags. Every behavioural
// flag defaults OFF; the tests below assert OFF = current behaviour (no-op) and
// ON = the new, deterministic behaviour, exercising only the PURE decision
// helpers (the gated side-effecting call sites thread these helpers verbatim).

// ── (2) DISCOVERY_DETERMINISTIC ──────────────────────────────────────────────
test("deterministicDiscoverySeed: same (company, framework) → same seed", () => {
  const a = deterministicDiscoverySeed(42, "TCFD");
  const b = deterministicDiscoverySeed(42, "TCFD");
  assert.equal(a, b);
  assert.equal(typeof a, "number");
  assert.ok(Number.isInteger(a) && a >= 0);
});

test("deterministicDiscoverySeed: different inputs → (almost surely) different seeds", () => {
  assert.notEqual(deterministicDiscoverySeed(42, "TCFD"), deterministicDiscoverySeed(43, "TCFD"));
  assert.notEqual(deterministicDiscoverySeed(42, "TCFD"), deterministicDiscoverySeed(42, "CDP"));
  // string company id is accepted too
  assert.equal(typeof deterministicDiscoverySeed("acme", "TCFD"), "number");
});

test("canonicalUrlKey: trims, lowercases, drops trailing slashes", () => {
  assert.equal(canonicalUrlKey("  https://Example.com/Report/  "), "https://example.com/report");
  assert.equal(canonicalUrlKey("https://example.com///"), "https://example.com");
  assert.equal(canonicalUrlKey(""), "");
});

test("sortDedupeCanonicalUrls: dedupes by canonical key (first spelling wins), sorts by key", () => {
  const out = sortDedupeCanonicalUrls([
    "https://b.com/Doc",
    "https://a.com/x/",
    "https://B.com/doc/", // dup of first by canonical key
    "https://a.com/x",    // dup of second
  ]);
  // deterministic order by canonical key: a.com/x then b.com/doc
  assert.deepEqual(out, ["https://a.com/x/", "https://b.com/Doc"]);
});

test("sortDedupeCanonicalUrls: stable across input permutations", () => {
  const base = ["https://z.com/a", "https://y.com/b", "https://x.com/c"];
  const perm = ["https://x.com/c", "https://z.com/a", "https://y.com/b"];
  assert.deepEqual(sortDedupeCanonicalUrls(base), sortDedupeCanonicalUrls(perm));
});

test("canonicalDocKey: is a stable string for a doc identity", () => {
  const k1 = canonicalDocKey({ url: "https://Example.com/r/" } as any);
  const k2 = canonicalDocKey({ url: "https://example.com/r" } as any);
  assert.equal(k1, k2);
});

// ── (3) CORPUS_COVERAGE_BAR_FREEZE ───────────────────────────────────────────
test("decideCoverageBarFreeze: flag off always freezes immediately (current behaviour)", () => {
  const r = decideCoverageBarFreeze({
    flagOn: false,
    presentCategories: [],
    requiredCategories: ["annual", "sustainability"],
    attempt: 0,
    maxRetries: 2,
  });
  assert.deepEqual(r, { freeze: true, retry: false, reason: "flag-off" });
});

test("decideCoverageBarFreeze: ON + coverage satisfied → freeze", () => {
  const r = decideCoverageBarFreeze({
    flagOn: true,
    presentCategories: ["Annual Report", "Sustainability/ESG Report"],
    requiredCategories: ["annual", "sustainability"],
    attempt: 0,
    maxRetries: 2,
  });
  assert.equal(r.freeze, true);
  assert.equal(r.retry, false);
  assert.equal(r.reason, "coverage-satisfied");
});

test("decideCoverageBarFreeze: ON + missing + attempts left → retry", () => {
  const r = decideCoverageBarFreeze({
    flagOn: true,
    presentCategories: ["Annual Report"],
    requiredCategories: ["annual", "sustainability"],
    attempt: 0,
    maxRetries: 2,
  });
  assert.equal(r.freeze, false);
  assert.equal(r.retry, true);
  assert.match(r.reason, /coverage-missing:sustainability/);
});

test("decideCoverageBarFreeze: ON + missing + exhausted → freeze anyway", () => {
  const r = decideCoverageBarFreeze({
    flagOn: true,
    presentCategories: ["Annual Report"],
    requiredCategories: ["annual", "sustainability"],
    attempt: 2,
    maxRetries: 2,
  });
  assert.equal(r.freeze, true);
  assert.equal(r.retry, false);
  assert.match(r.reason, /freeze-anyway/);
});

test("corpusCoverageRequiredCategories: default set", () => {
  const prev = process.env["CORPUS_COVERAGE_REQUIRED_CATEGORIES"];
  delete process.env["CORPUS_COVERAGE_REQUIRED_CATEGORIES"];
  assert.deepEqual(corpusCoverageRequiredCategories(), ["annual", "sustainability"]);
  if (prev !== undefined) process.env["CORPUS_COVERAGE_REQUIRED_CATEGORIES"] = prev;
});

// ── (4) FETCH_FLOOR_REQUIRED_RETRY ───────────────────────────────────────────
test("decideFetchFloorRetry: flag off never retries", () => {
  const r = decideFetchFloorRetry({ flagOn: false, requiredUnfetched: ["a", "b"], attempt: 0, maxRetries: 2 });
  assert.deepEqual(r, { retry: false, reason: "flag-off" });
});

test("decideFetchFloorRetry: ON + nothing unfetched → no retry", () => {
  const r = decideFetchFloorRetry({ flagOn: true, requiredUnfetched: [], attempt: 0, maxRetries: 2 });
  assert.equal(r.retry, false);
  assert.equal(r.reason, "all-required-fetched");
});

test("decideFetchFloorRetry: ON + unfetched + attempts left → retry", () => {
  const r = decideFetchFloorRetry({ flagOn: true, requiredUnfetched: ["a"], attempt: 0, maxRetries: 2 });
  assert.equal(r.retry, true);
  assert.match(r.reason, /required-unfetched:1/);
});

test("decideFetchFloorRetry: ON + unfetched + exhausted → no retry", () => {
  const r = decideFetchFloorRetry({ flagOn: true, requiredUnfetched: ["a"], attempt: 2, maxRetries: 2 });
  assert.equal(r.retry, false);
  assert.match(r.reason, /exhausted/);
});

// ── (5) DISCOVERY_PROVIDER_BACKOFF ───────────────────────────────────────────
test("backoffDelayMs: exponential, base * 2^attempt", () => {
  assert.equal(backoffDelayMs(0, 500), 500);
  assert.equal(backoffDelayMs(1, 500), 1000);
  assert.equal(backoffDelayMs(2, 500), 2000);
  assert.equal(backoffDelayMs(3, 500), 4000);
  // negative attempt clamps to 0
  assert.equal(backoffDelayMs(-5, 500), 500);
});

// ── (7) RETRIEVAL_DETERMINISTIC_RANK ─────────────────────────────────────────
test("stablePassageTiebreak: orders by docKey, then seq, then offset, then idx", () => {
  assert.ok(stablePassageTiebreak({ docKey: "a" }, { docKey: "b" }) < 0);
  assert.ok(stablePassageTiebreak({ docKey: "b" }, { docKey: "a" }) > 0);
  assert.ok(stablePassageTiebreak({ docKey: "a", seqInDoc: 1 }, { docKey: "a", seqInDoc: 2 }) < 0);
  assert.ok(stablePassageTiebreak({ docKey: "a", seqInDoc: 1, offset: 5 }, { docKey: "a", seqInDoc: 1, offset: 2 }) > 0);
  assert.ok(stablePassageTiebreak({ docKey: "a", seqInDoc: 1, offset: 1, idx: 0 }, { docKey: "a", seqInDoc: 1, offset: 1, idx: 1 }) < 0);
});

test("stablePassageTiebreak: equal passages compare 0 (total order is reflexive)", () => {
  const p = { docKey: "a", seqInDoc: 1, offset: 1, idx: 0 };
  assert.equal(stablePassageTiebreak(p, { ...p }), 0);
});

test("stablePassageTiebreak: produces a stable sort of equal-score passages", () => {
  const items = [
    { docKey: "doc-b", seqInDoc: 0, offset: 0, idx: 2 },
    { docKey: "doc-a", seqInDoc: 1, offset: 0, idx: 0 },
    { docKey: "doc-a", seqInDoc: 0, offset: 0, idx: 1 },
  ];
  const once = [...items].sort(stablePassageTiebreak).map((i) => i.idx);
  const twice = [...items].reverse().sort(stablePassageTiebreak).map((i) => i.idx);
  assert.deepEqual(once, twice);
  assert.deepEqual(once, [1, 0, 2]); // doc-a seq0, doc-a seq1, doc-b
});

// ── (8) CHUNKING_DETERMINISTIC ───────────────────────────────────────────────
test("stableDocOrderKey: uses canonical url, falls back to title", () => {
  assert.equal(stableDocOrderKey({ url: "https://Example.com/A/" }), "https://example.com/a");
  assert.equal(stableDocOrderKey({ url: "", title: "  Annual Report  " }), "annual report");
});

test("compareDocsForStableChunking: orders docs independent of input order", () => {
  const docs = [
    { url: "https://z.com/3" },
    { url: "https://a.com/1" },
    { url: "https://m.com/2" },
  ];
  const sorted = [...docs].sort(compareDocsForStableChunking).map((d) => d.url);
  assert.deepEqual(sorted, ["https://a.com/1", "https://m.com/2", "https://z.com/3"]);
  // reversed input yields the same order
  const sorted2 = [...docs].reverse().sort(compareDocsForStableChunking).map((d) => d.url);
  assert.deepEqual(sorted2, sorted);
});

// ── (9) SCORING_QUOTE_VERBATIM_REQUIRED ──────────────────────────────────────
test("normalizeForVerbatim: unifies quotes/dashes, collapses whitespace, lowercases", () => {
  assert.equal(normalizeForVerbatim("“Net\u2013Zero”   by   2050"), '"net-zero" by 2050');
  assert.equal(normalizeForVerbatim("It\u2019s"), "it's");
});

test("quoteVerbatimPresent: true when normalised quote is a substring of normalised corpus", () => {
  const corpus = "The company committed to Net-Zero by 2050 across all operations.";
  assert.equal(quoteVerbatimPresent("net-zero by 2050", corpus), true);
  // curly en-dash + mixed case normalises to the corpus's straight hyphen form
  assert.equal(quoteVerbatimPresent("Net\u2013Zero by 2050", corpus), true);
});

test("quoteVerbatimPresent: false when quote not in corpus; short quotes pass", () => {
  const corpus = "We discuss climate matters generally.";
  assert.equal(quoteVerbatimPresent("net-zero by 2050", corpus), false);
  assert.equal(quoteVerbatimPresent("tiny", corpus), true); // below minChars → treated present
});

test("decideQuoteVerbatimGate: flag off never downgrades", () => {
  const r = decideQuoteVerbatimGate({ flagOn: false, verdict: "Yes", quotes: ["absent phrase here"], corpusText: "x" });
  assert.deepEqual(r, { downgrade: false, reason: "flag-off" });
});

test("decideQuoteVerbatimGate: ON + non-Yes verdict → no downgrade", () => {
  const r = decideQuoteVerbatimGate({ flagOn: true, verdict: "No", quotes: ["absent phrase here"], corpusText: "x" });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "verdict-not-yes");
});

test("decideQuoteVerbatimGate: ON + no quotes supplied → no downgrade", () => {
  const r = decideQuoteVerbatimGate({ flagOn: true, verdict: "Yes", quotes: [], corpusText: "x" });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "no-quotes-to-verify");
});

test("decideQuoteVerbatimGate: ON + Yes + quote verbatim present → keep", () => {
  const r = decideQuoteVerbatimGate({
    flagOn: true,
    verdict: "Yes",
    quotes: ["Net-Zero by 2050"],
    corpusText: "The firm targets net-zero by 2050.",
  });
  assert.equal(r.downgrade, false);
  assert.equal(r.reason, "quote-verbatim-present");
});

test("decideQuoteVerbatimGate: ON + Yes + no quote verbatim → downgrade", () => {
  const r = decideQuoteVerbatimGate({
    flagOn: true,
    verdict: "Yes",
    quotes: ["an invented supporting phrase about targets"],
    corpusText: "The firm discusses climate generally without specifics.",
  });
  assert.equal(r.downgrade, true);
  assert.equal(r.reason, "quote-not-verbatim");
});

// ── (10) READJUDICATION_CONFIDENCE_THRESHOLD ─────────────────────────────────
test("confidenceToNumber: textual + numeric mapping, unknown → high (1.0)", () => {
  assert.equal(confidenceToNumber("high"), 1.0);
  assert.equal(confidenceToNumber("medium"), 0.6);
  assert.equal(confidenceToNumber("low"), 0.3);
  assert.equal(confidenceToNumber("0.42"), 0.42);
  assert.equal(confidenceToNumber("2"), 1); // clamp >1
  assert.equal(confidenceToNumber("-1"), 0); // clamp <0
  assert.equal(confidenceToNumber(null), 1.0);
  assert.equal(confidenceToNumber("garbage"), 1.0);
});

test("decideReadjudicationByConfidence: null threshold (flag unset) → false", () => {
  assert.equal(decideReadjudicationByConfidence({ threshold: null, confidenceValue: 0.1 }), false);
});

test("decideReadjudicationByConfidence: below threshold → true; at/above → false", () => {
  assert.equal(decideReadjudicationByConfidence({ threshold: 0.5, confidenceValue: 0.3 }), true);
  assert.equal(decideReadjudicationByConfidence({ threshold: 0.5, confidenceValue: 0.5 }), false);
  assert.equal(decideReadjudicationByConfidence({ threshold: 0.5, confidenceValue: 0.9 }), false);
});

test("shouldReadjudicate: unset threshold leaves candidacy unchanged (OFF = current)", () => {
  // Not otherwise flagged → not a candidate, regardless of low confidence, when threshold absent
  assert.equal(shouldReadjudicate({ confidence: "low" } as any), false);
  // Existing trigger still works
  assert.equal(shouldReadjudicate({ needsReadjudication: true } as any), true);
});

test("shouldReadjudicate: low threshold routes low-confidence cells (ON = new)", () => {
  assert.equal(shouldReadjudicate({ confidence: "low" } as any, { confidenceThreshold: 0.5 }), true);
  assert.equal(shouldReadjudicate({ confidence: "high" } as any, { confidenceThreshold: 0.5 }), false);
  // already-traced rows are never re-adjudicated even under a threshold
  assert.equal(
    shouldReadjudicate({ confidence: "low", readjudicationTrace: {} } as any, { confidenceThreshold: 0.5 }),
    false,
  );
});

// ── (12) CROSS_MEASURE_CONSISTENCY ───────────────────────────────────────────
test("detectCrossMeasureInconsistencies: no-op when no dependency metadata present", () => {
  const out = detectCrossMeasureInconsistencies([
    { measureId: "m1", verdict: "Yes" },
    { measureId: "m2", verdict: "No" },
  ]);
  assert.deepEqual(out, []);
});

test("detectCrossMeasureInconsistencies: flags Yes-on-outcome with No-on-prerequisite", () => {
  const out = detectCrossMeasureInconsistencies([
    { measureId: "outcome", verdict: "Yes", prerequisiteMeasureId: "disclosure" },
    { measureId: "disclosure", verdict: "No" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].measureId, "outcome");
  assert.equal(out[0].dependsOn, "disclosure");
  assert.equal(out[0].reason, "yes-with-prerequisite-no");
});

test("detectCrossMeasureInconsistencies: consistent combos are not flagged", () => {
  const out = detectCrossMeasureInconsistencies([
    { measureId: "outcome", verdict: "Yes", dependsOnMeasureId: "disclosure" },
    { measureId: "disclosure", verdict: "Yes" },
  ]);
  assert.deepEqual(out, []);
});

test("detectCrossMeasureInconsistencies: reads alternative dependency field names, no hardcoded ids", () => {
  // uses `dependsOn` and numeric ids; "not met" treated as No
  const out = detectCrossMeasureInconsistencies([
    { measureId: 10, verdict: "Yes", dependsOn: 20 },
    { measureId: 20, verdict: "Not Met" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].measureId, "10");
  assert.equal(out[0].dependsOn, "20");
});

test("detectCrossMeasureInconsistencies: dependency pointing at missing measure is ignored", () => {
  const out = detectCrossMeasureInconsistencies([
    { measureId: "outcome", verdict: "Yes", prerequisiteId: "ghost" },
  ]);
  assert.deepEqual(out, []);
});

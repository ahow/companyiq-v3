import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFilingBoilerplateTerm,
  sanitizeTopicTerms,
  FILING_BOILERPLATE_PATTERNS,
} from "./boilerplate-hygiene.js";

// The exact extraneous terms observed contaminating fw12's topicSynonyms.
const FW12_CONTAMINANTS = [
  "filing fee",
  "all boxes",
  "computed table",
  "computed table exhibit",
  "fee all",
  "fee all boxes",
  "filing fee all",
  "paid previously",
  "previously with preliminary",
  "former managing",
  "table exhibit",
];

test("isFilingBoilerplateTerm: flags SEC filing/report boilerplate", () => {
  for (const t of FW12_CONTAMINANTS) {
    assert.equal(isFilingBoilerplateTerm(t), true, `should flag boilerplate: "${t}"`);
  }
  assert.equal(isFilingBoilerplateTerm("form 10-k"), true);
  assert.equal(isFilingBoilerplateTerm("incorporated by reference"), true);
  assert.equal(isFilingBoilerplateTerm("check mark"), true);
});

test("isFilingBoilerplateTerm: does NOT flag genuine topic vocabulary", () => {
  const topical = [
    "machine learning",
    "generative ai",
    "algorithmic accountability",
    "responsible ai",
    "model governance",
    "biodiversity restoration",
    "scope 3 emissions",
  ];
  for (const t of topical) {
    assert.equal(isFilingBoilerplateTerm(t), false, `should NOT flag topic term: "${t}"`);
  }
});

test("topicTokens protection: a genuine topic term that looks filing-ish is preserved", () => {
  // A framework literally about regulatory filings — "filing" is its topic term.
  const topicTokens = new Set(["filing", "disclosure", "regulatory"]);
  assert.equal(
    isFilingBoilerplateTerm("filing requirement", { topicTokens }),
    false,
    "protected by topicTokens overlap",
  );
  // Without protection the same phrase is boilerplate.
  assert.equal(isFilingBoilerplateTerm("filing requirement"), true);
});

test("sanitizeTopicTerms: strips contaminants, keeps topic terms, preserves order + casing", () => {
  const input = [
    "Machine Learning",
    "filing fee",
    "generative AI",
    "all boxes",
    "responsible AI",
    "computed table",
    "machine learning", // duplicate of first (case-insensitive)
    "paid previously",
  ];
  const { kept, dropped } = sanitizeTopicTerms(input);
  assert.deepEqual(kept, ["Machine Learning", "generative AI", "responsible AI"]);
  const droppedTerms = dropped.map((d) => d.term);
  assert.ok(droppedTerms.includes("filing fee"));
  assert.ok(droppedTerms.includes("all boxes"));
  assert.ok(droppedTerms.includes("computed table"));
  assert.ok(droppedTerms.includes("paid previously"));
  // duplicate flagged with its own reason
  assert.ok(dropped.some((d) => d.reason === "duplicate"));
});

test("sanitizeTopicTerms: protects the framework's canonical lexicon via topicTokens", () => {
  const input = ["filing fee", "filing calendar", "annual filing"];
  // Topic is about filings → protect "filing".
  const { kept } = sanitizeTopicTerms(input, { topicTokens: ["filing"] });
  // All three contain the protected token, so none are dropped.
  assert.deepEqual(kept, ["filing fee", "filing calendar", "annual filing"]);
});

test("sanitizeTopicTerms: topic-agnostic — same rules clean a totally different topic", () => {
  // A climate framework: filing boilerplate must still be stripped, climate terms kept.
  const input = ["carbon intensity", "exhibit", "scope 1", "pursuant to", "net zero"];
  const { kept } = sanitizeTopicTerms(input, { topicTokens: ["climate", "carbon", "emissions"] });
  assert.ok(kept.includes("carbon intensity"));
  assert.ok(kept.includes("scope 1"));
  assert.ok(kept.includes("net zero"));
  assert.ok(!kept.includes("exhibit"));
  assert.ok(!kept.includes("pursuant to"));
});

test("sanitizeTopicTerms: empty / non-array input handled without throwing", () => {
  assert.deepEqual(sanitizeTopicTerms([]).kept, []);
  assert.deepEqual(sanitizeTopicTerms(null as any).kept, []);
  assert.deepEqual(sanitizeTopicTerms(undefined as any).kept, []);
});

test("FILING_BOILERPLATE_PATTERNS is a non-empty RegExp array (all topic-agnostic)", () => {
  assert.ok(Array.isArray(FILING_BOILERPLATE_PATTERNS) && FILING_BOILERPLATE_PATTERNS.length > 0);
  for (const re of FILING_BOILERPLATE_PATTERNS) assert.ok(re instanceof RegExp);
});

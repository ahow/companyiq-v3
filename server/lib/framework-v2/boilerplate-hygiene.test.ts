import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFilingBoilerplateTerm,
  sanitizeTopicTerms,
  sanitizeAnchorFrameworks,
  isSafeHarbourTerm,
  stripEdgePunctuation,
  SAFE_HARBOUR_PATTERNS,
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

// ─── Issue 5: safe-harbour, cross-framework-leak, punctuation folding, anchors ───

test("stripEdgePunctuation: strips leading/trailing punctuation, collapses whitespace", () => {
  assert.equal(stripEdgePunctuation("  artificial intelligence,  "), "artificial intelligence");
  assert.equal(stripEdgePunctuation("(governance)"), "governance");
  assert.equal(stripEdgePunctuation("data   protection"), "data protection");
});

test("isSafeHarbourTerm: flags forward-looking / safe-harbour statement fragments", () => {
  assert.equal(isSafeHarbourTerm("forward-looking statements"), true);
  assert.equal(isSafeHarbourTerm("actual results may differ materially"), true);
  assert.equal(isSafeHarbourTerm("no obligation to update"), true);
});

test("isSafeHarbourTerm: does NOT flag genuine topic vocabulary", () => {
  assert.equal(isSafeHarbourTerm("greenhouse gas emissions"), false);
  assert.equal(isSafeHarbourTerm("board independence"), false);
});

test("SAFE_HARBOUR_PATTERNS is a non-empty RegExp array", () => {
  assert.ok(Array.isArray(SAFE_HARBOUR_PATTERNS));
  assert.ok(SAFE_HARBOUR_PATTERNS.length > 0);
  for (const p of SAFE_HARBOUR_PATTERNS) assert.ok(p instanceof RegExp);
});

test("sanitizeTopicTerms: drops safe-harbour fragments as safe_harbour", () => {
  const input = ["board oversight", "forward-looking statements", "actual results may differ materially"];
  const { kept, dropped } = sanitizeTopicTerms(input, { topicTokens: ["board", "oversight"], skipDfGate: true });
  assert.deepEqual(kept, ["board oversight"]);
  assert.ok(dropped.some((d) => d.reason === "safe_harbour"));
});

test("sanitizeTopicTerms: drops a candidate that maps onto a declared adjacent topic as cross_framework_leak", () => {
  // Framework topic = data privacy; cybersecurity is a DECLARED adjacent topic.
  const input = ["personal data", "cybersecurity incident response"];
  const { kept, dropped } = sanitizeTopicTerms(input, {
    topicTokens: ["data", "privacy"],
    adjacentTopics: ["cybersecurity"],
    skipDfGate: true,
  });
  assert.deepEqual(kept, ["personal data"]);
  assert.ok(dropped.some((d) => d.reason === "cross_framework_leak"));
});

test("sanitizeTopicTerms: a leak term sharing a protected topic token is NOT dropped (protection wins)", () => {
  // If the candidate overlaps the framework's OWN lexicon it is protected even if it
  // also matches an adjacent name substring — protection is checked first.
  const input = ["data cybersecurity"];
  const { kept } = sanitizeTopicTerms(input, {
    topicTokens: ["data"],
    adjacentTopics: ["cybersecurity"],
    skipDfGate: true,
  });
  assert.deepEqual(kept, ["data cybersecurity"]);
});

test("sanitizeTopicTerms: folds punctuation-only variants onto the clean form (punctuation_variant)", () => {
  const input = ["artificial intelligence", "artificial intelligence,", "(artificial intelligence)"];
  const { kept, dropped } = sanitizeTopicTerms(input, { topicTokens: ["artificial", "intelligence"], skipDfGate: true });
  assert.deepEqual(kept, ["artificial intelligence"]);
  assert.equal(dropped.filter((d) => d.reason === "punctuation_variant").length, 2);
});

test("sanitizeAnchorFrameworks: collapses case/duplicate anchors, preserves first casing", () => {
  const input = ["GRI", "gri", "GRI", "ISO 27001", " ISO 27001 "];
  const { kept, dropped } = sanitizeAnchorFrameworks(input);
  assert.deepEqual(kept.map((k) => k.name), ["GRI", "ISO 27001"]);
  assert.ok(dropped.length >= 3);
});

test("sanitizeAnchorFrameworks: drops an anchor that maps onto a declared adjacent topic", () => {
  const input = [{ name: "GRI", source: "op" }, { name: "cybersecurity", source: "op" }];
  const { kept, dropped } = sanitizeAnchorFrameworks(input, { adjacentTopics: ["cybersecurity"] });
  assert.deepEqual(kept.map((k) => k.name), ["GRI"]);
  assert.ok(dropped.some((d) => d.reason === "cross_framework_leak"));
});

test("sanitizeAnchorFrameworks: preserves the source field on kept anchors", () => {
  const input = [{ name: "SASB", source: "operator" }];
  const { kept } = sanitizeAnchorFrameworks(input);
  assert.deepEqual(kept, [{ name: "SASB", source: "operator" }]);
});

test("sanitizeAnchorFrameworks: empty / non-array input handled without throwing", () => {
  assert.deepEqual(sanitizeAnchorFrameworks([]).kept, []);
  assert.deepEqual(sanitizeAnchorFrameworks(null as any).kept, []);
});

/**
 * Unit tests for the topic-scoped corpus sampling helpers (precision fix).
 *
 * Background: the anchor-framework / adjacent-topic LLM miners were proposing
 * GENERIC reporting standards (GRI / SASB / TCFD ...) for any topic because the
 * corpus sample they saw was built from the DOCUMENT HEAD — report front-matter
 * where generic reporting-standard boilerplate dominates regardless of topic.
 * The fix extracts text WINDOWS around occurrences of the framework topic term /
 * synonyms (read from framework metadata), so only standards cited IN CONNECTION
 * WITH the topic reach the model.
 *
 * These tests are deliberately GENERIC: every fixture uses invented topics and
 * company names; nothing references a real framework, company, or standard, so
 * the behaviour under test is topic-agnostic by construction.
 *
 * Run with:  npx tsx --test server/lib/framework-v2/framework-candidates.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTopicQueryTokens,
  extractTopicWindows,
  type FrameworkMetaForMining,
  type TopicQuery,
} from "./framework-candidates.js";

function meta(partial: Partial<FrameworkMetaForMining>): FrameworkMetaForMining {
  return {
    topicTerm: "",
    topicSynonyms: [],
    adjacentTopics: [],
    anchorFrameworks: [],
    ...partial,
  };
}

// ── buildTopicQueryTokens ───────────────────────────────────────────────────

test("buildTopicQueryTokens: derives lowercased phrases from term + synonyms", () => {
  const q = buildTopicQueryTokens(
    meta({ topicTerm: "Water Stewardship", topicSynonyms: ["Watershed Management", "Water Risk"] }),
  );
  assert.ok(q.phrases.includes("water stewardship"));
  assert.ok(q.phrases.includes("watershed management"));
  assert.ok(q.phrases.includes("water risk"));
});

test("buildTopicQueryTokens: distinctive tokens exclude generic connective/boilerplate words", () => {
  const q = buildTopicQueryTokens(
    meta({ topicTerm: "Water Risk Management", topicSynonyms: ["the water policy and reporting"] }),
  );
  // Distinctive domain tokens are kept.
  assert.ok(q.tokens.includes("water"));
  // Generic words are filtered out as standalone tokens.
  for (const generic of ["management", "risk", "policy", "reporting", "the", "and"]) {
    assert.ok(!q.tokens.includes(generic), `expected generic token "${generic}" to be filtered`);
  }
});

test("buildTopicQueryTokens: drops tokens shorter than 4 chars and dedups", () => {
  const q = buildTopicQueryTokens(
    meta({ topicTerm: "AI Governance", topicSynonyms: ["AI governance", "governance of AI"] }),
  );
  // "ai" is 2 chars -> not a standalone token.
  assert.ok(!q.tokens.includes("ai"));
  // "governance" appears in every phrase but must be deduped.
  assert.equal(q.tokens.filter((t) => t === "governance").length, 1);
  // phrases deduped case-insensitively too.
  assert.equal(q.phrases.filter((p) => p === "ai governance").length, 1);
});

test("buildTopicQueryTokens: empty metadata yields empty query", () => {
  const q = buildTopicQueryTokens(meta({}));
  assert.deepEqual(q.phrases, []);
  assert.deepEqual(q.tokens, []);
});

// ── extractTopicWindows ─────────────────────────────────────────────────────

const Q: TopicQuery = { phrases: ["water stewardship"], tokens: ["watershed"] };

test("extractTopicWindows: returns a window around a phrase occurrence", () => {
  const text =
    "x".repeat(2000) +
    " our approach to water stewardship references the aqua-standard here. " +
    "y".repeat(2000);
  const out = extractTopicWindows(text.toLowerCase(), Q, 4000);
  assert.ok(out.includes("water stewardship"));
  assert.ok(out.includes("aqua-standard"));
  // The window is bounded context around the match, NOT the whole ~4000-char
  // document: the far filler (2000 chars either side) must be largely excluded.
  assert.ok(out.length < 1200, `window should be bounded context, got ${out.length}`);
});

test("extractTopicWindows: returns '' when the topic is never named (caller falls back)", () => {
  const text = "this document discusses carbon emissions and energy transition only.".repeat(50);
  const out = extractTopicWindows(text, Q, 4000);
  assert.equal(out, "");
});

test("extractTopicWindows: single-token match respects word boundaries", () => {
  // "watershed" must not match inside "watersheds-are-nice" boundary-wise? It is
  // a prefix; the guard protects against matching a token embedded in a larger
  // word. Use a clear embedded case: token "aqua" should not match "aquarium".
  const q: TopicQuery = { phrases: [], tokens: ["aqua"] };
  const embedded = "the aquarium was large. ".repeat(30);
  assert.equal(extractTopicWindows(embedded, q, 2000), "");
  const standalone = "x".repeat(500) + " the aqua rating improved. " + "y".repeat(500);
  assert.ok(extractTopicWindows(standalone, q, 2000).includes("aqua rating"));
});

test("extractTopicWindows: respects maxChars budget", () => {
  const unit = " water stewardship matters. ";
  const text = unit.repeat(400); // many matches
  const out = extractTopicWindows(text, Q, 300);
  assert.ok(out.length <= 300 + 10, `expected <= ~300 chars, got ${out.length}`);
  assert.ok(out.includes("water stewardship"));
});

test("extractTopicWindows: merges overlapping windows (no duplicated runs)", () => {
  // Two matches close together should merge into a single contiguous window
  // rather than producing two separate ' ... '-joined slices.
  const text = "a".repeat(300) + " water stewardship and watershed plans " + "b".repeat(300);
  const out = extractTopicWindows(text.toLowerCase(), Q, 4000);
  assert.ok(out.includes("water stewardship and watershed"));
  assert.ok(!out.includes(" ... "), "adjacent matches should merge into one window");
});

test("extractTopicWindows: empty text or zero budget yields ''", () => {
  assert.equal(extractTopicWindows("", Q, 4000), "");
  assert.equal(extractTopicWindows("water stewardship", Q, 0), "");
});

test("extractTopicWindows: empty query yields '' (no needles)", () => {
  const out = extractTopicWindows("water stewardship everywhere", { phrases: [], tokens: [] }, 4000);
  assert.equal(out, "");
});

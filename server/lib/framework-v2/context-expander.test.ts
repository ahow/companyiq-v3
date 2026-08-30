import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findQuoteInSource,
  expandToSentenceBoundaries,
} from "./context-expander.js";

test("findQuoteInSource: exact match", () => {
  const src = "Foo. Bar baz qux. Hello world.";
  const idx = findQuoteInSource("Bar baz qux.", src);
  assert.ok(idx !== null && idx >= 0);
});

test("findQuoteInSource: smart-quote normalisation", () => {
  const src = 'She said "hello" to us.';
  const idx = findQuoteInSource("said \u201chello\u201d", src);
  assert.ok(idx !== null && idx >= 0);
});

test("findQuoteInSource: distinctive shingle", () => {
  const src = "Over 13,000 employees completed this training in 2024. Separate AI-specific training is planned for 2025.";
  // Slightly paraphrased/truncated quote
  const idx = findQuoteInSource("13,000 employees completed this training", src);
  assert.ok(idx !== null && idx >= 0);
});

test("findQuoteInSource: not found returns null", () => {
  const src = "Nothing related here.";
  const idx = findQuoteInSource("Zebra unicorn moonlight", src);
  assert.equal(idx, null);
});

test("expandToSentenceBoundaries: expands to at least minContext", () => {
  const src =
    "In 2024, we launched a comprehensive ethics compliance training programme across all business units. " +
    "Over 13,000 employees completed this training in 2024. " +
    "The programme covered anti-corruption, data-protection, and code-of-conduct topics. " +
    "Separate AI-specific training is planned for 2025.";
  const quote = "Over 13,000 employees completed this training in 2024.";
  const idx = findQuoteInSource(quote, src);
  assert.ok(idx !== null);
  const expanded = expandToSentenceBoundaries(src, idx!, quote.length, 120);
  // Expanded must contain the ethics-training context that reveals attribution
  assert.ok(expanded.toLowerCase().includes("ethics"), `expanded missing 'ethics': ${expanded}`);
  assert.ok(expanded.length >= 120);
});
